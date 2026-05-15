import { z } from 'zod';
import type { LLMClient } from '../llm/client.js';
import { logger } from '../util/logger.js';

const Output = z.object({
  l0_summary: z.string().min(1).max(400),
  l1_overview: z.string().min(1).max(2000),
});

const SYSTEM = '你是知识库的笔记摘要器。只输出严格 JSON,不要解释、不要 markdown 代码块。要简洁、准确,绝不为了凑字数而填充无意义内容。';

const userPrompt = (body: string) => `为下面这段笔记正文生成两层摘要,精简优先。

要求:
- l0_summary: 一句话核心摘要,中文,**最多 100 字符**,体现"这条笔记在讲什么"
- l1_overview: 一段紧凑概览,中文,**最多 500 字符**,提炼最核心的论点 / 事实
  - **聚焦主题信号,不展开具体技术细节**
  - 这是给 embedding 模型用的"主题描述",过长会稀释主题向量,影响聚类
  - 想象成"在 cluster 内能区分这一篇 vs 其他成员"的最小描述
- **如果原文已经很短或信息密度低,允许 l1 比 l0 长不了多少甚至接近原文长度——不要为了凑字数填充**

笔记正文(可能被截断):
"""
${body.slice(0, 6000)}
"""

只输出 JSON:
{"l0_summary":"...","l1_overview":"..."}`;

// Below this length, summarization is wasteful: the LLM either echoes the
// body or hallucinates filler to hit the lower bound. Short bodies become
// their own l1, with l0 truncated to ≤ 100 chars. Cutoff is intentionally
// generous — anything ≤ 200 chars fits comfortably in any embedding context
// and gives clustering enough signal as-is.
const SHORT_BODY_THRESHOLD_CHARS = 200;
const L0_MAX_CHARS = 100;

/** Optional override: a cheaper / faster model for summaries.
 * Read once at module load (matches the rest of config; reload on restart). */
const SUMMARIZATION_MODEL = process.env.SUMMARIZATION_MODEL?.trim() || undefined;

export class SummarizationService {
  constructor(private llm: LLMClient) {
    if (SUMMARIZATION_MODEL) {
      logger.info({ model: SUMMARIZATION_MODEL }, 'summarizer: using dedicated model');
    }
  }

  async summarize(body: string): Promise<{ l0_summary: string; l1_overview: string }> {
    const trimmed = body.trim();
    if (!trimmed) return { l0_summary: '(空文档)', l1_overview: '(空文档)' };

    // Short-body fast path. Skip the LLM entirely; use the body as l1, and
    // truncate to L0_MAX_CHARS for l0. Cheaper, deterministic, no risk of
    // hallucination. Loses the "single-sentence-summary" quality for ~200-char
    // notes — the trade-off is honesty over polish at this scale.
    if (trimmed.length <= SHORT_BODY_THRESHOLD_CHARS) {
      return {
        l0_summary: trimmed.length <= L0_MAX_CHARS ? trimmed : trimmed.slice(0, L0_MAX_CHARS),
        l1_overview: trimmed,
      };
    }

    const completion = await this.llm.chat({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(body) },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
      model: SUMMARIZATION_MODEL,
    });
    const raw = completion.choices[0]?.message?.content ?? '{}';
    try {
      return Output.parse(JSON.parse(raw));
    } catch (err) {
      logger.warn(
        { err, raw: raw.slice(0, 200) },
        'summarizer output invalid; falling back to body slices',
      );
      return {
        l0_summary: trimmed.slice(0, L0_MAX_CHARS),
        l1_overview: trimmed.slice(0, 500),
      };
    }
  }
}

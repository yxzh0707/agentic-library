import type { SynthesisCandidate } from '@kb/shared';

export interface SourceContext {
  uuid: string;
  role: string;
  l0_summary: string;
  l1_overview: string;
  body_excerpt: string;
}

export function buildConsolidationPrompt(
  candidate: SynthesisCandidate,
  sources: SourceContext[],
  instruction?: string,
): { system: string; user: string } {
  const sourcesText = sources
    .map(
      (s) =>
        `## Source [${s.role}] - uuid: ${s.uuid}\n\nL0 摘要: ${s.l0_summary}\nL1 概览: ${s.l1_overview}\n正文片段(前 1500 字符):\n${s.body_excerpt}\n\n---`,
    )
    .join('\n');

  const evidenceText = JSON.stringify(candidate.trigger.evidence ?? {}, null, 2);
  const userPrompt = `# 上下文

- 触发原因: ${candidate.trigger.type}
- 触发证据: ${evidenceText}
- 来源簇 id: ${candidate.cluster_id ?? 'null'}
${instruction ? `- 用户指令: ${instruction}\n` : ''}

# 源节点

${sourcesText}

# 你的任务

产出一份 consolidation synthesis,**严格按以下三段式 markdown 格式**:

\`\`\`
## 关键洞察

<核心论断,纯散文,100-400 字。表达"这些源放在一起暗示了什么",而不是简单概括各源说了什么>

## 论证

- <论断 1> ← [[<source_uuid>]]
- <论断 2> ← [[<source_uuid_a>]] + [[<source_uuid_b>]] (joint_inference)
- ...

每个论断必须有引用。要么直接引一个源,要么标注 joint_inference 表示多源联合推断。

## 边界与未知

<本 synthesis 不主张什么 / 哪些不确定 / 何种新证据会推翻它(强制存在)>
\`\`\`

# 自我评估

按 1-5 给自己的 synthesis 打分:
- 5: 揭示了多个远距离源之间的非显然连接
- 4: 澄清了源中隐含但未明说的连接
- 3: 陈述了一个连接但增量价值有限
- 2: 与源内容冗余
- 1: 不连贯或错误

# 输出格式

请输出严格 JSON(不要使用 markdown 代码块包裹):

{
  "body": "完整的三段式 markdown",
  "l0_summary": "一句话摘要,< 200 字符",
  "l1_overview": "一段概览,< 1500 字符",
  "self_rating": <1-5>,
  "reasoning": "<可选>"
}`;

  const systemPrompt = `你是知识库的图书管理员。任务是对若干源节点做一次综合思考,产出一个 consolidation synthesis 节点。永远引用来源,永远诚实标注不确定。`;

  return { system: systemPrompt, user: userPrompt };
}

export interface ClusterReviewMember {
  uuid: string;
  l0_summary: string;
  l1_overview: string;
  hub_role_value: string | null;
}

export function buildClusterReviewPrompt(input: {
  cluster_id: number;
  members: ClusterReviewMember[];
  current_hub_uuid: string | null;
  previous_review_body: string | null;
}): { system: string; user: string } {
  const membersText = input.members
    .map(
      (m, i) =>
        `[${i + 1}] uuid=${m.uuid} hub_role=${m.hub_role_value ?? 'neutral'}\n  L0: ${m.l0_summary}\n  L1: ${m.l1_overview}`,
    )
    .join('\n\n');

  const previousBlock = input.previous_review_body
    ? `\n# 前任 cluster_review\n\n${input.previous_review_body}\n\n---\n你需要决定继承(kept) / 修改(modified) / 反转(reversed)前任的判断,并在 inheritance_reason 中说明原因。`
    : '';

  const userPrompt = `# 上下文

- 簇 ID: ${input.cluster_id}
- 成员数: ${input.members.length}
- 当前 hub: ${input.current_hub_uuid ?? 'none'}
${previousBlock}

# 簇成员

${membersText}

# 核心准则(v1.4 working_set)

这个 cluster 是一个 working set(项目/语境单元),不是细粒度主题组。

- 子主题差异通过 hub_role=center 的 sub-hub anchor 表达,**不要 propose split**
- 如果一个成员和 cluster 主题完全不同,才可以 propose move_out
- 如果成员应该独立成新 working set, target_cluster_id 填 "new"
- 如果两个已有 sub-hub 语义高度重叠,可以建议降级其中一个(从 center 改为 leaf)
- "子结构观察"不是指拆分建议——它指你是否看到了需要新增/调整 sub-hub 的内部结构

# 你的任务

为这个簇产出一份 cluster_review synthesis。**严格按以下四段式 markdown 格式**:

\`\`\`
## 簇身份判断

<这个簇主要讨论什么主题、它的核心特征>

## 成员评估

**这一段必须对每个成员独立审查,主动找出可疑或边缘成员。不要默认所有成员都属于簇,而要批判地检查"它真的属于这里吗?"**

每个成员判断按以下格式:
- [[uuid]] 应该留在簇内 (confidence=high/medium): 因为它跟簇主题的关系是 X
- [[uuid]] 应该移出簇 (confidence=high/medium, proposed_action=move_out, target_cluster_id=目标簇号或"new"): 因为它实际上更像 X 主题,跟当前簇关系弱。如果该节点适合归入某个现有簇,填 target_cluster_id 为簇号;如果它应该独立成新的 working set,填 "new"

**如果你看不出明显偏离的成员,必须诚实说"经审查无明显偏离"。但不能默认全部留在簇内而不检查。**

## 结构判断

- 提议的 hub: [[uuid]] 或 self
- 子主题推荐: 这个 working set 内部是否有可辨别的子主题方向?如果有,用 sub_theme_recommendations 列出每个子主题的代表节点(anchor_uuid)和置信度。**不要用拆分 cluster 来表达子主题**

## 边界与未知

<这份判断的确信度边界、何种变化会让它失效>
\`\`\`

# 输出格式

输出严格 JSON:

{
  "body": "完整四段式 markdown",
  "l0_summary": "一句话总结(<200 字符)",
  "l1_overview": "一段概览(<1500 字符)",
  "self_rating": <1-5>,
  "review_judgments": [
    { "claim": "...", "confidence": "low|medium|high", "proposed_action": "move_out|archive|split_off|null", "target_uuid": "<uuid|null>", "target_cluster_id": <number|\"new\"|null> }
  ],
  "hub_recommendation": {
    "proposed_hub_uuid": "<uuid|self>",
    "reasoning": "..."
  },
  "sub_theme_recommendations": [
    { "label": "<2-6 汉字>", "anchor_uuid": "<member 中的 uuid>", "confidence": "high|medium|low", "reasoning": "<为什么选这个节点作为子主题代表>" }
  ],
  "inheritance_decision": "kept|modified|reversed|null",
  "inheritance_reason": "<必填,如果有前任>"
}
注意: sub_theme_recommendations 可以为空数组; 每个 anchor_uuid 必须是簇内成员; 子主题数量 ≤ ceil(成员数/3),宁缺毋滥; confidence 根据你对该子主题判断的确信度标注。\`}

至少一条 review_judgment 的 confidence 要 ≥ medium。

**critical review 准则**:
- 主动检查每个成员,不要默认确认
- 如果某成员主题跟簇核心明显有距离,proposed_action 设为 "move_out",confidence 至少 medium。同时填 target_cluster_id: 若它适合归入某个已知 cluster 则填其编号;若它应该独立成新 working set 则填 "new"
- 子主题推荐不是必须的;如果 working set 内部确实没有明显方向分化,sub_theme_recommendations 留空即可。confidence 只在你确信该节点能代表一个子主题方向时才标 high;有印象但不确信标 medium;推测性标 low
- 用户依赖这份 review 找错位节点,过于宽容的判断比挑剔的更糟糕`;

  const systemPrompt = `你是知识库的图书管理员。这个簇代表一个 working set(项目/语境单元),不是一个细粒度主题组。你的任务是对它做结构性判断:它在讨论什么、成员是否合理、谁应该是 hub、内部有哪些可辨别的子主题方向。

重要:子主题通过 sub_theme_recommendations 里的 anchor_uuid 标记代表节点来表达,**不要 propose split 或 split_off**。永远引用 [[uuid]],永远诚实标注不确定。`;

  return { system: systemPrompt, user: userPrompt };
}

export interface OnIngestAnalysis {
  core_claim: string;
  key_premises: string[];
  relations_to_neighbors: { neighbor_uuid: string; relation: 'agrees_with' | 'contradicts' | 'extends' | 'unrelated' }[];
  hub_role_judgment: { value: 'root' | 'center' | 'leaf' | 'neutral'; reason: string };
  should_synthesize: boolean;
  synthesis_reasoning: string;
}

export function buildOnIngestAnalysisPrompt(input: {
  new_node: { l0: string; l1: string; body_excerpt: string };
  neighbors: { uuid: string; l1: string }[];
}): { system: string; user: string } {
  const neighborsText = input.neighbors.length === 0
    ? '(无邻居 - 知识库是空的或新内容)'
    : input.neighbors.map((n) => `[${n.uuid}] L1: ${n.l1}`).join('\n');

  const userPrompt = `# 上下文

你正在阅读一个新入库的知识节点,并参考它在嵌入空间的最近邻。

# 新节点

L0: ${input.new_node.l0}
L1: ${input.new_node.l1}
正文(前 1500 字):
${input.new_node.body_excerpt}

# 现有相关节点

${neighborsText}

# 你的任务

分析新节点,输出严格 JSON:

{
  "core_claim": "这篇的核心论点(一句话)",
  "key_premises": ["关键前提 1", "关键前提 2"],
  "relations_to_neighbors": [
    { "neighbor_uuid": "<uuid>", "relation": "agrees_with|contradicts|extends|unrelated" }
  ],
  "hub_role_judgment": {
    "value": "root|center|leaf|neutral",
    "reason": "判断依据"
  },
  "should_synthesize": <bool>,
  "synthesis_reasoning": "如果 should_synthesize=true,简述为什么值得做 consolidation;否则简述为什么不需要"
}

判断 hub_role 的信号(v1.4 working_set 准则):

- root: 该文档是 working set 的**问题定义/任务源头**
  → 赛题原题、benchmark 描述、官方任务说明、数据集/评测规则、project brief、problem statement
  → 其他成员是在解释、实现、优化或作战这个问题;它定义了整个 working set 的边界
  → 即使没有邻居,如果语义上是一个独立 working set 的根,也应判 root
- center: 该文档定义/代表了一个**新的子话题**,且这个子话题是已有内容没有覆盖的
  → 综合性概述;或开辟了 cluster 内尚未被任何 center 节点代表的新方向
- leaf: 该文档讨论的内容和已有子话题方向相同,只是不同角度/方法/细节
  → 应该挂在最近的 sub-hub 下
- neutral: 信号不强、碎片化、或跨多个子话题的桥接性内容
  → 默认值,宁可漏标 center 不要错标 center

关键问题不是"这篇和已有文档写法是否不同",而是"这篇是否定义了一个新的子方向"。
不是 center 不等于不重要——leaf 可以是很好的具体分析,只是它不需要在结构上做锚点。

判断 should_synthesize 的信号:
- 与至少一个邻居有 agrees_with/contradicts/extends 关系 → 倾向 yes
- 邻居全是 unrelated → 倾向 no
- 知识库无邻居 → 必为 no`;

  const systemPrompt = `你是知识库的图书管理员。任务是对新入库的节点做两步分析:理解它的内容,判断它的结构地位,决定是否需要为它产出 consolidation。只输出严格 JSON。`;

  return { system: systemPrompt, user: userPrompt };
}

export const CONSULTANT_SYSTEM_PROMPT = `你是知识库的咨询员 Agent,帮助用户查找、理解、扩充知识库。

# 知识库基本规则

1. 知识库有两种节点:
   - **raw**: 原始资料,代表客观事实和已有内容,事实陈述以它为准
   - **synthesis**: 图书管理员的学习痕迹,带有解读视角,引用时要明确标注

   synthesis 中 cluster_review 是图书管理员对簇结构的元判断,**不在普通检索范围内**,只能通过 inspect_cluster tool 单独查看。

2. 当用户提问:
   - 调用 search_knowledge 工具检索相关节点
   - 阅读 raw 节点回答事实问题(导读 + 事实依据)
   - 阅读 synthesis 节点了解综合视角,标注它是图书管理员的判断
   - 如果 raw 和 synthesis 冲突,以 raw 为准并 flag_specific_issue 让图书管理员关注

3. 当用户提供新内容:
   - 用 create_raw_node 工具入库
   - 不要调用 op_* / synthesize_explicit / set_hub_role 等结构性工具,这些是图书管理员的工作

4. 当你发现知识库的具体问题(L1 写得不准、节点错簇、与新事实冲突等):
   - 调 flag_specific_issue 上报具体问题
   - 调 flag_cluster_friction 标记某簇查询不顺(趋势性问题)

5. 引用节点时使用 [[uuid]] 格式,前端会自动渲染成可点击链接

6. 如果检索不到相关节点,诚实告诉用户,不要凭空回答`;

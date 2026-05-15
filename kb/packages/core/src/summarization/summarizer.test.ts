import { describe, it, expect } from 'vitest';
import { SummarizationService } from './summarizer.js';
import type { LLMClient } from '../llm/client.js';

// A mock LLM that throws if called. Lets us verify the short-body fast path
// genuinely skips the LLM (rather than calling and getting lucky on the result).
function neverCallLlm(): LLMClient {
  return {
    chat: async () => {
      throw new Error('LLM was called but the test required it not to be');
    },
  } as unknown as LLMClient;
}

describe('SummarizationService — short-body fast path', () => {
  it('returns the placeholder for empty input without calling LLM', async () => {
    const svc = new SummarizationService(neverCallLlm());
    const r = await svc.summarize('');
    expect(r.l0_summary).toBe('(空文档)');
    expect(r.l1_overview).toBe('(空文档)');
  });

  it('returns placeholder for whitespace-only input', async () => {
    const svc = new SummarizationService(neverCallLlm());
    const r = await svc.summarize('   \n\t  \n');
    expect(r.l0_summary).toBe('(空文档)');
    expect(r.l1_overview).toBe('(空文档)');
  });

  it('uses the body itself for both layers when body ≤ 100 chars', async () => {
    const svc = new SummarizationService(neverCallLlm());
    const body = '今天和小张开会决定了 Phoenix 项目的下一步方向，需要在月底前出技术方案。';
    expect(body.length).toBeLessThanOrEqual(100);
    const r = await svc.summarize(body);
    expect(r.l0_summary).toBe(body);
    expect(r.l1_overview).toBe(body);
  });

  it('truncates l0 to 100 chars but keeps full body as l1 when body 100-200 chars', async () => {
    const svc = new SummarizationService(neverCallLlm());
    // 150-char body
    const body = 'a'.repeat(150);
    const r = await svc.summarize(body);
    expect(r.l0_summary.length).toBe(100);
    expect(r.l0_summary).toBe('a'.repeat(100));
    expect(r.l1_overview).toBe(body);
    expect(r.l1_overview.length).toBe(150);
  });

  it('honors the threshold exactly at 200 chars (still skips LLM)', async () => {
    const svc = new SummarizationService(neverCallLlm());
    const body = 'b'.repeat(200);
    const r = await svc.summarize(body);
    // 200 chars is the boundary — still short-path
    expect(r.l1_overview).toBe(body);
    expect(r.l0_summary.length).toBe(100);
  });

  it('trims surrounding whitespace before length check', async () => {
    const svc = new SummarizationService(neverCallLlm());
    // Padded with whitespace; trimmed length = 5 (well under threshold)
    const body = '\n\n   hello   \n\n';
    const r = await svc.summarize(body);
    expect(r.l0_summary).toBe('hello');
    expect(r.l1_overview).toBe('hello');
  });
});

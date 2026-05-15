import OpenAI from 'openai';
import type { KBConfigEmbedding, KBConfigLLM } from '@kb/shared';
import { logger } from '../util/logger.js';

export class LLMClient {
  private chatClient: OpenAI;
  private embedClient: OpenAI;
  private chatCfg: KBConfigLLM;
  private embedCfg: KBConfigEmbedding;

  constructor(chat: KBConfigLLM, embedding: KBConfigEmbedding) {
    this.chatCfg = chat;
    this.embedCfg = embedding;
    this.chatClient = this.buildClient(chat.api_key, chat.base_url);
    this.embedClient = this.buildClient(embedding.api_key, embedding.base_url);
  }

  private buildClient(apiKey: string, baseUrl: string): OpenAI {
    return new OpenAI({
      apiKey: apiKey || 'placeholder',
      baseURL: baseUrl || undefined,
    });
  }

  /** Hot-reload credentials/models without restarting the server. */
  update(chat: KBConfigLLM, embedding: KBConfigEmbedding) {
    this.chatCfg = chat;
    this.embedCfg = embedding;
    this.chatClient = this.buildClient(chat.api_key, chat.base_url);
    this.embedClient = this.buildClient(embedding.api_key, embedding.base_url);
  }

  get config(): KBConfigLLM {
    return this.chatCfg;
  }

  get embeddingConfig(): KBConfigEmbedding {
    return this.embedCfg;
  }

  raw(): OpenAI {
    return this.chatClient;
  }

  async chat(params: {
    messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; reasoning_content?: string; name?: string; tool_call_id?: string; tool_calls?: unknown[] }[];
    tools?: unknown[];
    temperature?: number;
    response_format?: { type: 'json_object' };
    /** Override the chat model for this single call (e.g. cheap fast model for summaries). */
    model?: string;
  }) {
    const res = await this.chatClient.chat.completions.create({
      model: params.model ?? this.chatCfg.chat_model,
      messages: params.messages as never,
      tools: params.tools as never,
      temperature: params.temperature ?? 0.3,
      response_format: params.response_format,
    });
    return res;
  }

  async *chatStream(params: {
    messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; reasoning_content?: string; name?: string }[];
    tools?: unknown[];
    temperature?: number;
  }) {
    const stream = await this.chatClient.chat.completions.create({
      model: this.chatCfg.chat_model,
      messages: params.messages as never,
      tools: params.tools as never,
      temperature: params.temperature ?? 0.3,
      stream: true,
    });
    for await (const chunk of stream) {
      yield chunk;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let attempt = 0;
    while (true) {
      try {
        const res = await this.embedClient.embeddings.create({
          model: this.embedCfg.model,
          input: texts,
        });
        return res.data.map((d) => d.embedding);
      } catch (err) {
        attempt++;
        if (attempt >= 3) throw err;
        const wait = 500 * 2 ** attempt;
        logger.warn({ attempt, err }, 'embed retry');
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
}

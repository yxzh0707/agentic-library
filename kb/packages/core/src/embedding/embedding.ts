import type { LLMClient } from '../llm/client.js';
import { logger } from '../util/logger.js';

export class EmbeddingService {
  constructor(private llm: LLMClient) {}

  async embedTexts(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    const BATCH = 64;
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const vectors = await this.llm.embed(batch);
      out.push(...vectors);
    }
    return out;
  }

  async embedOne(text: string): Promise<number[]> {
    if (!text) return [];
    const res = await this.embedTexts([text]);
    return res[0] ?? [];
  }
}

export interface EmbeddingWorkerDeps {
  embedding: EmbeddingService;
  pendingUuids: () => string[];
  embedNode: (uuid: string) => Promise<void>;
}

export interface EmbeddingWorkerHandle {
  /** Trigger a tick now, regardless of timer schedule. Coalesces while a tick is in flight. */
  kick: () => void;
  stop: () => void;
}

export function startEmbeddingWorker(
  deps: EmbeddingWorkerDeps,
  intervalMs = 30_000,
): EmbeddingWorkerHandle {
  let stopped = false;
  let running = false;
  let kickPending = false;

  const tick = async () => {
    if (stopped) return;
    if (running) {
      kickPending = true;
      return;
    }
    running = true;
    try {
      const uuids = deps.pendingUuids();
      for (const uuid of uuids) {
        try {
          await deps.embedNode(uuid);
        } catch (err) {
          logger.warn({ err, uuid }, 'embed worker failed for node');
        }
      }
    } finally {
      running = false;
      if (kickPending) {
        kickPending = false;
        void tick();
      }
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  void tick();

  return {
    kick: () => void tick(),
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

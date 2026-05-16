import type { ToolRegistry } from './registry.js';
import type { NodeStorage } from '../storage/storage.js';
import type { OpLogService } from '../op_log/op_log.js';
import type { DB } from '../storage/db.js';
import type { EmbeddingService } from '../embedding/embedding.js';
import type { IndexService } from '../indexing/index_service.js';
import type { SynthesisService } from '../synthesis/synthesis.js';
import type { ClusteringService } from '../clustering/clustering.js';
import type { FlagQueueService } from '../flag/flag_queue.js';
import type { KBConfigParameters } from '@kb/shared';
import { registerReadTools } from './read_tools.js';
import { registerWriteTools } from './write_tools.js';
import { registerStructuralTools } from './structural_tools.js';
import { registerAdminTools } from './admin_tools.js';

export interface RegisterDeps {
  registry: ToolRegistry;
  storage: NodeStorage;
  oplog: OpLogService;
  db: DB;
  embedding: EmbeddingService;
  index: IndexService;
  synthesis: SynthesisService;
  clustering: ClusteringService;
  flagQueue: FlagQueueService;
  params: KBConfigParameters;
  heartbeat?: string;
  // v2.0: optional llm for spawn_sub_agent tool
  llm?: { chat: (msg: unknown) => Promise<{ choices?: { message?: { content?: string } }[] }> };
}

export function registerAllTools(deps: RegisterDeps) {
  registerReadTools(deps);
  registerWriteTools(deps);
  registerStructuralTools(deps);
  registerAdminTools(deps);
}

import { config as loadEnv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PARAMETERS,
  type KBConfig,
  type KBConfigEmbedding,
  type KBConfigLLM,
} from '@kb/shared';
import { logger } from '../util/logger.js';

const CONFIG_ENV = 'KB_DATA_DIR';

// ---------- Locate and load .env ----------
// pnpm runs each workspace script with CWD = that package's dir,
// so the project root's .env wouldn't be found by `import 'dotenv/config'`.
// Walk up from this file's location to find .env, then load it.
const HERE = path.dirname(fileURLToPath(import.meta.url));

function findEnvFile(): string | null {
  let cur = HERE;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(cur, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Fallback: cwd-based lookup
  const cwdCandidate = path.join(process.cwd(), '.env');
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;
  return null;
}

const envPath = findEnvFile();
if (envPath) {
  loadEnv({ path: envPath });
  logger.info({ path: envPath }, 'loaded .env');
} else {
  logger.info('no .env file found; using process env + defaults only');
}

function defaultDataDir(): string {
  return process.env[CONFIG_ENV] ?? path.join(os.homedir(), 'Downloads', 'kb_main');
}

function envStr(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

function envNum(key: string, fallback: number): number {
  const v = envStr(key);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function defaultLLM(): KBConfigLLM {
  return {
    provider: 'openai_compatible',
    base_url: envStr('LLM_BASE_URL') ?? '',
    api_key: envStr('LLM_API_KEY') ?? '',
    chat_model: envStr('LLM_CHAT_MODEL') ?? '',
  };
}

function defaultEmbedding(): KBConfigEmbedding {
  return {
    base_url: envStr('EMBEDDING_BASE_URL') ?? '',
    api_key: envStr('EMBEDDING_API_KEY') ?? '',
    model: envStr('EMBEDDING_MODEL') ?? '',
    dim: envNum('EMBEDDING_DIM', 1024),
  };
}

export function configPath(dataDir: string): string {
  return path.join(dataDir, 'config.json');
}

export function emptyConfig(dataDir: string): KBConfig {
  return {
    version: '1.3',
    data_dir: dataDir,
    llm: defaultLLM(),
    embedding: defaultEmbedding(),
    parameters: { ...DEFAULT_PARAMETERS },
    external_agents: [],
  };
}

/** Migrate legacy config shapes (llm.embedding_model → embedding.*). */
function normalize(cfg: Partial<KBConfig> & { llm?: Record<string, unknown> }): KBConfig {
  const dataDir = (cfg.data_dir as string) ?? defaultDataDir();
  const base: KBConfig = emptyConfig(dataDir);
  base.llm = { ...base.llm, ...(cfg.llm as KBConfigLLM | undefined) };

  // Pull legacy embedding fields off llm if present
  const legacyModel = (cfg.llm as Record<string, unknown> | undefined)?.embedding_model as
    | string
    | undefined;
  const legacyDim = (cfg.llm as Record<string, unknown> | undefined)?.embedding_dim as
    | number
    | undefined;

  base.embedding = {
    ...base.embedding,
    ...(cfg.embedding ?? {}),
  };
  if (!base.embedding.model && legacyModel) base.embedding.model = legacyModel;
  if (!base.embedding.dim && typeof legacyDim === 'number') base.embedding.dim = legacyDim;

  // Strip deprecated keys from llm so the saved file doesn't carry them around
  delete (base.llm as unknown as Record<string, unknown>).embedding_model;
  delete (base.llm as unknown as Record<string, unknown>).embedding_dim;

  base.parameters = { ...DEFAULT_PARAMETERS, ...(cfg.parameters ?? {}) };
  base.external_agents = cfg.external_agents ?? [];
  return base;
}

const ENV_BINDINGS: Array<{ env: string; section: 'llm' | 'embedding'; key: string; numeric?: boolean }> = [
  { env: 'LLM_BASE_URL',       section: 'llm',       key: 'base_url' },
  { env: 'LLM_API_KEY',        section: 'llm',       key: 'api_key' },
  { env: 'LLM_CHAT_MODEL',     section: 'llm',       key: 'chat_model' },
  { env: 'EMBEDDING_BASE_URL', section: 'embedding', key: 'base_url' },
  { env: 'EMBEDDING_API_KEY',  section: 'embedding', key: 'api_key' },
  { env: 'EMBEDDING_MODEL',    section: 'embedding', key: 'model' },
  { env: 'EMBEDDING_DIM',      section: 'embedding', key: 'dim', numeric: true },
];

/**
 * Apply .env values on top of a config object. .env is the source of truth for
 * keys it defines — runtime wins on every startup, regardless of what config.json
 * has saved. UI edits to env-managed keys are only effective until next restart.
 *
 * Returns the keys that were taken from env (for UI badges).
 */
export function applyEnvOverrides(cfg: KBConfig): { config: KBConfig; envManagedKeys: string[] } {
  const out: KBConfig = JSON.parse(JSON.stringify(cfg));
  const managed: string[] = [];
  for (const b of ENV_BINDINGS) {
    const raw = envStr(b.env);
    if (raw === undefined) continue;
    const target = out[b.section] as unknown as Record<string, unknown>;
    target[b.key] = b.numeric ? Number(raw) : raw;
    managed.push(`${b.section}.${b.key}`);
  }
  return { config: out, envManagedKeys: managed };
}

// Module-scoped: the keys most recently observed as env-managed at startup.
// Updated by loadOrInitConfig and read by the AppContext for display purposes.
let lastEnvManagedKeys: string[] = [];
export function envManagedKeys(): string[] {
  return [...lastEnvManagedKeys];
}

export function loadOrInitConfig(dataDir: string = defaultDataDir()): KBConfig {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const p = configPath(dataDir);

  let baseCfg: KBConfig;
  if (!fs.existsSync(p)) {
    baseCfg = emptyConfig(dataDir);
    fs.writeFileSync(p, JSON.stringify(baseCfg, null, 2));
    logger.info({ path: p }, 'created default config');
  } else {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<KBConfig> & { llm?: Record<string, unknown> };
    baseCfg = normalize({ ...parsed, data_dir: parsed.data_dir ?? dataDir });
  }

  // Apply .env overrides every startup. Anything set in .env wins on restart
  // — config.json ends up reflecting the active runtime values.
  const { config: applied, envManagedKeys: managed } = applyEnvOverrides(baseCfg);
  lastEnvManagedKeys = managed;

  // Persist the merged result so config.json always shows what's actually being used.
  if (JSON.stringify(applied) !== fs.readFileSync(p, 'utf-8').trim()) {
    fs.writeFileSync(p, JSON.stringify(applied, null, 2));
  }

  if (managed.length > 0) {
    logger.info({ keys: managed }, '.env overrides applied (these keys win on every restart)');
  }
  return applied;
}

export function saveConfig(cfg: KBConfig): void {
  fs.writeFileSync(configPath(cfg.data_dir), JSON.stringify(cfg, null, 2));
}

export function isConfigComplete(cfg: KBConfig): boolean {
  const llmReady = Boolean(cfg.llm.base_url && cfg.llm.api_key && cfg.llm.chat_model);
  const embReady = Boolean(cfg.embedding.base_url && cfg.embedding.api_key && cfg.embedding.model);
  return llmReady && embReady;
}

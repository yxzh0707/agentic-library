#!/usr/bin/env node
/**
 * agentic-library CLI — zero-config KB server for any agent.
 *
 * Usage:
 *   agentic-library start           Start the KB server
 *   agentic-library init            Interactive first-time setup
 *   agentic-library config          View current config
 *   agentic-library config set <key> <value>   Update config
 *   agentic-library import <path>   Import files into KB
 *   agentic-library register [id]   Register a new agent
 *   agentic-library status          Show KB health and stats
 *   agentic-library onboard <key>   Full onboarding for an agent
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn, execSync } = require('child_process');

// ─── constants ───────────────────────────────────────────────────────────────
const DEFAULT_PORT = 7823;
const DEFAULT_HOST = '127.0.0.1';

// Where the npm package lives on disk
const PKG_ROOT = (() => {
  // __dirname when installed globally: .../node_modules/@zyx0707/agentic-library/bin
  // Bin dir is a sibling of package root, so walk up one level
  const binDir = path.resolve(__dirname);
  const pkgDir = path.resolve(binDir, '..');
  // Verify: does packages/core/dist/index.js exist?
  if (fs.existsSync(path.join(pkgDir, 'packages', 'core', 'dist', 'index.js'))) return pkgDir;
  if (fs.existsSync(path.join(pkgDir, 'node_modules', '@zyx0707', 'agentic-library'))) {
    // Possibly nested
    const nested = path.join(pkgDir, 'node_modules', '@zyx0707', 'agentic-library');
    if (fs.existsSync(path.join(nested, 'packages', 'core', 'dist', 'index.js'))) return nested;
  }
  // Fallback: assume we're in dev (repo root is parent of packages/)
  if (fs.existsSync(path.join(pkgDir, 'packages', 'core', 'src', 'index.ts'))) return pkgDir;
  return pkgDir;
})();

const DATA_DIR = process.env.KB_DATA_DIR || path.join(os.homedir(), '.agentic-library', 'data');
const ENV_TEMPLATE = path.join(PKG_ROOT, '.env.example');

// ─── util ────────────────────────────────────────────────────────────────────
function request(method, urlPath, body, opts = {}) {
  const { host, port, useHttps } = { host: DEFAULT_HOST, port: DEFAULT_PORT, useHttps: false, ...opts };
  const mod = useHttps ? https : http;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const reqOpts = {
      hostname: host, port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 },
      timeout: 15000,
    };
    const req = mod.request(reqOpts, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve({ raw, _httpStatus: res.statusCode }); }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (ans) => { rl.close(); resolve(ans.trim()); }));
}

// ─── init ────────────────────────────────────────────────────────────────────
async function cmdInit() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   agentic-library — first-time setup    ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  This will create a .env file with your LLM and embedding settings.');
  console.log('  Press Enter to skip any field (you can edit .env later).');
  console.log('');

  const fields = [
    { key: 'LLM_BASE_URL',       prompt: 'LLM API Base URL',                     example: 'https://api.deepseek.com' },
    { key: 'LLM_API_KEY',        prompt: 'LLM API Key',                          example: 'sk-...' },
    { key: 'LLM_CHAT_MODEL',     prompt: 'LLM Chat Model',                       example: 'deepseek-chat' },
    { key: 'EMBEDDING_BASE_URL', prompt: 'Embedding API Base URL',               example: 'https://api.siliconflow.cn/v1' },
    { key: 'EMBEDDING_API_KEY',  prompt: 'Embedding API Key',                    example: 'sk-...' },
    { key: 'EMBEDDING_MODEL',    prompt: 'Embedding Model name',                 example: 'BAAI/bge-m3' },
    { key: 'EMBEDDING_DIM',      prompt: 'Embedding dimension (default: 1024)', example: '1024' },
    { key: 'KB_DATA_DIR',        prompt: `Data directory (default: ${DATA_DIR})`, example: DATA_DIR },
  ];

  const lines = ['# agentic-library configuration', `# Generated: ${new Date().toISOString()}`, ''];
  for (const f of fields) {
    const val = await ask(`  ${f.prompt} [${f.example}]: `);
    if (val) {
      lines.push(`${f.key}=${val}`);
    } else {
      lines.push(`# ${f.key}=${f.example}`);
    }
  }
  lines.push('');

  const envPath = path.join(process.cwd(), '.env');
  fs.writeFileSync(envPath, lines.join('\n'));
  console.log('');
  console.log(`  ✅ Created ${envPath}`);
  console.log('');
  console.log('  Next:');
  console.log('    agentic-library start');
  console.log('');

  // Ensure data dir exists
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── config view / set ───────────────────────────────────────────────────────
async function cmdConfig(sub, key, value) {
  const configPath = path.join(DATA_DIR, 'config.json');

  if (sub === 'set' && key && value) {
    if (!fs.existsSync(configPath)) {
      // Bootstrap minimal config
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        version: '1.3',
        data_dir: DATA_DIR,
        llm: { provider: 'openai_compatible', base_url: '', api_key: '', chat_model: '' },
        embedding: { base_url: '', api_key: '', model: '', dim: 1024 },
        parameters: {
          noise_threshold: 0.4,
          synthesis_compactness: 0.9,
          max_cluster_size: 60,
          cold_start_max_n: 80,
          embedding_batch_size: 8,
        },
        external_agents: [],
      }, null, 2));
    }
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Support dotted paths like "llm.base_url"
    const parts = key.split('.');
    let target = cfg;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]]) target[parts[i]] = {};
      target = target[parts[i]];
    }
    const lastKey = parts[parts.length - 1];
    // Auto-convert numeric strings
    const numVal = Number(value);
    target[lastKey] = isNaN(numVal) ? value : numVal;

    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    console.log(`  ✅ Set ${key} = ${JSON.stringify(target[lastKey])}`);
    console.log(`  Config: ${configPath}`);
  } else {
    // View
    console.log(`  Config file: ${configPath}`);
    console.log(`  Data dir:    ${DATA_DIR}`);
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      console.log(`  LLM:         ${cfg.llm?.chat_model || '(not set)'} @ ${cfg.llm?.base_url || '(not set)'}`);
      console.log(`  Embedding:   ${cfg.embedding?.model || '(not set)'} dim=${cfg.embedding?.dim || '?'}`);
      console.log(`  Agents:      ${(cfg.external_agents || []).length} registered`);
    } else {
      console.log(`  ⚠️  No config yet. Run "agentic-library init" or start the server.`);
    }
    // Show .env location
    let envFound = null;
    for (const p of [path.join(process.cwd(), '.env'), path.join(PKG_ROOT, '.env')]) {
      if (fs.existsSync(p)) { envFound = p; break; }
    }
    if (envFound) console.log(`  .env:        ${envFound}`);
    else console.log(`  .env:        not found (use "agentic-library init" or set env vars)`);
  }
}

// ─── import ──────────────────────────────────────────────────────────────────
async function cmdImport(targetPath) {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    console.log(`❌ Path not found: ${resolved}`);
    process.exit(1);
  }

  // Check server
  let alive = false;
  try { const h = await request('GET', '/api/health'); alive = h.ok; } catch { /* down */ }
  if (!alive) {
    console.log('KB server is not running. Starting it first with "agentic-library start"...');
    process.exit(1);
  }

  const stat = fs.statSync(resolved);
  const files = [];

  if (stat.isDirectory()) {
    function walk(dir) {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const s = fs.statSync(full);
        if (s.isDirectory()) walk(full);
        else files.push(full);
      }
    }
    walk(resolved);
  } else {
    files.push(resolved);
  }

  if (files.length === 0) {
    console.log('No files found.');
    return;
  }

  console.log(`Importing ${files.length} file(s)...`);
  let imported = 0, failed = 0;

  for (const f of files) {
    // Skip hidden files and binary-looking extensions
    const ext = path.extname(f).toLowerCase();
    const skipExts = new Set(['.jpg','.jpeg','.png','.gif','.mp4','.mp3','.zip','.gz','.tar','.dmg','.exe']);
    if (skipExts.has(ext)) continue;

    try {
      const content = fs.readFileSync(f, 'utf-8');
      await request('POST', '/api/import/text', {
        text: content,
        filename: path.basename(f),
        source: `cli-import:${path.basename(f)}`,
      });
      imported++;
      if (imported % 10 === 0) process.stdout.write(`  ${imported}/${files.length}...\r`);
    } catch {
      failed++;
    }
  }
  console.log(`✅ Imported ${imported}, failed ${failed}`);
}

// ─── start with Python check ─────────────────────────────────────────────────
async function cmdStart() {
  // ── Python dependency check ────────────────────────────────────────────────
  console.log('Checking environment...');
  const warnings = [];

  let pythonOk = false;
  try {
    const pyVer = execSync('python3 --version 2>&1', { timeout: 5000 }).toString();
    process.stdout.write(`Python: ${pyVer.trim()}`);
    pythonOk = true;
  } catch { warnings.push('Python 3 not found — clustering will be unavailable.'); }

  if (pythonOk) {
    try {
      execSync('python3 -c "import hdbscan, sklearn, numpy" 2>&1', { timeout: 10000 });
      console.log('  ✅ umap-learn + hdbscan + scikit-learn');
    } catch {
      console.log('  ⚠️  Missing Python packages for clustering');
      console.log('     Install: pip3 install umap-learn hdbscan scikit-learn numpy');
      warnings.push('Python clustering packages missing. Install: pip3 install umap-learn hdbscan scikit-learn numpy');
    }
  }

  // ── Start server ───────────────────────────────────────────────────────────
  console.log('');
  console.log('Starting agentic-library server...');

  const distEntry = path.join(PKG_ROOT, 'packages', 'core', 'dist', 'index.js');
  const srcEntry = path.join(PKG_ROOT, 'packages', 'core', 'src', 'index.ts');

  if (fs.existsSync(distEntry)) {
    // npm install mode — use prebuilt dist
    process.env.KB_DATA_DIR = DATA_DIR;
    // dynamic import ESM from CJS
    import(pathToFileURL(distEntry)).catch((err) => {
      console.error('Failed to start server:', err.message);
      process.exit(1);
    });
  } else if (fs.existsSync(srcEntry)) {
    // Dev mode — use tsx
    console.log('(dev mode — using tsx)');
    try {
      execSync('npx tsx packages/core/src/index.ts', {
        cwd: PKG_ROOT,
        stdio: 'inherit',
        env: { ...process.env, KB_DATA_DIR: DATA_DIR },
      });
    } catch (err) {
      // tsx may exit with non-zero on SIGTERM — that's fine
    }
  } else {
    console.error('Cannot find server entry point.');
    console.error(`  Tried: ${distEntry}`);
    console.error(`  Tried: ${srcEntry}`);
    process.exit(1);
  }
}

function pathToFileURL(p) {
  // node:url is ESM-only; implement minimal version for CJS
  let resolved = path.resolve(p);
  if (process.platform === 'win32') {
    resolved = '/' + resolved.replace(/\\/g, '/');
  }
  return 'file://' + resolved;
}

// ─── other commands ──────────────────────────────────────────────────────────
async function checkServerAlive() {
  try { const h = await request('GET', '/api/health'); return h.ok === true; } catch { return false; }
}

async function cmdStatus() {
  const alive = await checkServerAlive();
  if (!alive) { console.log('Server not running. Start: agentic-library start'); return; }
  try {
    const s = await request('GET', '/api/status');
    console.log('KB Status:');
    console.log(`  Nodes:    ${s.counts?.total ?? '?'} (${s.counts?.raw ?? 0} raw + ${s.counts?.synthesis ?? 0} synth + ${s.counts?.reflection ?? 0} refl)`);
    console.log(`  Clusters: ${s.cluster_count ?? '?'}`);
    console.log(`  Pending:  ${s.counts?.pending_embed ?? 0} embed`);
  } catch (err) {
    console.log(`Status fetch failed: ${err.message}`);
  }
}

async function cmdRegister(agentId) {
  const id = agentId || `agent-${Date.now().toString(36)}`;
  const alive = await checkServerAlive();
  if (!alive) { console.log('Server not running. Start: agentic-library start'); return; }
  try {
    const r = await request('POST', '/api/agent/create', {
      agent_id: id,
      permissions: ['read', 'write', 'structural', 'admin'],
      description: 'Registered via agentic-library CLI',
    });
    console.log(`Agent:   ${r.agent_id || id}`);
    console.log(`API Key: ${r.api_key}`);
  } catch (err) {
    console.log(`Register failed: ${err.message}`);
  }
}

async function cmdOnboard(apiKey) {
  if (!apiKey) { console.log('Usage: agentic-library onboard <api_key>'); return; }
  const alive = await checkServerAlive();
  if (!alive) { console.log('Server not running. Start: agentic-library start'); return; }
  try {
    const r = await request('POST', '/api/agent/invoke', {
      agent_id: 'cli-agent',
      api_key: apiKey,
      tool_name: 'agent_onboarding',
      args: {},
    });
    const s = r.result?.kb_snapshot;
    console.log('KB Onboarding:');
    console.log(`  Nodes:     ${s?.nodes_total ?? '?'}`);
    console.log(`  Clusters:  ${s?.clusters ?? '?'}`);
    console.log(`  Flag queue: ${r.result?.flag_queue?.pending ?? 0} pending`);
    if (r.result?.quick_start?.recommended_first_steps?.length) {
      console.log('\nQuick start:');
      for (const step of r.result.quick_start.recommended_first_steps) {
        console.log(`  → ${step}`);
      }
    }
  } catch (err) {
    console.log(`Onboard failed: ${err.message}`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const cmd = process.argv[2] || 'start';
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  if (cmd === 'start')  return cmdStart();
  if (cmd === 'init')   return cmdInit();
  if (cmd === 'config') return cmdConfig(arg1, arg2, process.argv[5]);
  if (cmd === 'import') return cmdImport(arg1 || '.');

  // These commands need the server running
  if (cmd === 'status')   return cmdStatus();
  if (cmd === 'register') return cmdRegister(arg1);
  if (cmd === 'onboard')  return cmdOnboard(arg1);

  console.log('');
  console.log('agentic-library — Agent-oriented knowledge base');
  console.log('');
  console.log('Usage:');
  console.log('  agentic-library start              Start the KB server');
  console.log('  agentic-library init               Interactive setup wizard');
  console.log('  agentic-library config             View current config');
  console.log('  agentic-library config set <k> <v> Set a config value');
  console.log('  agentic-library import <path>      Import files into KB');
  console.log('  agentic-library register [name]    Register a new agent');
  console.log('  agentic-library status             Show KB health & stats');
  console.log('  agentic-library onboard <key>      Full agent onboarding');
  console.log('');
}

main().catch((e) => { console.error(e.message); process.exit(1); });

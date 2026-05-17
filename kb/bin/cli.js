#!/usr/bin/env node
/**
 * agentic-library CLI — zero-config KB server for any agent.
 *
 * Usage:
 *   npx agentic-library start          Start the KB server
 *   npx agentic-library register       Register a new agent (returns API key)
 *   npx agentic-library status         Show KB health and stats
 *   npx agentic-library onboard <key>  Full onboarding for a registered agent
 */

const http = require('http');

const DEFAULT_PORT = 7823;
const DEFAULT_HOST = '127.0.0.1';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: DEFAULT_HOST, port: DEFAULT_PORT, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); }
      });
    });
    req.on('error', (e) => reject(e));
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const cmd = process.argv[2] || 'start';
  const arg = process.argv[3];

  if (cmd === 'start') {
    console.log('Starting agentic-library server...');
    console.log(`  Server: http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
    console.log('  Health: http://localhost:7823/api/health');
    console.log('');
    console.log('Next steps for any agent:');
    console.log('  1. Register: npx agentic-library register my-agent');
    console.log('  2. Onboard:  curl -X POST http://localhost:7823/api/agent/invoke -d \'{"agent_id":"my-agent","api_key":"...","tool_name":"agent_onboarding"}\'');
    // Delegate to the actual server
    require('child_process').execSync('npx tsx packages/core/src/index.ts', { stdio: 'inherit', cwd: __dirname });
    return;
  }

  // Check if server is running
  let health;
  try { health = await request('GET', '/api/health'); } catch { health = null; }
  if (!health || !health.ok) {
    console.log('Server not running. Start it first: npx agentic-library start');
    process.exit(1);
  }

  if (cmd === 'status') {
    const s = await request('GET', '/api/status');
    console.log('KB Status:');
    console.log(`  Nodes: ${s.counts.total} (${s.counts.raw} raw + ${s.counts.synthesis} synth + ${s.counts.reflection} refl)`);
    console.log(`  Clusters: ${s.cluster_count}`);
    console.log(`  Pending embed: ${s.counts.pending_embed}`);
  } else if (cmd === 'register') {
    const agentId = arg || `agent-${Date.now().toString(36)}`;
    const r = await request('POST', '/api/agent/create', {
      agent_id: agentId,
      permissions: ['read', 'write', 'structural', 'admin'],
      description: `Registered via agentic-library CLI`,
    });
    console.log(`Agent registered: ${agentId}`);
    console.log(`API Key: ${r.api_key}`);
    console.log('');
    console.log('Connect any agent:');
    console.log(`  curl -X POST http://localhost:7823/api/agent/invoke \\`);
    console.log(`    -H 'Content-Type: application/json' \\`);
    console.log(`    -d '{"agent_id":"${agentId}","api_key":"${r.api_key}","tool_name":"agent_onboarding","args":{}}'`);
  } else if (cmd === 'onboard') {
    const apiKey = arg;
    if (!apiKey) { console.log('Usage: npx agentic-library onboard <api_key>'); process.exit(1); }
    const r = await request('POST', '/api/agent/invoke', {
      agent_id: 'cli-agent',
      api_key: apiKey,
      tool_name: 'agent_onboarding',
      args: {},
    });
    const s = r.result?.kb_snapshot;
    console.log('KB Onboarding:');
    console.log(`  ${s.nodes_total} nodes, ${s.clusters} clusters, ${s.nodes_reflection} reflections`);
    console.log(`  Flag queue: ${r.result?.flag_queue?.pending} pending`);
    console.log('');
    console.log('Quick start:');
    for (const step of r.result?.quick_start?.recommended_first_steps || []) {
      console.log(`  → ${step}`);
    }
  } else {
    console.log('Usage: npx agentic-library <start|register|status|onboard>');
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });

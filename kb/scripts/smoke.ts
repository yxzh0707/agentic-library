/**
 * End-to-end smoke test (per §11.2 of the implementation plan).
 *
 * Run after `pnpm dev` is up:
 *   pnpm tsx scripts/smoke.ts
 */

const BASE = process.env.KB_URL ?? 'http://127.0.0.1:7823';

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
  return res.json();
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function main() {
  console.log('1. health check');
  await get('/api/health');

  console.log('2. import 30 raw nodes across 3 themes');
  const themes = [
    'spaced repetition learning research',
    'sleep architecture and memory consolidation',
    'fermentation chemistry of sourdough bread',
  ];
  const created: string[] = [];
  for (let i = 0; i < 30; i++) {
    const theme = themes[i % themes.length] ?? themes[0]!;
    const body = `${theme} - sample note ${i}\n\n` + 'lorem ipsum '.repeat(60);
    const res = await post('/api/import/text', {
      body,
      l0_summary: `${theme} (#${i})`,
    });
    created.push(res.uuid);
  }
  console.log(`  created ${created.length}`);

  console.log('3. wait for embeddings');
  for (let i = 0; i < 30; i++) {
    const status = await get('/api/status');
    console.log(`  pending=${status.counts.pending_embed}`);
    if (status.counts.pending_embed === 0) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log('4. trigger monthly recluster');
  await post('/api/scheduler/trigger', { job_name: 'monthly' });
  await new Promise((r) => setTimeout(r, 8000));

  console.log('5. list clusters');
  const clusters = (await get('/api/clusters')).clusters;
  console.log(`  ${clusters.length} clusters`);

  console.log('6. trigger daily synthesis scan');
  await post('/api/scheduler/trigger', { job_name: 'daily' });
  await new Promise((r) => setTimeout(r, 5000));

  console.log('7. ask consultant');
  const chat = await post('/api/chat', {
    messages: [{ role: 'user', content: 'What do my notes say about memory and learning?' }],
  });
  console.log(`  answer length=${(chat.message.content ?? '').length}`);

  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

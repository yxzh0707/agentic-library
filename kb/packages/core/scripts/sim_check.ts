import { openDb } from '../src/storage/db.js';
import { IndexService } from '../src/indexing/index_service.js';

const db = openDb('/Users/apple/Downloads/kb_main');
const idx = new IndexService('/Users/apple/Downloads/kb_main', 1024);
const rows = db.prepare(`SELECT uuid, e_l1_id, l0_summary, hub_role_value FROM nodes WHERE status='active' AND node_type='raw' AND e_l1_id IS NOT NULL ORDER BY created_at`).all() as { uuid: string; e_l1_id: number; l0_summary: string; hub_role_value: string | null }[];

function cos(a: number[], b: number[]) {
  let d=0,na=0,nb=0;
  for (let i=0;i<a.length;i++){ d+=(a[i]??0)*(b[i]??0); na+=(a[i]??0)**2; nb+=(b[i]??0)**2; }
  return d/(Math.sqrt(na)*Math.sqrt(nb));
}

const items = rows.map(r => ({uuid: r.uuid.slice(0,8), hub: r.hub_role_value || '-', l0: r.l0_summary.slice(0,30), v: idx.getVector('l1', r.e_l1_id)!}));
console.log('--- 节点 ---');
for (const it of items) console.log(`  ${it.uuid} hub=${it.hub.padEnd(7)} ${it.l0}`);
console.log('\n--- 两两余弦相似度 ---');
console.log('         ' + items.map(i=>i.uuid.padStart(8)).join('  '));
for (const a of items) {
  process.stdout.write(`${a.uuid}`);
  for (const b of items) process.stdout.write(`  ${cos(a.v, b.v).toFixed(3).padStart(7)}`);
  process.stdout.write('\n');
}
const sims: number[] = [];
for (let i=0;i<items.length;i++) for (let j=i+1;j<items.length;j++) sims.push(cos(items[i]!.v,items[j]!.v));
console.log(`\n非自身相似度: 平均=${(sims.reduce((a,b)=>a+b,0)/sims.length).toFixed(3)} 最低=${Math.min(...sims).toFixed(3)} 最高=${Math.max(...sims).toFixed(3)}`);
process.exit(0);

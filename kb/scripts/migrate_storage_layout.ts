/**
 * One-shot migration: 2-hex-bucket layout → date-bucket layout.
 *
 *   <dataDir>/content/<2-hex>/<uuid>.md   (old)
 *     ↓
 *   <dataDir>/content/<YYYY-MM-DD>/<uuid-no-dashes>.md   (new)
 *
 * Date is taken from the file's frontmatter `created_at` (the file is the
 * source of truth — SQL is just a derived index). Uses `git mv` so content_git
 * preserves history across the rename. Empty hex buckets are removed at the
 * end.
 *
 * Usage:
 *   pnpm tsx scripts/migrate_storage_layout.ts [dataDir]
 *   # default dataDir is /Users/apple/Downloads/kb_main
 *
 * Idempotent: skips files already in the new layout.
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const HEX_BUCKET_RE = /^[0-9a-f]{2}$/i;
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_DASHED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRONTMATTER_DATE_RE = /^created_at:\s*(\S+)/m;

function uuidToFilename(uuid: string): string {
  return uuid.replace(/-/g, '');
}

function readCreatedAt(filePath: string): string | null {
  // Read just enough of the file to find the created_at line. Frontmatter is
  // always at the top so a 4 KB read is plenty.
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.slice(0, n).toString('utf-8');
    const m = FRONTMATTER_DATE_RE.exec(head);
    return m?.[1] ?? null;
  } finally {
    fs.closeSync(fd);
  }
}

interface MoveJob {
  oldAbs: string;
  newAbs: string;
  oldRel: string;
  newRel: string;
}

function planMoves(contentDir: string): { jobs: MoveJob[]; skipped: number; warnings: string[] } {
  const jobs: MoveJob[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  for (const sub of fs.readdirSync(contentDir)) {
    if (!HEX_BUCKET_RE.test(sub)) {
      // Already in date layout (or unrelated dir) — leave alone.
      if (DATE_DIR_RE.test(sub)) skipped++;
      continue;
    }
    const subPath = path.join(contentDir, sub);
    if (!fs.statSync(subPath).isDirectory()) continue;
    for (const fname of fs.readdirSync(subPath)) {
      if (!fname.endsWith('.md')) continue;
      const stem = fname.slice(0, -'.md'.length);
      if (!UUID_DASHED_RE.test(stem)) {
        warnings.push(`unexpected filename in ${sub}/: ${fname} — leaving in place`);
        continue;
      }
      const oldAbs = path.join(subPath, fname);
      const createdAt = readCreatedAt(oldAbs);
      if (!createdAt) {
        warnings.push(`no created_at in ${sub}/${fname} — leaving in place`);
        continue;
      }
      const date = createdAt.slice(0, 10);
      if (!DATE_DIR_RE.test(date)) {
        warnings.push(`unparseable created_at "${createdAt}" in ${sub}/${fname} — leaving in place`);
        continue;
      }
      const newName = `${uuidToFilename(stem)}.md`;
      const newAbs = path.join(contentDir, date, newName);
      jobs.push({
        oldAbs,
        newAbs,
        oldRel: path.join(sub, fname),
        newRel: path.join(date, newName),
      });
    }
  }
  return { jobs, skipped, warnings };
}

function gitInsideContentDir(contentDir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: contentDir, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function gitMv(contentDir: string, oldRel: string, newRel: string) {
  // Make sure the destination directory exists; `git mv` will create the file
  // but not the parent directory.
  fs.mkdirSync(path.dirname(path.join(contentDir, newRel)), { recursive: true });
  execFileSync('git', ['mv', oldRel, newRel], { cwd: contentDir, stdio: 'inherit' });
}

function plainMv(oldAbs: string, newAbs: string) {
  fs.mkdirSync(path.dirname(newAbs), { recursive: true });
  fs.renameSync(oldAbs, newAbs);
}

function removeEmptyHexBuckets(contentDir: string): number {
  let removed = 0;
  for (const sub of fs.readdirSync(contentDir)) {
    if (!HEX_BUCKET_RE.test(sub)) continue;
    const subPath = path.join(contentDir, sub);
    try {
      const entries = fs.readdirSync(subPath);
      if (entries.length === 0) {
        fs.rmdirSync(subPath);
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

function main() {
  const dataDir = process.argv[2] ?? '/Users/apple/Downloads/kb_main';
  const contentDir = path.join(dataDir, 'content');
  if (!fs.existsSync(contentDir)) {
    console.error(`content dir not found: ${contentDir}`);
    process.exit(1);
  }
  console.log(`migrating ${contentDir}`);

  const { jobs, skipped, warnings } = planMoves(contentDir);
  for (const w of warnings) console.warn('  WARN', w);
  console.log(`  ${jobs.length} files to move; ${skipped} date dirs already in place`);

  const useGit = gitInsideContentDir(contentDir);
  console.log(`  git in content/: ${useGit ? 'yes (will git mv)' : 'no (plain rename)'}`);

  let moved = 0;
  for (const job of jobs) {
    if (fs.existsSync(job.newAbs)) {
      console.warn(`  SKIP existing: ${job.newRel}`);
      continue;
    }
    if (useGit) {
      gitMv(contentDir, job.oldRel, job.newRel);
    } else {
      plainMv(job.oldAbs, job.newAbs);
    }
    moved++;
  }

  const removed = removeEmptyHexBuckets(contentDir);
  console.log(`  moved ${moved} files; removed ${removed} empty hex buckets`);

  if (useGit && moved > 0) {
    console.log('  committing rename batch');
    execFileSync('git', ['commit', '-m', 'migrate: 2-hex bucket → date bucket layout'], {
      cwd: contentDir,
      stdio: 'inherit',
    });
  }
  console.log('done');
}

main();

import { v7 as uuidv7 } from 'uuid';

export function newUuid(): string {
  return uuidv7();
}

const UUID_HEX_RE = /^[0-9a-f]{32}$/i;
const UUID_DASH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strip dashes from a canonical UUID. Used for filenames so on-disk names are
 *  32 chars instead of 36. The frontmatter / SQL / wikilinks keep the canonical
 *  dashed form — only filenames use the compact form. */
export function uuidToFilename(uuid: string): string {
  return uuid.replace(/-/g, '');
}

/** Inverse of uuidToFilename. Accepts either form (32-char compact or 36-char
 *  canonical), to keep reconcile compatible with files written by the old layout. */
export function filenameToUuid(filename: string): string | null {
  const stem = filename.replace(/\.md$/, '');
  if (UUID_DASH_RE.test(stem)) return stem.toLowerCase();
  if (UUID_HEX_RE.test(stem)) {
    const s = stem.toLowerCase();
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
  }
  return null;
}

import YAML from 'yaml';
import type { Node, NodeFrontmatter } from '@kb/shared';

const FM_DELIM = '---';

export function parseMarkdown(content: string, uuid: string): Node {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== FM_DELIM) {
    throw new Error(`node ${uuid}: missing frontmatter`);
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FM_DELIM) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) throw new Error(`node ${uuid}: unterminated frontmatter`);
  const yamlText = lines.slice(1, endIdx).join('\n');
  const fm = YAML.parse(yamlText) as NodeFrontmatter;
  const body = lines.slice(endIdx + 1).join('\n').replace(/^\n+/, '');
  return { ...fm, body };
}

export function serializeMarkdown(node: Node): string {
  const { body, ...fm } = node;
  const yamlText = YAML.stringify(fm, { lineWidth: 0 });
  return `${FM_DELIM}\n${yamlText}${FM_DELIM}\n\n${body}\n`;
}

const WIKILINK_RE = /\[\[([0-9a-fA-F-]{8,36})(?:\|[^\]]+)?\]\]/g;

export function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const id = m[1];
    if (id) out.add(id);
  }
  return [...out];
}

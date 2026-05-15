import path from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

// mammoth ships convertToMarkdown at runtime but omits it from its public .d.ts.
// Augment locally so we can call it without `as any`.
type MammothMarkdown = typeof mammoth & {
  convertToMarkdown: (input: { buffer: Buffer }) => Promise<{
    value: string;
    messages: Array<{ type: string; message: string }>;
  }>;
};

export type ParseFormat = 'markdown' | 'text' | 'pdf' | 'docx';

export interface DocumentStructure {
  /** Extracted heading hierarchy. level 1 is top-level (H1), 2 is H2, etc.
   *  text is the heading content; char_offset is approximate position of
   *  the heading line within `body` (0-based). For PDF, char_offset may
   *  be -1 if the outline source doesn't expose location. */
  headings: { level: number; text: string; char_offset: number }[];
  /** Where the structure came from. */
  source: 'markdown_regex' | 'pdf_outline' | 'text_heuristic' | 'none';
}

export interface ParsedFile {
  format: ParseFormat;
  /** Extracted body, normalized to UTF-8 string. DOCX is converted to Markdown
   *  with structure preserved (headings / bold / italics / lists / tables);
   *  PDF is plain text with original whitespace. */
  body: string;
  /** Original filename, useful for downstream metadata. */
  filename: string;
  /** Soft hints surfaced to caller (e.g. encrypted PDF, partial conversion). */
  warnings: string[];
  /** Heading-level structure if any was detected. Always present, may be empty. */
  structure: DocumentStructure;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

const TEXT_EXTS = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.log']);
const PDF_EXTS = new Set(['.pdf']);
const DOCX_EXTS = new Set(['.docx']);

export function classifyFile(filename: string): ParseFormat | 'unsupported' {
  const ext = path.extname(filename).toLowerCase();
  if (TEXT_EXTS.has(ext)) return ext === '.md' || ext === '.mdx' || ext === '.markdown' ? 'markdown' : 'text';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (DOCX_EXTS.has(ext)) return 'docx';
  return 'unsupported';
}

export async function parseFile(buffer: Buffer, filename: string): Promise<ParsedFile> {
  const kind = classifyFile(filename);
  const warnings: string[] = [];
  if (kind === 'unsupported') {
    throw new Error(`unsupported file format: ${path.extname(filename) || '<no ext>'}`);
  }
  let body: string;
  let pdfOutline: PdfOutline | null = null;
  if (kind === 'markdown' || kind === 'text') {
    body = buffer.toString('utf-8');
  } else if (kind === 'pdf') {
    const r = await parsePdf(buffer, warnings);
    body = r.text;
    pdfOutline = r.outline;
  } else {
    body = await parseDocx(buffer, warnings);
  }
  body = normalizeBody(body);
  if (Buffer.byteLength(body, 'utf-8') > MAX_BODY_BYTES) {
    warnings.push(`body truncated to ${MAX_BODY_BYTES} bytes`);
    body = body.slice(0, MAX_BODY_BYTES);
  }
  const structure = extractStructure(kind, body, pdfOutline);
  return { format: kind, body, filename, warnings, structure };
}

interface PdfOutlineNode {
  title: string;
  items: PdfOutlineNode[];
}
type PdfOutline = PdfOutlineNode[];

async function parsePdf(buffer: Buffer, warnings: string[]): Promise<{ text: string; outline: PdfOutline | null }> {
  // pdf-parse v2 exposes a stateful PDFParse class; pdfjs-dist takes ownership
  // of the underlying TypedArray, so copy into a fresh Uint8Array. destroy()
  // releases the worker.
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const textResult = await parser.getText();
    if (!textResult.text || textResult.text.trim().length === 0) {
      warnings.push('pdf produced empty text (likely scanned / image-only)');
      // still try outline — bookmarks may exist on a scanned PDF
    }
    let outline: PdfOutline | null = null;
    try {
      const info = await parser.getInfo();
      if (info.outline && info.outline.length > 0) {
        outline = normalizeOutline(info.outline);
      }
    } catch (err) {
      // Outline is best-effort; failures don't block ingestion.
      warnings.push(`pdf outline extraction skipped: ${(err as Error).message}`);
    }
    return { text: textResult.text ?? '', outline };
  } catch (err) {
    throw new Error(`pdf parse failed: ${(err as Error).message}`);
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// Recursively extract title + items from pdfjs-dist OutlineNode shape.
// We deliberately drop everything else (color, dest, url, count) — only
// hierarchy + title is needed for structure extraction.
function normalizeOutline(nodes: Array<{ title?: string; items?: unknown }>): PdfOutline {
  const result: PdfOutline = [];
  for (const n of nodes ?? []) {
    if (typeof n.title !== 'string' || n.title.trim().length === 0) continue;
    const items = Array.isArray(n.items) ? normalizeOutline(n.items as Array<{ title?: string; items?: unknown }>) : [];
    result.push({ title: n.title.trim(), items });
  }
  return result;
}

async function parseDocx(buffer: Buffer, warnings: string[]): Promise<string> {
  // convertToMarkdown preserves heading levels, bold/italic, lists, tables —
  // same target shape llm_wiki's docx-rs path produces.
  const m = mammoth as MammothMarkdown;
  const { value, messages } = await m.convertToMarkdown({ buffer });
  for (const msg of messages) {
    if (msg.type === 'warning' || msg.type === 'error') warnings.push(`mammoth: ${msg.message}`);
  }
  return value;
}

/**
 * Extract heading-level structure from a parsed document.
 *
 * Format-specific strategies:
 *
 * - markdown / docx: regex on the markdown body. DOCX is converted to
 *   markdown by mammoth in a previous step, so the same regex covers both.
 *   Setext-style headings (=== / ---) are NOT matched; ATX (#-style) only.
 *
 * - pdf: prefer the document's own outline (bookmarks/TOC) when present.
 *   Most academic papers, books, and well-authored technical PDFs have one.
 *   When absent, we fall back to a light heuristic on the body text: lines
 *   matching common section patterns ("Chapter N", "Section N.M", ALL CAPS
 *   on their own line). This is intentionally conservative — better to
 *   miss a heading than fabricate one.
 *
 * - text: numeric-prefix heuristic ("1. Title", "1.1 Sub"). Light, optional.
 */
export function extractStructure(
  format: ParseFormat,
  body: string,
  pdfOutline: PdfOutline | null,
): DocumentStructure {
  if (format === 'markdown' || format === 'docx') {
    return { headings: extractMarkdownHeadings(body), source: 'markdown_regex' };
  }
  if (format === 'pdf') {
    if (pdfOutline && pdfOutline.length > 0) {
      return { headings: flattenPdfOutline(pdfOutline), source: 'pdf_outline' };
    }
    // Fall through to text heuristic on the body — last resort.
    const heuristic = extractTextHeadings(body);
    return {
      headings: heuristic,
      source: heuristic.length > 0 ? 'text_heuristic' : 'none',
    };
  }
  if (format === 'text') {
    const heuristic = extractTextHeadings(body);
    return {
      headings: heuristic,
      source: heuristic.length > 0 ? 'text_heuristic' : 'none',
    };
  }
  return { headings: [], source: 'none' };
}

const MD_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function extractMarkdownHeadings(body: string): { level: number; text: string; char_offset: number }[] {
  const out: { level: number; text: string; char_offset: number }[] = [];
  let inCodeFence = false;
  let offset = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    // Skip ATX headings inside fenced code blocks (``` or ~~~)
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeFence = !inCodeFence;
    }
    if (!inCodeFence) {
      const m = MD_HEADING_RE.exec(line);
      if (m) {
        const level = m[1]?.length ?? 1;
        const text = (m[2] ?? '').trim();
        if (text.length > 0 && text.length <= 200) {
          out.push({ level, text, char_offset: offset });
        }
      }
    }
    offset += line.length + 1; // +1 for the newline removed by split
  }
  return out;
}

function flattenPdfOutline(outline: PdfOutline, level = 1): { level: number; text: string; char_offset: number }[] {
  const out: { level: number; text: string; char_offset: number }[] = [];
  for (const node of outline) {
    out.push({ level, text: node.title, char_offset: -1 }); // PDF outline doesn't expose body offset
    if (node.items.length > 0 && level < 6) {
      out.push(...flattenPdfOutline(node.items, level + 1));
    }
  }
  return out;
}

// Conservative text heuristic. Recognizes:
//   - "Chapter N" / "Chapter N: Title" / "第 N 章 ..."
//   - Numbered sections "1. Title", "1.1 Sub", "1.1.1 Subsub"
//   - ALL-CAPS lines (≥ 4 chars, only as level-1 if isolated by blank lines)
// We REJECT lines that look like list items, bullet points, code, prose
// sentences (ending with . or 。), or anything > 100 chars.
const NUMBERED_SECTION_RE = /^(\d+(?:\.\d+)*)\.?\s+(\S.{2,99})$/;
const CHAPTER_RE = /^(?:chapter|第\s*[一二三四五六七八九十0-9]+\s*章)\s*[:：．\.\-]?\s*(.{0,120})$/i;
const ALL_CAPS_RE = /^[A-Z][A-Z0-9 \-:&]{3,80}$/;

function extractTextHeadings(body: string): { level: number; text: string; char_offset: number }[] {
  const out: { level: number; text: string; char_offset: number }[] = [];
  const lines = body.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    let level: number | null = null;
    let text: string | null = null;

    const numbered = NUMBERED_SECTION_RE.exec(trimmed);
    if (numbered) {
      const numbering = numbered[1] ?? '';
      level = numbering.split('.').length;
      text = (numbered[2] ?? '').trim();
      // Reject if "title" looks like prose (sentence-ending)
      if (/[.。!?！？]$/.test(text)) {
        level = null;
        text = null;
      }
    } else if (CHAPTER_RE.test(trimmed)) {
      level = 1;
      text = trimmed;
    } else if (ALL_CAPS_RE.test(trimmed)) {
      // Require blank lines on at least one side — paragraph-isolated
      const prev = (lines[i - 1] ?? '').trim();
      const next = (lines[i + 1] ?? '').trim();
      if (prev === '' || next === '') {
        level = 1;
        text = trimmed;
      }
    }

    if (level !== null && text && text.length > 0 && text.length <= 100) {
      out.push({ level, text, char_offset: offset });
    }
    offset += line.length + 1;
  }
  return out;
}

function normalizeBody(body: string): string {
  // Strip BOM, collapse 3+ blank lines to 2, normalize CRLF.
  return body
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

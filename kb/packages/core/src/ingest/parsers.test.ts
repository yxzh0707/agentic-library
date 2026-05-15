import { describe, it, expect } from 'vitest';
import { classifyFile, parseFile, extractStructure } from './parsers.js';

describe('classifyFile', () => {
  it('routes by extension, case-insensitive', () => {
    expect(classifyFile('a.md')).toBe('markdown');
    expect(classifyFile('a.MD')).toBe('markdown');
    expect(classifyFile('a.markdown')).toBe('markdown');
    expect(classifyFile('a.txt')).toBe('text');
    expect(classifyFile('a.PDF')).toBe('pdf');
    expect(classifyFile('a.docx')).toBe('docx');
    expect(classifyFile('a.doc')).toBe('unsupported');
    expect(classifyFile('a.xlsx')).toBe('unsupported');
    expect(classifyFile('noext')).toBe('unsupported');
  });
});

describe('parseFile text/markdown', () => {
  it('reads utf-8 with BOM stripping and CRLF normalize', async () => {
    const body = '﻿# Title\r\n\r\n\r\n\r\nbody\r\n';
    const buf = Buffer.from(body, 'utf-8');
    const r = await parseFile(buf, 'note.md');
    expect(r.format).toBe('markdown');
    expect(r.body).toBe('# Title\n\nbody');
    expect(r.warnings).toEqual([]);
  });

  it('rejects unsupported with a clear error', async () => {
    await expect(parseFile(Buffer.from('x'), 'a.xls')).rejects.toThrow(/unsupported/);
  });
});

describe('extractStructure — markdown', () => {
  it('parses ATX headings with correct levels and offsets', () => {
    // body = "# A\nintro\n\n## B\nbody\n\n### C\nmore"
    // line offsets: "# A"=0 ; "intro"=4 ; ""=10 ; "## B"=11 ; "body"=16 ; ""=21 ; "### C"=22
    const body = '# A\nintro\n\n## B\nbody\n\n### C\nmore';
    const r = extractStructure('markdown', body, null);
    expect(r.source).toBe('markdown_regex');
    expect(r.headings).toEqual([
      { level: 1, text: 'A', char_offset: 0 },
      { level: 2, text: 'B', char_offset: 11 },
      { level: 3, text: 'C', char_offset: 22 },
    ]);
  });

  it('skips ATX headings inside fenced code blocks', () => {
    const body = '# Real heading\n\n```\n# not a heading\n```\n\n## Real';
    const r = extractStructure('markdown', body, null);
    expect(r.headings.map((h) => h.text)).toEqual(['Real heading', 'Real']);
  });

  it('handles trailing # marks', () => {
    const r = extractStructure('markdown', '## My Heading ##', null);
    expect(r.headings[0]?.text).toBe('My Heading');
  });

  it('docx routes to markdown extractor (mammoth produces markdown)', () => {
    const body = '# Doc Title\n\n## Section A\n\nbody';
    const r = extractStructure('docx', body, null);
    expect(r.source).toBe('markdown_regex');
    expect(r.headings.length).toBe(2);
  });

  it('returns empty headings for body with no headings', () => {
    const r = extractStructure('markdown', 'just plain text\nno headings here', null);
    expect(r.headings).toEqual([]);
  });
});

describe('extractStructure — pdf outline', () => {
  it('flattens nested outline with correct levels', () => {
    const outline = [
      {
        title: 'Chapter 1',
        items: [
          { title: 'Section 1.1', items: [] },
          { title: 'Section 1.2', items: [{ title: 'Sub 1.2.1', items: [] }] },
        ],
      },
      { title: 'Chapter 2', items: [] },
    ];
    const r = extractStructure('pdf', '', outline);
    expect(r.source).toBe('pdf_outline');
    expect(r.headings).toEqual([
      { level: 1, text: 'Chapter 1', char_offset: -1 },
      { level: 2, text: 'Section 1.1', char_offset: -1 },
      { level: 2, text: 'Section 1.2', char_offset: -1 },
      { level: 3, text: 'Sub 1.2.1', char_offset: -1 },
      { level: 1, text: 'Chapter 2', char_offset: -1 },
    ]);
  });

  it('falls back to text heuristic when outline is missing', () => {
    const body = '1. Introduction\n\nbody body body\n\n1.1 Background\n\nmore body';
    const r = extractStructure('pdf', body, null);
    expect(r.source).toBe('text_heuristic');
    expect(r.headings.map((h) => h.text)).toEqual(['Introduction', 'Background']);
  });

  it('returns source=none when both outline and heuristic find nothing', () => {
    const r = extractStructure('pdf', 'just prose without any structure markers.', null);
    expect(r.source).toBe('none');
    expect(r.headings).toEqual([]);
  });
});

describe('extractStructure — text heuristic', () => {
  it('catches numbered sections as nested headings', () => {
    const body = '1. Top\n\nfoo\n\n1.1 Sub\n\nbar\n\n1.1.1 Sub-sub\n\nbaz\n\n2. Another';
    const r = extractStructure('text', body, null);
    expect(r.headings.map((h) => `${h.level}:${h.text}`)).toEqual([
      '1:Top',
      '2:Sub',
      '3:Sub-sub',
      '1:Another',
    ]);
  });

  it('catches Chapter N pattern', () => {
    const body = 'Chapter 1: Beginnings\n\nfoo bar\n\n第 二 章 故事的展开\n\nmore';
    const r = extractStructure('text', body, null);
    expect(r.headings.length).toBe(2);
    expect(r.headings[0]?.text).toContain('Chapter 1');
  });

  it('catches isolated ALL-CAPS lines', () => {
    const body = '\nINTRODUCTION\n\nsome prose follows.\n\nMETHODS\n\nmore prose';
    const r = extractStructure('text', body, null);
    expect(r.headings.map((h) => h.text)).toEqual(['INTRODUCTION', 'METHODS']);
  });

  it('rejects prose-like lines that happen to start with a number', () => {
    // "1. The cat sat on the mat." ends with a period — looks like prose, not a heading.
    const body = '1. The cat sat on the mat.\n\nThis should not be a heading.';
    const r = extractStructure('text', body, null);
    expect(r.headings).toEqual([]);
  });

  it('rejects ALL-CAPS that is not paragraph-isolated', () => {
    const body = 'Some prose. SHOUTED WORDS HERE more prose follows immediately.';
    const r = extractStructure('text', body, null);
    expect(r.headings).toEqual([]);
  });
});


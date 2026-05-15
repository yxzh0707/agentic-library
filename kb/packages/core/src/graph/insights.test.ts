import { describe, it, expect } from 'vitest';
import {
  godNodes,
  surprisingConnections,
  knowledgeGaps,
  type InsightInput,
  type InsightNode,
  type InsightEdge,
} from './insights.js';

const N = (uuid: string, opts: Partial<InsightNode> = {}): InsightNode => ({
  uuid,
  node_type: 'raw',
  cluster_id: 0,
  l0_summary: `summary-${uuid}`,
  status: 'active',
  ...opts,
});

const E = (s: string, t: string, opts: Partial<InsightEdge> = {}): InsightEdge => ({
  source: s,
  target: t,
  kind: 'wikilink',
  relation_type: 'cites',
  confidence: 'EXTRACTED',
  ...opts,
});

describe('godNodes', () => {
  it('returns top-degree raw nodes sorted descending', () => {
    const input: InsightInput = {
      nodes: [N('a'), N('b'), N('c'), N('d')],
      edges: [E('a', 'b'), E('a', 'c'), E('a', 'd'), E('b', 'c')],
    };
    const r = godNodes(input);
    expect(r[0]?.uuid).toBe('a'); // degree 3
    expect(r[1]?.uuid).toMatch(/[bc]/); // tied at 2
    expect(r[0]?.degree).toBe(3);
  });

  it('excludes synthesis nodes (high degree by construction)', () => {
    const input: InsightInput = {
      nodes: [N('s', { node_type: 'synthesis' }), N('a'), N('b')],
      edges: [E('s', 'a'), E('s', 'b'), E('a', 'b')],
    };
    const r = godNodes(input);
    expect(r.find((g) => g.uuid === 's')).toBeUndefined();
    expect(r.length).toBeGreaterThan(0);
  });

  it('skips zero-degree nodes (no informational value)', () => {
    const input: InsightInput = {
      nodes: [N('a'), N('orphan')],
      edges: [],
    };
    expect(godNodes(input)).toEqual([]);
  });

  it('excludes archived/superseded nodes', () => {
    const input: InsightInput = {
      nodes: [N('a'), N('b', { status: 'archived' })],
      edges: [E('a', 'b'), E('b', 'a')],
    };
    const r = godNodes(input);
    expect(r.find((g) => g.uuid === 'b')).toBeUndefined();
  });

  it('respects topN parameter', () => {
    const input: InsightInput = {
      nodes: ['a', 'b', 'c', 'd', 'e'].map((u) => N(u)),
      edges: [
        E('a', 'b'),
        E('a', 'c'),
        E('a', 'd'),
        E('b', 'c'),
        E('b', 'd'),
        E('c', 'e'),
      ],
    };
    const r = godNodes(input, 2);
    expect(r.length).toBe(2);
  });
});

describe('surprisingConnections', () => {
  it('flags cross-cluster INFERRED edges high', () => {
    const input: InsightInput = {
      nodes: [N('a', { cluster_id: 0 }), N('b', { cluster_id: 1 })],
      edges: [E('a', 'b', { confidence: 'INFERRED', relation_type: 'builds_on' })],
    };
    const r = surprisingConnections(input);
    expect(r.length).toBe(1);
    expect(r[0]?.reasons).toContain('cross-cluster: 0 ↔ 1');
    expect(r[0]?.reasons).toContain('inferred: not explicitly stated');
  });

  it('skips structural mention/sources edges', () => {
    const input: InsightInput = {
      nodes: [N('a', { cluster_id: 0 }), N('b', { cluster_id: 1 })],
      edges: [E('a', 'b', { relation_type: 'mention' })],
    };
    expect(surprisingConnections(input)).toEqual([]);
  });

  it('boosts pure semantic similarity 1.5x', () => {
    const input: InsightInput = {
      nodes: [N('a', { cluster_id: 0 }), N('b', { cluster_id: 1 })],
      edges: [
        E('a', 'b', { relation_type: 'cites', confidence: 'EXTRACTED' }), // baseline
      ],
    };
    const baseline = surprisingConnections(input)[0]?.score ?? 0;
    const semInput: InsightInput = {
      nodes: input.nodes,
      edges: [
        E('a', 'b', { relation_type: 'semantically_similar', confidence: 'INFERRED', kind: 'similar' }),
      ],
    };
    const semScore = surprisingConnections(semInput)[0]?.score ?? 0;
    expect(semScore).toBeGreaterThan(baseline);
  });

  it('dedupes by cluster pair so one hub does not flood top-N', () => {
    // Hub `h` in cluster 0 cites 3 nodes in cluster 1 — should produce only 1 result.
    const input: InsightInput = {
      nodes: [
        N('h', { cluster_id: 0 }),
        N('a', { cluster_id: 1 }),
        N('b', { cluster_id: 1 }),
        N('c', { cluster_id: 1 }),
      ],
      edges: [
        E('h', 'a', { relation_type: 'cites', confidence: 'INFERRED' }),
        E('h', 'b', { relation_type: 'cites', confidence: 'INFERRED' }),
        E('h', 'c', { relation_type: 'cites', confidence: 'INFERRED' }),
      ],
    };
    const r = surprisingConnections(input);
    expect(r.length).toBe(1);
  });

  it('flags peripheral→hub when one side has degree ≤2 and other ≥5', () => {
    const nodes = [
      N('hub', { cluster_id: 0 }),
      N('peripheral', { cluster_id: 1 }),
      N('a', { cluster_id: 0 }),
      N('b', { cluster_id: 0 }),
      N('c', { cluster_id: 0 }),
      N('d', { cluster_id: 0 }),
      N('e', { cluster_id: 0 }),
    ];
    const edges: InsightEdge[] = [
      E('hub', 'a'),
      E('hub', 'b'),
      E('hub', 'c'),
      E('hub', 'd'),
      E('hub', 'e'),
      E('hub', 'peripheral', { relation_type: 'cites', confidence: 'INFERRED' }),
    ];
    const r = surprisingConnections({ nodes, edges });
    const peripheralEdge = r.find((s) => s.target === 'peripheral' || s.source === 'peripheral');
    expect(peripheralEdge?.reasons).toContain('peripheral node reaches hub');
  });
});

describe('knowledgeGaps', () => {
  it('flags orphans (degree ≤ 1)', () => {
    // a/b/c each have degree 2 (well-connected triangle); orphan has degree 0.
    const input: InsightInput = {
      nodes: [N('a'), N('b'), N('c'), N('orphan')],
      edges: [E('a', 'b'), E('a', 'c'), E('b', 'c')],
    };
    const r = knowledgeGaps(input);
    const orphans = r.filter((g) => g.type === 'orphan');
    expect(orphans.map((o) => o.refs.uuid)).toEqual(['orphan']);
  });

  it('also flags degree-1 nodes (loosely connected)', () => {
    // a has 2 connections, b has 2, weak has only 1 connection to a.
    const input: InsightInput = {
      nodes: [N('a'), N('b'), N('c'), N('weak')],
      edges: [E('a', 'b'), E('a', 'c'), E('b', 'c'), E('a', 'weak')],
    };
    const orphans = knowledgeGaps(input).filter((g) => g.type === 'orphan');
    expect(orphans.map((o) => o.refs.uuid)).toEqual(['weak']);
  });

  it('flags low-cohesion clusters when cohesion data provided', () => {
    const input: InsightInput = {
      nodes: ['a', 'b', 'c', 'd', 'e'].map((u) => N(u, { cluster_id: 7 })),
      edges: [E('a', 'b')], // very sparse
      cohesionByCluster: new Map([[7, 0.05]]),
    };
    const r = knowledgeGaps(input);
    const lowC = r.filter((g) => g.type === 'low_cohesion_cluster');
    expect(lowC.length).toBe(1);
    expect(lowC[0]?.refs.cluster_id).toBe(7);
  });

  it('does not flag low cohesion if member_count < minMembers', () => {
    const input: InsightInput = {
      nodes: ['a', 'b', 'c'].map((u) => N(u, { cluster_id: 7 })),
      edges: [],
      cohesionByCluster: new Map([[7, 0.0]]),
    };
    const r = knowledgeGaps(input, { minMembers: 5 });
    expect(r.filter((g) => g.type === 'low_cohesion_cluster')).toEqual([]);
  });

  it('flags bridge nodes connecting ≥ 3 clusters', () => {
    const input: InsightInput = {
      nodes: [
        N('hub', { cluster_id: 0 }),
        N('a', { cluster_id: 1 }),
        N('b', { cluster_id: 2 }),
        N('c', { cluster_id: 3 }),
      ],
      edges: [E('hub', 'a'), E('hub', 'b'), E('hub', 'c')],
    };
    const r = knowledgeGaps(input);
    const bridges = r.filter((g) => g.type === 'bridge_node');
    expect(bridges.length).toBe(1);
    expect(bridges[0]?.refs.uuid).toBe('hub');
    expect((bridges[0]?.evidence.bridged_clusters as number[]).sort()).toEqual([1, 2, 3]);
  });

  it('does not flag bridges below minBridgeClusters threshold', () => {
    const input: InsightInput = {
      nodes: [
        N('a', { cluster_id: 0 }),
        N('b', { cluster_id: 1 }),
        N('c', { cluster_id: 2 }),
      ],
      edges: [E('a', 'b'), E('a', 'c')], // a reaches 2 clusters; not yet a bridge
    };
    const r = knowledgeGaps(input, { minBridgeClusters: 3 });
    expect(r.filter((g) => g.type === 'bridge_node')).toEqual([]);
  });
});

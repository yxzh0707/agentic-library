import type {
  ClusterReviewPayload,
  HubRecommendation,
  Inheritance,
  InheritanceDecision,
  KBConfigParameters,
  Node,
  ReviewJudgment,
  SynthesisCandidate,
  SynthesisSubtype,
  ToolContext,
} from '@kb/shared';
import { z } from 'zod';
import crypto from 'node:crypto';
import type { DB } from '../storage/db.js';
import type { NodeStorage } from '../storage/storage.js';
import type { OpLogService } from '../op_log/op_log.js';
import type { LLMClient } from '../llm/client.js';
import type { EmbeddingService } from '../embedding/embedding.js';
import type { IndexService } from '../indexing/index_service.js';
import {
  buildConsolidationPrompt,
  buildClusterReviewPrompt,
  type SourceContext,
} from './prompts.js';
import { logger } from '../util/logger.js';

const ConsolidationOutput = z.object({
  body: z.string().min(20),
  l0_summary: z.string(),
  l1_overview: z.string(),
  self_rating: z.number().int().min(1).max(5),
  reasoning: z.string().optional(),
});

// LLMs (especially smaller ones like MiMo Flash) often return string "null"
// for nullable fields instead of actual JSON null. Coerce before validation.
const nullish = (inner: z.ZodTypeAny) =>
  z.preprocess((v) => (v === 'null' || v === '' || v === undefined ? null : v), inner.nullable().optional());

const ReviewJudgmentSchema = z.object({
  claim: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  proposed_action: nullish(z.enum(['move_out', 'archive', 'split_off'])),
  target_uuid: nullish(z.string()),
  target_cluster_id: nullish(z.union([z.number(), z.literal('new')])),
});

const SubThemeRecSchema = z.object({
  label: z.string(),
  anchor_uuid: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  reasoning: z.string().optional(),
});

const ClusterReviewOutput = z.object({
  body: z.string().min(20),
  l0_summary: z.string(),
  l1_overview: z.string(),
  self_rating: z.number().int().min(1).max(5),
  review_judgments: z.array(ReviewJudgmentSchema),
  hub_recommendation: nullish(
    z.object({ proposed_hub_uuid: z.string(), reasoning: z.string() }),
  ),
  sub_theme_recommendations: nullish(z.array(SubThemeRecSchema)),
  inheritance_decision: nullish(z.enum(['kept', 'modified', 'reversed'])),
  inheritance_reason: nullish(z.string()),
});

type GateRejection = { rejected: true; reason: string };
type GenerateOk = { rejected: false; node: Node };

export interface SynthesisDeps {
  db: DB;
  storage: NodeStorage;
  oplog: OpLogService;
  llm: LLMClient;
  embedding: EmbeddingService;
  index: IndexService;
  params: KBConfigParameters;
}

export class SynthesisService {
  constructor(private deps: SynthesisDeps) {}

  // ========== Gates ==========

  private preGate(candidate: SynthesisCandidate): { ok: true } | GateRejection {
    const { db } = this.deps;
    // P1 dedup (consolidation: same source set; cluster_review handled separately)
    if (candidate.subtype !== 'cluster_review') {
      const sourceKey = [...candidate.source_uuids].sort().join('|');
      const existing = db
        .prepare(
          "SELECT n.uuid FROM nodes n WHERE n.node_type='synthesis' AND n.status='active' AND n.synthesis_subtype=?",
        )
        .all(candidate.subtype) as { uuid: string }[];
      for (const e of existing) {
        const sources = db
          .prepare('SELECT source_uuid FROM synthesis_sources WHERE synthesis_uuid=?')
          .all(e.uuid) as { source_uuid: string }[];
        const k = sources.map((s) => s.source_uuid).sort().join('|');
        if (k === sourceKey) {
          return { rejected: true, reason: 'duplicate' };
        }
      }
    }
    // P2 source maturity: every source must be active raw
    const placeholders = candidate.source_uuids.map(() => '?').join(',');
    const types = db
      .prepare(`SELECT uuid, node_type, status FROM nodes WHERE uuid IN (${placeholders})`)
      .all(...candidate.source_uuids) as { uuid: string; node_type: string; status: string }[];
    if (types.length !== candidate.source_uuids.length) return { rejected: true, reason: 'source_missing' };
    if (types.some((t) => t.node_type !== 'raw' || t.status !== 'active')) {
      return { rejected: true, reason: 'invalid_source' };
    }
    return { ok: true };
  }

  private postGateConsolidation(
    body: string,
    sources: SourceContext[],
    compactness: number,
    novelty: number,
    self_rating: number,
  ): { ok: true } | GateRejection {
    const { params } = this.deps;
    const totalSourceTokens = sources.reduce((s, x) => s + estTokens(x.l1_overview), 0) + sources.reduce((s, x) => s + estTokens(x.body_excerpt), 0);
    // If source content is very short (under 200 tokens), the compactness ratio is misleading.
    // Short annotations of small source nodes should not be blocked.
    if (totalSourceTokens < 200 && compactness > params.compactness_hard_max) {
      // still allow it — compactness check doesn't apply to small sources
    } else if (compactness > params.compactness_hard_max) {
      return { rejected: true, reason: 'too_long' };
    }
    if (!validateCitations(body, sources.map((s) => s.uuid))) {
      return { rejected: true, reason: 'missing_citation' };
    }
    if (novelty < 1 - params.similarity_to_source_max) {
      return { rejected: true, reason: 'paraphrase' };
    }
    if (self_rating < params.self_rating_min) return { rejected: true, reason: 'low_quality' };
    return { ok: true };
  }

  private postGateClusterReview(
    body: string,
    memberUuids: string[],
    judgments: ReviewJudgment[],
    self_rating: number,
  ): { ok: true } | GateRejection {
    const { params } = this.deps;
    if (!validateCitations(body, memberUuids)) {
      return { rejected: true, reason: 'missing_citation' };
    }
    const hasMidConfidence = judgments.some((j) => j.confidence === 'medium' || j.confidence === 'high');
    if (!hasMidConfidence) {
      return { rejected: true, reason: 'no_confident_judgment' };
    }
    if (self_rating < params.self_rating_min) return { rejected: true, reason: 'low_quality' };
    return { ok: true };
  }

  // ========== Generate: consolidation ==========

  async generateConsolidation(
    candidate: SynthesisCandidate,
    ctx: ToolContext,
    instruction?: string,
    bypassPreGates = false,
  ): Promise<GenerateOk | GateRejection> {
    if (!bypassPreGates) {
      const pre = this.preGate(candidate);
      if ('rejected' in pre) return pre;
    }
    const { storage, llm, embedding, index, oplog } = this.deps;
    const sources: SourceContext[] = [];
    for (const u of candidate.source_uuids) {
      const node = storage.readNode(u);
      if (!node) return { rejected: true, reason: `source_missing:${u}` };
      sources.push({
        uuid: node.uuid,
        role: 'primary',
        l0_summary: node.l0_summary,
        l1_overview: node.l1_overview,
        body_excerpt: node.body.slice(0, 1500),
      });
    }
    const { system, user } = buildConsolidationPrompt(candidate, sources, instruction);
    const completion = await llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    let parsed;
    try {
      parsed = ConsolidationOutput.parse(JSON.parse(raw));
    } catch (err) {
      logger.warn({ err, raw }, 'consolidation output parse failed');
      return { rejected: true, reason: 'invalid_output' };
    }
    const sourceTokenSum = sources.reduce((s, x) => s + estTokens(x.l1_overview), 0);
    const compactness = sourceTokenSum > 0 ? estTokens(parsed.body) / sourceTokenSum : 1;
    let synEmbedding: number[] = [];
    try {
      synEmbedding = await embedding.embedOne(parsed.l1_overview);
    } catch (err) {
      logger.warn({ err }, 'failed to embed synthesis for novelty check');
    }
    let maxSim = 0;
    for (const s of sources) {
      const ptr = storage.getEmbeddingPointers(s.uuid);
      if (!ptr || ptr.e_l1_id === null || synEmbedding.length === 0) continue;
      const sv = index.getVector('l1', ptr.e_l1_id);
      if (!sv) continue;
      maxSim = Math.max(maxSim, cosineSim(synEmbedding, sv));
    }
    const novelty = synEmbedding.length === 0 ? 1 : 1 - maxSim;
    const post = this.postGateConsolidation(parsed.body, sources, compactness, novelty, parsed.self_rating);
    if ('rejected' in post) return post;
    const node = storage.createNode({
      node_type: 'synthesis',
      body: parsed.body,
      l0_summary: parsed.l0_summary,
      l1_overview: parsed.l1_overview,
      synthesis_subtype: 'consolidation',
      sources: candidate.source_uuids.map((u) => ({ uuid: u, role: 'primary' })),
      trigger: candidate.trigger,
      quality: {
        compactness_ratio: compactness,
        novelty_to_sources: novelty,
        self_rating: parsed.self_rating,
      },
      cluster_when_created: candidate.cluster_id ?? undefined,
      created_by: `agent:${ctx.agent_id}`,
      created_by_run: ctx.agent_run_id,
    });
    oplog.append({
      agent_run_id: ctx.agent_run_id,
      agent_id: ctx.agent_id,
      op_type: 'extract',
      args: {
        kind: 'consolidation',
        new_uuid: node.uuid,
        trigger: candidate.trigger,
      },
      reason: instruction ? `explicit consolidation: ${instruction}` : `consolidation from ${candidate.trigger.type}`,
      affected_uuids: [node.uuid, ...candidate.source_uuids],
    });
    return { rejected: false, node };
  }

  // ========== Generate: cluster_review ==========

  async generateClusterReview(
    cluster_id: number,
    ctx: ToolContext,
    options: { previous_uuid?: string | null; inheritance_hint?: InheritanceDecision } = {},
  ): Promise<GenerateOk | GateRejection> {
    const { db, storage, llm, oplog } = this.deps;
    const memberRows = db
      .prepare(
        "SELECT uuid, l0_summary, l1_overview, hub_role_value FROM nodes WHERE cluster_id=? AND status='active' AND node_type='raw'",
      )
      .all(cluster_id) as {
      uuid: string;
      l0_summary: string;
      l1_overview: string;
      hub_role_value: string | null;
    }[];
    if (memberRows.length < 2) {
      return { rejected: true, reason: 'cluster_too_small' };
    }
    const clusterRow = db
      .prepare('SELECT hub_uuid FROM clusters WHERE cluster_id=?')
      .get(cluster_id) as { hub_uuid: string | null } | undefined;

    let previous_review_body: string | null = null;
    if (options.previous_uuid) {
      const prev = storage.readNode(options.previous_uuid);
      if (prev) previous_review_body = prev.body;
    }

    const { system, user } = buildClusterReviewPrompt({
      cluster_id,
      members: memberRows,
      current_hub_uuid: clusterRow?.hub_uuid ?? null,
      previous_review_body,
    });
    const completion = await llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });
    const raw = completion.choices[0]?.message?.content ?? '';
    let parsed: z.infer<typeof ClusterReviewOutput>;
    try {
      parsed = ClusterReviewOutput.parse(JSON.parse(raw));
    } catch (err) {
      logger.warn({ err, raw }, 'cluster_review output parse failed');
      return { rejected: true, reason: 'invalid_output' };
    }

    const memberUuids = memberRows.map((m) => m.uuid);
    const judgments: ReviewJudgment[] = parsed.review_judgments.map((j) => ({
      claim: j.claim,
      confidence: j.confidence,
      proposed_action: j.proposed_action ?? null,
      target_uuid: j.target_uuid ?? null,
    }));
    const post = this.postGateClusterReview(parsed.body, memberUuids, judgments, parsed.self_rating);
    if ('rejected' in post) return post;

    const reviewedAtState = {
      member_count: memberRows.length,
      member_uuids: memberUuids,
      centroid_e_l1_hash: hashCentroid(db, cluster_id),
    };
    const hub_recommendation: HubRecommendation | null = parsed.hub_recommendation
      ? {
          proposed_hub_uuid: parsed.hub_recommendation.proposed_hub_uuid,
          reasoning: parsed.hub_recommendation.reasoning,
        }
      : null;
    const rawRecs: { label: string; anchor_uuid: string; confidence: 'high' | 'medium' | 'low'; reasoning?: string }[] = parsed.sub_theme_recommendations ?? [];
    const subThemeRecs = rawRecs
      .filter((s) => memberUuids.includes(s.anchor_uuid))
      .map((s) => ({
        label: s.label,
        anchor_uuid: s.anchor_uuid,
        confidence: s.confidence,
        reasoning: s.reasoning,
      }));
    const review_payload: ClusterReviewPayload = {
      reviewed_cluster_id: cluster_id,
      reviewed_at_state: reviewedAtState,
      review_judgments: judgments,
      hub_recommendation,
      sub_theme_recommendations: subThemeRecs.length > 0 ? subThemeRecs : undefined,
    };

    const inheritance: Inheritance | undefined = options.previous_uuid
      ? {
          previous_cluster_review_uuid: options.previous_uuid,
          inheritance_decision: parsed.inheritance_decision ?? options.inheritance_hint ?? null,
          inheritance_reason: parsed.inheritance_reason ?? null,
        }
      : undefined;

    const node = storage.createNode({
      node_type: 'synthesis',
      body: parsed.body,
      l0_summary: parsed.l0_summary,
      l1_overview: parsed.l1_overview,
      synthesis_subtype: 'cluster_review',
      sources: memberUuids.map((u) => ({ uuid: u, role: 'primary' })),
      trigger: { type: 'on_review', evidence: { cluster_id } },
      quality: {
        compactness_ratio: null,
        novelty_to_sources: null,
        self_rating: parsed.self_rating,
      },
      cluster_when_created: cluster_id,
      review_payload,
      inheritance,
      created_by: `agent:${ctx.agent_id}`,
      created_by_run: ctx.agent_run_id,
    });

    db.prepare('UPDATE clusters SET last_review_at=? WHERE cluster_id=?').run(
      new Date().toISOString(),
      cluster_id,
    );

    oplog.append({
      agent_run_id: ctx.agent_run_id,
      agent_id: ctx.agent_id,
      op_type: 'extract',
      args: {
        kind: 'cluster_review',
        new_uuid: node.uuid,
        cluster_id,
        previous_uuid: options.previous_uuid ?? null,
      },
      reason: `cluster_review for cluster #${cluster_id}`,
      affected_uuids: [node.uuid, ...memberUuids],
    });

    return { rejected: false, node };
  }

  /** v1.3 §10.4 — original cluster_review superseded; new ones generated for each new cluster_id. */
  async regenerateClusterReviewForSplit(
    old_cluster_id: number,
    new_cluster_ids: number[],
    ctx: ToolContext,
  ): Promise<{ generated: number; rejected: number }> {
    const old = this.deps.db
      .prepare(
        "SELECT uuid FROM nodes WHERE node_type='synthesis' AND synthesis_subtype='cluster_review' AND status='active' AND reviewed_cluster_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(old_cluster_id) as { uuid: string } | undefined;
    if (old) {
      this.deps.storage.supersedeNode(old.uuid, 'cluster_split');
    }
    let generated = 0;
    let rejected = 0;
    for (const cid of new_cluster_ids) {
      const r = await this.generateClusterReview(cid, ctx, {
        previous_uuid: old?.uuid ?? null,
        inheritance_hint: 'modified',
      });
      if (r.rejected) rejected++;
      else generated++;
    }
    return { generated, rejected };
  }

  async regenerateClusterReviewForMerge(
    old_cluster_ids: number[],
    new_cluster_id: number,
    ctx: ToolContext,
  ): Promise<GenerateOk | GateRejection> {
    let mostRecentPrev: { uuid: string; created_at: string } | undefined;
    for (const cid of old_cluster_ids) {
      const old = this.deps.db
        .prepare(
          "SELECT uuid, created_at FROM nodes WHERE node_type='synthesis' AND synthesis_subtype='cluster_review' AND status='active' AND reviewed_cluster_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(cid) as { uuid: string; created_at: string } | undefined;
      if (old) {
        this.deps.storage.supersedeNode(old.uuid, 'cluster_merged');
        if (!mostRecentPrev || old.created_at > mostRecentPrev.created_at) {
          mostRecentPrev = old;
        }
      }
    }
    return this.generateClusterReview(new_cluster_id, ctx, {
      previous_uuid: mostRecentPrev?.uuid ?? null,
      inheritance_hint: 'modified',
    });
  }

  // ========== explicit ==========

  async generateExplicit(input: {
    source_uuids: string[];
    subtype_hint?: SynthesisSubtype;
    instruction?: string;
    bypass_pre_gates?: boolean;
    reason: string;
    ctx: ToolContext;
  }): Promise<GenerateOk | GateRejection> {
    const subtype = input.subtype_hint ?? 'consolidation';
    const candidate: SynthesisCandidate = {
      source_uuids: input.source_uuids,
      cluster_id: this.commonClusterOf(input.source_uuids),
      subtype,
      trigger: {
        type: 'explicit',
        evidence: { reason: input.reason, requested_by: input.ctx.agent_id },
      },
    };
    if (subtype === 'consolidation') {
      return this.generateConsolidation(candidate, input.ctx, input.instruction, input.bypass_pre_gates);
    }
    return { rejected: true, reason: `explicit subtype not supported: ${subtype}` };
  }

  // ========== helpers ==========

  private commonClusterOf(uuids: string[]): number | null {
    const { db } = this.deps;
    if (uuids.length === 0) return null;
    const placeholders = uuids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT DISTINCT cluster_id FROM nodes WHERE uuid IN (${placeholders})`)
      .all(...uuids) as { cluster_id: number | null }[];
    if (rows.length === 1) return rows[0]!.cluster_id;
    return null;
  }
}

// ========== utils ==========

function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const CITATION_RE = /\[\[([0-9a-fA-F-]{8,36})\]\]/g;

function validateCitations(body: string, allowedUuids: string[]): boolean {
  const allowed = new Set(allowedUuids);
  const cited = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = CITATION_RE.exec(body)) !== null) {
    if (m[1]) cited.add(m[1]);
  }
  if (cited.size === 0) return false;
  for (const c of cited) if (!allowed.has(c)) return false;
  return true;
}

function hashCentroid(db: DB, cluster_id: number): string {
  const row = db.prepare('SELECT centroid_e_l1 FROM clusters WHERE cluster_id=?').get(cluster_id) as
    | { centroid_e_l1: Buffer | null }
    | undefined;
  if (!row?.centroid_e_l1) return 'no-centroid';
  return crypto.createHash('sha256').update(row.centroid_e_l1).digest('hex').slice(0, 16);
}

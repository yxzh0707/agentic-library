import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type {
  CreateNodeInput,
  HubRoleInfo,
  HubRoleSource,
  HubRoleValue,
  Node,
  NodeBrief,
  NodeFilter,
  NodeFrontmatter,
  LifecycleStatus,
  NodeType,
  SynthesisSubtype,
  ValidationStatus,
  ValidationState,
  ClusterReviewPayload,
  Inheritance,
} from '@kb/shared';
import { newUuid, uuidToFilename } from '../util/uuid.js';
import { nowIso } from '../util/now.js';
import { logger } from '../util/logger.js';
import { bus } from '../events/bus.js';
import { parseMarkdown, serializeMarkdown, extractWikilinks } from './frontmatter.js';
import { ContentGit } from './git_repo.js';
import type { DB } from './db.js';

export interface StorageDeps {
  db: DB;
  dataDir: string;
}

export class NodeStorage {
  private db: DB;
  private dataDir: string;
  private contentDir: string;
  private git: ContentGit;
  private lockPath: string;

  constructor({ db, dataDir }: StorageDeps) {
    this.db = db;
    this.dataDir = dataDir;
    this.contentDir = path.join(dataDir, 'content');
    if (!fs.existsSync(this.contentDir)) fs.mkdirSync(this.contentDir, { recursive: true });
    this.git = new ContentGit(dataDir);
    this.lockPath = path.join(dataDir, 'kb.lock');
    this.acquireLock();
  }

  private acquireLock() {
    if (fs.existsSync(this.lockPath)) {
      const pidStr = fs.readFileSync(this.lockPath, 'utf-8').trim();
      const pid = Number(pidStr);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error(`kb is already running (pid=${pid})`);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw err;
          }
        }
      }
    }
    fs.writeFileSync(this.lockPath, String(process.pid));
    process.on('exit', () => {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // ignore
      }
    });
  }

  releaseLock() {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // ignore
    }
  }

  // ========== file path helpers ==========
  //
  // Layout: <contentDir>/<YYYY-MM-DD>/<uuid-no-dashes>.md
  // The date directory comes from node.created_at (ISO 8601, slice(0,10)).
  // Filenames are 32-char hex (dashes stripped) — frontmatter / SQL / wikilinks
  // keep the canonical dashed UUID, only on-disk names are compact.
  //
  // Looking up a file by UUID requires its created_at (UUID v7 carries time
  // info but we don't decode it — SQL is the canonical source). Reconcile path
  // (SQL miss) falls back to a one-shot glob across date directories.

  private dateDir(createdAt: string): string {
    return createdAt.slice(0, 10);
  }

  private filePathForNode(node: Node): string {
    return path.join(this.contentDir, this.dateDir(node.created_at), `${uuidToFilename(node.uuid)}.md`);
  }

  private fileRelativeForNode(node: Node): string {
    return path.join(this.dateDir(node.created_at), `${uuidToFilename(node.uuid)}.md`);
  }

  /** Locate an on-disk file for `uuid`. Fast path: pull created_at from SQL.
   *  Fallback: glob each date directory (also matches the legacy 2-hex-bucket
   *  layout and dashed-uuid filenames so old files keep working until migrated). */
  private locateFile(uuid: string): string | null {
    const row = this.db
      .prepare('SELECT created_at FROM nodes WHERE uuid=?')
      .get(uuid) as { created_at: string } | undefined;
    if (row) {
      const direct = path.join(this.contentDir, this.dateDir(row.created_at), `${uuidToFilename(uuid)}.md`);
      if (fs.existsSync(direct)) return direct;
    }
    if (!fs.existsSync(this.contentDir)) return null;
    const compactName = `${uuidToFilename(uuid)}.md`;
    const dashedName = `${uuid}.md`;
    for (const sub of fs.readdirSync(this.contentDir)) {
      const subPath = path.join(this.contentDir, sub);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(subPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const compactCandidate = path.join(subPath, compactName);
      if (fs.existsSync(compactCandidate)) return compactCandidate;
      const dashedCandidate = path.join(subPath, dashedName);
      if (fs.existsSync(dashedCandidate)) return dashedCandidate;
    }
    return null;
  }

  private writeFile(node: Node) {
    const fp = this.filePathForNode(node);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, serializeMarkdown(node));
  }

  private readFile(uuid: string): Node {
    const fp = this.locateFile(uuid);
    if (!fp) throw new Error(`file not found for uuid ${uuid}`);
    const content = fs.readFileSync(fp, 'utf-8');
    return parseMarkdown(content, uuid);
  }

  private fileMtimeForNode(node: Node): number {
    return fs.statSync(this.filePathForNode(node)).mtimeMs;
  }

  // ========== CRUD ==========

  findByBodyHash(bodyHash: string): string | null {
    const row = this.db
      .prepare(
        "SELECT uuid FROM nodes WHERE body_sha256=? AND status='active' LIMIT 1",
      )
      .get(bodyHash) as { uuid: string } | undefined;
    return row?.uuid ?? null;
  }

  static hashBody(body: string): string {
    return crypto.createHash('sha256').update(body.trim(), 'utf-8').digest('hex');
  }

  createNode(input: CreateNodeInput): Node {
    const uuid = newUuid();
    const ts = nowIso();
    const wikilinks = input.wikilinks ?? extractWikilinks(input.body);
    const node: Node = {
      uuid,
      node_type: input.node_type,
      created_at: ts,
      updated_at: ts,
      created_by: input.created_by ?? 'human:default',
      created_by_run: input.created_by_run ?? 'manual',
      l0_summary: input.l0_summary ?? '',
      l1_overview: input.l1_overview ?? '',
      embeddings: {
        e_l0_id: null,
        e_l1_id: null,
        e_l2_id: null,
        model: null,
        embedded_at: null,
      },
      wikilinks,
      current_path: input.current_path ?? null,
      derived_state: {
        cluster_id: null,
        cluster_membership_strength: null,
        is_cluster_hub: false,
        hub_of_cluster: null,
      },
      lifecycle: {
        status: 'active',
        reference_count: 0,
        last_accessed_at: null,
        superseded_by: null,
        superseded_reason: null,
      },
      hub_role: input.hub_role,
      synthesis_subtype: input.synthesis_subtype,
      sources: input.sources,
      trigger: input.trigger,
      quality: input.quality,
      cluster_when_created: input.cluster_when_created,
      review_payload: input.review_payload,
      inheritance: input.inheritance,
      body: input.body,
    };

    this.writeFile(node);
    void this.git.commitFile(this.fileRelativeForNode(node), `create: ${uuid}`);
    this.upsertNodeRow(node);
    this.replaceWikilinks(uuid, wikilinks);
    if (input.sources && input.sources.length > 0) {
      this.replaceSources(uuid, input.sources);
    }

    logger.info({ uuid, node_type: node.node_type }, 'node created');
    bus.publish({ type: 'node_created', uuid });
    return node;
  }

  readNode(uuid: string): Node | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE uuid = ?').get(uuid) as
      | NodeRow
      | undefined;
    if (!row) {
      // Reconcile path: file exists but SQL row doesn't. Rebuild full state
      // including wikilinks + synthesis_sources so the relationship tables
      // stay in sync with frontmatter (single source of truth = markdown).
      try {
        const node = this.readFile(uuid);
        this.upsertNodeRow(node);
        this.replaceWikilinks(uuid, node.wikilinks);
        if (node.sources && node.sources.length > 0) {
          this.replaceSources(uuid, node.sources);
        }
        return node;
      } catch {
        return null;
      }
    }
    let node: Node;
    try {
      node = this.readFile(uuid);
      this.upsertNodeRow(node);
    } catch (err) {
      logger.warn({ err, uuid }, 'file missing for indexed node');
      return null;
    }
    return node;
  }

  updateNodeContent(uuid: string, newBody: string, reason: string): Node {
    const node = this.readNode(uuid);
    if (!node) throw new Error(`node not found: ${uuid}`);
    node.body = newBody;
    node.updated_at = nowIso();
    node.wikilinks = extractWikilinks(newBody);
    node.embeddings = { ...node.embeddings, embedded_at: null };
    this.writeFile(node);
    void this.git.commitFile(this.fileRelativeForNode(node), `update: ${uuid} - ${reason}`);
    this.upsertNodeRow(node);
    this.replaceWikilinks(uuid, node.wikilinks);
    bus.publish({ type: 'node_updated', uuid });
    return node;
  }

  updateNodeMetadata(uuid: string, patch: Partial<NodeFrontmatter>): Node {
    const node = this.readNode(uuid);
    if (!node) throw new Error(`node not found: ${uuid}`);
    Object.assign(node, patch);
    node.updated_at = nowIso();
    this.writeFile(node);
    void this.git.commitFile(this.fileRelativeForNode(node), `meta: ${uuid}`);
    this.upsertNodeRow(node);
    bus.publish({ type: 'node_updated', uuid });
    return node;
  }

  archiveNode(uuid: string, reason: string): void {
    const node = this.readNode(uuid);
    if (!node) return;
    node.lifecycle.status = 'archived';
    node.lifecycle.superseded_reason = reason;
    node.updated_at = nowIso();
    this.writeFile(node);
    void this.git.commitFile(this.fileRelativeForNode(node), `archive: ${uuid} - ${reason}`);
    this.upsertNodeRow(node);
    // Clean relationship edges so inactive nodes don't leak into the graph.
    // Hard-delete path already does this; soft archive should be consistent.
    this.db.prepare('DELETE FROM wikilinks WHERE source_uuid=? OR target_uuid=?').run(uuid, uuid);
    this.db.prepare('DELETE FROM synthesis_sources WHERE synthesis_uuid=? OR source_uuid=?').run(uuid, uuid);
    bus.publish({ type: 'node_archived', uuid });
  }

  deleteNodeFile(uuid: string): boolean {
    const fp = this.locateFile(uuid);
    if (!fp) return false;
    fs.unlinkSync(fp);
    logger.info({ uuid, fp }, 'hard-deleted markdown file');
    return true;
  }

  /** Mark a node as superseded with a reason (e.g. cluster_review after split). */
  supersedeNode(uuid: string, reason: string, supersededBy: string | null = null): void {
    const node = this.readNode(uuid);
    if (!node) return;
    node.lifecycle.status = 'superseded';
    node.lifecycle.superseded_reason = reason;
    node.lifecycle.superseded_by = supersededBy;
    node.updated_at = nowIso();
    this.writeFile(node);
    void this.git.commitFile(this.fileRelativeForNode(node), `supersede: ${uuid} - ${reason}`);
    this.upsertNodeRow(node);
    // Clean relationship edges so inactive nodes don't leak into the graph.
    this.db.prepare('DELETE FROM wikilinks WHERE source_uuid=? OR target_uuid=?').run(uuid, uuid);
    this.db.prepare('DELETE FROM synthesis_sources WHERE synthesis_uuid=? OR source_uuid=?').run(uuid, uuid);
    bus.publish({ type: 'node_archived', uuid });
  }

  listNodes(filter: NodeFilter = {}): NodeBrief[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.node_type) {
      where.push('node_type = $node_type');
      params.node_type = filter.node_type;
    }
    if (typeof filter.cluster_id === 'number') {
      where.push('cluster_id = $cluster_id');
      params.cluster_id = filter.cluster_id;
    }
    if (filter.status) {
      where.push('status = $status');
      params.status = filter.status;
    }
    if (filter.hub_role_value) {
      where.push('hub_role_value = $hub_role_value');
      params.hub_role_value = filter.hub_role_value;
    }
    if (filter.synthesis_subtype) {
      where.push('synthesis_subtype = $synthesis_subtype');
      params.synthesis_subtype = filter.synthesis_subtype;
    }
    if (filter.exclude_subtype) {
      where.push('(synthesis_subtype IS NULL OR synthesis_subtype != $exclude_subtype)');
      params.exclude_subtype = filter.exclude_subtype;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT uuid, node_type, l0_summary, l1_overview, current_path, cluster_id, status,
                embedded_at, hub_role_value, synthesis_subtype, is_cluster_hub, reviewed_cluster_id
         FROM nodes ${whereSql}
         ORDER BY updated_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
      )
      .all(params) as NodeBriefRow[];
    return rows.map(briefFromRow);
  }

  countByStatus(): { total: number; raw: number; synthesis: number; reflection: number; pending_embed: number } {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE status='active'").get() as { c: number }).c;
    const raw = (this.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE status='active' AND node_type='raw'").get() as { c: number }).c;
    const synth = (this.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE status='active' AND node_type='synthesis'").get() as { c: number }).c;
    const refl = (this.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE status='active' AND node_type='reflection'").get() as { c: number }).c;
    const pending = (this.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE status='active' AND embedded_at IS NULL").get() as { c: number }).c;
    return { total, raw, synthesis: synth, reflection: refl, pending_embed: pending };
  }

  pendingEmbeddingUuids(limit = 50): string[] {
    const rows = this.db
      .prepare(
        "SELECT uuid FROM nodes WHERE status='active' AND embedded_at IS NULL LIMIT ?",
      )
      .all(limit) as { uuid: string }[];
    return rows.map((r) => r.uuid);
  }

  /**
   * Update embedding pointers after the embedding worker writes vectors.
   * v1.3 only embeds l0 + l1; e_l2_id is always null.
   */
  setEmbeddingPointers(
    uuid: string,
    pointers: { e_l0_id: number; e_l1_id: number; model: string },
  ): void {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE nodes SET e_l0_id=?, e_l1_id=?, e_l2_id=NULL, embedding_model=?, embedded_at=?
         WHERE uuid=?`,
      )
      .run(pointers.e_l0_id, pointers.e_l1_id, pointers.model, ts, uuid);
    const node = this.readFile(uuid);
    node.embeddings = {
      e_l0_id: pointers.e_l0_id,
      e_l1_id: pointers.e_l1_id,
      e_l2_id: null,
      model: pointers.model,
      embedded_at: ts,
    };
    this.writeFile(node);
    bus.publish({ type: 'embedding_completed', uuid });
  }

  setClusterAssignment(uuid: string, cluster_id: number | null, strength: number): void {
    this.db
      .prepare('UPDATE nodes SET cluster_id=?, cluster_membership_strength=? WHERE uuid=?')
      .run(cluster_id, strength, uuid);
    if (cluster_id !== null) {
      const node = this.readFile(uuid);
      node.current_path = `/cluster_${cluster_id}`;
      node.derived_state = {
        ...node.derived_state,
        cluster_id,
        cluster_membership_strength: strength,
      };
      this.writeFile(node);
    }
    bus.publish({ type: 'cluster_assigned', uuid, cluster_id });
  }

  setCurrentPath(uuid: string, currentPath: string): void {
    const node = this.readFile(uuid);
    node.current_path = currentPath;
    node.updated_at = nowIso();
    this.writeFile(node);
    this.db.prepare('UPDATE nodes SET current_path=? WHERE uuid=?').run(currentPath, uuid);
  }

  /**
   * Mark / unmark a raw node as the canonical hub of its cluster.
   * Idempotent: if both SQL and markdown already match, no write happens
   * (avoids noise commits when recomputeHubs sweeps all nodes).
   */
  setIsClusterHub(uuid: string, isHub: boolean, hubOfCluster: number | null): void {
    let node: Node;
    try {
      node = this.readFile(uuid);
    } catch {
      return; // file gone (hard-deleted)
    }
    const currentIsHub = !!node.derived_state?.is_cluster_hub;
    const currentHubOf = node.derived_state?.hub_of_cluster ?? null;
    if (currentIsHub === isHub && currentHubOf === hubOfCluster) {
      // Already in sync — only ensure SQL row matches (cheap UPDATE).
      this.db
        .prepare('UPDATE nodes SET is_cluster_hub=?, hub_of_cluster=? WHERE uuid=?')
        .run(isHub ? 1 : 0, hubOfCluster, uuid);
      return;
    }
    this.db
      .prepare('UPDATE nodes SET is_cluster_hub=?, hub_of_cluster=? WHERE uuid=?')
      .run(isHub ? 1 : 0, hubOfCluster, uuid);
    node.derived_state = {
      ...node.derived_state,
      is_cluster_hub: isHub,
      hub_of_cluster: hubOfCluster,
    };
    this.writeFile(node);
  }

  /**
   * Update a raw node's hub_role with full history append. Caller is expected
   * to have already checked that the change differs from current state.
   */
  setHubRole(
    uuid: string,
    next: HubRoleValue,
    source: HubRoleSource,
    reason: string,
    opId: string | null,
    changedBy: string,
  ): void {
    const node = this.readFile(uuid);
    if (node.node_type !== 'raw') {
      throw new Error(`hub_role only applies to raw nodes (got ${node.node_type})`);
    }
    const prev: HubRoleInfo = node.hub_role ?? {
      value: 'neutral',
      source: 'auto_detected',
      reason: '',
      history: [],
    };
    const ts = nowIso();
    const newInfo: HubRoleInfo = {
      value: next,
      source,
      reason,
      history: [
        ...prev.history,
        {
          changed_at: ts,
          from: prev.value,
          to: next,
          changed_by: changedBy,
          op_id: opId,
          reason,
        },
      ],
    };
    node.hub_role = newInfo;
    node.updated_at = ts;
    this.writeFile(node);
    void this.git.commitFile(this.fileRelativeForNode(node), `hub_role: ${uuid} ${prev.value}->${next}`);
    this.db
      .prepare(
        'UPDATE nodes SET hub_role_value=?, hub_role_source=?, hub_role_reason=?, updated_at=? WHERE uuid=?',
      )
      .run(next, source, reason, ts, uuid);
    bus.publish({ type: 'node_updated', uuid });
  }

  /** Update a synthesis node's derived cluster_id (recomputed each clustering pass). */
  setSynthesisDerivedCluster(uuid: string, clusterId: number | null): void {
    this.db
      .prepare('UPDATE nodes SET cluster_id=? WHERE uuid=? AND node_type=?')
      .run(clusterId, uuid, 'synthesis');
    const node = this.readFile(uuid);
    node.derived_state = { ...node.derived_state, cluster_id: clusterId };
    this.writeFile(node);
  }

  /** Update a cluster_review's validation_state after each clustering pass. */
  setValidationState(uuid: string, state: ValidationState): void {
    this.db
      .prepare(
        'UPDATE nodes SET validation_status=?, primary_concentration=? WHERE uuid=? AND synthesis_subtype=?',
      )
      .run(
        state.validation_status,
        state.primary_concentration,
        uuid,
        'cluster_review',
      );
    const node = this.readFile(uuid);
    node.validation_state = state;
    this.writeFile(node);
  }

  getEmbeddingPointers(uuid: string): {
    e_l0_id: number | null;
    e_l1_id: number | null;
  } | null {
    const row = this.db
      .prepare('SELECT e_l0_id, e_l1_id FROM nodes WHERE uuid=?')
      .get(uuid) as { e_l0_id: number | null; e_l1_id: number | null } | undefined;
    return row ?? null;
  }

  allActiveRawWithL1(): { uuid: string; e_l1_id: number }[] {
    const rows = this.db
      .prepare(
        "SELECT uuid, e_l1_id FROM nodes WHERE status='active' AND node_type='raw' AND e_l1_id IS NOT NULL",
      )
      .all() as { uuid: string; e_l1_id: number }[];
    return rows;
  }

  // ========== private upserts ==========

  private upsertNodeRow(node: Node) {
    const fileMtime = this.fileMtimeForNode(node);
    const bodyHash = NodeStorage.hashBody(node.body);
    const reviewPayload = node.review_payload as ClusterReviewPayload | undefined;
    const inheritance = node.inheritance as Inheritance | undefined;
    const validation = node.validation_state as
      | { primary_concentration: number; validation_status: ValidationStatus }
      | undefined;
    this.db
      .prepare(
        `INSERT INTO nodes (
           uuid, node_type, created_at, updated_at, created_by, created_by_run,
           l0_summary, l1_overview, current_path, status, reference_count,
           last_accessed_at, superseded_by, superseded_reason,
           cluster_id, cluster_membership_strength, is_cluster_hub, hub_of_cluster,
           hub_role_value, hub_role_source, hub_role_reason,
           synthesis_subtype, trigger_type, cluster_when_created,
           compactness_ratio, novelty_to_sources, self_rating,
           reviewed_cluster_id, validation_status, primary_concentration,
           previous_cluster_review_uuid, inheritance_decision,
           e_l0_id, e_l1_id, e_l2_id, embedding_model, embedded_at, file_mtime,
           body_sha256
         ) VALUES (
           @uuid, @node_type, @created_at, @updated_at, @created_by, @created_by_run,
           @l0_summary, @l1_overview, @current_path, @status, @reference_count,
           @last_accessed_at, @superseded_by, @superseded_reason,
           @cluster_id, @cluster_membership_strength, @is_cluster_hub, @hub_of_cluster,
           @hub_role_value, @hub_role_source, @hub_role_reason,
           @synthesis_subtype, @trigger_type, @cluster_when_created,
           @compactness_ratio, @novelty_to_sources, @self_rating,
           @reviewed_cluster_id, @validation_status, @primary_concentration,
           @previous_cluster_review_uuid, @inheritance_decision,
           @e_l0_id, @e_l1_id, @e_l2_id, @embedding_model, @embedded_at, @file_mtime,
           @body_sha256
         )
         ON CONFLICT(uuid) DO UPDATE SET
           updated_at=excluded.updated_at,
           l0_summary=excluded.l0_summary,
           l1_overview=excluded.l1_overview,
           current_path=excluded.current_path,
           status=excluded.status,
           reference_count=excluded.reference_count,
           last_accessed_at=excluded.last_accessed_at,
           superseded_by=excluded.superseded_by,
           superseded_reason=excluded.superseded_reason,
           is_cluster_hub=excluded.is_cluster_hub,
           hub_of_cluster=excluded.hub_of_cluster,
           hub_role_value=excluded.hub_role_value,
           hub_role_source=excluded.hub_role_source,
           hub_role_reason=excluded.hub_role_reason,
           synthesis_subtype=excluded.synthesis_subtype,
           trigger_type=excluded.trigger_type,
           cluster_when_created=excluded.cluster_when_created,
           compactness_ratio=excluded.compactness_ratio,
           novelty_to_sources=excluded.novelty_to_sources,
           self_rating=excluded.self_rating,
           reviewed_cluster_id=excluded.reviewed_cluster_id,
           validation_status=excluded.validation_status,
           primary_concentration=excluded.primary_concentration,
           previous_cluster_review_uuid=excluded.previous_cluster_review_uuid,
           inheritance_decision=excluded.inheritance_decision,
           e_l0_id=COALESCE(excluded.e_l0_id, nodes.e_l0_id),
           e_l1_id=COALESCE(excluded.e_l1_id, nodes.e_l1_id),
           embedding_model=excluded.embedding_model,
           embedded_at=excluded.embedded_at,
           file_mtime=excluded.file_mtime,
           body_sha256=excluded.body_sha256
        `,
      )
      .run({
        uuid: node.uuid,
        node_type: node.node_type,
        created_at: node.created_at,
        updated_at: node.updated_at,
        created_by: node.created_by,
        created_by_run: node.created_by_run,
        l0_summary: node.l0_summary,
        l1_overview: node.l1_overview,
        current_path: node.current_path,
        status: node.lifecycle.status,
        reference_count: node.lifecycle.reference_count,
        last_accessed_at: node.lifecycle.last_accessed_at,
        superseded_by: node.lifecycle.superseded_by,
        superseded_reason: node.lifecycle.superseded_reason,
        cluster_id: node.derived_state?.cluster_id ?? null,
        cluster_membership_strength: node.derived_state?.cluster_membership_strength ?? null,
        is_cluster_hub: node.derived_state?.is_cluster_hub ? 1 : 0,
        hub_of_cluster: node.derived_state?.hub_of_cluster ?? null,
        hub_role_value: node.hub_role?.value ?? null,
        hub_role_source: node.hub_role?.source ?? null,
        hub_role_reason: node.hub_role?.reason ?? null,
        synthesis_subtype: node.synthesis_subtype ?? null,
        trigger_type: node.trigger?.type ?? null,
        cluster_when_created: node.cluster_when_created ?? null,
        compactness_ratio: node.quality?.compactness_ratio ?? null,
        novelty_to_sources: node.quality?.novelty_to_sources ?? null,
        self_rating: node.quality?.self_rating ?? null,
        reviewed_cluster_id: reviewPayload?.reviewed_cluster_id ?? null,
        validation_status: validation?.validation_status ?? null,
        primary_concentration: validation?.primary_concentration ?? null,
        previous_cluster_review_uuid: inheritance?.previous_cluster_review_uuid ?? null,
        inheritance_decision: inheritance?.inheritance_decision ?? null,
        e_l0_id: node.embeddings.e_l0_id,
        e_l1_id: node.embeddings.e_l1_id,
        e_l2_id: null,
        embedding_model: node.embeddings.model,
        embedded_at: node.embeddings.embedded_at,
        file_mtime: fileMtime,
        body_sha256: bodyHash,
      });
  }

  /**
   * Replace this node's outbound mention edges. v1.3 wikilinks only carry
   * mention semantics; the relation_type/confidence columns persist for
   * backward compat but new writes always use ('mention', 'EXTRACTED').
   */
  private replaceWikilinks(uuid: string, links: string[]) {
    this.db.prepare("DELETE FROM wikilinks WHERE source_uuid=?").run(uuid);
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO wikilinks (source_uuid, target_uuid, relation_type, confidence) VALUES (?, ?, 'mention', 'EXTRACTED')",
    );
    for (const t of links) stmt.run(uuid, t);
  }

  /** Public: delete a single wikilink edge. Used by hermes auto-clean rules. */
  deleteWikilink(source_uuid: string, target_uuid: string) {
    this.db.prepare('DELETE FROM wikilinks WHERE source_uuid=? AND target_uuid=?').run(source_uuid, target_uuid);
  }

  /** Generic typed query helper. Used by hermes rules to avoid direct db access. */
  queryAll<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  querySingle<T>(sql: string, params: unknown[] = []): T | null {
    return (this.db.prepare(sql).get(...params) as T | undefined) ?? null;
  }

  countActiveClusters(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM clusters WHERE status=?').get('active') as { c: number }).c;
  }

  listFrictionClusters(): number[] {
    return (this.db
      .prepare("SELECT cluster_id FROM clusters WHERE friction_count > 0 AND status='active'")
      .all() as { cluster_id: number }[])
      .map((r) => r.cluster_id);
  }

  countPendingOptimizationItems(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM optimization_queue WHERE status='pending'").get() as { c: number }).c;
  }

  private replaceSources(uuid: string, sources: { uuid: string; role: string }[]) {
    this.db.prepare('DELETE FROM synthesis_sources WHERE synthesis_uuid=?').run(uuid);
    const stmt = this.db.prepare(
      'INSERT INTO synthesis_sources (synthesis_uuid, source_uuid, role) VALUES (?, ?, ?)',
    );
    for (const s of sources) stmt.run(uuid, s.uuid, s.role);
  }

  // v2.0 Hermes Optimizer §4.3 — reasoning trace CRUD

  insertTrace(trace: {
    trace_id: string;
    agent_id: string;
    agent_run_id?: string;
    query_id?: string;
    task_type?: string;
    trace_content: string;
    evidence_uuids?: string[];
    final_answer_summary?: string;
    outcome?: string;
    expires_at?: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO reasoning_traces
          (trace_id, agent_id, agent_run_id, query_id, task_type, trace_content,
           evidence_uuids, final_answer_summary, outcome, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trace.trace_id,
        trace.agent_id,
        trace.agent_run_id ?? null,
        trace.query_id ?? null,
        trace.task_type ?? null,
        trace.trace_content,
        trace.evidence_uuids ? JSON.stringify(trace.evidence_uuids) : null,
        trace.final_answer_summary ?? null,
        trace.outcome ?? null,
        nowIso(),
        trace.expires_at ?? null,
      );
  }

  listTraces(opts?: { agent_run_id?: string; expired?: boolean; limit?: number }) {
    let sql = 'SELECT * FROM reasoning_traces WHERE 1=1';
    const params: unknown[] = [];
    if (opts?.agent_run_id) {
      sql += ' AND agent_run_id=?';
      params.push(opts.agent_run_id);
    }
    if (opts?.expired === false) {
      sql += ' AND (expires_at IS NULL OR expires_at > ?)';
      params.push(nowIso());
    } else if (opts?.expired === true) {
      sql += ' AND expires_at IS NOT NULL AND expires_at <= ?';
      params.push(nowIso());
    }
    sql += ' ORDER BY created_at DESC';
    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }
    return this.db.prepare(sql).all(...params);
  }

  deleteExpiredTraces() {
    return this.db
      .prepare('DELETE FROM reasoning_traces WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(nowIso());
  }

  // v2.0 Hermes Optimizer §4.1 — heartbeat.md read/write

  private get hermesDir(): string {
    return path.join(this.dataDir, 'hermes');
  }

  readHeartbeat(): string | null {
    const heartbeatPath = path.join(this.hermesDir, 'heartbeat.md');
    if (!fs.existsSync(heartbeatPath)) return null;
    return fs.readFileSync(heartbeatPath, 'utf-8');
  }

  updateHeartbeat(content: string) {
    if (!fs.existsSync(this.hermesDir)) {
      fs.mkdirSync(this.hermesDir, { recursive: true });
    }
    fs.writeFileSync(path.join(this.hermesDir, 'heartbeat.md'), content, 'utf-8');
  }

  // v2.0 Hermes Optimizer §4.4 — optimization_queue CRUD

  insertOptimizationItem(input: {
    item_id: string;
    problem_type: string;
    target_uuid?: string | null;
    target_cluster_id?: number | null;
    evidence?: string;
    proposed_action?: string;
    risk_level: string;
    created_by: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO optimization_queue
          (item_id, problem_type, target_uuid, target_cluster_id, evidence,
           proposed_action, risk_level, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.item_id,
        input.problem_type,
        input.target_uuid ?? null,
        input.target_cluster_id ?? null,
        input.evidence ?? null,
        input.proposed_action ?? null,
        input.risk_level,
        input.created_by,
        nowIso(),
      );
  }

  listOptimizationQueue(filter?: {
    status?: string;
    risk_level?: string;
    limit?: number;
  }): unknown[] {
    let sql = 'SELECT * FROM optimization_queue WHERE 1=1';
    const params: unknown[] = [];
    if (filter?.status) {
      sql += ' AND status=?';
      params.push(filter.status);
    }
    if (filter?.risk_level) {
      sql += ' AND risk_level=?';
      params.push(filter.risk_level);
    }
    sql += ' ORDER BY created_at DESC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    return this.db.prepare(sql).all(...params);
  }

  resolveOptimizationItem(item_id: string, resolution: string) {
    this.db
      .prepare(
        "UPDATE optimization_queue SET status='resolved', resolved_at=?, resolution=? WHERE item_id=?",
      )
      .run(nowIso(), resolution, item_id);
  }
}

interface NodeRow {
  uuid: string;
  node_type: NodeType;
  status: LifecycleStatus;
  file_mtime: number | null;
}

interface NodeBriefRow {
  uuid: string;
  node_type: NodeType;
  l0_summary: string;
  l1_overview: string;
  current_path: string | null;
  cluster_id: number | null;
  status: LifecycleStatus;
  embedded_at: string | null;
  hub_role_value: HubRoleValue | null;
  synthesis_subtype: SynthesisSubtype | null;
  is_cluster_hub: number;
  reviewed_cluster_id: number | null;
}

function briefFromRow(r: NodeBriefRow): NodeBrief {
  return {
    uuid: r.uuid,
    node_type: r.node_type,
    l0_summary: r.l0_summary,
    l1_overview: r.l1_overview,
    current_path: r.current_path,
    cluster_id: r.cluster_id,
    status: r.status,
    hub_role_value: r.hub_role_value ?? undefined,
    synthesis_subtype: r.synthesis_subtype ?? undefined,
    is_cluster_hub: r.is_cluster_hub === 1,
    reviewed_cluster_id: r.reviewed_cluster_id ?? undefined,
    embedded: r.embedded_at !== null,
  };
}

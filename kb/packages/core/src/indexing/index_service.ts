import path from 'node:path';
import fs from 'node:fs';
import hnswlib from 'hnswlib-node';
import { HNSW_EF_CONSTRUCTION, HNSW_EF_SEARCH, HNSW_M } from '@kb/shared';
import { logger } from '../util/logger.js';

type Level = 'l0' | 'l1';
const LEVELS: Level[] = ['l0', 'l1'];

const MAX_ELEMENTS = 100_000;

interface LevelState {
  index: hnswlib.HierarchicalNSW;
  nextId: number;
  removed: Set<number>;
  dim: number;
  path: string;
}

export class IndexService {
  private dataDir: string;
  private states: Record<Level, LevelState | null> = { l0: null, l1: null };
  private dim: number;

  constructor(dataDir: string, dim: number) {
    this.dataDir = dataDir;
    this.dim = dim;
    const indicesDir = path.join(dataDir, 'indices');
    if (!fs.existsSync(indicesDir)) fs.mkdirSync(indicesDir, { recursive: true });
    for (const lvl of LEVELS) {
      this.states[lvl] = this.loadOrCreate(lvl, dim);
    }
  }

  private loadOrCreate(level: Level, dim: number): LevelState {
    const file = path.join(this.dataDir, 'indices', `e_${level}.hnsw`);
    const idx = new hnswlib.HierarchicalNSW('cosine', dim);
    if (fs.existsSync(file)) {
      try {
        idx.readIndexSync(file, false);
        if (idx.getMaxElements() < MAX_ELEMENTS) idx.resizeIndex(MAX_ELEMENTS);
        idx.setEf(HNSW_EF_SEARCH);
        const next = idx.getCurrentCount();
        return { index: idx, nextId: next, removed: new Set(), dim, path: file };
      } catch (err) {
        logger.warn({ err, file }, 'failed to load index, recreating');
      }
    }
    idx.initIndex(MAX_ELEMENTS, HNSW_M, HNSW_EF_CONSTRUCTION);
    idx.setEf(HNSW_EF_SEARCH);
    return { index: idx, nextId: 0, removed: new Set(), dim, path: file };
  }

  private state(level: Level): LevelState {
    const s = this.states[level];
    if (!s) throw new Error(`index not initialized: ${level}`);
    return s;
  }

  addVector(level: Level, vector: number[]): number {
    const s = this.state(level);
    if (vector.length !== s.dim) {
      throw new Error(`embedding dim mismatch: expected ${s.dim}, got ${vector.length}`);
    }
    const id = s.nextId++;
    s.index.addPoint(vector, id);
    return id;
  }

  markVectorRemoved(level: Level, internalId: number): void {
    const s = this.state(level);
    s.removed.add(internalId);
  }

  searchKNN(
    level: Level,
    queryVector: number[],
    k: number,
    excludeIds: Set<number> = new Set(),
  ): { id: number; distance: number }[] {
    const s = this.state(level);
    if (s.nextId === 0) return [];
    const requested = Math.min(k + s.removed.size + excludeIds.size, s.nextId);
    const res = s.index.searchKnn(queryVector, requested);
    const out: { id: number; distance: number }[] = [];
    for (let i = 0; i < res.neighbors.length && out.length < k; i++) {
      const id = res.neighbors[i]!;
      if (s.removed.has(id) || excludeIds.has(id)) continue;
      out.push({ id, distance: res.distances[i]! });
    }
    return out;
  }

  getVector(level: Level, internalId: number): number[] | null {
    const s = this.state(level);
    try {
      return s.index.getPoint(internalId);
    } catch {
      return null;
    }
  }

  persist(): void {
    for (const lvl of LEVELS) {
      const s = this.states[lvl];
      if (!s) continue;
      try {
        s.index.writeIndexSync(s.path);
      } catch (err) {
        logger.warn({ err, path: s.path }, 'failed to persist index');
      }
    }
  }

  resetAll(newDim: number): void {
    this.dim = newDim;
    for (const lvl of LEVELS) {
      const file = path.join(this.dataDir, 'indices', `e_${lvl}.hnsw`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      this.states[lvl] = this.loadOrCreate(lvl, newDim);
    }
  }

  get embeddingDim(): number {
    return this.dim;
  }
}

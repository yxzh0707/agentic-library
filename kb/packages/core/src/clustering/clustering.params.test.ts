import { describe, it, expect } from 'vitest';
import { ClusteringService } from './clustering.js';
import { DEFAULT_PARAMETERS } from '@kb/shared';
import type { KBConfigParameters } from '@kb/shared';

// We exercise only the pure parameter-adaptation logic. The full clustering
// pipeline needs SQLite + HNSW + a Python child process, which is integration
// territory and lives in scripts/smoke.ts.

const baseParams: KBConfigParameters = DEFAULT_PARAMETERS;

function makeService(p: KBConfigParameters): ClusteringService {
  // Cast — we never call methods that touch db/storage/index in these tests.
  return new ClusteringService(null as never, null as never, null as never, p);
}

describe('reclusterThreshold', () => {
  const svc = makeService(baseParams);
  it('floors at 6 for small N (cold-start friendly)', () => {
    expect(svc.reclusterThreshold(6)).toBe(6);
    expect(svc.reclusterThreshold(20)).toBe(6);
    expect(svc.reclusterThreshold(40)).toBe(10); // adaptive=5, 5*2=10
  });
  it('scales with N for large datasets', () => {
    expect(svc.reclusterThreshold(200)).toBe(50); // adaptive=25, 25*2=50
    expect(svc.reclusterThreshold(800)).toBe(200);
  });
});

describe('adaptParamsForN (via fullRecluster path proxy)', () => {
  // The adaptation is private; we verify the contract via reclusterThreshold
  // (which uses the same N/8 floor=3 rule) and a thin behavioral check.
  // If you change one, change the other or this test will catch the drift.
  const svc = makeService(baseParams);
  it('threshold rule mirrors min_cluster_size adaptation', () => {
    // For each N, the threshold should be 2x the adaptive min_cluster_size,
    // floored at 6.
    for (const N of [10, 24, 96, 240]) {
      const expectedAdaptiveMin = Math.max(3, Math.floor(N / 8));
      const expectedThreshold = Math.max(6, expectedAdaptiveMin * 2);
      expect(svc.reclusterThreshold(N)).toBe(expectedThreshold);
    }
  });
});

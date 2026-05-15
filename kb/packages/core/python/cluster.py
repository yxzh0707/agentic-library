#!/usr/bin/env python3
"""
Cluster computation service. Reads JSON task from stdin or a temp file,
writes JSON result to stdout.

Tasks:
  - full_recluster   : UMAP + HDBSCAN on a list of embedding vectors
  - detect_substructure : k-means k=2..4 + silhouette over a single cluster
"""
import sys
import json

import numpy as np
import umap  # noqa: E402
import hdbscan  # noqa: E402
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score


def full_recluster(embeddings, params):
    arr = np.array(embeddings, dtype=np.float32)
    n = arr.shape[0]
    if n < params.get('hdbscan_min_cluster_size', 12):
        return {'labels': [-1] * n, 'probabilities': [0.0] * n}
    # Tiny-N path: skip UMAP. UMAP's spectral_layout calls scipy.eigsh which
    # requires k < N (k = n_components + 1), so it crashes for very small N
    # even with adaptive n_components. Run HDBSCAN directly on raw vectors
    # (cosine metric) — works fine and avoids the eigsh constraint.
    if n < 10:
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=params.get('hdbscan_min_cluster_size', 12),
            min_samples=params.get('hdbscan_min_samples', 5),
            metric='euclidean',
            cluster_selection_method='eom',
        )
        labels = clusterer.fit_predict(arr)
        return {
            'labels': labels.tolist(),
            'probabilities': clusterer.probabilities_.tolist(),
        }
    reducer = umap.UMAP(
        n_neighbors=min(params.get('umap_n_neighbors', 15), max(2, n - 1)),
        # n_components + 1 must be < N for scipy.eigsh inside spectral_layout.
        n_components=min(params.get('umap_n_components', 50), max(2, n - 2)),
        metric='cosine',
        min_dist=0.0,
        random_state=42,
    )
    reduced = reducer.fit_transform(arr)
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=params.get('hdbscan_min_cluster_size', 12),
        min_samples=params.get('hdbscan_min_samples', 5),
        metric='euclidean',
        cluster_selection_method='eom',
    )
    labels = clusterer.fit_predict(reduced)
    probabilities = clusterer.probabilities_
    return {
        'labels': labels.tolist(),
        'probabilities': probabilities.tolist(),
    }


def detect_substructure(embeddings, params):
    arr = np.array(embeddings, dtype=np.float32)
    if len(arr) < 6:
        return {
            'silhouette': 0.0,
            'recommended_action': 'noop',
            'sub_assignments': None,
            'k': None,
        }
    best_silhouette = -1.0
    best_k = None
    best_labels = None
    for k in [2, 3, 4]:
        if len(arr) < k * 2:
            continue
        km = KMeans(n_clusters=k, random_state=42, n_init=10)
        sub_labels = km.fit_predict(arr)
        score = float(silhouette_score(arr, sub_labels))
        if score > best_silhouette:
            best_silhouette = score
            best_k = k
            best_labels = sub_labels
    split_threshold = params.get('silhouette_split_threshold', 0.5)
    pattern_threshold = params.get('silhouette_pattern_threshold', 0.4)
    if best_labels is not None:
        unique, counts = np.unique(best_labels, return_counts=True)
        ratio = counts.max() / max(1, counts.min())
    else:
        ratio = float('inf')
    if best_silhouette > split_threshold and ratio < 5:
        action = 'split'
    elif best_silhouette > pattern_threshold:
        action = 'pattern_synthesis'
    else:
        action = 'noop'
    return {
        'silhouette': best_silhouette,
        'recommended_action': action,
        'sub_assignments': best_labels.tolist() if best_labels is not None else None,
        'k': best_k,
    }


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--file':
        with open(sys.argv[2], 'r') as f:
            task = json.load(f)
    else:
        task = json.load(sys.stdin)
    op = task['op']
    if op == 'full_recluster':
        result = full_recluster(task['embeddings'], task.get('params', {}))
    elif op == 'detect_substructure':
        result = detect_substructure(task['embeddings'], task.get('params', {}))
    else:
        result = {'error': f'unknown op: {op}'}
    json.dump(result, sys.stdout)


if __name__ == '__main__':
    main()

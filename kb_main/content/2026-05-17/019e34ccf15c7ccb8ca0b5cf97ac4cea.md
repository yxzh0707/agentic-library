---
uuid: 019e34cc-f15c-7ccb-8ca0-b5cf97ac4cea
node_type: raw
created_at: 2026-05-17T07:18:26.908Z
updated_at: 2026-05-17T07:34:10.774Z
created_by: human:default
created_by_run: import:markdown:summary_2026-05-01.md
l0_summary: 对比实验发现cold restart关键、timestamp_split负效、id_dropout正效但需正确基准。
l1_overview: 对比四个实验：baseline-0、I-503（关闭cold restart）、I-601（启用timestamp_split）、I-602（id_dropout+timestamp_split）。关键发现：(1) cold restart不可禁用，I-503 AUC下降-0.01376；(2) timestamp_split意外造成-0.0122回归，可能源于最佳epoch漂移或数据分割假设失效；(3) id_dropout以I-601为基准时正向+0.0044，但直接对比baseline-0为负，表明其效果依赖于timestamp_split基础。推理时间波动为平台噪音。推荐下一实验I-603：在baseline-0上单独测试id_dropout，以消除混淆。
embeddings:
  e_l0_id: 459
  e_l1_id: 459
  e_l2_id: null
  model: BAAI/bge-m3
  embedded_at: 2026-05-17T07:33:54.997Z
wikilinks: []
current_path: /cluster_2
derived_state:
  cluster_id: 2
  cluster_membership_strength: 0.6799728778050801
  is_cluster_hub: false
  hub_of_cluster: null
lifecycle:
  status: active
  reference_count: 0
  last_accessed_at: null
  superseded_by: null
  superseded_reason: null
hub_role:
  value: leaf
  source: auto_detected
  reason: 该节点提供具体实验对比和发现，但未定义新的子话题，已有center节点覆盖cold restart、数据分割等方向，本文属于细化分析。
  history:
    - changed_at: 2026-05-17T07:34:10.774Z
      from: neutral
      to: leaf
      changed_by: agent:librarian
      op_id: 019e34db-5853-7ccb-8ca6-bdfcd7752167
      reason: 该节点提供具体实验对比和发现，但未定义新的子话题，已有center节点覆盖cold restart、数据分割等方向，本文属于细化分析。
---

# Eval Round Summary — 2026-04-30 → 2026-05-01

Cross-experiment leaderboard analysis. Source logs: `base0.md`, `i-503.md`, `i-601.md`, `i-602.md` in this directory.

## Numbers

| Run | Δ vs baseline-0 | Leaderboard AUC | Infer time | Best ckpt | ≈ epoch |
|---|---|---|---|---|---|
| baseline-0 (ref) | — | **0.81147** | 323.61s | step 21744 | 6 |
| I-503 (cold restart OFF) | -0.01376 | 0.79771 | 399.63s | step 3624 | 1 |
| I-601 (timestamp_split ON) | -0.01220 | 0.79927 | 320.82s | step 29288 | ≈ 8 |
| I-602 (timestamp + id_dropout p=0.3 t=10K) | -0.00781 | 0.80366 | 211.64s | step 21966 | ≈ 6 |

(epoch ≈ step / 3661 — derived from I-601 epoch-1 logging.)

## Read

### 1. Cold restart confirmed load-bearing (I-503)
-0.01376 vs baseline-0 matches the predicted -0.014 within rounding. Memory rule
`feedback_cold_restart_load_bearing.md` stands. Never disable.

### 2. timestamp_split was a regression, not a no-op (I-601 — UNEXPECTED)
Predicted ≈ 0, got -0.0122.

Two non-mutually-exclusive explanations:
- **Best-epoch drift**: timestamp val picked epoch ≈ 8 (step 29288); baseline-0 picked
  epoch 6 (step 21744). Cold restart fires every epoch end, so later epochs sit on a
  less-trained sparse-embedding state. Worse on leaderboard even if val_auc is higher.
- **Premise crack**: `pcvr_diag_data_split` showed all 1000 parquets cover the same
  ~4.6-day window. We assumed last-10%-by-timestamp ≈ last-10%-by-file (both
  uniform within-window). If within-window time gradient is non-trivial, the new val
  is itself a thin time slice and overfit-prone.

The 0.046 train→leaderboard gap is structural (high-card ID non-recurrence + 313%
conversion-rate drift across 4.6 days), not just split-induced. The val
infrastructure fix did not recover any of that gap.

### 3. id_dropout works — but only when comparator is right (I-602)

| Comparator | Δ leaderboard | Reading |
|---|---|---|
| vs baseline-0 | -0.00781 | Bad in isolation |
| vs I-601 (same timestamp split) | **+0.00439** | True isolated effect — positive |

Because I-602 inherited timestamp_split from I-601, the apples-to-apples comparator
is I-601, not baseline-0. id_dropout p=0.3 t=10K netted **+0.0044 leaderboard on
top of the timestamp-split base**.

Codex's challenge during planning was correct: with cold restart already wiping
high-cardinality Embeddings every epoch, id_dropout's primary effect is regularizing
**dense-parameter co-adaptation to the ID channel**, not sparse Embedding
memorization. The +0.0044 is consistent with that mechanism.

Result is slightly above conservative prediction (+0.001~+0.003 in eval template),
well below original prediction (+0.005~+0.015 in Job Description).

### 4. Inference time variance is not informative
| Run | Infer time |
|---|---|
| baseline-0 | 323.61s |
| I-503 | 399.63s |
| I-601 | 320.82s |
| I-602 | **211.64s** |

I-602 inference path is byte-identical to baseline-0 (id_dropout is training-only,
no model architecture change, same 310k test rows, same `infer.py`). The 110s
delta vs baseline is platform contention, not a real signal. Don't bank on it.

## Open questions for next session

1. **Is timestamp_split's loss real or a one-seed fluke?** No multi-seed ablation
   yet. Could be -0.012 or could be ±0.005 stochastic noise that just landed bad.
2. **Should I-603 keep timestamp split or revert?** If we stay on timestamp split,
   future deltas are interpretable vs I-601 but stuck at a -0.012 disadvantage to
   baseline-0. If we revert, deltas are vs baseline-0 directly but we lose the
   "fixed val" infrastructure (which we now know didn't actually help anyway).
3. **id_dropout sweep (p∈{0.1, 0.5})**: justified by positive effect, but blocked
   on (1)/(2) — pointless to sweep on a confounded base.

## Decision sketch

Recommend next experiment: **I-603 = id_dropout p=0.3 t=10K WITHOUT timestamp_split**
(i.e. on baseline-0 base, not on I-601 base). This isolates id_dropout vs the
established baseline-0 reference and answers "is the +0.0044 reproducible when
timestamp split is removed?" If yes, we shed timestamp_split with no loss; if no,
timestamp_split was load-bearing for id_dropout's effect (interesting but
unexpected).

Cost: ~10–14 hours train + 1 eval slot. Lower priority than fixing the
timestamp-split confound.





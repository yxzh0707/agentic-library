---
uuid: 019e34cc-f17a-7ccb-8ca1-8fbac11bf6bb
node_type: raw
created_at: 2026-05-17T07:18:26.938Z
updated_at: 2026-05-17T07:20:51.366Z
created_by: human:default
created_by_run: import:markdown:meta.md
l0_summary: I-647：实时用户序列聚合特征（16维），无OOV，预期AUC+0.002
l1_overview: 实验I-647在PCVRHyFormer的user_dense通道新增16维用户历史序列实时聚合特征（4域×4统计：总事件数、近1d/7d事件数、时间跨度），以显式提供用户活跃度信号，弥补attention隐式学习因冷启动重置的不足。特征完全基于batch内PIT时间戳计算，无OOV风险，与I-625 gap特征数据流向一致。预期AUC从0.8229提升至0.825，属于small-features-stacking策略，后续可扩展更多统计。当前状态ready_for_taiji，需评估后决定promote/neutral/kill。
embeddings:
  e_l0_id: null
  e_l1_id: null
  e_l2_id: null
  model: null
  embedded_at: null
wikilinks: []
current_path: null
derived_state:
  cluster_id: null
  cluster_membership_strength: null
  is_cluster_hub: false
  hub_of_cluster: null
lifecycle:
  status: active
  reference_count: 0
  last_accessed_at: null
  superseded_by: null
  superseded_reason: null
---

# I-647_user_seq_agg

```yaml
id: I-647
name: user_seq_agg
status: ready_for_taiji
base: experiments/I-625_gap_features/code/  (forked, dataset.py + train.py +
                                              infer.py + run.sh modified)
fork_base: "experiments/I-625_gap_features/code/"
prior:
  expected_lb_auc: 0.825
  range: [0.821, 0.829]
  p_improve_over_baseline: 0.40
  baseline_lb_auc: 0.822863  # I-625

amp_compile_caveat: "Inherited from I-625 (amp+compile always on)."

rationale:
  - 17 个实验里我们从未抽出过"用户级聚合统计"作为独立特征. PCVRHyFormer
    的 attention 理论上能 implicitly 学到这些, 但 cold restart 每轮重置
    sparse Embedding 削弱了这种隐式学习. 显式 dense 通道更稳.
  - 元规则双过 (data_understanding_v2): (a) NEW signal: per (user, domain)
    aggregations 从未单独输入过模型; (b) OOV-safe: 全部是 user-internal
    统计, 与 item_id / user_id 身份无关.
  - TOP1 0.83 vs 我们 0.823 = 0.007 gap, 多个 +0.001~0.002 的小特征堆
    叠才补得上. 用户活跃度画像是经典 +0.001 量级特征.

oov_safety_proof:
  - 警觉问题: user_id 在 train/test 也几乎无交集, I-647 是否会重蹈 I-635
    覆辙 (item_id OOV -> 特征坍缩)?
  - 答案: NO. 数据流向完全相反.
    * I-635 流向: train 数据 -> 预先按 item_id 分组聚合 -> events_artifact
      .npz 字典 -> infer 时按 test row 的 item_id 查字典 -> OOV 查不到.
    * I-647 流向: 当前 batch 的 seq 字段 (每条样本自带的历史时间戳列)
      -> 实时聚合 -> 不查任何字典. user_id 完全不出现在 _compute_user_seq_agg
      代码路径里.
  - 类比: I-635 像 "用 train 时记下的电话簿查号码" (新 user 查不到),
    I-647 像 "看用户出示的身份证" (每个用户都自带身份证).
  - 既有 PROMOTE 实验 I-625 (gap features, +0.011) 同样从 batch 的
    seq_ts 列实时算 Fourier 特征, 数据流向与 I-647 一致 -- I-625
    没有 OOV 问题, I-647 也不会有.

design:
  features (4 stats × 4 domains = 16 dims, append to user_dense_feats):
    - log1p(seq_len) — 该 domain 总事件数
    - log1p(events_in_last_1d) — 最近 24h 事件数 (PIT: ts < cur_ts)
    - log1p(events_in_last_7d) — 最近 7d 事件数 (PIT)
    - log1p(time_span_seconds) — max_ts - min_ts in valid range
  PIT discipline: events with ts >= cur_ts are excluded (no leakage from
    the row's own event back into its features).
  fallback: events with ts==0 (padding) are excluded. Domains with
    list-array column missing or empty contribute zero block.

changes (vs I-625):
  - dataset.py:
      * USER_SEQ_AGG_STATS_PER_DOMAIN = 4 module constant.
      * _USER_SEQ_AGG_FID_MARKER = 647 (virtual fid for the appended block).
      * PCVRParquetDataset.__init__ accepts use_user_seq_agg kwarg.
      * After _load_schema, when enabled, register virtual fid in
        user_dense_schema -> user_dense_dim grows by 4*n_domains
        (=16 for 4 domains). Buffer auto-resizes (line 233 reads schema).
      * New method _compute_user_seq_agg(batch, current_ts, B): reads each
        domain's ts_ci column (Arrow ListArray offsets+values), computes
        the 4 stats per (user, domain), returns (B, 16) float32.
      * _convert_batch: after the existing user_dense plan fill, writes
        the agg block into user_dense[:, -agg_dim:] tail slots.
      * create_dataset factory plumbs the kwarg to both train/valid
        datasets.
  - train.py: --use_user_seq_agg flag (default False). Plumbed to
    create_dataset and recorded in train_config (vars(args) includes it).
  - infer.py: reads use_user_seq_agg from train_config (default False);
    test dataset constructed with same flag so user_dense_dim matches
    the trained model.
  - run.sh: passes --use_user_seq_agg.
  - model.py / trainer.py / utils.py / ns_groups.json / etc.:
    byte-identical to I-625. The model's existing user_dense_proj
    Linear(user_dense_dim, d_model) auto-widens to consume the extra
    16 input dims.

new_dense_params: ~1024  # d_model=64 × 16 extra Linear weight + bias
architecture_constraint: none (no new tokens; num_ns unchanged)

decision_thresholds:
  promote_if: "leaderboard_auc >= 0.825"
  neutral: "0.822 <= leaderboard_auc < 0.825"
  kill_if: "leaderboard_auc < 0.822"

next_actions:
  promote:
    - User-side aggregation 通道打开. v2 候选:
      * +4 dims/domain: low-cardinality sideinfo unique counts (action_type
        diversity per user per domain).
      * +1 dim/domain: events_in_last_1h (very recent burst).
    - Stack with I-625 base + I-617 dow + I-643/I-646 winners.
  neutral:
    - 检查每 dim 的 weight magnitude (w/ wandb or printed). 如果 weights
      接近 0, 说明信息冗余 (attention 已 implicit 学到), 删掉冗余 dims.
  kill:
    - User-side dense path 在 PCVRHyFormer 上没有 explicit 通道带宽 (单
      token Linear(D, 64) 太窄). 升级 user_dense_proj 到 MLP, 或迁去
      sequence-side 加 dense channel.
```

## Cross-references
- `docs/data_understanding_v2.md` — 元规则 (a)+(b) 双过.
- `知识库拓展/2025-2026_findings.md` — TOP1 0.83 small-features-stacking
  framing supports this experiment direction.

## Outcome
(待 eval 后填写)


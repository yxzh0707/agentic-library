---
uuid: 019e34cc-f18c-7ccb-8ca2-01efb244cdba
node_type: raw
created_at: 2026-05-17T07:18:26.956Z
updated_at: 2026-05-17T08:00:15.606Z
created_by: human:default
created_by_run: import:markdown:meta.md
l0_summary: 记录低秩双线性交叉融合类别热编码与时间特征的模型实验。
l1_overview: 笔记描述一个新模型模块(CateTimeCross)，通过低秩双线性(秩-8 Hadamard积)显式交叉两个已证明有效的稠密特征：类别热编码(OOF)和时间gap特征(Fourier)。该交叉不引入新稀疏嵌入，参数仅2601，满足匿名化、非集成、低延迟等约束。笔记设定提升决策阈值(LB AUC≥0.826推荐晋级)，并规划超参数扫描与扩展动作。
embeddings:
  e_l0_id: 501
  e_l1_id: 501
  e_l2_id: null
  model: BAAI/bge-m3
  embedded_at: 2026-05-17T08:00:05.701Z
wikilinks: []
current_path: /cluster_1
derived_state:
  cluster_id: 1
  cluster_membership_strength: 0.7486349487545376
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
  reason: 该节点是对已有子话题（特征交叉）的具体实验实现，不定义新子方向。
  history:
    - changed_at: 2026-05-17T08:00:15.606Z
      from: neutral
      to: leaf
      changed_by: agent:librarian
      op_id: 019e34f3-38f1-7cc9-94de-e98b39856617
      reason: 该节点是对已有子话题（特征交叉）的具体实验实现，不定义新子方向。
---

# I-671_cate_x_time_cross

```yaml
id: I-671
name: cate_x_time_cross
status: ready_for_taiji
base: experiments/I-643_cate_oof_heat/code/  (forked)
fork_base: "experiments/I-643_cate_oof_heat/code/"
prior:
  expected_lb_auc: 0.826
  range: [0.821, 0.830]
  p_improve_over_baseline: 0.45
  baseline_lb_auc: 0.824608  # I-643

rationale:
  - 项目两条已 PROMOTED 的 dense-feature 轴的二阶交叉：
    * I-643 cate-OOF heat (item_int_feats_84) — LB +0.00175, OOV-safe (cate train/test shared)
    * I-625 gap features (8-dim Fourier of abs(ts[i]-ts[i-1])) — LB +0.011, project's biggest single PROMOTE
  - 命中 active_state:146 "only feature-axis (new information) and regularization-axis (less train-overfit) can transfer" 的特征轴 + 已知 transfer-friendly 信号
  - 显式 cross (bilinear low-rank Hadamard)，不引入新 sparse embedding 或 id-dep lookup
  - 与 closed gating axis 区别：不是把 time feature 当乘性 scaling 加在 token 上 (I-639 KILL), 而是把 cate-heat 和 time-context 作为两个独立 dense 信号做秩-8 bilinear cross

changes (vs I-643):
  - model.py:
    * Add CateTimeCross module: cate_proj (15→8) + time_proj (8→8) + Hadamard product + out_proj (8→32)
    * Add cross_to_model: Linear(32, d_model=64)
    * Add gamma_cross: nn.Parameter(0.0) — zero-init residual gate
    * Add _extract_time_context: pull 8-dim gap-Fourier slice from last valid timestep of domain_a's seq_time_feats
    * In forward + predict: output = output + gamma_cross * cross_to_model(cate_time_cross(cate_heat, time_context))
  - dataset.py / run.sh / train.py / item_heat.py / utils.py / trainer.py / infer.py / ns_groups.json / test_seq_time_features.py: VERBATIM copy from I-643
  - New params: 2601 (< 5000 cap)
    * CateTimeCross: 488 (15·8+8) + (8·8+8) + (8·32+32) = 128 + 72 + 288 = 488
    * cross_to_model: 32·64 + 64 = 2112
    * gamma_cross: 1

decision_thresholds:
  promote_if: "leaderboard_auc >= 0.826"
  neutral: "0.824 <= leaderboard_auc < 0.826"
  kill_if: "leaderboard_auc < 0.824"

next_actions:
  promote:
    - Sweep rank ∈ {4, 8, 16}
    - Try mean-of-last-K time context instead of last-step
    - Add second cross layer (rank-8 → rank-8 chain)
  neutral:
    - Larger d_cross (32 → 64)
    - Try outer-product variant (full 15×8=120 dim) at the cost of params
  kill:
    - cate × time interaction may be redundant with what HyFormer attention captures implicitly
    - Combine with another PROMOTED axis (e.g., I-617 dow onehot) as triplet cross

constraints_compliance:
  A1_anonymized_only: yes (cate_heat is precomputed dense, time_context is timestamp-derived)
  A2_no_ensemble: yes (single-model forward)
  A3_latency: yes (low-rank bilinear is O(B·r) FLOPs, negligible)
  A4_auc_metric: yes (BCE loss unchanged)
  F2_no_id_dep: yes (cross does NOT touch user_id or item_id learned embeddings)
  F3_bce_unchanged: yes
```





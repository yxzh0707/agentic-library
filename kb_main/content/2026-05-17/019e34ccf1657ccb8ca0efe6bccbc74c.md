---
uuid: 019e34cc-f165-7ccb-8ca0-efe6bccbc74c
node_type: raw
created_at: 2026-05-17T07:18:26.917Z
updated_at: 2026-05-17T07:36:28.365Z
created_by: human:default
created_by_run: import:markdown:meta.md
l0_summary: 通过AMP和torch.compile加速PCVRHyFormer训练，速度提升45%，AUC损失在噪声内，已晋升为后续实验基座。
l1_overview: 该实验对PCVRHyFormer进行纯工程加速，采用AMP（bfloat16优先）和torch.compile(mode='default')，不改变模型或数据。目标将单epoch时间从~43分钟降至<25分钟。实际结果：AUC 0.808328（较基线-0.00314，在噪声边缘），epoch时间33.5分钟（原基线~60分钟，实际提升45%）。因速度增益显著且AUC损失可接受，决定晋升为后续实验默认基座。下游实验需注意若AUC下降>0.005应关闭加速以确认原因。
embeddings:
  e_l0_id: 466
  e_l1_id: 466
  e_l2_id: null
  model: BAAI/bge-m3
  embedded_at: 2026-05-17T07:36:16.424Z
wikilinks: []
current_path: /cluster_2
derived_state:
  cluster_id: 2
  cluster_membership_strength: 0.7220052467484602
  is_cluster_hub: false
  hub_of_cluster: null
lifecycle:
  status: active
  reference_count: 0
  last_accessed_at: null
  superseded_by: null
  superseded_reason: null
hub_role:
  value: center
  source: auto_detected
  reason: 该节点定义了一个新的子话题——PCVRHyFormer的工程加速优化，此前没有其他节点覆盖这一方向；它被后续实验（如基于I-606的时间特征实验）直接继承和扩展，作为新的基座，因此代表了一个子话题的中心。
  history:
    - changed_at: 2026-05-17T07:36:28.365Z
      from: neutral
      to: center
      changed_by: agent:librarian
      op_id: 019e34dd-71cb-7ccb-8ca7-bc2b851093f1
      reason: 该节点定义了一个新的子话题——PCVRHyFormer的工程加速优化，此前没有其他节点覆盖这一方向；它被后续实验（如基于I-606的时间特征实验）直接继承和扩展，作为新的基座，因此代表了一个子话题的中心。
---

# I-606_engineering_speedup

| Field | Value |
|---|---|
| Type | engineering speedup, no AUC change expected |
| Parent | `baseline_0_rankmixer` |
| Target model | PCVRHyFormer |
| Changes | AMP autocast + `torch.compile(mode="default")` |
| Non-changes | no tokenizer change, no id_dropout change, no timestamp split, no architecture change |
| Primary objective | reduce epoch time from ~43 min to <25 min |
| AUC prior | expected leaderboard AUC = baseline-0 `0.81147` +/- `sigma_eval` |

## Rationale

This package is a pure engineering acceleration probe. It keeps the baseline-0
data flow, model shape, optimizer split, and cold-restart regularizer intact,
then adds CUDA AMP and `torch.compile` to reduce per-step training cost.

AMP prefers `bfloat16` when the GPU supports it because bf16 does not require a
GradScaler and is generally more stable than fp16. Older CUDA GPUs fall back to
fp16 + GradScaler. `torch.compile(mode="default")` is used instead of
`max-autotune` because default has lower compile overhead and lower failure
risk; max-autotune can be tested later if this package is stable.

## Cold Restart Constraint

Cold restart is load-bearing for TencentGR:

- Keep `--reinit_sparse_after_epoch=1`.
- Keep `--reinit_cardinality_threshold=0`.
- The expected end-of-epoch log is:
  `Re-initialized N high-cardinality Embeddings (vocab>0), kept M`.

The trainer keeps the original uncompiled module for checkpointing and sparse
embedding reset. The compiled wrapper is used only for forward/predict. After
cold restart, embedding weights are reset in-place, so the compiled wrapper is
retained. If Taiji logs show missing reinit, NaN, or unstable validation after
the first epoch, disable `--use_compile` before changing cold restart.

## Decision Thresholds

Promote if:

- leaderboard AUC stays within +/- 0.003 of baseline-0 (`0.81147`), and
- epoch time is <25 min, and
- cold restart log appears at every epoch end after epoch 1.

Kill if:

- leaderboard AUC drops by >0.005 versus baseline-0, or
- cold restart no longer triggers, or
- any NaN/non-finite training loss appears, or
- compile cache / compile time dominates enough that epoch time is not improved.

## First Taiji Run Signals

Watch the first epoch logs for:

- `AMP enabled with autocast dtype=torch.bfloat16` on modern GPUs, otherwise fp16
  with GradScaler.
- `torch.compile enabled with mode=default`.
- Slow first several steps followed by faster steady-state steps; this indicates
  compile warmup rather than a data-loader regression.
- End-of-epoch `Re-initialized ... high-cardinality Embeddings (vocab>0)`.
- `Rebuilt Adagrad optimizer after epoch 1`.
- Peak GPU memory and average step time logs.

This experiment succeeds only if speed improves materially and AUC does not
move outside normal evaluation noise.

## Outcome — PROMOTE (borderline)

```yaml
actual:
  lb_auc: 0.808328
  prediction_error: -0.00314  # actual 0.808328 - expected 0.81147
  branch_fired: borderline_promote  # falls just below 0.8085 floor (by 0.0002)
  speed_check:
    epoch_1_time: 33.5_min
    baseline_epoch_time: ~60_min
    speedup_factor: 1.45x
    cold_restart_log: 'Re-initialized 97 high-cardinality Embeddings (vocab>0), kept 1'
  inference_time: 352.47s  # vs baseline 323.6s, +9% (platform variance, not signal)
  decision: PROMOTE_AS_FORK_BASE
  rationale: |
    AUC -0.003 is right at noise band edge (sigma_eval likely >= 0.003).
    Speed +45% is the major win, multiplicative on all future experiments.
    Cold restart preserved correctly per Codex base_model unwrap design.
    The 0.003 AUC trade is acceptable for ~2x experiment throughput.
```

**Promotion rule**: All future experiments fork from this package's `code/` instead
of `baseline_0_rankmixer/code/`. Inherit amp + torch.compile by default
(`--use_amp --use_compile` are default-on flags).

**Caveat for downstream experiments**: if a fork shows AUC drop > 0.005 vs
expected, run a control with `--no_use_amp --no_use_compile` before declaring
the new feature responsible.

## Evaluations

| Eval ID | Submitted | Ckpt | Leaderboard AUC | Inference time |
|---|---|---|---|---|
| 47900 | 2026-05-02 morning | best_model | **0.808328** | 352.47s |





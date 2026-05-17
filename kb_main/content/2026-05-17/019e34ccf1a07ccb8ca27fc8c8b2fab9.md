---
uuid: 019e34cc-f1a0-7ccb-8ca2-7fc8c8b2fab9
node_type: raw
created_at: 2026-05-17T07:18:26.976Z
updated_at: 2026-05-17T07:22:08.670Z
created_by: human:default
created_by_run: import:markdown:dreamwalk_candidates.md
l0_summary: "Dreamwalk #1-#13累计39个候选实验，按优先级和预期+EV分类，列出立即执行候选及已关闭实验。"
l1_overview: "Dreamwalk #1-#13 session累计39个候选实验，基于预期+EV分类。Tier-1包括GLN、SwiGLU FFN、EMA/SWA等低风险高收益候选，等待触发条件。Tier-2包含FuXi-Linear、SPHINX、CIN等架构机制候选。Tier-3训练侧trick如SAM、DropPath。Tier-Original有辅助任务和伪标签。累计前5为GLN、SwiGLU、EMA/SWA、Lookahead、L2-SP。已KILL I-672、I-673、I-675，相关轴关闭。"
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

# Dreamwalk #1-#13 累计候选 (2026-05-15 session)

> 13 次 dreamwalk reconnaissance, 39 个新候选实验, 按预期 +EV 分类。
> 期间 base = I-670 SOTA (0.825484), 在飞 I-674 v4 + 已 KILL I-675 (0.816233)。

## 按 priority 分类

### 🥇 Tier-1 — 触发条件后立刻派 (低风险高 EV)

| 候选 | 来源 | 触发条件 | 预期 +EV | 实现量 | 在 dreamwalk # |
|---|---|---|---|---|---|
| **GLN (Group-Layer Normalization)** | KB TAAC2026_Solution | I-674 LB 后无论 outcome | +0.1-0.3% "near-zero cost" | ~20 行 | #13 |
| **SwiGLU/GeGLU FFN** | LLM 标准 | 任何 base 都可叠 | +0.1-0.3% | ~15 行 | #6 |
| **EMA / SWA weight smoothing** | Kaggle 标准 | 任一 PROMOTE | +0.0005-0.001 (valid→LB transfer) | ~30 行 | #5 |
| **Lookahead optimizer** | 多 Kaggle CTR 胜方 | 任一 PROMOTE | +0.001 | ~25 行 | #9 |
| **RMSNorm 替换 LayerNorm** | Llama 标准 | training cycle 长 → 提速 + 微 +EV | +0-0.001 | ~10 行 | #9 |

### 🥈 Tier-2 — 架构机制候选

| 候选 | 来源 | 触发条件 | 预期 +EV | 实现量 | 在 dreamwalk # |
|---|---|---|---|---|---|
| **FuXi-Linear attention** | dreamwalk WIDE #5 | I-675 KILL → 换 attention | +0.001-0.003 | ~240 行 | #1 |
| **SPHINX Sharpened Selective Routing** (τ=0.45) | SPHINX V7.6 #6 | I-674/I-675 PROMOTE → stack | +0.001-0.002 | ~80 行 | #1 |
| **SPHINX Strong Time Residual 4D** | SPHINX V7.6 #7 | I-675 KILL 后 (attention 不行就改 output head) | +0.0005-0.002 | ~50 行 | #2 |
| **2025 P0 FiLM** (Feature-wise Linear Mod) | 2025 champion | I-675 PROMOTE → stack | +0.001-0.002 | ~70 行 | #3 |
| **2025 P0 Gated Fusion** | 2025 champion | I-675 PROMOTE → stack | +0.001-0.002 | ~60 行 | #1 |
| **SPHINX TimeContextEncoder z_t** | SPHINX V7.6 #2 | I-674 KILL 后 | +0.0005-0.002 | ~80 行 | #3 |
| **SPHINX QueryGenerator with z_t inject** | SPHINX V7.6 #3 | I-674 PROMOTE → stack | +0.001-0.002 | ~70 行 | #7 |
| **xDeepFM CIN** (vector-wise cross) | KDD 2018 | I-674 PROMOTE → stack 跟 ML-DCN 互补 | +0.001-0.003 | ~120 行 | #11 |
| **MoS theme-aware MoE** | dreamwalk WIDE #7 | 双 NEUTRAL → 大跨度尝试 | +0.001-0.003 | ~220 行 | #2 |
| **HSTU (Meta 2024)** | dreamwalk WIDE #1 | 双 KILL → 换 attention backbone | +0.002-0.005 | ~300 行 | #5 |
| **OneTrans NS 独占参数** | KB | I-674 KILL → 大改造 | unknown | ~200 行 | #13 |
| **AutoInt** (multi-head self-attn 在 feature 维) | Microsoft 2019 | I-674 KILL → 换 NS tokenizer | +0.001 | ~150 行 | #8 |
| **Squeeze-Excitation on NS tokens** | CV SE-net | I-674 PROMOTE → 加 SE | +0.001-0.003 | ~40 行 | #9 |
| **Sliding-window attention (Mistral)** | Mistral / Longformer | I-675 KILL → 换 attention pattern | +0.001 | ~80 行 | #11 |
| **ALiBi 位置偏置** | 替代 RoPE | I-675 KILL → 探另一个 position encoding | +0.0005-0.002 | ~80 行 | #4 |

### 🥉 Tier-3 — 训练侧 trick

| 候选 | 来源 | 触发条件 | 预期 +EV | 实现量 | 在 dreamwalk # |
|---|---|---|---|---|---|
| **SAM (Sharpness-Aware Minimization)** | 2024 训练侧 | 任一 NEUTRAL → SAM 试 transfer | +0.001-0.002 | ~50 行 | #4 |
| **DropPath / Stochastic Depth** | 标准 transformer | 任一 PROMOTE → 加正则化 | +0.001 | ~30 行 | #4 |
| **mixup feature-level** | DeepCTR/CV | NEUTRAL → 加 mixup | +0.001-0.002 | ~40 行 | #7 |
| **FGSM Adversarial Training** | NLP/CTR | gap 大 → 加 adv train | +0.001-0.003 | ~60 行 | #7 |
| **CutMix on dense features** | mixup 升级 | I-674 PROMOTE → 加 CutMix | +0.001-0.002 | ~50 行 | #10 |
| **Knowledge Distillation I-670→I-674** | Kaggle CVR 胜方 | I-674 PROMOTE → 再 +EV | +0.001-0.003 | ~80 行 | #6 |
| **Self-distillation via EMA-teacher** | 2023+ paper | 任一 PROMOTE → 加 self-distill | +0.001 | ~50 行 | #11 |
| **Schedule-Free optimizer (Facebook 2024)** | 2024 新 paper | training cycle 短 | +0-0.001 | ~30 行 | #8 |
| **MUP (μP parameterization)** | 标准 init | I-674 KILL → 重新 init | +0-0.001 | ~40 行 | #5 |
| **L2-SP regularization** (anchor I-670) | Transfer learning | I-675 LB KILL → 强制接近 SOTA | +0.001 | ~30 行 | #10 |
| **TTA (Test-Time Augmentation)** | 推理侧 | 单 PROMOTE + deadline | +0.0005-0.001 | ~40 行 | #6 |
| **Label smoothing** (BCE ε=0.05-0.1) | 标准正则 | 任何 base | +0-0.001 | ~5 行 | #12 |
| **Cosine warm restart SGDR** | 学习率 trick | I-674 NEUTRAL 但 valid 还在升 | +0-0.001 | ~20 行 | #12 |

### 🎯 Tier-Original — 项目独家机会

| 候选 | 独家 reason | 触发条件 | 预期 +EV | 实现量 | 在 dreamwalk # |
|---|---|---|---|---|---|
| **Auxiliary task: predict label_time bucket** | 我们 EDA 独家发现 label_time leak-safe (test 全 NULL) | 任一 PROMOTE → 派 multi-task 版 | unknown (独家)  | ~80 行 | #8 |
| **Pseudo-labeling on test (310k 样本)** | 利用 EDA 独家信息 (test 1.5h 单窗口) | I-674 PROMOTE + 有时间 | +0.002-0.005 | ~80 行 | #12 |

### Tier-4 — Backup / 待 deep-search 验证

| 候选 | 来源 | 备注 |
|---|---|---|
| **5/13 archive DIN-residual-blend** | `20260513-1757_inquiry_din_residual_blend` | 草案待回炉 |
| **IKEA Contrastive regularization** | dreamwalk WIDE #3 | Pattern B 风险 (但 IKEA 结构不同) |
| **Multi-resolution time bucket** | 当前 65 buckets 未 sweep | 1 次 hyperparam sweep |
| **MTGR Dynamic Masking** | KB Tier-3 | mask 是 zero, drop 是 skip |

## 累计 39 候选，按"立刻可派" 排序最高 5 名

1. **GLN** (KB, near-zero cost, 20 行) — 待 I-674 LB
2. **SwiGLU/GeGLU FFN** (LLM 标准, 15 行) — 任何 base
3. **EMA/SWA weight smoothing** (Kaggle 标准, 30 行) — 任一 PROMOTE
4. **Lookahead optimizer** (25 行) — 任一 PROMOTE
5. **L2-SP regularization** (anchor I-670, 30 行) — I-675 LB KILL 后做 transfer 修复

## 已 KILL (本 session) — 不要重派

- I-672 (cross + MLPlatt stack): KILL -0.0027 → **stacks 不可加性** axis closed
- I-673 (IF-DFM-Lite recency reweight): KILL -0.0040 → **day-bucket weighting** axis closed
- I-675 (AttnBias by action_type): KILL -0.0093 → **AttnBias 不转移** (可能 Pattern B 扩展)

## 已闭轴 (cross-session, 不再尝试)

详见 `closed_axes.md`。


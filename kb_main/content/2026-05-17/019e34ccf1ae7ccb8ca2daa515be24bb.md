---
uuid: 019e34cc-f1ae-7ccb-8ca2-daa515be24bb
node_type: raw
created_at: 2026-05-17T07:18:26.990Z
updated_at: 2026-05-17T07:22:34.610Z
created_by: human:default
created_by_run: import:markdown:closed_axes.md
l0_summary: 本笔记记录了推荐系统精排模型中已验证无效的多个技术方向及其根因，并列出了可探索的开放轴。
l1_overview: 笔记总结了多个闭轴方向：Loss重加权（train/test分布偏移非单调，reweight无效）、时序加权（测试集仅单窗口1.5小时，不转移）、ID特征（无交集无transfer）、Gating机制、模型容量饱和（d_model=64已饱和）、Stacks不可加性（叠加模块可能KILL）、AttnBias（属于Pattern B扩展）、Content-tower（数据匿名化无文本）。开放轴包括：架构机制（ML-DCN cross、FuXi-Linear等）、训练trick（SAM、EMA、mixup等）、层级正则（GLN、DropPath）、辅助监督（label_time bucket）、推理侧（TTA、伪标签）、多任务（ESMM/PLE不确定）。核心是避免重复失败，聚焦结构性改进和训练优化。
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

# Closed Axes — 不再尝试的方向

> 跨 session 持久参考。新 base 探新方向前先读此文件确认不重蹈覆辙。
> Last updated: 2026-05-15 18:50 BJT

## 一、Loss-axis 闭轴

### Pattern B: pure loss reweighting (5/5 KILL)

| 实验 | LB | Δ vs base | 备注 |
|---|---|---|---|
| I-630 focal_loss α=0.25 | 0.817099 | -0.00576 | first focal try |
| I-631 focal_alpha_aggressive | KILL | — | |
| I-673 IF-DFM-Lite recency | 0.821448 | -0.0040 | day-bucket weighting |
| (I-672 stack includes calib weighting effect) | 0.822739 | -0.0027 | |
| (I-675 AttnBias = attention reweighting) | 0.816233 | -0.0093 | possibly Pattern B extension |

**Root cause**: train/test distribution shift 是 non-monotonic, train 里加权的 "hard examples" 跟 test 里的 hard examples 不是同类 → reweight 反而损失 transfer。

**Don't try**: focal loss (any α/γ), recency-weighted training, hard-example mining, asymmetric BCE
**OK to try**: structural changes (architecture, features), training-only signals that don't directly reweight samples

## 二、Day-bucket / 时序加权闭轴

### 根因：测试集是 1.5h 单窗口（EDA hook 2026-05-15 抓到）

测试 parquet 310k 行真相：
- `label_type` 全部 -1 (NULL)
- `label_time` 全部 0 (missing)
- `timestamp` span 仅 0.065 天 = ~1.5 小时
- per-day count: `{'D0': 310000}` — 单一时段

**任何 "按 day bucket 加权样本" 策略都不转移** — test 不是 D9 延伸。

**Don't try**: day-index reweighting, recency cosine schedule per-day, train-late-day-heavy schemes
**OK to try**: timestamp 作为 feature (但不做加权), label_time 作为 training-only signal (leak-safe per EDA)

## 三、ID 特征闭轴

### Train/test uid 仅 1 条 instance + 无交集 → id 无 transfer 价值

| 实验 | LB | Δ | 备注 |
|---|---|---|---|
| I-503 cold_restart_off | 0.79771 | -0.014 | id rely 全失败 |
| I-608 item_id_hash 1M | 0.80803 | -0.003 | high-card sparse |
| I-635 multi_window_item_heat | 0.815836 | -0.0070 | item_id dependency |
| I-638 item_id_mask | 0.810642 | -0.0122 | most severe |

**Root cause (Ado 独立验证 + 我们)**: id features 在精排无 transfer 价值。

**Don't try**: user_id learnable embedding, item_id sparse embedding, id hashing for cross
**OK to use**: id 衍生 dense vector (如 user_dense_feats_61/87 ue embedding), category-level OOF heat

## 四、Gating 机制闭轴

| 实验 | LB | Δ | 备注 |
|---|---|---|---|
| I-624 target-aware gate | 0.81511 | -0.00219 | 用 target 信息门控 |
| I-639 time-feat context gating | 0.820408 | -0.0025 | 时间门控 |

**Don't try**: target-aware multiplicative gating, time-aware multiplicative gating
**OK to try**: additive bias (跟 gating 不同), entropy-regularized router

## 五、容量轴闭轴 (d_model)

### MC-MLCC family 在 d_model=64 已饱和

| 实验 | LB | Δ | 备注 |
|---|---|---|---|
| I-604 layer3 capacity | 0.80569 | -0.006 | 加层 KILL |
| I-665 MC-MLCC E'=8 | 0.81897 | -0.0067 | |
| I-666 MC-MLCC E'=16 | 0.82042 | -0.0053 | E'=16 比 E'=8 +0.0014 (Bilibili paper 反方向) |

**Don't try**: 增加 d_model (capacity 已饱和), MC-MLCC variants
**OK to try**: 架构机制层面的改造 (cross branch, attention 替换)

## 六、Stacks 不可加性闭轴

### 两 PROMOTE 模块叠起来可能 KILL

- I-672 = I-670 (ML-DCN cross +0.0005) + I-657 (MLPlatt calib +0.0004) → **LB -0.0027 KILL**
- 论坛 SPHINX V7.6: "单拿 1-2 机制涨千分位，全 7 stack 反而掉分"

**Don't try**: 一次性叠 2+ PROMOTE 模块期望线性 +EV
**OK to try**: 单独验证 → 验证后再做 stack 实测 (不能假设)

## 七、AttnBias 闭轴 (今日 2026-05-15 新增)

I-675 AttnBias by per-position action_type: **LB 0.816233, -0.0093 vs I-670 SOTA**
- Valid peak 0.8634 (差 SOTA peak 只 -0.0002)
- LB gap 巨大 (-0.0093)
- 数学上是 attention reweighting，可能属 Pattern B 扩展

**Don't try**: 任何 per-position attention reweighting by action_type / category 类离散信号
**OK to try**: attention 结构改造 (FuXi-Linear, Sliding-window, ALiBi position bias), 但要带 entropy regularization

## 八、Content-tower 死局

| 原因 | 证据 |
|---|---|
| Competition data 是 anonymized int/float | schema audit |
| 5 篇 text-based paper 全不适用 | dreamwalk WIDE/DEPTH 双确认 |

**Don't try**: text encoder / pre-trained LM embedding / semantic match

## 九、可探的开放轴 (positive list)

| 轴 | 状态 | 候选 |
|---|---|---|
| 架构机制 | OPEN | I-670 ML-DCN cross PROMOTE; FuXi-Linear, Sharpened Routing, Strong Time Residual 待尝试 |
| 训练侧 trick | OPEN | SAM, EMA/SWA, Lookahead, mixup, KD |
| Layer-level 正则 | OPEN | GLN (KB Tier-1 候选 🥇), DropPath, RMSNorm |
| Auxiliary supervision | OPEN | label_time bucket aux (独家 leak-safe), Next Action loss |
| Inference-side | OPEN | TTA, Pseudo-labeling test |
| ESMM/PLE 多任务 | UNCERTAIN | 需 CTR signal 才有意义 |


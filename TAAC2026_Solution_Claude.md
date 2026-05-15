# TAAC 2026 统一主干网络 CVR 预测方案

> 本方案由 Claude Code 基于知识库（cluster 15, 81 节点）综合生成
> 生成时间: 2026-05-15
> 知识库状态: cluster_review validated=confirmed

---

## 一、赛题核心理解

### 1.1 任务定义

**TAAC 2026 / KDD Cup 2026** 是腾讯广告转化率预估挑战赛。任务描述：

> 基于匿名化的腾讯广告日志数据，预测用户对广告的转化率（CVR）。参赛者需要设计**统一的深度学习模型**，同时处理：
> - **序列行为令牌**（用户多域行为序列）
> - **非序列多域特征**（用户/广告/上下文/交叉特征）
> 输出 pCVR。

### 1.2 硬约束

| 约束 | 规则 |
|------|------|
| 模型架构 | **单一同构 backbone + 可堆叠统一 block**，禁止集成 |
| 评测指标 | **AUC + 延迟**（双约束） |
| 延迟规则 | **推理超时直接作废，同分按延迟升序排名** |
| 论文奖一 | Unified Block Innovation Award |
| 论文奖二 | Scaling Law Innovation Award |

### 1.3 核心工程矛盾

工业推荐中，序列建模和特征交叉几十年是**双轨并行**的：
- 序列侧：DIN→DIEN→SIM→TWIN→SASRec→BERT4Rec→HSTU→TransAct
- 特征交叉侧：DNN/DeepFM/DCN等

**赛题要求打破这个双轨局限，用单一主干同时建模两类输入**。这是真问题，不是 leaderboard 玩具。

---

## 二、架构方案

### 2.1 参考架构对比

| 架构 | 论文 | 核心特点 | 适用性 |
|------|------|---------|--------|
| **HSTU** | Meta, ICML 2024 | Pointwise norm 替代 softmax，5-15x 快，Scaling law 验证 | baseline 核心 |
| **OneTrans** | 字节, WWW 2026 | NS token 独占参数，Cross-request KV Cache | 赛题官方推荐 |
| **HyFormer** | - | Query decoding 长序列压缩，双向信息流 | 实现复杂 |
| **MTGR** | - | HSTU + DLRM 显式交叉，GLN + Dynamic Masking | 工业落地优 |
| **Wukong** | Meta, ICML 2024 | FM 堆叠替代 Transformer，线性 Scaling | Scaling Law 奖 |
| **DeepContextNet** | 腾讯 baseline | 序列加法融合 + HSTU blocks | 官方起跑线 |

### 2.2 推荐主干：MTGR → OneTrans 路径

**主线架构选择**：MTGR 作为快速起跑 backbone，最终演进到 OneTrans。

**理由**：
1. MTGR 起步代价低，保留显式 cross feature
2. OneTrans 是赛题官方明确推荐的参考点
3. 两者可以渐进式演进，不需要完全重写

**Token 化设计**（融合 OneTrans + Sample Is Feature）：

```
序列侧（每域）：
  [EventToken = ItemID + ActionType + TemporalBucket]（加法融合）

非序列侧：
  Group-wise tokenization: 每 8-16 个 NS 字段编成一个 NS token
  Timestamp-aware interleave: 时间敏感的序列并入

Block 内部规则（S↑ 每域共享参数，NS↓ 独占参数）：
  - S-tokens: 共享参数
  - NS-tokens: 独占参数（OneTrans 风格）
```

**Block 内部结构**（基于 HSTU）：
1. Pointwise Projection（线性变换）
2. Spatial Aggregation（Pointwise norm 替代 softmax 处理高基数 token）
3. Pointwise Transformation（输出）

**关键配置**：
```
[CLS, User, Item, Sequence_Event_1, ..., Sequence_Event_N]
  ↓
N 个 HSTU Block（统一处理序列 + 非序列）
  ↓
投影头 → CVR
```

### 2.3 序列建模增强

基于 SIM/TWIN/TransAct 的演进，对序列侧做增强：

1. **Target-aware attention**：用候选 item 做 query，序列 token 做 key/value
2. **Action type embedding**：序列中的 ActionType 独立 embedding（不只是加到 ItemID 里）
3. **Cross-request KV Cache**：利用历史请求的 KV cache，近免费收益

---

## 三、工程优化

### 3.1 延迟优化（三类杠杆，按收益排序）

**延迟是淘汰线和排名打破规则，不是优化项，是必须先过的门槛。**

| 杠杆 | 技术 | 预期收益 |
|------|------|---------|
| **计算复杂度** | HSTU/TokenMixer 替代标准 self-attention | 5-15x 加速 |
| **请求结构** | Cross-request KV Cache | 近免费收益 |
| **内核与精度** | FlashAttention + 混合精度 | 额外 20-30% |

**延迟决策树**：
```
1. 先用 baseline 测出单样本延迟 L0
2. 计算延迟预算 = L0 × (1 - 安全margin)
3. 在预算内选择最大模型
4. 优化顺序：先算子再结构，不要留到最后
```

### 3.2 知识蒸馏（禁 ensemble 下的软合规路径）

**赛题禁 ensemble，但蒸馏不算 ensemble**——蒸馏产出单个学生模型。

**三档用法**：

**A. 大模型蒸小模型**（最推荐）：
```
训练阶段：OneTrans-Large 或 MTGR-Large（不要求延迟达标）
↓
蒸馏阶段：KL divergence + CVR BCE loss
↓
上线：单学生模型（延迟合规，AUC 接近大模型）
```

**B. 多教师聚合**：
```
同时训多个架构（HSTU/OneTrans/MTGR）
↓
蒸馏到单一学生（软标签聚合）
```

**C. 自蒸馏**：
```
模型自己当 teacher（epoch T）
↓
蒸馏到 epoch T-1（自己教自己，稳定性好）
```

### 3.3 多任务 CTR + CVR 联合训练

**问题**：样本选择偏差（只有被曝光的样本才有 label）
**方案**：ESMM/PLE 框架

```
CTR head + CVR head 共享 backbone
CTR 全量样本梯度 → backbone
CVR 样本梯度（pCTR 加权）→ backbone
```

**效果**：+0.3~1.0% AUC

### 3.4 Embedding 哈希压缩

**问题**：大词表（百万级）内存瓶颈

**方案**：
- Multi-hash embedding（多个 hash 函数映射到低维）
- Semantic ID（语义聚类后用聚类 ID 替代原始 ID）
- Embedding table 压缩 + int8 量化

---

## 四，创新方向与论文奖

### 4.1 Unified Block Innovation Award

**核心论点**：单一 Block 统一处理序列和特征交叉，是真正的架构创新。

**支撑材料**：
- OneTrans 的 NS 独占参数设计
- MTGR 的显式交叉 + HSTU 融合
- HiFormer 的异构 self-attention + 低秩近似

**建议 framing**：不是简单替换，而是在**统一 Block 内做参数分化**（S↑ 共享 / NS↓ 独占），这是组合创新。

### 4.2 Scaling Law Innovation Award

**赛题评审会拿你的曲线跟 Wukong/HSTU 的 scaling baseline 对照。**

**Scaling Law 图谱**（过去 24 个月）：

```
2024:
  - Wukong: FM堆叠 + Synergistic upscaling (W+D同时扩展) ← 奠基
  - HSTU: Pointwise norm + 万亿参数 ← 序列侧事实标准

2025:
  - RankMixer: TokenMixer替换self-attention, 硬件感知
  - TokenMixer-Large: 规模化验证

2026:
  - OneTrans: 官方推荐路径
  - MTGR: 工业落地
```

**参赛策略**：
1. 跑**三档模型**（小/中/大）
2. 画 **(compute, AUC)** 曲线
3. 对比 Wukong 和 HSTU 的 baseline 斜率
4. 验证 **5 个 Scaling 维度**：W（宽度）/ D（深度）/ T（温度）/ L（序列长）/ N（数量）
5. **创新点**：NS token 数和 Sample-level token 是新维度

---

## 五，三档实验路线图

### Tier 1 — 最小可行（1-2 周）

**目标**：跑通 baseline，建立提交流水线

| 步骤 | 操作 | 预期收益 |
|------|------|---------|
| 1 | 跑 DeepContextNet baseline | 记录 AUC + 延迟基线 |
| 2 | 加 Group-Layer Normalization | +0.1~0.3% AUC（几乎零代价）|
| 3 | 加多任务 head（CTR + CVR）| +0.3~1.0% AUC |
| 4 | 加 Next Action Loss 辅助 | +0.1~0.3% AUC |
| 5 | NS token 数从 2 扩到 8-16 | +0.2~0.5% AUC |

### Tier 2 — 优化 backbone（2-4 周）

**目标**：在延迟约束内最大化 AUC

| 步骤 | 操作 | 预期收益 |
|------|------|---------|
| 1 | MTGR backbone 替代 DeepContextNet | 验证 MTGR vs baseline |
| 2 | 知识蒸馏（大模型 → 小模型）| 延迟合规 + AUC 接近大模型 |
| 3 | RoPE 位置编码替代 Rotary | +0.1~0.2% AUC |
| 4 | KV Cache 工程实现 | 延迟降低 20-30% |
| 5 | Embedding 哈希压缩 | 内存降低 + 允许更大模型 |

### Tier 3 — 创新冲刺（持续投入）

**目标**：冲击论文奖

**Unified Block 方向**：
- NS token 独占参数的极端化（100% 独占 vs 共享）
- Block 内 S/NS 参数比例搜索

**Scaling Law 方向**：
- 多档模型 + 曲线绘制
- (W, D, T, L, N) 五维实验设计
- NS token 数作为新 scaling 维度的理论验证

---

## 六，不确定项与验证计划

| 不确定项 | 验证方法 |
|---------|---------|
| 序列长度在工业数据上的量级 | 先跑 baseline 测 50/90/99 分位延迟 |
| NS token group 大小的最优配置 | Tier 1 的 Step 5 对比实验 |
| 蒸馏温度的选择 | Grid search T ∈ {0.5, 1.0, 2.0} |
| OneTrans vs MTGR 哪个更优 | Tier 2 的 Step 1 对比 |

---

## 七，结论

**核心方案**：以 MTGR 为起跑 backbone，渐进演进到 OneTrans。采用 HSTU Block（Pointwise norm）+ Group-wise NS Tokenization + Cross-request KV Cache 的统一架构。训练阶段用知识蒸馏和多任务 CTR+CVR 联合训练最大化 AUC，推理阶段通过 KV Cache 和 Group-Layer Normalization 控制延迟在淘汰线以下。

**差异化**：不是凭空设计新架构，而是沿着 **Wukong( Scaling) → HSTU(工业) → OneTrans(官方) → MTGR(工程落地)** 的技术演进线做组合创新，同时用 Scaling Law 实验支撑论文奖。

---

## 知识库来源

本方案综合自知识库 cluster 15（81 节点，cluster_review validated=confirmed）：

| 节点类型 | 关键节点 | 内容 |
|---------|---------|------|
| 赛题核心 | 6ab21467, 8d7ad6b3 | 赛题 framing 与规则 |
| 官方 baseline | 2d6c46a6 | DeepContextNet 拆解 |
| 架构参考 | 1feccbed | OneTrans 统一 Transformer |
| 基线核心 | a1222571 | HSTU 架构与 scaling |
| 工业优化 | a2123487 | MTGR 融合方案 |
| 长序列 | d84bad16 | SIM/TWIN/TransAct 演进 |
| 延迟工程 | 1b107b65 | 三类延迟杠杆与决策树 |
| 工程三件套 | a9f80253 | 蒸馏/多任务/哈希压缩 |
| Scaling Law | 0e4b250c | Wukong 与 scaling 图谱 |
| 架构对比 | b4260168 | HiFormer/InterFormer |
| 综合作战 | 25c98cc2, 6c886021 | 两份完整作战计划 |

---

*本方案由 Claude Code 调用知识库 API，综合 81 个节点内容自动生成*
*KB cluster 15 hub: 019e2617-7f81-7666-bff2-4b48424c498d*
*生成时间: 2026-05-15*
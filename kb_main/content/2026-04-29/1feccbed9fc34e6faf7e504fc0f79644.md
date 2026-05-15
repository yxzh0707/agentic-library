---
uuid: 1feccbed-9fc3-4e6f-af7e-504fc0f79644
node_type: raw
created_at: 2026-04-29T08:13:36.410Z
updated_at: 2026-05-11T07:31:44.531Z
created_by: human:default
created_by_run: import:02_onetrans.md
l0_summary: OneTrans是字节提出的一种统一Transformer架构，用于同时处理序列建模和特征交互，是KDD Cup 2026赛题的参考点。
l1_overview: 笔记介绍OneTrans架构，核心是用一个Transformer统一序列与非序列特征处理。主要设计包括：NS字段的Group-wise或Auto-Split token化；多域序列的Timestamp-aware或Timestamp-agnostic并入；以及S-tokens共享参数、NS-tokens独占参数的block内部规则。推理侧采用Cross-request KV Caching，分两阶段计算以降低延迟和内存。训练细节如优化器和batch大小可作起点。实验显示离线AUC提升，在线GMV提升且延迟降低。启示是统一block的最小落地、服务侧拆分以控延迟，以及causal attention的工程价值。
embeddings:
  e_l0_id: 22
  e_l1_id: 22
  e_l2_id: null
  model: BAAI/bge-m3
  embedded_at: 2026-04-29T08:14:14.192Z
wikilinks: []
current_path: /cluster_1
derived_state:
  cluster_id: 1
  cluster_membership_strength: 0.6814549139211905
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
  source: librarian
  reason: 'cold_start sub-theme anchor: "统一架构设计" (working set: "TAAC 2026 推荐赛题")'
  history:
    - changed_at: 2026-04-29T08:14:30.986Z
      from: neutral
      to: leaf
      changed_by: agent:librarian
      op_id: ed114931-c5af-4d24-9e4c-2a043d4c7748
      reason: 新节点高度具体，聚焦OneTrans架构的细节设计（如token化、参数共享、KV缓存），无跨引用或总结性语言，信号强指向leaf
    - changed_at: 2026-05-11T07:31:44.531Z
      from: leaf
      to: center
      changed_by: agent:librarian:cold_start
      op_id: 019e15f2-f50b-7110-8527-40056ed84368
      reason: 'cold_start sub-theme anchor: "统一架构设计" (working set: "TAAC 2026 推荐赛题")'
---

# OneTrans — 当前最贴赛题主旨的统一架构（字节，WWW 2026）

> arxiv 2510.26104 | 赛题组织方在 KDD Cup 2026 推荐阅读列表中明确点名

## 这篇为什么是赛题的事实参考点
它正面回答了赛题的核心问题：用一个 Transformer 同时做 sequence modeling + feature interaction，不再分两路。所有后续设计取舍都可以参照它。

## 三个可以直接复用的设计选择

### 1. 非序列字段如何 token 化（NS tokenizer，赛题里就是 70 列 user/item int_feats + dense_feats）
两种方案：
- **Group-wise**：人工把字段按语义分组，每组一个 token
- **Auto-Split**：所有字段拼接 → 单个 MLP 投影 → 切分成 N 个 token

赛题映射：HuggingFace parquet 的列名前缀（user_int / user_dense / item_int）天然给出语义分组，Group-wise 几乎免费；Auto-Split 是 fallback。

### 2. 多域序列如何并入同一序列（赛题里就是 Domain A/B/C/D 四域，45 列）
两种方案：
- **Timestamp-aware**：所有 event 按时间 interleave，附 sequence-type 指示符
- **Timestamp-agnostic**：按事件影响力直接拼接

赛题映射：每条 sample 的 (item_id, action_type, timestamp) 都全 → Timestamp-aware 是首选；4 个 domain 加 4 维 type embedding。

### 3. block 内部参数共享规则（这是 OneTrans 跟普通 Transformer 不同的核心）
- S-tokens（序列侧）共享一组参数 W^S
- NS-tokens（非序列侧）每个 token 一套独占参数 W_{NS,i}

公式（论文式 12）：W_i = W^S 当 i ≤ L^S，否则 W_{NS,i}

直觉：序列里的 event 是同分布的（共享投影合理），非序列字段每个语义角色不同（独占参数避免被平均掉）。这是赛题里"统一 block"的关键 trick——不是把所有 token 同等对待，而是按 token 类型分配参数预算。

Attention 形式：standard MHA + causal mask（消融发现 full attention 几乎无收益 +0.01%，所以保 causal 的代价是 0、收益是兼容下面的 KV cache）。

## 推理延迟侧的关键设计：Cross-request KV Caching
两阶段切分：
- Stage I（per request）：把所有 S-tokens 算一遍，缓存 KV
- Stage II（per candidate ad）：每个候选广告只算它自己的 NS-tokens，对缓存的 S-side KV 做 cross-attention

收益：runtime/latency -30%，memory -50%

这点在赛题里**直接决定能不能在延迟预算内打高 AUC**——因为 TAAC 的样本是 (用户, 上下文, 目标广告) 三元组，每个用户在一次请求里要打分多个候选广告，序列侧重复计算是浪费。

## 训练侧细节（可作为我们超参的起点）
- sparse embedding: Adagrad β1=0.1, β2=1.0
- dense: RMSPropV2 lr=0.005, momentum=0.99999
- per-GPU batch 2048
- 梯度裁剪：dense 90 / sparse 120

## 实验数字（用来校准我们模型的相对位置）
- 离线 vs DCNv2+DIN：+1.53% CTR AUC, +1.14% CVR AUC
- 在线 A/B（Feeds）：+5.68% gmv/u, **-3.91% latency**（注意：是降低！）

负 latency 这点说明统一架构不一定更慢，因为省掉了双轨之间的特征传递。

## 我对赛题的 framing 启示
1. token 化层（NS group-wise + 序列 timestamp-aware）+ 共享/独占参数规则——这是"统一 block"的最小可行落地
2. 服务侧把 S/NS 拆两阶段，KV cache 复用——这是把"同构主干"做到延迟可控的关键
3. 不要被"causal vs full"消磨注意力——消融差 0.01%，但 causal 解锁了 cache，工程价值远大于精度










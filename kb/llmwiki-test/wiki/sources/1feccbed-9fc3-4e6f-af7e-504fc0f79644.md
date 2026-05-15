---
type: source
title: OneTrans — 当前最贴赛题主旨的统一架构（字节，WWW 2026）
created: 2026-04-29
updated: 2026-04-29
tags: [推荐系统, Transformer, 统一架构, 工业实践, KDD Cup 2026]
related: [taac2026-kdd-cup-2026, 统一主干架构, 延迟优化, sample-level-token, onetrans]
sources: ["1feccbed-9fc3-4e6f-af7e-504fc0f79644.md"]
authors: [字节跳动]
year: 2026
url: "https://arxiv.org/abs/2510.26104"
venue: "WWW 2026"
---

# OneTrans — 当前最贴赛题主旨的统一架构（字节，WWW 2026）

这篇论文是 KDD Cup 2026 推荐阅读列表中明确点名的参考架构，正面回答了赛题核心问题：用一个 Transformer 同时做序列建模与特征交互，不再分两路。

## 核心设计选择

### 1. 非序列字段 token 化（NS tokenizer）
针对赛题中 70 列 user/item int_feats + dense_feats，提供两种方案：
- **Group-wise**：按语义分组（如 HuggingFace parquet 列名前缀），每组一个 token。
- **Auto-Split**：所有字段拼接后通过 MLP 投影，切分成 N 个 token。

### 2. 多域序列并入
针对赛题中 Domain A/B/C/D 四域共 45 列序列数据：
- **Timestamp-aware**：所有 event 按时间 interleave，附 sequence-type 指示符。
- **Timestamp-agnostic**：按事件影响力直接拼接。

### 3. 块内参数共享规则
这是 OneTrans 的核心创新：
- **S-tokens（序列侧）**：共享一组参数 W^S。
- **NS-tokens（非序列侧）**：每个 token 独占参数 W_{NS,i}。
公式：W_i = W^S 当 i ≤ L^S，否则 W_{NS,i}。此规则避免语义平均化，是“统一 block”的关键 trick。

### 4. 推理延迟优化：Cross-request KV Caching
两阶段计算：
- **Stage I（per request）**：计算所有 S-tokens，缓存 KV。
- **Stage II（per candidate ad）**：每个候选广告只计算其 NS-tokens，对缓存的 S-side KV 做 cross-attention。
收益：runtime/latency -30%，memory -50%。

### 5. Causal Attention
使用带因果掩码的注意力机制，虽精度收益微小（+0.01%），但解锁 KV 缓存，工程价值显著。

## 实验结果
- **离线指标**：相比 DCNv2+DIN，CTR AUC 提升 1.53%，CVR AUC 提升 1.14%。
- **在线 A/B 测试（Feeds 场景）**：GMV 提升 5.68%，延迟降低 3.91%。

## 对赛题的启示
1. **统一 block 最小可行落地**：token 化层（NS group-wise + 序列 timestamp-aware）+ 共享/独占参数规则。
2. **服务侧拆分控延迟**：S/NS 拆两阶段，KV cache 复用，实现延迟可控。
3. **工程价值优先**：Causal Attention 的微小精度代价换取 KV 缓存支持，远优于理论最优。

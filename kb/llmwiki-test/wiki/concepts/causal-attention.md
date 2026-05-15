---
type: concept
title: Causal Attention
created: 2026-04-29
updated: 2026-04-29
tags: [注意力机制, Transformer, 工程优化]
related: [onetrans, 延迟优化]
sources: ["1feccbed-9fc3-4e6f-af7e-504fc0f79644.md"]
---

# Causal Attention

Causal Attention 是带因果掩码的注意力机制。在 OneTrans 中，虽然其精度收益微小（+0.01%），但解锁了 KV 缓存支持，工程价值显著。

## 核心价值
- **精度与工程的权衡**：Causal Attention 的微小精度代价换取 KV 缓存支持，使推理延迟降低 30%、内存减少 50%。
- **工业场景优先**：在推荐系统等工业场景中，工程效率往往优先于理论最优。

## 与 Full Attention 的对比
消融实验显示，Full Attention 的精度收益仅 +0.01%，但无法支持 KV 缓存。Causal Attention 在平衡精度与工程效率方面更具优势。

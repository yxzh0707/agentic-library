---
type: entity
title: SASRec (Self-Attentive Sequential Recommendation)
created: 2026-04-29
updated: 2026-04-29
tags: [推荐系统, 序列模型, Transformer, Causal Mask]
related: [classic-model-tricks-absorption, causal-attention, onetrans]
sources: ["9d892f8e-1218-4bd5-b6c7-e3cc35bc2f66.md"]
---

# SASRec (Self-Attentive Sequential Recommendation)

SASRec (Self-Attentive Sequential Recommendation) 是 UCSD 于 2018 年提出的序列推荐模型，是第一篇将 Transformer self-attention 用于序列推荐的论文。

## 核心技巧
- **Causal Mask**：在 Transformer 中用于序列推荐的因果掩码，确保预测仅依赖历史信息。
- **Last Token Prediction**：使用最后一个 Token 进行预测。

## 赛题吸收策略
SASRec 的 Causal Mask 可直接复用于统一主干，与 OneTrans 的因果注意力机制一致。

## 参考文献
- arXiv: 1808.09781

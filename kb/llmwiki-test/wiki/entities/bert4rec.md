---
type: entity
title: BERT4Rec (Bidirectional Encoder for Recommendation)
created: 2026-04-29
updated: 2026-04-29
tags: [推荐系统, 序列模型, Cloze Task, 预训练]
related: [classic-model-tricks-absorption, 工程三件套]
sources: ["9d892f8e-1218-4bd5-b6c7-e3cc35bc2f66.md"]
---

# BERT4Rec (Bidirectional Encoder for Recommendation)

BERT4Rec 是 SASRec 的双向版本，核心技巧为 Cloze 任务（类似掩码语言建模）。

## 核心技巧
- **Cloze Task**：通过掩码语言建模任务进行预训练，适用于序列推荐。

## 赛题吸收策略
在统一主干架构中，可考虑将 BERT4Rec 的 Cloze 任务用于预训练阶段，但需确认是否违反赛题“禁 Ensemble”的规则。

## 参考文献
- arXiv: 1904.06690

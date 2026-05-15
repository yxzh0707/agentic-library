---
type: concept
title: 经典模型吸收策略
created: 2026-04-29
updated: 2026-04-29
tags: [推荐系统, 统一主干, 吸收策略, 创新]
related: [onetrans, 统一主干架构, classic-model-tricks-absorption, 训练目标]
sources: ["9d892f8e-1218-4bd5-b6c7-e3cc35bc2f66.md"]
---

# 经典模型吸收策略

经典模型吸收策略是指在统一主干架构中内化经典推荐模型（如 DIN、DIEN、DCNv2、SASRec、BERT4Rec）的核心技巧，以提升模型性能并体现设计哲学。

## 设计哲学
- **尊重经典**：统一主干应在极限情况下能退化为经典模型，体现“包含”而非“打败”的理念。
- **展示创新**：通过统一 Attention 作为 DCNv2 泛化等视角，争取“Unified Block Innovation Award”。

## 实现路径
- **序列侧**：Target Attention、Auxiliary Loss、Causal Mask、Cloze Task 预训练。
- **非序列侧**：Cross Attention 作为 DCNv2 泛化，证明表达力更强。

## 开放问题
- 赛题规则澄清：分阶段预训练是否违反“禁 Ensemble”规则？
- 实验验证：如何设计实验验证统一主干能退化为经典模型？

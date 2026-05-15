---
type: entity
title: DCN (Deep & Cross Network)
created: 2026-04-29
updated: 2026-04-29
tags: [推荐系统, 非序列模型, 特征交叉, Google]
related: [classic-model-tricks-absorption, fat-field-aware-attention, 统一-block设计]
sources: ["9d892f8e-1218-4bd5-b6c7-e3cc35bc2f66.md"]
---

# DCN (Deep & Cross Network)

DCN (Deep & Cross Network) 是 Google 于 2017 年提出的非序列推荐模型，核心技巧为显式特征交叉。

## 核心技巧
- **Cross Network**：通过线性递推显式建模任意阶特征交叉，每层做 (x_0 ⊗ x_l) + x_l 的线性递推。

## 赛题吸收策略
在统一主干架构中，非序列 Token 间的 Cross Attention 可视为 DCN 的泛化，其中 Attention 是学习到的核函数。

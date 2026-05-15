---
type: entity
title: DCNv2 (Deep & Cross Network v2)
created: 2026-04-29
updated: 2026-04-29
tags: [推荐系统, 非序列模型, 特征交叉, Google]
related: [classic-model-tricks-absorption, fat-field-aware-attention, 统一-block设计, onetrans]
sources: ["9d892f8e-1218-4bd5-b6c7-e3cc35bc2f66.md"]
---

# DCNv2 (Deep & Cross Network v2)

DCNv2 是 DCN 的升级版，于 2020 年由 Google 提出，核心技巧为矩阵形式的交叉网络，是工业部署主力。

## 核心技巧
- **Matrix Cross Network**：将交叉网络中的 vector 形式升级为 matrix 形式，参数从 O(d) 变 O(d²)，但用低秩分解控制。
- **Mixture of Low-Rank Cross Layers**：工业部署的主力，Google 大规模部署，多个产品线 AUC 提升。

## 赛题吸收策略
在统一主干架构中，非序列 Token 间的 Cross Attention 可视为 DCNv2 的泛化，其中 Attention 是学习到的核函数，可能表达力更强。OneTrans 与 DCNv2 + DIN 对比的 AUC 提升（+1.53%）表明 DCNv2 是当前最强的非序列 Baseline。

## 参考文献
- arXiv: 2008.13535

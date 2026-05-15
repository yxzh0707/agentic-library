---
type: concept
title: Pointwise Normalization
created: 2026-04-29
updated: 2026-04-29
tags: [normalization, attention-mechanism, hstu, recommendation-system]
related: [hstu, spatial-aggregation, 统一主干架构]
sources: ["a1222571-c9e3-4b27-b630-c00090560127.md"]
---

# Pointwise Normalization

Pointwise Normalization 是 HSTU 架构中的关键创新，用于替代标准 softmax，以处理推荐系统中高基数、非平稳的 token（如 item ID）。

## 定义
在 HSTU 的 Spatial Aggregation 子层中，pointwise normalization 用于计算 token 间的交互权重，避免 softmax 在高基数 token 上失效的问题。

## 背景
推荐系统的“词表”（item ID）具有高基数（每天有新 item 加入）和非平稳性，标准 softmax 在这种场景下归一化效果会被冲掉，导致模型性能下降。

## 作用
- 实现高效的 token 间交互，同时保持计算效率。
- 支持 HSTU 在推荐场景下的 scaling 行为，是其速度优势的基础。

## 相关概念
- [[spatial-aggregation]]：HSTU 中使用 pointwise normalization 的子层。
- [[统一主干架构]]：pointwise normalization 是实现序列与非序列特征同构处理的技术之一。

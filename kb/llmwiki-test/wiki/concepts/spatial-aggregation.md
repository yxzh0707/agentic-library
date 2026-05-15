---
type: concept
title: Spatial Aggregation
created: 2026-04-29
updated: 2026-04-29
tags: [attention-mechanism, hstu, token-interaction]
related: [hstu, pointwise-normalization, 统一主干架构]
sources: ["a1222571-c9e3-4b27-b630-c00090560127.md"]
---

# Spatial Aggregation

Spatial Aggregation 是 HSTU 架构中负责 token 间交互的核心子层，使用 pointwise normalization 替代标准 softmax。

## 定义
在 HSTU 每层的三个子层中，Spatial Aggregation 是真正进行 token 间交互的地方，类似于 attention 机制，但使用 pointwise normalization 而非 softmax。

## 作用
- 实现 token 间的交互，同时避免高基数 token 场景下 softmax 的失效问题。
- 是 HSTU 能高效处理 [CLS, User, Item, Sequence] 四类 token 的关键。

## 与标准 Transformer 的区别
标准 Transformer 使用 softmax 计算注意力权重，而 HSTU 的 Spatial Aggregation 使用 pointwise normalization，更适合推荐系统的高基数、非平稳 token。

## 相关概念
- [[pointwise-normalization]]：Spatial Aggregation 中使用的核心技术。
- [[统一主干架构]]：Spatial Aggregation 是实现序列与非序列特征同构处理的组件之一。

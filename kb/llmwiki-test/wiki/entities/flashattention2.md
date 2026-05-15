---
type: entity
title: FlashAttention2
created: 2026-04-29
updated: 2026-04-29
tags: [attention-optimization, speed-benchmark, transformer]
related: [hstu]
sources: ["a1222571-c9e3-4b27-b630-c00090560127.md"]
---

# FlashAttention2

FlashAttention2 是一种优化的注意力机制实现，用于加速 Transformer 模型的计算。在 HSTU 的上下文中，它被用作速度对比的基准。

## 背景
FlashAttention2 是标准 Transformer 注意力机制的高效实现，通过减少内存访问和优化计算来提升速度。

## 在 HSTU 中的使用
- HSTU 在 8192 长序列下比 FlashAttention2 Transformer 快 **5.3x ~ 15.2x**。
- 这一速度对比突显了 HSTU 在推荐场景下的工程优势。

## 相关概念
- [[hstu]]：HSTU 架构的速度优势以 FlashAttention2 为基准。

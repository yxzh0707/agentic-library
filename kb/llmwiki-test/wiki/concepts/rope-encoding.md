---
type: concept
title: RoPE（旋转位置编码）
created: 2026-04-29
updated: 2026-04-29
tags: [positional-encoding, llm, sequence-modeling, token-type-encoding]
related: [causal-attention, 统一嵌入层, deepcontextnet, taac2026-cluster-review]
sources: ["41c16c8b-3ce0-459b-89ac-b00602053736.md"]
---

# RoPE（旋转位置编码）

RoPE（Rotary Positional Embedding）是由 Su 等人在 2021 年提出的位置编码技术，现已成为 LLaMA、Gemma、Mistral 等大模型的默认位置编码方案。

## 原理

RoPE 将绝对位置编码为多个 cos/sin 平面中的旋转矩阵，相对位置自动从相位差中读出。这种方式统一表达了绝对与相对位置，且无需额外可学习参数。

## 关键性质

- 绝对 + 相对位置统一表达
- 零额外可学习参数
- 序列长度可外推（4k 训练 → 100k+ 推理只需 angle scaling）
- 兼容线性 attention 形式

## 在推荐系统中的非标准应用

在 TAAC2026 基线模型 DeepContextNet 中，RoPE 被用于“token type encoding”——即区分 CLS、User、Item 等 token 类型，而非传统的时序位置编码。这种用法为赛题选手提供了改进空间。

## 时间感知 RoPE

作为 Baseline RoPE 用法的改进方向，时间感知 RoPE 将事件 timestamp 的对数映射为连续位置，再用 RoPE 编码，使位置编码更具物理意义。这是一个潜在的论文创新点。

## 资源

- 原论文：https://arxiv.org/abs/2104.09864
- Selective RoPE：https://arxiv.org/abs/2511.17388
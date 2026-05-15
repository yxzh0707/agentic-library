---
type: entity
title: Sample Is Feature
created: 2026-04-29
updated: 2026-04-29
tags: [论文, 创新轴, 统一推荐模型]
related: [sample-level-token, taac2026-kdd-cup-2026, hstu, onetrans, 统一主干架构]
sources: ["6c886021-c6ef-4e0c-b85e-beaa79f2e060.md", "36c9093a-685e-405e-ab99-2ab5fa147443.md"]
---

# Sample Is Feature

《Sample Is Feature》是一篇发表于 arXiv（编号 2604.15650）的论文，它挑战了统一推荐模型中默认的 **item-level token 假设**。该假设认为，用户历史中的每个物品（item）应被编码为一个独立的 token 进行处理。论文指出，这种做法存在结构性局限：它丢失了样本的完整上下文（如请求时间、用户状态、其他候选物品），并且序列 token 与非序列 token 的异构性导致统一 backbone 处理是次优的。

论文的核心解法是引入 **sample-level token**，将每个历史“样本”（即一次完整的用户-上下文-候选物品交互）作为一个整体 token 进行编码，从而保留更丰富的上下文信息。这一思路为 TAAC2026/KDD Cup 2026 赛题提供了新的创新轴，特别是在统一主干架构设计中。

相关讨论可参考 [[sample-level-token]] 和 [[统一主干架构]]。

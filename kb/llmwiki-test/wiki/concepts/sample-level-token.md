---
type: concept
title: Sample-Level Token
created: 2026-04-29
updated: 2026-04-29
tags: [token化, 统一架构, 上下文保留]
related: [sample-is-feature, item-level-token, 统一主干架构, taac2026-modeling-challenges]
sources: ["003a7684-bc68-423c-b1e1-dba5b579b820.md", "36c9093a-685e-405e-ab99-2ab5fa147443.md"]
---

# Sample-Level Token

**Sample-Level Token** 是一种 token 化方法，它将每个历史“样本”（即一次完整的用户-上下文-候选物品交互）作为一个整体 token 进行编码，而不是像传统 **item-level token** 那样仅将每个物品编码为独立 token。

## 与 Item-Level Token 的对比

- **Item-Level Token**：仅编码“行为发生”，丢失了样本的完整上下文（如请求时间、用户状态、其他候选物品）。这是现有统一推荐模型（如 HSTU、OneTrans）的默认假设。
- **Sample-Level Token**：保留样本的全部上下文，提供更丰富的信息，但可能导致序列变短，影响模型速度。

## 在统一架构中的应用

在 TAAC2026/KDD Cup 2026 赛题中，sample-level token 可通过“代理构造”（如行为共现、时间邻近）近似实现，因为赛题历史数据缺乏显式上下文。这为统一主干架构提供了新的创新轴，但也引入了速度风险（序列变短可能削弱 HSTU 等模型的速度优势）。

相关概念：[[sample-is-feature]]、[[统一主干架构]]、[[taac2026-modeling-challenges]]。

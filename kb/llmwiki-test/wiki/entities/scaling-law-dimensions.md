---
type: entity
title: Scaling Law 维度框架
created: 2026-04-29
updated: 2026-04-29
tags: [scaling-law, dimensions, innovation]
related: [taac2026-kdd-cup-2026, sample-is-feature, unified-architecture]
sources: ["80f87065-23cb-4f4d-ab2d-90eafcff89f9.md"]
---

# Scaling Law 维度框架

Scaling Law 维度框架定义了模型性能随计算量变化的5个关键维度，为TAAC2026赛题的Scaling Law Innovation Award提供创新方向。

## 5个Scaling维度

1. **W (Width)** — 模型宽度，Wukong起就在scale。
2. **D (Depth)** — 模型深度，HSTU、RankMixer等涉及。
3. **T (Token数)** — Token数量，RankMixer正式列入。
4. **L (Sequence Length)** — 序列长度，TWIN V2、ULTRA-HSTU等涉及。
5. **N (Sample内Token粒度)** — Sample-level granularity，Sample Is Feature提出的新维度。

## 赛题创新点
- **NS token数**：70个非序列特征如何切分为几个token，是相对未被探索的方向。
- **Sample-level granularity**：从item-level token走向sample-level token，挑战现有scaling假设。

## 与现有模型的连接
- [[wukong]]：W和D维度的奠基工作。
- [[hstu]]：序列侧scaling的事实标准。
- [[sample-is-feature]]：N维度的突破性概念。
- [[unified-architecture]]：统一架构在多个维度上的协同设计。

---
type: concept
title: Scaling Law 理论工具
created: 2026-04-29
updated: 2026-04-29
tags: [scaling-law, theory, efficiency]
related: [kunlun, fat-field-aware-attention, est, scaling-law-dimensions]
sources: ["80f87065-23cb-4f4d-ab2d-90eafcff89f9.md"]
---

# Scaling Law 理论工具

Scaling Law 理论工具为模型效率优化提供科学化解释，提升TAAC2026赛题论文的理论分量。

## 核心理论工具

1. **MFU (Model FLOPs Utilization)** — GPU实际利用率，Kunlun提出的核心瓶颈指标，替代FLOPs成为优化目标。
2. **Rademacher复杂度** — FAT提出的形式化CTR scaling law理论工具，用于解释模型性能曲线的理论依据。
3. **Lightweight Cross-Attention** — EST提出的有理论根的剪枝方法，优化推理效率。

## 应用场景
- **Kunlun优化**：通过GDPA、Hierarchical Seed Pooling等技术提升MFU，实现scaling效率2x。
- **FAT理论对话**：在论文中与Rademacher framing对话，增强理论解释。
- **效率科学化**：从单纯画曲线转向解释曲线成立的理论原因。

## 与现有模型的连接
- [[kunlun]]：MFU优化的代表工作。
- [[fat-field-aware-attention]]：Rademacher复杂度的形式化框架。
- [[est]]：Lightweight Cross-Attention的工业实践。

---
type: entity
title: HyFormer
created: 2026-04-29
updated: 2026-04-29
tags: [模型架构, 层间交错, 论文策略]
related: [统一-block设计]
sources: ["6c886021-c6ef-4e0c-b85e-beaa79f2e060.md"]
---

# HyFormer

HyFormer 是一篇论文（2601.12681）提出的模型架构，在 TAAC2026 赛题的综合作战计划中用于 **Unified Block 创新** 的层间交错思路。

在 Unified Block 路径中，HyFormer 的 Query Decoding 作为层间池化算子，与 OneTrans 的参数分化结合，提出新 block。具体做法：偶数层标准 unified self-attention，奇数层 Query Decoding 风 cross-attention。

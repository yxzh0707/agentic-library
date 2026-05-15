---
type: entity
title: Muon 优化器
created: 2026-04-29
updated: 2026-04-29
tags: [optimizer, training-efficiency, llm, orthogonalization]
related: [deepcontextnet, 延迟优化, taac2026-cluster-review]
sources: ["2d6c46a6-ec1b-468e-b475-ca64e91e0768.md", "41c16c8b-3ce0-459b-89ac-b00602053736.md"]
---

# Muon 优化器

Muon 是由 Keller Jordan 等人在 2024 年末发布的优化器，核心思想是对隐藏层权重的梯度更新进行正交化，以提升训练效率。

## 原理

Muon 通过 Newton-Schulz 迭代对更新矩阵进行正交化，将其投到正交矩阵流形上。这种方法避免了 SVD 的计算开销，仅需几次矩阵乘法即可完成。

## 应用范围

Muon 仅用于隐藏层 2D 权重；嵌入层和 LayerNorm 仍使用 AdamW。这种混合模式是 Muon 论文推荐的实践。

## 效率优势

在 LLM scaling law 测试下，Muon 的计算效率约为 AdamW 的 2 倍。在推荐系统场景中，它特别适用于 HSTU 等大参数量模块的训练。

## 赛题中的取舍

在 TAAC2026 赛题中，保留 Muon 可与基线公平对照，且其 2x 训练效率意味着同样时间能扫描更多超参。替换为 AdamW 则更稳定且文献支持更多。混合使用（Muon 用于 backbone，AdamW 用于 embedding/output）是推荐模式。

## 资源

- 论文：https://arxiv.org/pdf/2502.16982
- 博客：https://kellerjordan.github.io/posts/muon/
- 代码：https://github.com/KellerJordan/Muon
---
type: entity
title: HSTU 模型架构
created: 2026-04-29
updated: 2026-04-29
tags: [hstu, model-architecture, meta, recommendation-system]
related: [taac2026-kdd-cup-2026, 统一主干架构, scaling-law-theory, muon-optimizer, pointwise-normalization]
sources: ["003a7684-bc68-423c-b1e1-dba5b579b820.md", "a1222571-c9e3-4b27-b630-c00090560127.md"]
---

# HSTU 模型架构

HSTU（Hierarchical Sequential Transformer Unit）是 Meta 提出的推荐系统架构，发表于 ICML 2024，用于万亿参数生成式推荐。它是 TAAC2026 赛题 baseline 的核心 block，也是推荐域 Scaling Law 创新的骨架。

## 架构细节
HSTU 每层包含三个子层：
1. **Pointwise Projection**：token-wise 投影，每个 token 独立处理。
2. **Spatial Aggregation**：使用 **pointwise normalization** 替代 softmax，实现 token 间交互，解决推荐场景高基数 token 的归一化问题。
3. **Pointwise Transformation**：token-wise 变换。

## 性能优势
- 在 8192 长序列下，比 FlashAttention2 Transformer 快 **5.3x ~ 15.2x**。
- 支持更大模型容量，在延迟约束下留出更大工程预算。

## 在 TAAC2026 中的应用
- 直接处理 [CLS, User, Item, Sequence] 四类 token，实现序列与非序列特征的同构处理。
- 是 Scaling Law 创新奖的自然 baseline，已证明能平稳提升 AUC。
- **改进机会**：缺乏显式 S/NS 参数区分，可结合 OneTrans 规则进行创新。

## 引用
- Paper: [arxiv 2402.17152](https://arxiv.org/abs/2402.17152)
- 代码: [meta-recsys/generative-recommenders](https://github.com/meta-recsys/generative-recommenders)

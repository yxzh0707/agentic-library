---
type: entity
title: MTGR 模型架构
created: 2026-04-29
updated: 2026-04-29
tags: [模型架构, 推荐系统, 工业应用]
related: [hstu, onetrans, taac2026-kdd-cup-2026, 统一主干架构, 延迟可控的scaling]
sources: ["003a7684-bc68-423c-b1e1-dba5b579b820.md", "25c98cc2-55a5-483f-a395-9be79561c6f6.md"]
---

# MTGR 模型架构

MTGR 是一种结合了 HSTU 与 GLN（Group Layer Normalization）的工业级推荐模型架构。在 TAAC2026 赛题的综合作战计划中，MTGR 被选为首选 Backbone，因其起步代价最低、保留赛题数据中的 Cross Feature 语义，并且有工业 baseline 数字支持。

## 在 TAAC2026 中的应用

*   **Tokenizer 设计**：MTGR 的架构支持分层 Tokenizer 设计，序列侧采用 timestamp-aware interleave，非序列侧采用 group-wise 压缩。
*   **Block 内部结构**：MTGR 的 GLN 用于 Layer normalization 按语义分组，结合 HSTU 的 pointwise normalization 以获得延迟优势。
*   **参数规则**：遵循序列 token 共享、NS token 独占的规则，借自 OneTrans。
*   **Mask 机制**：使用 dynamic mask 隔离不该互看的 token，确保模型效率。

MTGR 作为 TAAC2026 赛题的核心 Backbone，其设计哲学强调工程实用性与论文价值的平衡，是统一主干架构的具体实现之一。
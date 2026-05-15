---
type: concept
title: 分层 Tokenizer 设计
created: 2026-04-29
updated: 2026-04-29
tags: [tokenizer, 推荐系统, 特征工程]
related: [同构-token化, onetrans, mtgr, taac2026-kdd-cup-2026]
sources: ["25c98cc2-55a5-483f-a395-9be79561c6f6.md"]
---

# 分层 Tokenizer 设计

分层 Tokenizer 设计是 TAAC2026 综合作战计划中提出的关键技术，用于将用户的多域行为序列和非序列字段编码成统一的 token 表示。该设计分为序列侧和非序列侧，以实现高效的特征提取和模型输入。

## 序列侧设计

*   **Timestamp-aware Interleave**：对 4 个域（domain）的行为序列进行时间感知的交错处理。
*   **事件表示**：每个事件由 item_id embedding、action_type embedding 和 time_bucket embedding 拼接而成（而非简单的加法），并附加 4 维的 domain type embedding。
*   **目的**：保留序列的时序信息和域特异性，为后续的统一 Block 处理提供高质量输入。

## 非序列侧设计

*   **Group-wise 压缩**：借鉴 OneTrans 的风格，将非序列特征分组压缩为 token。
    *   **User 组**：46 个 user_int_feats + 10 个 user_dense_feats → 8-16 个 user token。
    *   **Item 组**：14 个 item_int_feats → 4-8 个 item token。
    *   **Candidate 组**：当前打分的目标广告 → 1 个 candidate token。
*   **目的**：减少非序列特征的维度，同时保留关键信息，便于与序列特征在统一 Block 中交互。

分层 Tokenizer 设计是实现序列与非序列特征同构处理的基础，为统一主干架构提供了灵活的输入表示。
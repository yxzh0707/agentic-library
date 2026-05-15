---
type: entity
title: 经典模型技巧吸收
created: 2026-04-29
updated: 2026-04-29
tags: [推荐系统, 经典模型, 统一主干, 吸收策略]
related: [onetrans, din, dien, sasrec, bert4rec, dcn, dcnv2, 统一主干架构, 训练目标]
sources: ["9d892f8e-1218-4bd5-b6c7-e3cc35bc2f66.md"]
---

# 经典模型技巧吸收

经典模型技巧吸收是指将 DIN、DIEN、DCN、DCNv2、SASRec、BERT4Rec 等经典推荐模型的核心技巧融入统一主干架构的设计策略。这一策略旨在让统一主干在极限情况下能退化为经典模型，从而体现“尊重经典”与“展示创新”的平衡。

## 序列侧技巧吸收
- **DIN 的 Target Attention**：在统一 Token 流中，让 Candidate Ad Token 对历史行为 Token 进行加权求和，实现用户表示因候选而异。
- **DIEN 的 Auxiliary Loss**：将预测下一行为的辅助任务作为廉价损失函数融入统一主干。
- **SASRec 的 Causal Mask**：直接复用于统一主干，确保预测仅依赖历史信息。
- **BERT4Rec 的 Cloze 任务**：可考虑用于预训练阶段，但需确认赛题规则。

## 非序列侧技巧吸收
- **DCNv2 的 Cross Attention 泛化**：将非序列 Token 间的 Cross Attention 视为 DCNv2 的泛化，其中 Attention 是学习到的核函数，可能表达力更强。

## 相关实体
- [[onetrans]]：作为统一主干架构，是吸收经典技巧的载体。
- [[din]]、[[dien]]、[[sasrec]]、[[bert4rec]]、[[dcn]]、[[dcnv2]]：经典模型实体。

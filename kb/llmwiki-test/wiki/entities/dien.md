---
type: entity
title: DIEN (Deep Interest Evolution Network)
created: 2026-04-29
updated: 2026-04-29
tags: [推荐系统, 序列模型, Auxiliary Loss, 阿里]
related: [classic-model-tricks-absorption, 训练目标, transact-v2]
sources: ["9d892f8e-1218-4bd5-b6c7-e3cc35bc2f66.md"]
---

# DIEN (Deep Interest Evolution Network)

DIEN (Deep Interest Evolution Network) 是阿里巴巴于 2018 年提出的序列推荐模型，是 DIN 的升级版，核心技巧为 Auxiliary Loss。

## 核心技巧
- **Auxiliary Loss**：通过预测下一行为等辅助任务，显式建模兴趣演化。

## 赛题吸收策略
在统一主干架构中，可将 DIEN 的 Auxiliary Loss 作为廉价辅助损失函数融入，与 TransAct V2 的 Next Action Loss 思路一致。

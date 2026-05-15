---
type: entity
title: DIN (Deep Interest Network)
created: 2026-04-29
updated: 2026-04-29
tags: [推荐系统, 序列模型, Target Attention, 阿里]
related: [classic-model-tricks-absorption, 统一主干架构, onetrans]
sources: ["9d892f8e-1218-4bd5-b6c7-e3cc35bc2f66.md"]
---

# DIN (Deep Interest Network)

DIN (Deep Interest Network) 是阿里巴巴于 2017 年提出的序列推荐模型，核心技巧为 Target Attention。

## 核心技巧
- **Target Attention**：用候选广告作为 Query 对用户历史行为序列进行加权求和，使用户表示因候选而异，而非传统的 Mean-Pooling。

## 赛题吸收策略
在统一主干架构中，通过让 Candidate Ad Token 对历史行为 Token 进行 Target Attention，可在统一框架内复活 DIN 的核心能力。

## 参考文献
- arXiv: 1706.06978
- 工业部署：阿里展示广告主流量，2B 样本。

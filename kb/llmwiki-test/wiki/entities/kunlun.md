---
type: entity
title: Kunlun
created: 2026-04-29
updated: 2026-04-29
tags: [论文, MFU优化, 延迟分析, 工具]
related: [延迟可控的scaling, 交叉请求kv缓存, mtgr]
sources: ["6c886021-c6ef-4e0c-b85e-beaa79f2e060.md"]
---

# Kunlun

Kunlun 是一篇论文（2602.10016），在 TAAC2026 赛题的综合作战计划中扮演关键角色，主要用于 **MFU（Model FLOPs Utilization）优化** 和 **延迟分析**。

在 Tier 2 工程优化中，Kunlun 提供了 MFU 度量框架，用于评估模型训练效率，并作为延迟来源分析的工具。它与 [[交叉请求kv缓存]] 等技术结合，帮助在延迟约束下优化模型性能。

---
type: concept
title: 交叉请求 KV 缓存
created: 2026-04-29
updated: 2026-04-29
tags: [推理优化, 延迟优化, KV 缓存]
related: [onetrans, 延迟优化]
sources: ["1feccbed-9fc3-4e6f-af7e-504fc0f79644.md"]
---

# 交叉请求 KV 缓存

交叉请求 KV 缓存（Cross-request KV Caching）是 OneTrans 中用于降低推理延迟和内存占用的核心技术。其采用两阶段计算：

## 两阶段计算
1. **Stage I（per request）**：计算所有 S-tokens，缓存 KV。
2. **Stage II（per candidate ad）**：每个候选广告只计算其 NS-tokens，对缓存的 S-side KV 做 cross-attention。

## 收益
- runtime/latency -30%
- memory -50%

## 赛题意义
在 KDD Cup 2026 赛题中，每个用户在一次请求里要打分多个候选广告，序列侧重复计算是浪费。Cross-request KV Caching 直接决定能否在延迟预算内打高 AUC。

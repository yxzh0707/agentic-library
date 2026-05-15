---
type: entity
title: OneTrans
created: 2026-04-29
updated: 2026-04-29
tags: [模型架构, Transformer, 统一架构, 字节跳动]
related: [taac2026-kdd-cup-2026, 统一主干架构, 延迟优化, sample-level-token, 多域序列并入]
sources: ["1feccbed-9fc3-4e6f-af7e-504fc0f79644.md"]
---

# OneTrans

OneTrans 是字节跳动提出的一种统一 Transformer 架构，用于同时处理序列建模和特征交互。该架构被 KDD Cup 2026 赛题组织方明确列为推荐阅读，是赛题的核心参考点。

## 核心创新

### 1. 参数分配策略
- **序列 token（S-tokens）**：共享一组参数，避免重复计算。
- **非序列 token（NS-tokens）**：每个 token 独占参数，避免语义平均化。
此规则是“统一 block”的关键 trick，确保不同语义角色的 token 得到针对性处理。

### 2. 推理延迟优化
采用 **Cross-request KV Caching** 两阶段计算：
- Stage I：缓存序列侧 KV。
- Stage II：对每个候选广告计算非序列侧，复用缓存。
实测延迟降低 30%，内存减少 50%，证明统一架构在工业部署中可实现高效推理。

### 3. 工程实践验证
在字节 Feeds 场景的实际部署中，OneTrans 相比双轨架构（DCNv2+DIN）实现离线 AUC 提升 1.53%（CTR）和 1.14%（CVR），在线 GMV 提升 5.68%，同时延迟降低 3.91%。

## 与赛题的关联
OneTrans 直接对应赛题中“统一主干架构”的设计要求，其 NS tokenizer、多域序列并入、参数共享规则等技术细节均可直接复用，为赛题提供可落地的解决方案。

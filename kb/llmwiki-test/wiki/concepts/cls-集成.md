---
type: concept
title: CLS 集成
created: 2026-04-29
updated: 2026-04-29
tags: [预测出口, token 聚合, 最终预测]
related: [deepcontextnet, 深度交互]
sources: ["2d6c46a6-ec1b-468e-b475-ca64e91e0768.md"]
---

# CLS 集成

CLS 集成是 DeepContextNet 的关键技巧，CLS token 聚合用户静态属性、item 特征和行为序列做最终预测。

## 方法

- CLS token 作为唯一的预测出口，聚合所有信息。
- 通过非线性瓶颈层输出 CTR 概率。

## 局限性

单 CLS 在多类 token 混合时容易被序列侧主导。

## 改进方向

引入 candidate item token 参与预测，实现多预测出口。

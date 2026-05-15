---
type: overview
title: Wiki Index
created: 2026-04-29
updated: 2026-04-29
tags: []
related: []
sources: ["003a7684-bc68-423c-b1e1-dba5b579b820.md", "1feccbed-9fc3-4e6f-af7e-504fc0f79644.md", "2d6c46a6-ec1b-468e-b475-ca64e91e0768.md", "2e27e6fa-dd52-4724-a935-d3a167c9f358.md", "6ab21467-3b2e-410d-ad03-745d0d2f7796.md", "6c886021-c6ef-4e0c-b85e-beaa79f2e060.md", "8d7ad6b3-c41d-4352-ad78-6c363ef7ddf8.md", "9d892f8e-1218-4bd5-b6c7-e3cc35bc2f66.md", "25c98cc2-55a5-483f-a395-9be79561c6f6.md", "332a2579-1a3a-4ad8-ace0-0def1e4135fe.md", "36c9093a-685e-405e-ab99-2ab5fa147443.md", "41c16c8b-3ce0-459b-89ac-b00602053736.md", "80f87065-23cb-4f4d-ab2d-90eafcff89f9.md", "a1222571-c9e3-4b27-b630-c00090560127.md"]
---

# Wiki Index

## Entities

- [[taac2026-kdd-cup-2026]] — TAAC2026/KDD Cup 2026 推荐系统赛题
- [[one-trans]] — OneTrans 模型架构
- [[hstu]] — HSTU 模型架构
- [[mtgr]] — MTGR 模型架构
- [[onetrans]] — OneTrans 统一 Transformer 架构
- [[bytedance]] — 字节跳动
- [[huggingface-parquet]] — HuggingFace Parquet 数据格式
- [[deepcontextnet]] — DeepContextNet 基线模型
- [[muon-optimizer]] — Muon 优化器
- [[综合作战计划]] — 围绕赛题的综合性策略方案
- [[taac2026-framing-analysis]] — TAAC2026 赛题 Framing 分析
- [[kunlun]] — Kunlun 论文（MFU 优化与延迟分析）
- [[fat-field-aware-attention]] — FAT (Field-Aware Attention) 理论框架
- [[sample-is-feature]] — Sample Is Feature 技术概念
- [[transact-v2]] — TransAct V2 技术概念
- [[hyformer]] — HyFormer 模型架构
- [[wukong]] — Wukong 模型架构
- [[taac2026-data-format]] — TAAC2026 数据格式
- [[classic-model-tricks-absorption]] — 经典模型技巧吸收
- [[din]] — DIN (Deep Interest Network)
- [[dien]] — DIEN (Deep Interest Evolution Network)
- [[sasrec]] — SASRec (Self-Attentive Sequential Recommendation)
- [[bert4rec]] — BERT4Rec (Bidirectional Encoder for Recommendation)
- [[dcn]] — DCN (Deep & Cross Network)
- [[dcnv2]] — DCNv2 (Deep & Cross Network v2)
- [[taac2026-cluster-review]] — TAAC2026 统一主干架构设计簇
- [[sample-is-feature]] — Sample Is Feature 论文
- [[scaling-law-dimensions]] — Scaling Law 维度框架
- [[suyanli220]] — TAAC2026 baseline GitHub 仓库作者
- [[flashattention2]] — FlashAttention2 速度基准
- [[m-falcon]] — M-FALCON 微批处理方案

## Concepts

- [[统一主干架构]] — 设计单一、同构的主干网络以统一处理序列与非序列特征
- [[序列与非序列特征同构处理]] — 在同一个模型中对序列和非序列特征进行统一建模
- [[双轨建模瓶颈]] — 工业推荐系统中序列建模与特征交互分离导致的问题
- [[异构-transformer]] — 能够处理异构数据的 Transformer 变体
- [[sample-level-token]] — 以样本为单位进行 Tokenization 的技术概念
- [[延迟优化]] — 优化模型推理延迟以满足工业部署要求
- [[scaling-law-实验]] — 研究模型性能随规模变化的实验方法
- [[多域序列并入]] — 将多个域的序列事件统一到同一序列中处理
- [[causal-attention]] — 带因果掩码的注意力机制，平衡精度与工程效率
- [[块内参数共享规则]] — 按 token 类型分配参数预算，避免语义平均化
- [[交叉请求kv缓存]] — 两阶段计算降低推理延迟和内存占用
- [[统一嵌入层]] — 将稀疏类别 ID 和稠密向量映射到共享潜空间
- [[序列合成]] — 将 Item_ID、Action_Type、Temporal_Bucket 三个 embedding 加法融合成一个事件 token
- [[深度交互]] — 使用多个 HSTU 块处理 [CLS, User, Item, Sequence] token
- [[cls-集成]] — CLS token 聚合用户静态属性、item 特征和行为序列做最终预测
- [[非序列特征压缩]] — 将 70 列非序列特征压缩为两个 token（User/Item）
- [[工程三件套]] — 蒸馏、多任务学习、哈希压缩等实际部署技术
- [[同构-token化]] — 将用户的多域行为序列和非序列字段编码成统一 token 表示
- [[统一-block设计]] — 单个模型块同时承担序列内自注意力、非序列内特征交叉以及交叉注意力
- [[延迟可控的scaling]] — 在延迟约束下通过模型扩展提升性能，避免工程风险
- [[三档实验路线]] — 按代价递增的实验规划，指导资源分配和优先级
- [[训练目标]] — 综合损失函数，结合多任务学习、自监督学习和蒸馏技术
- [[论文奖项策略]] — 针对论文奖项的两条 framing 路径
- [[taac2026-modeling-challenges]] — TAAC2026 建模挑战
- [[经典模型吸收策略]] — 在统一主干架构中内化经典推荐模型的核心技巧
- [[分层-tokenizer设计]] — 分层 Tokenizer 设计，用于将用户的多域行为序列和非序列字段编码成统一的 token 表示
- [[taac2026-cluster-analysis]] — TAAC2026 簇分析方法
- [[sample-level-token]] — Sample-Level Token 技术概念
- [[rope-encoding]] — RoPE（旋转位置编码）技术概念
- [[scaling-law-theory]] — Scaling Law 理论工具
- [[pointwise-normalization]] — Pointwise Normalization 技术概念
- [[spatial-aggregation]] — Spatial Aggregation 技术概念

## Sources

- [[003a7684-bc68-423c-b1e1-dba5b579b820]] — TAAC2026 赛题统一主干架构设计簇分析
- [[1feccbed-9fc3-4e6f-af7e-504fc0f79644]] — OneTrans — 当前最贴赛题主旨的统一架构（字节，WWW 2026）
- [[2d6c46a6-ec1b-468e-b475-ca64e91e0768]] — 腾讯广告赛题 DeepContextNet 基线模型拆解
- [[2e27e6fa-dd52-4724-a935-d3a167c9f358]] — 推荐系统赛题综合解决方案簇分析
- [[6ab21467-3b2e-410d-ad03-745d0d2f7796]] — TAAC2026 / KDD Cup 2026 赛题 framing
- [[6c886021-c6ef-4e0c-b85e-beaa79f2e060]] — 综合作战计划 v2（吸收第二轮深度搜索后的修订）
- [[8d7ad6b3-c41d-4352-ad78-6c363ef7ddf8]] — TAAC2026 赛题全览（问题导向版）
- [[9d892f8e-1218-4bd5-b6c7-e3cc35bc2f66]] — 赛题经典 Baseline 吸收策略
- [[25c98cc2-55a5-483f-a395-9be79561c6f6]] — TAAC2026 综合作战计划：模型选型、结构设计与奖项策略
- [[332a2579-1a3a-4ad8-ace0-0def1e4135fe]] — TAAC2026 统一主干架构设计簇分析
- [[36c9093a-685e-405e-ab99-2ab5fa147443]] — Sample Is Feature — 一个对赛题最有可能拿"创新分"的新 axis
- [[41c16c8b-3ce0-459b-89ac-b00602053736]] — Baseline 用到的两个非显然技术：Muon 优化器 + RoPE
- [[80f87065-23cb-4f4d-ab2d-90eafcff89f9]] — 推荐域 Scaling Law 全图谱（赛题创新奖二的论文坐标系）
- [[a1222571-c9e3-4b27-b630-c00090560127]] — HSTU — 赛题 baseline 的核心 block，也是 scaling law 的骨架

## Queries

## Comparisons

## Synthesis

# Knowledge Base v1.3 设计文档

**版本**:1.3.1
**日期**:2026-04-29
**状态**:框架冻结版

> ⚠️ **后续 framing 升级公告**：本设计稿截至 2026-04-29。之后系统经历了两次重要 framing 升级:
>
> 1. **2026-04-29~30 层级聚类升级**:见 `docs/clustering_pipeline.md`
> 2. **2026-05-11 working_set framing 升级**:见 `docs/handoff_2026_05_11.md`
> 3. **2026-05-13~14 handoff 待办落地**:cluster_review sub_theme_recommendations (三级消费)、move_out 支持 target_cluster_id='new'、fullRecluster 全 noise cluster_friction 信号 + GC op_log 审计、reset_clusters_and_recluster admin tool、前端 single-child parent 压平。运行事实以 `docs/clustering_pipeline.md` 为准。
>
> 本文档以下章节跟现状有出入,以上述升级文档为准:
> - §6.1 主聚类 — cold_start_cluster 实际承担小 N 主路径,K=1 working_set 是常态
> - §6.2 关键参数 — hdbscan.min_cluster_size 已自适应到 max(3, N/8)
> - §6.3 增量与全量 — 新增 30 天软锁、cold_start、rescueNoiseNodes、全 noise 信号
> - §6.5 子结构判定(k-means + silhouette)— 从未实施;子结构通过 sub-hub anchor (hub_role=center) 表达
> - §6.7 Hub 计算 — hub_source 值集已细化为 librarian_recommended / raw_lexical_fallback / synthesis_calculated / none

**v1.3.1 字段层小改**(相对 v1.3.0,框架不变):
- **检索阶段 2 改为多簇扩展**(§9.3 / §9.4):从 top-1 命中簇扩展改为 top-K 命中簇扩展(默认 K=3),防止单一簇命中错误导致召回失败
- **新增簇 centroid 漂移监控**(§6.6):在 cluster_review 自证伪机制之外,加一层基于 centroid + 协方差的统计漂移检测,作为 on_review 优先级辅助信号

**v1.3 主要变更**(相对 v1.2):
- **嵌入简化**:每节点两个嵌入(e_l0、e_l1),取消 e_l2
- **节点 hub_role 字段**:入库时 LLM 判断初始值,后续可由图书管理员通过操作日志修改
- **synthesis subtype 扩展**:从 4 个扩到 6 个(consolidation / annotation / question / association / meta / cluster_review),v1.0 实施 consolidation 和 cluster_review,其他延后
- **触发器范式重构**:从被动响应外部信号(co_retrieval/drift/substructure/explicit)转为伴随真实工作动作(on_ingest/on_review/on_query/on_reflection)
- **cluster_review 机制**:作为新 subtype,承担 hub 补位资格、自证伪追踪、与簇生命周期绑定、链式继承前任判断
- **L1 升级为工作记忆**:大部分 LLM 阅读基于 L1,L2 仅在权威验证时使用
- **检索三阶段**:raw 和 synthesis 平等并行检索,LLM 在生成阶段自决
- **多跳遍历能力**:作为 KB 一等能力,通过 tool 暴露给所有 Agent

**v1.2 → v1.3 概念正交性确认**:
- 视图级别 L0/L1/L2(每节点的多详细度切片)
- 节点类型 raw / synthesis / reflection(reflection v1.0 不实现,保留枚举值)
- HNSW 数据结构(纯实现层)
三个维度依然独立。

---

## 〇 一页摘要

一个面向 Agent 的、自组织的知识库——**不是项目管理工具、不是 Agent 对话记忆、不是 RAG 服务**,而是一个**外部于任何具体 Agent 的、长寿的、由图书管理员 Agent 持续维护的知识基础设施**。

**核心比喻**:这是图书馆,不是笔记本。
- raw 节点是馆藏资料(权威)
- synthesis 节点是图书管理员的学习笔记(辅助)
- 图书管理员 Agent 维护知识库的健康度(无主、为知识本身工作)
- 咨询员 Agent 是唯一人类接口

**核心机制**:
- 知识以 markdown 文件形式扁平存储,UUID 寻址,与物理位置完全解耦
- 多向量嵌入(e_l0、e_l1)+ HNSW 索引,L0/L1 视图切片支持渐进式披露
- HDBSCAN + UMAP 主聚类,只对 raw 跑;silhouette 判定子结构
- Synthesis 是图书管理员的学习痕迹,通过 sources 单向指向 raw,不参与聚类输入
- 部分 synthesis(cluster_review)在缺 raw hub 时可补位为簇中心
- 图书管理员周期性巡视,所有结构性操作进独立操作日志,可回滚
- 所有能力通过 Tools 层统一暴露,Agent 之间能力平等、身份叠加

**最重要的差异化**:
- 主语是知识本身,不是 Agent
- 多范式融合(Karpathy 写入时综合 + OpenViking 边界约束 + 经典 RAG 兜底)
- 客观结构(嵌入聚类)与主观判断(LLM cluster_review)显式分工

---

## 一 定位与设计原则

### 1.1 这是什么

一个独立部署的、可被多个 Agent 共享的知识管理系统。它存储结构化的、被反复维护的、跨时间累积的知识,而不是任何特定 Agent 的对话历史或交互记录。

### 1.2 这不是什么

- 不是项目管理工具(虽然可以为项目服务)
- 不是 Agent 的对话 memory(那是 Mem0、Letta 等系统的范畴)
- 不是 autoresearch(本系统**描述**前沿,不**推进**前沿)
- 不是简单的 RAG 检索服务(synthesis 不是查询时拼出来的)

### 1.3 三种范式的有机组合

本系统融合三种范式,各司其职,任何一种失效都不会让系统崩溃,只会降级到下一种:

| 范式 | 在系统中的位置 | 承担什么 |
|------|--------------|---------|
| Karpathy 写入时综合 | synthesis 节点的生成 | 图书管理员预先思考好,持久存在 |
| OpenViking 结构边界 | 聚类 + 检索的边界 gate | 限定向量检索范围,避免跨域噪声 |
| 经典 RAG | 咨询员对开放查询的处理 | 在 raw 和 synthesis 上并行查找 |

**关键澄清**:raw 是权威答案源(对客观事实的查询),synthesis 是图书管理员的学习痕迹(对解读、综合、模式的查询),两者**地位平等**。检索时并行返回,LLM 在生成阶段自决怎么用。

### 1.4 九条设计原则

1. **逻辑/物理分离**:文件物理位置和语义身份完全解耦
2. **UUID 是身份**:位置可以变,身份不变;链接永远用 UUID
3. **写时轻提取,周期重整合**:实时操作只做必需元数据,深度处理留给周期任务
4. **内容树与操作树独立**:文件改动史和结构性操作史分别记录,只共享 UUID 命名空间
5. **Synthesis 响应真实工作,不做组合枚举**:伴随图书管理员的真实工作动作产生,不靠遍历
6. **聚类只对 raw 输入,synthesis 不参与聚类计算**:但 synthesis 通过 sources 派生出 cluster_id,可在 raw 缺 hub 时补位
7. **KB 描述前沿,不推进前沿**:KB 内任何操作都对自身闭环,不调外部世界
8. **三个维度概念正交**:视图级别(L0/L1)、节点类型(raw/synthesis)、索引数据结构(HNSW)是独立的事
9. **能力是平的,身份是叠加的**:所有 KB 能力通过 Tools 层暴露,Agent 通过被授予的 tool 子集获得能力

---

## 二 整体架构

```
                    ┌──────────────────┐
              人类 ⇄│   咨询员 Agent    │
                    └────────┬─────────┘
                             │ 通过 tools 调用
                             ▼
        ┌─────────────────────────────────────┐
        │           Tools Layer               │
        │  search / read / create / op_*      │
        │  flag / inspect_cluster / traverse  │
        └─────┬──────────────────────────┬────┘
              │                          │
              ▼                          ▼
┌──────────────────┐         ┌─────────────────────┐
│  视图层 SQLite   │         │   HNSW × 2 索引      │
│  nodes/clusters/ │         │   e_l0  / e_l1       │
│  op_log/query_log│         └─────────────────────┘
└────────┬─────────┘
         │
         ▼
┌────────────────────┐
│   内容存储          │
│  (markdown 平铺)    │
│  + content_git     │
└────────────────────┘

         ▲
         │
┌────────┴──────────────────────────┐
│      图书管理员 Agent              │
│   通过 tools 调用,有完整权限       │
│   on_ingest:新节点入库时           │
│   on_review:每周巡视               │
│   on_query:消化反馈队列            │
│   on_reflection:月度反思           │
└───────────────────────────────────┘
```

---

## 三 节点模型

### 3.1 三种 node_type

| 类型 | 用途 | 创建方式 | v1.0 状态 |
|------|------|---------|----------|
| `raw` | 原始知识录入 | 人类 / 咨询员 | 实施 |
| `synthesis` | 图书管理员的学习笔记 | 图书管理员触发生成 | 实施 |
| `reflection` | 元认知 / CoT(后续) | 任意 Agent | **v1.0 不创建**,但 schema 保留枚举值 |

### 3.2 通用 frontmatter schema

```yaml
---
uuid: "7c4f8a2b-9d3e-4f0a-b1c2-3d4e5f6a7b8c"
node_type: "raw"   # raw | synthesis | reflection
created_at: "2026-04-29T10:23:00.000Z"
updated_at: "2026-04-29T10:23:00.000Z"
created_by: "human:default"
created_by_run: "manual"

# 渐进式披露两层(L2 即 body 全文)
l0_summary: "一句话摘要,< 200 字符"
l1_overview: "结构化概览,< 2000 字符,包含核心论点 / 关键前提 / 证据 / 适用范围"

# 嵌入指针(由后台 worker 异步填充)
embeddings:
  e_l0_id: 1234         # 在 e_l0 HNSW 中的 internal id
  e_l1_id: 1234         # 在 e_l1 HNSW 中的 internal id
  model: "text-embedding-3-small"
  embedded_at: "2026-04-29T10:23:30.000Z"

# 关系
wikilinks: ["uuid_a", "uuid_b"]

# 当前视图位置(图书管理员维护,不构成身份)
current_path: "/cluster_5"

# 派生字段(每次聚类后重算)
derived_state:
  cluster_id: 5                # raw 直接来自 HDBSCAN;synthesis 来自 sources 分布计算
  cluster_membership_strength: 0.83   # 仅 raw 有
  is_cluster_hub: false
  hub_of_cluster: null

# 生命周期
lifecycle:
  status: "active"   # active | archived | superseded
  reference_count: 0
  last_accessed_at: null
  superseded_by: null
  superseded_reason: null
---

# 节点正文(L2 全文,作为权威真相档案)
节点的完整内容写在这里,可使用 [[uuid]] 引用其他节点。
```

### 3.3 raw 节点的额外字段

```yaml
hub_role:
  value: "center" | "leaf" | "neutral"   # 入库时 LLM 判断初始值
  source: "auto_detected" | "human" | "librarian"
  reason: "..."   # 简短判断理由
  history:        # 修改历史
    - changed_at: <ISO 8601>
      from: "neutral"
      to: "center"
      changed_by: "agent:librarian"
      op_id: <op_uuid>
      reason: "..."
```

**hub_role 是动态可变的字段**——入库时 LLM 给初始判断,后续图书管理员可以通过 `op_set_hub_role` 操作修改,所有变更进操作日志可追溯、可回滚。

### 3.4 synthesis 节点的额外字段

```yaml
synthesis_subtype: "consolidation"
# v1.0 实施:consolidation, cluster_review
# v1.1+ 扩展:annotation, question, association, meta

sources:
  - uuid: "raw_uuid_1"
    role: "primary"   # primary | supporting

trigger:
  type: "on_ingest"   # on_ingest | on_review | on_query | on_reflection
  evidence: { ... }   # 不同 trigger 对应不同 schema

quality:
  compactness_ratio: 0.28
  novelty_to_sources: 0.74
  self_rating: 4

cluster_when_created: 5   # 历史信息,创建时所属簇

# cluster_review 类型独有(见 §7.6)
review_payload: { ... }
validation_state: { ... }
```

**所有 synthesis 平级,不分 tier**。它们通过 sources 单向指向 raw,但**不会指向其他 synthesis**(避免链条爬升)。

### 3.5 标识与寻址

- **身份**:UUID v4,创建时分配,**永不变化**
- **物理路径**:`storage/<uuid 前 2 字符>/<uuid>.md`(纯粹为文件系统性能,无语义)
- **逻辑路径**(`current_path`):由视图层维护,可变
- **跨节点引用**:永远使用 UUID

---

## 四 存储与索引

### 4.1 物理存储

扁平目录,markdown 文件:

```
storage/
  ab/abcdef-1234-...md
  cd/cd9999-5678-...md
  ff/ff0011-9abc-...md
```

重组操作不动文件,只改视图层。文件内容修改触发该文件的 git commit。

### 4.2 嵌入策略(v1.3 简化版)

每节点两个嵌入,各司其职:

| 嵌入 | 输入 | 维度(默认) | 主要用途 |
|------|------|-----------|---------|
| e_l0 | l0_summary | 256 | 标题级快速判断、图谱节点 hover 显示、Agent 浏览目录的快速定位 |
| e_l1 | l1_overview | 768 | **主聚类、漂移检测、检索精排、synthesis 触发的相似度判断** |

**取消 e_l2**——理由:
- 全文长度差异巨大,嵌入质量不稳定
- 主流嵌入模型有 token 上限,长文本要分块、聚合,工程复杂
- 大部分操作在 L1 层做(L1 是工作记忆原则),e_l2 的实际价值不够支撑维护成本
- 需要全文级语义时,直接用 e_l1 找到节点后 LLM 读 L2 文本即可

嵌入由后台 worker 异步生成,新节点入库后入队列。

### 4.3 索引

- **向量索引**:两个独立 HNSW(`hnswlib-node`),M=16, efConstruction=200
- **视图层**:SQLite 单文件,主表对应 frontmatter,关系表存 wikilinks/sources
- **操作日志**:独立 SQLite 数据库(append-only),内容寻址

---

## 五 raw 与 synthesis 的图结构关系

### 5.1 两片半透明图层

```
┌─────────────────────────────────────────┐
│  Synthesis 图层(图书管理员的学习笔记)   │
│   ◇  ◇    ◇         ◇    ◇  ◇          │
│   不参与聚类输入计算                    │
│   通过 sources 单向指向 raw 图层         │
│   通过 sources 分布派生 cluster_id      │
└────────────┬─────┬─────┬────────────────┘
             ▼     ▼     ▼   单向引用
┌─────────────────────────────────────────┐
│  Raw 图层(原始知识 + 聚类结构)         │
│   ●●●●  ●●●●●  ●●●●●●  ●●●●            │
│   ╲簇1╱  ╲簇2╱  ╲ 簇3 ╱  ╲簇4╱          │
└─────────────────────────────────────────┘
```

### 5.2 关键规则

**Raw 图层**:
- 知识库的"主图":节点 + 边(wikilinks)+ 聚类结构
- HDBSCAN 聚类只输入 raw 节点的 e_l1
- raw 之间通过 wikilink 互引

**Synthesis 图层**:
- 图书管理员的学习痕迹层
- **不作为聚类算法的输入**(防止主观判断污染客观结构)
- **synthesis 之间不互引**(sources 字段只允许指向 raw,避免链条上升)
- 通过 sources 字段单向指向 raw 图层

**关键:派生而不是参与**

虽然 synthesis 不参与聚类**计算**,但它通过 sources 字段获得**派生的 cluster_id**:

- 当 sources 都集中在某簇 → cluster_id 设为该簇
- 当 sources 跨多簇 → cluster_id 设为 null,标记为"跨簇 synthesis"

这个 cluster_id 是**每次聚类后动态重算**的,不是固定字段。

### 5.3 这种设计解决了什么

**1. 跨簇 synthesis 问题被自然处理**
synthesis 不属于任何簇,只是"派生地关联"到簇。重聚类不影响 synthesis 的存在和内容,只更新它的派生 cluster_id 和 validation_state(对 cluster_review 而言)。

**2. synthesis 不会越长越深**
没有"synthesis 的 synthesis"机制。所有 synthesis 平等,都是对 raw 的直接学习痕迹。

**3. 检索时两边平等**
raw 和 synthesis 各有自己的 HNSW 索引(实际上共用 e_l1 索引,SQL filter 区分),查询时**并行检索**,LLM 在生成阶段自决怎么用。

### 5.4 两种"图视图"

系统中存在**两种图视图**,从同一份关系数据中派生:

- **聚类图视图**:只含 raw + raw 之间的 e_l1 嵌入边——HDBSCAN 在这个视图上跑
- **遍历图视图**:含 raw + synthesis + 所有关系(wikilinks + sources + 嵌入边)——多跳遍历在这个视图上跑

这不是两份物理数据,是同一份关系的不同投影,通过 view 层函数获取。

---

## 六 聚类机制

> 聚类只对 raw 节点输入计算。synthesis 不参与计算,但派生 cluster_id。

### 6.1 主聚类:UMAP 降维 + HDBSCAN

> ⚠️ **2026-05-11 之后过时**:UMAP+HDBSCAN 仍是月度全量重聚的算法,但对小 N(< 80)+ 高同质化场景常全 noise。**实际承担分簇主路径的是 LLM `coldStartCluster`(v1.4 两阶段 working_set 版本)**,见 `docs/handoff_2026_05_11.md` §2.1。`hdbscan.min_cluster_size` 现已自适应:`min(12, max(3, floor(N/8)))`。

**完整管道**:

```python
import umap, hdbscan, numpy as np

# 输入:N × 768 的 e_l1 嵌入矩阵(raw 节点)
embeddings = np.array([...])

# 第 1 步:UMAP 降维
reducer = umap.UMAP(
    n_neighbors=15, n_components=50,
    metric='cosine', min_dist=0.0, random_state=42
)
reduced = reducer.fit_transform(embeddings)

# 第 2 步:HDBSCAN 聚类
clusterer = hdbscan.HDBSCAN(
    min_cluster_size=12, min_samples=5,
    metric='euclidean',
    cluster_selection_method='eom'
)
labels = clusterer.fit_predict(reduced)
probabilities = clusterer.probabilities_
```

### 6.2 关键参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| umap.n_neighbors | 15 | 越大越保留全局结构 |
| umap.n_components | 50 | 经验值 30-50 都可以 |
| hdbscan.min_cluster_size | 12 | 决定"几个节点能成独立主题" |
| hdbscan.min_samples | 5 | 噪声敏感度,不轻易改 |
| cluster_selection_method | eom | 倾向选大簇,细分留给子结构判定 |

### 6.3 增量与全量

| 类型 | 频率 | 做法 |
|------|------|------|
| 增量归类 | 实时(新节点入库) | 新节点 e_l1 找 top-K 邻居 → ≥60% 在某簇则归入,否则标 unclustered |
| 全量重聚 | 月度任务 | UMAP+HDBSCAN 整体重跑,变化进操作日志 |

### 6.4 聚类后的 synthesis cluster_id 重算

每次聚类(增量或全量)完成后,跑一次 `SynthesisRoleRecomputation`:

```
对每个 active synthesis:
  统计其 sources 在各簇的分布
  if 所有 sources 都在同一簇 X:
    cluster_id = X
  else:
    cluster_id = null  # 跨簇

  if synthesis_subtype == 'cluster_review':
    重算 validation_state(见 §7.6)
```

这一步轻量,不需要 LLM 参与。

### 6.5 子结构判定

> ⚠️ **2026-05-11 之后过时**:本节描述的 k-means + silhouette 拆分提案**从未实施**。v1.4 working_set framing 下,子结构通过 hub_role=center anchor(sub-hub)在 working_set 内部表达,**不拆 cluster**。前端 `computeSubclusterAnchors` 把成员按 cosine 归到最近 sub-hub。详见 `docs/handoff_2026_05_11.md` §6.4。
>
> 代码里 `detectSubstructure` 函数还在,但只作为 diagnostic 接口,不参与自动决策。

每个簇周期性跑(原始 768 维 e_l1,**不用 UMAP 降维**):

```
对簇内 e_l1 跑 k-means(k = 2, 3, 4)
计算 silhouette score:
  silhouette > 0.5 且最大/最小子簇比 < 5:1 → 拆分提案
  silhouette ∈ [0.4, 0.5] → 标记弱结构,可触发 on_review
  silhouette < 0.4 → 不动
```

**关键**:不用绝对数量阈值。100 篇均质论文不拆,15 篇有强子结构则拆。

### 6.6 簇内漂移监控(语义漂移检测)

随着新成员持续加入簇,簇的真实语义重心可能逐渐偏离原中心,导致 cluster_review 当初的判断与当前数据分布脱节。本系统通过两个层次监控漂移:

**层次 1:cluster_review 的自证伪机制**(已在 §7.6 详述)

每次聚类后重算 cluster_review 的 validation_state——基于 sources 在当前簇分布的比例,分 confirmed / partially_drifted / mostly_drifted 三档。这是**认知层面**的漂移检测——它问的是"图书管理员当初的判断与当前数据是否一致"。

**层次 2:簇 centroid 的统计漂移监控**(v1.3 新增)

每周快照一次每个簇的 centroid + 协方差(基于 e_l1 嵌入)。跨周期对比:

```
对每个 active cluster:
  current_centroid = mean(member e_l1)
  current_covariance = cov(member e_l1)

  与上次 review 时的快照对比:
    centroid_shift = ||current_centroid - last_review_centroid||
    covariance_change = trace(current_cov - last_review_cov) / trace(last_review_cov)

  若 centroid_shift > shift_threshold (默认 0.15) 或
     covariance_change > variance_change_threshold (默认 0.30):
    标记簇为 drift_detected
    加入下次 on_review 的优先列表
```

这是**数学层面**的漂移检测——它问的是"簇的统计特征本身是否已经显著变化"。

**两层互补**:
- 认知层面捕捉"判断错位"——cluster_review 内容跟当前 sources 关系
- 数学层面捕捉"分布偏移"——簇的统计中心是否漂离原位
- 任一层触发都把簇推入 on_review 优先队列;两层同时触发是强信号,优先级最高

**实施提示**:协方差矩阵在 768 维空间是大对象,不要对每个簇存完整矩阵——存其 trace(对角线和)即可。trace 反映总方差大小,跨周期变化已足够检测漂移。

### 6.7 Hub 计算

> ⚠️ **2026-05-11 之后过时**:本节算法只是 fallback 路径。当前最高优先级是 LLM `cluster_review.hub_recommendation`(LLM 看完整 cluster 后的推荐)。`hub_source` 值集已细化为 `librarian_recommended` / `raw_lexical_fallback` / `synthesis_calculated` / `none` + 历史 `raw_explicit`。详见 `docs/handoff_2026_05_11.md` §2.4 + §6.5。

每次聚类完成后跑 hub 计算:

```
对每个簇:
  if 簇内有 raw 节点 hub_role.value == 'center':
    hub_uuid = 该 raw 的 uuid
    hub_source = 'raw_explicit'
  elif 簇内有 cluster_review subtype 的 synthesis 且其 cluster_id == 当前簇:
    hub_uuid = 该 synthesis 的 uuid
    hub_source = 'synthesis_calculated'
  else:
    hub_uuid = null
    hub_source = 'none'
```

**raw hub 优先级显式高于 synthesis hub**(事实优于判断,这是一直坚持的"raw 是权威"原则的具体体现)。

**只有 cluster_review 这种 subtype 的 synthesis 有 hub 补位资格**——其他 subtype(consolidation 等)即使 sources 全在簇内,也不补位 hub。理由:cluster_review 显式做了"对簇结构的判断",其他 subtype 只是"对内容的思考"。

---

## 七 Synthesis 规范

### 7.1 六种 subtype(v1.0 实施 2 个,其他延后)

| subtype | 性质 | v1.0 状态 |
|---------|------|----------|
| **consolidation** | 综合多个 raw 的内容判断 | 实施 |
| **cluster_review** | 对一个簇的结构判断,带自证伪 | 实施 |
| annotation | 对单个或少量内容的评注 | 延后 v1.1+ |
| question | 识别的 knowledge gap | 延后 v1.1+ |
| association | 跨 raw 的联想式连接 | 延后 v1.1+ |
| meta | 关于 KB 自身状态的元反思 | 延后 v1.1+ |

### 7.2 四个触发器

新触发器范式:**伴随图书管理员的真实工作动作产生,不靠外部信号枚举**。

| 触发器 | 触发时机 | 主要产出 subtype | 周期 |
|-------|---------|----------------|------|
| **on_ingest** | 新 raw 节点入库,LLM 阅读后产生学习痕迹 | consolidation | 实时(异步) |
| **on_review** | 每周主动巡视满足条件的簇 | cluster_review,有时 consolidation | 每周 |
| **on_query** | 咨询员消化 flag 队列时 | 视情况 | 触发后处理 |
| **on_reflection** | 月度元反思 | meta(v1.1+) | 每月 |

#### on_ingest 触发逻辑

新 raw 节点入库后,经过两步思维链摄入:

**第一步:分析**

LLM 阅读新节点 + top-K 嵌入邻居,产出结构化分析:
- 这篇的核心论点
- 与现有内容的关联
- 与现有知识的矛盾或张力
- hub_role 初始值的判断(center/leaf/neutral)

**第二步:可选生成 synthesis**

LLM 决定是否产出 synthesis(可以不产出)。如产出:
- subtype 通常是 consolidation
- sources 是新文档 + 它的语义近邻(**不严格要求 intra-cluster**,因为聚类还在演化)
- 产出后等聚类完成,cluster_id 自动派生

**特例**:on_ingest 不严格要求 intra-cluster,这是与其他三个触发器的区别。

#### on_review 触发逻辑

每周一次,满足条件的簇被巡视:

```
本周需 review 的簇 = 满足以下任一条件的簇:
  - 过去 7 天有新节点加入
  - 过去 7 天有累积的 cluster_friction(咨询员标记的反馈)
  - 距离上次 review 超过 N 周(防止冷落,N 默认 4)

不 review 的簇:
  - 已 archived
  - 上述条件全不满足

每周最多 review 3 个簇(预算控制)
按"最值得 review"排序(friction_count + 新节点数加权)
```

巡视时对每个簇产出 0-1 份 cluster_review(不强制每次都产),以及可能的 consolidation(发现的内容综合)。

#### on_query 触发逻辑(咨询员的反馈处理)

咨询员有两个 flag tool:

```
flag_specific_issue(target_uuid, issue_type, description)
  → 推送到图书管理员的"具体问题队列"
  → 适合明确、可定位的问题(L1 写得不准、cluster_review 跟用户反馈矛盾等)

flag_cluster_friction(cluster_id, description)
  → 累加到 clusters 表的 friction_count
  → 适合趋势性、整体的问题(用户在某簇反复查得不顺)
  → 影响下次 on_review 的优先级
```

图书管理员在 background pass 或下次 on_review 时消化这些 flag。

**关键边界**:咨询员只能 flag,不能直接修改 KB 结构。所有结构修改走图书管理员。

#### on_reflection 触发逻辑(v1.1+)

月度任务,产出 meta subtype synthesis(v1.0 不实施)。

### 7.3 前置闸门

每个候选 synthesis 必须穿过:

| 闸门 | 检查 | 失败处理 |
|------|------|---------|
| P1 去重 | 相同 sources 集合是否已有 active synthesis | 跳过(若有 archived 同源,允许重试,标 previously_archived) |
| P2 源成熟度 | source 必须是 active raw | 该 source 剔出候选 |
| P3 周期预算 | 本周期已生成 < 上限 | 推送下一周期队列 |

预算:on_ingest 每节点最多 K=2 个 synthesis;on_review 每个簇最多 1 个 cluster_review + 1 个 consolidation。

### 7.4 后置闸门(按 subtype 分化)

#### consolidation

| 闸门 | 阈值 |
|------|------|
| Q1 紧凑度 | synthesis_tokens / sum(source_l1_tokens) < 0.4 通过,> 0.6 拒绝 |
| Q2 引用完整性 | body 中每个论断必有 [[uuid]] 或 joint_inference 标记 |
| Q3 单源相似度 | max(cos_sim(synthesis, source_l1)) < 0.9 |
| Q4 自评分 | self_rating ≥ 3 |

#### cluster_review

| 闸门 | 阈值 |
|------|------|
| Q1' 判断明确性 | review_payload.review_judgments 至少一条 confidence ≥ medium |
| Q2 引用完整性 | 同上 |
| Q4 自评分 | self_rating ≥ 3 |

(Q1 紧凑度和 Q3 单源相似度不适用 cluster_review,因为它的内容性质不同)

### 7.5 Body 三段式(consolidation 用)

```markdown
## 关键洞察
<核心论断,纯散文,100-400 字>

## 论证
- <论断 1> ← [[source_uuid]]
- <论断 2> ← [[source_uuid_a]] + [[source_uuid_b]] (joint_inference)
- ...

## 边界与未知
<本 synthesis 不主张什么 / 不确定的地方 / 何种新证据会推翻它>
```

**第三段强制存在**——给未来的自我证伪和 contradiction 检测留 hook。

### 7.6 cluster_review 详细规范

#### 内容结构(body 格式)

```markdown
## 簇身份判断
<这个簇主要讨论什么主题、它的核心特征>

## 成员评估
- 成员判断 1:[[uuid]] 应该留在簇内,因为...
- 成员判断 2:[[uuid]] 实际属于其他领域,建议移出
- ...

## 结构判断
- 提议的 hub:[[uuid]] 或 self
- 子结构观察:是否有内部分化趋势

## 边界与未知
<这份判断的确信度边界、何种变化会让它失效>
```

#### 专属 frontmatter 字段

```yaml
review_payload:
  reviewed_cluster_id: 5
  reviewed_at_state:
    member_count: 12
    member_uuids: [...]
    centroid_e_l1_hash: <hash>

  review_judgments:
    - claim: "这个簇主要讨论 transformer 优化"
      confidence: high
    - claim: "成员 D 应该被移出去,因为它实际在讨论 RNN"
      proposed_action: move_out
      target_uuid: <D_uuid>
      confidence: medium

  hub_recommendation:
    proposed_hub_uuid: <某 raw 或 self>
    reasoning: "..."

# 链式继承(若有前任 cluster_review)
inheritance:
  previous_cluster_review_uuid: <被 superseded 的那份的 uuid>
  inheritance_decision: "kept" | "modified" | "reversed"
  inheritance_reason: "..."

# 自证伪追踪(每次重聚类后重算)
validation_state:
  last_validated_at: <ISO 8601>
  current_sources_distribution: {5: 4, 7: 1}
  primary_concentration: 0.8
  validation_status: "confirmed" | "partially_drifted" | "mostly_drifted"
```

#### 简化版三档自证伪

每次聚类(增量或全量)完成后,对每个 active cluster_review 重算:

```
sources 在原 reviewed_cluster_id 中的比例 = primary_concentration
  ≥ 0.8 → confirmed
  0.5 - 0.8 → partially_drifted (flag 给图书管理员关注,不立即触发重生成)
  < 0.5 → mostly_drifted (强烈建议下次 on_review 重新生成)
```

#### 与簇生命周期的紧密绑定

| 操作 | 对 cluster_review 的影响 |
|------|------------------------|
| op_split(簇 X → X1, X2) | 原 review for X 立即 superseded;**立即触发为 X1 和 X2 各生成新 cluster_review**(在该 op 完成后的 background pass 中执行) |
| op_merge(簇 X, Y → Z) | 原两份 review 立即 superseded;**立即触发为 Z 生成新 cluster_review** |
| op_move(节点 D 从 X 移到 Y) | 触发 X 和 Y 的 cluster_review 重算 validation_state;状态变化大才 flag,不立即重生成 |
| op_archive(归档某节点) | 同 op_move,只重算 validation_state |

**为什么大改动立即重生成,小改动只标记**:
- split/merge 是**簇身份变更**,旧 review 谈论的对象已经不存在,不重生成等于让 KB 里有"无对象"的判断
- move 是**簇内成员变化**,簇本身还在,旧 review 的判断可能仍然成立

#### 链式继承机制

cluster_review 重生成时,**新 review 的 frontmatter 中 inheritance 字段引用前任 uuid**,body 中说明:

- 我继承了前任的什么判断
- 我修改了什么
- 我为什么这样改

这让 cluster_review 形成一条**判断演化链**——每次重生成都是"基于前任做出的调整",不是孤立的从零判断。**这是 KB 沉淀"对自身组织方式的演化判断"的机制**。

#### cluster_review 不参与对用户的检索

cluster_review 是图书管理员的"对系统结构的元判断",对普通用户查询没有直接价值。

具体实现:

- 普通 `search_knowledge` tool 在 SQL filter 中加 `subtype != 'cluster_review'`
- 专用 `inspect_cluster` tool 返回某簇的 cluster_review + 成员列表 + hub 信息
- 前端"知识图谱面板"点击某簇时显示对应 cluster_review

### 7.7 Subtype 与触发器对应关系

| 触发器 | 主要产出的 subtype |
|-------|------------------|
| on_ingest | consolidation(主要),annotation(v1.1+) |
| on_review | cluster_review(主要),consolidation,pattern(在 association v1.1+ 中) |
| on_query | 视 flag 性质而定 |
| on_reflection | meta(v1.1+ only) |

---

## 八 图书管理员 Agent

### 8.1 三个周期 + 一个事件驱动

| 周期 | 频率 | 工作内容 |
|------|------|---------|
| 实时(事件驱动) | 新节点入库后 | on_ingest:两步思维链,可能产出 synthesis |
| 周 | 每周 | on_review:巡视满足条件的簇;消化 cluster_friction;子结构判定;漂移检测 |
| 月 | 每月 | 全局 UMAP+HDBSCAN 重聚类;长期 unclustered 节点处理;失效 synthesis 归档;on_reflection(v1.1+) |
| Background pass | 持续 | 消化 specific_issue 队列;cluster_review 链式重生成 |

### 8.2 工作分层

| 对象 | 维护动作 |
|------|---------|
| Raw 节点 | 聚类、归档、dedupe、合并相似节点、调整 hub_role |
| Synthesis 节点 | 触发器扫描后生成、冗余检测后归档、源失效后标记 superseded |
| 簇结构 | 子结构判定、拆分提案、漂移检测、hub 重计算 |
| cluster_review | 跟随簇生命周期变化重生成,链式继承 |

### 8.3 输出原则

**所有结构性操作必须经过操作日志,带 reason 字段**。这强制图书管理员说明决策依据——既是审计,也是后期分析其策略并训练更好版本的数据来源。

---

## 九 咨询员 Agent

### 9.1 角色

唯一人类接口,接受:

- 自然语言提问(主要功能)
- 知识录入请求(粘贴 / 上传内容)
- 显式 synthesis 调用(很少使用)

**不直接编辑结构**,所有结构性变化都路由给图书管理员的下一周期任务。

咨询员可调用的 flag tool:

- `flag_specific_issue(uuid, issue_type, description)` — 推送到具体问题队列
- `flag_cluster_friction(cluster_id, description)` — 累加到簇的 friction_count

### 9.2 核心检索原则

**raw 和 synthesis 是平等的检索对象**。

- raw = 原始资料、客观事实
- synthesis(consolidation 等)= 图书管理员的学习笔记
- cluster_review = 元判断,**不参与普通检索**
- 两者各有自己的索引(实际上共用 e_l1 但 SQL filter 区分),**查询时并行检索**
- 没有"先 synthesis 后 raw"的优先级,LLM 在生成时自决

### 9.3 三阶段检索流程

```
用户提问
    │
    ▼
┌───────────────────────────────────────────┐
│  阶段 1:并行检索(raw 和 synthesis)        │
│   - query embedding 同时查 raw 和          │
│     synthesis(filter cluster_review)      │
│   - 两路结果合并,按相关度排序              │
└─────────────────┬─────────────────────────┘
                  │
                  ▼
┌───────────────────────────────────────────┐
│  阶段 2:多簇边界扩展(可选)                │
│   - 找候选 raw 所在的 top-K 个簇            │
│     (默认 K=3,不只用 top-1 命中簇)         │
│   - 每个簇内补充其他高分 raw                │
│   - 这是 OpenViking 风格的"边界 gate"       │
│   - 多簇扩展防止"漏斗截断":                │
│     即使主命中簇是错的,次命中簇能补救       │
│   - synthesis 不参与扩展(不直接属于簇)    │
└─────────────────┬─────────────────────────┘
                  │
                  ▼
┌───────────────────────────────────────────┐
│  阶段 3:LLM 生成                           │
│   - 默认用 L1 拼 context(L1 是工作记忆)   │
│   - 必要时升级到 L2(read_full tool)       │
│   - 在 prompt 里清楚标注每段的来源类型      │
│     (raw 是事实,synthesis 是判断)         │
│   - LLM 生成回答,自决怎么用每条信息        │
└───────────────────────────────────────────┘
```

### 9.4 多簇扩展的工作机制

阶段 2 的多簇扩展是 v1.3 针对"漏斗截断风险"的关键改进。

**问题**:如果阶段 1 raw 命中的 top-1 簇恰好是错的(用户查询用词跟某个错误主题更接近),阶段 2 只在错误簇内扩展,会彻底丢失正确簇里的相关 raw。

**解法**:阶段 2 不限制在 top-1 命中簇,而是在 top-K 命中簇内分别扩展。

**具体逻辑**:

```
阶段 1 返回的 raw 候选 → 统计这些 raw 所属的 cluster_id
按命中频次排序,取 top-K 个簇(默认 K=3)
对每个簇:
  在簇内 raw 中,用 query embedding 找 top-N 高分 raw(N=5)
  合并到候选集
去重后进入阶段 3
```

**参数**:
- `expansion_top_k_clusters`:扩展的簇数(默认 3,可调)
- `expansion_per_cluster`:每簇扩展数(默认 5)

这个机制的代价很小(多查几次 HNSW),但能显著降低单一簇命中错误导致的召回失败。代价不超过纯 RAG 的几倍 HNSW 查询时间。

### 9.5 L1 升级到 L2 的机制

默认用 L1 拼 context,LLM 在以下情况调用 `read_full(uuid)` tool 升级:

- 用户问的是非常具体的细节(具体数字、具体引文)
- 综合时遇到 L1 之间看似矛盾,可能是 L1 写得不准导致的
- 高 stakes 内容(法律、医疗、合同)

**升级是少数情况,不是常规**。

### 9.6 查询日志

```yaml
query_id: <uuid>
timestamp: <ISO 8601>
queried_by: consultant | librarian | external:<id>
query_text: <用户原文>
raw_hits: [<uuid>, ...]
synthesis_hits: [<uuid>, ...]      # 不含 cluster_review
raw_after_expansion: [<uuid>, ...]
final_used: [<uuid>, ...]
flagged_issues: [<flag_id>, ...]   # 如咨询员触发了 flag
answer_adopted: bool
```

---

## 十 操作日志与回滚

### 10.1 独立 git 树

只追加,不可篡改。和文件改动 git 不同,这棵树记录**结构性操作**——内容树和操作树通过 UUID 命名空间共享对象,但**没有反向引用**。

### 10.2 操作类型(v1.0 收敛)

```
move(uuid, from_path, to_path, reason)
merge(folder_a, folder_b, into_path, reason)
split(folder, into_subfolders[], reason)
promote(uuid, to_hub_path, reason)
demote(folder, to_uuid, reason)
rewrite_summary(uuid, level, old, new, reason)
extract(source_uuids[], new_uuid, content, reason)
dedupe(uuid_a, uuid_b, kept_uuid, reason)

# v1.3 新增
set_hub_role(uuid, from_value, to_value, reason)
revert(target_op_id, reason)
```

每条操作记录字段:

```yaml
op_id: <uuid>
timestamp: <ISO 8601>
agent_run_id: <run_id>
agent_id: librarian | external:<id>
type: <op_type>
args: { ... }
reason: <强制,LLM 必须给出>
before_view_hash: <sha256>
after_view_hash: <sha256>
affected_uuids: [<uuid>, ...]
reverted_by: <op_id> | null
branch_name: "main"
```

### 10.3 能力

- `log` — 列出某段时间所有操作
- `diff <op_id>` — 显示该操作前后视图层差异
- `revert <op_id>` — 单个操作回滚(A 方案,拒绝级联)
- `branch` — 让图书管理员在分支上做激进重组,不影响主干
- `blame <uuid>` — 显示某节点经历的所有结构性变化和原因

### 10.4 与 cluster_review 的联动

操作类型与 cluster_review 重生成的对应关系:

| 操作 | cluster_review 处理 |
|------|-------------------|
| op_split | 原 review superseded;新簇立即触发新 review 生成(进 background queue) |
| op_merge | 原 reviews superseded;新簇立即触发新 review 生成 |
| op_move | 重算 validation_state;变化显著时 flag |
| op_archive | 重算 validation_state |
| op_set_hub_role | 不直接影响 cluster_review,但下次 on_review 时考虑 |

---

## 十一 Tools 层

### 11.1 角色

**所有 KB 能力通过 Tools 层暴露**。任何 Agent(咨询员、图书管理员、未来的外部 Agent)都通过同一组 tools 工作。差异只在被授予的 tool 子集和身份(用于审计)。

### 11.2 Tool 分类(按权限标签)

#### 读取类(`permission: read`)

```
search_knowledge(query, k_raw, k_synthesis)
  返回:{ raw: NodeBrief[], synthesis: NodeBrief[] }
  不返回 cluster_review

read_node(uuid, include_body)
  返回完整 Node

read_full(uuid)
  专门用于 L1 → L2 升级,返回 body 全文

list_nodes(filters)
get_cluster_info(cluster_id)
get_op_log(filters)
get_query_log(filters)
inspect_cluster(cluster_id)
  专用 tool,返回该簇的 cluster_review + 成员 + hub
traverse_graph(start_uuid, max_hops, filters)
  多跳遍历,在 raw + synthesis 的遍历图视图上跑
find_path(from_uuid, to_uuid, max_hops)
```

#### 写入类(`permission: write`)

```
create_raw_node(body, l0_summary, l1_overview, ...)
update_node_content(uuid, new_body, reason)
archive_node(uuid, reason)

flag_specific_issue(target_uuid, issue_type, description)
flag_cluster_friction(cluster_id, description)
```

#### 结构性操作类(`permission: structural`)

```
op_move / op_merge / op_split / op_promote / op_demote
op_rewrite_summary / op_extract / op_dedupe
op_set_hub_role
synthesize_explicit(source_uuids, instruction, subtype_hint, reason)
```

#### 回滚类(`permission: admin`)

```
revert_op(op_id, reason)
create_branch(branch_name, reason)
switch_branch(branch_name)
merge_branch(from_branch, reason)
blame_node(uuid)
```

### 11.3 角色到权限的映射

| Agent | 权限 | 可调用的 tools |
|-------|------|--------------|
| 咨询员 | read + write | 读取类全部 + create_raw_node + flag_* |
| 图书管理员 | read + write + structural + admin | 全部 |
| 外部 Agent | 按授予 | 视具体授权而定 |

### 11.4 Agent 接入端点(v1.0 实现)

```
POST /api/agent/invoke
  body: { agent_id, api_key, tool_name, args }

POST /api/agent/list_tools
  body: { agent_id, api_key }
  返回该 Agent 可见的 tool 列表(OpenAI tool calling 格式)
```

---

## 十二 实施路线图

### v1.0 范围(确认)

**框架级**(不会再变):
- 内容存储 + UUID 寻址 + 视图层
- 多向量嵌入(e_l0, e_l1)+ HNSW 索引
- HDBSCAN+UMAP 主聚类 + 子结构判定
- 咨询员 Agent + 三面板前端
- 知识录入(单文件 + 批量 markdown)
- 操作日志(完整记录 + revert 简版)
- Tools 层统一接口
- 多 Agent 接入端点
- 多跳遍历 tool

**Synthesis subtype**:
- consolidation(完整管道)
- cluster_review(完整管道 + 自证伪 + 链式继承 + hub 补位资格)

**触发器**:
- on_ingest(完整)
- on_review(完整)
- on_query(完整,通过 flag 机制)

### v1.1+ 延后

- annotation / question / association / meta subtypes
- on_reflection 触发器
- 操作日志 branch / blame 完整 UI
- reflection 节点类型完整规范
- 操作日志数据分析驱动的策略学习

### 暂不做

- 参数自适应调优
- 多用户 namespace

---

## 十三 已知开放问题

1. **后置闸门 Q4(自评分)的可信度** — LLM 自评偏松,后续考虑独立评审 Agent
2. **触发器具体阈值调优** — 7 天 / 3 次 / 0.8 等数字需要真实数据验证
3. **嵌入模型升级路径** — 升级时全量重嵌入的成本和兼容
4. **多用户场景** — namespace、权限、merge conflict 语义
5. **cluster_review 重生成的成本** — 频繁的 split/merge 可能导致 LLM 调用密集,需要观察
6. **Synthesis 之间的隐式关联是否够用** — 目前只通过共享 sources 形成隐式关联,无显式互引
7. **图书管理员的策略可学习性** — 长期目标,基于操作日志的 reason 字段做训练

---

## 附录 A:技术栈

| 组件 | 选型 |
|------|------|
| 内容存储 | 文件系统 + markdown |
| 视图层 | SQLite (better-sqlite3) |
| 向量索引 | hnswlib-node |
| 嵌入模型 | OpenAI 兼容 API(GLM / DeepSeek 等) |
| LLM | OpenAI 兼容 API |
| 聚类 | Python 子进程(umap-learn + hdbscan) |
| 操作日志 | SQLite + 周期 git tag |
| 后端 | TypeScript + Express + WebSocket |
| 前端 | React + Vite + Zustand + Tailwind |
| 图谱可视化 | react-force-graph-2d / sigma.js |
| 运行时 | Tauri v2(本地桌面)|

## 附录 B:核心术语

| 术语 | 含义 |
|------|------|
| node | 知识库中任意节点 |
| raw | 原始知识节点(权威答案源) |
| synthesis | 图书管理员的学习痕迹节点(辅助) |
| subtype | synthesis 的子类(consolidation, cluster_review, ...) |
| cluster_review | 对一个簇的结构判断类 synthesis |
| L0/L1/L2 | 节点的视图级别(摘要/概览/全文) |
| hub_role | raw 节点的中心性属性(center/leaf/neutral) |
| cluster_id | 节点的派生簇归属(raw 直接,synthesis 通过 sources 派生) |
| view layer | 视图层,描述当前节点位置和元数据的派生表 |
| operation log | 操作日志,记录所有结构性操作的独立 git 树 |
| Tools layer | 统一能力接口层,所有 Agent 通过它访问 KB |

## 附录 C:与同类系统的关系

| 借鉴 | 来源 | 在系统中的位置 |
|------|------|--------------|
| L0/L1 视图级别 | OpenViking | §3.2 frontmatter |
| 文件系统范式 + UUID 寻址 | Letta MemFS | §4.1 |
| 结构边界 + 边界内向量精化 | OpenViking | §6 聚类 + §9 检索阶段 2 |
| 写入时综合(synthesis 持久产物) | Karpathy LLM Wiki | §7 synthesis 生成 |
| Sleep-time consolidation | Letta sleep-time compute | §8 周期任务 |
| HDBSCAN+UMAP 嵌入聚类 | 工业标准组合 | §6 |
| HNSW 数据结构 | Malkov & Yashunin | §4.3 仅作向量索引 |
| 客观结构与主观判断分工 | 本设计独有 | §6 聚类 + §7.6 cluster_review |
| 双 git 树独立(内容/操作) | 本设计独有 | §10 |
| 学习者范式(synthesis = 学习笔记) | 本设计独有 | §1.3, §7 |
| 链式继承的 cluster_review | 本设计独有 | §7.6 |

**与三种主流范式的关系**:

- **vs 经典 RAG**:RAG 在本系统里只承担"咨询员对开放查询的初次定位",不承担"知识综合"——综合是 synthesis 早已写好的
- **vs Karpathy LLM Wiki**:继承 compile-once 哲学,但 synthesis 不代替 raw 当用户答案;synthesis 是图书管理员的学习痕迹,与 raw 平等被检索
- **vs OpenViking**:借用其"结构边界 + 边界内向量"思想,但**结构(聚类)是动态由数据生成的**,而不是手工组织的目录;同时保留 OpenViking 的 L0/L1 视图级别
- **vs Microsoft GraphRAG**:借鉴层次社区思想,但**有意不抄它的多层 Tier**——synthesis 单层、平等、不形成金字塔

**最重要的差异化定位**:

> 主流系统(Mem0、Letta、Zep)把记忆视为"Agent 的笔记本"——记忆为 Agent 服务,跟着 Agent 生死。
> 腾讯 ima 把知识视为"用户的资料管家"——查询时 RAG 拼答案,KB 自身不演化。
> Karpathy LLM Wiki 把知识视为"被预先编译的 wiki"——LLM 是程序员,wiki 是代码库,用户读 wiki 不读原文。
>
> **本系统把知识视为"图书馆 + 馆员的学习笔记"**——
> raw 是馆藏资料,synthesis 是馆员阅读时留下的学习痕迹。
> 馆藏永远是权威,笔记是有用的辅助。
> 任何 Agent 来都能查阅,任何操作都被审计,馆员的工作可被回滚。
> 馆员工作越多越有心得,这些心得通过 cluster_review 的链式继承被显式保存。

---

## 附录 D:框架稳定性承诺

以下九条是 v1.3 的**框架级决定**,后续不会再变(除非实施时撞到明显问题才停下来重新讨论):

1. 节点模型:UUID 寻址、L0/L1 视图、frontmatter + body
2. 图结构隔离原则:聚类只对 raw 跑,synthesis 通过 sources 单向指向 raw
3. 聚类机制:UMAP + HDBSCAN 在 e_l1 嵌入空间,增量 + 月度全量
4. 存储与索引:文件平铺 + UUID 命名;两个 HNSW 索引;SQLite 视图层
5. 操作日志独立:文件 git 和操作日志双轨,UUID 命名空间共享
6. Tools 层统一接口:所有能力通过 tools 暴露,Agent 能力面相同
7. 三阶段检索:目录定位 → 簇内并行 → RAG 精排
8. Agent 角色边界:咨询员只读 + 录入,图书管理员可改结构,所有结构改动经操作日志
9. L1 是工作记忆原则:大部分阅读在 L1 层,L2 全文是档案

字段级和行为级的细节(具体阈值、prompt 措辞、UI 表现等)在实施过程中可能微调,但不影响这九条框架。

---

**文档结束**

下一步:基于 v1.3 进入 Phase 1 实现。

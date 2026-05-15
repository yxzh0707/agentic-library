# Knowledge Base v1.0 实施任务书

**目标读者**:Claude Code(或类似的代码生成 Agent)
**项目目标**:实现一个本地部署的、面向 Agent 的、自组织的知识库系统
**配套文档**:`knowledge_base_v1.2_design.md`(本文档是其实施版,有冲突以本文档为准)
**技术栈**:全栈 TypeScript
**部署形态**:Mac 本地单机应用

---

## 〇 阅读说明

本任务书按"先理解整体 → 再分模块实现 → 最后联调"的顺序组织。Claude Code 实施时建议:

1. 先完整读完 §1-§3,理解项目骨架和数据模型
2. 然后按 §10 的任务序列**严格按顺序**实现,每完成一个里程碑用 §11 的方法验证
3. 实施过程中遇到设计模糊的地方,先看 §12 坑点提示;还不能解决的标注 `// TBD: <问题>` 暂时跳过
4. **不要**自作主张扩展功能,严格执行任务书内的范围

---

## 一 项目总体架构

### 1.1 顶层模块

```
knowledge-base/
├── packages/
│   ├── core/              # 后端核心:存储、索引、聚类、Agent
│   ├── frontend/          # React 前端:三面板 UI
│   └── shared/            # 前后端共享类型、常量
├── data/                  # 用户数据(运行时生成,不进 git)
│   └── (用户首次运行时由前端引导选择 ~/Downloads/kb_<name>/)
├── package.json           # workspace root
├── tsconfig.base.json
└── README.md
```

使用 **pnpm workspace** 管理 monorepo。

### 1.2 后端架构(packages/core)

```
core/
├── src/
│   ├── storage/           # 文件系统 + SQLite 视图层
│   ├── embedding/         # 嵌入服务(OpenAI 兼容)
│   ├── indexing/          # HNSW 索引管理
│   ├── clustering/        # UMAP + HDBSCAN
│   ├── synthesis/         # synthesis 触发器、生成管道、闸门
│   ├── tools/             # ⭐ Agent-callable tools 层(核心)
│   ├── agents/            # 咨询员、图书管理员
│   ├── scheduler/         # 启动追赶 + cron 调度
│   ├── op_log/            # 操作日志
│   ├── server/            # HTTP 服务(本地 localhost)
│   └── index.ts           # 启动入口
├── package.json
└── tsconfig.json
```

### 1.3 前端架构(packages/frontend)

```
frontend/
├── src/
│   ├── panels/
│   │   ├── ChatPanel/         # 聊天面板(咨询员对话)
│   │   ├── VisualizationPanel/  # 图谱、聚类、操作日志可视化
│   │   └── DashboardPanel/    # 节点列表、参数面板、状态总览
│   ├── components/        # 通用组件
│   ├── api/               # 与后端通信
│   ├── stores/            # 状态管理(Zustand)
│   ├── App.tsx
│   └── main.tsx
├── package.json
└── vite.config.ts
```

### 1.4 关键架构原则(实施时反复确认)

1. **逻辑/物理分离**:文件物理位置由 UUID 决定,与语义身份无关
2. **所有 KB 能力都通过 tools 层暴露**:Agent 不直接调底层模块,统一通过 tool 调用
3. **Synthesis 与 raw 图结构隔离**:聚类只对 raw 跑,synthesis 通过 sources 单向指向 raw
4. **操作日志双轨**:文件内容改动走单文件 git,结构性操作走独立操作日志
5. **三面板独立**:前端三个面板状态独立,通过 store 统一同步

---

## 二 数据模型

### 2.1 文件系统布局

用户数据目录(用户首次运行选择,默认 `~/Downloads/kb_<projectname>/`):

```
kb_<projectname>/
├── content/               # 节点内容(扁平存储)
│   ├── ab/
│   │   ├── ab12cdef-....md
│   │   └── ab98xxxx-....md
│   ├── cd/
│   └── ff/
├── content_git/           # 内容文件的 git 仓库(.git 在这里)
│                          # 跟踪每个 markdown 文件的内容修改史
├── indices/               # HNSW 索引文件
│   ├── e_l0.hnsw
│   ├── e_l1.hnsw
│   └── e_l2.hnsw
├── kb.sqlite              # 视图层 + 操作日志 + query log
├── config.json            # 用户配置(API key、模型选择等)
└── kb.lock                # 进程锁,防止多开
```

UUID 取前 2 字符作为子目录,平衡文件系统性能和可读性。

### 2.2 节点 frontmatter schema

每个 markdown 文件的开头是 YAML frontmatter:

```yaml
---
uuid: "7c4f8a2b-9d3e-4f0a-b1c2-3d4e5f6a7b8c"
node_type: "raw"  # raw | synthesis | reflection (reflection v1.0 不创建,仅保留枚举值)
created_at: "2026-04-27T10:23:00.000Z"
updated_at: "2026-04-27T10:23:00.000Z"
created_by: "human:default"  # human:<id> | agent:<id>
created_by_run: "manual"

# 渐进式披露三层
l0_summary: "一句话摘要,不超过 200 字符"
l1_overview: "一段概览,不超过 2000 字符"
# l2 即 body 全文

# 嵌入指针
embeddings:
  e_l0_id: 1234         # 在 e_l0 HNSW 中的 internal id
  e_l1_id: 1234
  e_l2_id: 1234
  model: "text-embedding-3-small"
  embedded_at: "2026-04-27T10:23:30.000Z"

# 关系
wikilinks: ["uuid_a", "uuid_b"]

# 当前视图位置(图书管理员维护,不构成身份)
current_path: "/cluster_5"  # 单 raw:所属簇路径;synthesis:在 synthesis_cluster 路径下

# 生命周期
lifecycle:
  status: "active"  # active | archived | superseded
  reference_count: 0
  last_accessed_at: null
  superseded_by: null
  superseded_reason: null
---

# 节点正文(L2)
节点的完整内容写在这里,可使用 [[uuid]] 引用其他节点。
```

### 2.3 synthesis 节点的额外字段

```yaml
synthesis_subtype: "comparison"  # comparison | pattern | edge_observation | research_direction
sources:
  - uuid: "raw_uuid_1"
    role: "primary"  # primary | supporting
  - uuid: "raw_uuid_2"
    role: "supporting"
trigger:
  type: "co_retrieval"  # co_retrieval | drift | substructure | explicit
  evidence:
    co_occurrence_count: 5
    distinct_query_sources: 3
    time_window_days: 7
quality:
  compactness_ratio: 0.28
  novelty_to_sources: 0.74
  self_rating: 4
cluster_when_created: 7  # 创建时所属簇 id,历史信息
```

**注意**:synthesis 节点没有 `tier`、`layer`、`meta_sources` 字段。所有 synthesis 平级。

### 2.4 SQLite Schema(视图层 + 操作日志)

```sql
-- ========== 视图层 ==========

-- 节点主表(从 frontmatter 派生,加速查询)
CREATE TABLE nodes (
  uuid TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,  -- 'raw' | 'synthesis' | 'reflection'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_run TEXT,
  l0_summary TEXT,
  l1_overview TEXT,
  current_path TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived' | 'superseded'
  reference_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  superseded_by TEXT,
  cluster_id INTEGER,  -- raw 节点所属簇 id;synthesis 节点 NULL
  cluster_membership_strength REAL,  -- HDBSCAN probability
  -- synthesis 专属字段
  synthesis_subtype TEXT,
  trigger_type TEXT,
  cluster_when_created INTEGER,
  compactness_ratio REAL,
  novelty_to_sources REAL,
  self_rating INTEGER,
  -- 嵌入指针
  e_l0_id INTEGER,
  e_l1_id INTEGER,
  e_l2_id INTEGER,
  embedding_model TEXT,
  embedded_at TEXT,
  FOREIGN KEY (superseded_by) REFERENCES nodes(uuid)
);

CREATE INDEX idx_nodes_type ON nodes(node_type);
CREATE INDEX idx_nodes_cluster ON nodes(cluster_id);
CREATE INDEX idx_nodes_status ON nodes(status);

-- wikilinks 关系
CREATE TABLE wikilinks (
  source_uuid TEXT NOT NULL,
  target_uuid TEXT NOT NULL,
  PRIMARY KEY (source_uuid, target_uuid),
  FOREIGN KEY (source_uuid) REFERENCES nodes(uuid),
  FOREIGN KEY (target_uuid) REFERENCES nodes(uuid)
);

-- synthesis 的 sources 关系
CREATE TABLE synthesis_sources (
  synthesis_uuid TEXT NOT NULL,
  source_uuid TEXT NOT NULL,
  role TEXT NOT NULL,  -- 'primary' | 'supporting'
  PRIMARY KEY (synthesis_uuid, source_uuid),
  FOREIGN KEY (synthesis_uuid) REFERENCES nodes(uuid),
  FOREIGN KEY (source_uuid) REFERENCES nodes(uuid)
);

CREATE INDEX idx_sources_target ON synthesis_sources(source_uuid);

-- 簇元数据
CREATE TABLE clusters (
  cluster_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  centroid_e_l1 BLOB,  -- 768d float32 序列化
  description TEXT,  -- LLM 生成的簇描述(后续 v1.1 可用)
  status TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'merged' | 'split'
);

-- 簇快照(用于 drift 触发器)
CREATE TABLE cluster_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TEXT NOT NULL,
  cluster_id INTEGER NOT NULL,
  centroid_e_l1 BLOB NOT NULL,
  member_count INTEGER NOT NULL,
  member_uuids TEXT NOT NULL  -- JSON array
);

CREATE INDEX idx_snapshots_time ON cluster_snapshots(taken_at);
CREATE INDEX idx_snapshots_cluster ON cluster_snapshots(cluster_id);

-- ========== 查询日志(co_retrieval 触发器输入)==========

CREATE TABLE query_log (
  query_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  queried_by TEXT NOT NULL,  -- 'consultant' | 'librarian' | 'external:<id>'
  query_text TEXT NOT NULL,
  raw_hits TEXT NOT NULL,  -- JSON array of uuids
  synthesis_hits TEXT NOT NULL,
  raw_after_expansion TEXT NOT NULL,
  final_used TEXT NOT NULL,
  answer_adopted INTEGER  -- 0 | 1 | NULL
);

CREATE INDEX idx_query_time ON query_log(timestamp);

-- ========== 操作日志(独立轨迹)==========

CREATE TABLE op_log (
  op_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  op_type TEXT NOT NULL,  -- 'move' | 'merge' | 'split' | 'promote' | 'demote'
                          -- | 'rewrite_summary' | 'extract' | 'dedupe'
  args TEXT NOT NULL,  -- JSON
  reason TEXT NOT NULL,
  before_view_hash TEXT NOT NULL,
  after_view_hash TEXT NOT NULL,
  affected_uuids TEXT NOT NULL,  -- JSON array
  reverted_by TEXT,  -- 如果被某个 revert 操作撤销,指向那个 op_id
  branch_name TEXT NOT NULL DEFAULT 'main'
);

CREATE INDEX idx_oplog_time ON op_log(timestamp);
CREATE INDEX idx_oplog_branch ON op_log(branch_name);
CREATE INDEX idx_oplog_run ON op_log(agent_run_id);

-- ========== Agent 运行记录 ==========

CREATE TABLE agent_runs (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_type TEXT NOT NULL,  -- 'daily' | 'weekly' | 'monthly' | 'manual' | 'consultant'
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,  -- 'running' | 'completed' | 'failed'
  summary TEXT  -- 简短描述这次跑了什么
);

-- ========== 调度器状态 ==========

CREATE TABLE scheduler_state (
  job_name TEXT PRIMARY KEY,  -- 'daily' | 'weekly' | 'monthly'
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT
);
```

### 2.5 配置文件 schema(config.json)

```typescript
interface KBConfig {
  version: "1.0";
  data_dir: string;  // 绝对路径
  llm: {
    provider: "openai_compatible";
    base_url: string;  // 用户填,如 https://open.bigmodel.cn/api/paas/v4
    api_key: string;   // 用户填
    chat_model: string;       // 如 "glm-4-plus"
    embedding_model: string;  // 如 "embedding-3"
    embedding_dim: number;    // 该模型输出维度,用户配
  };
  parameters: {
    // HDBSCAN
    hdbscan_min_cluster_size: number;  // 默认 12
    hdbscan_min_samples: number;       // 默认 5
    // UMAP
    umap_n_neighbors: number;  // 默认 15
    umap_n_components: number; // 默认 50
    // co_retrieval 触发器
    co_retrieval_window_days: number;     // 默认 7
    co_retrieval_min_count: number;       // 默认 3
    co_retrieval_min_distinct_sources: number;  // 默认 2
    // substructure
    silhouette_split_threshold: number;   // 默认 0.5
    silhouette_pattern_threshold: number; // 默认 0.4
    // drift
    drift_consecutive_weeks: number;  // 默认 3
    drift_sim_min: number;            // 默认 0.65
    drift_sim_max: number;            // 默认 0.85
    // synthesis 闸门
    synthesis_budget_per_day: number;     // 默认 5
    synthesis_budget_per_week: number;    // 默认 20
    compactness_max: number;              // 默认 0.4
    compactness_hard_max: number;         // 默认 0.6
    similarity_to_source_max: number;     // 默认 0.9
    self_rating_min: number;              // 默认 3
  };
}
```

---

## 三 后端模块详解

### 3.1 storage 模块

**职责**:文件读写 + SQLite 视图层维护。所有节点级别的持久化操作都通过这里。

**对外暴露的核心函数**(伪代码):

```
class NodeStorage:
  init(data_dir: string)
    - 检查 data_dir 是否存在,不存在则创建
    - 检查/初始化 content_git 仓库
    - 检查/初始化 kb.sqlite(执行 §2.4 的 DDL)
    - 检查 kb.lock,如已存在且活跃,拒绝启动

  createNode(input: CreateNodeInput) -> Node
    - 生成 UUID v4
    - 生成 markdown 文件内容(frontmatter + body)
    - 写入 content/<uuid前2位>/<uuid>.md
    - 在 content_git 中 commit("create: <uuid>")
    - INSERT 到 nodes 表
    - 把 wikilinks/synthesis_sources 同步进对应表
    - 返回完整 Node 对象

  readNode(uuid: string) -> Node
    - 先查 SQLite,如果命中且文件 mtime 一致,返回 SQLite 数据 + 按需 lazy 读 body
    - 如果 SQLite 缺失或 mtime 不一致,回到文件读 + parse frontmatter + 同步进 SQLite

  updateNodeContent(uuid: string, new_body: string, reason: string) -> Node
    - 改 body,frontmatter 的 updated_at 更新
    - 写文件 + content_git commit("update: <uuid> - <reason>")
    - 同步 SQLite
    - 标记嵌入需要重算(把 embedded_at 设为 null,等 embedding 服务异步处理)

  updateNodeMetadata(uuid: string, patch: Partial<NodeMetadata>) -> Node
    - 仅改 frontmatter 元数据(不动 body)
    - 写文件,content_git commit
    - 同步 SQLite

  deleteNode(uuid: string) -> void
    - **不真的删文件**,改 status='archived',文件保留
    - 同步 SQLite

  listNodes(filter: NodeFilter) -> Node[]
    - 按 type / cluster / status 等过滤
```

**关键设计点**:

- **SQLite 是文件的派生视图,文件是真相**。如果 SQLite 损坏,可以从文件全量重建
- 启动时跑一次"一致性检查"(扫描文件 + 对比 SQLite,有差异以文件为准)
- 文件的 git 历史是节点内容修改的真相,与操作日志互不干扰

### 3.2 embedding 模块

**职责**:把节点的 L0/L1/L2 文本送到 LLM 服务获取嵌入向量,处理失败重试。

```
class EmbeddingService:
  init(config: KBConfig.llm)

  async embedTexts(texts: string[]) -> number[][]
    - 调 OpenAI 兼容 /v1/embeddings 端点
    - 自动分批(每批 ≤ 100 个)
    - 失败指数退避重试(最多 3 次)
    - 返回 number[][]

  async embedNode(uuid: string) -> void
    - 读节点的 l0_summary, l1_overview, body
    - 调 embedTexts 拿到三个向量
    - 把向量交给 IndexService 入索引
    - 更新节点的 embeddings 字段

  // 后台 worker 方式:
  startBackgroundWorker()
    - 定期(每 30 秒)查 nodes 表里 embedded_at IS NULL 的节点
    - 逐个调 embedNode
```

**关键设计点**:

- 所有节点的嵌入异步生成,不阻塞 createNode
- 失败的嵌入不阻塞其他节点,记录到日志,重试机制独立
- 用户可以在 dashboard 看到"待嵌入节点数"

### 3.3 indexing 模块

**职责**:三个 HNSW 索引的生命周期管理(增、删、改、查、持久化)。

使用 `hnswlib-node` 库。

```
class IndexService:
  init(data_dir: string, dims: { l0: number, l1: number, l2: number })
    - 加载或新建三个 HNSW 索引,从 indices/ 目录
    - 每个索引: M=16, efConstruction=200, efSearch=50

  async addVector(level: 'l0'|'l1'|'l2', vector: number[]) -> internalId: number
    - 添加向量到对应 HNSW
    - 返回 internal id(供 nodes 表的 e_l*_id 字段引用)

  async markVectorRemoved(level, internalId)
    - HNSW 不支持真删,只能标记
    - 我们维护一个"已删除 internalId 集合",查询时过滤

  async searchKNN(level, queryVector, k, excludeIds=[]) -> { ids, distances }[]
    - 查 top-K,自动过滤已标记删除的

  async persist()
    - 写入 indices/*.hnsw

  async fullRebuild(allNodes)
    - 当索引太多删除标记时,从所有 active 节点的嵌入完全重建
    - 用于月度任务
```

**关键坑点**:HNSW 增加新维度会失效——确保 LLM embedding model 切换时**整体重建**。

### 3.4 clustering 模块

**职责**:UMAP 降维 + HDBSCAN 聚类,增量归类 + 全量重聚。

TS 生态没有成熟的 UMAP/HDBSCAN 库,**v1.0 用 Python 子进程方案**:

- 安装 Python 3.10 + umap-learn + hdbscan(用户首次启动时引导)
- 后端启动时探测 Python,失败则给前端报错
- 通过 `child_process.spawn` 调用脚本,数据用 stdin/stdout JSON 通信

```
class ClusteringService:
  init(python_path: string)

  async incrementalAssign(node_uuid: string) -> { cluster_id: number | null, strength: number }
    - 取该节点的 e_l1
    - 在已聚类节点中找 top-20 邻居
    - 看它们的 cluster_id 分布
    - ≥60% 在某簇 → 归入,strength = 占比
    - 否则 → 返回 cluster_id: null(noise),后续等全量重聚

  async fullRecluster(allActiveRawEmbeddings) -> { uuid: cluster_id }
    - 调 Python 子进程跑 UMAP + HDBSCAN
    - 拿到 labels 和 probabilities
    - 对比当前 nodes 表里的 cluster_id,发现变化
    - 把变化记录成 op_log 的 'recluster' 操作(批量)
    - 更新 nodes 表 cluster_id

  async detectSubstructure(cluster_id) -> SubstructureResult
    - 取该簇所有节点的 e_l1(原始 768 维)
    - 跑 k-means k=2,3,4
    - 算 silhouette
    - 返回 { silhouette, recommended_action: 'split' | 'pattern_synthesis' | 'noop', sub_assignments }

  async snapshotClusters() -> void
    - 快照所有当前簇的 centroid 和 member 列表写入 cluster_snapshots
    - 每周任务调用
```

**Python 脚本路径**:`packages/core/python/cluster.py`,任务书附录 D 给出具体脚本内容。

### 3.5 synthesis 模块

**职责**:四个触发器的扫描和触发、闸门 P1-3 / Q1-4、生成调用、入库。

```
class SynthesisService:
  init(config, dependencies)

  // ========== 触发器 ==========

  async scanCoRetrievalTriggers() -> SynthesisCandidate[]
    - SELECT FROM query_log WHERE timestamp > now - 7 days
    - 对每条查询的 raw_after_expansion 中的节点对统计共现
    - 过滤 count ≥ 3 AND distinct queried_by ≥ 2
    - 返回候选 [{ source_uuids, trigger_evidence }]

  async scanSubstructureTriggers() -> SynthesisCandidate[]
    - 对每个 cluster 跑 detectSubstructure
    - silhouette ∈ [0.4, 0.5] → 候选 pattern synthesis
    - silhouette > 0.5 → 候选 split 操作(返回给图书管理员)
    - 返回候选

  async scanDriftTriggers() -> SynthesisCandidate[]
    - 取过去 4 周的 cluster_snapshots
    - 对每对历史独立簇,算 cos_sim 时间序列
    - 满足"连续 3 周升 + 当前 ∈ [0.65, 0.85]"的簇对
    - 对每对,**生成两个独立的 edge_observation 候选**(各自一侧的边界 raw)
    - 返回候选

  // ========== 闸门 ==========

  async preGate(candidate: SynthesisCandidate) -> 'pass' | 'reject:<reason>'
    // P1: 去重
    if 同 sources 的 active synthesis 已存在 → reject:duplicate
    // P2: 源成熟度
    if 任何 source 不是 raw → reject:invalid_source
    // P3: 周期预算
    if 本日/本周已达上限 → reject:budget

  async postGate(synthesis_node, sources) -> 'pass' | 'reject:<reason>'
    // Q1: 紧凑度
    ratio = synthesis_tokens / sum(source_l1_tokens)
    if ratio > 0.6 → reject:too_long
    // Q2: 引用完整性(用 LLM 检查,或正则提取每段是否带 [[uuid]])
    if 存在无归属论断 → reject:missing_citation
    // Q3: 单源相似度
    for each source:
      sim = cosine(synthesis_e_l1, source_e_l1)
      if sim > 0.9 → reject:paraphrase
    // Q4: 自评分
    if self_rating < 3 → reject:low_quality

  // ========== 生成管道 ==========

  async generate(candidate) -> Node | null
    1. preGate(candidate),失败返回 null
    2. 准备 prompt(包含所有 sources 的 l1_overview + 部分 body)
    3. 调 LLM 生成 synthesis 内容(必须按 §7.4 三段式)
    4. 同次调用追加自评分
    5. 解析 LLM 输出
    6. 算 compactness 和 novelty
    7. postGate,失败返回 null
    8. 通过 NodeStorage.createNode 入库
    9. 返回 Node

  // ========== 主循环 ==========

  async runDailyScan() -> void
    candidates = await scanCoRetrievalTriggers()
    for each candidate (按预算上限):
      await generate(candidate)

  async runWeeklyScan() -> void
    candidates = await scanSubstructureTriggers() concat scanDriftTriggers()
    for each candidate:
      if it's split proposal → 让图书管理员处理
      else: await generate(candidate)
```

**关键提示词模板**(任务书附录 B 给完整版):
```
你是图书管理员,在簇 <cluster_id> 内对以下源节点做综合思考:

[Source 1: uuid=<uuid>]
摘要: <l0>
概览: <l1>
正文片段: <body excerpt>

[Source 2: ...]
...

你的任务:产出一份 synthesis,严格按以下三段式:

## 关键洞察
<核心论断,纯散文,100-400 字>

## 论证
- <论断 1> ← [[<source_uuid>]]
- <论断 2> ← [[<source_uuid>]] + [[<source_uuid>]] (joint_inference)
- ...

## 边界与未知
<本 synthesis 不主张什么 / 不确定的地方 / 何种新证据会推翻它>

最后,对自己的 synthesis 用 1-5 打分:
5: 揭示了非显然连接
4: 澄清了源中隐含的连接
3: 陈述了连接但增量价值有限
2: 与源冗余
1: 不连贯或错误

输出格式: ... (JSON)
```

### 3.6 ⭐ tools 模块(核心架构)

**职责**:把所有 KB 内部能力暴露成 OpenAI tool calling 协议兼容的工具。**所有 Agent(咨询员、图书管理员、未来的外部 Agent)都通过这一层与 KB 交互**。

每个 tool 是一个对象:

```typescript
interface Tool {
  name: string;
  description: string;  // LLM 看到的描述
  parameters: JSONSchema;  // OpenAI tool calling 的 parameters
  permission_tag: string;  // 'read' | 'write' | 'structural' | 'admin'
  handler: (args: any, ctx: ToolContext) => Promise<any>;
}

interface ToolContext {
  agent_id: string;
  agent_run_id: string;
  permissions: string[];  // 该 agent 拥有的 permission_tag 列表
}
```

#### v1.0 必须实现的 tool 清单

**读取类(permission: 'read')**

```
search_knowledge
  description: "在知识库中检索相关节点,返回 raw 和 synthesis 的混合结果"
  params: { query: string, k_raw?: number, k_synthesis?: number }
  returns: { raw: NodeBrief[], synthesis: NodeBrief[] }

read_node
  description: "读取单个节点的完整内容(含 body)"
  params: { uuid: string, include_body?: boolean }
  returns: Node

list_nodes
  description: "列出节点,支持按类型、簇、状态过滤"
  params: { node_type?, cluster_id?, status?, limit?, offset? }
  returns: NodeBrief[]

get_cluster_info
  description: "获取簇的元数据和成员"
  params: { cluster_id: number }
  returns: { cluster_id, member_count, members: NodeBrief[], description? }

get_op_log
  description: "查询操作日志"
  params: { since?, until?, agent_id?, op_type?, branch?, limit? }
  returns: OpLogEntry[]

get_query_log
  description: "查询用户查询日志(co_retrieval 触发器的输入)"
  params: { since?, queried_by?, limit? }
  returns: QueryLogEntry[]
```

**写入类(permission: 'write')**

```
create_raw_node
  description: "录入一个新的 raw 知识节点"
  params: { body: string, l0_summary?: string, l1_overview?: string,
            wikilinks?: string[], created_by_run?: string }
  returns: Node
  // 如果 l0/l1 没传,后台异步用 LLM 生成

update_node_content
  description: "修改节点正文(会触发 git commit + 重新嵌入)"
  params: { uuid: string, new_body: string, reason: string }
  returns: Node

archive_node
  description: "归档节点(软删除)"
  params: { uuid: string, reason: string }
  returns: void
```

**结构性操作类(permission: 'structural')**

每个对应一种 op_type,**必须经过 op_log**。

```
op_move
  description: "把节点从一个 current_path 移到另一个"
  params: { uuid, to_path, reason }
  returns: { op_id }

op_merge
  description: "合并两个簇为一个"
  params: { cluster_a, cluster_b, into_path, reason }
  returns: { op_id }

op_split
  description: "把一个簇拆成多个"
  params: { cluster_id, sub_assignments: { sub_path: uuid[] }, reason }
  returns: { op_id }

op_promote / op_demote / op_rewrite_summary / op_extract / op_dedupe
  // 类似,每个对应一种结构操作
```

**Synthesis 触发类(permission: 'structural')**

```
synthesize_explicit
  description: "显式生成一个 synthesis 节点"
  params: { source_uuids: string[], instruction?: string, subtype_hint?: string,
            bypass_pre_gates?: boolean, reason: string }
  returns: Node | { rejected: true, reason: string }
```

**回滚类(permission: 'admin')**

```
revert_op
  description: "回滚单个操作(A 方案,拒绝级联)"
  params: { op_id, reason }
  returns: { success: boolean, blocked_by?: string[] }
  // 如果该 op 之后有依赖它的操作,返回 blocked_by 列表,要求先回滚它们

create_branch
  description: "从当前 main 分出一个分支,用于试验性重组"
  params: { branch_name, reason }

switch_branch
  description: "切换到某个分支"
  params: { branch_name }

merge_branch
  description: "把分支合并回 main(简单冲突解决)"
  params: { from_branch, reason }

blame_node
  description: "查看节点经历过的所有结构性操作"
  params: { uuid }
  returns: OpLogEntry[]
```

#### tool 注册和调用机制

```
class ToolRegistry:
  register(tool: Tool)
  getOpenAISpec(permission_filter: string[]) -> OpenAITool[]
    // 返回该 agent 可见的 tool list,直接给 OpenAI tool calling
  invoke(tool_name, args, ctx) -> any
    // 检查 ctx.permissions 是否包含 tool.permission_tag
    // 调用 handler,捕获错误返回 {error: ...}
    // 所有 invoke 写一份记录(可选)
```

#### Agent 接入端点(v1.0 实现)

后端 HTTP server 暴露:

```
POST /api/agent/invoke
  body: { agent_id, api_key, tool_name, args }
  - 校验 api_key(本地配置文件里的 token)
  - 用 agent_id 查到该 agent 的 permission set
  - 走 ToolRegistry.invoke

POST /api/agent/list_tools
  body: { agent_id, api_key }
  - 返回该 agent 可见的 tool 列表(OpenAI 格式)
```

新外部 Agent 接入流程:管理员在 dashboard 创建一个 agent_id + 分配权限 + 生成 api_key,把这些给外部 Agent,它就能调 tools 了。

### 3.7 agents 模块

#### 咨询员 Agent

```
class ConsultantAgent:
  permissions: ['read', 'write']
  available_tools: [
    'search_knowledge', 'read_node', 'list_nodes', 'get_cluster_info',
    'create_raw_node'
    // 注意:不包含 op_* 和 synthesize_explicit
  ]

  async chat(user_message: string, history: Message[]) -> AgentResponse
    1. 构造 system prompt:
       "你是知识库的咨询员,帮助用户查找和理解知识。
        - raw 节点是原始资料,事实性陈述以它为准
        - synthesis 节点是图书管理员的思考,可引用但要标注
        - 用户上传的内容用 create_raw_node 入库
        - 不要直接修改或删除节点结构,如有需要告诉用户"
    2. 把 history + user_message + tools 列表喂给 LLM
    3. 处理 tool_calls,执行,把结果喂回 LLM
    4. 循环直到 LLM 返回最终消息
    5. 返回响应
```

#### 图书管理员 Agent

```
class LibrarianAgent:
  permissions: ['read', 'write', 'structural', 'admin']
  available_tools: [所有 tools]

  async runDaily() -> void
    1. SynthesisService.runDailyScan()  // co_retrieval 触发
    2. 对最近 24h 新创建但 cluster_id IS NULL 的节点,
       调 ClusteringService.incrementalAssign

  async runWeekly() -> void
    1. SynthesisService.runWeeklyScan()  // substructure + drift 触发
    2. ClusteringService.snapshotClusters()
    3. 对 substructure 触发器返回的 split 提案,LLM 决策是否 split
       (调 op_split tool)
    4. 检查 synthesis 冗余:
       - 找 sources 重叠 ≥ 70% 的 active synthesis
       - LLM 判断是否真冗余,冗余则 dedupe(调 op_dedupe tool)

  async runMonthly() -> void
    1. ClusteringService.fullRecluster()
    2. 对长期 unclustered(> 30 天)的 raw 节点,
       LLM 决策:是否标记为"叶子"(独立条目)
    3. 长期 reference_count == 0 的 synthesis(> 60 天),archive
```

### 3.8 scheduler 模块

**启动追赶 + 进程内 cron**(C 方案)。

```
class Scheduler:
  init()
    - 启动时读 scheduler_state 表
    - 检查每个 job(daily/weekly/monthly):
      if last_run_at + interval < now:
        立即跑一次(追赶)
        更新 last_run_at
    - 用 node-cron 注册 cron 表达式:
      daily: "0 3 * * *"   // 每天凌晨 3 点
      weekly: "0 4 * * 0"  // 每周日凌晨 4 点
      monthly: "0 5 1 * *" // 每月 1 号凌晨 5 点
    - cron 触发时:
      创建 agent_run,调 LibrarianAgent 对应方法
      完成后更新 scheduler_state

  async runManually(job_name: 'daily' | 'weekly' | 'monthly')
    - 前端 dashboard 触发用
```

### 3.9 op_log 模块

```
class OpLogService:
  async record(entry: OpLogEntry) -> op_id

  async revert(op_id, reason) -> { success, blocked_by? }
    1. 查这个 op 之后所有未撤销的 op,如果有依赖该 op 的(影响相同 uuids),
       返回 blocked_by
    2. 否则,根据 op_type 调用反向操作:
       - move(a→b) 反向 = move(b→a)
       - merge(a, b → c) 反向 = split(c → a, b)
       - split(a → b, c) 反向 = merge(b, c → a)
       - extract(sources → new_uuid) 反向 = archive new_uuid
       - rewrite_summary 反向 = 用 old 覆盖回去
       - dedupe(a, b, kept=a) 反向 = un-archive b
       - promote/demote 反向 = 互逆
    3. 记录一条新 op,op_type='revert',args 记录被撤销的 op_id
    4. 把原 op 的 reverted_by 字段填上新 op_id

  async createBranch(name) -> void
    - 在 op_log 里所有未来的写入用新 branch_name
    - 记录一个 'branch_create' op

  async switchBranch(name)
    - 设置当前 active branch
    - **未来所有 op 都 tag 这个 branch**
    - 视图层重建:从该 branch 的 op 序列回放出当前状态

  async mergeBranch(from, to='main') -> void
    - 把 from 上的 op 序列重放到 to
    - 冲突处理:同 uuid 的冲突操作,取 to 上的(简单策略)
    - 记一个 'branch_merge' op

  async blame(uuid) -> OpLogEntry[]
    - SELECT FROM op_log WHERE affected_uuids LIKE ... ORDER BY timestamp
```

**关键提示**:branch 切换需要"重建视图层"——这意味着 nodes 表的某些字段(主要是 cluster_id, current_path)是从 op_log 派生的。**实际实现里**,我们维护一个 `view_layer_state` 缓存表,branch 切换时从对应 branch 的 op 序列重建。

### 3.10 server 模块

```
本地 HTTP server,监听 127.0.0.1:<port>(默认 7823)。

REST 端点:
  // 咨询员
  POST /api/chat
  POST /api/chat/stream  (SSE)

  // KB 状态查询(给 dashboard 用)
  GET /api/nodes
  GET /api/nodes/:uuid
  GET /api/clusters
  GET /api/clusters/:id
  GET /api/op_log
  GET /api/query_log
  GET /api/agent_runs
  GET /api/scheduler_state

  // 手动触发
  POST /api/scheduler/trigger  body: { job_name }

  // 配置
  GET /api/config
  PUT /api/config

  // 数据导入
  POST /api/import/markdown_files  body: file[]
  POST /api/import/text  body: { content, l0?, l1? }

  // ⭐ Agent 接入(§3.6 末段)
  POST /api/agent/invoke
  POST /api/agent/list_tools

WebSocket:
  /ws/events
  - 推送实时事件给前端:
    - 新节点入库
    - 嵌入完成
    - 图书管理员开始/结束运行
    - 新 op 写入
```

---

## 四 前端模块详解

### 4.1 整体布局

```
┌──────────────────────────────────────────────────────────┐
│  Top Bar: 项目名 / 切换面板 / 设置                          │
├────────────┬──────────────────────┬──────────────────────┤
│            │                      │                      │
│  Chat      │   Visualization      │    Dashboard         │
│  Panel     │   Panel              │    Panel             │
│            │                      │                      │
│  (40%)     │   (35%)              │    (25%)             │
│            │                      │                      │
└────────────┴──────────────────────┴──────────────────────┘
```

三面板**默认全部显示**,顶部按钮可以折叠任意面板。

### 4.2 设计原则(美学)

- **配色**:浅色主题为主,可切深色。主色调用沉稳的蓝灰(#2C3E50 系)+ 一个强调色(琥珀 #F39C12)
- **字体**:界面用系统字体栈,正文用 -apple-system;代码块用 SF Mono / JetBrains Mono
- **间距**:8px 基准网格,组件间至少 16px 留白
- **圆角**:8px 默认,卡片 12px
- **阴影**:极少用,仅悬浮元素用 0 2px 8px rgba(0,0,0,0.08)
- **动效**:transition 200ms ease,不用花哨动画
- **图标**:Lucide React(轻量、统一)

### 4.3 ChatPanel(聊天面板)

```
┌──────────────────────────────┐
│  对话标题(可改)              │
├──────────────────────────────┤
│                              │
│  [用户]: 你好,XXX            │
│                              │
│  [咨询员]: 根据你的知识库,   │
│           ...                │
│           ↳ 引用 raw_xxx     │
│                              │
│  [用户]: ...                 │
│                              │
├──────────────────────────────┤
│  [上传文件] [输入框........]  │
│                       [发送] │
└──────────────────────────────┘
```

特性:
- 流式渲染 LLM 回复
- 引用的 uuid 渲染成可点击 link,点击跳到 visualization panel 高亮该节点
- 上传按钮支持拖入 .md / .txt 文件,自动调 import API
- 历史会话本地缓存(localStorage)

### 4.4 VisualizationPanel

三个 Tab(默认显示第 1 个):

**Tab 1: 知识图谱**
- 力导向图,节点 = raw / synthesis,边 = wikilinks + synthesis_sources
- 节点大小 = degree,颜色 = 簇 id(用 color hash)
- synthesis 节点用不同形状(圆环 vs 实心圆)
- hover 显示 l0_summary
- 点击节点 → 在 dashboard panel 弹出节点详情

**Tab 2: 聚类视图**
- 用 UMAP 2D 投影把所有节点画成散点
- 不同簇不同颜色
- 选某个簇:右侧列出该簇所有 member + 它的 synthesis

**Tab 3: 操作日志时间线**
- 横向时间线,每个 op 一个事件点
- hover 看 reason
- 点击 op 看 diff(前后视图层差异)
- 顶部有 branch 切换 / revert 按钮

库选型:
- 图谱:react-force-graph-2d(轻量、易集成)
- 散点:Plotly.js(自带 zoom/pan)
- 时间线:自己写(用 SVG)

### 4.5 DashboardPanel

垂直滚动,几个 section:

**Status 卡片**
- 总节点数(raw / synthesis 分别)
- 簇数
- 待嵌入节点数
- 上次 daily/weekly/monthly 跑的时间

**Action 卡片**
- "立即跑日整理 / 周整理 / 月整理"按钮
- "导入 markdown 文件夹"按钮

**Op Log 最近活动**(简版,最近 10 条)
- 时间 / agent / op_type / reason
- 点"查看全部"跳到 visualization panel 的 tab 3

**配置面板(可折叠)**
- LLM 参数(base_url、api_key、模型、维度)
- 触发器参数(全部 §2.5 里的 parameters)
- 重启生效

**Agent 接入管理**
- 列出已注册的外部 agent
- 创建新 agent + 分配权限 + 生成 api_key

### 4.6 状态管理

用 Zustand(简单、TS 友好):

```
useKBStore
  nodes: Map<uuid, Node>
  clusters: Map<id, Cluster>
  opLog: OpLogEntry[]
  config: KBConfig
  agentRuns: AgentRun[]

  actions: {
    refreshNodes(),
    refreshOpLog(),
    triggerJob(name),
    updateConfig(patch),
    ...
  }

useChatStore
  conversations: Conversation[]
  active_conv_id
  actions: {
    sendMessage(text),
    streamMessage(text),
    ...
  }
```

WebSocket 事件触发对应 store 的 refresh。

### 4.7 与后端的 API 客户端

```
packages/shared/api.ts
  - 定义所有 API 的 request/response 类型
  - 前端 packages/frontend/src/api/client.ts 实现 fetch 包装
  - 后端 packages/core/src/server/routes.ts 直接 import shared 类型保证一致
```

---

## 五 关键算法伪代码

### 5.1 嵌入流水线

```
当 createNode 被调用:
  1. 写文件 + 入 SQLite,embedded_at 字段保持 NULL
  2. 立即返回 Node(不阻塞)

后台 EmbeddingWorker 每 30 秒:
  pending = SELECT uuid FROM nodes WHERE embedded_at IS NULL LIMIT 50
  for uuid in pending:
    node = readNode(uuid)
    [v_l0, v_l1, v_l2] = await embedTexts([node.l0_summary, node.l1_overview, node.body])
    id_l0 = await IndexService.addVector('l0', v_l0)
    id_l1 = await IndexService.addVector('l1', v_l1)
    id_l2 = await IndexService.addVector('l2', v_l2)
    UPDATE nodes SET e_l0_id=id_l0, e_l1_id=id_l1, e_l2_id=id_l2,
                     embedded_at=now WHERE uuid=?
    
  // 嵌入完成后立即触发 incrementalAssign
  if node.node_type == 'raw':
    cluster_result = await ClusteringService.incrementalAssign(uuid)
    if cluster_result.cluster_id:
      UPDATE nodes SET cluster_id=?, cluster_membership_strength=?

  await IndexService.persist()
```

### 5.2 三阶段并行检索

```
async function search(query: string, k_raw=10, k_synthesis=5):
  q_l1 = await embedTexts([query])[0]
  q_l2 = await embedTexts([query, /* 用更长上下文版本 */])[0]
  
  # 阶段 1: 并行检索
  [raw_results, syn_results] = await Promise.all([
    IndexService.searchKNN('l1', q_l1, k_raw, exclude=非 raw),
    IndexService.searchKNN('l1', q_l1, k_synthesis, exclude=非 synthesis)
  ])
  
  # 阶段 2: 聚类边界扩展
  raw_clusters = SELECT DISTINCT cluster_id FROM nodes WHERE uuid IN raw_results.ids
  expanded_raw = []
  for cid in raw_clusters:
    in_cluster_raws = SELECT uuid FROM nodes WHERE cluster_id=cid AND node_type='raw'
    cluster_raw_ids = [n.e_l1_id for n in in_cluster_raws]
    extra = IndexService.searchKNN_within_subset('l1', q_l1, cluster_raw_ids, k=5)
    expanded_raw += extra
  expanded_raw = unique(raw_results + expanded_raw)
  
  # 阶段 3: e_l2 精排
  candidates = expanded_raw + syn_results
  l2_distances = []
  for c in candidates:
    n = readNode(c.uuid)
    l2_vec = IndexService.getVector('l2', n.e_l2_id)
    l2_distances.append((c.uuid, cosine(q_l2, l2_vec), n.node_type))
  sorted = sort by distance asc
  top_n = sorted[:N]  # N 通常 8-12
  
  # 写 query_log
  INSERT INTO query_log (...)
  
  return top_n
```

### 5.3 synthesis 生成主管道

```
async function generateSynthesis(candidate):
  # P1-P3
  if not preGate(candidate): return null
  
  # 准备 sources 内容
  sources_content = []
  for s_uuid in candidate.source_uuids:
    n = readNode(s_uuid)
    sources_content.append({
      uuid: s_uuid,
      l0: n.l0_summary,
      l1: n.l1_overview,
      body_excerpt: n.body[:1500]  # 限制长度
    })
  
  # 调 LLM
  prompt = renderPrompt(SYNTHESIS_PROMPT_TEMPLATE, {
    cluster_id: candidate.cluster_id,
    sources: sources_content,
    subtype: candidate.subtype,
    trigger_evidence: candidate.evidence
  })
  llm_response = await llm.complete(prompt, response_format='json')
  
  # 解析
  parsed = JSON.parse(llm_response)
  body = parsed.body  // 三段式 markdown
  self_rating = parsed.self_rating
  l0_summary = parsed.l0_summary
  l1_overview = parsed.l1_overview
  
  # 算 quality 指标
  syn_tokens = countTokens(body)
  source_tokens_sum = sum(countTokens(s.l1) for s in sources_content)
  compactness = syn_tokens / source_tokens_sum
  
  # 嵌入(同步生成,因为后置闸门 Q3 需要)
  syn_e_l1 = (await embedTexts([l1_overview]))[0]
  novelty = 1 - max(cosine(syn_e_l1, source_e_l1) for source in sources)
  
  # Q1-Q4
  if compactness > config.compactness_hard_max: return rejected('too_long')
  if not validate_citations(body): return rejected('missing_citation')
  if novelty < (1 - config.similarity_to_source_max): return rejected('paraphrase')
  if self_rating < config.self_rating_min: return rejected('low_quality')
  
  # 入库
  node = await NodeStorage.createNode({
    node_type: 'synthesis',
    body, l0_summary, l1_overview,
    synthesis_subtype: candidate.subtype,
    sources: candidate.source_uuids,
    trigger: candidate.trigger,
    quality: { compactness_ratio: compactness, novelty_to_sources: novelty, self_rating },
    cluster_when_created: candidate.cluster_id,
    created_by: 'agent:librarian',
    created_by_run: current_run_id
  })
  
  # 触发器特定的 evidence 也要存
  
  return node
```

### 5.4 操作日志 revert(简版,不含 branch 复杂逻辑)

```
async function revertOp(op_id: string, reason: string):
  op = SELECT FROM op_log WHERE op_id=?
  if op.reverted_by: return { success: false, error: 'already_reverted' }
  
  # 检查依赖
  later_ops = SELECT FROM op_log
              WHERE timestamp > op.timestamp
                AND branch_name = op.branch_name
                AND reverted_by IS NULL
                AND affected_uuids INTERSECTS op.affected_uuids
  if later_ops.length > 0:
    return { success: false, blocked_by: later_ops.map(o => o.op_id) }
  
  # 执行反向操作
  reverse_args = computeReverseArgs(op)
  new_op_id = uuid()
  await applyReverseOperation(op.op_type, reverse_args)
  
  # 记录新 op
  INSERT INTO op_log (op_id=new_op_id, op_type='revert', 
                      args={reverted: op.op_id, reverse_args}, ...)
  UPDATE op_log SET reverted_by=new_op_id WHERE op_id=op.op_id
  
  return { success: true, new_op_id }
```

---

## 六 LLM 集成细节

### 6.1 OpenAI 兼容客户端

用 `openai` npm 包(它支持 base_url 配置,直接兼容 GLM/DeepSeek)。

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: config.llm.api_key,
  baseURL: config.llm.base_url
});

// Chat completion
await client.chat.completions.create({
  model: config.llm.chat_model,
  messages: [...],
  tools: [...],
  tool_choice: 'auto'
});

// Embeddings
await client.embeddings.create({
  model: config.llm.embedding_model,
  input: texts
});
```

### 6.2 Tool Calling 流程

咨询员、图书管理员都按这个流程调:

```
async function runWithTools(messages, available_tools, ctx):
  while True:
    response = await client.chat.completions.create({
      model, messages, tools: available_tools.map(t => t.openai_spec)
    })
    msg = response.choices[0].message
    messages.push(msg)
    
    if msg.tool_calls:
      for tc in msg.tool_calls:
        result = await ToolRegistry.invoke(tc.function.name,
                                           JSON.parse(tc.function.arguments),
                                           ctx)
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result)
        })
      continue  // 让 LLM 看 tool 结果继续
    else:
      return msg.content  // 最终响应
```

### 6.3 流式响应(咨询员)

```
SSE 端点 /api/chat/stream:
  - 用 client.chat.completions.create({ stream: true })
  - 把每个 delta 包装成 SSE event 发给前端
  - tool_call 也要传(前端可以显示"正在调用 search_knowledge..."提示)
  - 完成后发 event: 'done'
```

---

## 七 启动流程

```
启动 (npm run dev / 打包后双击启动):
  1. 后端进程启动
     - 读 config.json,如果不存在,启动"首次配置"流程(等前端连接后弹引导)
     - 探测 Python 3.10 + umap-learn + hdbscan,缺失则打印错误
     - NodeStorage.init(data_dir)
     - IndexService.init() - 加载或新建索引
     - EmbeddingService.init() + 启动后台 worker
     - Scheduler.init() - 启动追赶 + cron
     - 启动 HTTP server on 127.0.0.1:7823
     - 启动 WebSocket on 127.0.0.1:7823/ws
     - 写 kb.lock
     - 注册 SIGTERM handler 优雅关闭
  
  2. 前端启动(开发期 Vite dev server,生产期打包成 Electron 或 PWA)
     - 检查后端是否在线
     - 如果是首次启动(config 不完整),进入首次配置向导:
       - 选数据目录(默认 ~/Downloads/kb_main)
       - 填 LLM API 配置
       - 写入 config.json
     - 拉初始数据,渲染三面板

关闭:
  - 后端收到 SIGTERM 或前端发 /api/shutdown:
    - 停 cron
    - 等当前 agent_run 完成或超时强制中断
    - IndexService.persist()
    - 关闭 SQLite
    - 删 kb.lock
```

---

## 八 数据导入流程

```
POST /api/import/markdown_files
  body: 文件流(可同时多个)
  
  for each file:
    content = read file
    if has YAML frontmatter:
      解析,如果含我们的 schema 字段,按现有节点导入
    else:
      生成新节点:
        body = file content
        l0_summary = await llm.summarize(content, max_tokens=100)
        l1_overview = await llm.overview(content, max_tokens=500)
        wikilinks = parseWikilinks(content)  // 从 [[...]] 提取
    
    await NodeStorage.createNode(...)
  
  返回:{ imported: N, failed: [...] }

POST /api/import/text
  - 单条文本入库,跟咨询员 create_raw_node 走同一路径
```

批量导入用 transaction + 后台异步嵌入。前端 dashboard 显示进度。

---

## 九 错误处理 / 日志 / 可观测性

### 9.1 日志

用 `pino`(快、结构化):

```
所有日志带:
  - timestamp
  - module
  - level
  - run_id (如果在某个 agent_run 上下文中)
  - context(可选:uuid、op_id 等)

写入 data_dir/logs/kb-<date>.log,自动按天 rotate。
```

### 9.2 错误处理

- LLM 调用失败:指数退避重试 3 次,仍失败把任务标记 failed,不影响其他
- 嵌入失败:同上,但保留 embedded_at IS NULL,下次后台 worker 会重试
- SQLite 损坏:启动时检测,提示用户"数据库损坏,可以从文件重建"
- 文件读失败但 SQLite 有记录:警告,把节点标记 corrupted

### 9.3 可观测性

- WebSocket 推送所有重要事件给前端
- Dashboard 的 Status 卡片实时反映系统状态
- agent_runs 表是 Agent 工作的审计 trail

---

## 十 任务序列(Claude Code 按此顺序实施)

### Milestone 1: 项目骨架(预估 0.5 天)

- [ ] 初始化 monorepo(pnpm workspace),三个 package
- [ ] 配置 TypeScript、ESLint、Prettier
- [ ] 写 packages/shared 的所有类型定义(对应 §2 数据模型)
- [ ] packages/core 空壳 + 入口
- [ ] packages/frontend 用 Vite + React 18 + Tailwind 起骨架
- [ ] 跑通 dev 命令

**验证**:`pnpm dev` 能同时启动后端(端口 7823 listening)和前端(端口 5173)。

### Milestone 2: 存储层(预估 1.5 天)

- [ ] 实现 NodeStorage(§3.1 全部 API)
- [ ] 实现 OpLogService(§3.9,先做 record/blame,revert 留 M9)
- [ ] SQLite 初始化 + 完整 DDL(§2.4)
- [ ] 文件系统操作 + content_git 集成(用 simple-git)
- [ ] 写单元测试覆盖 createNode / readNode / updateNodeContent / archiveNode

**验证**:能通过 NodeStorage API 创建 / 读取 / 修改节点,文件落盘正确,SQLite 同步正确,git 历史记录正确。

### Milestone 3: LLM + 嵌入服务(预估 1 天)

- [ ] EmbeddingService(§3.2)
- [ ] IndexService(§3.3,基于 hnswlib-node)
- [ ] LLM client 封装(§6)
- [ ] EmbeddingWorker 后台循环

**验证**:创建节点后 30 秒内能在 HNSW 索引里查到。

### Milestone 4: 聚类(预估 1.5 天)

- [ ] Python 脚本 packages/core/python/cluster.py(附录 D)
- [ ] ClusteringService(§3.4)
- [ ] incrementalAssign + fullRecluster + detectSubstructure
- [ ] 集成到 EmbeddingWorker:嵌入完成立即归类

**验证**:导入 50 个测试节点,fullRecluster 能聚出合理的簇,detectSubstructure 能在有子结构的簇上返回 split 提案。

### Milestone 5: Tools 层(预估 1.5 天)

- [ ] ToolRegistry(§3.6 框架)
- [ ] 实现读取类 6 个 tools
- [ ] 实现写入类 3 个 tools
- [ ] 实现结构性操作 8 个 tools(每个对应一种 op_type,**走 op_log**)
- [ ] 实现 synthesize_explicit
- [ ] 写 tools 的 OpenAI spec 自动生成

**验证**:能用 ToolRegistry.invoke 直接调用每个 tool,效果跟直接调底层模块一致;OpenAI spec 输出能直接喂给 client.chat.completions.create 而不报错。

### Milestone 6: 咨询员 Agent + Chat 端点(预估 1 天)

- [ ] ConsultantAgent(§3.7)
- [ ] /api/chat 和 /api/chat/stream(§3.10)
- [ ] 三阶段并行检索算法(§5.2,封装在 search_knowledge tool)

**验证**:用 curl 调 /api/chat 能拿到合理回答;咨询员能自己决定调 search_knowledge 然后回答。

### Milestone 7: synthesis 模块(预估 2 天)

- [ ] SynthesisService 框架(§3.5)
- [ ] co_retrieval 触发器
- [ ] substructure 触发器
- [ ] drift 触发器(需要 cluster_snapshots 表已工作)
- [ ] preGate / postGate 全部实现
- [ ] 生成管道(§5.3)
- [ ] 完整提示词模板(附录 B)

**验证**:手动构造一个 query_log 触发条件,跑 runDailyScan 能成功生成一个 synthesis 节点(包含三段式 body、quality 字段、入 op_log)。

### Milestone 8: 图书管理员 + 调度器(预估 1.5 天)

- [ ] LibrarianAgent(§3.7)
- [ ] Scheduler(§3.8)
- [ ] runDaily / runWeekly / runMonthly 完整实现
- [ ] /api/scheduler/trigger

**验证**:手动触发 daily/weekly/monthly,日志显示完整执行流程,新生成的 synthesis 进库,op_log 有记录。

### Milestone 9: 操作日志 revert + branch + blame(预估 1.5 天)

- [ ] OpLogService.revert(§5.4)
- [ ] 每种 op_type 的反向操作
- [ ] createBranch / switchBranch / mergeBranch
- [ ] blame_node tool
- [ ] view_layer_state 缓存表(branch 切换重建用)

**验证**:做几个 move/merge,revert 能正确撤销;创建 branch 试 split,合回 main 不影响其他。

### Milestone 10: HTTP API + WebSocket(预估 1 天)

- [ ] 全部 REST 端点(§3.10)
- [ ] WebSocket 事件推送
- [ ] /api/agent/invoke 和 /api/agent/list_tools(§3.6 末段)
- [ ] CORS、错误处理、日志

**验证**:外部脚本能用 /api/agent/invoke 模拟外部 Agent 调任意 tool。

### Milestone 11: 前端基础(预估 2.5 天)

- [ ] 三面板布局 + 顶部 bar
- [ ] Zustand stores
- [ ] API client + WebSocket client
- [ ] ChatPanel 完整(流式渲染、引用 link、文件上传)

**验证**:前端能跟后端聊天,显示引用,上传 markdown 文件入库。

### Milestone 12: 可视化 + Dashboard(预估 2.5 天)

- [ ] VisualizationPanel 三个 Tab
- [ ] DashboardPanel 全部 section
- [ ] 配置面板(可改参数实时生效)
- [ ] Agent 接入管理 UI

**验证**:三个面板都能正确显示数据,改配置能持久化,创建外部 agent 能拿到 api_key。

### Milestone 13: 数据导入 + 首次配置向导(预估 1 天)

- [ ] /api/import/markdown_files
- [ ] /api/import/text
- [ ] 前端首次启动向导(选目录 + 填 LLM 配置)
- [ ] 数据导入进度条

**验证**:首次启动能完成配置 + 导入一个测试文件夹的 50 个 .md 文件。

### Milestone 14: 打包 + 文档(预估 1 天)

- [ ] 用 pkg 或 Electron 打包成 Mac app
- [ ] README 含使用说明
- [ ] 验收 checklist

**总预估**:约 20 个工作日(4 周)。这是 Claude Code 顺利情况下的估计,实际可能略多。

---

## 十一 验证方法(每个 milestone 完成后跑)

### 11.1 单元测试

每个模块都要有基本单元测试。重点覆盖:

- NodeStorage:CRUD 一致性
- IndexService:add/search/persist 后重启能恢复
- ClusteringService:已知数据上的聚类结果稳定
- SynthesisService:闸门 P1-Q4 各自能拒绝预期的输入
- OpLogService:每种 op 的 revert 正确

### 11.2 端到端冒烟测试

`scripts/smoke.ts`:

```
1. 删除 data 目录 + 重启
2. 用 API 创建 30 个 raw 节点(覆盖 3 个明显主题)
3. 等所有节点嵌入完成(轮询 nodes 表)
4. 触发 monthly(全量重聚)
5. 验证至少聚出 3 个簇
6. 模拟用户查询(写 query_log)产生 co_retrieval 信号
7. 触发 daily,验证生成至少 1 个 synthesis
8. 调 chat API 提问,验证回答用了 raw 和 synthesis
9. 做一次 op_move,然后 revert,验证状态回滚正确
10. 创建 branch,做几个操作,merge 回 main
```

### 11.3 验收 checklist

最终验收:
- [ ] 能在 Mac 上从零启动跑通 smoke test
- [ ] 三面板都能正确显示数据
- [ ] 修改配置能生效
- [ ] revert 不会破坏数据一致性
- [ ] 外部 Agent 能通过 /api/agent/invoke 调 tool
- [ ] 关闭再启动,所有数据保留

---

## 十二 已知坑点提示

1. **HNSW 不支持真删除**:用"已删除集合"过滤,定期 fullRebuild 清理
2. **UMAP 输出不确定**:必须固定 random_state,否则每次结果不同
3. **HDBSCAN 增量更新差**:坚持"增量近似 + 月度全量"模式,不要尝试自己写增量
4. **Python 子进程通信**:大数组用 stdin/stdout JSON 太慢,用临时文件中转
5. **Embedding 模型切换会失效所有索引**:配置文件里改 model 时强制全量 rebuild
6. **SQLite + 多进程冲突**:用 kb.lock 防止多开;后端单进程操作 SQLite
7. **Branch 切换的视图重建慢**:用 view_layer_state 缓存,首次切换时重建并缓存
8. **LLM 输出 JSON 不稳**:用 response_format json_object + Zod schema 校验,失败重试
9. **op_log 的 affected_uuids 比较**:用 SQLite 的 JSON1 扩展或 PostgreSQL 风格的数组操作
10. **content_git 提交频繁**:每个 update 都 commit 会产生大量小提交,可考虑批量提交(每 10 个或 5 分钟一次)
11. **三面板状态同步**:WebSocket 推送变更,各 store 自己处理对应事件,避免轮询
12. **Mac 沙盒**:如果打包成 Electron,文件读写可能受限,提前测试 ~/Downloads 写入

---

## 附录 A:关键依赖列表

### 后端 (packages/core)

```json
{
  "dependencies": {
    "openai": "^4.x",
    "hnswlib-node": "^3.x",
    "better-sqlite3": "^11.x",
    "simple-git": "^3.x",
    "node-cron": "^3.x",
    "pino": "^9.x",
    "zod": "^3.x",
    "express": "^4.x",
    "ws": "^8.x",
    "cors": "^2.x",
    "yaml": "^2.x",
    "uuid": "^10.x",
    "tiktoken": "^1.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "@types/node": "^20.x",
    "tsx": "^4.x",
    "vitest": "^2.x"
  }
}
```

### 前端 (packages/frontend)

```json
{
  "dependencies": {
    "react": "^18.x",
    "react-dom": "^18.x",
    "zustand": "^5.x",
    "react-force-graph-2d": "^1.x",
    "plotly.js-dist-min": "^2.x",
    "react-plotly.js": "^2.x",
    "lucide-react": "^0.x",
    "react-markdown": "^9.x",
    "tailwindcss": "^3.x"
  },
  "devDependencies": {
    "vite": "^5.x",
    "@vitejs/plugin-react": "^4.x"
  }
}
```

### Python(用于聚类)

```
umap-learn>=0.5
hdbscan>=0.8
scikit-learn>=1.3
numpy>=1.24
```

---

## 附录 B:LLM 提示词完整模板

### Synthesis 生成提示词

```
你是知识库的图书管理员。你的任务是对以下源节点做一次综合思考,产出一个 synthesis 节点。

# 上下文

- 触发原因: {trigger.type}
- 触发证据: {trigger.evidence}
- 期望的 synthesis 类型: {subtype}
- 来源簇 id: {cluster_id}

# 源节点

{for each source}
## Source [{role}] - uuid: {uuid}

L0 摘要: {l0_summary}
L1 概览: {l1_overview}
正文片段(前 1500 字符):
{body_excerpt}

---
{end for}

# 你的任务

产出一份 synthesis,**严格按以下三段式 markdown 格式**:

```
## 关键洞察

<核心论断,纯散文,100-400 字。表达"这些源放在一起暗示了什么",而不是简单概括各源说了什么>

## 论证

- <论断 1> ← [[<source_uuid>]]
- <论断 2> ← [[<source_uuid_a>]] + [[<source_uuid_b>]] (joint_inference)
- ...

每个论断必须有引用,要么直接引一个源,要么标注 joint_inference 表示是多源联合推断。

## 边界与未知

<这一段强制存在。说明:
- 本 synthesis 不主张什么
- 哪些地方有不确定性
- 何种新证据会推翻它>
```

# 自我评估

最后,请按 1-5 给自己的 synthesis 打分:

5: 揭示了多个远距离源之间的非显然连接
4: 澄清了源中隐含但未明说的连接
3: 陈述了一个连接但增量价值有限
2: 与源内容冗余
1: 不连贯或错误

# 输出格式

请用以下 JSON 格式输出(不要用 markdown 代码块包裹 JSON):

{
  "body": "完整的三段式 markdown",
  "l0_summary": "一句话摘要,< 200 字符,描述这个 synthesis 在说什么",
  "l1_overview": "一段概览,< 1500 字符",
  "self_rating": <1-5>,
  "reasoning": "<可选,你的简短自我评价>"
}
```

### 咨询员 system prompt

```
你是一个知识库的咨询员 Agent,你帮助用户查找、理解、扩充知识库。

# 知识库基本规则

1. 知识库有两种节点:
   - **raw**: 原始资料,代表客观事实和已有内容,事实陈述以它为准
   - **synthesis**: 图书管理员对若干 raw 节点的综合思考,带有解读视角,引用时要明确标注

2. 当用户提问:
   - 调用 search_knowledge 工具检索相关节点
   - 阅读 raw 节点回答事实问题
   - 阅读 synthesis 节点了解综合视角,但要标注它是图书管理员的判断
   - 如果 raw 和 synthesis 冲突,以 raw 为准并指出 synthesis 可能需要更新

3. 当用户提供新内容:
   - 用 create_raw_node 工具入库
   - 不要调用 op_* 或 synthesize_explicit 工具,这些是图书管理员的工作

4. 引用节点时使用 [[uuid]] 格式,前端会自动渲染成可点击链接

5. 如果检索不到相关节点,诚实告诉用户,不要凭空回答

# 工具使用

可用工具:{tool list}

请根据用户问题决定调用哪些工具,然后基于工具结果给出回答。
```

### 图书管理员的子任务 prompt(若干个)

(任务书附录 B 的剩余部分会列出每个子任务的具体提示词,这里略)

---

## 附录 C:文件命名 / 路径示例

```
完整数据目录示例:
/Users/alice/Downloads/kb_research/
├── content/
│   ├── 7c/
│   │   └── 7c4f8a2b-9d3e-4f0a-b1c2-3d4e5f6a7b8c.md
│   ├── ab/
│   └── ff/
├── content_git/  (.git 在这)
├── indices/
│   ├── e_l0.hnsw
│   ├── e_l1.hnsw
│   └── e_l2.hnsw
├── logs/
│   └── kb-2026-04-27.log
├── kb.sqlite
├── config.json
└── kb.lock
```

---

## 附录 D:Python 聚类脚本(packages/core/python/cluster.py)

```python
#!/usr/bin/env python3
"""
集群计算服务。从 stdin 读 JSON 任务,从 stdout 写 JSON 结果。
"""
import sys
import json
import numpy as np
import umap
import hdbscan
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score


def full_recluster(embeddings, params):
    """UMAP + HDBSCAN 全量聚类"""
    arr = np.array(embeddings, dtype=np.float32)
    
    # UMAP 降维
    reducer = umap.UMAP(
        n_neighbors=params.get('umap_n_neighbors', 15),
        n_components=params.get('umap_n_components', 50),
        metric='cosine',
        min_dist=0.0,
        random_state=42
    )
    reduced = reducer.fit_transform(arr)
    
    # HDBSCAN
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=params.get('hdbscan_min_cluster_size', 12),
        min_samples=params.get('hdbscan_min_samples', 5),
        metric='euclidean',
        cluster_selection_method='eom'
    )
    labels = clusterer.fit_predict(reduced)
    probabilities = clusterer.probabilities_
    
    return {
        'labels': labels.tolist(),
        'probabilities': probabilities.tolist()
    }


def detect_substructure(embeddings, params):
    """簇内 silhouette 子结构判定"""
    arr = np.array(embeddings, dtype=np.float32)
    if len(arr) < 6:
        return {'silhouette': 0.0, 'recommended_action': 'noop',
                'sub_assignments': None, 'k': None}
    
    best_silhouette = -1
    best_k = None
    best_labels = None
    
    for k in [2, 3, 4]:
        if len(arr) < k * 2:
            continue
        km = KMeans(n_clusters=k, random_state=42, n_init=10)
        sub_labels = km.fit_predict(arr)
        score = silhouette_score(arr, sub_labels)
        if score > best_silhouette:
            best_silhouette = score
            best_k = k
            best_labels = sub_labels
    
    split_threshold = params.get('silhouette_split_threshold', 0.5)
    pattern_threshold = params.get('silhouette_pattern_threshold', 0.4)
    
    # 检查最大/最小子簇比
    if best_labels is not None:
        unique, counts = np.unique(best_labels, return_counts=True)
        ratio = counts.max() / counts.min()
    else:
        ratio = float('inf')
    
    if best_silhouette > split_threshold and ratio < 5:
        action = 'split'
    elif best_silhouette > pattern_threshold:
        action = 'pattern_synthesis'
    else:
        action = 'noop'
    
    return {
        'silhouette': float(best_silhouette),
        'recommended_action': action,
        'sub_assignments': best_labels.tolist() if best_labels is not None else None,
        'k': best_k
    }


def main():
    task = json.load(sys.stdin)
    op = task['op']
    
    if op == 'full_recluster':
        result = full_recluster(task['embeddings'], task.get('params', {}))
    elif op == 'detect_substructure':
        result = detect_substructure(task['embeddings'], task.get('params', {}))
    else:
        result = {'error': f'unknown op: {op}'}
    
    json.dump(result, sys.stdout)


if __name__ == '__main__':
    main()
```

调用方式:
```typescript
const result = await new Promise((resolve, reject) => {
  const proc = spawn('python3', ['python/cluster.py']);
  let out = '';
  proc.stdout.on('data', d => out += d);
  proc.on('close', () => resolve(JSON.parse(out)));
  proc.stdin.write(JSON.stringify({ op: 'full_recluster', embeddings, params }));
  proc.stdin.end();
});
```

数据量大时(> 1MB)用临时文件中转,避免 stdin/stdout 性能问题。

---

**任务书结束**

实施时遇到本文档未覆盖的设计决策,请按设计原则(§1.4)推断;实在不确定的标 `// TBD: <问题>` 暂时跳过,提交前汇总让我审核。

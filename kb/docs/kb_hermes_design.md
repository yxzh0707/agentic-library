# KB 内置 Hermes Optimizer 设计文档

**版本**: v2.0
**日期**: 2026-05-16
**状态**: 框架设计版

> 本文档描述 KB 系统内置 Hermes Optimizer 的完整设计。
> 它是 `knowledge_base_v1.3_design.md` 的扩展，不是替代。
> v1.3 的 raw/synthesis 双层架构、聚类、synthesis 管线等仍然有效。

---

## 〇 设计目标

### 核心定位

KB 不再只是一个被动存储库，而是一个**具有自我诊断、自我整理、自我进化能力的知识基础设施**。

内部运行一个完整的 Hermes Optimizer，为没有外部 Hermes agent 的用户提供同等级服务；同时通过统一的工具接口层，支持外部 Hermes / 任意工具调用 agent 的接入。

### 三个设计原则

1. **工具接口统一**：不管调用方是内部 Optimizer 还是外部 Hermes，调同一套工具
2. **记忆层独立**：KB 有自己的记忆（heartbeat / reflection / traces / queue），不依赖外部 agent 持有
3. **内外皆可用**：有外部 agent 时外部操控股权，没有时内部 Optimizer 兜底

---

## 一 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    KB Server（单进程）                         │
│                                                             │
│  ┌───────────────┐    ┌───────────────────────────────────┐  │
│  │ConsultantAgent│    │  Hermes 内置 Optimizer（daemon）   │  │
│  │  对外 API     │    │  - 主循环持续激活                   │  │
│  │  /api/chat    │    │  - 触发：数据摄入/事件/每周觉醒     │  │
│  └───────────────┘    │  - O-D-P-A-V 五段闭环              │  │
│                       │  - sub-agent spawning（按需）       │  │
│                       └───────────────┬───────────────────┘  │
│                                       │ 调用同一工具接口      │
│  ┌─────────────────────────────────────▼───────────────────┐  │
│  │              工具接口层（ToolRegistry）                  │  │
│  │  read / write / structural / admin / hermes             │  │
│  └─────────────────────────────────────┬───────────────────┘  │
│                                        │                      │
│  ┌─────────────────────────────────────▼───────────────────┐  │
│  │              记忆层（KB 自持，不绑定外部 agent）         │  │
│  │  heartbeat.md / reflection 节点 / traces / queue       │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 与 v1.3 的关系

- ConsultantAgent 保持不变，处理外部 chat 请求
- LibrarianAgent 演进为 Hermes Optimizer 的核心执行体
- Scheduler 的 weekly/monthly/background cron 继续作为周期性觉醒触发器
- 所有现有工具（search / read / write / structural / admin）继续有效，Hermes 调用它们执行动作

---

## 二 触发模型

### 三类触发，不做持续扫描

```
被动触发（事件来了立即处理）
  ├── 新数据摄入 → on_ingest 触发 immediate check
  ├── flag/feedback → 立即消费
  └── trace 积累够阈值 → 触发提炼

周期性觉醒（每周一次）
  └── 整体看 KB 状态，决定优先事项，不频繁

外部 agent 触发（按需）
  └── /api/agent/invoke 调用工具，Hermes 响应但不独占
```

**设计原则**：不做每分钟/每小时扫描。大部分时间深度睡眠，事件触发或周期觉醒才醒。

---

## 三 Hermes Optimizer 五段闭环

每次激活都按以下五段运行：

### Step 1: Observe（观察）

读取当前 KB 状态：
- 新数据及其 cluster 归属
- 相关 flag / feedback
- trace 增量
- optimization_queue 积压
- 最近一次 heartbeat 的开放循环

输出：observation record（结构化的当前状态摘要）

---

### Step 2: Diagnose（诊断）

把观察结果归类为以下问题类型：

| 类型 | 说明 |
|---|---|
| `cluster_quality` | 聚类边界弱 / hub 失准 / drift |
| `retrieval_quality` | 某类 query 持续失败 / 命中不足 |
| `content_quality` | duplicate / outdated / summary 不准 |
| `coverage_gap` | 某类 topic 持续缺资料 |
| `workflow_feedback` | 同一问题反复出现 |
| `reflection_opportunity` | trace 中有高价值经验待提炼 |

输出：diagnosis items（带 priority / confidence / recommended action class）

---

### Step 3: Plan（计划）

决定每条 diagnosis 的处理方式：

| 风险等级 | 行动 |
|---|---|
| **L1 自动执行** | 规则函数：auto-archive / dedup / clean / threshold-based 维护 |
| **L2 验证后执行** | LLM 推理：cluster_review / consolidation / reflection 生成（需 replay 验证） |
| **L3 必须提议** | 高风险操作：大规模改 / 外部搜索 / reset，写 queue 等外部 agent 处理 |

输出：action plan（每条 diagnosis 对应一个确定的处理方式）

---

### Step 4: Act（执行）

按 plan 执行：

- L1 规则函数直接执行，op_log 记录
- L2 LLM 推理调用 synthesis service，生成节点，写 op_log
- L3 写 optimization_queue 或 acquisition_request，等待外部处理

输出：executed / queued results，affecting uuids

---

### Step 5: Verify（验证）

验证本次操作是否有效（仅 L2 执行需要完整验证，L1 轻量确认）：

- cluster cohesion 前后对比
- representative query replay
- 同类 feedback 是否减少
- 新 reflection 是否被后续使用

输出：verification result → accepted / reverted / escalated

最后更新 heartbeat.md，记录本次闭环结论。

---

## 四 记忆层

### 4.1 heartbeat.md

KB 的自我描述文档，每次 Hermes 闭环结束后更新。

格式设计：

```markdown
# Hermes Heartbeat
last_updated: <ISO 8601>

## Current KB State
- active raw: N  synthesis: N  reflection: N
- clusters: K（active）
- friction clusters: [id list]
- noise nodes: N
- optimization_queue depth: N
- pending acquisition: N

## Open Loops
- <item> (<priority>, <created>)
- ...

## Learned Heuristics
- "<finding>": "<action that worked>"
- ...

## Scheduled
- next weekly: <ISO date>
- pending verification runs: N

## Hermes Policy
- auto_archive_threshold: 60d
- dedup_similarity_threshold: 0.08
- reflection_promotion_min_confidence: medium
- ...
```

**用途**：
- 外部 agent 兼职时的操作手册（读到这里就知道 KB 当前状态）
- 内部 Optimizer 每次觉醒的起点（从这里恢复上下文）
- 自身学习的载体（每次更新加入新的 learned heuristics）

---

### 4.2 reflection 节点

从 trace 中提炼的可复用经验，与 raw/synthesis 平级的第三节点类型。

**用途**：
- 记录"这类问题应该这样做"
- 记录"某 cluster 的 hub 选错了，某条件下要优先检查"
- 记录"某类 query 用 synthesis 比 raw 可靠"
- 记录"检索策略 X 在 Y 场景下有效"

**检索策略**：
- 默认低权重，不进普通 search_knowledge
- 通过专门工具 `search_reflection` 召回
- 通过 `inspect_cluster` 的诊断模式可附带

---

### 4.3 reasoning_traces 表

接收外部 agent 的原始 reasoning trace，TTL 过期。

| 字段 | 说明 |
|---|---|
| trace_id | UUID |
| agent_id | 来源 agent |
| agent_run_id | 关联运行 |
| query_id | 关联查询 |
| task_type | 任务类型 |
| trace_content | JSON 或文本 |
| evidence_uuids | 引用节点 |
| final_answer_summary | 最终答案摘要 |
| outcome | success/failure/partial |
| created_at | |
| expires_at | TTL |

**设计原则**：trace 是日志层，不进默认检索，主要用于提炼 reflection。

---

### 4.4 optimization_queue

待处理事项，内部 Optimizer 和外部 Hermes 共享。

| 字段 | 说明 |
|---|---|
| item_id | UUID |
| problem_type | cluster_quality / coverage_gap / etc. |
| target_uuid / cluster_id | 问题对象 |
| evidence | 发现依据 |
| proposed_action | 建议处理方式 |
| risk_level | L1/L2/L3 |
| status | pending / accepted / resolved / dismissed |
| created_by | hermes / external:<id> / human |
| created_at | |
| resolved_at | |
| resolution | |

L1 项可被内部 Optimizer 自动执行，L2/L3 需外部 agent 或人工确认。

---

### 4.5 acquisition_request

知识缺口声明，触发外部搜索前先走这个。

| 字段 | 说明 |
|---|---|
| request_id | UUID |
| gap_description | 缺什么资料 |
| affected_cluster_id / query_pattern | 影响范围 |
| priority | |
| status | pending / approved / rejected / fulfilled |
| source_type | internal_hermes / external:<id> / human |
| created_at | |
| approved_at / rejected_at | |
| fulfillment_notes | |

**设计原则**：Hermes 发现缺口后写 request，不直接上网。外部 agent 或人审批后执行搜索。

---

## 五 内部管理函数（规则驱动）

无需 LLM 的日常维护操作，Hermes 调用：

| 函数 | 触发条件 | 动作 |
|---|---|---|
| `autoArchiveStaleSynthesis` | 60 天无 reference_count | archive + op_log |
| `autoMarkDuplicate` | embed 距离 ≤ 0.08 | flag_queue 写入 duplicate candidate |
| `autoCleanOrphanWikilinks` | wikilink target 不存在 | 删除无效边 |
| `autoUpdateClusterAssignment` | 新 node incremental assign | 更新 cluster_id |
| `autoConsumeSimpleFlag` | specific_issue + 规则明确 | archive / move + op_log |

这些是 Hermes 可以直接调用、不需要提议的 L1 风险操作。

---

## 六 工具接口层（统一，内外共用）

### 新增 hermes 类工具

| 工具名 | 用途 | 权限 |
|---|---|---|
| `search_reflection` | 专门检索 reflection | read |
| `read_heartbeat` | 读取 KB 当前状态摘要 | read |
| `submit_trace` | 外部 agent 提交 reasoning trace | write |
| `create_acquisition_request` | 声明知识缺口 | write |
| `consume_optimization_queue` | 处理待办事项 | structural |
| `verify_action` | 操作后验证 replay | admin |
| `spawn_sub_agent` | 派生受限子任务 | admin |
| `get_hermes_status` | 返回 KB health 摘要 + heartbeat 内容 | read |

### 现有工具复用

所有现有工具（search_knowledge / read_node / create_raw_node / op_move / flag_* 等）继续对内外部共用，Hermes 和外部 agent 调同一套。

---

## 七 sub-agent 生成（按需，不是预设）

### 触发场景

- 外部 deep search / 资料采集（隔离执行）
- 批量 query replay（并行加速）
- 大规模 cluster 诊断（窄目标隔离）
- 长时间清洗任务（不阻塞主循环）

### 实现方式

不预设多个常驻 agent，而是在需要时：
1. Hermes 主 agent 生成一个受限子上下文
2. 给 sub-agent 授权 tools 的子集
3. sub-agent 执行完，结果合并回 Hermes
4. sub-agent 的 agent_run_id 归在主 Hermes run 下，可审计

---

## 八 外部 agent 接入

### /api/agent/invoke 继续作为主入口

外部 Hermes / 任意能调工具的 agent 通过 `/api/agent/invoke` 操作 KB。

权限体系（read / write / structural / admin）控制操作边界。

### heartbeat.md 作为外部 agent 的操作手册

外部 agent 兼职时：
1. 先读 heartbeat.md 了解当前 KB 状态
2. 读 optimization_queue 了解待处理事项
3. 决定优先级后调用工具
4. 操作后更新 heartbeat.md（或由内部 Optimizer 下次更新）

### 外部 agent 可以完全主导 KB 优化

内部 Optimizer 和外部 Hermes 是竞争合作关系，不是主从关系。外部 agent 来时可以接管所有优化任务，内部 Optimizer 在外部 agent 不活跃时兜底。

---

## 九 数据模型

### 节点类型（扩展）

```
NodeType = 'raw' | 'synthesis' | 'reflection'
```

reflection 节点额外字段：

```yaml
reflection_subtype: 'decision' | 'failure_analysis' | 'retrieval_strategy' | 'plan' | 'critique' | 'postmortem'
sources: [uuid]  # 指向 raw/synthesis/query_context
trace_source: { agent_run_id, query_id }  # 关联原始 trace
outcome: 'useful' | 'superseded' | 'rejected' | 'expired'
confidence: 'high' | 'medium' | 'low'
reusability_score: float
visibility: 'private' | 'debug' | 'retrievable'
promotion_state: 'distilled' | 'promoted'
```

### 新增表

```
reasoning_traces      -- trace 存储
optimization_queue    -- 待办事项
acquisition_requests  -- 知识缺口声明
verification_runs      -- 验证记录
```

---

## 十 落地顺序

### Phase 1（最小可工作集）
1. 实现 `reasoning_traces` 表 + `submit_trace` 工具
2. 实现 `reflection` 节点类型 + schema（仅 base 字段）
3. 实现 `heartbeat.md` 读写逻辑
4. 内部 Optimizer 基本框架（Observe → Diagnose → Plan，不做 Act）
5. `autoArchiveStaleSynthesis` 规则函数

### Phase 2（核心功能）
6. `optimization_queue` 表 + `consume_optimization_queue` 工具
7. Hermes Act 阶段实现（L1 自动执行 + L2 LLM 生成）
8. `search_reflection` 工具
9. `acquisition_request` 表 + `create_acquisition_request`
10. on_ingest 触发 immediate check 增强（聚类质量 + 整理机会）

### Phase 3（完整能力）
11. Hermes Verify 阶段实现（replay + metrics 对比）
12. sub-agent spawning 实现
13. `get_hermes_status` 工具
14. 外部 agent 兼职模式跑通

---

## 十一 与 v1.3 设计文档的关系

- v1.3 的 raw/synthesis 双层架构保持不变
- v1.3 的聚类 / synthesis 管线 / librarian 调度继续作为底层能力
- Hermes 是 librarian 的演进方向：librarian 从"周期性任务执行者"升级为"持续激活的自主优化 agent"
- v1.3 的 `reflection` 枚举值在此版本实现

---

## 十二 关键文件

| 文件 | 改动 |
|---|---|
| `packages/shared/src/types.ts` | 扩 ReflectionSubtype / reflection 节点字段 |
| `packages/core/src/storage/db.ts` | 新增 traces/queue/acquisition 表 |
| `packages/core/src/storage/storage.ts` | 支撑 reflection 节点创建 |
| `packages/core/src/agents/librarian.ts` | 演进为 Hermes 主循环（核心改动） |
| `packages/core/src/agents/consultant.ts` | 不变 |
| `packages/core/src/synthesis/synthesis.ts` | reflection 生成 pipeline |
| `packages/core/src/search/search.ts` | reflection 默认低权重策略 |
| `packages/core/src/tools/read_tools.ts` | 新增 hermes 类工具 |
| `packages/core/src/tools/registry.ts` | 新增 hermes 工具注册 |
| `packages/core/src/tools/write_tools.ts` | 新增 submit_trace / create_acquisition |
| `packages/core/src/tools/admin_tools.ts` | 新增 spawn_sub_agent / verify_action |
| `packages/core/src/scheduler/scheduler.ts` | Hermes 主循环接入 |
| `docs/kb_hermes_design.md` | 本文档 |
# kb 后 v1.3 演进路线图（auto research 底座）

> 本文档是 v1.3 全面落地（见 `clustering_pipeline.md`）之后，从"auto research 底座"框架层目标出发，对当前 kb 自动聚类管理的缺陷盘点 + 外部项目借鉴清单 + 推进优先级。
>
> 配合阅读：
> - `knowledge_base_v1.3_design.md`（v1.3 设计意图）
> - `clustering_pipeline.md`（v1.3 + framing 升级后的实际落地状态）
> - 本文档（在已落地基础上识别下一步）
>
> 编制日期：2026-05-07
> 编制语境：kb 已完成 v1.3 重写 + 层级聚类 + 双层 LLM 介入 + op_log 软锁。物理基底（UMAP/HDBSCAN）+ LLM 评注层 + 审计三件套已搭好。下一阶段问题是：怎么把"被动收纳"演进为"auto research 底座"。

---

## 一、定位与判断框架

kb 的长期目标是作为多 Agent 共享 + 自动研究循环的底座。在这个 framing 下评估缺陷的标尺有三条：

1. **是否支持多 Agent 通过统一接口共享同一份知识**
2. **是否能闭合 auto research 的"思考 → 发现空白 → 主动研究 → 摄入 → 再思考"循环**
3. **synthesis / thinking / lint / 图谱洞察这些机制是否能用同一套基础设施承载，避免分裂成多个独立子系统**

借鉴外部项目的功能时，先用 kb 核心 framing（"知识为主语 + synthesis 为评注 + 信号驱动 + 三范式 gate + 统一 tool 接口"）重新映射，再讨论落地。不照搬 UI 形态。

---

## 二、当前 framing 层缺陷盘点

### 缺陷 1：LLM 评注层是"被触发的"，不会主动发现空白

**现状**：cluster_review 在 weekly job 里被 selectClustersForReview 选中才跑；wrong_cluster handler 等用户 flag。

**缺位**：auto research 底座要的是"思考 → 发现空白 → 主动研究"循环。当前 KB 没有"主动识别 cluster 中缺什么 center / 缺哪个 sub-topic / 缺什么 source"的入口。

**已知约束**：实战中发现 LLM 在 cluster_review 倾向"和稀泥"，prompt 改严帮助有限（见 `project_clustering_evolution.md` 决策 3）。这暗示需要的不是更狠的 prompt，而是把"发现空白"从 LLM 自由判断转成**结构信号驱动**（如 cluster 内 center=0 + N≥5 → 标 hub_gap）。

---

### 缺陷 2：聚类有空间层级，但没有时间维度

**现状**：computeClusterHierarchy 给了"外层语境"（parent_cluster_id）。

**缺位**：cluster 在 auto research 中应该有生命阶段：

| 阶段 | 信号 |
|---|---|
| 探索期 | noise 多 / 低 cohesion / 频繁 move |
| 成型期 | 有 center / cohesion 上升 / 进入 weekly review |
| 沉淀期 | reference_count 稳定 / cluster_review.l0 不再变 |
| 衰减期 | 长时间无新成员 / 检索命中下降 |

drift 检测把演化当"漂移告警"，没把它当**正向信号**——cluster 进入新阶段应该触发不同 LLM 介入策略。

---

### 缺陷 3：hub_role 是单向的——"已成型的中心"，缺"应成为中心但还没生出来"

**现状**：center 是"识别既有思考产物"。

**缺位**：**hub_gap signal** 是 first-class 信号——cluster 内 center=0 + member≥N。能被外部 Agent 订阅，转成"去研究/写一篇能当 center 的笔记"任务。

**意义**：这是把 KB 从"被动收纳"转成"主动 research 底座"的最小钩子。

---

### 缺陷 4：跨簇侧链丢了（v1.2 cross_cluster_relations 删除后）

**现状**：只有"完全分簇 OR 完全合簇 OR 同父簇"三态。

**缺位**：中间态——两个 cluster 共享一个 sub-topic 但合并不合理——没有表达。

**影响**：检索阶段做多簇 top-K 扩展是按距离，没有"语义桥"，跨簇召回质量受限。

**注意**：v1.3 删 similarity_edges 是有意决定，本缺陷不是"恢复 v1.2"，而是问：在 v1.3 framing 下，跨簇语义桥应该用什么形态承载（synthesis.sources 跨簇？专门的 lateral_link 类型？还是 cluster_review 中的引用？）。

---

### 缺陷 5：LLM 输出质量没有反馈闭环

**现状**：cluster_review 写完即结束。move_out 提议被消费 / wrong_cluster 用户 flag 都是**结果级**反馈。

**缺位**：cluster_review 本身好不好（判断准确率、move_out 命中率）没被记账，更没回到 prompt / 选簇策略上。

**framing**：这是 LLM 介入点的"自我评判"层缺位。

---

### 缺陷 6：多 Agent 接口还是空的

**现状**：
- `registered_agents` 表已建，admin tool 未接
- external agents 仍走 `config.external_agents` 旧路径
- bus 事件流没覆盖结构性变更（hub_role_upgraded / cluster_split / hub_gap_detected）

**缺位**：auto research 多 Agent 共享同一份知识的目标——接口侧还没真正打开。

---

### 缺陷 7：noise 救援是"找最近 cluster"，没有"种子聚类"路径

**现状**：rescueNoiseNodes 只把 noise 归到现有 cluster。

**缺位**：5 个 noise 节点如果在嵌入空间互相接近，应该升级为**新生 cluster**（embryonic cluster）——这是新研究方向涌现的信号。

monthly fullRecluster 间接处理，但 LLM 不在这条路径上做"涌现判断"。

---

### 缺陷 8：LLM 推理路径没保留

**现状**：on_ingest 两步思维链、cluster_review 四段式都是结构化输出。

**缺位**：中间"为什么这么判"的 reasoning trace 不在 op_log 里。审计、debug、未来 Agent 复用都只能看结论。

---

## 三、外部项目借鉴清单（已做 kb framing 重映射）

每个条目格式：原项目做什么 → kb 已有的对应 → 映射缺口 → 在 kb framing 下怎么落地。

### A. Microsoft GraphRAG（层级摘要 + global/local query）

- **它做的**：Leiden 社区检测 → 多层 community → 每层 LLM summary → 检索时按问题抽象度选层。
- **kb 已有**：computeClusterHierarchy（一层父簇）+ cluster_review。
- **映射缺口**：检索阶段缺"按 query 抽象度选层级"。当前三阶段检索是 l1 距离 + 多簇 top-K，但 query "推荐系统赛题整体思路" vs "HSTU 具体参数" 应该击中不同层 cluster summary。
- **落地路径**：cluster_review.l0 是父簇级 summary，consolidation 是 leaf 级，可以加一条 "query 抽象度路由"——LLM 判 query 的抽象度，对应选 cluster_review vs consolidation vs raw l1。

### B. Mem0（memory operations 抽象）

- **它做的**：每条新信息走 ADD/UPDATE/DELETE/NOOP 四种 op，由 LLM 决定。
- **kb 已有**：op_log + 不做自动 dedupe（用户硬决策，见 `project_clustering_evolution.md` 决策 2）。
- **映射借鉴**：op_log 已经是这个抽象。Mem0 那种 LLM-driven op decision 对应 kb 的 on_ingest 第一步——但 on_ingest 现在只判 hub_role 不判 op。
- **落地路径**：on_ingest 扩展为"LLM 看新节点 + 邻居后建议 ADD 还是 SUPERSEDE 既有节点"，**不自动执行**，进 flag_queue。这是用户主动 dedupe 路径的 LLM 助攻，符合"系统只做无破坏性的自动操作"边界。

### C. LangMem / Letta（前 MemGPT）的 sleep-time consolidation

- **它做的**：闲时把 episodic memory 重放、抽离重要片段升级为 semantic memory。
- **kb 已有**：weekly review + monthly fullRecluster 是粗粒度的。
- **映射缺口**：缺"重放"信号。当前 selectClustersForReview 优先级是 friction + 新成员 + stale + 没 review 过——但不看**最近被 query/检索命中频率**。
- **落地路径**：被反复检索的 cluster 是"工作记忆热点"，应该优先 review。query_log 已存在，缺的只是这条选簇维度。

### D. DSPy / TextGrad（trace-based prompt optimization）

- **它做的**：LLM 调用结果 + 用户反馈 → 自动优化 prompt / pipeline。
- **kb 缺位**：cluster_review 准确率没被学习（对应缺陷 5）。
- **映射借鉴**：不必上 DSPy 全套。
- **落地路径（最小可行）**：给每条 cluster_review.review_judgments 加 outcome 字段（用户后续是否 flag 了同一节点为 wrong_cluster / move_out 提议是否被消费）→ 累计指标 → 当某模式 review 持续低质量时降级该 cluster 的 review 频率，或换严格模式 prompt。

### E. Anthropic Contextual Retrieval（嵌入前 LLM 注入上下文）

- **它做的**：chunk 嵌入前，LLM 看 chunk + 全文，生成 60 tokens 的"这个 chunk 在文档里是谈什么"前缀，再嵌入。
- **kb 已有**：l0/l1 是节点级摘要。
- **映射缺口**：l0/l1 是"节点对自己的总结"，不是"节点在 cluster 中的位置"。
- **落地路径**：节点摄入后，除 l0/l1 外再生成"在 cluster X 中谈了什么"的 cluster-aware contextualized summary，单独嵌入。检索时按 cluster-context 命中可以解决跨簇相似但实际不同 framing 的混淆。代价：每节点多 1 次 LLM + 1 个嵌入向量，对 kb 稳态成本可接受。

### F. OpenAI Deep Research / Agentic Research Loop

- **它做的**：plan → search → read → synthesize → identify gap → re-search 闭环。
- **kb 框架对应**：当前是单向"摄入 → 整理"，缺 outer loop。
- **映射约束**：不在 kb 内造研究 loop（用户偏好不照搬 UI/形态）。
- **落地路径**：把 kb 暴露成"gap signal 源"——hub_gap、low_cohesion_cluster、orphan_cluster_review 三个信号通过 bus 推给外部 research Agent，让 Agent 决定怎么填。这正是 `registered_agents` 接口该承担的 framing。

### G. HippoRAG / 海马体启发图谱检索

- **它做的**：personalized PageRank on knowledge graph + neural-symbolic 混合。
- **kb 当前**：检索是嵌入 KNN + cluster top-K 扩展，没用图结构（wikilinks / synthesis sources / hub-leaf 关系）。
- **映射缺口**：图结构信号在检索时没被用上。
- **落地路径（最小动作）**：检索阶段 3 加一步——从 top-K 命中节点出发，沿 hub-leaf / synthesis.sources 边做 1-hop 扩展（带衰减），把"图结构相邻"作为 rerank 信号。跟"知识为主语 + synthesis 为评注"framing 一致——synthesis 的 sources 边本来就是图边。

---

## 四、推进优先级

按"贴 auto research 底座目标 + 落地代价"双维度排，优先推这三件：

### 优先级 1：hub_gap signal + bus 事件流（缺陷 3 + 缺陷 6 + 借鉴 F）

- **为什么**：把 KB 状态变化变成可订阅事件，是多 Agent 协同的最小钩子。
- **范围**：定义 hub_gap / cluster_evolved / hub_role_upgraded 等事件 + bus 推送 + registered_agents 订阅接口。
- **不做**：不在 kb 内实现"主动研究"——只暴露信号，外部 Agent 决定动作。

### 优先级 2：query-frequency 选簇维度（缺陷 1 + 借鉴 C）

- **为什么**：已有 query_log，加一条选簇优先级即可，把 review 从 stale 驱动转成热点驱动。
- **范围**：selectClustersForReview 增加 "最近 N 天检索命中频率" 维度 + 权重调参。
- **代价**：极小，不动 schema。

### 优先级 3：图结构 1-hop rerank（借鉴 G）

- **为什么**：检索质量直接受益，且复用现有 hub-leaf / sources 边，不增基础设施。
- **范围**：search.ts 三阶段检索的最后一步加 1-hop 扩展 + 衰减加权。
- **代价**：检索延迟微增，准确率应可观提升。

### 后续候选（前三跑通后再评估）

- 缺陷 4（跨簇侧链）：framing 上要先想清楚 v1.3 下用什么形态承载
- 缺陷 5 + 借鉴 D（trace-based prompt opt）：等 cluster_review 稳定运行有数据后再上
- 缺陷 7（embryonic cluster）：跟 fullRecluster 改造一起做
- 缺陷 8（reasoning trace）：跨多个 LLM 介入点的统一改造，等接口层稳定后做
- 缺陷 2（cluster 时间维度）：比较重，需要先有运行数据支撑设计
- 借鉴 A（GraphRAG query 抽象度路由）：依赖优先级 3 完成后的检索改造
- 借鉴 B（Mem0 op suggestion）：依赖 on_ingest 改造，跟缺陷 8 一起做合适
- 借鉴 E（Contextual Retrieval cluster-aware embedding）：稳态成本可接受但是基础设施动作较大

---

## 五、不做事项（明确边界）

避免后续讨论时再被反复带回：

1. **不做自动 dedupe / 自动 archive 等破坏性操作**（用户硬决策）
2. **不依赖 LLM 主动挑刺**（实战验证 alignment 偏向"和稀泥"，prompt 改严帮助有限）
3. **不在 kb 内实现 research outer loop**（用户偏好不照搬，研究 loop 由外部 Agent 承担）
4. **不恢复 v1.2 增量代码**（review_queue / similarity_edges / outlier / cross_cluster 已删，不回退）
5. **不再做 v1.3 设计稿的平铺单层 cluster**（已升级为层级 + 双层 LLM 介入）

---

## 六、文档位置

| 用途 | 文件 |
|---|---|
| v1.3 设计意图 | `docs/knowledge_base_v1.3_design.md` |
| v1.3 + framing 升级实际状态 | `docs/clustering_pipeline.md` |
| 后 v1.3 演进路线（本文档） | `docs/auto_research_roadmap.md` |
| v1.0 实施计划（历史参考） | `docs/kb_v1.0_implementation_plan.md` |

---

**文档结束**

# kb 聚类流程（v1.4 working_set framing 实际状态）

> 本文档是当前可运行系统的事实描述，对照 `docs/clustering.md`（v1.0/v1.2 历史）和 `docs/knowledge_base_v1.3_design.md`（v1.3 设计意图）阅读。
>
> 关键变化：v1.3 设计稿是平铺单层 cluster + 单签 hub 选举；v1.4 framing 升级后 cluster = working set（项目/语境单元），子主题通过 hub_role=center anchor (sub-hub) 在簇内呈现，不再通过拆分 cluster 表达。本文以 `docs/handoff_2026_05_11.md` 和当前代码实现为准。

---

## 一、整体 framing：v1.4 working_set

### 1.1 cluster = working set

一个 cluster 代表一个**项目 / 语境单元（working set）**，不是一个细粒度主题组。例如「TAAC 2026 推荐赛题」下的 22 篇文档形成 1 个 cluster，而不是被强行拆成 7 个。

### 1.2 子主题通过 sub-hub anchor 表达

cluster 内部的子主题方向**不通过拆分 cluster（split）表达**，而是通过 `hub_role=center` 节点（sub-hub anchor）在 working set 内部呈现。前端 `computeSubclusterAnchors` 把成员按 cosine 归到最近的 center，渲染成 sub-hub 气泡。

### 1.3 双层分工

```
┌──────────────────────────────────────────┐
│   LLM 评注层（cluster-level 元判断）       │
│   - cluster_review (含 sub_theme_recs)    │
│   - hub_recommendation                    │
│   - move_out (可 target_cluster_id='new') │
│   - computeClusterHierarchy (罕用)        │
└──────────┬───────────────────────────────┘
           │ 修正回灌（受 30 天软锁保护）
           ▼
┌──────────────────────────────────────────┐
│   涌现物理层（node-level 信号）            │
│   - hub_role (on_ingest + review 推荐)   │
│   - HDBSCAN+UMAP 聚类                    │
│   - 嵌入余弦距离                          │
└──────────────────────────────────────────┘
```

**核心 framing 原则**：

1. **物理层是涌现基础**：HDBSCAN 在 embedding 空间形成密度簇，小 N(<80)/高同质化场景常全 noise，此时 cold_start_cluster（LLM working_set 分簇）承担主分簇职责
2. **LLM 评注层是修正 + 子主题识别**：cluster_review 推荐 hub、标记 sub_theme anchor、提出 move_out
3. **30 天软锁**：LLM/user 对节点 cluster 的手动修正，30 天内不被 fullRecluster 推翻
4. **子主题不拆 cluster**：从不 propose split；通过 sub_theme_recommendations + hub_role=center 表达内部方向

---

## 二、完整流水线（以一篇新笔记为例）

```
                             ┌─ raw markdown
                             │
                             ▼
   ① 摄入 (storage.createNode)
      → 写文件 + SQLite row + git commit
      → bus 发 node_created 事件
                             │
                             ▼
   ② summarize (LLM)
      → MiMo 生成 l0 (≤200字) + l1 (≤700字)
      → 写回 frontmatter
                             │
                             ▼
   ③ embed (bge-m3)
      → embedding(l0) → e_l0_id (HNSW)
      → embedding(l1) → e_l1_id (HNSW)
      → 写 nodes.embedded_at
                             │
                             ▼
   ④ incrementalAssign (centroid + KNN fallback)
      → 找最近 cluster centroid
      → sim ≥ 0.65 → 直接归入
      → 0.50-0.65 → KNN 邻居 60% 投票
      → < 0.50 → noise (cluster_id NULL)
                             │
                             ▼
   ⑤ on_ingest LLM (两步思维链)
      → 第一步：判 hub_role + relations_to_neighbors + should_synthesize
      → 设置 hub_role (op_set_hub_role)
      → 第二步：可选生成 consolidation (受 compactness 限制)
                             │
                             ▼
   节点入流水线完成

   ─────────────────────── 周期性维护 ───────────────────────

   weekly (CRON_WEEKLY = 每周日 4:00)
      ┌→ cold_start_cluster (仅 0 簇 + N=2~80 时)
      │  → LLM 看所有 l0+l1 直接输出 working_sets + sub_themes
      │  → 每个 sub_theme anchor 自动升级为 hub_role=center
      │
      ├→ selectClustersForReview (≤3 个 cluster)
      │  → 优先：从未 review 过 (+100 分)
      │  → 然后：friction_count + 新成员 + stale
      │
      ├→ generateClusterReview (working_set 视角)
      │  → LLM 看完整 cluster 成员
      │  → 输出 review_payload {
      │      review_judgments: [...],
      │      hub_recommendation: {proposed_hub_uuid, reasoning},
      │      sub_theme_recommendations: [{label, anchor_uuid, confidence, reasoning}]
      │    }
      │
      ├→ snapshotClusters (drift 检测基线)
      │
      ├→ recomputeHubs (核心 LLM 修正回灌)
      │  → 选 hub = LLM 推荐 (优先级最高)
      │  → 若推荐 hub_role != 'center'
      │     → auto op_set_hub_role 升级到 center
      │     → 写 op_log + 受 30 天软锁保护
      │
      ├→ consumeSubThemeRecommendations (v1.4)
      │  → high+共识(≥2次) → auto setHubRole(center)
      │  → high/medium 新推荐 → flag_queue 待人工决策
      │  → low → 仅记录在 review payload 中
      │
      ├→ recomputeSynthesisDerivedState
      │  → synthesis 的 cluster_id 重新派生
      │  → cluster_review 的 validation_status 重算
      │
      ├→ multi-center 信号检测 (≥4 center 且 >60% 成员 → flag_queue)
      │
      ├→ rescueNoiseNodes (weekly 也跑，不等月度)
      │
      └→ 完成

   monthly (CRON_MONTHLY = 每月 1 日 5:00)
      ┌→ fullRecluster (HDBSCAN+UMAP)
      │  → 30 天软锁：跳过最近 LLM/user move 的节点
      │  → tiny-N 路径：N<10 跳过 UMAP 直 HDBSCAN
      │  → 全 noise 保护：HDBSCAN 全 noise 时保留现状
      │  → 全 noise + active 簇偏少 → 写 cluster_friction flag
      │     (建议人工使用 reset_clusters_and_recluster 重聚类)
      │  → GC 写入 cluster_status_change op_log
      │
      ├→ rescueNoiseNodes (LLM 兜底)
      │  → 对每个 noise 节点
      │  → LLM 看节点 l1 vs 各 cluster 描述
      │  → 自动归类，写 op_log
      │
      ├→ recomputeHubs + recomputeSynthesisDerivedState
      │
      ├→ computeClusterHierarchy (LLM 元聚类, v1.4 罕用)
      │  → 看所有 cluster 的 description + cluster_review.l0
      │  → 判断它们是否共享外层语境
      │  → 形成虚拟父簇 (parent_cluster_id)
      │  → 前端仅当 ≥2 子簇时才渲染父层
      │
      ├→ 归档 60 天 reference_count=0 的 synthesis
      │
      └→ 完成

   background (CRON_BACKGROUND = 每 15 分钟)
      ┌→ 处理 flag_queue.specific_issue
      │  → wrong_cluster: LLM 判最适合的 cluster + op_move
      │  → duplicate / outdated: archive
      │  → sub_theme 推荐: 等待用户决策（human-in-the-loop）
      │
      ├→ 消费 cluster_review 的 move_out 提议
      │  → high confidence + target_cluster_id='new'
      │     → 调 createNewWorkingSetForNode (KNN+LLM 小范围分簇)
      │  → high confidence + target_cluster_id=number
      │     → 沿用 wrong_cluster 校验 + op_move
      │  → high (无目标) → wrong_cluster LLM 选簇
      │  → medium → 留 flag_queue 等人工
      │
      └→ 完成
```

---

## 三、LLM 在聚类的全部介入点（按 token 消耗排）

| 介入点 | 触发 | 输入 | 输出 | 频率 | 单次 tokens |
|---|---|---|---|---|---|
| **summarize** | 节点摄入 | body 前 6000 字 | l0 + l1 | 每节点 1 次 | ~3.6K |
| **on_ingest 第一步** | embed 完成 | 节点 l0/l1/body excerpt + 8 邻居 l1 | hub_role + relations + should_synthesize | 每节点 1 次 | ~3.8K |
| **on_ingest 第二步** | should_synthesize=true | 3 个相关邻居 l0/l1/body | consolidation 三段式 | 部分节点（多被 too_long 拒） | ~4.2K |
| **cold_start_cluster** | 0 簇 + N=2~80 | 所有节点 l0+l1 | 簇划分 + 中文 label | 仅冷启动一次 | ~3.4K |
| **rescueNoiseNodes** | monthly 跑完 | noise 节点 l1 + 各 cluster 描述 | cluster_id + reason | 每个 noise 1 次 | ~1.4K |
| **generateClusterReview** | weekly | 簇内全部成员 l1 + 当前 hub + 前任 review | 四段式 + review_judgments + hub_recommendation | 每周 ≤3 次 | ~5.5K |
| **wrong_cluster handler** | flag_queue | 节点 l1 + 各 cluster 描述 | 目标 cluster_id | 用户/auto trigger | ~1.4K |
| **computeClusterHierarchy** | monthly | 所有 cluster 描述 + cluster_review.l0 | 父簇分组 | 每月 1 次 | ~3K |

**典型月成本**（100 节点 KB）：
- summarize: 100 × 3.6K ≈ 360K（一次性）
- on_ingest: 100 × 4K ≈ 400K（一次性）
- weekly: 4 cluster × 5.5K × 4 周 ≈ 88K
- monthly: rescue + hierarchy ≈ 10K
- **稳态月开销 ≈ 100K tokens**（不含初次摄入）

---

## 四、物理层算法细节

### 4.1 incrementalAssign（实时归类）

```
输入：新 raw 节点 uuid
输出：cluster_id (number | null), strength (0-1)

算法：
  1. 拿 e_l1 向量
  2. 对每个 active cluster 算 cosine(节点, cluster.centroid)
  3. 取最大相似度 bestSim
  4. if bestSim ≥ 0.65:
       归入 bestCluster, strength=bestSim
       refreshClusterCentroid + bumpClusterLastNewMember
       return
  5. elif bestSim < 0.50:
       return null (noise)
  6. else (0.50 ≤ bestSim < 0.65):
       KNN top-20 邻居在 e_l1 上
       投票最多的 cluster_id
       if voteStrength ≥ 0.6:
         归入, strength=voteStrength
       else:
         return null (noise)
```

设计取舍：
- **0.65 阈值**：高于这个判定为强相似，直接归入
- **0.50 阈值**：低于这个连兜底投票都不做，留 noise 给 LLM 处理
- **KNN 兜底**：解决 centroid 是平均向量、对边缘成员判断不准的问题

### 4.2 fullRecluster（月度全量重聚）

```
输入：无（扫所有 active raw + l1 向量）
输出：{ assignments, clusters, locked }

软锁层（30 天保护）：
  查 op_log 最近 30 天的 'move' 操作
  对应节点 → 排除出 HDBSCAN 输入，保留原 cluster_id

tiny-N 路径（N < 10）：
  跳过 UMAP（避免 scipy.eigsh 在小 N 时崩）
  HDBSCAN 直接吃原 e_l1 向量

UMAP 路径（N ≥ 10）：
  n_neighbors = min(15, N-1)
  n_components = min(50, N-2)  ← N-2 防 spectral_layout k>=N 错误
  metric=cosine, min_dist=0
  
HDBSCAN：
  min_cluster_size = adapted (clamp to N/8 floor=3)
  metric=euclidean
  cluster_selection_method=eom

全 noise 保护：
  if HDBSCAN 把所有节点判 noise:
    保留现有 cluster_id 不变  ← 防止 cold_start 形成的簇被冲掉
    return

否则：
  UPDATE nodes.cluster_id 按新 labels
  upsert clusters 表
  refreshClusterCentroid 每个 cluster
```

参数自适应（`adaptParamsForN`）：
- 默认 hdbscan_min_cluster_size=12（稳态）
- N=20 时 → adapted 到 3，避免冷启动全 noise

### 4.3 cold_start_cluster（LLM working_set 分簇）

v1.4 两阶段 working_set framing：cluster = 项目/语境单元，子主题通过 sub_theme anchor (hub_role=center) 表达。

**输入**：所有 active raw 节点的 l0_summary + l1_overview
**输出**：
```json
{
  "working_sets": [{
    "label": "<2-8 汉字项目名>",
    "reasoning": "...",
    "member_uuids": [...],
    "sub_themes": [
      { "label": "<子主题名>", "anchor_uuid": "<member 中 uuid>" }
    ]
  }]
}
```
**持久化**：每个 working_set 建 1 个 cluster 行；每个 sub_theme anchor 调 setHubRole(center) + 写 op_log。

**边界**：仅 0 active cluster + N=2~80 时触发；>=1 个 active cluster 时跳过。如需强制重跑，使用 admin tool `reset_clusters_and_recluster`。

### 4.4 rescueNoiseNodes（HDBSCAN noise 救援）

```
触发：fullRecluster 跑完后

对每个 cluster_id IS NULL 的 active raw 节点（最多 maxBudget=20）:
  prompt LLM:
    - 节点 l0 + l1
    - 各 active cluster 的 description + 5 个代表 l0
    - 判断它最该归到哪个 cluster
    - 只有完全跨主题才返回 -1
  
  if LLM 返回有效 cluster_id:
    setClusterAssignment + refreshClusterCentroid
    op_log: 'extract' kind='noise_rescue'
```

### 4.5 推荐设置（调优建议）

| 参数 | 默认 | 含义 | 调整方向 |
|---|---|---|---|
| `hdbscan_min_cluster_size` | 12 | HDBSCAN 簇最小成员数 | 自适应到 max(3, N/8) |
| `hdbscan_min_samples` | 5 | HDBSCAN 噪声敏感度 | 通常不调 |
| `umap_n_neighbors` | 15 | UMAP 局部 vs 全局 | 越大越保留全局 |
| `umap_n_components` | 50 | UMAP 降维目标维 | 30-50 都可 |
| `compactness_hard_max` | 0.6 | consolidation 长度上限 | 太严会拒掉正常 consolidation，可调 0.8 |
| `review_max_clusters_per_week` | 3 | weekly 一次最多 review 几个 cluster | cluster 多时调 5+ |
| `review_min_weeks_since_last` | 4 | cluster review 间隔 | 不频繁触发可调小 |

---

## 五、Hub 选举逻辑（升级后）

```
对每个 active cluster c：

  1. 拿 cluster_review.hub_recommendation.proposed_hub_uuid
     (LLM 看了完整 cluster 后的 cluster-level 判断)
  
  2. 验证：该节点是 c 内的 active raw
  
  3. 采纳为 hub  ← LLM 元判断有最高优先级
  
  4. 如果该节点的 hub_role != 'center':
     auto op_set_hub_role: <原> → 'center'
     reason: "cluster_review hub_recommendation: cluster-level 
              judgment overrides on_ingest single-doc judgment"
     op_log 记录 + 受 30 天软锁保护
  
  fallback 1: 没有 LLM 推荐 / 推荐节点不在 cluster 内
    → hub_role='center' 候选中 created_at 最早的 raw
  
  fallback 2: cluster 内无 hub_role='center' 节点
    → 该 cluster 的 cluster_review synthesis 节点本身当 hub
    (hub_source='synthesis_calculated', 在前端显示为红色菱形)
  
  fallback 3: 都没有
    → hub_uuid = NULL (前端不显示该 cluster 的中心点)
```

**为什么这套逻辑合理**：
- LLM 元判断有最高权威，因为它看了完整 cluster 上下文
- 但 LLM 的修正落到物理层（hub_role）+ op_log，不是孤立的"前端覆盖"
- 30 天软锁防止 fullRecluster 翻烧饼
- 即使 LLM 失败也有完整的 fallback 链

---

## 六、层级聚类（v1.4 罕用）

v1.4 working_set framing 下，大多数 working set 就是独立 cluster，父簇仅当多个独立 working set 共享更外层语境时才出现（罕用）。

### 6.1 schema

```sql
ALTER TABLE clusters ADD COLUMN parent_cluster_id INTEGER;
```

- `parent_cluster_id IS NULL` = 顶级簇
- `parent_cluster_id = N` = 该簇的父簇是 cluster N
- 父簇本身的 `member_count = 0`（不持有 raw 节点）

### 6.2 computeClusterHierarchy（LLM 元聚类）

月度任务：fullRecluster 完成后跑。输入所有 leaf cluster 的 description + cluster_review.l0，LLM 判断是否共享外层语境并形成虚拟父簇。

落库后，前端仅在父簇有 ≥2 个子簇时才渲染父层（GraphTab/NodesTab 均压平 single-child parent）。

### 6.3 sub-cluster anchor（前端层级展示）

后端 `/api/graph` 对每个非 hub raw 节点计算 `sub_anchor_uuid`：

```
对每个 cluster:
  cluster_hub = hub_uuid 节点
  sub_hubs = cluster 内 hub_role='center' 但不是 cluster_hub 的 raw
  
  if sub_hubs 为空:
    所有非 hub leaf 直接归 cluster_hub (前端显示为紫色 direct_member)
  
  else:
    每个 leaf 跟所有 sub_hub + cluster_hub 算 cosine
    归到最近的 anchor
    - 归到 sub_hub → 前端显示为绿色 sub_member
    - 归到 cluster_hub → 紫色 direct_member
```

前端层级展示：
- 父簇（KB）: 八边形深靛蓝
- cluster_hub: 红色大圆
- sub_hub: 黄色中圆
- sub_member: 绿色小圆
- direct_member: 紫色小圆
- virtual_sub_hub: 黄色虚线"?"圆（前端聚合 ≥3 direct_member 时）

---

## 七、所有 LLM 修正路径（用户视角）

| 用户动作 | 触发的 LLM 介入 | 系统响应 |
|---|---|---|
| 摄入新文件 | summarize → on_ingest 两步 | 自动设 hub_role + 可选 consolidation |
| `flag_specific_issue(wrong_cluster)` | wrong_cluster handler | LLM 判最适合 cluster → 自动 op_move |
| `flag_specific_issue(duplicate/outdated)` | background pass | 自动 archive |
| `flag_cluster_friction` | 累计 friction_count | 下次 weekly 优先 review |
| `op_split / op_merge / op_set_hub_role` | 触发 cluster_review 重生成 | 调用 chain regenerate |
| 手动 `synthesize_explicit` | LLM 生成 consolidation | 写一个 synthesis |

LLM 自动决策的：
- `cluster_review` 中的 `move_out` 高置信度提议 → 自动消费（background pass）
- noise 节点 → 自动 rescue
- LLM 推荐 hub 不是 center → 自动升级 hub_role

---

## 八、当前实战数据（21 节点示例）

```
🌐 父簇 #4「推荐系统赛题」(LLM 元聚类生成)
│
├─ cluster 0 「赛题策略」(6 成员)
│    hub: 25c98cc2 综合作战计划 (hub_role=center)
│
├─ cluster 1 「赛题元层」(8 成员)
│    hub: 8d7ad6b3 赛题主文 (hub_role 升级 leaf → center)
│
├─ cluster 2 「Scaling/HSTU」(5 成员)
│    hub: a1222571 HSTU baseline (hub_role=center)
│
└─ cluster 3 「字节腾讯架构对比」(3 成员)
     hub: c660dd2f HyFormer (hub_role 升级 neutral → center)
```

LLM 在这个 KB 上做的事：
- 21 次 summarize + 21 次 on_ingest（一次性）
- 1 次 cold_start_cluster（冷启动期）
- 4 次 rescueNoiseNodes（HDBSCAN 全 noise 之后）
- ~16 次 generateClusterReview（多次 weekly 触发）
- 2 次自动 hub_role 升级（cluster 1 / cluster 3）
- 1 次 computeClusterHierarchy（形成父簇）

**总 token ≈ 270K**（用 MiMo Flash → Pro 切换过）

---

## 九、跟 v1.3 设计文档的差异

`knowledge_base_v1.3_design.md` 写的是平铺单层 cluster + 单签 hub 选举。当前 v1.4 working_set framing 落地的是：

| 维度 | v1.3 设计稿 | v1.4 实际落地 |
|---|---|---|
| **cluster 语义** | 细粒度主题组 | working set（项目/语境单元） |
| **子主题表达** | 拆 cluster（k-means+silhouette, 未实施） | hub_role=center sub-hub anchor |
| **hub 选举** | hub_role=center + 字典序 | LLM cluster_review 推荐 (librarian_recommended) + raw_lexical_fallback + synthesis_calculated |
| **hub_source 值集** | raw_explicit / synthesis_calculated / none | librarian_recommended / raw_lexical_fallback / synthesis_calculated / none |
| **noise 处理** | 留给 monthly | LLM weekly + monthly rescueNoiseNodes |
| **fullRecluster 与 LLM 修正冲突** | 未定义 | 30 天软锁保护 |
| **fullRecluster 全 noise 信号** | 无 | cluster_friction flag（指向 reset_clusters_and_recluster） |
| **cluster status 变更审计** | 无 | cluster_status_change op_log |
| **review_judgments move_out** | 未消费 | background pass 自动消费 high, 支持 target_cluster_id='new' |
| **cluster_review** | hub_recommendation 仅 | + sub_theme_recommendations (confidence 三级消费) |
| **重聚类 admin 入口** | 无标准入口 | reset_clusters_and_recluster |
| **前端父簇渲染** | 始终渲染 | ≥2 子簇才渲染，single-child 压平 |

---

## 十、关键代码位置

| 功能 | 文件 |
|---|---|
| 主聚类管线 | `packages/core/src/clustering/clustering.ts` |
| - `incrementalAssign` | 同上 |
| - `fullRecluster` (含软锁、全 noise 信号、GC op_log) | 同上 |
| - `coldStartCluster` (v1.4 working_set 两阶段) | 同上 |
| - `resetClustersAndRecluster` (admin destructive reset) | 同上 |
| - `rescueNoiseNodes` | 同上 |
| - `recomputeHubs` (含 hub_role 自动升级) | 同上 |
| - `computeClusterHierarchy` (v1.4 罕用) | 同上 |
| - `computeSubclusterAnchors` | 同上 |
| Synthesis 生成 | `packages/core/src/synthesis/synthesis.ts` |
| - `generateClusterReview` (含 sub_theme_recommendations 解析) | 同上 |
| Cluster review prompts | `packages/core/src/synthesis/prompts.ts` |
| - `buildClusterReviewPrompt` (v1.4 working_set framing) | 同上 |
| Librarian 调度 | `packages/core/src/agents/librarian.ts` |
| - `runOnIngest` | 同上 |
| - `runOnReview` (含 consumeSubThemeRecommendations) | 同上 |
| - `runMonthly` | 同上 |
| - `runBackgroundPass` (含 move_out → new cluster) | 同上 |
| - `consumeSubThemeRecommendations` (三级消费) | 同上 |
| - `createNewWorkingSetForNode` (move_out 'new') | 同上 |
| - `handleSpecificIssue` (wrong_cluster handler) | 同上 |
| Admin tools | `packages/core/src/tools/admin_tools.ts` |
| - `reset_clusters_and_recluster` | 同上 |
| Flag queue (cluster_friction + sub_theme 待决策) | `packages/core/src/flag/flag_queue.ts` |
| 前端图谱 (single-child parent 压平) | `packages/frontend/src/panels/VisualizationPanel/GraphTab.tsx` |
| 前端节点列表 (single-child parent 压平) | `packages/frontend/src/panels/VisualizationPanel/NodesTab.tsx` |
| Python 子进程 (UMAP+HDBSCAN) | `packages/core/python/cluster.py` |

---

**文档结束**

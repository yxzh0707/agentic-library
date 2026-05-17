# KB — Agent-Oriented Knowledge Base

本地部署、面向 Agent 的、自组织的知识库。任何 Agent（Hermes / Claude Code / OpenClaw）通过标准 REST API 接入，获得语义搜索、深度分析、思考归档能力。

## 5 分钟启动

```bash
# 1. 安装
npm install -g @zyx0707/agentic-library

# 2. 配置（交互式，填入你的 LLM + Embedding API key）
agentic-library init

# 3. 启动
agentic-library start
# → http://localhost:7823
```

```bash
# 或者看当前配置
agentic-library config

# 导入文件
agentic-library import ./my-docs/

# 查看状态
agentic-library status
```

## 任何 Agent 三步接入

无论你用的是 Hermes、Claude Code 还是 OpenClaw，接入方式完全相同：

```bash
# Step 1: 注册 Agent，获取 api_key
curl -X POST http://localhost:7823/api/agent/create \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"my-agent","permissions":["read","write","structural","admin"]}'
# → {"agent_id":"my-agent","api_key":"kb_xxxx..."}

# Step 2: 了解 KB 全貌
curl -X POST http://localhost:7823/api/agent/invoke \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"my-agent","api_key":"kb_xxxx...","tool_name":"agent_onboarding"}'
# → 节点数、簇分布、最近 reflection、flag 队列、操作指南

# Step 3: 开始工作
#   suggest_context("我的任务是...") → 找相关节点和过去的思考
#   deep_analyze("某个问题")       → 搜索→阅读→遍历→综合节点
#   create_reflection(...)         → 把推理过程永久存回 KB
```

## 核心能力

| 工具 | 做什么 | Agent 什么时候用 |
|------|--------|-----------------|
| `agent_onboarding` | KB 全局快照 + 操作指南 | 首次接入 |
| `suggest_context` | 根据任务搜索 + 建议上下文 | 接到新任务时 |
| `deep_analyze` | 搜索→读→遍历→综合 | 需要深度分析时 |
| `create_reflection` | 把 CoT 推理轨迹存为 KB 节点 | 完成分析后 |
| `search_knowledge` | 三阶段语义检索 | 需要找相关资料时 |
| `traverse_graph` | 沿 wikilink 多跳遍历 | 探索节点关系时 |

完整工具列表：`POST /api/agent/list_tools`

## 它不是什么

- 不是 RAG 服务（不拼检索结果给你一段回答）
- 不是 Agent 对话记忆（它是跨 Agent、跨会话的持久知识）
- 不是项目管理工具（但它可以服务项目）

## 它是什么

一个**图书馆**：你往里存资料（raw 节点），图书管理员（librarian）自动分类、聚类、维护质量，咨询员（consultant）回答你的问题，你也可以把思考过程写回去（reflection 节点）供下次复用。

## 架构

```
Agent (Hermes / Claude Code / OpenClaw / ...)
  │
  ▼  REST API (port 7823)
  │
  ├─ Tool Layer (48 tools, 4 permission levels)
  │    ├─ Read:   search, read, traverse, onboarding
  │    ├─ Write:  create_raw, update, flag, submit_trace
  │    ├─ Structural: merge, split, move, synthesize
  │    └─ Admin:  revert, branch, batch_flags, cluster_desc
  │
  ├─ SQLite View Layer (nodes, clusters, op_log)
  ├─ HNSW Vector Index (e_l0 + e_l1 embeddings)
  └─ Librarian Agent (auto clustering, quality review, noise rescue)
```

## 依赖

- Node.js ≥ 20
- Python 3.10+（可选，用于聚类。如缺失，搜索/读写仍正常工作）
  - 如需聚类: `pip3 install umap-learn hdbscan scikit-learn numpy`

## 配置

`agentic-library init` 生成 `.env`:

```
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=sk-xxx
LLM_CHAT_MODEL=deepseek-chat
EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_API_KEY=sk-xxx
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIM=1024
KB_DATA_DIR=~/.agentic-library/data
```

## 安全

- Server 默认 bind 127.0.0.1
- Agent API key 存储在 `config.json`（明文——生产环境建议加反向代理和 HTTPS）

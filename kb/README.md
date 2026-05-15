# Knowledge Base v1.0

本地部署的、面向 Agent 的、自组织的知识库系统。

## 架构

```
knowledge-base/
├── packages/
│   ├── core/        # 后端:存储、嵌入、HNSW 索引、聚类(Python 子进程)、
│   │                #       synthesis 触发器、Agent、HTTP/WS server
│   ├── frontend/    # React 三面板 UI
│   └── shared/      # 前后端共享类型 + 常量 + API 契约
├── scripts/
│   └── smoke.ts     # 端到端冒烟测试
└── docs/
    └── kb_v1.0_implementation_plan.md
```

## 依赖

- Node.js >= 20
- pnpm 9+
- Python 3.10 + `umap-learn`, `hdbscan`, `scikit-learn`, `numpy`(用于聚类)

## 快速开始

```bash
pnpm install

# Python 依赖(聚类)
python3 -m pip install -r packages/core/python/requirements.txt

# 同时启动前后端
pnpm dev
```

后端默认监听 `127.0.0.1:7823`,前端 dev server 在 `http://localhost:5173`。

首次打开 web UI 会引导你填写 LLM 配置(base_url、api_key、chat_model、embedding_model、embedding_dim)。

## 数据目录

默认在 `~/Downloads/kb_main/`,可以通过环境变量 `KB_DATA_DIR` 覆盖。结构:

```
kb_main/
├── content/          # markdown 节点(扁平存储,UUID 前 2 字符分桶)
├── content_git/      # 内容文件的 git 仓库(.git)
├── indices/          # HNSW 索引文件(e_l0/e_l1/e_l2)
├── kb.sqlite         # 视图层 + op_log + query_log
├── config.json
└── kb.lock           # 进程锁
```

## 模块对应关系

| 模块 | 文件 |
|---|---|
| NodeStorage | `packages/core/src/storage/storage.ts` |
| OpLogService | `packages/core/src/op_log/op_log.ts` |
| EmbeddingService | `packages/core/src/embedding/embedding.ts` |
| IndexService | `packages/core/src/indexing/index_service.ts` |
| ClusteringService | `packages/core/src/clustering/clustering.ts` (+ `python/cluster.py`) |
| SynthesisService | `packages/core/src/synthesis/synthesis.ts` |
| ToolRegistry + tools | `packages/core/src/tools/*` |
| Consultant / Librarian | `packages/core/src/agents/*` |
| Scheduler | `packages/core/src/scheduler/scheduler.ts` |
| HTTP routes | `packages/core/src/server/routes.ts` |
| WS bus | `packages/core/src/events/bus.ts` |

## 验收 checklist

- [ ] 从零启动跑通 `scripts/smoke.ts`
- [ ] 三面板都能正确显示数据
- [ ] 修改配置能生效
- [ ] revert 不会破坏数据一致性
- [ ] 外部 Agent 能通过 `/api/agent/invoke` 调任意 tool
- [ ] 关闭再启动,所有数据保留

## 设计文档

完整设计见 `docs/kb_v1.0_implementation_plan.md`。

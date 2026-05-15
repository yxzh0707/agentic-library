---
type: entity
title: TAAC2026 数据格式
created: 2026-04-29
updated: 2026-04-29
tags: [数据格式, parquet, json, taac2026]
related: [huggingface-parquet, taac2026-kdd-cup-2026, taac2026-data-format]
sources: ["8d7ad6b3-c41d-4352-ad78-6c363ef7ddf8.md"]
---

# TAAC2026 数据格式

TAAC2026 赛题提供两种数据格式：官方原始格式（JSON 嵌套）和 HuggingFace Parquet 格式（扁平列）。

## 官方原始格式（JSON 嵌套）

- **序列数据**：单一 `seq` 数组，事件对象内联，包含 `item_id`、`action_type`、`timestamp`。
- **非序列特征**：每个特征是数组中的独立对象，通过 `feature_id` 和 `feature_value_type`（如 `int_value`、`int_array`、`float_array`）区分。

## HuggingFace Parquet 格式（扁平列）

- **文件**：`demo_1000.parquet`，共 120 列。
- **ID & Label**：5 列，包括 `user_id`、`item_id`、`label_type`、`label_time`、`timestamp`。
- **非序列特征**：70 列，包括用户整数特征（`user_int_feats_{fid}`）、用户稠密特征（`user_dense_feats_{fid}`）、物品整数特征（`item_int_feats_{fid}`）。
- **行为序列特征**：45 列，按 4 个行为域（Domain A/B/C/D）拆分，每列类型为 `list<int64>`，可能含 `null`。

## 格式差异对照

| 维度 | 官方 JSON | HuggingFace Parquet |
|------|-----------|---------------------|
| 结构 | 嵌套对象 | 扁平列 |
| 特征寻址 | `feature_id` 字段 | 列名直接编码 `fid` |
| 序列组织 | 单一 `seq`，混合所有域 | 按 4 域拆分为 45 列 |
| 序列字段 | `item_id`/`action_type`/`timestamp` 内联 | 分散到不同 `domain_x_seq_*` 列 |
| Context Features | 独立语义块 | 合并入 `user_int_feats_*` 或 `item_int_feats_*` |
| 类型信息 | `feature_value_type` 字段显式声明 | 由列名前缀隐式区分 |

## 数据加载示例

```python
import pandas as pd
from datasets import load_dataset

# 本地 parquet
df = pd.read_parquet("demo_1000.parquet")
print(df.shape)  # (1000, 120)

# HuggingFace
ds = load_dataset("TAAC2026/data_sample_1000")
sample = ds['train'][0]

# 访问各类特征
seq_a  = sample['domain_a_seq_38']   # list[int]，Domain A 序列
u_feat = sample['user_int_feats_48'] # int，用户整数特征
cross  = sample['user_dense_feats_61'] # list[float]，交叉稠密特征
label  = sample['label_type']        # int，目标标签
```
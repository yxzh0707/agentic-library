---
uuid: 019e34cc-f1ab-7ccb-8ca2-cb08a0b5ee65
node_type: raw
created_at: 2026-05-17T07:18:26.987Z
updated_at: 2026-05-17T07:22:27.799Z
created_by: human:default
created_by_run: import:markdown:track_b_prime_context_audit.md
l0_summary: 审计项目是否遗漏官方第四类Context Features，发现无显式列但可能存在隐含或截断风险。
l1_overview: 审计确认项目flat schema中无显式context列，但官方四类特征包含Context Features。vendor遗留代码使用单独context列但已废弃。两个假设：(H1) context已隐含在timestamp衍生特征中，部分实验已验证但效果有限；(H2) 生产数据可能有更多context列，但flat_reader的硬编码cap（max_user_int_feats=48, max_item_int_feats=16）会静默截断新列，导致特征丢失或覆盖现有特征。建议：在Taiji平台验证生产数据列数，或直接提高cap以防范。审计改变Track A设计：先提高reader cap再选择交叉特征集。
embeddings:
  e_l0_id: null
  e_l1_id: null
  e_l2_id: null
  model: null
  embedded_at: null
wikilinks: []
current_path: null
derived_state:
  cluster_id: null
  cluster_membership_strength: null
  is_cluster_hub: false
  hub_of_cluster: null
lifecycle:
  status: active
  reference_count: 0
  last_accessed_at: null
  superseded_by: null
  superseded_reason: null
---

# Track B' — Context Features Audit

**Trigger**: Post-MC-MLCC pivot, post-content-tower-feasibility=NO. User asked to verify whether the project is leaving the official 4th feature category (Context Features) on the table.

## What official says

`<PROJECT_ROOT>/docs/competition_original.md` paragraph:

> "non-sequential multi-field features grouped into four categories: User Features, Ads Features, **Context Features (sparse)**, and Cross Features (dense embeddings), all subject to privacy protection."

Four official categories. The project clearly handles User, Ads, and Cross-dense (the latter as `user_dense_feats_*`). Context Features is the open question.

## What our flat reader sees

`data/demo_1000.parquet` has 120 columns. Categorized:

| Group | Count | Fid set |
|---|---|---|
| META | 5 | `user_id, item_id, timestamp, label_type, label_time` |
| `user_int_feats_*` | 46 | 1, 3, 4, 15, 48-66, 80, 82, 86, 89-109 |
| `user_dense_feats_*` | 10 | 61-66, 87, 89-91 |
| `item_int_feats_*` | 14 | 5-13, 16, 81, 83-85 |
| `domain_a_seq_*` | 9 | — |
| `domain_b_seq_*` | 14 | — |
| `domain_c_seq_*` | 12 | — |
| `domain_d_seq_*` | 10 | — |

**Zero columns explicitly named `context_feature`, `ctx_*`, or similar.**

**Fid gap pattern** in the integer namespace: USED = {1, 3-13, 15, 16, 48-66, 80-87, 89-109}. GAP = {2, 14, **17**, 18-47, 67-79, 88}. These gaps could be where Context fids land in production data (if Context Features expand the fid namespace).

## What vendor (legacy 7-col schema) did

`vendor/TAAC_2026/config/gen/*/data.py` ALL expect a separate column `context_feature` as a list-of-struct in the 7-col nested schema:

```python
groups = (
    ("user", row.get("user_feature")),
    ("context", row.get("context_feature")),
    ("item", row.get("item_feature")),
    ("cross", row.get("cross_feature")),
)
```

And `_context_tokens_from_row` mixes the `context_feature` list with a derived `request_hour = (timestamp // 3600) % 24` signal. Vendor test fixture uses `fid 17` as a context feature example.

**But**: the 7-col nested schema is **deprecated** (per project's `docs/data_understanding_v2.md` and operating context). The official 120-col flat schema is the production format. Where context went during flattening is the open question.

## Two hypotheses (mutually compatible)

### H1: Context info already implicit, already explored

`timestamp` is in our flat data. Timestamp-derived signals are exactly what `_context_tokens_from_row` builds in the vendor code. The project HAS tried these:
- **I-617 dow onehot** → LB +0.000648 NEUTRAL+
- **I-616 v2 hour-of-day onehot** → LB -0.005 KILL
- **I-625 gap features** → LB +0.011 PROMOTE (this is the biggest single win in project history; gap features are a form of context — recency context)

→ If H1 is true, **time-context axis is mostly closed**, with `gap features` (I-625, already in the I-643 base) being the surviving win.

### H2: Production data has MORE columns (hidden context fids in the 4M data)

`docs/decision_log.md:61` flagged this 1 month ago: *"context_feature 字段可能在 parquet 中不存在"*. Never resolved.

**HARD GOTCHA discovered in this audit**:
```python
# src/data/flat_reader.py:33-34
max_user_int_feats: int = 48
max_item_int_feats: int = 16
```

And in `_detect_schema`:
```python
user_int_cols = _sort_feature_columns(column_names, USER_INT_PATTERN)[: config.max_user_int_feats]
```

**If 4M production data has more `user_int_feats_*` columns than 48 (or more `item_int_feats_*` than 16), they are SILENTLY DROPPED in alphabetical-by-fid order from the end.** Demo has exactly 46 user_int (fids up to 109 — sparse, sorted by fid ascending, last 46 selected). If production adds 14 more fids in the range 17-47 (currently gap region), they'd be silently truncated when our reader takes the top-48 by fid value.

Actually wait — re-read `_sort_feature_columns`: it sorts ASCENDING by fid, then takes the first `max`. So if production adds fids 17-30 as context, those LOW fids would BUMP OUT the existing high-fid columns (95-109). The model would silently lose features it currently uses. This would be a regression, not a gain.

→ If H2 is true, **the cap is a bug that could either silently miss context OR silently destroy existing features** depending on which way production adds columns.

## Concrete next-step decisions

The audit confirms **uncertainty about H2**. Two paths:

### Path P1 (zero-risk, takes 5 min on Taiji platform): Verify column count

Either user (with platform access) or me (using CLI scrape on a production job's data dir info) checks how many `user_int_feats_*` and `item_int_feats_*` columns exist in `/data_ams/academic_training_data`. If counts > 48 and 16 respectively, H2 is true and we have a critical issue.

### Path P2 (zero-risk, just decide): Update the reader cap

Even without verifying P1, update `max_user_int_feats` and `max_item_int_feats` to safer values (200 / 100) to be future-proof. Cost: 2 lines of code, defensive. Verify on demo it still works (will be a no-op since demo has 46/14, both under any reasonable cap).

### Path P3: If P1 confirms hidden context fids → design new experiment

If production has additional fids (say fids 17, 67-79, 88), they may be Context Features. Then Track A's ML-DCN cross set should include them as a NEW feature group, distinct from user_int / item_int.

## Audit verdict

- **No clear answer on whether the project is leaving Context features on the table.**
- **High-confidence finding**: `flat_reader.py:33-34` has a hardcoded cap that could silently drop or shadow production features. Even if Context features aren't a factor, the cap should be raised defensively.
- **Recommendation for Track A**: use what we have (user_int + item_int + user_dense as the cross set), but FIRST raise the reader cap so Track A's training picks up any hidden columns the cap was masking.

## What this audit changed about Track A's design

| Original Track A | Updated Track A |
|---|---|
| Cross over `user_int_feats + item_int_feats + user_dense_feats` (stable attributes only, no uid/item_id) | Same, BUT first raise reader cap `max_user_int_feats: 48 → 256` and `max_item_int_feats: 16 → 64` so any production fids beyond demo's 46/14 actually flow in. After cap raise, RE-RUN data sanity check to confirm no regression. |

This 2-line change adds **near-zero cost** but recovers any cap-masked features as a free side benefit before the bigger ML-DCN cross work.


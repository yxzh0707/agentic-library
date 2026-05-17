---
uuid: 019e34cc-f1a7-7ccb-8ca2-aedd0c826df5
node_type: raw
created_at: 2026-05-17T07:18:26.983Z
updated_at: 2026-05-17T07:22:21.764Z
created_by: human:default
created_by_run: import:markdown:report.md
l0_summary: I-668提案预检查：内容塔替代物品ID嵌入，属于架构轴改动，有论文支持但因时序冲突与数据风险建议暂缓。
l1_overview: 报告对I-668（内容塔）进行预检查，判定其不属于已封闭的物品ID嵌入轴，而是架构轴，当前有两项架构轴实验（I-665/I-666）正在运行。五篇2025–2026年工业论文支持该机制，但存在三个阻塞点：与I-665/666的GPU资源竞争；3–7天的工程成本是常规实验的5–10倍；数据匿名化可能无法提供可编码的物品文本/内容，需先验证。因此推荐RISKY，建议等待MC-MLCC结果并确认数据可行性后再决定升级为GO。
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

# Deep Search Report — Precheck I-668

## Context

- Subcommand: `precheck`
- Input: `I-668 add content-tower for item OOV`
- Mode: `local-only` (Gate A not re-triggered — fresh paper evidence already in repo from 13:14 BJT inquiry)
- Output directory: `<PROJECT_ROOT>/docs/research/deep_search/20260513-1322_precheck_I-668/`
- Run timestamp: 2026-05-13 13:22 BJT
- Skill version: v0 + Year Freshness Rule patch (commit `990252e`)

## Axis Classification

Proposed mechanism: replace item-id embedding with a content-derived dense vector (text encoder / multimodal embed). This is the architectural pattern surfaced 8 minutes earlier in `<PROJECT_ROOT>/docs/research/deep_search/20260513-1314_inquiry_item_oov_papers/`.

Axis assignment (avoid the trap of treating "anything touching item_id" as item-id-axis-closure):

- **`item-id-feature` axis**: closed for mechanisms that **DEPEND on** the learned item-id lookup (I-608 sparse hash, I-635 dense item heat). Content-tower **REPLACES** item-id with content; it does not depend on the lookup. **Closure mechanism does not apply.**
- **`architecture-replacement` axis**: untested. Per `<PROJECT_ROOT>/docs/active_state.md:128`, architecture-axis = ⚪ untested. I-665 / I-666 (MC-MLCC LocalCompressor) are the FIRST architecture-axis attempts and are still RUNNING.

## Evidence

### Closed-axis rule does NOT apply

- `<PROJECT_ROOT>/docs/active_state.md:151` — "Dense projection on seq-internal time = +EV (+0.006 demonstrated). High-card sparse new embedding = -EV (item_id_hash 0.0). Wave 3 must use dense projection family."
  - Content-tower output IS a dense projection. Aligns with the allowed direction.
- `<PROJECT_ROOT>/docs/active_state.md:28,47,61` — I-608 + I-635 KILL root cause: they DEPEND on item-id lookup that misses at inference. Content-tower has no such lookup. Structural difference is decisive.

### Architecture-axis context

- `<PROJECT_ROOT>/docs/handoff_2026-05-13.md:13-14` — "Feature-axis stacking on I-643 has been exhausted (12+ KILL). Architecture-axis is now the only remaining lever. Two architecture-axis jobs are training right now."
- `<PROJECT_ROOT>/docs/handoff_2026-05-13.md:23` — "If both KILL <0.823, architecture-axis is also closed and the only remaining option is **full-backbone replacement (OneRec/HSTU, 2-3 day effort)**." **Content-tower replacement is in this tier of move**.

### Paper-prior support (just-verified, ≥2025)

From `<PROJECT_ROOT>/docs/research/deep_search/20260513-1314_inquiry_item_oov_papers/external_research.md` (all 5 verified by WebFetch, 0 hallucinations):

| Paper | Year | Source | Closest match to I-668 |
|---|---|---|---|
| MOON Embedding | 2025 | Alibaba | Engineering-ready offline product content embedding table |
| MIM | 2025 | Alibaba | Explicit framing of "ID embedding fails under cold/long-tail" |
| FilterLLM | 2025 | Alibaba | Cold-item text-to-distribution (most novel) |
| **QARM V2** | **2026** | **Kuaishou** | **Newest, most on-target — alignment to business objective** |
| OneRec-Think | 2025 | Kuaishou | Generative; biggest architectural shift |

### Past attempts in this project

- `grep -l "content.tower\|text encoder" eval_Logs/*.md`: 0 matches. **No prior in-project attempts.**

## Findings

1. The proposal is **NOT a closed-axis repeat**. The I-608/I-635 closure pattern requires dependency on item-id lookup; content-tower bypasses that lookup entirely.
2. The proposal IS **architecture-axis-tier**, and the architecture axis has 2 in-flight experiments (MC-MLCC, results pending ~hours away). Submitting I-668 before MC-MLCC LB lands creates GPU contention and decision conflicts.
3. Five 2025–2026 industrial papers from Alibaba (3) and Kuaishou (2) all converge on this mechanism. The paper backing is strong, not speculative.
4. Implementation cost per the inquiry report: 3–7 days. This is in the same tier as the OneRec/HSTU full-backbone option named in handoff §4 as the "if architecture-axis closes" fallback.
5. **Unknown blocker**: the official competition data is anonymized. Whether there is accessible item text / content / category / creative-text in the actual 4M-row dataset (vs. only the 1000-row demo) is not stated in any local doc. **Must verify before committing engineering time.**

## Citations

- `<PROJECT_ROOT>/docs/active_state.md:28,47,61,128,151`
- `<PROJECT_ROOT>/docs/handoff_2026-05-13.md:13-14,23`
- `<PROJECT_ROOT>/docs/research/deep_search/20260513-1314_inquiry_item_oov_papers/external_research.md`

## Next Steps

- Recommendation: **RISKY**
- Gate A: `OFF — paper evidence already gathered 8 minutes ago in the inquiry; no need to re-search`
- Gate C: `OFF — this precheck is a decision aid, not a finding worth promoting`
- Follow-up owner: `user`

### Why RISKY and not GO

Three blockers preventing GO upgrade:

1. **Timing collision**: I-665/I-666 still RUNNING (architecture axis being probed via MC-MLCC). I-668 submission would compete for the same 2 GPU cards. Wait for terminal.
2. **Engineering cost asymmetric**: 3–7 days is 5-10x a typical I-### experiment. Should only commit if MC-MLCC closes the in-d_model architecture axis.
3. **Data feasibility unverified**: anonymized competition data — is item text/content actually accessible in the 4M-row training set? If only sparse anonymized IDs (no creative text, no category names) are exposed, content-tower has nothing to encode. **Must confirm before any code work.**

### Suggested Justification Template (to upgrade RISKY → GO)

Fill these in to convert this into a GO experiment proposal:

```yaml
i668_go_justification:
  prerequisite_1_data_feasibility:
    question: "Does the official 4M-row competition dataset expose item text, category names, or creative content (not just anonymized IDs)?"
    answer: "<YES/NO + reference to data card or schema doc>"
    blocker_if_no: "Skip I-668; pivot to a non-content variant"

  prerequisite_2_axis_status:
    question: "Have I-665 + I-666 both reached terminal state? What is their LB?"
    answer: "<I-665 LB / I-666 LB / verdict per handoff §6>"
    blocker_if_promote: "MC-MLCC promote → I-668 becomes P2 follow-up, not P0"
    trigger_if_kill: "Both KILL → architecture-axis closed → I-668 becomes P0 per handoff §4"

  prerequisite_3_implementation_scoping:
    paper_chosen: "<MOON | MIM | FilterLLM | QARM V2 | OneRec-Think>"
    text_encoder: "<frozen | fine-tuned | LLM-distilled>"
    alignment_objective: "<conversion CE loss | semantic-code reconstruction | none>"
    estimated_days: "<3-7>"
    rollback_plan: "<branch + per-step revert path>"

  prerequisite_4_evaluation_plan:
    primary_metric: "valid AUC + LB AUC"
    submission_quota_use: "How many of remaining LB submissions to budget?"
    stop_condition: "<concrete>"
```

### If user wants to proceed despite RISKY

Recommended sequencing:

1. **HOLD** I-668 until I-665/I-666 LB read (handoff §6 step E)
2. If MC-MLCC KILL both → I-668 is P0; complete prerequisites 1+3+4 in justification template
3. If MC-MLCC PROMOTE → I-668 stays P2; revisit only if I-665/I-666 follow-up sweep also exhausted
4. Either way: prerequisite 1 (data feasibility) must be resolved FIRST — costs nothing to check, blocks everything if NO


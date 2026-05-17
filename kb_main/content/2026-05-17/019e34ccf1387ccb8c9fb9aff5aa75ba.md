---
uuid: 019e34cc-f138-7ccb-8c9f-b9aff5aa75ba
node_type: raw
created_at: 2026-05-17T07:18:26.872Z
updated_at: 2026-05-17T07:21:37.838Z
created_by: human:default
created_by_run: import:markdown:i-615.md
l0_summary: PCVRHyFormer模型推理日志：NumExpr线程限制、模型加载与特征处理。
l1_overview: PCVRHyFormer模型推理日志，记录NumExpr因检测到384核而限制线程为16的警告；模型配置包括d_model=64、2层、4头等；使用RankMixerNSTokenizer处理14个和46个特征；加载checkpoint；测试样本310k；序列最大长度256/512。
embeddings:
  e_l0_id: 428
  e_l1_id: 428
  e_l2_id: null
  model: BAAI/bge-m3
  embedded_at: 2026-05-17T07:21:14.307Z
wikilinks: []
current_path: /cluster_2
derived_state:
  cluster_id: 2
  cluster_membership_strength: 0.7309854937562925
  is_cluster_hub: false
  hub_of_cluster: null
lifecycle:
  status: active
  reference_count: 0
  last_accessed_at: null
  superseded_by: null
  superseded_reason: null
hub_role:
  value: leaf
  source: auto_detected
  reason: 该节点是多次类似推理日志中的一员，没有定义新的子话题，属于已有子话题（推理日志）的具体实例。
  history:
    - changed_at: 2026-05-17T07:21:37.838Z
      from: neutral
      to: leaf
      changed_by: agent:librarian
      op_id: 019e34cf-db2b-7ccb-8ca4-64cd11a25e00
      reason: 该节点是多次类似推理日志中的一员，没有定义新的子话题，属于已有子话题（推理日志）的具体实例。
---

message
time
2026-05-03 14:05:16,014 - INFO - NumExpr defaulting to 16 threads.
2026-05-03 22:05:16.014
2026-05-03 14:05:16,014 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-03 22:05:16.014
2026-05-03 14:05:16,014 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-03 22:05:16.014
2026-05-03 14:05:16,013 - INFO - NumExpr defaulting to 16 threads.
2026-05-03 22:05:16.014
2026-05-03 14:05:16,013 - INFO - NumExpr defaulting to 16 threads.
2026-05-03 22:05:16.014
2026-05-03 14:05:16,013 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-03 22:05:16.014
2026-05-03 14:05:16,013 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-03 22:05:16.014
2026-05-03 14:05:16,013 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - NumExpr defaulting to 16 threads.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - NumExpr defaulting to 16 threads.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - NumExpr defaulting to 16 threads.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - NumExpr defaulting to 16 threads.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - NumExpr defaulting to 16 threads.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,013 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-03 22:05:16.013
2026-05-03 14:05:16,012 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-03 22:05:16.013
2026-05-03 14:05:15,185 - INFO - Starting inference...
2026-05-03 22:05:15.186
2026-05-03 14:05:15,185 - INFO - Model loaded successfully
2026-05-03 22:05:15.185
2026-05-03 14:05:09,915 - INFO - Loading checkpoint from /apdcephfs_fsgm2/share_305170765/angel/ams_2026_1029735554728161656/angel_training_ams_2026_1029735554728161656_20260503140215_de555007/self/95cdb4769de33483019decf4031d1781/ckpt/global_step21744.layer=2.head=4.hidden=64.best_model/model.pt
2026-05-03 22:05:09.916
2026-05-03 14:05:05,246 - INFO - emb_skip_threshold=1000000: seq_c skipped 3/11 features
2026-05-03 22:05:05.246
2026-05-03 14:05:05,246 - INFO - emb_skip_threshold=1000000: seq_b skipped 1/13 features
2026-05-03 22:05:05.246
2026-05-03 14:05:03,164 - INFO - RankMixerNSTokenizer: 14 fids, total_emb_dim=896, chunk_dim=448, num_ns_tokens=2, pad=0
2026-05-03 22:05:03.164
2026-05-03 14:05:03,145 - INFO - RankMixerNSTokenizer: 46 fids, total_emb_dim=2944, chunk_dim=589, num_ns_tokens=5, pad=1
2026-05-03 22:05:03.146
2026-05-03 14:05:03,120 - INFO - Building PCVRHyFormer with cfg: {'d_model': 64, 'emb_dim': 64, 'num_queries': 2, 'num_hyformer_blocks': 2, 'num_heads': 4, 'seq_encoder_type': 'transformer', 'hidden_mult': 4, 'dropout_rate': 0.01, 'seq_top_k': 50, 'seq_causal': False, 'action_num': 1, 'num_time_buckets': 64, 'use_seq_time_features': True, 'seq_time_feat_dim': 36, 'rank_mixer_mode': 'full', 'use_rope': False, 'rope_base': 10000.0, 'emb_skip_threshold': 1000000, 'seq_id_threshold': 10000, 'ns_tokenizer_type': 'rankmixer', 'user_ns_tokens': 5, 'item_ns_tokens': 2}
2026-05-03 22:05:03.120
2026-05-03 14:05:03,120 - INFO - No NS groups JSON found, using default: each feature as one group
2026-05-03 22:05:03.120
2026-05-03 14:05:03,120 - WARNING - train_config missing 'seq_time_feat_dim', using fallback = 36
2026-05-03 22:05:03.120
2026-05-03 14:05:03,120 - INFO - Total test samples: 310000
2026-05-03 22:05:03.120
2026-05-03 14:05:03,119 - INFO - PCVRParquetDataset: 310000 rows from 1000 file(s), batch_size=256, buffer_batches=0, shuffle=False
2026-05-03 22:05:03.120
2026-05-03 14:05:02,602 - INFO - seq_max_lens: {'seq_a': 256, 'seq_b': 256, 'seq_c': 512, 'seq_d': 512}
2026-05-03 22:05:02.602
2026-05-03 14:05:02,602 - INFO - Loaded train_config from /apdcephfs_fsgm2/share_305170765/angel/ams_2026_1029735554728161656/angel_training_ams_2026_1029735554728161656_20260503140215_de555007/self/95cdb4769de33483019decf4031d1781/ckpt/global_step21744.layer=2.head=4.hidden=64.best_model/train_config.json
2026-05-03 22:05:02.602
2026-05-03 14:05:02,600 - INFO - Using schema: /apdcephfs_fsgm2/share_305170765/angel/ams_2026_1029735554728161656/angel_training_ams_2026_1029735554728161656_20260503140215_de555007/self/95cdb4769de33483019decf4031d1781/ckpt/global_step21744.layer=2.head=4.hidden=64.best_model/schema.json
2026-05-03 22:05:02.600
====== Inferring ======
2026-05-03 22:05:01.220
=================================
2026-05-03 22:05:00.795
Working Dir: /workspace
2026-05-03 22:05:00.795
Environment: competition
2026-05-03 22:05:00.795
GPU Count: 1
2026-05-03 22:05:00.795
GPU Available: True
2026-05-03 22:04:59.404
PyTorch: 2.7.1+cu126
2026-05-03 22:04:57.966
[DEBUG][libvgpu]hijack_call.c:175 [p:79 t:79]hooked libcuda_realpath to : /lib/x86_64-linux-gnu/libcuda.so.1
2026-05-03 22:04:55.701
[DEBUG][libvgpu]hijack_call.c:174 [p:79 t:79]hooked libnvml_realpath to : /lib/x86_64-linux-gnu/libnvidia-ml.so.1
2026-05-03 22:04:55.701
[DEBUG][libvgpu]hijack_call.c:173 [p:79 t:79]hooked LD_LIBRARY_PATH to : /usr/local/cuda/lib64:/usr/local/nvidia/lib:/usr/local/nvidia/lib64
2026-05-03 22:04:55.701
[DEBUG][libvgpu]hijack_call.c:172 [p:79 t:79]hooked env NCCL_SET_THREAD_NAME to : 1
2026-05-03 22:04:55.701
[DEBUG][libvgpu]hijack_call.c:125 [p:79 t:79]env_ld_library_path: /usr/local/cuda/lib64:/usr/local/nvidia/lib:/usr/local/nvidia/lib64
2026-05-03 22:04:55.697
[DEBUG][libvgpu]hijack_call.c:107 [p:79 t:79]Thread pid:79, tid:79
2026-05-03 22:04:55.697
[DEBUG][libvgpu]hijack_call.c:106 [p:79 t:79]init cuda hook lib
2026-05-03 22:04:55.697
Python: Python 3.10.20
2026-05-03 22:04:55.356
CUDA: 12.6.77
2026-05-03 22:04:55.352
=== Competition Environment Ready ===
2026-05-03 22:04:55.343
Complete setting network policy rules.
2026-05-03 22:04:51.911
Complete setting taiji user.
2026-05-03 22:04:51.847

###指标	
	
Leaderboard Score(auc)： 0.818146
Inference Time：383.07s





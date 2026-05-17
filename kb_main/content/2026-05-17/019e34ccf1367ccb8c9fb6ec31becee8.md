---
uuid: 019e34cc-f136-7ccb-8c9f-b6ec31becee8
node_type: raw
created_at: 2026-05-17T07:18:26.870Z
updated_at: 2026-05-17T07:20:59.426Z
created_by: human:default
created_by_run: import:markdown:i-608.md
l0_summary: 比赛环境推理日志：完成310000个样本预测并评分。
l1_overview: 该笔记记录了在competition环境中，使用PyTorch 2.7.1+cu126、CUDA 12.6.77、Python 3.10.20及单GPU进行的推理任务。进程处理了310000个样本，生成预测并保存至results文件夹，随后执行评分操作。环境初始化包括设置网络策略、taiji用户，并检测到NumExpr线程限制。整体流程从环境准备到推理完成再到评分结束。
embeddings:
  e_l0_id: 427
  e_l1_id: 427
  e_l2_id: null
  model: BAAI/bge-m3
  embedded_at: 2026-05-17T07:20:48.703Z
wikilinks: []
current_path: /cluster_2
derived_state:
  cluster_id: 2
  cluster_membership_strength: 0.7531941100908515
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
  reason: 该节点内容与已有多个邻居高度一致，都是竞赛推理日志，没有定义新的子话题方向，应作为已有子话题的实例。
  history:
    - changed_at: 2026-05-17T07:20:59.426Z
      from: neutral
      to: leaf
      changed_by: agent:librarian
      op_id: 019e34cf-451f-7ccb-8ca4-510721971e81
      reason: 该节点内容与已有多个邻居高度一致，都是竞赛推理日志，没有定义新的子话题方向，应作为已有子话题的实例。
---

message
time
====== Score Finished ======
2026-05-02 17:42:23.138
====== Scoring ======
2026-05-02 17:42:20.260
=================================
2026-05-02 17:42:19.888
Working Dir: /workspace
2026-05-02 17:42:19.888
Environment: competition
2026-05-02 17:42:19.888
GPU Count: 1
2026-05-02 17:42:19.888
GPU Available: True
2026-05-02 17:42:18.503
PyTorch: 2.7.1+cu126
2026-05-02 17:42:17.102
[DEBUG][libvgpu]hijack_call.c:175 [p:79 t:79]hooked libcuda_realpath to : /lib/x86_64-linux-gnu/libcuda.so.1
2026-05-02 17:42:14.870
[DEBUG][libvgpu]hijack_call.c:174 [p:79 t:79]hooked libnvml_realpath to : /lib/x86_64-linux-gnu/libnvidia-ml.so.1
2026-05-02 17:42:14.870
[DEBUG][libvgpu]hijack_call.c:173 [p:79 t:79]hooked LD_LIBRARY_PATH to : /usr/local/cuda/lib64:/usr/local/nvidia/lib:/usr/local/nvidia/lib64
2026-05-02 17:42:14.870
[DEBUG][libvgpu]hijack_call.c:172 [p:79 t:79]hooked env NCCL_SET_THREAD_NAME to : 1
2026-05-02 17:42:14.870
[DEBUG][libvgpu]hijack_call.c:125 [p:79 t:79]env_ld_library_path: /usr/local/cuda/lib64:/usr/local/nvidia/lib:/usr/local/nvidia/lib64
2026-05-02 17:42:14.868
[DEBUG][libvgpu]hijack_call.c:107 [p:79 t:79]Thread pid:79, tid:79
2026-05-02 17:42:14.868
[DEBUG][libvgpu]hijack_call.c:106 [p:79 t:79]init cuda hook lib
2026-05-02 17:42:14.868
Python: Python 3.10.20
2026-05-02 17:42:14.536
CUDA: 12.6.77
2026-05-02 17:42:14.532
=== Competition Environment Ready ===
2026-05-02 17:42:14.523
Complete setting network policy rules.
2026-05-02 17:42:10.972
Complete setting taiji user.
2026-05-02 17:42:10.905
====== Infer Finished ======
2026-05-02 17:37:37.508
2026-05-02 09:37:36,806 - INFO - Saved status.json to /apdcephfs_fsgm2/share_305170765/angel/ams_2026_1029735554728161656/49260/results/status.json
2026-05-02 17:37:36.806
2026-05-02 09:37:36,337 - INFO - Saved 310000 predictions to /apdcephfs_fsgm2/share_305170765/angel/ams_2026_1029735554728161656/49260/results/predictions.json
2026-05-02 17:37:36.337
2026-05-02 09:37:35,945 - INFO - Inference complete: 310000 predictions
2026-05-02 17:37:35.945
2026-05-02 09:37:35,114 - INFO - Processed 512000 samples
2026-05-02 17:37:35.114
2026-05-02 09:37:19,310 - INFO - Processed 486400 samples
2026-05-02 17:37:19.310
2026-05-02 09:37:03,526 - INFO - Processed 460800 samples
2026-05-02 17:37:03.526
2026-05-02 09:36:47,094 - INFO - Processed 435200 samples
2026-05-02 17:36:47.095
2026-05-02 09:36:30,847 - INFO - Processed 409600 samples
2026-05-02 17:36:30.848
2026-05-02 09:36:15,129 - INFO - Processed 384000 samples
2026-05-02 17:36:15.130
2026-05-02 09:35:59,514 - INFO - Processed 358400 samples
2026-05-02 17:35:59.514
2026-05-02 09:35:43,500 - INFO - Processed 332800 samples
2026-05-02 17:35:43.500
2026-05-02 09:35:27,661 - INFO - Processed 307200 samples
2026-05-02 17:35:27.661
2026-05-02 09:35:12,845 - INFO - Processed 281600 samples
2026-05-02 17:35:12.846
2026-05-02 09:34:57,895 - INFO - Processed 256000 samples
2026-05-02 17:34:57.895
2026-05-02 09:34:42,577 - INFO - Processed 230400 samples
2026-05-02 17:34:42.577
2026-05-02 09:34:27,335 - INFO - Processed 204800 samples
2026-05-02 17:34:27.335
2026-05-02 09:34:13,093 - INFO - Processed 179200 samples
2026-05-02 17:34:13.094
2026-05-02 09:33:58,653 - INFO - Processed 153600 samples
2026-05-02 17:33:58.653
2026-05-02 09:33:43,010 - INFO - Processed 128000 samples
2026-05-02 17:33:43.010
2026-05-02 09:33:27,748 - INFO - Processed 102400 samples
2026-05-02 17:33:27.749
2026-05-02 09:33:16,346 - INFO - Processed 76800 samples
2026-05-02 17:33:16.346
2026-05-02 09:33:05,238 - INFO - Processed 51200 samples
2026-05-02 17:33:05.238
2026-05-02 09:32:53,576 - INFO - Processed 25600 samples
2026-05-02 17:32:53.576
2026-05-02 09:32:40,444 - INFO - NumExpr defaulting to 16 threads.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - NumExpr defaulting to 16 threads.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - NumExpr defaulting to 16 threads.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - NumExpr defaulting to 16 threads.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - NumExpr defaulting to 16 threads.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - NumExpr defaulting to 16 threads.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - NumExpr defaulting to 16 threads.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - NumExpr defaulting to 16 threads.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: NumExpr detected 384 cores but "NUMEXPR_MAX_THREADS" not set, so enforcing safe limit of 16.
2026-05-02 17:32:40.444
2026-05-02 09:32:40,444 - INFO - Note: detected 384 virtual cores but NumExpr set to maximum of 64, check "NUMEXPR_MAX_THREADS" environment variable.
2026-05-02 17:32:40.444
2026-05-02 09:32:39,497 - INFO - Starting inference...
2026-05-02 17:32:39.497
2026-05-02 09:32:39,496 - INFO - Model loaded successfully
2026-05-02 17:32:39.497
2026-05-02 09:32:36,289 - INFO - Loading checkpoint from /apdcephfs_fsgm2/share_305170765/angel/ams_2026_1029735554728161656/angel_training_ams_2026_1029735554728161656_20260502120741_284af874/self/95cdb55f9de411b5019de6eca045058a/ckpt/global_step25368.layer=2.head=4.hidden=64.best_model/model.pt
2026-05-02 17:32:36.289
2026-05-02 09:32:33,971 - INFO - emb_skip_threshold=1000000: seq_c skipped 3/11 features
2026-05-02 17:32:33.971
2026-05-02 09:32:33,970 - INFO - emb_skip_threshold=1000000: seq_b skipped 1/13 features
2026-05-02 17:32:33.971
2026-05-02 09:32:31,773 - INFO - RankMixerNSTokenizer: 15 fids, total_emb_dim=960, chunk_dim=480, num_ns_tokens=2, pad=0
2026-05-02 17:32:31.773
2026-05-02 09:32:31,461 - INFO - RankMixerNSTokenizer: 46 fids, total_emb_dim=2944, chunk_dim=589, num_ns_tokens=5, pad=1
2026-05-02 17:32:31.461
2026-05-02 09:32:31,438 - INFO - Building PCVRHyFormer with cfg: {'d_model': 64, 'emb_dim': 64, 'num_queries': 2, 'num_hyformer_blocks': 2, 'num_heads': 4, 'seq_encoder_type': 'transformer', 'hidden_mult': 4, 'dropout_rate': 0.01, 'seq_top_k': 50, 'seq_causal': False, 'action_num': 1, 'num_time_buckets': 64, 'rank_mixer_mode': 'full', 'use_rope': False, 'rope_base': 10000.0, 'emb_skip_threshold': 1000000, 'seq_id_threshold': 10000, 'ns_tokenizer_type': 'rankmixer', 'user_ns_tokens': 5, 'item_ns_tokens': 2}
2026-05-02 17:32:31.438
2026-05-02 09:32:31,438 - INFO - No NS groups JSON found, using default: each feature as one group
2026-05-02 17:32:31.438
2026-05-02 09:32:31,438 - INFO - Total test samples: 310000
2026-05-02 17:32:31.438
2026-05-02 09:32:31,438 - INFO - PCVRParquetDataset: 310000 rows from 1000 file(s), batch_size=256, buffer_batches=0, shuffle=False
2026-05-02 17:32:31.438
2026-05-02 09:32:30,962 - INFO - seq_max_lens: {'seq_a': 256, 'seq_b': 256, 'seq_c': 512, 'seq_d': 512}
2026-05-02 17:32:30.962
2026-05-02 09:32:30,962 - INFO - Loaded train_config from /apdcephfs_fsgm2/share_305170765/angel/ams_2026_1029735554728161656/angel_training_ams_2026_1029735554728161656_20260502120741_284af874/self/95cdb55f9de411b5019de6eca045058a/ckpt/global_step25368.layer=2.head=4.hidden=64.best_model/train_config.json
2026-05-02 17:32:30.962
2026-05-02 09:32:30,959 - INFO - Using schema: /apdcephfs_fsgm2/share_305170765/angel/ams_2026_1029735554728161656/angel_training_ams_2026_1029735554728161656_20260502120741_284af874/self/95cdb55f9de411b5019de6eca045058a/ckpt/global_step25368.layer=2.head=4.hidden=64.best_model/schema.json
2026-05-02 17:32:30.959
====== Inferring ======
2026-05-02 17:32:29.782
=================================
2026-05-02 17:32:29.426
Working Dir: /workspace
2026-05-02 17:32:29.426
Environment: competition
2026-05-02 17:32:29.426
GPU Count: 1
2026-05-02 17:32:29.426
GPU Available: True
2026-05-02 17:32:28.132
PyTorch: 2.7.1+cu126
2026-05-02 17:32:26.848
[DEBUG][libvgpu]hijack_call.c:175 [p:79 t:79]hooked libcuda_realpath to : /lib/x86_64-linux-gnu/libcuda.so.1
2026-05-02 17:32:24.713
[DEBUG][libvgpu]hijack_call.c:174 [p:79 t:79]hooked libnvml_realpath to : /lib/x86_64-linux-gnu/libnvidia-ml.so.1
2026-05-02 17:32:24.713
[DEBUG][libvgpu]hijack_call.c:173 [p:79 t:79]hooked LD_LIBRARY_PATH to : /usr/local/cuda/lib64:/usr/local/nvidia/lib:/usr/local/nvidia/lib64
2026-05-02 17:32:24.713
[DEBUG][libvgpu]hijack_call.c:172 [p:79 t:79]hooked env NCCL_SET_THREAD_NAME to : 1
2026-05-02 17:32:24.713
[DEBUG][libvgpu]hijack_call.c:125 [p:79 t:79]env_ld_library_path: /usr/local/cuda/lib64:/usr/local/nvidia/lib:/usr/local/nvidia/lib64
2026-05-02 17:32:24.710
[DEBUG][libvgpu]hijack_call.c:107 [p:79 t:79]Thread pid:79, tid:79
2026-05-02 17:32:24.710
[DEBUG][libvgpu]hijack_call.c:106 [p:79 t:79]init cuda hook lib
2026-05-02 17:32:24.710
Python: Python 3.10.20
2026-05-02 17:32:24.364
CUDA: 12.6.77
2026-05-02 17:32:24.360
=== Competition Environment Ready ===
2026-05-02 17:32:24.351
Complete setting network policy rules.
2026-05-02 17:32:20.984
Complete setting taiji user.
2026-05-02 17:32:20.928

###指标	
	
Leaderboard Score(auc)： 0.808031
Inference Time：305.39s





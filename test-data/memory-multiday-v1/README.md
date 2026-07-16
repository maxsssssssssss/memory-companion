# Memory Multiday v1

## Fixture Replay（不调用远端服务）

下面的命令直接读取 `manifest.json` 和 `scripts/day-*.txt`，构造稳定的 ASR `TranscriptSegment[]`，再通过 development/test 专用的 deterministic providers 复用真实 `processUpload`、Relationship Signal normalization/Zod、Memory Index、dedup、relations、relevance gate 和 Proactive validator。它不会读取 WAV，不会启动 Next.js 或 tunnel，也不会调用 ASR、Tokenhub、DeepSeek、OpenAI、TTS 或其他 HTTP 服务。

```powershell
$env:NODE_ENV="development"
npm run memory:replay-fixtures -- --dataset test-data/memory-multiday-v1 --user memory-eval-user --reset-user --report .data/evaluation/memory-multiday-v1-report.json --fail-fast
```

可选参数：

- `--from-day 1` / `--to-day 8`：按 manifest 顺序选择日期范围。
- `--reset-user`：先打印数量，再清理该 userId 的 Memory Index 和本数据集的 fixture upload artifacts；默认不删除。
- `--report <path>`：指定 JSON 报告位置；默认 `.data/evaluation/memory-multiday-v1-report.json`。
- `--fail-fast`：任一天没有进入 `ready` 时立即停止。

安全边界：

- 仅显式 `NODE_ENV=development` 或 `NODE_ENV=test` 时允许执行；未设置或 `production` 都会明确拒绝。
- replay 期间 `globalThis.fetch` 被替换为调用即失败的网络 guard；报告中的 `execution.networkAttempts` 必须为 `0`。
- stable `sourceId` 形式为 `fixture_<sessionId>_seg_<line>`，可重复定位到同一条 `A:/B:` 原文。
- 报告的 `deterministicDigest` 排除了执行时间和运行耗时；连续 reset + replay 应得到相同 digest。

这是一套隐私安全、可重复生成的中文双人对话评估数据，用于验证 Memory Index、evidence 回溯、去重、occurrence、relations、relevance gate、proactive insight、Relationship Signal Cards，以及 current/week/all QA 范围。

数据全部为模拟对话，不含真实隐私。音频使用本机 Windows OneCore TTS 和项目已安装的 `ffmpeg-static` 生成；生成过程不调用 ASR、LLM 或远端 TTS。

## 生产代码调查结论

### 上传格式

上传端和服务端当前支持：AAC、FLAC、M4A/MP4、MP3/MPGA、OGG、Opus、WAV、WebM、原始 PCM，以及带音轨的 MP4。默认最大文件为 300 MB。

- `.pcm` 会在上传时包装为 16 kHz、mono、16-bit WAV。
- 设备裸 Opus packet 会包装为 OGG Opus；已经是 OGG container 的 Opus 不重复包装。
- 本数据集生成 `pcm_s16le`、16 kHz、mono WAV。

### 音频如何进入 ASR

`POST /api/uploads` 接收 multipart `file` 与 `recordingDate`，将规范化后的文件写入：

```text
.data/users/{authenticatedUserId}/uploads/{uploadId}.{ext}
```

随后 Next.js `after()` 调用 `processUpload({ uploadId, userId })`。pipeline 从 upload JSON 读取 `filePath` 和 `mimeType`，再调用 `getTranscriptionProvider().transcribe()`。

- `speaker-asr` 会从用户隔离的文件路径解析 `userId`，构造 `/api/internal/audio/{userId}/{uploadId}?token=...` 公网 URL，提交给远端 ASR。
- `openai` 和 `fixture` provider 使用各自现有流程。
- pipeline 到达 `ready` 或 `failed` 后会删除用户上传目录中的工作副本；本数据集目录内的源 WAV 不受影响。

### 日期语义

生产上传已经支持显式 `recordingDate`，无需新增测试日期后门：

```text
formData.recordingDate -> upload.recordingDate
```

如果表单未提供日期，服务端才回退到上传当天的 UTC 日期。`createdAt` 始终是实际上传时间，不用于 week/all 的录音日期筛选。文件元数据不参与日期判断。

当前 `AudioUpload` 只保存日期级 `recordingDate`，不保存完整 `recordedAt`。因此 manifest 的 `recordedAt` 是数据集时序元数据；进入现有生产 pipeline 时，实际持久化的是对应的 `date`。这足以真实验证跨日和跨自然周，但不能验证一天内的时间顺序。

`manifest.json` 中的 `userId: memory-eval-user` 是数据集逻辑标签。真实 `userId` 必须来自登录账号，不能从 manifest 覆盖认证身份。

### ID 与日期如何传播

```text
authenticated userId
  -> processUpload
  -> Memory Index user_id

generated uploadId
  -> transcript/audio insight/semantic/brief/relationship collections 的文件键
  -> 每条 TranscriptSegment / BriefItem / RelationshipSignal 的 uploadId
  -> memory_evidence.upload_id

upload.recordingDate
  -> Relationship Signal provider recordingDate/card.date
  -> extractUploadMemories(recordingDate)
  -> memory_items.date/first_seen_date/last_seen_date
  -> memory_evidence.date
```

Daily Brief、timeline 和 audio insights 本身按 `uploadId` 存储；日期通过所属 upload 关联。Relationship Signal Card 额外直接保存 `date`。

### Week 的真实定义

week 是 reference date 所在的本地自然周：周一 00:00 到周日，按 `upload.recordingDate` 的 `YYYY-MM-DD` 比较。它不是最近七天。

以 `2026-07-12` 为 reference date：

- week：`2026-07-06` 至 `2026-07-12`，包含 Day 5-8。
- all：包含 Day 1-8。
- current：只包含当前选中的 upload。

## 数据集结构

```text
test-data/memory-multiday-v1/
├── README.md
├── manifest.json
├── expected-results.json
├── generate-audio.mjs
├── validate-dataset.mjs
├── scripts/
│   ├── day-01.txt
│   ├── day-02.txt
│   ├── day-03.txt
│   ├── day-04.txt
│   ├── day-05.txt
│   ├── day-06.txt
│   ├── day-07.txt
│   └── day-08.txt
└── audio/
    ├── .gitignore
    └── .gitkeep
```

生成出的 `audio/*.wav` 被目录内 `.gitignore` 排除，不应提交 Git。

## 日期与故事

| Day | 日期 | 自然周 | 故事摘要 | 主要评估点 |
| --- | --- | --- | --- | --- |
| 1 | 2026-06-29 | 06-29 至 07-05 | B 明确答应周五前检查简历；A 说明咖啡偏好 | commitment、preference、clear commitment |
| 2 | 2026-07-01 | 06-29 至 07-05 | 提出周末博物馆计划，出发时间待确认 | event、question、follow-up commitment |
| 3 | 2026-07-03 | 06-29 至 07-05 | A 追问简历，B 先含糊后说明原因并给新时间 | follow-up、轻微 evasive、counter evidence |
| 4 | 2026-07-05 | 06-29 至 07-05 | 博物馆因天气和时间冲突改期；A 表达提前通知边界 | plan change、boundary respect |
| 5 | 2026-07-07 | 07-06 至 07-12 | B 记得无糖拿铁/低糖偏好并再次确认 | preference dedup、occurrence、active listening |
| 6 | 2026-07-09 | 07-06 至 07-12 | B 完成简历检查并给出两条具体修改建议 | commitment resolution、resolved_by |
| 7 | 2026-07-11 | 07-06 至 07-12 | A 需要安静时间，B 接住情绪并尊重边界；确认次日行程 | emotional support、boundary respect |
| 8 | 2026-07-12 | 07-06 至 07-12 | 回顾已完成的博物馆行程和具体展览 | event completion、museum follow-up |

日期跨度为 13 天，覆盖两个完整的周一到周日自然周。

## 本地声线与音频生成

默认声线：

- A：`Microsoft Yaoyao`，zh-CN，Female。
- B：`Microsoft Kangkang`，zh-CN，Male。

列出本机 OneCore 声线：

```powershell
node test-data/memory-multiday-v1/generate-audio.mjs --list-voices
```

生成全部音频：

```powershell
node test-data/memory-multiday-v1/generate-audio.mjs --force
```

清理并重新生成：

```powershell
node test-data/memory-multiday-v1/generate-audio.mjs --clean --force
```

只生成一段：

```powershell
node test-data/memory-multiday-v1/generate-audio.mjs --session memory-v1-day-01 --force
```

覆盖默认声线：

```powershell
$env:MEMORY_DATASET_VOICE_A = "Microsoft Yaoyao"
$env:MEMORY_DATASET_VOICE_B = "Microsoft Kangkang"
node test-data/memory-multiday-v1/generate-audio.mjs --force
```

脚本会拒绝以下情况：缺少两个不同的 zh-CN voice、对话轮次不是 8-14、说话人未交替、时长不在 90-150 秒，或输出不是 PCM 16 kHz mono WAV。每轮后会按固定序列加入 0.8-1.3 秒静音，并通过 `loudnorm` 缩小两种 voice 的音量差异。

静态验证：

```powershell
node test-data/memory-multiday-v1/validate-dataset.mjs --require-audio
```

## 上传顺序

生产上传已经接收 `recordingDate`，所以不需要新增 import API。可在页面中依次选择 manifest 日期上传，或者使用已有 pipeline validator。

下面的命令会调用配置好的远端 ASR/LLM，可能产生费用；数据集生成阶段不要执行：

```powershell
$env:MEMORY_EVAL_EMAIL = "your-test-account@example.com"
$env:MEMORY_EVAL_PASSWORD = "your-test-password"

npm run validate:pipeline -- --audio test-data/memory-multiday-v1/audio/day-01.wav --date 2026-06-29 --port 3200 --tunnel cloudflared --email $env:MEMORY_EVAL_EMAIL --password $env:MEMORY_EVAL_PASSWORD --timeout-seconds 900
npm run validate:pipeline -- --audio test-data/memory-multiday-v1/audio/day-02.wav --date 2026-07-01 --port 3200 --tunnel cloudflared --email $env:MEMORY_EVAL_EMAIL --password $env:MEMORY_EVAL_PASSWORD --timeout-seconds 900
npm run validate:pipeline -- --audio test-data/memory-multiday-v1/audio/day-03.wav --date 2026-07-03 --port 3200 --tunnel cloudflared --email $env:MEMORY_EVAL_EMAIL --password $env:MEMORY_EVAL_PASSWORD --timeout-seconds 900
npm run validate:pipeline -- --audio test-data/memory-multiday-v1/audio/day-04.wav --date 2026-07-05 --port 3200 --tunnel cloudflared --email $env:MEMORY_EVAL_EMAIL --password $env:MEMORY_EVAL_PASSWORD --timeout-seconds 900
npm run validate:pipeline -- --audio test-data/memory-multiday-v1/audio/day-05.wav --date 2026-07-07 --port 3200 --tunnel cloudflared --email $env:MEMORY_EVAL_EMAIL --password $env:MEMORY_EVAL_PASSWORD --timeout-seconds 900
npm run validate:pipeline -- --audio test-data/memory-multiday-v1/audio/day-06.wav --date 2026-07-09 --port 3200 --tunnel cloudflared --email $env:MEMORY_EVAL_EMAIL --password $env:MEMORY_EVAL_PASSWORD --timeout-seconds 900
npm run validate:pipeline -- --audio test-data/memory-multiday-v1/audio/day-07.wav --date 2026-07-11 --port 3200 --tunnel cloudflared --email $env:MEMORY_EVAL_EMAIL --password $env:MEMORY_EVAL_PASSWORD --timeout-seconds 900
npm run validate:pipeline -- --audio test-data/memory-multiday-v1/audio/day-08.wav --date 2026-07-12 --port 3200 --tunnel cloudflared --email $env:MEMORY_EVAL_EMAIL --password $env:MEMORY_EVAL_PASSWORD --timeout-seconds 900
```

不要并行上传：dedup、occurrence 和 relation 验证依赖前一段录音已进入 `ready` 并完成 Memory Index 写入。

## QA 建议问题

### Current

- 这段录音里，对方答应了什么？
- 这次谈话中有哪些具体的支持行为？
- 这段录音里还有什么没有说清？

### Week

以 `2026-07-12` 为 reference date：

- 这周还有哪些没有完成的承诺？
- 关于简历修改，这周发生了哪些进展？
- 这周有哪些具体的支持或边界表达？

### All

- 我平时对咖啡有什么偏好？
- 博物馆计划从提出到完成经历了什么变化？
- 哪些承诺后来得到了落实？
- 哪些问题有跨日期证据，哪些还不能算长期模式？

## 预期关系矩阵

| 故事 | 起点 | 后续 | 可接受结果 | 级别 |
| --- | --- | --- | --- | --- |
| 简历检查 | Day 1 commitment | Day 3 追问与新时间 | `follow_up` 或有证据的等价关联 | Must |
| 简历检查 | Day 1 commitment | Day 6 完成并给建议 | `resolved_by` 或主 memory 进入 `resolved` | Must |
| 咖啡偏好 | Day 1 preference | Day 5 再次确认 | 合并且 `occurrence_count >= 2`，或 `repeated/related` | Should |
| 博物馆计划 | Day 2 提出 | Day 4 改期 | `follow_up/related`；语义确实判为取消时可为 `contradicted_by` | Should |
| 博物馆计划 | Day 4 改期 | Day 8 完成 | `resolved_by/follow_up/related` | Should |

不为了命中某个 relation 强制修改算法；`expected-results.json` 接受语义等价的 status 变化。

## SQLite 抽查

数据库默认位于 `.data/memory.sqlite`。使用 SQLite CLI：

```powershell
sqlite3 .data/memory.sqlite
```

实际 schema 查询：

```sql
SELECT COUNT(*) FROM memory_items;

SELECT
  id,
  user_id,
  type,
  title,
  summary,
  importance,
  importance_score,
  status,
  occurrence_count,
  first_seen_date,
  last_seen_date,
  date,
  created_at
FROM memory_items
ORDER BY created_at ASC;

SELECT
  memory_id,
  source_type,
  source_id,
  upload_id,
  date,
  quote
FROM memory_evidence
ORDER BY date ASC;

SELECT
  source_memory_id,
  target_memory_id,
  relation_type,
  confidence,
  created_at
FROM memory_relations
ORDER BY created_at ASC;

SELECT e.*
FROM memory_evidence e
LEFT JOIN memory_items m ON m.id = e.memory_id
WHERE m.id IS NULL;
```

按真实认证用户隔离检查时，给前三个查询增加 `WHERE user_id = '实际 userId'`；evidence 可通过 join 到 `memory_items.user_id` 过滤。不要使用不存在的 `content` 字段。

## 验收分层

`expected-results.json` 不锁死 LLM 生成数量，使用：

- `must`：证据链、scope 隔离、核心 commitment/preference 生命周期必须满足。
- `should`：允许模型与规则存在合理语义差异，例如 dedup 与 repeated relation 二选一。
- `mustNot`：人格判断、心理诊断、分手建议、单日长期化、伪造 evidence 一律失败。

## 已知限制

1. 当前 upload 模型只保存日期，不保存 `recordedAt` 的时分秒。
2. `recordingDate` 服务端目前只做非空处理，未在 upload route 强制校验 `YYYY-MM-DD`；本 manifest 和 validator 会严格校验。
3. 本地 TTS 的语气和停顿比真实情侣录音更规整，适合架构回归，不代表真实声学表现。
4. speaker diarization 应能利用男女声差异，但远端 ASR 的 speaker ID 顺序不保证固定对应 A/B。
5. LLM extraction、Relationship Signal 和 proactive insight 具有合理输出波动，因此采用语义基准，不使用精确条数作为唯一验收。
6. 完整 pipeline 会调用远端服务；本数据集创建与本地音频校验本身不会调用远端 API。

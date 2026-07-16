# Unified Chunk Model v1

> Runtime speaker-ASR chunk processing is documented in
> `docs/architecture/long-recording-asr-chunks.md`.

## 目标与范围

本版本只建立共享数据契约，不改变生产 pipeline。它为后续音频切片、并发 ASR、分块分析、checkpoint 和确定性合并提供统一的 domain model。

本版本不修改 ASR、Audio Insight、Daily Brief、Relationship Signal、Memory、queue、worker 或上传 API。

## 当前实现调查

### 上传与音频

- 上传入口位于 `src/app/api/uploads/route.ts`。
- 输入是 multipart `File` 和可选 `recordingDate`。当前实现通过 `file.arrayBuffer()` 一次性读取完整文件，并把规范化音频写入用户 uploads 目录。
- 上传后通过 Next.js `after()` 调用同进程的 `processUpload()`，没有持久队列或独立 worker。
- FFmpeg 路径统一由 `src/lib/server/ffmpeg.ts` 提供。

### OpenRouter ASR 音频 chunk

实现位于 `src/lib/server/transcription/openai-provider.ts`：

- 输入：`{ uploadId, filePath, mimeType }`。
- 先用 ffprobe 获取 duration。
- 超过阈值时用 FFmpeg 生成 MP3 chunk，默认 60 秒，mono、16 kHz、32 kbps。
- chunk 只保存为临时文件路径和数组顺序，没有 domain schema、稳定 chunk ID、状态或 checkpoint。
- chunk 目前串行请求。
- 合并时用 `chunkIndex * chunkSeconds` 回填全局时间 offset，并用当前 segment 数量避免 ID 冲突。
- speaker 不做跨 chunk 对齐。
- OpenAI SDK 的 `chunking_strategy: "auto"` 是 provider 内部行为，不是项目可管理的 chunk model。

### Daily Brief transcript chunk

实现位于 `src/lib/server/extraction/chunks.ts` 和 `src/lib/server/extraction/merge.ts`：

- 长录音阈值：20 分钟、超过 60 segments 或 prompt 超过 12,000 字符。
- 单 chunk 上限：50 segments、12 分钟、8,000 字符。
- 优先按 Semantic Segment 的 evidence 边界分组，再按限制切分。
- `ExtractionChunk` 包含临时 `id/index/segments/start/end/input metrics`，但没有 uploadId、统一状态、来源或 checkpoint。
- chunk 当前串行调用模型。
- merge 会校验真实 source segment ID、去重、排序、限量并重建 BriefItem ID。

### Semantic Timeline 时间块

实现位于 `src/lib/processing/semantic-segments.ts`：

- 20 分钟或 40 segments 进入长录音模式。
- 目标块约 8 分钟，边界约 5 至 12 分钟，并结合 topic/value 语义。
- 输出 `SemanticSegment[]`，包含全局时间范围和原始 source segment IDs。
- 它是分析结果和 Daily Brief 分块提示，不是音频执行 chunk，也没有处理状态。

### 当前 chunk 概念数量

项目内有三套独立概念：

1. OpenRouter 临时音频 chunk。
2. Daily Brief transcript extraction chunk。
3. Semantic Timeline 语义时间块。

它们可以保留各自的划分策略，但应共享统一 envelope 和时间/来源约束。

## TranscriptSegment 能力判断

现有 `TranscriptSegment` 已包含：

- `id`
- `uploadId`
- `startSeconds/endSeconds`
- `speaker`
- `text/confidence`
- `sceneLabels/valueLabels`

它足以作为合并后的全局 transcript 原子，但不足以单独表达 chunk 处理过程：

- 没有来源 audio chunk。
- 没有局部/全局 timestamp 语义。
- 没有 speaker ID 的作用域和跨 chunk 映射。
- 没有 chunk 状态、retry 或错误信息。

因此 v1 不修改 `TranscriptSegment`，而是由 `TranscriptChunk` 补充这些上下文。

## 推荐架构

```text
Uploaded Audio
      |
      v
AudioChunk[]
      |
      v
TranscriptChunk[]
      |
      v
TranscriptChunkMergeResult
      |
      v
AnalysisChunk[]
      |
      v
Daily reducers -> Memory / Event / Agent
```

### AudioChunk

`AudioChunk` 是音频执行单元：

- 稳定 `id` 和唯一 `index`。
- 相对整段 upload 的 `startSeconds/endSeconds`。
- source 类型为原始上传或生成切片。
- provider 状态只能写入 `metadata`。
- `status/error/retryCount/updatedAt` 为未来 checkpoint 提供基础。

Audio chunk 数组不强制按 index 排序，因为并行 worker 的完成顺序不稳定；collection schema 只保证 ID 和 index 唯一。消费者必须显式排序。

### TranscriptChunk

`TranscriptChunk` 是一个 AudioChunk 的规范化转写结果：

- `audioChunkId` 显式追踪来源。
- `timebase` 固定为 `upload_global`。
- provider 返回的局部 timestamp 必须在 adapter 边界加 offset，再进入 schema。
- segment ID 在整个 upload 内必须唯一。
- `speakerIdScope=upload` 表示 speaker 已全局统一。
- `speakerIdScope=chunk` 表示 speaker 仍是 chunk-local，此时 `speakerMap` 必须覆盖所有 speaker ID。

这使 timestamp offset 和 speaker reconciliation 各自只发生一次，避免下游重复猜测。

### AnalysisChunk

`AnalysisChunk` 是 provider-neutral 的分析执行 envelope，首版支持：

- `audio_insight`
- `semantic_timeline`
- `daily_brief`
- `relationship_signal`

它只保存来源 transcript chunks、source segment IDs、输出对象 IDs 和执行状态，不嵌入具体模型输出 schema。具体分析结果继续使用现有 `AudioInsight`、`SemanticSegment`、`BriefItem` 和 `RelationshipSignalCard`。

## 数据不变量

1. 所有时间都相对完整 upload 的 0 秒，不保存 provider-local 时间。
2. AudioChunk 和 TranscriptChunk 的 index 在所属 upload 内唯一。
3. Transcript segment ID 在整个 chunk set 和 merge result 内唯一。
4. chunk 和内部 segment 的 uploadId 必须一致。
5. segment 时间必须落在所属 TranscriptChunk 的全局时间范围内。
6. merge 输入只能包含 `completed` TranscriptChunk。
7. merge 输出必须按全局 startSeconds 排序，并使用 upload-global speaker ID。
8. provider-specific 字段不能出现在 schema 顶层，只能进入 `metadata`。
9. failed chunk 必须有结构化 `error`，但错误信息不得包含 token、密钥或完整 transcript。

音频切片未来可以采用 overlap，但 v1 不把“不重叠”设为 schema 约束。边界去重属于 merge policy，不属于数据合法性。

## 文件结构

```text
src/lib/domain/chunks/
  chunk-status.ts       # 状态、错误、retry、时间和 metadata
  audio-chunk.ts        # AudioChunk 与 AudioChunkSet
  transcript-chunk.ts   # TranscriptChunk、set、merge input/result
  analysis-chunk.ts     # 下游分析执行 envelope
  index.ts              # 公共导出
  chunks.test.ts        # domain contract 单测
```

## 渐进迁移策略

### 阶段 1：仅建立契约

当前版本。现有生产模块不导入这些类型，行为不变。

### 阶段 2：适配 OpenRouter ASR

1. FFmpeg 切片后创建 `AudioChunk[]`，保留当前 60 秒策略。
2. 每次 ASR 返回先转换为 `TranscriptChunk`，把局部时间变成 upload-global 时间。
3. 使用 merge input/result schema 包围现有合并逻辑。
4. 暂时保持串行，确认数据契约后再增加并发。

### 阶段 3：适配 speaker-asr 与统一 merge

1. speaker-asr 复用同一 AudioChunk planner。
2. 增加有界并发和每 chunk req_id，但 req_id 只放 metadata 或任务存储。
3. 在 merge 前完成 speaker mapping、边界去重和全局 segment ID 生成。

### 阶段 4：迁移下游分析

- Daily Brief 保留现有 semantic-guided 划分规则，把 `ExtractionChunk` 逐步映射为 `AnalysisChunk`。
- Audio Insight 和 Relationship Signal 以后以 TranscriptChunk 或重新规划的 AnalysisChunk 为 map 输入。
- day-level reduce 继续产出当前 domain 类型，Memory 和 Agent 无需感知执行 chunk。

### 阶段 5：worker 与 checkpoint

持久化 chunk envelope 后，queue/worker 可以按稳定 ID 领取任务，更新 status、retryCount、error 和 updatedAt。幂等键可使用 `uploadId + kind + index`，worker 重启后只重跑未完成或可重试 chunk。

## 明确未实现

- 音频 chunk planner 和持久化。
- 并发 ASR 与并发限制。
- speaker 跨 chunk 自动对齐。
- transcript 边界重叠去重。
- Audio Insight/Relationship Signal chunk map-reduce。
- queue、worker、checkpoint repository 和 resume。

这些能力应建立在本契约之上，不能由本次 schema 提前模拟。

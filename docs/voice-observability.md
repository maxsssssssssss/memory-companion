# Voice QA 可观测性

本文说明 Browser Voice QA 单轮交互的服务端 Trace 契约、延迟口径和排障方法。它覆盖当前链路：

```text
Browser recording
  -> POST /api/voice/qa
  -> browser audio conversion and batch PCM forwarding
  -> Volcengine realtime ASR
  -> Voice QA Bridge
  -> memory-aware QA and response style
  -> realtime TTS
  -> Browser playback
  -> POST /api/voice/trace
```

Trace 只记录结构化时间、状态和失败代码，不保存 transcript、回答正文、音频、citation、Provider response 或凭据。

## 1. Trace 模型

每次通过 `POST /api/voice/qa` 发起的 push-to-talk 请求会创建一个版本为 `1` 的 `VoiceSessionTrace`。`sessionId` 是本系统生成的 Trace UUID；Provider 返回的会话 ID 单独保存在可选的 `providerSessionId` 中，两者不要混用。

Trace 的事件时间戳如下：

| 事件 | 当前记录位置 | 精确定义 |
| --- | --- | --- |
| `session_created` | Voice QA API | 请求通过认证和表单校验后创建 Trace 的服务端时间。 |
| `speech_started` | Browser session runner | 浏览器整段录音已经上传并转换为 PCM 后，服务端开始把这批 PCM 转发给 Voice Bridge 的时间。 |
| `speech_ended` | Browser session runner | 这批 PCM 转发结束或转发抛错时的服务端时间。 |
| `asr_first_partial` | Voice QA Bridge | Bridge 第一次接受到非空的 ASR partial transcript update 的时间；重复 partial 不会覆盖该时间。 |
| `asr_final_received` | Voice QA Bridge | Bridge 接受并规范化出本轮最终 query 的时间。Provider 若只发 partial、随后发 `ASREnded`，Bridge 会把最后缓存文本作为 final 接受，因此该事件表示“Bridge 接受 final”，不保证 Provider 原事件带有 final 标记。 |
| `qa_started` | Voice QA Bridge | 调用现有 memory-aware QA answerer 之前。 |
| `qa_completed` | Voice QA Bridge | QA answerer 返回或抛错之后；失败也会记录完成边界。 |
| `tts_started` | Voice QA Bridge | 调用现有 Voice Provider 合成回复之前。 |
| `audio_play_started` | Browser + Trace API | 浏览器 `audio` 元素触发 `playing` 后发送 telemetry，`POST /api/voice/trace` 在服务端接收到并接受该事件的时间。 |
| `session_completed` | Voice QA API 或 Trace API | 无音频/请求失败时由服务端结束；正常有音频时由浏览器在播放结束、播放失败或页面关闭后上报，由服务端记录接收时间。 |

### 统一时钟口径

所有存储时间戳都由服务端时钟产生。浏览器不会上传自己的事件时间，因此不存在客户端与服务端时钟偏差，但 `audio_play_started` 包含从浏览器 `playing` 回调到 telemetry 被服务端接收的网络延迟。

`speech_started` / `speech_ended` 目前不是 VAD 检测到的真实发声边界，也不是浏览器录音按钮的开始/结束时间；它们是当前 **batch PCM 服务端转发边界**。所以现有四项延迟不包含浏览器录音时长、录音文件上传、音频转换和 Provider session 建立时间。

事件采用 first-write-wins：同一个事件重复到达不会覆盖首次时间。缺少的事件保持缺失，不会通过相邻事件推算。Trace 一旦进入终态即不可变；迟到或乱序的浏览器事件不会改写已持久化指标，也不会让终态日志与文件内容发生分歧。

## 2. 延迟计算

所有延迟均为整数毫秒，按以下公式计算：

```text
ASR latency
  = asr_final_received - speech_ended

QA latency
  = qa_completed - qa_started

TTS latency
  = audio_play_started - tts_started

Total response latency
  = audio_play_started - speech_ended
```

具体含义：

- `asrLatencyMs` 是服务端完成本批 PCM 转发后，到 Bridge 接受 final query 的时间。
- `qaLatencyMs` 只覆盖现有 QA answerer 调用，其中包含 Memory retrieval、answer generation 和当前 Response Style 路径。
- `ttsLatencyMs` 是“开始请求 TTS”到“浏览器实际开始播放的 telemetry 到达服务端”的端到端 time-to-audio；它不等于纯 Provider 合成耗时，还包含 API 返回、浏览器解码/自动播放以及 telemetry 网络时间。
- `totalResponseLatencyMs` 是“本批 PCM 已转发完成”到“浏览器开始播放”的用户响应尾延迟，不包含录音、上传和预处理。

任一公式的起点或终点缺失时，对应值为 `null`。如果两个时间戳顺序反转或无法解析，也返回 `null`，不会取绝对值或估算。

## 3. 状态和失败语义

Trace 状态包括：

- `in_progress`：尚未收到终态。
- `completed`：正常完成，且没有已记录 failure。
- `completed_with_errors`：流程返回了可用结果，但存在 failure，例如 TTS 失败后仍返回文字回答。
- `failed`：会话或播放失败。
- `aborted`：请求被取消、页面关闭或新一轮交互终止旧会话。
- `incomplete`：等待最终结果超时等导致链路未完整结束。

失败只保存结构化的 `stage` / `code`，同一组合去重，最多保存 8 条。当前阶段为 `session`、`asr`、`qa`、`tts`、`playback`；代码包括请求取消、响应超时、ASR final 缺失、QA/TTS/播放失败等。

典型边界情况：

- **只有 partial，没有可接受的 final**：若 `ASREnded` 时仍有非空缓存文本，Bridge 会将其作为 final；若最终仍没有可接受文本，可能记录 `asr_failed`，或请求超时时记录 `asr_final_missing` + `response_timeout`。没有 `asr_final_received` 时，ASR 延迟为 `null`。
- **整轮 deadline 超时**：先根据已落盘事件定位阶段。没有 `asr_final_received` 才记录 `asr_final_missing`；QA 已开始但未结束时记录 `qa_timeout`；TTS 已开始时记录 `tts_timeout`。三种情况都会同时记录 session 级 `response_timeout`，避免把 QA/TTS 长尾误报成 ASR 缺失。
- **TTS 失败**：保留 `tts_started`，记录 `tts_failed`。若没有音频可播放，`audio_play_started` 不存在，因此 TTS 和总响应延迟为 `null`；文字回答仍可返回，终态通常为 `completed_with_errors`。
- **播放失败**：浏览器上报 `session_completed/outcome=failed`，记录 `playback_failed`。如果失败发生在 `playing` 之前，不会伪造 `audio_play_started`，TTS 和总响应延迟保持 `null`。
- **浏览器没有回传终态**：正常带音频的 API 响应不会在服务端提前完成 Trace。浏览器对网络错误、408、429 和 5xx 使用最多 3 次的有界退避重试；如果页面崩溃或网络持续不可用，Trace 仍会保持 `in_progress`，不会伪造播放成功。

## 4. 持久化

Trace 复用项目现有 `JsonStore`，不引入新数据库。认证后的请求使用用户隔离的数据根目录，实际文件路径为：

```text
<APP_DATA_DIR>/users/<userId>/voice-session-traces/<traceId>.json
```

如果未设置 `APP_DATA_DIR`，路径解析依次回退到 `DATA_DIR`，再回退到 `.data`。文件写入沿用 `JsonStore` 的临时文件 + rename 原子替换，防止写出半个 JSON。

`POST /api/voice/trace` 必须经过认证，只会在当前用户的 store 中按合法 UUID 查找 Trace。浏览器只允许补充 `audio_play_started` 和 `session_completed`，不能提交任意时间戳或覆盖服务端事件。

### Retention / TTL 限制

当前 `voice-session-traces` **没有自动 TTL、过期扫描或数量上限**。文件会一直保留，直到执行明确的用户数据或运维清理；单个 upload 的删除流程不会顺带删除这些跨 scope Trace。部署前应根据隐私和磁盘预算补充独立 retention policy；在此之前，不能把 Trace 文件描述成自动过期数据。

### 并发锁限制

Tracer 会在单个实例内用 promise tail 串行持久化。认证层会为每个请求创建新的 `JsonStore` wrapper，因此 Repository 使用进程级 Trace UUID 队列，为同一 session 串行执行完整的 read-modify-write；`JsonStore` 最终使用原子 rename 写文件。

这些都是**单进程内存协调**，不是跨进程文件锁或分布式锁。因此多 Web 实例或 PM2 cluster 同时更新同一 Trace 时，原子写能避免文件损坏，但不能保证 read-modify-write 不发生 last-write-wins / 丢失更新。当前浏览器用串行 telemetry queue 上报 `audio_play_started` 后再上报 `session_completed`，并对可重试失败最多尝试 3 次，降低了正常单页面路径的竞争和短暂网络故障影响，但这不是多进程一致性保证。

## 5. 结构化日志

Trace 到达终态时输出单行、可检索的结构化日志：

```text
VOICE_TRACE: {"session_id":"<uuid>","asr_latency_ms":120,"qa_latency_ms":840,"tts_latency_ms":690,"total_latency_ms":1650,"status":"completed"}
```

缺失指标以 JSON `null` 输出。日志只包含 Trace ID、四项延迟和状态，不包含 `uploadId`、Provider session ID、transcript、回答、音频或凭据。持久化失败只记录脱敏的 `session_id` 和错误类型，并且不会让 Voice QA 主流程因可观测性写入失败而崩溃。

## 6. 调试流程

1. 从 `POST /api/voice/qa` 响应的 `traceId`，或服务端 `VOICE_TRACE` 日志的 `session_id` 确认目标会话。
2. 在认证用户的数据目录中打开 `voice-session-traces/<traceId>.json`，先看 `status` 和 `failures`，再看缺失的事件。
3. 按事件边界定位阶段：
   - 有 `speech_ended`、无 `asr_final_received`：优先检查 ASR finalization、Provider 错误和 response timeout。
   - 有 `asr_final_received`、无 `qa_started`：检查 Bridge 状态机或 turn queue。
   - `qa_started` 到 `qa_completed` 很高：检查 Memory retrieval、QA Provider 和 Response Style 路径日志。
   - 有 `tts_started`、无 `audio_play_started`：检查 TTS failure、空音频、API 返回、浏览器解码、自动播放和 `/api/voice/trace` telemetry。
   - 已有 `audio_play_started`、无 `session_completed`：检查浏览器播放结束回调、页面卸载和 telemetry 网络失败。
4. 将 `VOICE_TRACE` 的聚合指标用于趋势观察，但排查单次故障时以持久化事件与 failure code 为准。
5. TTS 指标异常时必须记住它是 time-to-audio，不要仅凭该值断言 Provider 合成慢；需要和 Provider/HTTP/浏览器日志对齐。

## 7. 当前边界

- 当前是一轮 push-to-talk、整段上传后的 batch 流程，不是浏览器实时流式麦克风 Trace。
- 没有 VAD 级别的真实 speech onset/end，因而不能计算用户停止说话前后的声学延迟。
- `audio_play_started` 使用 telemetry 服务端接收时间，包含一小段网络时间；没有客户端高精度时间关联。
- Trace 写入是 best effort；写入失败会告警，但不会阻断语音问答。
- 尚无 TTL 和跨进程并发控制，扩展到多 Web 实例前需要补齐 retention 与共享锁/乐观并发策略。

## 8. Streaming Voice 扩展

选择 `application/x-ndjson` 流式响应的浏览器会补充以下事件：

| 事件 | 记录位置 | 含义 |
| --- | --- | --- |
| `first_sentence_committed` | Voice QA Bridge | 完整 QA 结果通过既有校验后，首次取得 grounded sentence commit。 |
| `first_safe_sentence` | Streaming Voice Optimizer | 整轮 sentence preflight 原子通过，首次允许进入 TTS。 |
| `tts_stream_started` | Voice QA Bridge | 开始逐句请求现有 Voice Provider。 |
| `first_audio_chunk_received` | Voice QA Bridge | 收到首个属于当前 TTS turn 的 PCM chunk。 |
| `playback_started` | Browser + Trace API | Web Audio 已安排首个 PCM buffer 后的 telemetry 服务端接收时间。 |
| `stream_completed` | Voice QA Bridge | 服务端已收到并转发本轮全部 TTS chunks；不等同于浏览器已播放完成。 |

新增的主要体验指标为：

```text
speechToFirstAudioPlayMs
  = playback_started - speech_ended
```

辅助指标包括 `speechToFirstSentenceCommittedMs`、`speechToFirstSafeSentenceMs`、
`ttsToFirstAudioChunkMs`、`firstAudioChunkToPlaybackMs` 和 `streamDurationMs`。缺少任一端点或时间顺序反转时仍返回 `null`，不会推算或取绝对值。

旧客户端继续使用 `tts_started` / `audio_play_started`。新客户端使用
`tts_stream_started` / `playback_started`；两条路径共享同一个 Trace model，但不会用旧事件伪造流式事件。

`playback_started` 当前表示 Web Audio source 已被排程，并包含 telemetry 到达服务端的网络时间，和扬声器硬件实际出声仍可能有小量误差。流式 QA 的 `first_sentence_committed` 目前发生在完整结构化回答校验后，因此不能解释为 LLM 生成期间已经开始播音。

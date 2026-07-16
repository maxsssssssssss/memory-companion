# Long Recording 45m v1

本目录是一套隐私安全、可重复生成的中文双人亲密关系场景长录音基准，用于验证项目现有的长录音 Chunk Pipeline。对话全部为合成内容，不包含真实个人信息。

## 数据概况

- 录音日期：`2026-07-15`
- 目标时长：`2670-2695s`
- 实际时长：`2682s`（44:42）
- 预计 ASR chunk：`9` 个，默认每个 `300s`
- 说话人 A：`Microsoft Yaoyao`
- 说话人 B：`Microsoft Kangkang`
- 音频：WAV、`pcm_s16le`、16kHz、mono
- 对话：154 个交替话轮，9 个连续场景

`dialogue.json` 是唯一台词来源。`dialogue.txt` 由生成器自动导出，不应单独手工编辑。

## 场景安排

| 时间 | 场景 | 主要验收点 |
| --- | --- | --- |
| 00:00-05:00 | 普通日常闲聊 | 低价值信息过滤 |
| 05:00-10:00 | 工作压力 | 主动倾听、情绪支持 |
| 10:00-15:00 | 简历与咖啡 | 明确承诺、咖啡偏好 |
| 15:00-20:00 | 博物馆计划 | 计划、未决问题、后续确认 |
| 20:00-25:00 | 日常过渡与轻微回避 | 温和不确定性、反例和修复 |
| 25:00-30:00 | 线上争执担忧 | 沟通问题、边界需求 |
| 30:00-35:00 | 修复与边界方案 | 暂停、恢复沟通、明确约定 |
| 35:00-40:00 | 跨 chunk 回访 | 偏好复现、博物馆问题解决 |
| 40:00-44:42 | 承诺确认与收尾 | 跨 chunk candidate reducer、自然收尾 |

## 本地生成

只使用 Windows OneCore TTS、`ffmpeg-static` 和 `ffprobe-static`，不访问网络。

```powershell
node test-data/long-recording-45m-v1/generate-audio.mjs --list-voices
node test-data/long-recording-45m-v1/generate-audio.mjs --clean --force
node test-data/long-recording-45m-v1/validate-audio.mjs --require-audio
```

清理生成音频：

```powershell
node test-data/long-recording-45m-v1/generate-audio.mjs --clean
```

生成出的 `audio/*.wav` 和 `audio/generation-metadata.json` 被本目录的 `.gitignore` 忽略。

## 真实 Pipeline

运行前必须确认测试账号、speaker-ASR、DeepSeek/Tokenhub 和 cloudflared 配置存在。整段远端验收最多执行一次。

```powershell
npm run validate:pipeline -- --audio test-data/long-recording-45m-v1/audio/long-recording-45m-v1.wav --date 2026-07-15 --port 3200 --tunnel cloudflared --email $env:LONG_RECORDING_EVAL_EMAIL --password $env:LONG_RECORDING_EVAL_PASSWORD --timeout-seconds 3600
```

默认值保持：

```text
ASR_CHUNK_DURATION_SECONDS=300
ASR_CHUNK_CONCURRENCY=3
```

不要为本基准临时提高并发，也不要在整段失败后自动重新上传。

## 验收边界

本基准能够验证：

- 45 分钟音频规划为 9 个 chunk。
- speaker-ASR chunk 并发、checkpoint 和 TranscriptMerge。
- Audio Insight chunk processing。
- Relationship candidate extraction 和 deterministic reducer。
- Daily Brief、Memory Index 和当前录音 Proactive Insight。

本基准是单日、单录音，不能证明多日 dedup、跨周 retrieval、跨录音 speaker identity 或长期 relation lifecycle。

## 报告位置

真实运行后报告写入：

```text
.data/evaluation/long-recording-45m-v1/
```

报告不得包含 API key、密码、音频访问 token 或完整环境变量。

# Long Recording 60m v1

这是一套隐私安全、可在本地重复生成的中文双人合成长录音数据集，用于验证约 60 分钟录音下的 12-chunk Pipeline。故事围绕读书会焦虑、排练承诺、稳定偏好、陶艺计划、计划变化与通知边界展开，不复用旧 45 分钟数据集的简历、咖啡、博物馆或线上争执情节。

## 数据约束

- 数据集版本：`long-recording-60m-v1`
- 录音日期：`2026-07-17`
- 计划时长：`3592s`（59:52）
- 允许范围：`3585-3598s`
- AudioChunk：`12` 个，默认每个 `300s`
- Section：前 11 段各 `300s`，最后一段 `292s`
- 对话轮次：`190-220`
- 音频格式：WAV、`pcm_s16le`、16kHz、mono
- 说话人 A：优先 `Microsoft Yaoyao`
- 说话人 B：优先 `Microsoft Kangkang`

`dialogue.json` 是唯一人工台词来源。`dialogue.txt` 由生成器在音频成功生成后原子更新，不应单独手工编辑。

## 本地生成

生成过程只使用 Windows OneCore TTS、`ffmpeg-static` 和 `ffprobe-static`，不访问网络。

```powershell
node test-data/long-recording-60m-v1/generate-audio.mjs --list-voices
node test-data/long-recording-60m-v1/generate-audio.mjs --clean --force
node test-data/long-recording-60m-v1/validate-audio.mjs --require-audio
```

需要使用其他本地中文声线时，可以显式传入：

```powershell
node test-data/long-recording-60m-v1/generate-audio.mjs --clean --force `
  --voice-a "Microsoft Yaoyao" `
  --voice-b "Microsoft Kangkang"
```

只清理已生成的音频和 generation metadata：

```powershell
node test-data/long-recording-60m-v1/generate-audio.mjs --clean
```

## 时长校准

生成器先逐句调用 OneCore TTS，再按 section 计算统一 `atempo`。每句经过 loudness normalization 和短停顿填充；每个 section 最后单独 pad/trim 到 manifest 指定时长，且必须留下至少 3 秒边界静音。所有 section 最后拼接为 3592 秒 WAV。

如果某一 section 需要超出 manifest 的 tempo 范围，生成器会失败。此时应调整该 section 的台词密度，不应使用长静音勉强补足时长。

## 可复现性和陈旧数据保护

`audio/generation-metadata.json` 会记录：

- manifest、dialogue、派生 transcript 和最终 WAV 的 SHA-256；
- 实际 OneCore voice ID；
- Node、Windows、PowerShell、FFmpeg 和 FFprobe 版本；
- 每个 section 的原始语音时长、停顿、tempo 和最终边界静音。

验证器会重新计算这些 hash。修改 `manifest.json` 或 `dialogue.json` 后，旧 WAV 会被判定为陈旧，必须重新生成。

OneCore voice 包和系统版本可能改变实际波形，因此不同 Windows 机器之间不保证 WAV 字节完全一致；可复用保证限定为内容约束、结构、时长、格式和验收指标。

## Git 边界

60 分钟的 16kHz mono PCM WAV 约 110 MiB，超过 GitHub 单文件限制。`audio/` 下的 WAV、metadata 和临时发布目录均被本目录 `.gitignore` 忽略，只提交 `.gitignore` 与 `.gitkeep`。

不要提交生成音频，不要把 generation metadata 当作生产数据，也不要在生成或验证过程中调用远端服务。

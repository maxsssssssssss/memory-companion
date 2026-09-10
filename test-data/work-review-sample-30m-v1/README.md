# 30 分钟合成办公会议

澄禾行政物资申领试点范围与准备会，三名完全虚构的参与者。内容独立于旧 20 分钟样本，重点覆盖先提议后采纳、日期变更、带条件认领、日/号日期、未决问题和会末复述。

- `dialogue.json` 是音频和带时间戳原文的唯一文字来源，90 段、6 个议题。
- `expected-results.json` 在运行前固定验收要点，不传给 ASR 或分析模型；参与者姓名也不能作为生产身份推断依据。
- `source.json` 固定 1800 秒目标、三种 Windows OneCore 本地声音及音频参数。
- `generate-audio.mjs` 和 `validate-audio.mjs` 复用旧样本的本地 OneCore/FFmpeg 方法，未调用外部 TTS。
- `manifest.json` 保存实际时长、音频与原文哈希、语速和各段时长；`transcript.md` 时间戳由音频计算。

生成：`node test-data/work-review-sample-30m-v1/generate-audio.mjs`

验证：`node test-data/work-review-sample-30m-v1/validate-audio.mjs`

所有人名、组织、事件和数据均为虚构。实际分析只上传生成音频，经现有 ASR 形成 Canonical Evidence；不把作者原文或验收要点注入模型。

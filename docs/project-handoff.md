# 项目交接文档：昼记 / Long-time Record Analyze

更新时间：2026-07-08

## 1. 当前状态

这是一个用于内部验证的长录音复盘与记忆问答 Web 应用。核心目标是：用户上传一天内的长录音后，系统自动转写、按语义整理时间轴、提取每日复盘信息，并支持基于当天、本周、全部记忆范围的 AI 问答。

当前仍处于原型 / 内部 E2E 阶段，不是生产级多租户服务。接手前请先注意：

- 当前工作树不是干净状态，存在大量 modified 和 untracked 文件。接手人需要先确认这些改动是否都要保留，再统一提交。
- 当前存储是文件型 JSON store，不是数据库；适合小规模内部验证，不适合多人高并发生产使用。
- 线上服务模式会把录音上传到验证服务器处理；本地优先 BYOK 模式尽量让数据留在浏览器本地，但本地数据依赖浏览器 localStorage。
- 语气、互动、情绪相关能力目前是“证据层”和规则 / LLM 融合，不是医学或心理诊断。

## 2. 产品能力概览

已实现能力：

- 邀请码注册和登录。
- 上传长录音，支持 mp3、m4a、wav、webm、opus、ogg、pcm 等格式。
- PCM 兼容：裸 PCM 会被包装为 WAV；部分设备 opus 会被包装为 Ogg Opus。
- OpenAI / OpenRouter 兼容转写、摘要提取、AI 问答。
- 讯飞类说话人识别 provider 接入，能在结果里显示 `speaker_1`、`speaker_2` 等。
- 说话人别名编辑，例如把 `speaker_1` 改成真实姓名或昵称。
- 每日复盘：承诺 / 待办、关键决策、灵感与想法、风险等。
- 语义时间轴：不是按固定一分钟切段，而是按主题合并为更长语义段落。
- 时间轴标题、标签、多颜色标签、证据展开。
- 当天、本周、全部记忆范围问答。
- 问答角色预设和自定义 prompt，角色设置在问答输入框附近。
- 模型选择，默认和预置模型在代码和设置里可调整。
- 搜索当前录音内容、人名、承诺等。
- 多段录音按日期聚合，一个日期可以有多次上传记录。
- 声音 / 互动证据层：音量、停顿、重叠、语气标签、互动信号等会进入时间轴和问答证据。
- 问答证据默认折叠，可展开查看引用。
- favicon 已添加。

尚未完成或仍是验证态：

- 没有真正生产级用户体系、权限后台、管理员控制台。
- 没有正式数据库、迁移、备份、审计日志。
- 邀请码是环境变量静态配置，未实现邀请码生成 / 消耗 / 管理 UI。
- 本地优先 BYOK 模式依赖浏览器 localStorage，数据可被浏览器清理。
- 情绪识别模型还没有作为稳定外部 provider 完整接入；当前更多是声学特征 + LLM / 规则的可解释证据。
- OpenRouter 转写稳定性依赖供应商；曾出现 400、502、terminated、fail to fetch 等问题。

## 3. 技术栈

主要技术：

- Next.js 15 App Router
- React 19
- TypeScript
- Zod
- Vitest / Testing Library
- OpenAI Node SDK
- 原生 fetch / Web API
- ffmpeg / ffprobe，项目运行环境需要能调用它们来做音频探测、分片、格式兼容和声学特征提取

关键脚本见 `package.json`：

```bash
npm run dev
npm run build
npm run start
npm run test
npm run lint
```

本地开发常用：

```bash
npm install
# 首次初始化时再复制；已有 .env.local 时不要直接覆盖
cp .env.example .env.local
npm run dev -- -p 3200
```

生产 / 验证环境常用：

```bash
npm run build
npm run start -- -p 3200
```

## 4. 目录结构

重点目录：

```text
src/app/
  api/                         Next.js API routes
  page.tsx                     主页面
  layout.tsx                   根布局和 metadata / icon

src/components/
  daily-brief.tsx              每日复盘 UI
  timeline.tsx                 时间轴 UI
  qa-panel.tsx                 AI 问答 UI
  upload-panel.tsx             上传、日期、录音记录等 UI
  evidence-drawer.tsx          证据展开

src/lib/domain/
  types.ts                     核心领域类型
  qa-prompts.ts                问答角色预设 / prompt
  speaker-aliases.ts           说话人别名
  audio-insight-corrections.ts 语气 / 情绪等纠错结构

src/lib/processing/
  semantic-segments.ts         语义分段
  audio-insights.ts            时间轴 / 标签 / 摘要规则
  ai-audio-insights.ts         LLM 版音频洞察
  acoustic-features.ts         声学特征融合
  emotion-evidence.ts          情绪 / 互动证据融合

src/lib/server/
  auth/                        邀请码、用户、会话
  storage/                     JSON 文件存储和路径
  settings/                    用户 API Key / 模型 / prompt 设置
  transcription/               转写 provider
  extraction/                  摘要提取 provider
  audio-insights/              音频洞察 provider
  audio-features/              ffmpeg 声学特征
  emotion-signals/             外部情绪信号 provider 边界
  retrieval/                   QA / 记忆检索
  pipeline/process-upload.ts   上传后的完整处理流水线

src/lib/client/
  local-analysis.ts            本地优先 BYOK 分析流程
  openrouter-local.ts          浏览器直连 OpenRouter
  memory-context.ts            本地记忆上下文
  day-aggregation.ts           日期聚合
```

## 5. 核心数据流

### 在线服务模式

1. 用户登录。
2. 用户上传音频到 `/api/uploads`。
3. 服务端保存原始音频到用户目录下的 `uploads`。
4. `processUpload` 后台执行：
   - 音频兼容处理。
   - 转写。
   - 说话人识别 / diarization。
   - 音频洞察。
   - ffmpeg 声学特征。
   - 外部情绪信号 provider，默认 no-op。
   - 情绪 / 互动证据融合。
   - 语义分段。
   - 每日简报提取。
   - 写入 JSON store。
5. 处理结束后会尝试删除上传的音频文件，并移除 job 里的 `filePath`。

注意：如果 Node 进程被 kill、服务器磁盘异常或 pipeline 在不可恢复位置中断，仍需要人工检查上传目录是否有残留音频。

### 本地优先 BYOK 模式

1. 用户在浏览器里配置自己的 OpenRouter Key。
2. 浏览器本地读取音频文件。
3. 浏览器直连 OpenRouter 做转写 / 问答。
4. 分析结果存入浏览器 localStorage。
5. 服务端不参与转写和问答处理。

注意：localStorage 不是可靠数据库。用户清理浏览器数据、换浏览器、隐私模式、跨设备都会导致数据不可见或丢失。

## 6. 数据存储

服务端存储由 `APP_DATA_DIR` 控制。

本地默认：

```text
.data
```

线上验证曾使用：

```text
/var/data/daily-brief
```

用户级路径：

```text
{APP_DATA_DIR}/users/{userId}
{APP_DATA_DIR}/users/{userId}/uploads
{APP_DATA_DIR}/users/{userId}/settings/provider-config.json
```

全局认证数据也在 JSON store 下，包括用户、session 等。

不要提交以下内容：

- `.env.local`
- `.data/`
- `/var/data/daily-brief`
- `provider-config.json`
- 任何 API Key、邀请码、session 数据、用户上传或转写结果

## 7. 关键环境变量

完整示例见 `.env.example`。重点变量：

```bash
APP_DATA_DIR=.data
APP_STORAGE_MODE=local
# 线上服务端验证可用 APP_STORAGE_MODE=server
MAX_UPLOAD_BYTES=314572800

DAILY_BRIEF_INVITE_CODES=your-invite-code

OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe-diarize
OPENAI_TEXT_MODEL=gpt-4.1-mini
OPENAI_QA_MODEL=

OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=
OPENROUTER_APP_NAME=Daily Brief
OPENROUTER_QA_MODEL=openai/gpt-5-mini
OPENROUTER_TRANSCRIBE_CHUNK_SECONDS=60

TRANSCRIPTION_PROVIDER=fixture
TRANSCRIPTION_FALLBACK_PROVIDER=fixture
EXTRACTION_PROVIDER=rule
EXTRACTION_FALLBACK_PROVIDER=rule
AUDIO_INSIGHT_PROVIDER=rule
AUDIO_INSIGHT_FALLBACK_PROVIDER=rule
EMOTION_SIGNAL_PROVIDER=none
```

真实能力建议：

```bash
TRANSCRIPTION_PROVIDER=openai
TRANSCRIPTION_FALLBACK_PROVIDER=none
EXTRACTION_PROVIDER=openai
EXTRACTION_FALLBACK_PROVIDER=rule
AUDIO_INSIGHT_PROVIDER=openai
AUDIO_INSIGHT_FALLBACK_PROVIDER=rule
EMOTION_SIGNAL_PROVIDER=none
```

说话人识别 provider：

```bash
TRANSCRIPTION_PROVIDER=speaker-asr
SPEAKER_ASR_BASE_URL=http://14.103.196.9:8300
SPEAKER_ASR_AUDIO_BASE_URL=https://daydiary.vision-intelligence.tech
SPEAKER_ASR_AUDIO_ACCESS_TOKEN=replace-with-long-random-token
SPEAKER_ASR_SPEAKER=true
SPEAKER_ASR_LANGUAGE=zh_cn
```

`SPEAKER_ASR_AUDIO_BASE_URL` 必须是外部 ASR 服务能访问到的 HTTPS 地址。项目通过 `/api/internal/audio/[userId]/[uploadId]` 临时暴露音频给 ASR 服务读取，并用 `SPEAKER_ASR_AUDIO_ACCESS_TOKEN` 做访问控制。

## 8. 主要 API

认证：

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

上传和录音：

- `POST /api/uploads`
- `GET /api/uploads/latest`
- `GET /api/uploads/dates`
- `GET /api/uploads/by-date`
- `DELETE /api/uploads/[uploadId]`
- `GET /api/jobs/[jobId]`
- `GET /api/days/[uploadId]`

问答和记忆：

- `POST /api/days/[uploadId]/qa`
- `POST /api/days/context/qa`
- `POST /api/memory/week/qa`
- `POST /api/memory/all/qa`

设置：

- `GET /api/settings`
- `PUT /api/settings`
- `POST /api/settings/open-data-folder`

说话人 / 修正：

- `PUT /api/days/[uploadId]/speaker-aliases`
- `PUT /api/days/[uploadId]/audio-insight-corrections`

内部音频读取：

- `GET /api/internal/audio/[userId]/[uploadId]`

## 9. 模型和角色配置

问答模型预置在 `src/lib/server/settings/provider-config.ts` 的 `QA_MODEL_PRESETS` 中。用户问“代码里哪里改预置模型”时，看这里。

问答角色预置在 `src/lib/domain/qa-prompts.ts`。当前产品已经支持：

- 角色选择。
- 查看预设 prompt。
- 自定义 prompt。
- 保存到用户设置。

角色需要贯穿：

- UI 选择器。
- 用户 settings。
- QA request payload。
- 服务端 prompt 构造。
- 记忆范围 QA。

之前出现过“选择约会陪伴，但回答还是会议助手”的问题，后续修改角色相关代码时必须做端到端验证。

## 10. 外部能力接入现状

### OpenAI / OpenRouter

统一入口：

- `src/lib/server/openai/client.ts`

转写：

- `src/lib/server/transcription/openai-provider.ts`

OpenRouter 转写会走 `/audio/transcriptions`，对长音频做分片。分片长度由 `OPENROUTER_TRANSCRIBE_CHUNK_SECONDS` 控制，目前建议 60 秒以内。

### 说话人识别

入口：

- `src/lib/server/transcription/speaker-asr-provider.ts`

流程：

1. 上传后，服务端保存音频。
2. provider 生成带 token 的内部音频 URL。
3. 提交到外部 ASR 服务。
4. 轮询结果。
5. 转成项目内的 `TranscriptSegment`。

### 声学 / 情绪 / 互动证据

当前不是直接接入完整情绪模型，而是分层：

- `src/lib/server/audio-features/`：ffmpeg / ffprobe 提取音量、停顿等基础声学特征。
- `src/lib/server/emotion-signals/`：外部情绪信号 provider 边界。
- `src/lib/processing/emotion-evidence.ts`：把文本、声学、互动、外部信号融合成可解释证据。

`EMOTION_SIGNAL_PROVIDER` 默认 `none`，不会污染 OpenAI / LLM 输出。只有显式设置 `rule` 时才启用规则 provider。

## 11. 部署备注

历史线上验证环境：

- 域名：`daydiary.vision-intelligence.tech`
- 端口：`3200`
- 数据目录：`/var/data/daily-brief`

这些是历史上下文，不保证当前服务器状态。接手人需要登录服务器确认：

- Node 版本。
- 是否使用 PM2 / systemd。
- nginx 反向代理配置。
- HTTPS 证书状态。
- `.env.local` 或进程环境变量。
- `/var/data/daily-brief` 权限和容量。
- ffmpeg / ffprobe 是否安装。

服务器访问方式、私钥路径、API Key 不应写入仓库文档，应由交接双方单独传递。

## 12. 邀请码

目前邀请码来自环境变量：

```bash
DAILY_BRIEF_INVITE_CODES=code1,code2,code3
```

没有邀请码管理后台，也没有“使用后自动失效”的机制。生成邀请码可以临时用：

```bash
openssl rand -hex 12
```

如果要给更多内部人员使用，建议下一步做：

- 邀请码表。
- 已使用状态。
- 创建人 / 使用人 / 使用时间。
- 管理员页面。

## 13. 验证记录

最近一次完整验证结果：

```text
npm test          42 files / 312 tests passed
npm run -s lint  passed
npm run -s build passed
```

这次验证发生在情绪 provider 默认 no-op 修复之后。交接后如果继续改代码，至少跑：

```bash
npm test
npm run -s lint
npm run -s build
```

如果改上传、转写、ASR 或 ffmpeg 相关逻辑，还需要真实文件手工验证：

- 小 mp3。
- 大于 20MB 的 mp3。
- opus。
- 裸 pcm。
- 多段同一天录音。
- 说话人识别返回多 speaker 的会议录音。

## 14. 已知风险

技术风险：

- JSON 文件存储没有事务和并发控制，不适合多实例部署。
- Next.js `after()` 做后台任务适合验证，不适合稳定任务队列；进程退出会中断任务。
- OpenRouter 转写偶发 400 / 502，需要更好的重试、错误归一化和 provider fallback。
- 大文件上传可能受 nginx body size、Next.js、浏览器、网络超时共同影响。
- 上传音频处理失败时，虽然 pipeline 会尝试删除音频，但异常中断需要检查残留。
- localStorage 本地模式缺少导出、备份、迁移。
- 说话人映射目前是用户手工别名，不是跨天声纹识别。
- 情绪 / 语气标签可能过多，需要进一步做阈值、去重和解释优化。

产品风险：

- “情绪”“性格”“关系判断”等问题容易越界，需要坚持基于证据、低确定性表达。
- 用户对“本地优先”和“在线服务”的理解必须明确，否则会误解数据是否上传。
- 空记忆范围的问答交互还需要继续优化，避免用户以为系统坏了。
- 多天 / 全部记忆问答随着数据量增加会遇到检索质量和上下文长度问题。

安全风险：

- 用户自定义 API Key 存在 per-user settings 文件中，线上需要更严格加密或密钥托管。
- session、用户、邀请码现在都在 JSON store 中，缺少审计和管理。
- 内部音频读取接口依赖 token，token 必须足够长且不能泄露。

## 15. 推荐接手顺序

1. 先整理 git 工作树：确认所有 modified / untracked 文件，做一次明确提交。
2. 本地跑完整验证：`npm test`、`npm run -s lint`、`npm run -s build`。
3. 用一段小录音跑通在线服务模式。
4. 用一段多 speaker 会议录音跑通 `speaker-asr`。
5. 用大于 20MB 的 mp3 验证上传、分片、转写、错误展示。
6. 验证本地优先 BYOK 模式是否还能正常浏览器直连 OpenRouter。
7. 在服务器上确认 pm2 / nginx / https / env / 数据目录。
8. 决定下一阶段是否引入轻量数据库，例如 SQLite 或 Turso / LibSQL。
9. 决定情绪识别模型的产品边界：先做“气氛证据”，不要直接做人格或心理结论。

## 16. 下一阶段建议

优先级 P0：

- 把当前工作树整理成可交接提交。
- 固化部署脚本和服务器 README。
- 上传失败错误做用户可理解的归一化，不要把 HTML 502 直接展示给用户。
- 增加任务队列或至少增加任务恢复机制。
- 数据导出 / 备份能力。

优先级 P1：

- 邀请码管理后台。
- SQLite 存储替代 JSON store。
- 全部记忆检索质量评估。
- 说话人跨天映射，先从用户别名 + 历史上下文开始，不急着上声纹。
- 情绪 / 互动证据的纠错入口进入更多 UI。

优先级 P2：

- 真正外部情绪识别模型接入。
- 多设备同步。
- 管理后台和审计日志。
- 成本、耗时、token、转写失败率监控。

## 17. 交接注意事项

- 不要直接把这个项目当成生产 SaaS 部署；它目前是内部验证产品。
- 所有“数据不上云”的表达都必须区分模式：本地 BYOK 才能做到服务器不参与；在线服务模式会上传到服务器并调用模型供应商。
- 所有涉及人物性格、关系、情绪判断的回答都要基于证据，并给出不确定性。
- 修改角色 prompt 后，一定要验证当天、本周、全部记忆三个问答入口。
- 修改上传或转写后，一定要验证 20MB+ 文件和 opus / pcm 兼容。
- 修改说话人逻辑后，一定要验证 speaker alias 是否同步到每日复盘、时间轴、问答证据和关键人物卡片。

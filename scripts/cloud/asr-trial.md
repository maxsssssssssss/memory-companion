# Cloud 合成音频的独立 COS → ASR 验证

这是独立开发 CLI；Learning 页面已实现可选的 Cloud 合成 COS 模式并通过离线回归，真实页面闭环尚未验收（见 `docs/cloud-learning-providers.md`）。CLI与正式Cloud Provider入口复用ASR专属HTTP传输；原HMAC下载路由、数据库和普通Windows/服务器默认行为均不改变。不要把 COS 域名填入 `LEARNING_ASR_AUDIO_BASE_URL`：应用仍会拼接自己的路由路径。

## 前提与授权

- 每次真实验证需要明确目标及预算。本工具上限为一次提交、最多 30 次查询、约 60 秒，失败或结果不明均不重提。命令参数不是用户授权的替代品。
- 使用 Node ≥24.5、当前 Cloud 的 HTTP/HTTPS 代理和 CA；保持 TLS 校验。ASR 保留获准的协议和端口，不自动把 HTTP 改为 HTTPS。HTTP ASR 在独立 CLI 中使用 Node 原生 `http.request` 的标准正向代理路径；HTTPS COS 继续用 native fetch。当前平台代理下，native fetch 对 HTTP 目标的 CONNECT 路径失败，不能以支持 CONNECT 的本地模拟替代实际验证，也不得用直连绕过。
- 当前生效网络策略必须包含指定 ASR 主机和指定 COS bucket 主机。保存配置草稿不代表运行任务已经获得权限；不要绕过代理。
- 平台直接进程环境提供 `SPEAKER_ASR_BASE_URL`、`DAILY_BRIEF_COS_BUCKET`、`DAILY_BRIEF_COS_REGION`、`DAILY_BRIEF_COS_PREFIX=cloud-asr/`、`DAILY_BRIEF_COS_SECRET_ID`、`DAILY_BRIEF_COS_SECRET_KEY`。后两项需要安全注入原始值供本地签名，不能使用仅在网络代理中替换的 placeholder。不要贴聊天或写 `.env`。
- COS 使用独立测试私有 bucket 和只限 `cloud-asr/` 的 PutObject/GetObject/HeadObject/DeleteObject 权限；不授予列举、管理 bucket 或其他前缀的权限。可用生命周期规则兜底，但本工具不修改 bucket 配置。
- COS 存储、请求和流量可能收费；ASR 费用由服务方核算，CLI 无法读取账单。禁止用生产或用户音频验证。

## 命令

```sh
# 可选的离线普通话合成工具；仅此试验需要，普通 cloud:setup 不安装。
npm run cloud:asr:setup
npm run cloud:asr -- prepare
npm run cloud:asr -- status

# 网络、配置和本次预算获确认后才能运行，不能自动重试这条命令。
npm run cloud:asr -- run --submit-budget=1 --query-budget=30

# 仅在报告清理未确认时，针对 journal 记录的自有对象检查/清理；不提交 ASR。
npm run cloud:asr -- cleanup
```

安装器在已支持的 Debian 13/x86_64 镜像中，从官方签名 APT 元数据校验的软件包提取 espeak-ng 及必要库至 checkout 相邻的 `.cloud-tools/asr-tts`；不安装 npm 依赖、不调用在线 TTS、不改变系统库。工具可随环境快照复用，缺失时重建。它与应用安装职责不同，不是另一套 Web/Worker 安装流程。

`prepare` 离线生成约 10 秒普通话“今天学习三角形。面积等于底乘高除以二。”，使用已有 Learning 校验及 FFmpeg 分片实现，得到单片 mono/16 kHz/32 kbps MP3。合成器先写完整 WAV，避免 stdout 流式 RIFF 长度占位被项目严格校验拒绝。原件临时副本立即删除。

`run` 先对 ASR 做一次无提交 HEAD 探测，成功后才上传。随机对象 key、原音 hash、request ID 和计数保存于 `output/codex-cloud/asr-trial/state.json`；上传及提交意图先落盘，再执行网络请求。验证匿名下载拒绝、短期签名 URL 可下载且 hash 一致，然后直接复用既有 `requestCompanyAsr`，保持 HTTP、请求字段及时间戳断言。每次提交前更新计数，提交回执丢失也不允许换 ID 重提；最多 30 次查询，整体约 60 秒，响应大小受限。

只有签名 URL 在内存中传给 ASR；不落盘或输出凭据、URL 签名或原始 Provider 错误。结果报告仅记录计数、耗时、时间戳检查及这段合成材料的识别情况。进程只获得 COS/ASR 所需变量，不继承 LLM 等业务秘密。CLI拒绝正式应用的独立传输选择变量，避免绕过本次fetch调用计数；应始终通过cloud:asr包装器运行。LLM 调用数始终为零，ASR 次数单独记录。

成功或失败都尝试删除自身对象，若 bucket 返回 version ID 则删除精确版本，再核验 HEAD 404 和旧签名 URL 404。上传回执未知时，即使 DELETE/HEAD 成功也不宣称排除了晚到上传；清理保留 `unknown`。强制杀进程可能中断清理，须保留 journal 并人工处理所属对象，不得删除记录后重跑。总 COS 操作预算为 16 次；预算耗尽后若仍有对象，单独处理并报告，不扩大自动调用。

报告与 journal 属于被 Git 忽略的当前任务证据，不能当作未来任务配置；已经尝试过的 journal 不可清空来获得新提交机会。未上传的本地合成音频可以保留用于本次获准试验，完成且清理确认后工具删除音频，保留脱敏计数证据。

## 能力边界

COS 短期签名默认 180 秒，最多允许 300 秒。其直链不能逐次核验 Learning 活跃任务，且 COS 可能接受 Range；删除对象能撤销后续下载，但不等于应用原 HMAC 路由的全部语义。该 CLI 只证明“这段合成音频经 COS 能被指定 ASR 消费”，不证明 Learning 页面的完整上传、取消、删除、恢复或生产链路已验收。只有拿到匹配合成语音的真实 ASR 结果，才有 ASR 实际读取音频的证据。

离线回归：

```sh
npm run cloud:test -- scripts/cloud/asr-trial-core.test.ts src/lib/server/transcription/speaker-asr-provider.test.ts src/lib/server/learning/audio.test.ts src/app/api/learning/audio-routes.test.ts
node --test scripts/cloud/providers.test.mjs
npm run cloud:check
```

签名向量来自经完整性校验的官方 COS SDK，运行时不引入 SDK 或其自动重试逻辑。模拟测试与本地成功不能代替真实 ASR 验证。

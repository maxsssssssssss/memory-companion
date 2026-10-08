# Daily Brief: Codex Cloud 开发入口

本分支保留约会陪伴 `/date-companion/a`、日常复盘 `/reflection`、办公复盘 `/work-review`、学习整理 `/learning` 的源码、路由和既有业务契约。不要复制本机或生产 `.env.local`、数据库、音频、个人配置。本次初始提交基于完整已提交的 `dd3e1315f19ba428f61f6103ca38211446335c03`，包含其学习 PDF 原件传输修复；未带入原工作树的未提交内容。

## 首次 Environment 设置

- 仓库：`maxsssssssssss/memory-companion`；checkout **dev/cloud**。GitHub 的默认 master 不是此基线。若创建界面没有分支选项，在安装依赖前要求设置任务 fetch 并 checkout dev/cloud，记录 `git branch --show-current` 和 `git rev-parse HEAD` 后再继续。
- 名称建议：`daily-brief-dev-cloud`；访问：Only me。
- Node：`.nvmrc` 的 24.18.0（项目最低 22.13.0），npm 随 Node；Linux/Ubuntu，安装阶段可安装系统开发包。不得使用 Windows node_modules，必须在 Cloud 运行 npm ci。
- 环境变量、Network secrets：首次全部留空；不配置 VPN、SSH、生产凭据、OCR/ASR/LLM 凭据。不在仓库硬编码模型运行设置。
- 安装脚本（从仓库根运行）：`bash scripts/cloud/setup.sh`。安装锁定 npm 依赖、Redis、native 编译工具及项目 Playwright Chromium，然后只检查原生工具；不自动 build 或运行全量测试。
- 网络：安装使用 Package managers；若未涵盖，按安装错误只补 GitHub release 下载域 `github.com`、`release-assets.githubusercontent.com`、`objects.githubusercontent.com` 以及 Playwright 下载域 `cdn.playwright.dev`、`playwright.download.prss.microsoft.com`。系统包源需容器实际 Ubuntu 镜像源。不要用 All domains 补业务服务访问。安装后首次任务只允许必要仓库访问，拒绝外部业务服务。
- 这份文件及 `scripts/cloud/` 是仓库开发配置，不冒充平台自动识别的 Environment schema。平台 Install script 与 Start skill 仍须按下述文字填写/让设置任务保存。

## Start skill 内容

从已选择的仓库根开始，读取 AGENTS.md；确认 dev/cloud 及预期 SHA，不能回到默认 master。没有 .env 私有文件，不读取其他机器/生产服务。需要预览时在可停止的终端运行 `npm run cloud:dev`，等 Redis、Worker 和 Next 就绪，检查本机 3000 端口并打开平台端口预览。保留父进程；退出用 Ctrl-C/SIGTERM，让其关闭自己启动的进程。不要用 PM2 或系统服务覆盖其他 Redis。只用合成账号及合成数据。需要验证时先停止预览，再依序执行下列命令；报告失败，不自动调用外部服务。

`cloud:dev` 在空闲的 6380 端口启动自己的 Redis，数据写入 `output/codex-cloud/redis`；Web/Worker 共用 `output/codex-cloud/preview-data`，Web 端口 3000。端口占用时拒绝接管。四个入口保留、日常复盘录音/AI 回看与工作复盘主开关开启；其他工作开关沿用既有默认开启。fixture 注册邀请码为 `cloud-synthetic-only`，仅用于 **Only me 的合成开发预览**，不能当公开测试环境的访问保护。不上传私人内容。

无凭据预览可浏览和测试不依赖 Provider 的功能；真实音频转写、AI 生成、OCR 仍需另行授权和测试凭据，缺失时显示既有不可用/失败状态，不把 mock 当真实成功。Learning 的真实录音还需要 ASR 能访问签名音频入口。此开发包装器有意不继承任何业务凭据；未来真实服务验收须单独审阅测试配置及调用预算，不能直接把生产配置塞进 Environment。

## 验证命令

```sh
npm run cloud:check
npm run cloud:test -- src/components/product-system/product-system.test.tsx src/components/product-system/product-popover.test.tsx src/lib/server/daily-reflection/runtime-config.test.ts src/lib/server/work-review/runtime-config.test.ts
# 大型验证留在 Cloud，顺序执行，不与预览/其他 build 并行：
npm run cloud:test
npm run cloud:build
```

`cloud:check` 包含迁移定向 Node 测试及现有 lint 的 Next typegen/TypeScript，不要再次重复 tsc。`cloud:test` 使用现有 Vitest、最多两个 worker，允许传入定向文件。`cloud:build` 保留项目 postbuild trace 清理。离线预载复用既有 HTTP guard，阻止非 loopback Socket，移除继承的业务凭据/代理并拒绝 runtime .env 文件；它是误调用保护，不代替平台网络权限。

项目 Playwright 脚本与平台内置浏览器/Computer Use 是不同能力；装好 Chromium 不证明平台浏览器可用。E2E 按 docs/validation-tools.md 选当前受影响流程。`validate-learning-workflow.mjs` 本次只修 Linux 进程清理和环境变量；其历史 PDF mock 尚未适配新的 PDF source transport，不把该历史完整流程作为本次 PASS。Windows SAPI 音频生成和历史 ngrok/OCR 实验仍是专用本地工具，不在安装或默认验收中运行。

新增 POSIX 进程组用于只终止本 runner 创建的子进程；Windows 保留 taskkill /T。对应测试会检查孙进程端口释放及其他进程不受影响。当前开发规则不需要新架构、生产依赖或数据库迁移。

## 首次 Cloud 验收与保存

先检查安装/preflight，再跑定向、全量、build，按受影响流程做项目 Playwright 验收；记录具体 SHA、命令、发现/通过/失败数、退出码及资源限制。不能把 Windows 定向验证说成 Cloud/Linux 已通过。停止预览后确认 3000/6380 释放；新建任务确认可从已发布环境重建。首次发布前检查 prepared filesystem 中没有真实数据、凭据或个人文件。

Dot 的任务包必须携带目标、SHA、范围、验收、调用/重试预算和禁止项；实际模型/推理强度由平台选择与运行记录核验。不要在 AGENTS 里写一个模型名就声称已锁定。提交和推送只面向当前已授权开发分支；不合并、不推 main/master、不部署。停止 Dot 后也需检查它委派的任务与定时任务。

官方设置流程（核对日期 2026-10-08）：https://learn.chatgpt.com/docs/environments/cloud-environments

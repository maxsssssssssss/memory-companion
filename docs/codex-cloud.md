# Daily Brief：Codex Cloud 开发入口

Cloud 用于当前隔离 checkout 的主要代码开发、构建、合成测试和本机服务调试。保留约会陪伴 `/date-companion/a`、日常复盘 `/reflection`、办公复盘 `/work-review`、学习整理 `/learning` 的全部源码与产品契约。先读根 `AGENTS.md`；产品、UI、验证分别按需读 `PRODUCT.md`、`DESIGN.md`、`docs/validation-tools.md`。

## 唯一工具链与 Environment 字段

仓库为 `maxsssssssssss/memory-companion`，使用用户指定的 `dev/cloud` 提交或明确 SHA。开始记录实际 branch、HEAD 和 Git 状态，不以默认 `master` 或历史准备会话的 SHA 代替检查。已发布快照中的 Linux 工具和依赖可以复用，新任务的 Redis、Worker、Web 进程必须重新启动。直接使用当前 checkout；Cloud 任务已有隔离工作区，不为常规开发新建 worktree。

默认离线开发使用以下五个命令：

| 命令 | 用途 |
|---|---|
| `npm run cloud:setup` | 唯一安装逻辑：锁定 npm 依赖、项目 Python venv/requirements、Redis 和原生工具检查；复用系统 Chromium，不下载 Playwright 浏览器 |
| `npm run cloud:check` | 当前 9 项 Cloud 工具契约及 Next typegen/TypeScript；不再重复运行相同 `tsc` |
| `npm run cloud:test -- <目标文件>` | Vitest 定向验证，最多两个 worker；不包含全部独立 Node/Python runner |
| `npm run cloud:build` | 生产构建及现有 postbuild trace 清理 |
| `npm run cloud:dev` | 当前任务拥有的 Redis、Worker、Web 合成预览 |

Environment 的 **Install script** 从所选仓库根执行 `npm run cloud:setup`，不复制另一份安装器。**Start skill** 使用版本化的 [scripts/cloud/start-skill.md](../scripts/cloud/start-skill.md)，并在保存字段时注明本次所选提交 SHA。完整新任务验收 prompt 在 [scripts/cloud/new-task-acceptance.md](../scripts/cloud/new-task-acceptance.md)；复制时将其中的 `__EXPECTED_DEV_CLOUD_SHA__` 替换为已保存的目标提交。三份文件是仓库指令，不是平台自动识别的 Environment schema。

### 显式 Provider 开发入口

现有五个入口继续使用离线环境，不继承业务参数、凭据或代理。用户明确选择真实 Provider 开发时，使用以下入口；允许启动不等于允许付费请求。

```sh
npm run cloud:providers:check
npm run cloud:dev:providers -- --verify-no-calls
# 获得真实调用目标及预算授权后，才使用不带验证拦截的开发模式：
npm run cloud:dev:providers
```

检查命令只报告变量名称、是否存在、配置缺口与代理/CA状态，不请求接口。`--verify-no-calls`在保留实际业务变量及代理的同时加载外联拦截，适合本轮无付费调用的启动验证。真实模式使用同一个supervisor与同一份Web/Worker环境，独立Web3001、Redis6381、`output/codex-cloud/provider-data`、`provider-redis`及`daily-brief-cloud-providers`队列；只允许合成资料，不连接其他数据库/Redis。两个开发模式共用`.next`，不得并行运行，构建前同样停止自己拥有的开发服务。

[providers.mjs](../scripts/cloud/providers.mjs)定义完整的业务配置白名单，包括已采用的OpenAI兼容参数、Work Review角色参数、Learning生成参数及ASR/OCR配置。它不继承未知秘密、公开浏览器变量、生产存储、个人配置文件、设备同步、隧道或mock开关。转写/提取fallback固定为none；没有显式选择主Provider时维持源码默认fixture/rule，不声称真实功能可用。账号持久化Provider设置仍有应用自己的优先级，本模式仅使用新合成账号，不导入本机账号配置。

平台Environment variables可以提供白名单中的业务配置和直接凭据；Network secrets使用下列非保留目标名。不要把密钥写入`.env`、凭据文件、命令参数、日志、历史或Git。别名仅在子进程内映射为应用原变量，保持平台placeholder原样，由平台HTTPS代理在声明的目标域名替换。两个来源同时存在且不同会拒绝启动。

| Network secret目标环境变量 | 应用内变量 |
|---|---|
| `DAILY_BRIEF_OPENAI_API_KEY` | `OPENAI_API_KEY` |
| `DAILY_BRIEF_OPENROUTER_API_KEY` | `OPENROUTER_API_KEY` |
| `DAILY_BRIEF_DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` |
| `DAILY_BRIEF_OPENAI_TRANSCRIBE_API_KEY` | `OPENAI_TRANSCRIBE_API_KEY` |
| `DAILY_BRIEF_SPEAKER_ASR_AUDIO_ACCESS_TOKEN` | `SPEAKER_ASR_AUDIO_ACCESS_TOKEN` |
| `DAILY_BRIEF_LEARNING_PDF_SERVICE_TOKEN` | `LEARNING_PDF_SERVICE_TOKEN` |

Network secret仅绑定实际HTTPS目标主机；OpenAI兼容Key不能自动授权其他Provider，独立转写端点需独立绑定。平台不允许Network secret目标使用保留的`OPENAI_`前缀，因此使用业务别名。不要解密或验证placeholder字符串是不是“真Key”。没有实际绑定时，本地代理测试仅证明placeholder传递，不证明平台已完成真实替换或认证。

Provider模式需要Node>=24.5（当前24.19）；离线入口最低Node22.13保持。它继承平台HTTP(S)_PROXY、CA文件路径，使用Node原生`--use-env-proxy --use-system-ca`，保留`NODE_EXTRA_CA_CERTS`信任，不关闭TLS、不继承任意NODE_OPTIONS/NODE_PATH。保留平台NO_PROXY并补齐localhost/127.0.0.1/::1，拒绝全局`*`绕过代理；启动须存在HTTPS代理。对于Network secrets，还须确保业务主机未被平台NO_PROXY列表排除。HTTP/fetch代理已用本地模拟验证；浏览器/外部进程不是同一机制，真实浏览器请求另需显式限制。

supervisor对Web/Worker/Redis输出流脱敏，包括跨chunk凭据及代理认证；报告只含配置名称/状态。缺少模型、凭据、Learning opt-in参数、ASR可达音频入口或OCR实例/known-findings材料时保留实际配置失败，不通过共享fallback或历史mock补齐。Windows私有OCR/公网音频入口不属于普通Cloud启动前提。

`scripts/cloud/setup.sh` 是唯一安装实现；`scripts/cloud/environment.mjs` 为运行进程发现项目 `.venv/bin`、Cloud 工具目录和所需临时目录。正式入口不要求手工 `source /workspace/.cloud-tools/activate.sh`，也不依赖准备阶段的临时启动脚本。Redis 动态库需求放在执行包装脚本内，不能靠继承业务进程的 `LD_LIBRARY_PATH`。

本版安装器限定已验证的 Debian 13 / x86_64。系统 Chromium、make/g++ 和 Python venv/ensurepip 为系统前提；缺少时须有 root 或可用的非交互 sudo，否则明确报平台前提失败。当前快照已提供这些工具，正常复用不需要 sudo。Redis 可用官方签名 apt 软件包在 Cloud 工具目录提取重建；不绕过包签名或 TLS。

项目最低 Node 为 `>=22.13.0`，`.nvmrc` 为推荐版本。不能复用 Windows `node_modules`、venv 或浏览器二进制。更新 `package-lock.json`、Node ABI 或原生依赖后重新执行 `cloud:setup` 并检查实际版本与锁文件；Python 范围依赖和系统浏览器升级后做相应复验。每个运行入口先检查 venv/pypdf、Redis、Chromium、SQLite 和应用 FFmpeg/FFprobe。安装不创建 `.env.local`，不启动应用，不自动构建或运行全量测试。

## 配置、网络和数据边界

Environment 保持 **Only me／访问锁定**，不携带VPN、SSH、生产配置或私人登录态。离线入口不接收业务秘密；显式Provider模式只使用平台安全配置与合成数据。真实请求须有明确目标、测试凭据与调用预算授权；生产服务器、真实用户数据、私有服务和公网隧道不因该模式而获授权。

所有Cloud入口拒绝运行时 `.env` 文件（仅允许公开 `.env.example`）；离线入口过滤继承的业务凭据、代理、外部 Redis 和 `NODE_OPTIONS`。Provider模式仅传入已列明的业务及代理/CA参数，存储仍强制隔离。发现未知配置或数据时只报告名称、位置和存在性；不输出秘密、不直接删除、不启动业务处理。普通 Web/Worker 仍有自己的环境加载与账号设置优先级，Cloud 包装器的配置不能冒充 Windows 私有 `.env.local` 的行为。

安装使用实际需要的软件源，保留 TLS、包签名和校验。Package managers 预设是广泛的软件源集合，不能描述为只允许几个已用域名；失败时定位具体缺失，不以 All domains 或新增业务域名补救。不重试已知被策略阻止的 Playwright 浏览器下载。`offline.cjs` 是 Node 外联误调用保护，不是系统级安全沙箱；浏览器验证还须限制请求为 loopback。

`cloud:dev` 在空闲 6380 启动自己拥有的 Redis，在 3000 启动 Web，另启 Worker；端口已占用时拒绝接管。Web/Worker 共用绝对 `output/codex-cloud/preview-data`，采用 `server` 存储、`queue` 执行、并发 1；Redis AOF 位于 `output/codex-cloud/redis`。测试使用单独的 `output/codex-cloud/test-data`，采用 `local/inline`。`server` 是存储模式，表示本任务服务端文件，不表示连接生产。

预览默认 ASR fixture、提取 rule，不回退真实服务。显式开启 Reflection 上传、浏览器录音、AI 回看和 Work Review 主开关，四入口保留；Learning AI/OCR、会议生成、设备/语音功能缺少专用配置时维持既有失败或不可用状态。邀请码 `cloud-synthetic-only` 仅用于 Only me 的合成预览，不能当公开访问保护。

## 开发、浏览和停止

按修改风险选定向验证，不默认每次跑全量。构建前先停止本任务占用 `.next` 的开发服务，不并行运行 dev/build。保留实际 supervisor PID；通过 Ctrl-C/SIGTERM 停止自己拥有的 supervisor 后，确认其 Web、Worker、Redis 退出及 3000/6380 释放，不能只看终端已经关闭。禁止 broad `pkill`、停止未知进程或覆盖其他 Redis。

Worker 健康检查必须使用与预览相同的环境。下面示例用于离线预览；Provider 预览从 `scripts/cloud/providers.mjs` 导入 `providerEnvironment`，并将子进程的 `env` 改为 `providerEnvironment(process.cwd(), process.env, { verifyNoCalls: true })`，检查对应的 Redis6381、provider-data 和 Provider 队列。健康检查保持外联拦截，不消耗模型调用预算。

```sh
node --input-type=module <<'JS'
import {spawnSync} from 'node:child_process';
import {cloudEnvironment} from './scripts/cloud/environment.mjs';
const result = spawnSync(process.execPath,
  ['node_modules/tsx/dist/cli.mjs', 'scripts/queue-health.ts'],
  {cwd: process.cwd(), env: cloudEnvironment(process.cwd(), process.env, true), stdio: 'inherit'});
process.exitCode = result.status ?? 1;
JS
```

就绪应满足 `ok=true`、`workers>=1`、`storageProbe.status=matched`，Redis PING 为 PONG。需要恢复/去重验证时，用同一隔离环境执行现有 `scripts/queue-worker-smoke.ts`，核对本轮报告的全部断言与 `remoteProviderCalls=0`；它会写入自己的 `.data/evaluation/queue-worker-v1` 合成资料，清理前确认归属。

项目 Playwright 用安装检查确认的系统 Chromium 路径，当前为 `/usr/bin/chromium`，以 `chromium.launch({executablePath, headless:true})` 显式选择；限制外部请求并等待客户端内容就绪。默认 Playwright browser revision 缺失不靠下载补齐。项目浏览器与平台 Computer Use 是不同能力。根 Playwright 配置不自动启动 Web，旧 `validate-learning-workflow.mjs` 的历史 PDF mock 也不代表完整新 source transport 已验收。

Provider 入口的独立契约回归使用 `node --test scripts/cloud/providers.test.mjs`，覆盖白名单、凭据别名、隔离、日志脱敏和纯本地代理/CA。Learning 传输回归使用 `npm run cloud:test -- src/lib/server/learning/framework-generator.test.ts`。两者均不调用真实模型。

只使用合成账号/材料；账号隔离、SQLite/session/Redis 重启持久化、删除墓碑和清空后重建可按新任务验收 prompt 实测。停止服务后只清理明确属于本任务的合成数据，保留源码和证据。不同任务的文件/端口隔离以各自工作区为准，固定目录或队列名本身不是隔离证据。

## 已知验收边界

2026-10-08 的初次交接基线 `520c4f8f2f60dccd69b2cd16af0a176723ec7936` 曾实际运行一次全量 `cloud:test`：540 文件（536 通过、2 失败、2 跳过），6167 用例（6157 通过、1 失败、9 跳过），另历史 PDF suite collection failure 导致其 23 个声明病例未执行。Learning callback 时序问题已保持原精确断言修复，定向 14/14；历史 suite 未修复、未排除，也未以合成资料冒充。此历史结果不是更新后提交的全量通过证据，不默认重复全量。

Python OCR 原始 runner 的 36 个方法中，19 个依赖未提供的 Windows 历史 runtime-copy 源文件，产生 25 条错误记录（含 subtests）；17 个独立合成方法通过。合成 PDF可验证当前 native render、adapter、schema、SQLite和provenance边界，不能替代历史包的原件、hash、manifest、质量结果或源码 patch anchors。获批历史包与可配置 evidence root 可以解除路径限制，无需伪造 C:/ 目录或降低断言。

Windows SAPI fixture、DPAPI、真实麦克风/设备、历史长录音与私有 OCR/ASR/LLM/声纹验收保留专用环境。缺少这些能力不阻塞普通 Cloud 代码开发，也不能据此声称全面替代或真实模型质量通过。

在用户实际创建的新任务中，确认目标代码、恢复后的工具/依赖与数据隔离，并完成 cold-start→stop→clean→restart，可以建立本次开发可用证据。平台发布版本或内部 snapshot ID 能查则记录；不能查时如实标记，不能要求一个不可用的内部字段才能完成开发验收，也不能把同会话进程重启描述为另一实例还原。

## 保存与更新

源码通过 Git 保存到本次已授权的开发分支；不推 `main/master`、不自动合并或部署。Environment 草稿保存、用户 Publish 和生产发布是独立动作。安装或工具契约变化时，把审阅后的代码 SHA、唯一 `cloud:setup` Install 字段和版本化 Start skill 一起保存；是否 Publish由用户决定。记录实际执行命令、测试数量、退出码、耗时及未执行项；fixture PASS、真实 Provider PASS、生产 PASS分别报告。

根 `UPDATE_HISTORY.md` 是 Windows 与 Cloud 共用、纳入 Git 的唯一变更历史；接着已有记录追加，不覆盖、不另建替代历史，新增内容须脱敏。与代码一起按当次授权提交/推送，冲突时保留双方追加内容。`output/` 和运行日志继续忽略；需要的审阅证据应显式另存。协作委派传递目标 SHA、范围、产品边界、验收、预算及禁止事项，子任务反馈不产生新授权。

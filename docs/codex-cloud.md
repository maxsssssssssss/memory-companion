# Codex Cloud 代码开发

Cloud 负责代码开发和离线自动验证；Windows 负责真实 Provider、设备和完整业务验收，再合并 `main`、推送及按授权部署服务器。本分支保留约会陪伴、日常复盘、办公复盘、学习整理的原有应用代码，不要求 Cloud 具备所有真实运行服务。

## 分支与交付

初始基线为 `dev/cloud-code`。新任务先记录实际目录、分支、完整 HEAD 和 Git 状态，不假设平台使用了期望版本。后续按 Windows 中枢同步的最新集成基线创建或复用 `feat/...`、`fix/...` 等任务分支；默认使用当前工作区，不自动创建 worktree。遇到已有修改或基线偏差时先保全并说明，不自动 reset、覆盖或切换。

Cloud 完成相关离线测试、类型检查和必要构建后，按本次授权提交并推送开发分支。交付完整 SHA、变更说明、实际验证结果和 Windows 待验事项。Windows 在指定 SHA 上真实验收，失败则反馈脱敏复现材料，由 Cloud 在同一分支修复；Windows 直接修复也先同步开发分支，避免双方并改同一文件。通过后由 Windows 合并并推送 `main`；若合并期间基线变化，补做受影响回归。服务器部署须另有明确授权，不由 Cloud 开发任务执行。

`AGENTS.md` 和唯一的 `UPDATE_HISTORY.md` 随 Git 共享；完成改动后追加中文历史，不复制 Windows 个人配置、秘密、数据库或未审阅产物。旧 `dev/cloud` 的迁移实验不自动进入这个开发基线。

## 正式命令

| 命令 | 作用与使用时机 |
| --- | --- |
| `npm run cloud:setup` | 安装或恢复工具及依赖。用于 Environment 安装和锁文件/依赖变化后的同步，不要求每个任务重装。 |
| `npm run cloud:check` | 工具预检、Cloud 环境/进程契约、Next typegen 与 TypeScript。无需再重复运行同等类型检查。 |
| `npm run cloud:test -- <测试文件...>` | 使用隔离环境运行 Vitest；优先指定受影响文件。未带文件将运行全量，按任务风险选择。 |
| `npm run cloud:build` | 工具预检、生产构建和 trace 清理检查；运行前停止使用 `.next` 的开发服务。 |
| `npm run cloud:dev` | 启动本任务 loopback Redis、Worker 和 Web，使用合成账号/数据及离线 Provider。Ctrl-C 停止自有子进程。 |

安装脚本直接使用 `npm run cloud:setup`，不另维护一套安装逻辑。新任务 Start skill 内容见 [`scripts/cloud/start-skill.md`](../scripts/cloud/start-skill.md)。独立任务基本恢复检查见 [`scripts/cloud/new-task-acceptance.md`](../scripts/cloud/new-task-acceptance.md)。

## 工具、依赖和数据

- Node 满足 `package.json` 的 `>=22.13.0`；`.nvmrc` 提供当前安装基线，不代表所有未来快照的实际版本。以命令实测为准。
- `cloud:setup` 使用 `npm ci` 按 `package-lock.json` 安装，不能在运行时混用另一分支的依赖。锁文件改变或依赖缺失时重新同步，不能靠旧 `node_modules` 成功启动就声称一致。
- Python 使用项目 `.venv`，安装 `requirements.txt` 的 `pypdf` 约束。Cloud 入口自动将 `.venv/bin` 放在 PATH 首位并设置 `VIRTUAL_ENV`，无需激活脚本，也不复制 Windows `.venv`。
- 当前 setup 面向 Debian 13 x86_64。Redis 位于仓库上级 `.cloud-tools`，包装脚本负责动态库路径；缺失时通过正常校验的 Debian 软件源恢复。不要关闭 TLS 或混用其他发行版的动态库。
- 保留系统 `/usr/bin/chromium`，Playwright 使用该浏览器时需显式指定路径。setup 已有浏览器启动检查；不重复执行已知受网络限制的 Playwright 浏览器下载。
- FFmpeg/FFprobe 使用项目 npm 包的实际二进制，SQLite 使用当前系统的原生模块；预检会运行相应工具。不要仅以系统 FFmpeg 版本代替应用使用的版本。
- 安装依赖可随环境快照复用，但进程不能跨任务继承。`cloud:dev` 重新启动 Redis/Web/Worker，Web 与 Worker 使用同一绝对 `APP_DATA_DIR` 和独立合成队列。Redis 开启 AOF，仅是当前任务预览数据的持久化，不代表跨任务备份。
- 预览数据在 `output/codex-cloud/preview-data`，Redis 数据在 `output/codex-cloud/redis`，测试目录在 `output/codex-cloud/test-data`；均为忽略产物，不提交。重启可用于验证本任务持久化，干净新任务不得依赖这些目录已有内容。停止进程后只清理已确认属于本任务的合成数据，不删除来源不明的文件。
- Web 使用 `127.0.0.1:3000`，Redis 使用 `127.0.0.1:6380`；已有端口占用时拒绝启动，不接管旧服务。四个入口仍为 `/date-companion/a`、`/reflection`、`/work-review`、`/learning`。

## 配置与权限

Cloud 入口拒绝工作区中的运行时 `.env` 文件，保留 `.env.example`。安装不创建 `.env.local`；遇到真实或来源不明的配置时保全并报告，不读取秘密值或直接删除。

离线入口只传递工具所需环境及明确的合成配置，不继承真实业务 Provider 凭据、远端 Redis 或调用开关；同时注入 Node 外联误调用保护。该保护是开发辅助，不是完整安全沙箱，仍需平台网络权限配合。不要绕过入口使用普通启动命令来加载旧的业务配置。

本环境无需 ASR/OCR/LLM/COS/ngrok 的业务凭据和域名许可。平台界面中的现有变量、Network secrets 绑定及业务域名规则，需用户在 Environment 编辑界面移除或通过有权限的配置工具更新，再由用户审阅发布；只改 Git 不会删除平台设置。保留安装确实需要的受限软件源/包管理网络权限，不使用 All domains。变量或秘密存在不授权真实调用，也不自动证明它们有效。

不启动公网隧道，不连接生产、私有服务或用户数据。真实服务验收由 Windows 完成，Cloud 的 mock/fixture 通过不等于真实 Provider 或生产通过。Environment Publish 与 Git push 分开；未发布配置不能宣称已应用到未来任务。

## 验证边界

按本次改动选择定向测试和必要相邻回归。Cloud 恢复只做工具、check、一组定向测试及按需 loopback 健康检查，完成后进入实际开发，不重复全面迁移审计。

Windows SAPI/DPAPI、真实麦克风/设备、实时语音与真实 Provider 留在 Windows 验收。历史 PDF 包或音频 fixture 不随 Git 提供时，准确记录文件缺失、失败与未执行范围；不得伪造 fixture、删断言或无依据地宣称全量通过。普通合成 fixture 可用于其明确覆盖的合同，不替代历史质量证据。

Cloud 交付必须区分：离线已通过、Windows 待验、生产未执行。新任务的实际恢复结果可证明开发可用性，不能据此证明平台内部快照身份或实现。

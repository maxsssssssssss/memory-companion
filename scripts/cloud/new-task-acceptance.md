# 新 Cloud 任务的基本恢复检查

目标是确认本任务能开发和离线测试，然后继续产品工作；不重新进行全面迁移审计，不继承旧会话的测试结果或进程。本清单不授权真实 Provider、服务器、公开隧道、提交推送或 Environment 发布。

## 1. 实际基线与规则

读取 `AGENTS.md` 和 `docs/codex-cloud.md`，记录当前目录、分支、完整 HEAD、Git 状态及锁文件哈希。初始基线为 `dev/cloud-code`；后续以 Windows 中枢明确同步的最新集成基线/任务分支为准。

```bash
pwd
git branch --show-current
git rev-parse HEAD
git status --short
sha256sum package-lock.json
```

有明确期望 SHA 时逐项核对；未指定时不拿历史 SHA 当成当前要求。发现偏离或已有改动时保全并报告，不自动切换、reset 或创建 worktree。不读取或输出秘密；若发现运行时 `.env` 文件，保留并停止依赖该配置的启动。

## 2. 工具与最小检查

确认 Node 满足 `>=22.13.0`、项目 `.venv` 可用、已安装依赖与当前锁文件一致。无需每个新任务重装；工具缺失或锁文件发生变化时才执行 `npm run cloud:setup`，如安装网络受限则记录真实阻断，不关闭 TLS 或重试受阻浏览器下载。

```bash
node --version
npm --version
.venv/bin/python -c 'import sys,pypdf; print(sys.version.split()[0],pypdf.__version__)'
npm run cloud:check
npm run cloud:test -- src/lib/server/auth/session.test.ts
```

`cloud:check` 自带 Python/pypdf、SQLite、应用 FFmpeg/FFprobe、Redis 与 Chromium 预检，以及 Cloud 契约和类型检查。上面的合成账号会话测试仅作基本离线恢复证据；实际开发还需运行目标变更的定向回归。记录退出码、实际测试文件/用例数、失败和跳过；零测试不能作为通过。除非当前改动风险需要，不追加全量历史 PDF runner 或生产构建。

## 3. 按需验证合成预览

仅当任务涉及启动、队列、路由或页面时运行 `npm run cloud:dev`。确认自有 Web/Worker/Redis 重新启动、Redis PONG、独立合成队列和 Web/Worker 共享数据目录；按受影响流程检查四产品入口，必要时启动合成浏览器测试。服务只在 loopback，不使用旧账号、旧数据库或旧任务文件。

如本任务修改恢复/清理行为，再检查停止和再次启动；基本恢复无需机械执行多轮生命周期验收。停止时终止本任务拥有的进程，确认其端口释放；需要干净重建时仅清理本任务已确认的合成目录。构建前先停止开发服务，不能并发占用 `.next`。进程退出不等于代码已提交。

## 4. 收口并开始开发

简报实际 branch/SHA、工具与锁依赖状态、已执行检查、必要限制。历史 Windows fixture、真实 ASR/OCR/LLM、麦克风/设备及生产验收明确为本轮未执行，不为这些范围继续扩展 Cloud 接入。平台内部快照身份无法从公开接口证明时如实标记不可核验；实际恢复成功仅证明本任务的开发可用性。

基本恢复通过后直接处理用户指定的开发目标，按风险验证、追加同一份 `UPDATE_HISTORY.md`，最终交付待 Windows 验收的明确提交。

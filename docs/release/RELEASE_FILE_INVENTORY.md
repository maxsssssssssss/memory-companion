# Release File Inventory

本文定义 Daily Brief / Memory Companion 发布提交的文件边界。目标是让
release 包含可复现的源码、测试、fixture 与说明文档，同时排除本地账号、
真实 Provider 运行结果和可再生成的构建产物。

## 纳入 release

| 范围 | 内容 |
| --- | --- |
| 应用源码 | `src/`、`scripts/`、`tests/`、`e2e/` |
| 运行时静态资产 | `public/voice-pcm-worklet.js`，浏览器 Realtime Voice 的 AudioWorklet 入口 |
| 项目配置 | `package.json`、`package-lock.json`、Next.js/Vitest/PM2/Docker 配置 |
| 安全配置模板 | `.env.example`，所有凭据值必须为空 |
| 文档 | `README.md`、`docs/`，包括架构图和部署说明 |
| 可复现 benchmark | `benchmark/` 中的问题集与非敏感 fixture |
| 测试数据定义 | `test-data/` 中的 manifest、dialogue、expected results、生成和验证脚本 |
| 音频目录占位 | 数据集音频目录内的 `.gitignore` 和 `.gitkeep` |

## 不纳入 release

| 范围 | 原因 |
| --- | --- |
| `UPDATE_HISTORY.md`、`AGENTS.md`、本地交接文档 | 本地协作与演进记录 |
| `.env*`（`.env.example` 除外）、证书和私钥 | 凭据与本机配置 |
| `.data/` | Upload、Memory、checkpoint、trace、Provider capture 等运行数据 |
| `reports/` | 真实/受控 Provider benchmark 输出，可能包含答案文本和运行引用 |
| `output/`、`playwright-report/`、`test-results/` | 页面截图和可再生成的测试产物 |
| WAV/MP3/M4A/WebM/OGG/FLAC/AAC | 本地或合成音频，不进入 Git |
| SQLite/DB/WAL、日志、Redis/Docker data | 本地状态和运行日志 |
| `.next/`、`out/`、`dist/`、`coverage/`、`node_modules/` | 可再生成的构建或依赖目录 |
| `**/provider-raw-responses/` | Evaluation-only Provider 原始响应 |

明确排除的当前文件：

- `output/playwright/qa-composer-voice-button.png`
- `reports/long-recording-60m-answer-strategy-ab.json`

## 提交前人工确认

- `docs/architecture/daily-brief-memory-companion-project-flow.png` 是正式架构资产，
  由 `SYSTEM_ARCHITECTURE.md` 引用，可以纳入 release。
- benchmark JSON 只能包含受控测试问题、期望类别和非敏感标识。
- deployment 文档不得包含真实域名凭据、密码、Token 或 Authorization 内容。
- `.env.example` 只能保留变量名、安全默认值和空凭据占位。

## Staging Guard

不要直接执行未审查的 `git add .`。建议先查看候选：

```powershell
git status --short
git ls-files --others --exclude-standard
```

精确暂存后再次检查：

```powershell
git diff --cached --name-status
git diff --cached --check
```

只有在测试、敏感信息扫描、远端同步和 release 文件边界均确认后才进行 push。

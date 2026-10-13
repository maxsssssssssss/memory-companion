# Agent V1：最终 Windows 验收计划

本文件整合 A0/A1/A2/A3 的最终验收入口，不要求逐份执行历史任务。验收对象是最终交付对话给出的完整 SHA；分支 `feat/learning-agent-a2` 只是获取位置。Cloud 的离线结果不代表 Windows、真实模型或教学效果通过。

A1 `c0786b48947cdc059052c6b07d421f290cc3f1d1` 的两次最小真实协议调用由用户确认 PASS，仅属于旧 SHA。独立 JSON 修复为 `0feb4721de0734dc2bb1dac8390cd4659293a553`，A2 为 `ab89f2fce1f089cbb510f9dbc078db954042a60c`；都不能代替最终 V1 的验收。Windows 最终 SHA 真实验收 **PENDING**，生产部署 **NOT RUN**。

## 1. 干净检出、安装和记录

在新的独立目录检出交付 SHA，保留已有工作区、dirty 修改、配置和数据。本节不授权覆盖其他目录、reset、clean、stash、合并 main 或生产操作。

```powershell
git clone --branch feat/learning-agent-a2 https://github.com/maxsssssssssss/memory-companion.git memory-companion-agent-v1
Set-Location memory-companion-agent-v1
$AgentV1Sha = Read-Host "粘贴最终交付的完整40位SHA"
if ($AgentV1Sha -notmatch '^[0-9a-f]{40}$') { throw "需要完整SHA" }
git switch --detach $AgentV1Sha
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short
node --version
npm ci
```

确认 HEAD 相同、Git 工作区干净、Node >=22.13、锁文件未改。安装只使用该锁文件，不升级 LangGraph/OpenAI/Next。本任务无需 Python 服务、Postgres、托管 Agent 平台、OCR 或 ASR。按现有规则不把 `.env.local`、私人数据库、录音或个人登录态复制进 checkout。

浏览器使用已安装 Chromium/Chrome/Edge，必要时设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 为本机实际路径。脚本不会自动下载浏览器。Cloud 对 Windows 路径/进程分支的静态和离线合同验证不能替代 Windows 动态运行，后者仍为 PENDING。

## 2. 唯一推荐的离线体验入口

沿用 `scripts/agent-trial/launch.mjs`，没有另一个 V1 runtime。所有终端必须设置相同 `AGENT_TRIAL_DIR`，建议使用下面的独立目录；省略时沿用脚本兼容默认值。

终端 A：

```powershell
$env:AGENT_TRIAL_DIR = Join-Path (Get-Location) "output/agent-v1-offline"
node scripts/agent-trial/launch.mjs start
```

终端 B：

```powershell
$env:AGENT_TRIAL_DIR = Join-Path (Get-Location) "output/agent-v1-offline"
node scripts/agent-trial/launch.mjs status
node --import tsx scripts/agent-trial/seed.ts --manual
node --import tsx scripts/agent-trial/seed.ts --manual
```

应看到 `http://127.0.0.1:37951`、`evidenceMode=offline`、合成账号/手工教材与框架准备完成，seed 为零模型请求；第二次 seed 保留已有选择、成绩、笔记和删除结果，不恢复已删除材料。合成账号登录信息只保存在该目录的 `synthetic-accounts.json`。A–F 覆盖故障隔离，显式 `--manual` 的 M 只用于原手动学习回归；这不是新增产品或课程管理功能。

离线与真实证据目录不能互换或通过改名重新标记。既有目录模式不明或冲突应停止并保留证据，使用新的独立目录；不能删除账本后继续声称原证据属于新模式。

## 3. 一次完整离线流程

在同一目录执行，记录每步退出码。`a2-browser.mjs` 是保留的兼容脚本名，代表最终 V1 实现的当前验收脚本；仅替换模型传输，API、SQLite、SDK checkpoint、Quiz 组件和评分实际执行。

```powershell
node scripts/agent-trial/a2-browser.mjs before-restart
node scripts/agent-trial/launch.mjs stop
node scripts/agent-trial/launch.mjs status
```

应见 A 的实际页面作答、结果读回、解释及范围调整；B 停在原笔记审批，尚未追加。等待终端 A 退出、端口释放后，在终端 A 同目录再次 `node scripts/agent-trial/launch.mjs start`，终端 B 执行：

```powershell
node scripts/agent-trial/a2-browser.mjs after-restart
node scripts/agent-trial/a2-browser.mjs faults
node scripts/agent-trial/a2-browser.mjs manual
node scripts/agent-trial/a2-browser.mjs crash-before
```

检查 B 原审批恢复，批准和重复批准只写一次；C 旧批准失效；D 迟到响应无法按旧范围发布；E 原结果恢复与 unknown 禁重发；F 预算、无进展和明确失败重试。manual 覆盖原材料选择、框架/来源、追问、显式存笔记、独立 Quiz 练习/测验、历史和删除。

`crash-before` 故意在合成 Quiz 业务提交后、共享收据之前使应用进程退出 **86**。断言脚本自身应退出 0，两种退出码分别记录；不得在真实收费请求上执行故障注入。确认旧应用退出后同目录重启，执行：

```powershell
node scripts/agent-trial/a2-browser.mjs crash-after
node scripts/agent-trial/a2-browser.mjs inspect
```

应复用原题组 ID，暂停撤销旧租约、两个并发核对不新增生成。刷新、重登和等待不增加调用。失败保留原任务；按报告选择对应阶段续跑，不能重建数据或直接改 SQLite 状态/分数制造通过。

最后停止应用再进行类型检查和构建，避免同时写 `.next`：

```powershell
node scripts/agent-trial/launch.mjs stop
npm run lint
npm run build
git diff --check
git status --short
```

生产构建后可以同目录使用 `node scripts/agent-trial/launch.mjs start --production` 继续离线体验。最终退出时仍使用相同 stop/status 入口，保留数据。

## 4. 聚焦工程测试与旧 PDF 环境缺口

以下为可重复的核心检查，具体新增脚本合同及本轮完整命令见最终 Cloud 收尾报告。按实际发现的文件/用例数计数，不叠加重叠结果。

```powershell
npm test -- src/lib/server/agent src/lib/server/openai/structured-json.test.ts src/lib/server/openai/tokenhub-deepseek-flash.test.ts
npm test -- src/lib/server/learning/agent-scenario.test.ts src/lib/server/learning/agent-a2.test.ts src/lib/server/learning/agent-source-binding.test.ts src/lib/server/learning/study.test.ts src/lib/server/learning/quiz.test.ts src/lib/server/learning/framework.test.ts src/app/api/learning/agent-routes.test.ts src/app/api/learning/study-routes.test.ts src/app/api/learning/quiz-routes.test.ts src/components/learning
npm test -- scripts/agent-trial
```

已知旧测试 `src/lib/server/learning/pdf-parser-service.test.ts` 在模块加载时要求：

```text
C:/Codex/learning-ocr-handoff/20260921-171314/examples/success/source.pdf
C:/Codex/learning-ocr-handoff/20260921-171314/examples/success/response.json
C:/Codex/learning-ocr-handoff/20260921-171314/examples/quality/dc02-png-response.json
C:/Codex/learning-parsed-handoff/20260920-115054/round4-real-teaching-20260918/sources/bertology.pdf
```

前两个文件在模块加载时读取；后两个由 `maps untouched delivered BERTology response and accepts float32 box precision only` 用例读取。这四个历史交接文件不随 Git 提供，Cloud 中不存在，属于 A1 之前已有的环境缺口。Windows 仅在持有原始获准交接包时核对这些文件并运行 `npm test -- src/lib/server/learning/pdf-parser-service.test.ts`；缺失就标 BLOCKED/PARTIAL。它回放已交付响应，不要求访问 OCR。不要用较简单 PDF 或新构造 response 替代原断言，也不要删除安全断言或把跳过记成通过。

## 5. 单独获准后的真实配置与预算

本文件不授权付费调用。Windows 当前任务需先明确最终 SHA、既有 TokenHub/DS 通道、计划和总额度。旧 36 次额度和旧 A1 两次调用不继承；新的目录或空账本也不产生授权。

| 环境变量/参数 | 用途 |
| --- | --- |
| `AGENT_TRIAL_DIR` | 新的真实合成验收目录，推荐 `output/agent-v1-windows`，不能使用离线目录 |
| `AGENT_TRIAL_MAX_REQUESTS` | 本次明确授权的总上限，脚本接受 1..36，没有默认额度 |
| `AGENT_TRIAL_PROTOCOL_MAX_REQUESTS` | 总额度内协议子上限，1..总额度；最小协议计划为两次 |
| `DAILY_BRIEF_OPENAI_API_KEY` | 默认选定的安全环境密钥变量，只在显式真实模式读取 |
| `--credential-env OPENAI_API_KEY` | 仅当 Windows 已确认该变量属于获准 TokenHub 通道，才显式选择并映射给子进程 |
| `LEARNING_AGENT_API_KEY` / `OPENAI_API_KEY` | 启动器给子进程的别名，不修改父环境或密钥文件 |
| `OPENAI_BASE_URL` | 启动器固定为已选 TokenHub Responses 路径；不允许静默换服务 |
| `LEARNING_AGENT_DECISION_*` | 独立决策配置：PROVIDER、MODEL、MAX_INPUT_CHARS、MAX_OUTPUT_TOKENS、REQUEST_TIMEOUT_MS |
| `LEARNING_AGENT_GENERATION_*` | Agent 内部 Quiz/解释生成的对应独立配置，不改用户手动学习默认值 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | 可选，本机浏览器路径 |

配置缺失应报告变量名，不输出密钥、不扫描私人文件、不复制 `.env.local`。启动器显式设置已选 `deepseek-v4-pro`；不重新比较模型或原生 tool calling。trace/遥测关闭，自动重试关闭，单请求输入上限 48,000 字符、输出上限 8,000 tokens；所有决策、内部生成、失败和未知请求计入账本。

建议 Windows **申请而非自动获得**总上限 32 次：最小协议 2 次；轨迹 A 诊断/作答后决策及范围调整最多 14 次；轨迹 B 先解释/笔记审批及重启最多 10 次；最多 6 次用于有明确原因的修正复验。未用额度不要求用满。实际模型选择可能不同，以真实账本为准；不足以完成时保留 PARTIAL，不加新模型或无限调 prompt。普通本地读取、审批、作答保存和故障注入不消耗真实调用预算。

这个隔离启动器在真实模式只配置 Agent 的决策与内部生成，不启用手动 Quiz/追问生成，也不从父环境透传 `LEARNING_AI_*`。原手动 Learning 的完整交互使用前述离线 M 流程；真实模式可以检查已保存框架、来源、笔记和 Agent 题组作答。手动功能的真实生成质量本次入口 **NOT RUN**，若另需验收应单独明确其安全配置及预算，不能声称本计划已配置或通过。

在安全环境已注入密钥且两个额度变量已按本次授权设置后：

```powershell
$env:AGENT_TRIAL_DIR = Join-Path (Get-Location) "output/agent-v1-windows"
if (!$env:AGENT_TRIAL_MAX_REQUESTS -or !$env:AGENT_TRIAL_PROTOCOL_MAX_REQUESTS) { throw "先按本次授权设置额度" }
node scripts/agent-trial/launch.mjs start --real --credential-env OPENAI_API_KEY
```

默认专用变量时省略 `--credential-env OPENAI_API_KEY`。另一个终端设置同一目录和额度，准备同一份已冻结合成集合教材的代表性账号，不新增课程主题：

```powershell
node --import tsx scripts/agent-trial/seed.ts --real
$inventory = Join-Path $env:AGENT_TRIAL_DIR "protocol-course.json"
if (!(Test-Path $inventory)) { [IO.File]::WriteAllText($inventory, '{"materials":[]}') }
node --require ./scripts/agent-trial/guard.cjs --import tsx scripts/agent-trial/protocol-structured.ts --real --credential-env OPENAI_API_KEY
```

正式协议应为 `structured_action_v1`：模型选择 read_scope，程序实际读空库存，模型收到结果再选择 request_material；两次流式完成、实际动作和用量可以核对。脚本与产品行动请求均不强制 items 根字段。未满足则保留失败，不切协议或默默重试。

## 6. 真实业务只验代表性轨迹

真实模式按实际 UI 手动执行，不运行 offline-only 浏览器故障脚本。

| 场景 | 操作及可检查结果 |
| --- | --- |
| A：薄弱点不明确 | 当前页显式选范围和权限，输入复习目标；模型选择实际业务工具，生成 Quiz 后用原组件作答、整组提交并返回任务继续。读回真实保存结果改变后续行动，而不是前端传分数。等待期间刷新/重登零新增请求 |
| A：中途调整 | 等待中缩小范围或改变目标，预览前后并确认；授权扩展必须用户选择。版本增加，旧反馈/审批失效，预算累计。两窗口旧编辑应冲突并保留草稿 |
| B：明确概念不懂 | 输入明确疑问，允许模型先回源解释；提出笔记建议后核对目标、准确正文、来源及补充标记。待批准正常重启，批准只追加一次；不覆盖已有笔记。追加后明确交回，不称掌握 |
| 拒绝、草稿、来源 | 拒绝不写入；另一个窗口修改目标笔记后旧批准不能覆盖新内容。来源删除/重解析或撤销后旧正文不可继续作为证据。确定性迟到结果/进程退出由离线阶段覆盖，不刻意中断付费请求 |
| 取消及恢复 | 暂停/取消后不自动推进；有原结果先核对复用，unknown 不给重发。明确失败满足现有服务条件时才受控重试；每次计入同任务预算 |
| 手动 Learning | 前述离线 M 流程验证材料选择、框架阅读/来源、追问、显式存笔记、独立 Quiz 练习/测验、提示/跳过/交卷、历史和删除。真实模式只检查已保存内容及作答，手动真实生成未配置 |

人工有限观察：题目标准答案/解释是否受来源支持，是否提前揭示答案，反馈后动作是否合理，确认/返回/恢复是否可理解。记录观察而非掌握百分比或长期教学效果；争议题组停止参与本轮判断，原成绩不改，不把另一个模型的同意当核验。

停止条件：预算将耗尽、来源/授权不满足、协议不兼容、unknown 无原结果、重复写入或答案泄露、需要新增权限/模型时停止相应轨迹。只保留证据并交回，不新增任务绕过预算或扩大授权。

## 7. 失败复现、备份与回退

回传 Cloud：最终 SHA、Windows/Node 版本、命令与退出码、任务/版本/行动/业务结果 ID、期望和实际、允许的控制、脱敏请求状态与用量、发生顺序、页面截图及对应安全日志。不要发送密钥、认证 Cookie、完整 Provider 错误正文、私人材料或整份私人数据库。离线合成目录、`runs/` 报告、网络/离线账本和故障点记录本地保留，不删除账本重置额度。

任务库管理生命周期/行动/授权/预算，SDK SQLite 只管执行位置，Learning SQLite 管原业务数据。首次打开自动幂等增量迁移；不要求手写 SQL。本轮只验合成数据库，不迁移真实用户数据。

备份前按当前目录正常 stop，确认启动器退出且端口释放，再整体复制整个隔离数据目录（含任务库、checkpoint、Learning、认证、原件及 SQLite 配套文件），记录对应 SHA。运行中仅复制某一个 `.sqlite` 不能保证一致。

代码回退与数据回退分开：使用独立 checkout 检出已知版本，配该版本迁移前的完整停机副本或重新 seed 的独立合成目录。不要让 A1 代码直接写入 A2/V1 已迁移数据库，不手工删表/列降级。新旧证据与真实额度账本均保留；没有兼容数据副本时只可保留现场，不声称 checkout 即已恢复。

结束执行同一目录 `node scripts/agent-trial/launch.mjs stop --real`（离线省略 `--real`），随后 status 与端口/启动器退出核对。保留成果，下次继续真实推进仍需有效授权和剩余额度。

最终验收仅针对约定的共享 Agent 执行底座 V1 与 Learning 自适应复习 V1。Cloud 收尾后只接收此最终 SHA 的具体缺陷，在同一开发分支修复并交新 SHA 复验；不自动启动 A4、新 Agent、跨入口总管或泛化优化。

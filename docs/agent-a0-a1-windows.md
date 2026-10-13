# Daily Brief Agent A0/A1：Windows 接手与真实验收

> 历史阶段记录。最终 Agent V1 请统一执行 [Windows 验收计划](agent-v1-windows.md)，不重复四个阶段的任务，也不继承旧调用额度。

Windows 真实验收状态：**PENDING**。本文件是接手步骤，不是验收通过记录。Cloud 只交付代码、离线测试和开发分支；Windows 负责获授权的真实 Provider、浏览器与设备验收，随后按另行授权合并 `main` 或部署。此前 Cloud 的 18 次调用属于历史试验，不能替代本次 Windows 验收，也不证明最终提交已通过真实闭环。

## 1. 锁定独立 checkout 与验收提交

- 仓库：`maxsssssssssss/memory-companion`。
- 开发分支：`feat/learning-agent-a0-a1`。
- 本次交付完整 SHA：使用本轮最终交付消息给出的 40 位 Commit SHA；检出后用 `git rev-parse HEAD` 核对。本文件随该提交版本化，不在自身写入循环依赖的提交哈希；不得以分支名或旧基线替代。
- 使用新的独立 checkout，保留现有 Windows 工作区和未提交修改。不要在历史工作目录执行 reset、clean、stash 或覆盖操作。
- 先读取该提交的 `AGENTS.md`、`DESIGN.md`、`docs/agent-a0-a1.md` 及 `UPDATE_HISTORY.md` 最新记录；实际 HEAD 不同则先报告差异。

以下命令在新的 Windows checkout 内执行。验收前记录 `git rev-parse --show-toplevel`、`git branch --show-current`、`git rev-parse HEAD`、`git status --short`；将完整 SHA 与本次报告绑定。若使用 detached HEAD，也必须明确记录，不能称已在开发分支上验收。

环境要求是 Node.js 22.13 或更高、锁文件对应的依赖、可运行的 Chromium/Chrome/Edge。安装依赖使用 `npm ci`，不要在验收过程中升级包或改锁文件。浏览器选择优先级见 `scripts/agent-trial/browser-launch.mjs`：显式 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`、Playwright 已安装 Chromium、系统已有浏览器；Windows 包括常见 Chrome/Edge 安装目录。脚本不自动下载浏览器。缺少浏览器应先在安装范围内准备，不能把启动失败算成浏览器用例失败或 PASS。

## 2. 已采用的开源方案与正式协议

| 组件 | 锁定版本 | 直接复用的能力 |
| --- | --- | --- |
| `@langchain/langgraph` | `1.5.0` | `StateGraph` 串行图、`interrupt`/`Command`、递归限制和取消信号 |
| `@langchain/langgraph-checkpoint-sqlite` | `1.1.0` | `SqliteSaver` 持久 checkpoint 与中断恢复 |
| `@langchain/core` | `1.2.17` | `toJsonSchema`，从同一工具参数契约生成模型可见 schema |

三项均采用正式 MIT 包，许可证保留在安装包内，没有复制整个引擎或维护 fork。Graph/Saver 对应检查的上游提交是 `4510774dd362264f44efd34b29b4f5648eeb4c4c`；文件、发行修复和其他候选比较见 `docs/agent-a0-a1.md`。不要求 LangSmith 账号、托管平台、Python 服务或新增数据库服务。

正式模型协议只有 `structured_action_v1`：模型输出一个合法工具和参数、等待请求或结束请求；本地严格校验后调用实际业务服务，将重新读取的实际结果送入下一轮决策。LangGraph 负责图执行与恢复；适配器负责现有 Responses 流式传输和上述动作协议。程序固定授权范围、串行调度、预算与终止约束，模型选择诊断、回源、解释、练习、等待或交回。没有原生工具调用失败后静默切换协议的路径。

历史原生 Responses 工具验证未证明工具结果回传及完整第二轮流式完成，不能称为已兼容。Windows 原生验证入口是 `scripts/agent-trial/protocol.mjs`；正式结构化协议验证入口是 `scripts/agent-trial/protocol-structured.ts`。两者都要求 `--real` 与实际加载的预算 guard；原生探测是兼容性诊断，不改变正式协议。

## 3. 配置、权限与调用计划

真实密钥只能由 Windows 安全环境注入进程。不要写进本文件、命令历史、仓库 `.env`、测试教材、截图、请求正文或数据库；不要复制真实用户数据库与个人登录态。启动器拒绝 checkout 内真实 `.env*` 配置。

| 变量名称 | 用途与边界 |
| --- | --- |
| `DAILY_BRIEF_OPENAI_API_KEY` | Windows 真实试验启动器与协议脚本读取的已获准 DS 通道密钥；只列名称，不填写值 |
| `LEARNING_AGENT_API_KEY`、`OPENAI_API_KEY` | 真实启动器对子进程注入的凭据别名；不应手工保存到文件 |
| `OPENAI_BASE_URL` | 真实启动器固定为已核对的 TokenHub 通道；不是任意 Provider 切换入口 |
| `LEARNING_AGENT_DECISION_PROVIDER`、`LEARNING_AGENT_DECISION_MODEL` | 决策模型配置，与已有手动 Learning 配置分开 |
| `LEARNING_AGENT_DECISION_MAX_INPUT_CHARS`、`LEARNING_AGENT_DECISION_MAX_OUTPUT_TOKENS`、`LEARNING_AGENT_DECISION_REQUEST_TIMEOUT_MS` | 单次决策输入、输出与超时边界 |
| `LEARNING_AGENT_GENERATION_PROVIDER`、`LEARNING_AGENT_GENERATION_MODEL` | Agent 工具内部 Quiz/解释生成配置，不修改手动 Learning 默认模型 |
| `LEARNING_AGENT_GENERATION_MAX_INPUT_CHARS`、`LEARNING_AGENT_GENERATION_MAX_OUTPUT_TOKENS`、`LEARNING_AGENT_GENERATION_REQUEST_TIMEOUT_MS` | 工具内部每次生成的边界，嵌套请求也计费计数 |
| `AGENT_TRIAL_DIR` | 本次隔离试验绝对目录；Windows 真实验收明确设置，所有终端保持相同值 |
| `AGENT_TRIAL_PHASE` | 协议脚本为 `protocol`；业务启动器设置为 `trajectory`，用于分账 |
| `AGENT_TRIAL_MODE` | 启动器对子进程明确设置 `offline` 或 `real`；不能借改输出目录把离线结果重新标为真实证据 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | 可选，本机已有浏览器可执行文件的绝对路径 |
| `LANGSMITH_TRACING`、`LANGSMITH_TRACING_V2`、`LANGCHAIN_TRACING`、`LANGCHAIN_TRACING_V2` | 运行时关闭；不能启用云端追踪 |
| `NEXT_TELEMETRY_DISABLED` | 启动器关闭 Next 遥测 |

启动器固定已获准的 TokenHub/`deepseek-v4-pro` 路线，不做多模型或 reasoning 档位比较。直接读取实际启动代码确认本次冻结参数；不得偷偷回退到其他 Provider。密钥缺失、通道不兼容或权限不够时把真实验收标为 BLOCKED，继续离线验证。

**新的 Windows 账本只隔离证据，不产生新的付费授权。** 当前真实验收仍为 PENDING；执行前必须存在适用于 Windows、本次环境和范围的明确授权，并固定调用计划。脚本硬上限为总共 36 次真实请求、协议验证最多 6 次、单请求总输入 48,000 字符和输出 8,000 tokens；授权额度更低时按更低额度停止。若沿用同一轮总预算，计划须扣除已发生的历史请求；若是获准的新一轮，使用新的 Windows 账本并按该轮额度执行，不能默认继承或重新获得过期额度。

建议协议阶段只运行一次原生两轮验证与一次结构化两轮验证，最多计划 4 次；原生提前失败也记录已发生请求。其他额度保留给两条真实业务轨迹、内部 Quiz/解释及必要复验。最多两轮有具体失败原因的修正复验，不要求用满额度，不为制造路径差异重写标准答案。运行前检查 `network-ledger.sqlite` 的现有计数；所有失败、未知及嵌套请求均占额度。不要删除或更名账本来绕过限额。无需为每次正常工具调用重新授权。

## 4. 持久数据与首次使用迁移

`AGENT_TRIAL_DIR/data/users/<合成账号 ID>/` 下按账号隔离：

| 数据库 | 职责 |
| --- | --- |
| `agent-tasks.sqlite` | 任务生命周期、固定授权、调用预算、行动收据、去重事件与执行租约的权威 |
| `agent-checkpoints.sqlite` | SDK 图执行位置和中断点；只保存任务/行动引用与路由，不充当业务任务权威或原文备份 |
| `learning-organizer.sqlite` | 既有材料、框架、Quiz、真实作答、评分；新增 `learning_agent_artifacts` 存放任务内解释与业务结果引用 |

首次访问 Agent 自动执行幂等的 `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`；较早的 Agent 表缺少租约或事件业务身份列时按列检查后补列。`SqliteSaver` 执行其正式包的 checkpoint 初始化/迁移。没有需要手工运行的 Agent SQL 迁移命令，不要自行修改 SQLite 状态或直接注入分数。

Learning 新增材料删除触发器会将依赖该材料的 Agent artifact 置为无效并清除正文；学习页删除清除其 artifact。题组与作答继续使用原有保存/删除契约。来源变化后不能从旧 checkpoint 或解释继续取得被删原文。关闭进程后保留数据库及必要的 SQLite 配套文件；不清理整个试验目录。验收只允许访问以上隔离合成数据，真实用户数据库迁移与回滚不在本轮验收范围。

## 5. 先执行离线门禁

在没有真实 Provider 配置的测试终端执行。以下是待 Windows 执行的命令，不是本文件宣称的 PASS：

```powershell
npm test -- src/lib/server/agent/runtime.test.ts src/lib/server/learning/agent-scenario.test.ts src/app/api/learning/agent-routes.test.ts src/components/learning/learning-agent-panel.test.tsx src/components/learning/learning-quiz.test.tsx src/components/learning/learning.test.tsx src/app/api/learning/quiz-routes.test.ts src/lib/server/learning/quiz.test.ts scripts/agent-trial/offline-provider.test.ts scripts/agent-trial/student-policy.test.mjs
npm run lint
npm run build
git diff --check
git status --short
```

必须记录每条命令、退出码、实际测试文件/用例数、失败或跳过原因；零测试不能算通过。`npm run lint` 已包含 Next typegen 和 TypeScript，不必重复拆开执行。build 前先停本次占用 `.next` 的本地服务。Cloud 对应使用正式的 `cloud:test`、`cloud:check`、`cloud:build` 入口，Cloud 结果与 Windows 结果分栏记录。

## 6. 默认离线体验

默认启动不继承真实密钥，不发送真实 Provider 请求：

```powershell
node scripts/agent-trial/launch.mjs start
```

默认数据目录为 `output/agent-a0-a1-offline`，地址为 `http://127.0.0.1:37951`。另一个终端可执行 `node --import tsx scripts/agent-trial/seed.ts`，保存手工合成教材与框架；seed 本身不调用模型。离线启动器显式预加载 `offline-provider.cjs`，仅在 Responses 边界返回标注清楚的固定决策/生成 fixture；真实应用 API、业务服务与 SQLite 仍实际执行，底层外联保护保留。fixture 请求单独记入 `offline-provider.sqlite`，真实 Provider 网络请求数为 0。

可运行相同浏览器的 `before-restart`、正常停止/启动、`after-restart` 顺序验证离线业务闭环，使用同一离线目录且启动命令不带 `--real`。`runtime.json` 与浏览器结果的 `evidenceMode` 必须为 `offline`；它不能证明真实模型行动选择、生成质量或两条真实闭环。结束执行 `node scripts/agent-trial/launch.mjs stop`，以 `status` 确认本次进程已停，数据保留。启动器与两种 preload 在写入前对称拒绝相反模式的 runtime 或账本，原目录保持不变；真实模式必须使用独立目录，不能重标旧 fixture 结果。

## 7. 获准后的 Windows 真实启动与协议验证

以下代码只设置非秘密的试验路径。将路径放在独立 checkout 的忽略输出目录，两个终端都设置同一个绝对路径；不要把历史 Cloud 输出改名为 Windows 证据：

```powershell
$env:AGENT_TRIAL_DIR = Join-Path (Get-Location) "output/agent-a0-a1-windows"
New-Item -ItemType Directory -Force $env:AGENT_TRIAL_DIR | Out-Null
```

只在已获 Windows 真实调用授权且安全环境已注入密钥后，终端 A 执行：

```powershell
node scripts/agent-trial/launch.mjs start --real
```

显式 `--real` 使用真实模式；未覆盖时它的默认目录为 `output/agent-a0-a1-windows`。保留终端 A 的启动器进程，等待 loopback 应用就绪。在终端 B 使用相同 `AGENT_TRIAL_DIR`：

```powershell
node scripts/agent-trial/launch.mjs status --real
node --import tsx scripts/agent-trial/seed.ts
```

`seed` 通过实际注册/登录、Learning API 保存两位合成学生的课程；框架是明确标注的手工 fixture，不宣称模型生成。重跑会校验既有教材哈希，不覆盖已冻结教材或标准答案。生成的 `synthetic-accounts.json` 仅供本机合成账号登录，不提交或公开该文件。

协议验证必须显式传入 `--real`、加载同一网络 guard 和同一 Windows 账本，缺少任一条件时脚本拒绝执行。先只在文件不存在时保存合成空课程库存，再运行：

```powershell
$env:AGENT_TRIAL_PHASE = "protocol"
$inventory = Join-Path $env:AGENT_TRIAL_DIR "protocol-course.json"
if (!(Test-Path $inventory)) { [IO.File]::WriteAllText($inventory, '{"materials":[]}') }
node --require ./scripts/agent-trial/guard.cjs scripts/agent-trial/protocol.mjs --real
node --require ./scripts/agent-trial/guard.cjs --import tsx scripts/agent-trial/protocol-structured.ts --real
Remove-Item Env:AGENT_TRIAL_PHASE
```

逐条保存退出码，第一条失败不等于第二条不能验证。真实可用证明必须包含模型选读取动作、实际读回库存、模型依据空库存改变动作、完整流式完成及请求用量；只出现 `tool_calls` 不算闭环。原生失败如实保留，不能将结构化协议成功改写为原生成功。正式业务使用结构化协议；结构化验证被阻塞时停止真实业务调用，报告 BLOCKED。

## 8. 两条业务轨迹、正常停启与重登

终端 B 执行第一阶段：

```powershell
node scripts/agent-trial/browser.mjs before-restart
```

脚本使用真实应用、认证、SQLite、Quiz 服务和真实模型；浏览器只负责模拟学生操作，不 mock 模型或题目。A 的冻结目标是薄弱点不明确，B 的冻结目标是明确不懂概念。必须依据行动记录证明 A 可先诊断，B 先解释后依据用户反馈练习，不能只凭界面文案或预期路径推定模型已选择。

第一阶段应留下两条真实题组及持久作答等待，验证等待刷新零请求、暂停后继续无新作答零请求，保存应用进程身份。第一阶段通过后正常停止，再启动同一数据目录：

```powershell
node scripts/agent-trial/launch.mjs stop --real
node scripts/agent-trial/launch.mjs status --real
```

等终端 A 退出、`runtime.json` 标明停止且端口释放后，在终端 A 重新执行 `node scripts/agent-trial/launch.mjs start --real`；不要同时启动第二个应用，也不要改目录、删除数据库或重新造任务。终端 B 再执行：

```powershell
node scripts/agent-trial/browser.mjs after-restart
```

第二阶段校验应用进程与启动时间确实变化，原等待任务从磁盘恢复；退出登录时 API 返回 401，重新登录仍可打开任务。模拟学生通过现有 Quiz 组件实际 choose/finish 保存作答：A 按冻结策略选错误选项，B 选正确选项；标准答案只给模拟学生脚本，不进入决策输入，脚本不改原题与答案、不直接写分数。

作答完成后由“已完成作答，继续复习”提交受认证事件；模型必须读取实际结果，并产生可追溯的后续业务行动。比较两条轨迹的后续行动序列，进入持久等待、合理交回或有依据的结束。测试脚本得分只能证明程序保存/评分链路，不能证明题目正确或真人学习效果；另行人工审阅生成题目、选项理由、解释与来源。

阶段失败时保留证据，不重复创建任务制造理想轨迹。已有作答完成后不要无条件重跑第二阶段，它会拒绝改写已完成作答。可使用 `node scripts/agent-trial/browser.mjs inspect` 做只读检查，并定位首个失败后决定有界复验。

## 9. 额外核对与证据收口

以下项目使用保留的隔离合成数据，额外真实请求仍受同一授权和账本约束。会删除来源或改变任务状态的检查，应使用专用合成页，保留 A/B 主轨迹供继续体验。

| 检查 | 操作与应见结果 |
| --- | --- |
| 重复事件 | 第二阶段已重放相同反馈事件；再次提交同一事件应读回收据，题组数、行动数和 Provider 请求数均不增加。跨窗口重复提交相同作答也不得重建题组 |
| 来源删除/变化 | 在另一窗口删除专用合成来源后刷新任务；旧解释不再作为证据、无新动作，原文不可通过 Agent 日志或 checkpoint 读回。旧题与成绩按原契约保留，不能因此绕过当前来源检查 |
| 取消和晚到结果 | 等待时取消立即持久生效；另用确定性延迟测试检查执行中取消后晚到结果不能继续推进。已完成业务写入保留，不声称已撤回。浏览器取消未实际执行时单独标 NOT RUN |
| 疑题 | 等待题组时填写“这道题有疑问”并提交；Agent 停止用该题组分数判断薄弱点，可回源/解释/交回；旧正确答案与成绩不改 |
| unknown | 使用隔离的确定性故障测试验证网络结果未知进入 `needs_attention`、不自动重发。不要为制造 unknown 故意断开真实付费请求；若真实运行自然发生 unknown，记录账本与 operation ID，先查询原结果再处理 |
| 权限与答案揭示 | 另一合成账号读取任务/题组应拒绝；未交卷题组接口、任务日志和界面不得提前出现正确选项或答案解析；范围外读取必须拒绝 |
| 旧手动学习 | 手动框架、原有追问入口和 Quiz 仍可访问；需要真实生成的回归另计请求。不得为了验收访问 OCR/ASR、修改其他产品或部署服务器 |

保留 `runtime.json`、冻结输入、seed 结果、`browser-state.json`、两阶段检查与结果 JSON、轨迹 JSON、模拟学生作答结果、截图、用量账本及私有题目审阅文件。合成账号口令、原始 Provider 错误正文和密钥不进入可公开报告。报告必须分别写明离线/mock、真实模型、模拟学生、Windows 环境和提交 SHA；`browserClosed: true` 只表示脚本关闭浏览器，不代表所有验收项通过。

完成后执行 `node scripts/agent-trial/launch.mjs stop --real`，确认仅本轮所属进程已停止；保留课程、题组、任务和作答。继续体验时使用相同数据目录启动并登录合成账号，在原学习页打开“自适应复习·试用”；任何新的真实推进仍需在有效授权和剩余额度内。生产 build 后可使用 `start --real --production`，也必须先停开发服务。

## 10. 本轮上限与待验状态

- Windows 的协议兼容、两条真实模型轨迹、真实 Quiz/解释质量、浏览器正常重启/重登、设备表现与最终构建均为 **PENDING**，由 Windows 对交付 SHA 实际验证后更新结果；不要复制历史 Cloud PASS。
- A0/A1 实现是串行、固定目标与授权范围的试用原型。共享层有非 Learning 合成场景测试；这不代表 Work Agent 或跨入口总管已经实现。
- 正常等待重启可继续；运行中异常崩溃或外部结果未知保守停止。当前没有完整人工对账中心，不承诺全系统 exactly-once、生产稳定或教学效果。
- A2 留待复杂中途改目标/权限、审批交互、长期调度、运行中崩溃后的产品级对账恢复；A3 留待真实多场景复用价值、跨产品权限与长期可靠性验收。
- 本交接不授权合并 `main`、生产部署、OCR/ASR 调用、真实用户数据迁移或自动进入 A2/A3。按 Windows 对应会话的明确范围执行。

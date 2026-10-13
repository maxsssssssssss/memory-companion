# Daily Brief Agent A2：Windows 接手与验收

> 历史阶段记录。最终 Agent V1 请统一执行 [Windows 验收计划](agent-v1-windows.md)，不重复四个阶段的任务，也不继承旧调用额度。

本文件是执行交接，不是验收通过记录。A2 的 Windows 真实模型、生成质量和最终提交验收均为 **PENDING**；Cloud 只提供合成数据、离线 Provider、真实业务代码与本地测试证据。实际通过项目、命令退出码及最终 SHA 以本轮最终报告为准。

## 1. 版本与独立工作区

| 版本 | 证据边界 |
| --- | --- |
| A1 `c0786b48947cdc059052c6b07d421f290cc3f1d1` | 用户报告该旧 SHA 的最小 `structured_action_v1` 协议验证通过；不能据此宣称后续 SHA、A2 或完整业务轨迹通过 |
| 独立 JSON 修复 `0feb4721de0734dc2bb1dac8390cd4659293a553` | 单独的结构化 JSON 修复提交；不能继承 A1 的真实 PASS |
| A2 `feat/learning-agent-a2` | 用最终交付对话给出的完整 40 位 SHA 验收；本文件随该提交版本化，不用分支名或上表旧 SHA 替代最终 SHA |

仓库为 `maxsssssssssss/memory-companion`。在新的独立 checkout 检出最终交付 SHA，保留现有 Windows 工作区、dirty 改动和数据；不要 reset、clean、stash 或覆盖旧实现。记录以下输出，detached HEAD 如实记录：

```powershell
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
```

先读该提交的 `AGENTS.md`、`DESIGN.md`、`docs/codex-cloud.md` 和 `UPDATE_HISTORY.md` 近期记录。历史 A1 交接仅作背景；本文件的 A2 目录、显式预算和不复验原生协议要求适用于本次验收。

需要 Node.js >= 22.13、该 checkout 的锁文件依赖和本机浏览器。在新 checkout 执行 `npm ci`，不升级依赖或修改锁文件。浏览器优先使用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定的本机可执行文件，其次 Playwright 已安装的 Chromium，再查本机 Chrome/Edge 等路径；脚本不会下载浏览器。启动失败应记录为环境阻塞，不能算用例通过。

## 2. 当前实现与迁移边界

继续使用正式 MIT 包 `@langchain/langgraph@1.5.0`、`@langchain/langgraph-checkpoint-sqlite@1.1.0`、`@langchain/core@1.2.17`，未增加第二套 Agent 引擎。正式协议仍只有 `structured_action_v1`，复用现有 Responses 流式传输和严格结构化 JSON 校验。本次不复验原生 tool calling，不新增 Provider 或模型选型。

A2 在同一任务中增加目标/范围版本、待确认笔记追加和分类恢复。模型选择合法业务动作；账号、权限、来源、版本、批准条件、串行执行、预算和可恢复方式仍由程序检查。普通读取和 Quiz 不逐步弹审批；追加个人笔记需要对固定目标、正文、引用与补充标记明确批准。修改目标或范围不重置预算。

隔离目录下的 `data/users/<合成账号 ID>/` 按账号保存：

| 数据库 | A2 增量与职责 |
| --- | --- |
| `agent-tasks.sqlite` | 任务、行动、调用、事件增加版本，A1 行默认版本 1；增加恢复信息、审批收据与控制去重表。任务记录是生命周期和预算权威 |
| `agent-checkpoints.sqlite` | LangGraph 执行位置与中断引用；继续使用正式 Saver，不保存一份 Learning 原文或笔记正文作为第二权威 |
| `learning-organizer.sqlite` | Agent artifact 增加 `task_version`，保存任务内解释、题组引用和笔记提案。题目、作答、成绩和个人笔记仍由原业务服务管理 |

首次打开相应 repository/Agent 服务时按列检查并自动执行幂等增量迁移，不需手工运行 SQL。审批正文由当前仍有权限的 Learning 提案投影，共享审批只保留引用、摘要和校验信息；来源/目标笔记变化后不能靠旧审批继续追加。旧 A1 fixture 的迁移检查入口是 `scripts/agent-trial/a2-migration.test.ts`，不需要接触真实用户数据库。

本次只用合成数据。不要导入真实 `.env`、用户数据库、个人登录态或生产文件。停止进程后保留整个隔离目录及 SQLite 配套文件；不要只复制运行中的单个 `.sqlite` 文件当成一致备份。

## 3. 离线检查命令

以下是待执行命令，不表示本文件宣称 PASS。在没有真实 Provider 配置的测试终端运行并分别记录退出码、实际发现的文件/用例数和失败、跳过原因：

```powershell
npm test -- src/lib/server/openai/structured-json.test.ts src/lib/server/agent/model.test.ts
npm test -- src/lib/server/agent/runtime.test.ts src/lib/server/learning/agent-a2.test.ts src/lib/server/learning/agent-scenario.test.ts src/app/api/learning/agent-routes.test.ts scripts/agent-trial/a2-migration.test.ts scripts/agent-trial/a2-fixtures.test.ts scripts/agent-trial/credential-adapter.test.mjs scripts/agent-trial/request-budget.test.ts
npm test -- src/components/learning/learning-agent-panel.test.tsx src/components/learning/learning-quiz.test.tsx src/components/learning/learning-framework.test.tsx src/components/learning/learning.test.tsx
npm run lint
npm run build
git diff --check
git status --short
```

`lint` 已包含 Next typegen 与 TypeScript。build 前停本 checkout 占用 `.next` 的应用。Cloud 对应使用 `cloud:test`、`cloud:check`、`cloud:build`；Cloud 与 Windows 的结果分开记录。零测试、文件遗漏或历史记录不能代替本次执行。

Cloud 扩展执行一次全仓 `cloud:test` 时，既有 `pdf-parser-service.test.ts` 在加载阶段要求 Windows 本地的旧 PDF 交接 fixture，Cloud 没有该文件；另外两项新增明确重试测试在修复前失败，修复后已定向通过。最终 A2 聚焦门禁与全仓结果分别记录；不要将此缺失 fixture 改成合成数据后宣称旧 PDF 回放通过，也不要求本轮访问 OCR 服务。

## 4. 可重复离线体验：六账号与正常重启

所有终端进入同一独立 checkout，并设置相同绝对路径。A2 默认就是 `output/agent-a2-offline`，仍建议显式写出路径防止混用：

```powershell
$env:AGENT_TRIAL_DIR = Join-Path (Get-Location) "output/agent-a2-offline"
node scripts/agent-trial/launch.mjs start
```

保留终端 A 的启动器，等待 `http://127.0.0.1:37951` 就绪。终端 B 设置相同目录后运行：

```powershell
node scripts/agent-trial/launch.mjs status
node --import tsx scripts/agent-trial/seed.ts --a2
node scripts/agent-trial/a2-browser.mjs before-restart
```

seed 通过实际认证/API 保存六个合成账号 A–F 的课程，框架是明确标注的手工 fixture，本身零 Provider 请求。`synthetic-accounts.json` 仅供本机合成账号登录，不提交或公开。重跑会校验冻结教材，不覆盖已有题目、标准答案与作答。

`before-restart` 用真实组件保存 A 的模拟作答，读取实际成绩后预览并确认缩小目标/授权；B 展示笔记提案并停在待批准状态，未批准时笔记不变。随后终端 B 请求正常停止：

```powershell
node scripts/agent-trial/launch.mjs stop
node scripts/agent-trial/launch.mjs status
```

等待终端 A 退出、`runtime.json` 出现停止信息且端口释放。终端 A 在**同一数据目录**重新执行 `node scripts/agent-trial/launch.mjs start`。终端 B 再执行：

```powershell
node scripts/agent-trial/a2-browser.mjs after-restart
node scripts/agent-trial/a2-browser.mjs faults
node scripts/agent-trial/a2-browser.mjs inspect
```

`after-restart` 核对进程身份已变化、B 的同一审批从磁盘恢复，明确批准后只追加一次，重复事件不重复写入。`faults` 使用专用合成账号检查拒绝、版本/来源变化、取消与晚到结果、题组已写入但共享回执丢失、并发核对、unknown、明确失败和预算/无进展停止。C 的来源会被删除，不要用主体验账号代替故障账号。`inspect` 只读现有任务与截图，不自动重新推进。

另有独立的运行中崩溃检查，在正常两阶段完成后运行：

```powershell
node scripts/agent-trial/a2-browser.mjs crash-before
```

该阶段只对精确匹配的合成账号、任务、版本和 Quiz 收据注入故障：题组业务事务已提交、共享行动收据尚未保存时，应用进程以故意注入的退出码 `86` 结束。`offline-fault-exit.json` 保存这个边界，不手工改任务状态或租约。记录故障应用退出与浏览器断言脚本退出码，不能把两者混为同一个结果。

确认旧应用进程已退出并释放端口，在终端 A 用同一数据目录重新执行 `node scripts/agent-trial/launch.mjs start`，再在终端 B 执行：

```powershell
node scripts/agent-trial/a2-browser.mjs crash-after
node scripts/agent-trial/a2-browser.mjs inspect
```

`crash-after` 先验证启动没有自动重新生成；若任务仍显示运行，通过受认证的暂停操作废止旧租约，再并发核对原操作。应恢复原 Quiz ID 与作答等待，生成计数不增加。失败时保留原任务，只执行对应恢复阶段或检查，不重新造题掩盖回执丢失。

**`a2-browser.mjs` 的全部阶段都只支持 offline。** 它会拒绝 `evidenceMode=real`；不要去掉门禁或把 fixture 结果改名为真实证据。故障控制文件只用于离线 Responses/共享收据边界，应用 API、SQLite 和业务写入实际运行。离线请求记录在 `offline-provider.sqlite`，真实 Provider 请求数应为 0。失败后保留 `a2-state.json`、`a2-<阶段>-result.json`、`a2-<阶段>-checks.json`、`a2-task-<ID>.json`、截图和数据库，先定位失败，不重建数据制造 PASS。

## 5. 获准后的 Windows 真实配置

本文件不授予真实调用额度。执行前需要 Windows 当前任务的明确授权，冻结已确认 DS 通道、计划和本次总额度；**历史 36 次额度不继承，新的空账本也不产生新授权**。不得调用 OCR/ASR、其他产品 Agent、远程部署或新增收费服务。

真实密钥只从 Windows 安全环境注入。支持默认专用变量 `DAILY_BRIEF_OPENAI_API_KEY`，也支持显式 `--credential-env OPENAI_API_KEY` 选择已经确认属于既有 DS 通道的密钥；变量名像 OpenAI 不代表允许切换到另一个 Provider。适配器只为子进程映射 `OPENAI_API_KEY` / `LEARNING_AGENT_API_KEY` 别名，不改父环境、不读写 `.env`、不复制或输出密钥。

| 配置名 | 本次用途 |
| --- | --- |
| `AGENT_TRIAL_DIR` | 独立真实目录，建议 `output/agent-a2-windows`；不可使用离线目录或历史 Cloud 证据目录 |
| `AGENT_TRIAL_MAX_REQUESTS` | 本次获准的总真实请求上限，显式整数 `1..36`；36 只是脚本硬上限，不是默认授权 |
| `AGENT_TRIAL_PROTOCOL_MAX_REQUESTS` | 上述总额度内允许的结构化协议请求上限，显式整数 `1..总额度`；配置额度不等于要求发出请求，协议只做必要最小验证 |
| `DAILY_BRIEF_OPENAI_API_KEY` / `OPENAI_API_KEY` | 只选择已获准的一个安全环境变量，不在文档或命令中填写值 |
| `LEARNING_AGENT_DECISION_*` / `LEARNING_AGENT_GENERATION_*` | 启动器分别配置决策和 Agent 内生成，保持现有手动学习默认模型行为 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | 可选的本机浏览器路径，不是联网下载开关 |

启动器固定 TokenHub / `deepseek-v4-pro`，关闭外部 trace 和 Next 遥测。网络 guard 限制已选 Responses 目的地、流式完成、`store:false`、单请求总输入 48,000 字符与输出 8,000 tokens；自动重试关闭。`network-ledger.sqlite` 计入协议、决策、内部 Quiz/解释、失败与未知请求；usage 缺失记未知，不按零处理。启动和协议脚本都必须使用同一目录与显式额度，不能删除账本重置计数。

安全环境已注入选定密钥并按本次授权设置两个预算变量后，在终端 A 执行：

```powershell
$env:AGENT_TRIAL_DIR = Join-Path (Get-Location) "output/agent-a2-windows"
if (!$env:AGENT_TRIAL_MAX_REQUESTS -or !$env:AGENT_TRIAL_PROTOCOL_MAX_REQUESTS) { throw "先按本次授权显式配置总额度和协议额度" }
node scripts/agent-trial/launch.mjs start --real --credential-env OPENAI_API_KEY
```

终端 B 使用相同路径和预算，执行 `node --import tsx scripts/agent-trial/seed.ts --a2`。这仍只造合成教材与框架。缺密钥、授权、额度或通道兼容证据时标 **BLOCKED**；不得借其他变量/Provider 静默回退。

如果本轮授权要求对最终 A2 SHA 重新做最小结构化协议验证，只有以下正式入口，计划计入两次请求；不执行 `protocol.mjs` 的原生探测：

```powershell
$inventory = Join-Path $env:AGENT_TRIAL_DIR "protocol-course.json"
if (!(Test-Path $inventory)) { [IO.File]::WriteAllText($inventory, '{"materials":[]}') }
node --require ./scripts/agent-trial/guard.cjs --import tsx scripts/agent-trial/protocol-structured.ts --real --credential-env OPENAI_API_KEY
```

通过证据必须包括真实模型选择受限读取、实际返回空课程库存、据此选择请求材料及流式完成，用量和退出码可核对。缺任一环节不能宣称闭环通过。旧 A1 的用户报告不能替代此最终 SHA 的执行证据，也不要求无授权重跑。

## 6. 真实模式按 UI 核对的业务合同

真实模式的 A2 自动浏览器故障脚本未提供，需 Windows 在上述隔离应用用合成账号按 UI 操作。每条轨迹记录任务 ID、版本、行动工具、真实题组/解释 ID、下一步变化、用量和最终状态；实际模型选择可能不同，不把固定 fixture 轨迹当成模型必须输出的答案。真实题目和解释单独审阅来源与正确性，不用模拟学生分数证明生成质量。

| 项目 | 操作与应见结果 |
| --- | --- |
| 真实行动与反馈 | 一个目标薄弱点不明确，另一个目标明确概念不懂。由模型选择工具，实际保存 Quiz/解释；经原有答题组件保存后点“返回本轮复习”和“已完成作答，继续复习”，实际读回结果改变下一动作。未作答刷新不调用模型 |
| 目标/授权与 CAS | 点“调整本轮复习”，增减当前页材料/章节/知识点及历史、笔记、补充权限，先看“调整前后预览”再确认。版本增加、旧等待/审批失效、预算累计。另一窗口先更新后提交旧编辑，应返回版本冲突，草稿保留；刷新后明确重新比对才能提交 |
| 笔记批准/拒绝 | 看清目标、准确正文、来源和是否含补充；不批准时保持待确认。拒绝不写笔记；批准只追加一次，不覆盖旧笔记/框架。普通读取与 Quiz 不逐动作审批。目标笔记被另一个编辑器保存修改后，旧审批不能覆盖新内容 |
| 正常重启/重登 | 分别在等待作答与待审批时正常停止应用，以同目录重启。重新登录后恢复同一任务/审批；关闭页面和 GET 都不能默认为批准或反馈，不占长 HTTP 等待 |
| 重复/并发事件 | 保存同一受认证事件 ID、版本和批准指纹后重放，或两个窗口重复核对。只读回原业务结果，笔记、题组与内部生成不重复。另一个账号读取同一任务必须拒绝 |
| 来源变化 | 专用合成页删除/重新解析来源后刷新，旧解释/审批不再可用。重新确认范围前不能继续使用旧观察；撤销授权后下一版本不读取已撤内容。历史题与成绩存在不代表来源仍获授权 |
| 取消/晚到结果 | 等待时取消后不再推进；执行中取消/改范围后晚到响应不能按旧权限发布或继续。已经完成的业务写入按原契约保留，不宣称已撤回；确定性延迟证据来自离线用例 |
| unknown 与检查 | 自然出现结果未知时点“核对原操作结果”，该操作只查询原操作，不发新生成。没有结果仍标未知，不显示通用重试；不要故意断开付费请求制造 unknown。有明确失败/未开始证据且界面允许时才能明确重试 |
| 笔记/答题草稿 | 已打开的框架编辑草稿不应被 Agent 刷新覆盖；Agent 追加后返回“阅读框架”可读回保存结果。旧手动 Quiz、框架与追问继续可用，真实生成回归另外计入同一额度 |

运行中意外崩溃属于不同于正常等待重启的检查：重启不会后台自动重播任务。若任务还显示运行，先明确暂停以废止旧执行租约，再核对原结果；结果仍未知就保持停止、调整范围或结束交回，不能按失败盲重发。核对后若状态为准备执行，必须点“继续任务”才继续决策；“核对”本身不启动模型。崩溃租约的计算时间若无法精确计量，会保守计入累计预算，界面标明“含崩溃后保守估算”，不伪称精确用时。

笔记追加成功后当前实现会交回并结束本轮；需要继续复习时新建任务，而不是声称已通过学习检查。预算耗尽、用户取消、任务交回和学习检查结果必须分别记录，不生成长期掌握百分比。

## 7. 停止、保留与回退

结束或额度耗尽后执行同目录的 `node scripts/agent-trial/launch.mjs stop --real`，再用 `status --real` 与启动器退出确认只停止本轮进程。离线模式不带 `--real`。保留合成课程、任务、题组、作答、审批、两阶段记录、截图与用量账本；不自动删除整套体验成果。后续同目录启动可继续看历史，新的真实推进仍需有效授权和剩余额度。

回退代码使用另一个独立 checkout 检出已知 A1 SHA `c0786b48947cdc059052c6b07d421f290cc3f1d1`，配独立 A1 数据目录或停机后保存的迁移前合成数据副本。**不要让 A1 代码直接写入已经由 A2 迁移的数据库，也不要手工删列/删表做降级。** 保留 A2 原目录和故障证据用于定位；不能通过覆盖既有 Windows 工作区或删除账本完成回退。

A2 仍是本页、串行、有界的试用实现，不承诺全系统 exactly-once、教学效果或生产稳定。A3 多场景复用/长期可靠性、长期日程、全局 Memory、多 Agent 总管和跨产品行动均不在本次范围。本交接不授权合并 `main`、生产部署或真实用户数据库迁移。

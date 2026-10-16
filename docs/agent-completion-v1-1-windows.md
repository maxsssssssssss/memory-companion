# Learning Agent V1.1：集中 Windows 验收交接

本文件只针对本次最终交付 SHA。旧 Agent V1 的真实 PASS 不代表 V1.1 的目标拆解、证据关联或自主停止通过。Cloud 使用合成材料与离线模型响应；Windows 真实语义验收为 PENDING。本文件不授予真实请求预算，也不继承此前 34/36 的账本余额。

2026-10-16 首次 V1.1 验收已报告 BLOCKED，冻结版本为 `495c2e1fa81a892080f55cc5bcf56cbfe3ab48e6`。**本次返修请优先执行 [整包返修交接](agent-completion-v1-1-repair.md)**：沿用现有 V1.1 的 17 次请求账本与原任务，不按下文首次安装步骤重新 seed、重建真实目录或获得新额度。新 SHA 的真实验收仍待 Windows 定向完成。

## 检出、安装与离线继续体验

保留已有工作区与数据，在独立目录检出交付 SHA，不复制 `.env.local`、私人资料或原验收数据库：

```powershell
git clone --branch feat/learning-agent-completion-v1-1 https://github.com/maxsssssssssss/memory-companion.git memory-companion-completion-v1-1
Set-Location memory-companion-completion-v1-1
$CompletionSha = Read-Host "粘贴本次交付完整 SHA"
if ($CompletionSha -notmatch '^[0-9a-f]{40}$') { throw "需要完整 SHA" }
git switch --detach $CompletionSha
git rev-parse HEAD
git status --short
node --version
npm ci
```

Node >= 22.13.0；锁文件安装不升级依赖。本次扩展既有 `learning_agent_artifacts` 的受约束种类及 JSON 内容、Quiz 保存的可选复习上下文，没有新增数据库/表或外部服务。打开隔离数据时由原 repository 初始化既有表；不对用户真实数据库执行迁移。新任务含 `completionVersion: 1`，旧任务缺少计划时保持历史回顾，不补造通过。

终端 A：

```powershell
$env:AGENT_TRIAL_DIR = Join-Path (Get-Location) "output/agent-completion-v1-1-offline"
node scripts/agent-trial/launch.mjs start
```

终端 B：

```powershell
$env:AGENT_TRIAL_DIR = Join-Path (Get-Location) "output/agent-completion-v1-1-offline"
node scripts/agent-trial/launch.mjs status
node --import tsx scripts/agent-trial/seed.ts --manual
node --import tsx scripts/agent-trial/seed.ts --manual
```

应显示 loopback `http://127.0.0.1:37951`、`evidenceMode=offline`。两次 seed 都不调用模型，第二次不重置已有课程、笔记、成绩、任务或删除结果。合成登录信息位于此目录的 `synthetic-accounts.json`。在学习整理页进入“复习向导”，使用该页显式选中的合成材料。不要用旧 A2 固定浏览器流程证明 V1.1 语义；本轮 UI 检查以“本轮要检查什么”“本轮判断”“疑问已解决 / 仍需说明”为准。

新的集中浏览器入口仍复用同一启动器和数据，不另建服务：

```powershell
node scripts/agent-trial/completion-browser.mjs before-restart
node scripts/agent-trial/launch.mjs stop
node scripts/agent-trial/launch.mjs status
```

确认终端 A 退出后，以同一目录在终端 A 再次启动；终端 B 执行：

```powershell
node scripts/agent-trial/completion-browser.mjs after-restart
node scripts/agent-trial/completion-browser.mjs inspect
```

`before-restart` 保留解释等待和真实未作答题组；`after-restart` 从原任务继续，页面明确解决后零新请求结束，以及通过原 Quiz 组件提交模拟学生作答、满足目标后零额外决策停止。脚本校验刷新/登出重登零请求、真实外联为零，并将截图与逐项检查保存到同一目录的 `completion-runs/` 与 `completion-*-result.json`。该脚本拒绝真实模式；失败应保留原数据和失败输出，不重建场景抹去证据。

Windows 离线工程命令（Cloud 最终交付报告另列正式 `cloud:*` 命令及实际数量）：

```powershell
npm test -- src/lib/server/learning/agent-completion.test.ts src/app/api/learning/agent-completion-flow.test.ts src/lib/server/learning/quiz-review-purpose.test.ts src/lib/server/agent/runtime.test.ts src/lib/server/learning/agent-scenario.test.ts src/lib/server/learning/agent-a2.test.ts src/lib/server/learning/agent-source-binding.test.ts src/lib/server/learning/agent-context.test.ts src/lib/server/learning/agent-review-summary.test.ts src/app/api/learning/agent-routes.test.ts src/app/api/learning/quiz-routes.test.ts src/components/learning/learning-agent-panel.test.tsx
node scripts/agent-trial/launch.mjs stop
node scripts/agent-trial/launch.mjs status
npm run lint
npm run build
git diff --check
```

先等待自有服务退出再构建；使用 production 体验时以相同目录 `node scripts/agent-trial/launch.mjs start --production`。停止并重启后应保留相同计划、作答、解释、版本和完成结果。刷新、重登、等待、重复反馈不增加模型调用。实际 Windows 进程退出码如实记录，强制终止 exit 1 不写成优雅退出 0。

## 后续单独授权的真实配置

沿用正式 `structured_action_v1`，不重试原生 tools 协议，不更换 Provider。只有 Windows 后续明确授权 SHA、通道与总请求额度后才能启用下列真实入口：

| 变量/参数 | 用途 |
| --- | --- |
| `AGENT_TRIAL_DIR` | 独立真实合成验收目录，与离线目录双向隔离 |
| `AGENT_TRIAL_MAX_REQUESTS` | 本轮单独授权的总上限；所有决策、生成、失败和 unknown 都计入 |
| `AGENT_TRIAL_PROTOCOL_MAX_REQUESTS` | 同一账本中的协议子上限，不是新增额度 |
| `DAILY_BRIEF_OPENAI_API_KEY` | 现有启动器默认的安全环境变量名称；不要输出值 |
| `--credential-env OPENAI_API_KEY` | 仅在 Windows 已确认它对应获准 TokenHub 通道时，临时映射给子进程 |
| `LEARNING_AGENT_DECISION_*`、`LEARNING_AGENT_GENERATION_*` | 启动器设置独立决策/生成配置；不更改手动 Learning 默认值 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | 可选，本机 Chromium/Chrome/Edge 的实际路径 |

不扫描私人配置，不读写真实密钥文件，不复制 `.env.local`。如配置缺失，停止真实启动并报告变量名。默认离线不读取这些真实值。trace、遥测和隐式自动重试保持关闭。

启动器设置的完整配置名是 `LEARNING_AGENT_DECISION_PROVIDER`、`LEARNING_AGENT_DECISION_MODEL`、`LEARNING_AGENT_DECISION_MAX_INPUT_CHARS`、`LEARNING_AGENT_DECISION_MAX_OUTPUT_TOKENS`、`LEARNING_AGENT_DECISION_REQUEST_TIMEOUT_MS`，以及对应的 `LEARNING_AGENT_GENERATION_PROVIDER`、`LEARNING_AGENT_GENERATION_MODEL`、`LEARNING_AGENT_GENERATION_MAX_INPUT_CHARS`、`LEARNING_AGENT_GENERATION_MAX_OUTPUT_TOKENS`、`LEARNING_AGENT_GENERATION_REQUEST_TIMEOUT_MS`。推荐使用启动器，不另行更改手动 Learning 的默认配置。

```powershell
$env:AGENT_TRIAL_DIR = Join-Path (Get-Location) "output/agent-completion-v1-1-real"
if (!$env:AGENT_TRIAL_MAX_REQUESTS -or !$env:AGENT_TRIAL_PROTOCOL_MAX_REQUESTS) { throw "先取得本轮独立调用授权并设置上限" }
node scripts/agent-trial/launch.mjs start --real --credential-env OPENAI_API_KEY
```

另一终端设置相同目录，`node --import tsx scripts/agent-trial/seed.ts --real` 只准备合成来源，不重建旧 Windows 账本或历史。本轮无需新增课程主题、OCR、ASR、模型对比或多轮 Prompt 实验。

若后续任务明确要求正式协议最小复验，再执行原入口：

```powershell
$inventory = Join-Path $env:AGENT_TRIAL_DIR "protocol-course.json"
if (!(Test-Path $inventory)) { [IO.File]::WriteAllText($inventory, '{"materials":[]}') }
node --require ./scripts/agent-trial/guard.cjs --import tsx scripts/agent-trial/protocol-structured.ts --real --credential-env OPENAI_API_KEY
```

预期仍为模型选择 read_scope → 程序读取空库存 → 模型收到真实结果后 request_material。它最多证明协议，不代替下面的业务验收。

## 三条有限真实轨迹

每条至多两个新题组是本次验收范围建议，不是产品通过阈值。请求总预算由 Windows 任务另定，不能在本文件自动授权。使用固定合成教材；真实生成的题目和解释需有限人工复核，模拟学生的得分不是题目质量或学习效果证明。标准答案和预期动作不能提前喂给决策模型。

| 轨迹 | 操作与检查结果 | 结束条件 |
| --- | --- | --- |
| W1 解释疑问 | 明确请求解释交集/并集中的归属条件。核对短计划、真实解释及引用。先反馈“谢谢”，确认没有自动当成解决；再点“疑问已解决”。 | 保存明确反馈后直接结束为“疑问得到解决”；不强制出题、不写检查通过或长期掌握。重启/重复反馈零追加调用。 |
| W2 补一个真实目标缺口 | 选择针对性复习或章节检查。人工先核对约定目标、要求与来源；提交真实应用作答。高分但有未覆盖核心目标时，只补该缺口；查看实际保存题目与目标关联，不能只看模型标签。 | 取得约定的足够暂定证据后停止；不再产生额外 Quiz/决策请求。若目标或题目语义不可靠，保留部分/不足，不为过关降低要求。 |
| W3 辅助或反证 | 一题先用提示后正确；或针对规则适用条件作出一个错误回答。观察相关后续检查/实质不同解释，核对旧错答仍可回查、重复订正不被当成新情境迁移。 | 无足够支持时不提前通过；继续必须有明确目的。相同方法无进展时交回或换有区别的方法，不无限出题。 |

真实语义重点是：目标是否合理、逐题关联是否确实成立、后续题是否针对原困难且有意义、结束是否过早或无谓延长。程序只能核对来源/权限/真实提交与映射身份；这些语义不由程序判分或模型自评分证明。

## 无需真实调用的异常复验

用冻结的十组离线测试统一复验：提示时间边界、重复题、边界误用、争议/来源删除、旧评估失效、早 finish、已充分仍出题、prepared 恢复前检查。再复验正式 API 的重复事件、并发恢复、暂停取消、重登重启、累计预算和答案保护。不要在真实收费请求上注入中断或反复点击重试 unknown。

解释反馈另有两轮离线回归：对同一解释先点“仍需说明”，Agent 重新请求反馈后可点“疑问已解决”，不强制新解释或 Quiz。旧轮次的事件保持原样，重放不会推进新轮次；同一收据改答冲突，结束后的同内容重复提交零调用。不要把首次仍需说明解释成用户永远不能再解决。

调整目标后显示新版本，旧通过和旧事件不能推进；保留旧题/旧成绩。新目标范围缩小的结论只属于新范围。来源失效仍采用现有整体 fingerprint 的保守交回，未建设逐目标自动恢复。笔记确认仍沿用既有审批，未开放自动长期写入。

## 停止、失败证据与回退

任一核心目标被忽略、合法首答被错误降级、辅助/争议题制造通过、同一业务副作用重复、来源/账号/答案泄漏时立即标 BLOCKED，保留现场交回 Cloud 同一分支。模型语义、题目内容质量与完成规则错误分开记录。预算到顶、来源失效、unknown 或无法安全判断时停止，不追加额度、不重标证据、不重新 seed 消除问题。

保留脱敏的完整 SHA、命令/退出码、任务 ID/版本、计划/目的/证据引用、动作与结果 ID、脱敏请求账本、截图和预期/实际差异；不交付真实密钥或私人数据库。记录真实调用数量和未知用量，不把 unknown 写成零。跨环境交接由用户手动完成。

正常停止后备份**整个本轮隔离 `AGENT_TRIAL_DIR/data`**及账本/证据：其中 Learning SQLite、`agent-tasks.sqlite`、`agent-checkpoints.sqlite` 和业务来源必须作为同一套数据保留。确认进程已退出再复制 SQLite；不要只复制主 `.sqlite` 而遗漏仍活动的 WAL。先保留新版本完整备份，再在另一个隔离目录恢复此前一致备份配合旧 SHA；不得直接让旧代码继续推进含 V1.1 计划/动作的新任务。代码 checkout 不自动回退数据库，不能把仅切旧 SHA 写成完整回滚。

离线用 `node scripts/agent-trial/launch.mjs stop`，真实目录加 `--real`；之后 `status` 核对退出。保留全部合成课程、题组、作答、笔记和任务，等待用户决定下一步；不集成 `dev/cloud-code`、不合并 main、不部署。

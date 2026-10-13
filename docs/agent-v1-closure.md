# Agent V1 / A3 Cloud 开发收尾

交付范围固定为共享 Agent 执行底座 V1 与 Learning 自适应复习 V1。基于 `feat/learning-agent-a2` 的 A2 `ab89f2fce1f089cbb510f9dbc078db954042a60c` 继续收尾；最终完整 SHA 见交付对话与 Git 远端。本文件只记录本轮证据，历史 A1/A2 测试不计入本轮数量。

Cloud 使用合成数据和离线 Provider，认证、API、业务服务、SQLite、LangGraph checkpoint 和浏览器组件实际执行；模拟学生由脚本操作页面，不能推定模型语义、生成质量或学习效果。Windows 最终 SHA 真实验收 PENDING，生产部署 NOT RUN。统一执行入口见 [Windows 验收计划](agent-v1-windows.md)。

## 本轮实际修复

- 事件消费、退出等待及拒绝提案结果在同一个带账号/租约/版本检查的 SQLite 事务中保存。批准已消费、SDK checkpoint 尚未完成时发生暂停，恢复使用持久收据及 LangGraph `updateState` 继续同一个行动，重新核验提案，不再丢失反馈或重新提案。
- 完整但非法的模型结果仍保留已报告用量；失败/不完整事件即使内嵌 `completed`，没有真正开始解析也不能当成可重试的明确失败。决策和内部生成遵守同一统计与 unknown 边界。
- 整份 PDF 授权的导航同时核对解析版本及实际来源绑定，不能把旧框架节点的笔记/补充绑到新解析的同编号段落。旧手动框架回源契约保留。
- seed 与启动器统一兼容默认目录；seed 重跑保留用户选择、笔记、作答及删除成果。明确 `--real` 只准备 A/B，`--manual` 为离线手动回归追加 M。
- 启动器复用现有进程树清理；status/stop 不凭空创建数据目录，状态只输出进程元数据。证据模式核对 SQLite 账本结构，改名不能把离线重标为真实。补齐 Windows 浏览器发现合同及清楚的缺配置提示。
- 在原浏览器脚本增加手动 Learning 回归，以及批准笔记时另一页面未保存草稿的冲突保护验证，没有新增产品入口或第二运行器。

没有重新选型、升级核心依赖、重写 Quiz/评分、增加对外 HTTP API、表或迁移。共享内部增加事务式 `continueEvent`，原事件消费补齐账号/租约/版本参数，`AgentFailure` 可携带已经报告的用量；均复用已有表和预算字段。LangGraph `1.5.0`、SQLite Saver `1.1.0`、Core `1.2.17` 保持锁定（MIT）；复用上游 `StateGraph` / `interrupt` / `Command` / `updateState` / SQLite Saver。A0/A1 的版本、源码与许可证追溯记录继续有效。

## 完成矩阵

| 已承诺能力 | 实际入口 | 本轮离线证据入口 | Windows 待验 |
| --- | --- | --- | --- |
| structured_action_v1 与严格行动 JSON | `server/agent/model.ts`、`openai/structured-json.ts`、`agent-trial/protocol-structured.ts` | model、structured-json、传输回归；items/results/chapters 默认兼容 | 最终 SHA 两步真实协议 |
| 共享循环与业务工具 | `server/agent/runtime.ts`、`learning/agent-scenario.ts` | 非 Learning 合成场景、Learning 场景与 A/F 浏览器 | 模型依据实际结果选择动作 |
| 目标、固定范围、历史/笔记/补充授权 | `learning/agent-scope.ts`、API agent route、Agent 面板 | 账号/资源拒绝、PDF 来源绑定、A/D 流程 | 真实目标与授权操作负担 |
| 创建 Quiz、等待、提交和读回 | 原 Quiz 服务/路由/组件、`learning/agent-api-service.ts` | A 页面模拟作答、工具读回实际成绩、重复事件 | 真实题目质量和作答后决策 |
| 中途修改目标和授权 | shared store/runtime revision、Agent 面板调整预览 | A/D、CAS/撤权/迟到响应、预算累计 | 不同目标下的模型语义 |
| 笔记提案/批准/拒绝/幂等 | shared confirmation、Learning append_note + 原笔记服务 | B/C、重启、重复批准、另一页草稿冲突 | 内容/目标可理解性 |
| 暂停/继续/取消/结束 | shared controls + API/PANEL | D/F、消费前后暂停竞争、等待零请求 | Windows 实际进程与操作体验 |
| 来源失效、unknown、明确失败与恢复 | shared receipts/lease/recovery + Learning 业务查询 | C/E/F、进程退出 86、并发查原结果 | 不可查询 unknown 的交回文案 |
| 预算与诚实结束 | shared call/usage/steps/time + scenario finish | 嵌套生成、失败用量、无进展、finish 无业务掌握证明 | 真实 usage/模型失败形态 |
| 权限、日志、答案与持久化 | shared store/SQLite Saver + Learning projection | 跨账号/范围、来源撤销、未交卷答案、A1 迁移、重启 | 最终通道外联及 Windows 文件行为 |
| 原手动 Learning | 原框架/追问/笔记/Quiz/来源/历史组件与服务 | M 材料选择、追问存笔记、练习/测验、历史删除 | 真实生成质量；不测 OCR/ASR |

以上代码路径省略共同的 `src/lib/`、`src/app/api/`、`src/components/learning/` 或 `scripts/` 前缀；精确文件见 Git 差异与同名测试。矩阵的证据结果在下节按实际运行记录汇总。

## 权威边界与固定限制

任务库负责授权版本、行动收据、审批和预算；SDK checkpoint 只负责执行位置；Learning 库负责题组、成绩、解释及笔记。共享层不导入 Learning repository、知识点或评分类型。checkpoint 不存材料全文，日志不保存私有推理/秘密，来源撤销在服务端读取、执行与投影重新检查。trace/遥测默认关闭，自动重试不绕过预算。

批准保存笔记后交回并结束本轮，继续复习需新任务。未知 Provider 结果没有虚构查询或自动重发；已发生的业务写入保留，不承诺全系统 exactly-once。模型 finish 只请求结束，不能宣称用户掌握。仅当前 Learning 空间内授权，不开放其他产品；本轮不扩课程、题型、全局审批、工具市场、Memory、长期调度或多 Agent。

## 最终工程证据

所有证据位于本轮 `output/agent-v1-a3-offline`。历史 A2 目录保留，不计作当前 PASS。以下为最后有效结果，重叠测试不相加。

| 验证 | 实际结果 | 退出码 / 日志 |
| --- | --- | --- |
| Agent、Learning、JSON/传输、API、UI、脚本聚焦 | 38 文件 / 522 用例 PASS | 0；`final-related-tests-closure.log` |
| Cloud 环境合同 + 完整 TypeScript | 9 合同、Next typegen、完整 TS PASS | 0；`closure-cloud-check.log` |
| 最终 production build | 编译、类型、44 页面、180 trace manifests，forbidden=0 | 0；`final-cloud-build.log` |
| 扩展全仓回归 | 554 文件：551 PASS、1 加载失败、2 SKIP；6332 用例 PASS、9 SKIP | 1；`expanded-cloud-tests.log` |
| 原手动 Learning | M 六步实际浏览器/UI/API/SQLite PASS，模拟学生 | 0；`manual-learning-result.json`、`browser-manual-dev-resume.log` |
| Agent A–F、重启、双页草稿及退出故障 | production 服务与实际浏览器完成下述轨迹 | 成功断言脚本 0；注入退出的应用为 86 |
| seed 保留成果 | 停机后再次 seed，59 个数据/冻结记录文件逐字节不变 | 0；`seed-final-idempotence.json` |
| Git / 服务 / 账本 | diff check PASS、锁文件无改动、端口释放、数据保留、真实请求 0 | `closure-evidence-summary.json` |

全仓唯一失败是 `pdf-parser-service.test.ts` 加载未入库的 Windows 原始交接文件；另有既有 `paddle-handoff.integration.test.ts` 8 项与 `pdf-real-regression.test.ts` 1 项可选回放跳过。具体四个文件及 Windows 原断言补验命令见统一文档。未伪造 PDF、修改安全断言或访问 OCR。全仓运行后只增补浏览器子场景及其一项脚本参数测试；最后 38/522 聚焦和完整 TS 已覆盖这些变更，生产源码保持最终 build 对应版本。

最终聚焦命令（实际发现 38 文件）：

```sh
npm run cloud:test -- src/lib/server/agent src/lib/server/openai/structured-json.test.ts src/lib/server/openai/tokenhub-deepseek-flash.test.ts src/lib/server/openai/client.test.ts src/lib/server/learning/agent-scenario.test.ts src/lib/server/learning/agent-a2.test.ts src/lib/server/learning/agent-source-binding.test.ts src/lib/server/learning/study.test.ts src/lib/server/learning/quiz.test.ts src/lib/server/learning/framework.test.ts src/lib/server/learning/quiz-request-resume.test.ts src/lib/server/learning/quiz-request-packing.test.ts src/lib/server/learning/generation-parts-preflight.test.ts src/lib/server/learning/model-input.test.ts src/app/api/learning/agent-routes.test.ts src/app/api/learning/study-routes.test.ts src/app/api/learning/quiz-routes.test.ts src/app/api/learning/framework-routes.test.ts src/app/api/learning/learning-routes.test.ts src/components/learning scripts/agent-trial
npm run cloud:check
npm run cloud:build
npm run cloud:test
git diff --check
```

| 离线轨迹 | 实际动作和结果 |
| --- | --- |
| A `d7bf2ef7…` | read_scope/navigation → 创建真实题组 → 原页面模拟学生交卷 0/2 → read_answers → 回源与解释 → 调整预览确认缩小到知识点，版本 2 继续等待；旧分数保留，预算累计 |
| B `b359f750…`、补验 `16add327…` | 先解释再提案，未批准笔记不变；正常 stop/start 后批准精确追加一次，重复事件不改 revision；补验第二页未保存草稿仍在，旧 revision 保存返回 409，已追加正文不变，冲突过程零生成 |
| C | 拒绝、目标版本变化、真实删除合成材料，三种旧批准均不可再写入 |
| D | 解释响应延迟期间取消或撤销范围，旧结果不得发布；新版本仅引用新授权第 6/7 段 |
| E | 业务题组已写、共享回执丢失，两并发 inspect 复用原 ID；unknown 检查不重发、retry 被拒绝；任务 `8d15993f…` 写入后进程退出 86，重启经认证暂停撤租约，再并发核对找回同题组，零新调用 |
| F | 预算与无进展诚实停止；明确失败等待零调用，暂停/核对/明确重试使用原行动与解释 ID，完成后重新等待 |
| M | 材料选中/取消与保存文本、框架/来源、手动编辑笔记、追问与显式保存、独立练习提示/揭示、测验交卷前无答案、跳过/历史、取消删除再确认删除；保留另一题组、笔记及核心材料，Agent 任务为 0 |

共享非 Learning 场景同时覆盖授权撤销、确认、预算、恢复、事件消费前/后暂停和核对原批准；5 项 A1 迁移测试使用旧提交导出的真实 SDK checkpoint，升级不重写 Learning 原业务数据。新增 PDF 来源测试用合成解析服务数据验证相同段落编号不能穿透解析版本，包含关库重开后的旧等待恢复拒绝。

最终保留 7 个合成账号、14 个 Agent 任务，任务数据库完整性均为 ok。离线响应 114 次：决策 94、解释生成 14、Quiz 生成 5、手动追问 1；每项 `actual_network_requests=0`。这是受控响应次数，未伪造真实 token 或金额。账本、任务库、SDK checkpoint、题组/作答/笔记和截图保留。最后正常停止退出 0，37951 端口释放。

中间失败也保留：来源绑定测试先复现旧笔记泄漏；事件消费竞争先复现 consumed 丢失，随后 56/57 首轮暴露批准后暂停，再补出暂停→核对死点，均修复并复验；首次完整 TS 缺两份脚本声明，补齐后通过。相关首轮 38/521 中 1 项准备面板测试在 DOM 更新后抢先检查 passive effect，改为等待同一精确回调断言，未改产品或 OCR 逻辑。手动浏览器 `.check()` 误要求异步 API 保存同步选中，改点击/等待响应/核对选中；保留原作答续跑。B 草稿首次正文警告与 Next 路由播报双匹配，限定正文区域后新增独立 B-draft 合成任务正常重启复验，原 B 与失败报告均保留，没有修改数据库结果制造通过。

继续当前 Cloud 离线成果：

```sh
AGENT_TRIAL_DIR=output/agent-v1-a3-offline node scripts/agent-trial/launch.mjs start --production
# 另一终端；浏览器 http://127.0.0.1:37951，合成账号见该目录 synthetic-accounts.json
AGENT_TRIAL_DIR=output/agent-v1-a3-offline node scripts/agent-trial/launch.mjs status
AGENT_TRIAL_DIR=output/agent-v1-a3-offline node scripts/agent-trial/launch.mjs stop
```

Windows 全新 checkout 按统一文档安装、自动迁移并重新 seed；不复制 Cloud 目录为真实证据。需要单独重做草稿验收时，设置 `AGENT_TRIAL_SUBCASE=draft`，只执行 before-restart → 正常 stop/start → after-restart；它只允许 B 且独立保留 B-draft 数据，不重标原报告。

结论：**Agent V1功能开发完成（Cloud），等待Windows真实验收。** 功能开发 COMPLETE；Cloud 相关离线工程验收 PASS；扩展全仓回归 PARTIAL（上述外部 fixture）；Windows 最终 SHA 真实验收 PENDING；生产部署 NOT RUN。旧 A1 两次最小真实协议 PASS 只属于旧 SHA。本轮无已知 Agent 核心开发阻塞；Windows 通道兼容、模型选择/质量、操作负担及原生进程行为仍需实际验收。

Cloud 完成后只针对 Windows 在交付 SHA 上提供的具体脱敏复现返工；不自动进入 A4 或其他 Agent。

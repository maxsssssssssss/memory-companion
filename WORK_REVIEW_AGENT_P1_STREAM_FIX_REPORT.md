# Work Review Agent P1：#287 unknown 工程调查与离线修复报告

日期：2026-10-28，Asia/Shanghai。

**结论：已证明并修复一个可复现的流量计量缺陷；不能据此断言历史 #287 的唯一根因已经证实。** 旧实现将每个 SSE 事件的元数据、增量正文、完成快照全部累计到 200,000 字节额度。相同合法答案仅因分帧变细就可能被拒绝，尚未进入 JSON 解析，办公适配器随后正确地把无法确认的调用记为 unknown。此次分离了办公 Agent 的正文/事件限制与累计协议流量额度，保留全部 unknown、取消、预算及确认保护。

离线三会闭环、20 文件 507 用例、完整类型检查和生产构建通过。本轮真实 Provider 请求 **0**；真实验收尚未重新执行。历史 #287 的 unknown、空 usage、无成果状态保持不变。

## 1. 基线、范围与证据保护

- 工作区：`C:\Users\50245\.codex\worktrees\work-review-agent-p1\daily-brief-source-20260708-122232`。
- 分支：`codex/work-review-agent-p1`；HEAD：`0653b3f18d56c121935f50502a0dedef06ba5bcd`，未改变。
- 开始时 P1 为已有未提交修改。记录 1,840 个源码/文档文件的哈希、原 Git 状态，以及上轮真实验收目录全部 52 个文件的哈希。仅在本次必要文件上增量修改。
- 真实账本开始与结束均为 **287 条**，原 287 行内容不变；历史累计上限仍为 293，本轮没有使用剩余额度。
- 原真实验收数据库仅用只读连接核查。没有启动旧任务、recover、回填 usage、补建旧比较成果或更改旧任务状态。没有新建 worktree、提交、推送、部署、生产访问或读取真实用户正文。
- 所有新执行命令通过隔离环境包装器运行：清除继承的业务凭据，使用合成数据目录，启用仓库既有离线网络保护。模拟 HTTP 响应和实际 loopback socket 属于离线证据；不连接正式 Provider。

本轮证据目录：[output/work-agent-p1-stream-fix-20261028](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-fix-20261028)。`before.json` 保存基线，`preservation.json` 保存最终保护核对；`*.command.json` 保存真实命令、起止时间及退出码，`*.log` 保留失败和成功输出。

## 2. 历史事实与根因证据的边界

核对了 [response-287.json](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-real-20261028/response-287.json)、[diagnosis-287.json](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-real-20261028/diagnosis-287.json) 及真实测试库 `agent_calls`：

| 项目 | 实际事实 |
| --- | --- |
| 请求身份 | `e8c1cffa-0a93-4474-8508-fb4dce2645d7` |
| 旧任务 | `28661a4a-d6e4-4891-9304-02bf769600a5` |
| Provider 捕获 | HTTP 200，response.status=completed；4 条比较结论、5 项建议，schema 与来源核验通过 |
| 完整 response 对象 | 重新紧凑序列化后 8,527 UTF-8 字节；不是原始网络传输字节数 |
| assistant 正文 | 3,143 字符 / 3,581 UTF-8 字节 |
| Provider usage | input=6,102，output=1,365，total=7,467 |
| 产品调用记录 | kind=work_agent_comparison，status=unknown，input_tokens/output_tokens/diagnostics_json 均为 NULL |
| 缺失证据 | 原始 SSE 事件序列、原始异常及失败阶段未保存 |

旧流解析实现的确按 `Buffer.byteLength(message.data, "utf8")` 累计每条 SSE JSON，然后**先检查上限，再解析事件与读取 completed usage**。这不是最终答案的字节上限，而是包含重复内容和协议字段的累计值。现保留此旧语义供其他调用方使用，位置见 [structured-json.ts:535](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/openai/structured-json.ts:535)；原文件原样保存在证据目录 `structured-json.before.ts`。

原验收网络观察器位于解析器上游。它在转发一个原始 chunk 前检查里面所有 data 行，因此它看到 completed，并不保证下游消费者已经接受了前面所有 SSE 事件。详见原 [guard.cjs:27](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-real-20261028/guard.cjs:27)。这可以解释两层记录不一致，但缺少原帧，不能排除取消、传输或 iterator cleanup 等其他原因。

### 修复前后的可复现对照

使用历史 #284/#287 保存的终态响应，只在内存中构造符合当前 SDK 路径的合成 SSE 分帧。实际执行 `OpenAI.responses.create(...).asResponse()`、SDK `_iterSSEMessages`、产品 JSON/Zod 解析。没有注入解析成功返回值，没有把历史响应写入任何业务任务。

| 输入及合成分帧 | 全部 SSE data 累计字节 | 旧策略实际结果 | 修复后的办公策略 |
| --- | ---: | --- | --- |
| #284，单个大 delta + done/completed | 16,567 | 通过 | 通过 |
| #284，每 delta 2 字符，共 1,004 事件 | 184,137 | 通过 | 通过 |
| #287，单个大 delta + done/completed | 25,100 | 通过 | 通过 |
| #287，每 delta 2 字符，共 1,577 事件 | 289,507 | incomplete_response；parseResult=not_started，无 usage | 通过，4 结论 / 5 建议，读取响应内 6,102 / 1,365 usage |

增加阶段诊断后，用相同旧策略重现：第 **1,174** 个事件时累计 **200,170** 字节触发 `byte_limit / legacy_total`；最大单事件仅 **175** 字节，已读取增量正文仅 **2,730** 字节，尚未接收 completed。即此复现主要被每个 delta 的协议开销耗尽额度；done 与最终 response 也会计入累计值，但并非必须等到它们重复正文才会失败。

证据：[reproduction-before.json](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-fix-20261028/reproduction-before.json)、[reproduction-after.json](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-fix-20261028/reproduction-after.json)、[reproduction-legacy-diagnostics.json](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-fix-20261028/reproduction-legacy-diagnostics.json)。这是**已证实的计量缺陷及相符失败特征**，不是历史原始 SSE 的精确回放证明。

## 3. 最小修复及保护

产品逻辑只改了两个文件，无新增数据库表、依赖、模型路由、通用任务系统或全局开关。

| 文件 | 修改 |
| --- | --- |
| [openai/structured-json.ts:438](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/openai/structured-json.ts:438) | 新增可选 streamLimits，分别限制单个 SSE data、累计文本 delta 和累计 SSE data；原 maxResponseBytes 语义保持不变，两者同时传入时都生效 |
| [openai/structured-json.ts:503](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/openai/structured-json.ts:503) | 记录固定阶段、事件数、累计/最大事件/增量字节数、是否收到有效 completed、固定失败类别和触发的限制类型 |
| [openai/structured-json.ts:587](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/openai/structured-json.ts:587) | 有效 completed 事件到达后先保留 reported usage；若之后清理或取消失败，仍不解析/发布结果，parseResult 保持 not_started，调用仍为 unknown，但已知账单量不丢失 |
| [work-review/agent-model.ts:45](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/work-review/agent-model.ts:45) | 办公 Agent 显式选择独立流量限制；模型、TokenHub 地址、请求重试次数、输出 token、超时和 Runtime 预算均未改变 |
| [work-review/agent-model.ts:56](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/work-review/agent-model.ts:56) | 保留已有失败分类；增加与现有 requestId 关联的安全阶段日志，记录 parse/validation 状态与 reported usage；日志失败不改变业务结果 |

办公 Agent 的单事件和累计文本 delta 仍各限 **200,000 字节**。累计 SSE data 另设有限额度：`4 × 200,000 + 256 × maxOutputTokens`；本轮正式配置的 6,000 token 对应 **2,336,000 字节**。四份有界快照及每请求输出 token 的事件开销有独立额度，避免把协议重复当成新增答案。这个额度是显式的本地资源政策，不声称任意 Provider 分帧均可被接受；超出仍停止并记录 unknown。它统计的是 SSE data，而不是 TCP/HTTP 原始流量。

这是经过复现后的计量拆分，不是取消限制、接受部分 JSON、把 unknown 强改 success，或提高模型输出 token。其他产品及共享 Agent 决策适配器仍使用原有累计限制；未修改 Learning 业务。若未来单事件、正文或协议总量确实触顶，先依据新诊断评估具体需求，不自动增额或重试。

诊断仅含本地 requestId、固定 kind/阶段/原因、布尔值、计数和时长，不含正文、密钥、URL、Provider 错误文本或 Provider 自有 ID。写入现有服务日志，不增建诊断数据库；后续验收需保存本地进程日志，才能与 `agent_calls` 对齐。

## 4. Runtime 用量与结果提交顺序

实际顺序为：预留调用 → 执行模型适配器 → 成功/失败用量入 `agent_calls` → 检查取消/租约 → 返回业务结果 → 再检查活动状态 → 保存比较成果。

- [runtime.ts:235](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/agent/runtime.ts:235) 预留 call；243 行记录 failed/unknown；249 行记录 succeeded 与 usage，然后再做活动检查。
- [agent-scenario.ts:57](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/work-review/agent-scenario.ts:57) 模型返回后仍要 assertActive，随后才 saveComparison。
- [agent-stream.test.ts:76](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/work-review/agent-stream.test.ts:76) 在真正 saveComparison 执行前检查 SQLite：comparison call 已 succeeded，usage 已保存，之后才允许成果落库。

未发现需要改写 Runtime 提交顺序的缺陷，因此 Runtime/Store 未改。已知的 JSON/schema 错误仍记 failed 并保留 reported usage；断流、缺完成事件、超时、取消、清理失败、超限仍为 unknown。有效 completed 后被取消，只能保留账单事实，不能发布比较或关系。旧 #287 没有被补账或追认。

## 5. 离线三场会议闭环

新增 [work-agent-routes.test.ts:39](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/app/api/work-reviews/work-agent-routes.test.ts:39) 从合成会议 repository 流程创建来源、确认 Findings 和原 Todo，使用实际 Work 模型适配器、OpenAI SDK、SSE 解析、Scenario、Runtime、API handlers 与隔离 SQLite。仅认证/Next after 调度和模型 HTTP 响应为明确的离线 fixture，未替换解析函数或直接插入 Agent 成功状态。

| 用户步骤 | 实际断言结果 |
| --- | --- |
| M1 正式采用 A；M2 暂停 A，B 仅候选 | 保存 M2 批准关系后，A=suspended，currentFindingId=null；没有 B proposal 作为当前决定 |
| 自然语言请求整理 M3 后续工作 | 实际适配器接收碎片化 SSE，累计超过旧 200 KB 但合法完整；形成固定预览，尚不改 Todo |
| 逐项选择 | 选择 replace / update_deploy / complete_test / close_q / monitor；未选择错误的 reject_vendor |
| 最终批准 | 经正式 API 与 Runtime 确认，五项修改实际落地；批准前测试 Todo 仍 open |
| 部署 Todo | 使用原 ID，更新 B 配置及 2026-10-30 日期，原来源 Finding 保留；没有复制部署任务 |
| 测试 / 回滚 / 监控 | 测试 Todo completed；回滚 thread resolved；新增一个监控 Todo，总 Todo 数从 3 到 4 |
| 供应商与日志 | 供应商仍 open；错误建议记入 rejectedKeys；日志问题仍在未闭环提示中 |
| 时间线与引用 | records → suspends → supersedes，当前决定为 B；原文 API 返回 M3“正式决定一期用B替代A”的依据 |
| 重开与重复确认 | 每次正式 API 后关闭/重开 Runtime；GET 重新读取成果。重复同一批准事件不新增 Todo 操作历史、不重复写入 |
| 请求次数 | 两个离线任务共 4 次脚本化 HTTP 响应：2 次决策、2 次工具内比较；选择和批准不调用模型。不是 4 次真实 Provider 请求 |

usage 测试证明响应内数字被透传保存，而非根据预算估算。集成 fixture 使用 6,102/1,365 等明确合成报文数值，不代表本轮产生真实账单。历史 #287 的真实 usage 只在纯解析复现里读取，其原产品记录仍为 NULL。

受影响页面组件测试覆盖旧/新状态展示、只提交选中项、最终确认弹窗及卸载重开；本轮未运行新的 Browser E2E。API/组件验证与真实页面人工验收是不同证据层。既有 P1 repository 回归还覆盖账号/项目隔离、来源失效、取消晚到结果、事务回滚、提交后丢失回执恢复，以及 B 来源失效不恢复 A。

## 6. 失败保护与阶段诊断验证

新增 [agent-stream.test.ts:91](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/work-review/agent-stream.test.ts:91) 通过实际 SDK → 产品 parser → Runtime → SQLite 验证：

| 故障 | 最终保护 |
| --- | --- |
| EOF 缺 completed / 流中途抛错 | unknown，无成果、关系或 Todo 写入，再次 advance 不产生调用 |
| 总请求信号超时 | unknown，诊断 timeout，不自动重试 |
| 用户取消 / 收到 completed 后清理期间取消 | task=cancelled，call=unknown，不接受晚到成果；已经收到的 usage 可保留 |
| iterator cleanup 抛错 | unknown，诊断 cleanup_error，保留已收到 usage，不把结果升级为成功 |
| response.failed 携带误导性的 completed 状态 | unknown，parseResult=not_started，仍不采用该响应 |
| 单事件超过限制 | unknown，诊断 byte_limit/event，不解析或发布 |
| 完整响应 JSON 或 schema 错误 | failed，保留 usage；按既有“已知失败”契约交回决策循环，传输层不重发请求 |

[structured-json-limits.test.ts:40](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/openai/structured-json-limits.test.ts:40) 额外验证单事件、增量正文、累计协议三项限制，以及旧调用方累计限制、异常事件和诊断脱敏。

[structured-json-socket.test.ts:10](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/openai/structured-json-socket.test.ts:10) 使用本地 HTTP socket 和 native fetch，实际断开连接、截止信号、用户取消以及 completed 后保持连接不结束，共 4 项通过。缺 completed 不接受部分 JSON；合法 completed 不等待 EOF。这里只绑定 loopback，没有外部 Provider。

## 7. 验证命令、退出码及中间失败

统一包装命令为 `node output/work-agent-p1-stream-fix-20261028/run.mjs <标签> <Node入口及参数>`。它保留确切 argv 和退出码、使用隔离环境与离线网络保护；`npm` 简写解析为本机 npm-cli.js。

| 标签 / 实际后续命令 | 退出码 | 发现文件 / 用例结果 |
| --- | ---: | --- |
| reproduce-before：`node_modules/tsx/dist/cli.mjs output/work-agent-p1-stream-fix-20261028/reproduce.ts before` | 0 | 4 个纯解析对照，3 通过 / 1 预期复现失败；脚本成功不代表该失败变为通过 |
| red-tests：Vitest `structured-json-limits.test.ts` | 1 | 1 文件 / 1 PASS、1 FAIL；新增阶段诊断尚未实现，保留原日志 |
| first-green：Vitest limits / structured-json / agent-model | 0 | 3 文件 / 82 PASS |
| stream-tests：Vitest limits / agent-stream | 1 | 2 文件 / 18 PASS、2 FAIL；测试误认为已知 schema/JSON 失败不会再进入决策循环 |
| flow-tests：Vitest agent-stream / work-agent-routes | 1 | 2 文件 / 13 PASS、1 FAIL；测试预期批准 keys 为提交顺序，而产品持久化为规范排序 |
| socket-api-tests：Vitest socket / work-agent-routes | 0 | 2 文件 / 7 PASS |
| reproduce-after / reproduce-legacy-diagnostics | 均 0 | 新策略 4/4 解析；旧策略仍 3 通过 / 1 预期失败并给出 byte_limit 诊断 |
| lint：`npm run lint` | 1 | 完整 TS 发现新增测试一处 TS7006，补充 MockInstance 类型；没有放松类型配置 |
| lint-final：`npm run lint` | 0 | Next typegen + 完整 TypeScript 通过 |
| regression：下列显式文件清单 | 0 | **20 文件 / 507 PASS / 0 FAIL / 0 SKIP** |
| build：`npm run build` | 0 | Next production build、完整类型检查、44/44 页面生成、postbuild 通过；trace manifests=182、removed=42、forbidden=0 |

最终回归的实际命令：

```text
node output/work-agent-p1-stream-fix-20261028/run.mjs regression node_modules/vitest/vitest.mjs run src/lib/server/openai/structured-json.test.ts src/lib/server/openai/structured-json-limits.test.ts src/lib/server/openai/structured-json-socket.test.ts src/lib/server/openai/tokenhub-deepseek-flash.test.ts src/lib/server/work-review/agent-model.test.ts src/lib/server/work-review/agent-stream.test.ts src/lib/server/work-review/agent-p1.test.ts src/app/api/work-reviews/work-agent-routes.test.ts src/components/work-review/work-agent-page.test.tsx src/components/work-review/work-meeting-detail.test.tsx src/lib/server/agent/runtime.test.ts src/lib/server/agent/model.test.ts src/lib/server/agent/decision-diagnostics.test.ts src/lib/server/learning/framework-generator.test.ts src/lib/server/learning/agent-scenario.test.ts src/lib/server/work-review/analysis-provider.test.ts src/lib/server/work-review/weekly-tokenhub-transport.test.ts src/lib/server/work-review/tokenhub-client.test.ts src/lib/server/daily-reflection/candidate-provider.test.ts src/lib/server/date-companion/tokenhub-content-provider.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile=output/work-agent-p1-stream-fix-20261028/regression.json
node output/work-agent-p1-stream-fix-20261028/run.mjs lint-final npm run lint
node output/work-agent-p1-stream-fix-20261028/run.mjs build npm run build
git diff --check
node output/work-agent-p1-stream-fix-20261028/protect.mjs --verify
```

计数按 [regression.json](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-fix-20261028/regression.json) 的实际 testResults 文件和 assertionResults 核对，未把嵌套 describe 数当文件数。未重跑无关全仓测试；本次选择共享解析器所有相关风险与办公 P1 边界回归。中间失败保留，最终没有遗留测试失败。

## 8. 修改清单与后续真实复验建议

本轮修改原有文件：`src/lib/server/openai/structured-json.ts`、`src/lib/server/work-review/agent-model.ts`、`src/lib/server/work-review/agent-model.test.ts`、`src/app/api/work-reviews/work-agent-routes.test.ts`；在根 `UPDATE_HISTORY.md` 末尾追加记录。

新增：`src/lib/server/openai/structured-json-stream.test-fixture.ts`、`structured-json-limits.test.ts`、`structured-json-socket.test.ts`、`src/lib/server/work-review/agent-stream.test.ts`、本报告，以及隔离 output 里的复现/保护/执行证据脚本。未改会议/Findings/Todo authority、数据库 schema、业务确认事务、共享 Runtime 或 Learning 业务。

剩余不确定性：原始 #287 的具体分帧和异常不可恢复，因此不能把它归因为已证实的单一 byte-limit 故障。新增诊断也能区分同样会导致 unknown 的取消、超时和清理失败，供后续真实运行判定。本轮没有验证真实 Provider 在修复后是否仍触发其他流问题，也没有完成新的人工页面模型语义验收。

后续需要另行明确授权真实复验后再执行：

1. 重核实际账本及所有上限；当前仅剩 293−287=6 次，不能把本轮未用额度当成新的执行授权。
2. 保留旧 #287，不对旧任务重试、补结果或追认。在独立合成库中预先限定一次修复复验任务及请求上限；决策和内部比较都计入，不通过重建任务提高成功率。
3. 维持正式办公 Provider/模型配置，保存 `[work-agent-response]` 安全阶段日志，用 requestId 对齐网络账本、agent_calls、实际成果。正常完整回复应解析、入库并有 reported usage；遇 unknown 或严重错误立即停止。
4. 人工复核 M3 变化与引用，再逐项批准正确安排、拒绝错误建议；检查 Todo 原 ID、事务结果、时间线、未闭环提示和刷新重开。
5. 如果要重新执行 M2 和 M3 两个完整真实任务，6 次余额未必足够；必须在开始前确定预算，不能自动扩额。此次离线成功不替代该真实验收。

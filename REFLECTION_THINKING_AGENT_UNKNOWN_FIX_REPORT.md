# 「一起想」第二轮 unknown：本地定向修复

2026-11-04。结论：**PASS_OFFLINE_FIX / PARTIAL_REAL_CAUSE**。已修复离线可复现的协议预算、比较输入投影和 guard 帧边界问题；**没有证据确定本次真实 unknown 的具体触发点，也未取得修复版真实 PASS**。

## 基线及原证据

- 工作区：当前 `reflection-thinking-main-migration`；分支 `codex/reflection-thinking-main-migration`；HEAD `453b1a40342010725f1aaee854c84e5b682d902d`。开始时仅有原有未跟踪 `tmp/`，本轮保留。
- 只读检查用户提供的 [response-002.json](C:/Users/50245/.codex/worktrees/learning-release-20261027/daily-brief-source-20260708-122232/output/thinking-real-20261104/response-002.json)：HTTP 200、guard `completed`、用量 input 4881 / output 1356，保存了最终助手文本和 stream hash。其 SHA-256 为 `ad27b0538cbb32f3fcaa611e8661c5c2abd2716509dd390de531396a54964269`，检查后未变。
- 用户补充的另一本地 guard/test 与本工作区修复前逐文件 hash 相同。**没有核对服务器运行副本 hash**，没有原始 SSE 序列或应用 stream diagnostics。本轮未读取服务器或原调用账本，11 月 3 日材料未作为本次 SSE 证据。
- 因而接受交接结论：guard 看到了它认可的有效完成事件，应用记录为 unknown；缺少中间证据，不能归因为“完成事件缺失”，也不能排除解析前字节限制、帧派发差异或清理阶段失败。

## 已确认的代码问题与最小修复

1. **SSE 协议字节与答案正文共用 200 KB 上限。**通用 Agent 适配器使用旧 `maxResponseBytes`，把逐 token 事件元数据和重复快照一并累计。修复前用实际 SDK 的离线单测复现：最终回答及单事件均很小，旧代码仍在完成前触发限制。修复后再经 guard、共享 Runtime 和 SQLite 完成两轮闭环。改为复用现有 Work Review 的三项有限预算：单事件 200,000 字节、累计 delta 200,000 字节、总事件 data `800,000 + 256 × maxOutputTokens`；一起想 4,000 token 时为 1,824,000 字节。保留输出 token、时间、请求次数和 guard 原有 2 MB 线传输限制。这是已复现缺陷，**不是本次故障的已证实归因**。
2. **比较观察暴露服务端溯源字段。**原 observation 直接发送持久化 comparison，包含严格输入 schema 不接受的 `sourceEventId`。现只向模型投影可编辑字段及稳定方案 ID，服务端完整 provenance 仍保存。补充工具说明及场景指令，prompt version 为 `reflection_thinking_p3_v2`。没有放宽 schema 或自动删除模型输出里的未知字段。
3. **unknown 缺少解析前定位信息。**在原 `agent_calls.diagnostics_json` 内追加可选的安全 response 信息：解析/校验阶段、stream phase、完成标记、失败标签、字节及事件数。复用现有 diagnostics 类型，不存正文、原始错误、URL、凭据或模型自定义字段；旧记录不需迁移，也不补造历史诊断。完成事件无效、缺失、父取消或清理失败仍为 unknown，不能因网关有文本而自动发布。
4. **guard 在 EOF 时额外派发未结束帧。**旧 guard 对最后没有空行结束的 JSON 事件仍记 completed，而 SDK 不派发该 SSE 帧，离线可重现两侧判断不同。现按 SDK 帧结束规则处理 EOF；字节原样转发，新增事件数/完成标记/EOF 残留的安全摘要。**没有证据表明真实第二轮使用了这种帧格式**。

对留存第二轮文本只做本地 schema 校验，得到两项 `unrecognized_keys`：`comparison.options[0/1].sourceEventId`。实际 SDK/Runtime 测试确认：如果先合法完成，再走到该参数校验，会成为独立的已知工具参数失败，零回复写入；它不能解释此前尚未进入校验的 unknown。没有把留存文本提交给业务 API，也没有用它恢复原任务。

主要文件：`agent/model.ts`、`agent/types.ts`、`daily-reflection/thinking-agent.ts`、`scripts/reflection-thinking-real-network-guard.cjs`；四个既有测试文件及新增 `thinking-agent-transport.test.ts`。共享 parser、Runtime、Store、数据库 schema、UI 和普通业务 API 未改；无新依赖、框架或持久化 authority。

## 离线验证

所有调用传输均为 mock，外部网络另有绝对路径 NODE_OPTIONS 守卫；没有装载真实 Provider 配置。

| 执行 | 文件 / 用例 | 退出码与结果 |
| --- | --- | --- |
| 修复前定向复现 | 3 / 97 | 1；91 通过、6 失败，保留 red.log/json |
| 首轮修复复验 | 4 / 100 | 0；全部通过 |
| 最终受影响及相邻回归 | 12 / 296 | 0；全部通过、0 跳过 |
| 追加 SDK/guard EOF 帧对照及相关复验 | 2 / 55 | 0；全部通过；合并唯一用例 297，不累计重复执行 |
| `npm run lint`（typegen + 完整 TypeScript） | 全部当前源码 | 0 |
| `git diff --check` | 本轮差异 | 0 |

命令：`npm test -- @tests --maxWorkers=1 --reporter=default --reporter=json --outputFile=output/thinking-response-unknown-fix/regression.json`，`@tests` 的 12 个准确路径及原命令见 [选择清单](C:/Users/50245/.codex/worktrees/reflection-thinking-main-migration/daily-brief-source-20260708-122232/output/thinking-response-unknown-fix/test-selection.json) 和 [执行日志](C:/Users/50245/.codex/worktrees/reflection-thinking-main-migration/daily-brief-source-20260708-122232/output/thinking-response-unknown-fix/regression.log)。初次复现/首轮复验分别使用其中 3/4 个文件，完整命令保留在对应 red.log/green.log。追加用例后只补跑模型和 guard 两文件，命令及结果见 [framing.log](C:/Users/50245/.codex/worktrees/reflection-thinking-main-migration/daily-brief-source-20260708-122232/output/thinking-response-unknown-fix/framing.log)，业务源码无后续改动。类型检查见 [lint.log](C:/Users/50245/.codex/worktrees/reflection-thinking-main-migration/daily-brief-source-20260708-122232/output/thinking-response-unknown-fix/lint.log)。

关键实际结果：两轮比较经过真实 SDK、测试 guard、正式业务服务、共享 Runtime 和 SQLite 成功保存；方案 ID、先选 A 再选 B 的理由及历史、已采纳但未执行的安排保留；另一账号读取失败。缺失完成的模拟请求持久化为 unknown，核对操作只读且传输计数不增加。清理错误和无效完成仍拒绝；各字节上限仍生效。诊断重开数据库后保留并按账号隔离，正文和错误标记不进入诊断。LF/CRLF 单字节拆包的 guard 不改变内容；未终止帧不再冒充完成。来源撤回、取消及晚到保护和 Learning/Work Review 相邻检查通过。

本轮不重复全仓、production build 或浏览器；没有修改页面、路由、构建配置或共享解析器。此前 453b1a4 的生产构建不代表本次修复已构建；下一次真实复验须绑定修复版源码/构建。

## 停止点与下一批申请

- **新增真实 Provider 请求 0**。原批次仍为交接中的 2 次，本轮未重发、恢复或改写原 unknown，未读取或修改原账本；原响应文件及另一工作区 guard/test 原件未变。
- 已在当前工作区完成本地修复和离线检查；未提交、推送、部署、启动隧道或访问服务器。临时目录及所有历史失败证据保留。
- 申请下一批使用新的独立合成账号/数据/账本，**最多 12 次实际请求**（沿用现有守卫，工具后续同计），只验证首次比较和补充新约束的第二轮续接；unknown 立即停止、不得自动重发或反复跑到成功。必须获得新的明确授权并先绑定修复版构建；本报告不授予 Provider 或服务器操作权限。原批次不能以本修复为理由改成成功或继续发送。

## 后续授权复验记录

同日用户明确授权后，新独立本地批次实际 2/12 次、两轮业务成功；完整范围、用量、浏览器/SQLite 证据和已知限制见 [限定真实复验报告](C:/Users/50245/.codex/worktrees/reflection-thinking-main-migration/daily-brief-source-20260708-122232/REFLECTION_THINKING_AGENT_UNKNOWN_FIX_REAL_ACCEPTANCE_REPORT.md)。这不改变上文对原 unknown 归因不足的结论，也不代表原始 453b1a4 或生产环境获得 PASS。

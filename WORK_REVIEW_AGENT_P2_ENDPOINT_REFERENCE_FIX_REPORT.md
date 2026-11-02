# Work Review Agent P2：关系端点引用定向修复

日期：2026-10-29。结论：**本地修复与离线验收 PASS；新增真实 Provider 请求 0，修复后的真实模型验收 NOT RUN。** 原真实验收的 PARTIAL 结论和历史任务保持不变。

## 基线与本轮差异

- 工作区：`C:\Users\50245\.codex\worktrees\work-review-agent-p1\daily-brief-source-20260708-122232`
- 分支：`codex/work-review-agent-p1`；HEAD：`0653b3f18d56c121935f50502a0dedef06ba5bcd`，未改变。
- 开始时已有 P1、SSE、最终一致性修复、P2 的 dirty 文件和未跟踪文件。`output/work-agent-p2-endpoint-fix-20261029/baseline.json` 保存完整状态及 1,853 个源码/文档摘要，`before/` 保存对应字节快照。本轮增量不能用整个 HEAD diff 代替。
- 最终 production build：`w7CMK7Hx3zfm-4mWAqS7S`；`npm run build` 退出 0，44/44 页面生成完成。

| 本轮文件 | 实际修改 |
| --- | --- |
| `src/lib/server/work-review/agent-repository.ts:72` | 唯一业务代码修改：保存比较前规范化关系端点引用，再执行原校验；引用超限明确归类为已知拒绝 |
| `src/lib/server/work-review/agent-endpoint-sources.test.ts:33` | 新增 16 项端点、来源、确认、回滚与恢复测试 |
| `src/app/api/work-reviews/work-agent-routes.test.ts:39` | 新增正式 API 选择、批准、来源持久化与重复确认测试 |
| `UPDATE_HISTORY.md` | 只在末尾追加本次中文记录 |
| 本报告 | 新增交付文档 |

回放脚本、日志、SQLite 副本与审计文件仅位于 `output/work-agent-p2-endpoint-fix-20261029/`。无 schema、迁移、Prompt、模型路由、预算、Learning、SSE 或共享 AgentRuntime 修改。

## 根因与修复

#296 的两项关系已明确提供正确的 `anchorFindingId` 与 `findingId`，但 `sourceFindingIds` 只包含 M3 端点，遗漏 M1 原始端点。输出 schema 分别约束这三个字段，没有要求它们互相包含（`src/lib/domain/work-agent.ts:10`）；Prompt 其实已经要求包含两端（`agent-model.ts:22`），原 repository 又要求来源数组显式重复两端，因此整个比较在保存前被拒绝。

修复前离线回放确认：SSE 完成、JSON/schema 通过、三次历史响应的 usage 进入隔离副本；随后业务任务进入 `needs_attention / known_failed`，没有预览。这不是 SSE 或历史 unknown 问题。

现在在 `validateComparison` 中执行以下顺序（`agent-repository.ts:84–105`）：

1. 原模型引用仍先经过原 `known()` 校验，不静默删掉未知或重复引用。
2. 两个明确端点必须存在于本次重新读取、已校验的项目上下文；不从全库搜索、不按相似文本补 ID。
3. 将原引用与这两个有效端点取并集并排序；保留原额外有效引用。通过原 `WorkAgentChange` schema 再校验，保留最多 8 个引用的限制，超限使用 `invalid_action` 明确拒绝。
4. 再核对引用范围，继续原会议时间、正式决定/候选、问题类型、Todo 范围等检查。
5. 规范化发生在比较持久化及固定预览、指纹、批准之前。`WorkAgentComparison.parse` 的副本被修改，原响应对象及原文件不变。后续确认、事务应用和恢复继续使用同一份固定内容。

账号、项目、已确认 Finding、有效 Canonical 原文来自原 `readWorkAgentContext/readWorkAgentSource`（`agent-context.ts:25、116`）；保存使用即时事务及当前来源指纹（`agent-repository.ts:125`）。没有降低来源标准，也没有改写历史预览。

**部分有效操作的处理：**缺失、越权、失效端点仍让本批比较拒绝，不静默剔除坏关系后宣称保存完整比较；要支持这种结构失败的逐项保留，需要另行改变保存及预览契约，本轮不扩展。端点合法但语义依据不足时，已有 `needs_review/blocked` 机制仍可保留不可批准项，并允许其他独立有效 Todo 进入确认。新增测试实际批准三项 Todo、拒绝不受支持的关闭关系，问题保持未解决。

## #296 原始响应回放及语义核对

输入为原目录的完整 `response-294.json`、`response-295.json`、`response-296.json`，没有修改响应对象或正文；#296 文件 SHA-256 为 `753d629712631567907b4fa9540676b95f5d483bc7ef8a64df45aabf0fa96718`。前两份只用于复现同一次历史任务的决策顺序。

复制上一轮合成业务 SQLite **及 WAL**，在独立副本创建离线任务。正式 SDK/结构解析、API GET/POST/PATCH、AgentRuntime、repository 和 Todo 事务均实际执行；仅认证上下文、Next 后台调度及网络传输替换为离线入口。SSE 包装是合成的，内部完整响应来自原文件。因此这是原响应离线回放，**不是新的真实网络请求，也不是还原网络逐字节时序**。业务成功没有通过直接写表制造。

| #296 操作 | 原文人工核对 | 离线正式流程结果 |
| --- | --- | --- |
| B 替代 A | M1 正式 A；M2 暂停且 B 候选；M3 明确 B 替代 A，原因是配额不能满足峰值 | 两端来源补齐，批准后保存 supersedes；A→暂停→B 时间顺序与原文保留 |
| 关闭回滚问题 | M1 尚未验证；M3 同时明确测试完成、确认问题解决 | 两端来源补齐，批准后保存 resolves；不靠 Todo 完成推导关闭 |
| 更新部署 | M3 承诺原部署任务调整 B、10月30日完成、不新建部署任务 | 原 ID `wrt_eb0bff65-2f2b-4e95-a4a7-c9131b512109` 保留，实际标题 B方案部署、负责人林晨、期限10月30日、版本1 |
| 完成回滚测试 | M3 明确全部完成 | 原测试 Todo 完成，退出未完成列表 |
| 新增监控 | M3 明确林晨负责、10月29日前完成 | 创建一次，关联 M3 的原 Finding |

最终回放生成 **5/5 固定预览**，经选择与批准落库 **2 项关系 + 3 项 Todo 操作**。日志期限保持 `unresolved`，供应商保持 `waiting`，没有供应商完成操作。两次重复批准、关闭数据库并重新打开后，项目响应、Todo 历史及关系事件均保持一致；原 Finding 与原调用记录未变。

最终证据：`output/work-agent-p2-endpoint-fix-20261029/replay-ahbUik/` 下的 `before-approval.json`、`operation-evidence-review.json`、`result.json`、`final-business.json`、`work-review.sqlite`。第一次修复后通过的 `replay-mGpGYC/` 也保留。

这些核对分别验证了引用完整性和本案例的实际语义；`confirmable` 仍表示未发现有限规则可识别的明确矛盾，**不代表模型语义已被全面证明正确**。

## 验证命令与结果

命令均经本轮 `run.mjs` 使用既有离线网络 Guard、隔离数据目录和无继承凭据的环境执行。日志及完整参数、起止时间、退出码在同名 `.log` / `.command.json` 中。

| 记录 | 文件 / 用例 | 退出码与结果 |
| --- | --- | --- |
| `replay-before-corrected` | 1 / 1 | 1：修复前确实停在 needs_attention，没有预览 |
| `replay-after` | 1 / 1 | 0：原响应首次完整通过 |
| `regression` | 10 / 117 | 0：全部通过，包含 P1/P2、来源一致性、API、组件、流式错误保护、Todo 和项目删除 |
| `capacity-before` | 1 / 实际选中1 | 1：追加边界测试复现引用超限被 ZodError 误分类 unknown；15个其他用例因 -t 未选中 |
| `endpoint-final` | 1 / 16 | 0：修正失败分类后全部通过，含超限 known_failed |
| `replay-final` | 1 / 1 | 0：最终代码再次完成未改动 #296 的完整闭环 |
| `lint-final` | 完整 typegen + TypeScript | 0 |
| `build-final` | production build，44/44 页面 | 0；BUILD_ID 见上 |

主要实际命令如下（PowerShell）：

```powershell
$endpointRunner = 'output/work-agent-p2-endpoint-fix-20261029/run.mjs'
node $endpointRunner regression node_modules/vitest/vitest.mjs run --maxWorkers=2 `
  src/lib/server/work-review/agent-endpoint-sources.test.ts `
  src/lib/server/work-review/agent-p1.test.ts `
  src/lib/server/work-review/agent-p2.test.ts `
  src/lib/server/work-review/agent-consistency.test.ts `
  src/lib/server/work-review/agent-model.test.ts `
  src/lib/server/work-review/agent-stream.test.ts `
  src/app/api/work-reviews/work-agent-routes.test.ts `
  src/components/work-review/work-agent-page.test.tsx `
  src/lib/server/work-review/project-deletion.test.ts `
  src/lib/server/work-review/todo-repository.test.ts
node $endpointRunner endpoint-final node_modules/vitest/vitest.mjs run src/lib/server/work-review/agent-endpoint-sources.test.ts --maxWorkers=1
node $endpointRunner replay-final node_modules/vitest/vitest.mjs run --config output/work-agent-p2-endpoint-fix-20261029/vitest.replay.config.ts --maxWorkers=1
node $endpointRunner lint-final npm run lint
node $endpointRunner build-final npm run build
```

16 项端点测试还覆盖：两个字段缺失/不存在、跨账号、跨项目、未关联、删除、预览后来源变化、坏引用不得静默丢弃、候选不得替代正式决定、没有解决依据不得关闭、事务中后续创建失败整批回滚、事务提交但 Runtime 回执失败后 inspect 恢复且无重复写入。

保留的其他中间失败：首次 `replay-before` 漏复制 WAL，报缺表，属于回放准备错误，补齐 WAL 后才取得有效修复前证据；`endpoint-tests` 为15通过/1失败，原因是 rejectedKeys 断言误按字典序而实际按固定预览顺序保存，按原顺序修正断言，未删除用例或放宽业务条件。最初 `lint`、`build` 也退出0；追加容量失败分类修复后重新运行最终检查和构建，没有用旧构建代表最终代码。首次文档收尾审计因 PowerShell 追加末尾 CRLF 产生 whitespace 告警（diff检查退出2、审计退出1）；只整理本轮追加部分的换行，原历史字节前缀未变，失败审计仍保留。

## 保护结果与剩余限制

- 对照本轮基线，其他既有 dirty 成果未改；3,702 个历史证据文件摘要全部一致，`UPDATE_HISTORY.md` 原字节前缀完整保留。差异与保护结果见 `audit-final-verified.json`；编译后的服务端包含本次规范化，见 `build-proof.json`。
- 原真实账本仍 **296**，SHA-256 `e77416e7e133514b02ad84c3089ec859389de2af876f8efc6cd04f13c8939f9c` 未变；真实 Provider 新增0。回放 usage 是隔离副本内的历史数值，不计作新请求或真实费用。
- #287 仍 `unknown`，原 input/output token 都保持 NULL；#296 原业务任务仍 `needs_attention`，没有重试、追认或覆盖旧成绩。
- 原账本/业务库仅复制后检查；副本及最终回放 SQLite 的 `integrity_check=ok`。本轮未启动 HTTP 服务；测试和构建进程已退出，3210、37952 无监听。
- 原模型输入/输出 schema、每项8引用上限和整批结构错误拒绝策略保留。复杂语义仍需要用户核对；不新增自动推断、自动重试或自动应用。
- 雷达仍按已有独立 Finding 展示“仍待处理的事项”，可能与具体未解决事项重叠；本轮不按文本相似合并或扩展雷达。
- 本轮未重新进行真实 Provider 或现场浏览器验收，不把组件/API/离线结果等同于真实验收。下一次如获授权，应先核对新构建、原账本和有效预算，再用独立合成副本完成一次有界真实流程；不重试旧 unknown。
- 无提交、推送、合并、部署、新 Worktree 或 P3 开发。

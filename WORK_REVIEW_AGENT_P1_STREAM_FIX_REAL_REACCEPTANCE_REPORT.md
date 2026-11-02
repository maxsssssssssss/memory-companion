# Work Review Agent P1：SSE 修复后 M3 最终真实验收

日期：2026-10-29（Asia/Shanghai）。结论：**SSE 真实响应处理通过；选中操作的保存与重开通过；完整 M3 产品目标未通过。**

本轮只创建一个新 M3 任务，使用正式模型 3 次。真实回复产生两项错误操作建议，人工拒绝后未写入。部署待办因此未调整为 B；另发现已完成测试仍被列为“未关闭”的展示缺陷。没有用剩余额度重新提问、换任务或修补数据。

## 1. 实际基线与运行方式

| 项目 | 本轮实测 |
| --- | --- |
| 工作区 | `C:\Users\50245\.codex\worktrees\work-review-agent-p1\daily-brief-source-20260708-122232` |
| 分支 / HEAD | `codex/work-review-agent-p1` / `0653b3f18d56c121935f50502a0dedef06ba5bcd` |
| 源码状态 | HEAD 加既有未提交 P1/SSE 修复；启动、结束核对的 1,845 个原文件哈希均未变。本轮没有修改业务源码、Prompt、配置或 UPDATE_HISTORY |
| production build | Next 15.5.19；BUILD_ID=`rMEINRPW2EYypUJAs5jXd`；此前构建成功于 2026-10-28 17:46:28 +08:00，本轮未重新构建 |
| 编译产物身份 | Agent route SHA256=`8eac24f878d91f1f30b56963b6968c6389dec56e8f6eb023931d4611aa4bfc7c`；parser chunk 1885 SHA256=`84f4bf5d967b570ffb07bc3787181e15686103d71079e916eecb7d0c6bde3f8f` |
| 修复生效核验 | 编译产物包含分项 streamLimits、completionReceived 及 `[work-agent-response]`；实际运行也输出对应完整诊断。两个产物哈希结束时未变 |
| 正式 Provider | TokenHub / `deepseek-v4-pro`，reasoning=none，max output=6000，timeout=90000ms，maxRetries=0；没有变更路由 |
| 服务 | `next start --hostname 127.0.0.1 -p 37952`，10:32:39–10:46:19 +08:00；自有服务与浏览器已停止，无监听 |
| 新任务 | `dc0f4650-3758-4c63-8409-c2e137510cd9` |

数据放在 [独立验收目录](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029)。通过 SQLite backup 复制上一轮**合成业务库**，复用三场已核对会议、3 条原 Todo 和已批准的 M2 关系；同时保留旧 M3 unknown。没有重跑 M2、重试 #287、导入离线模型回复或直接插入 Agent 成功记录。之后的任务创建、选择、批准均由正式页面发起。

本轮材料整理/ASR 不是验收范围；三场会议及 Findings 来自既有合成 fixture 的业务 repository 审核流程。本轮的决策和比较响应全部来自真实 Provider。

启动时最初的辅助预检错误地要求原始配置地址完全等于规范地址，退出 1；按**未修改的实际 TokenHub adapter**构造并核验客户端后通过，证明这是预检假设过严，不是配置漂移。没有改地址或发探测请求。证据：[baseline.json](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/baseline.json)、[实际 Profile 核验](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/profile-verification.json)。

## 2. 预算、请求与 usage 对账

使用同一既有累计账本：
`C:\Users\50245\.codex\worktrees\agent-structured-windows-smoke\daily-brief-source-20260708-122232\output\agent-v1-1-windows-final-20261016\real\network-ledger.sqlite`。

启动现场为 **287/293**，有效新增上限 min(用户 6，累计余额 6)=6。Guard 仍使用累计上限 293、protocol 上限 2；本轮不是 protocol 测试。代码允许的最大配置值 319 不构成授权，未采用。产品任务的 16 calls / 16 steps / 600000ms、每调用 inputChars 48000 / output 8000 仍保留；正式 Provider 输出 6000 与外层新增 6 次限制更严格。Guard 同时限制目标端点、输入大小，拒绝新失败或未完成请求后的继续调用。

| 账本 | 用途 / requestId | 网络 / 产品 | 输入 Tokens | 输出 Tokens |
| --- | --- | --- | ---: | ---: |
| #288 | 决策；`0a69cd66-512c-471e-951f-1a98827d8281` | HTTP 200 completed / succeeded | 1110 | 40 |
| #289 | 决策；`ad5326fc-c593-4931-bd54-baec9930cb64` | HTTP 200 completed / succeeded | 5736 | 46 |
| #290 | M3 比较；`1351e9c6-dc9f-439b-b441-0e05b211289d` | HTTP 200 completed / succeeded | 6102 | 1681 |
| 合计 | **3 次** | **新增 unknown=0，已知 Provider 失败=0** | **12948** | **1767** |

总用量 **14715 Tokens**，均为 Provider reported usage，与 agent_calls、任务 usage、阶段日志逐项一致，没有估算补零。累计 **290/293**，剩余 3 次未使用。选择、批准、重复确认、刷新和重开均未增加模型请求。

历史账本 #101 仍为 unknown，usage 为 NULL，不能视为 0。历史 #287 网络 completed / 产品 unknown 的原有差异和 NULL 产品 usage 原封保留；其已捕获网络 usage=6102+1365，也未追认到旧产品记录。

证据：[原始账本快照](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/ledger-before.json)、[逐请求对账](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/closeout-corrected.json)、[实际运行日志](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/app.log)。

## 3. SSE 修复的真实证据

#290 实际诊断为：

- SSE data 累计 **248732 字节**，**1688 个事件**；
- 最大事件 **10737 字节**，正文增量 **4539 字节**；
- completionReceived=true，phase=complete；
- JSON parse=success，schema validation=success，usage=6102/1681；
- 产品比较成果实际落库，并生成可恢复的固定预览。

这次真实流超过旧 200000 字节累计限制，而正文只有约 4.5 KB，证明新策略处理了本轮实际遇到的协议开销。新策略仍保持每事件/正文增量 200 KB、累计协议额度 2336000 字节；未放松 JSON、业务来源或 unknown 保护。实现位置：[agent-model.ts:50](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/work-review/agent-model.ts:50)、[structured-json.ts:539](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/openai/structured-json.ts:539)。

**本轮没有再次出现“Provider 完成、产品 unknown”的新记录。** 这不追溯证明历史 #287 的唯一失败原因；原 SSE 帧仍缺失。

## 4. 人工语义审查与引用

实际覆盖 3/3 会议、14/14 已确认 Findings、3/3 项目 Todo 状态、2/2 已存在议题。页面明确说明不含 pending/ignored 候选、完整会议讨论或 Todo 备注。

真实输出有 5 条比较、8 项操作。5 条比较分别为新增监控、B 正式替代 A、测试完成/回滚解决、日志与供应商未解决、客户约束清单缺少记录；这些文字判断均与原文一致。changed/resolved 的模型标签在产品内规范化为“关联建议，待确认”，未当作已批准关系。

全部操作引用在页面逐个打开，共 **13 处引用、10 条不同 Finding**；显示对应会议、日期及合成原文时间段。来源 ID/权限/版本读取有效不等于操作语义正确，错误供应商建议正是引用了相反证据。

| 操作建议 | 人工核对 | 最终选择 |
| --- | --- | --- |
| B 替代 A | M1 正式 A、M2 暂停但未批准 B、M3 正式 B，三端原文正确 | 批准 |
| 关闭回滚问题 | M1 问题与 M3 明确解决相符 | 批准 |
| B 候选另建 records | 引用有效，未把 M2 说成最终决定；但以候选作新议题会与现有同步方案议题重复，标签含混 | 不采用，不记为“提前采用 B”的已发生错误 |
| 日志期限延续 | M1 未决 + M3 仍未解决；没有关闭依据 | 批准，保留 open |
| 调整 B 部署 | 原 Todo ID、负责人、10-30 正确；**实际新 title 仍是“A方案部署”**，与标签及 M3 原文矛盾 | 拒绝，整项零写入 |
| 新增监控 | 明确承诺，林晨，10-29；来源正确 | 批准 |
| 完成供应商等待 | **错误**：引用 M3“供应商还没回复”；也与模型自己的 unresolved 文字矛盾 | 明确拒绝，零写入 |
| 完成回滚测试 Todo | 原测试 ID、M3 明确完成证据正确；与关闭问题分开 | 批准 |

证据：[真实回复与来源检查](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/diagnosis-290.json)、[逐条页面原文](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/ui-source-review-results.log)、[选择记录](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/ui-selection.log)、[固定预览](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/playwright/work-p1-sse-m3-preview.yml)。

没有修改预览、让模型补答案或手工改 Todo 来补齐验收目标。**两项真实模型错误被人工选择机制拦住**，不是产品自动理解并拒绝了错误。

## 5. 事务、实际业务结果与重开

页面完成“逐项选择 5 项 → 核对选中项 → 固定预览确认弹窗 → 最终批准”。批准前，Todo 与关系行均和初始快照一致。

批准后，task=ended、artifact=applied；回执 selectedKeys=5、rejectedKeys=3。同一事务实际新增 **3 条关系事件**、创建 **1 条监控 Todo**、完成 **1 条原测试 Todo**；Todo 操作历史新增 2 条（created_from_finding、completed），共 4 条 Todo、5 条 Todo 历史事件。回执与实际业务行一致。事务组合位置：[agent-repository.ts:171](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/work-review/agent-repository.ts:171)。

| 必须核对的目标 | 结果 |
| --- | --- |
| B 正式替代 A，M2 候选不提前成为决定 | PASS：currentFindingId 指向 M3 B；时间线保留 M2 suspends，再有 M3 supersedes |
| 更新原部署 Todo，保留 ID | **未完成**：错误建议被拒绝，原 ID `wrt_eb0bff65-2f2b-4e95-a4a7-c9131b512109`、A 标题、10-28 截止及历史保持不变；无重复部署 Todo |
| 完成原回滚测试 | PASS：`wrt_d24c9188-1138-481c-b6da-674afb52d1bd` completed，原会议/Finding 来源保留 |
| 有依据地关闭回滚问题 | PASS：独立 resolves，问题状态 resolved |
| 创建监控 Todo | PASS：`wrt_9e5f5d13-d5f4-45b7-bd02-d50c431f1b1a`，林晨，10-29，open，有 M3 来源 |
| 日志期限、供应商仍未解决 | PASS：日志 thread open；供应商 Todo 完整行及历史未变 |
| 未批准建议不写入 | PASS：2 项错误 + 1 项未采用关联全部保存在 rejectedKeys；无对应业务修改 |
| 重复确认 | PASS：重发**原批准请求的同一 eventId/版本/指纹**，HTTP 202、scheduled=false；Todo、Todo 历史、关系、模型调用数均未变化 |
| 刷新、离开页面返回、关闭标签页再打开 | PASS：均恢复同一成果、“已保存 5 项，未采用 3 项”、固定预览及当前待办 |
| 最小时间线 | PARTIAL：暂停→B 替代及原文正确；M1 A 的事实可从引用打开，但既有 M2 未存 records，未显示独立“M1 采用 A”节点 |
| 未闭环提示 | PARTIAL：日志/供应商保留正确；测试已完成却仍有“回滚测试：尚无已确认关闭关系”提示 |

最后一个问题来自既有 M2 `tracks` 议题：Todo 已 completed，但议题投影仍 open，并被统一当作 question 提示。见 [agent-context.ts:84](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/work-review/agent-context.ts:84)、[agent-service.ts:66](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/src/lib/server/work-review/agent-service.ts:66)。这是本轮实测的产品投影缺陷，不是测试 Todo 未落库，也不是 SSE 失败。本轮没有修复它。

证据：[批准前快照](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/inspect-before-approval.json)、[实际批准请求](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/ui-mutations.log)、[重复确认结果](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/repeat-approval.log)、[重开页面](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/playwright/work-p1-sse-m3-tab-reopened.yml)、[实际服务只读投影](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/project-projection.json)。

## 6. 保护检查、命令与限制

- 原 287 条账本记录逐行不变；旧 #287 在原库及独立副本中都保持 unknown。原库 10 组相关业务表逐行不变，数据库正文、WAL 与 checkpoint 哈希均未变。
- **文件字节保护例外**：旧合成库 `date-companion.sqlite-shm` 哈希改变，因此严格全文件检查保留退出 1。仅共享内存侧文件变化，与只读 backup 的 SQLite 读者记账相符；正文和 WAL 哈希未变。没有覆盖/还原侧文件来制造全文件 PASS。[核验详情](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-stream-real-20261029/history-verification.json)。
- 独立 Work、checkpoint、date-companion SQLite 和既有网络账本 integrity_check 均为 ok；原 Work 库也为 ok。
- 服务主动停止时 launcher exit=1，记录为受控关闭，不当作测试通过。端口 37952 无监听；没有终止其他任务进程。
- 没有提交、推送、合并、部署、服务器访问或真实用户数据访问。本轮只新增报告、隔离验收脚本、合成副本和证据，保留既有 dirty 改动。

主要命令（均在本报告工作区）：

| 命令 / 操作 | 实际结果 |
| --- | --- |
| `node output/work-agent-p1-stream-real-20261029/preflight.mjs` | 1；原始地址检查过严，其余基线/账本/构建检查一致 |
| `node --import tsx .../verify-profile.ts` | 0；实际未改适配器核验通过，0 请求 |
| `node .../prepare.mjs`、`node --check .../guard.cjs`、`node --check .../launch.mjs` | 0；独立副本及 Guard 就绪 |
| `node .../launch.mjs` | production 服务成功启动；主动停止后 1 |
| `npx --no-install --package @playwright/cli playwright-cli -s=workp1ssefinal ...` | 正式 UI 的输入、来源核对、逐项确认、重开成功；没有响应 mock |
| `node --import tsx .../diagnose.ts` | 0；真实回复 5 items / 8 changes，10 个不同有效来源 |
| `node --import tsx .../read-projection.ts` | 0；只读 SQLite 使用实际项目服务，验证状态及提示 |
| `node .../closeout.mjs` | 1；严格历史文件哈希检查发现上述 -shm 变化 |
| `node .../verify-history.mjs` | 0；正文/WAL/原业务行与历史 unknown 未变 |
| `git diff --check` | 0 |

辅助工具中间失败也保留：初次打开不存在的 /login 返回 404，随后使用产品实际登录入口；一次 CLI 脚本函数格式错误及一次过期元素 ref 均在发业务请求前失败；一次辅助 page.request GET 未携带应用鉴权而返回 401，不算重开成功证据，重开以正式页面及只读服务投影核验。最初收尾脚本因此读取不到 threads；另一处辅助统计误用 Todo 事件 id 字段，已按真实 event_id 修正为新增 2 条，原错误输出保留于 closeout.json，最终采用 closeout-corrected.json。上述均未产生真实模型重试或修改业务代码。

本轮未运行 Vitest、SSE 单测、lint 或新 build；这些不是本轮真实用户验收的替代。来源删除、移出项目、跨账号攻击、真实断流/超时/取消等未在本轮重做，既有离线证据不升级为本轮真实通过。

**停止原因**：唯一 M3 任务的正确选中项已保存并完成核验；错误部署建议被拒绝，不能在不改预览/重新请求的前提下补齐目标。保留 3 次余额，不用它刷成功率。后续若获授权，应优先处理“标签/操作载荷与原文矛盾”的建议质量问题和 tracks 议题与 Todo 状态的投影问题，再定义新的有界验收。本轮不进入修复开发。

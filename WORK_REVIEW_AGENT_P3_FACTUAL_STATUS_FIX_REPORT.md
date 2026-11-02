# Work Review Agent P3 会前议程事实与日期修复

日期：2026-10-30。结论：**本轮定向修复与离线验收通过；真实 Provider 复验未执行。**

## 1. 基线与范围

- 工作区：`C:\Users\50245\.codex\worktrees\work-review-agent-p1\daily-brief-source-20260708-122232`。
- 分支：`codex/work-review-agent-p1`；HEAD：`0653b3f18d56c121935f50502a0dedef06ba5bcd`，未改变。
- 初始已有 P1、SSE、P2、P3 未提交修改。开始时保存 Git 状态、1431 个源码/配置/历史文件摘要及源码副本；本轮增量单独保存为 `output/work-agent-p3-facts-20261030/incremental.patch`。
- 真实 Provider 请求 **0**；账本仍为 **302**，原网络 unknown 1 条及旧产品 unknown 均保留。未创建 Worktree，未提交、推送、合并、部署或访问生产。

## 2. #302 原始问题复现与根因

直接读取原 `response-302.json`、`semantic-audit.json`、正式 API 快照和 `vendor-detail.txt`。原响应 SHA-256：

`f2e813685cc2fb6cea3c6572f20b396ce61a72b41423bec241343e33cb272bc7`

将含 WAL 的原合成业务库复制到隔离目录，通过实际 SSE 解析、`generateWorkPreparation`、AgentRuntime 和 `saveGenerated` 回放，响应正文未改动：

| 阶段 | 解析/任务 | 业务草稿 |
|---|---|---|
| 修复前 | completed / ended，schema 成功 | 原样保存“B已上线”和“与准备会议日期同日” |
| 修复后 | completed / ended，三项议程保留 | 两句错误文字均未进入新 `generated_json`、`agenda_json` 或 API 事实字段 |
| 旧草稿读取 | 使用修复前库的独立副本 | 返回安全的系统事实投影；历史数据库行逐字不变 |

根因不是 SSE、unknown 或引用越权：旧 schema 要求模型自由填写 `reason/background/currentStatus`；仓库检查引用身份及负责人依据后直接保存这些文本。真实引用存在不等于支持模型连接出的事实。旧输入只有 `asOf`，没有明确独立的 `meetingDate`，模型将读取日期解释成会议日期。

证据：`replay-before-3/replay.json`、`replay-after/replay.json`、`legacy-read/result.json`，均在本轮证据目录。回放 usage 来自历史响应，仅为离线测试输入，不是新增付费调用。

## 3. 修改文件与事实职责

本轮修改 **5 个产品文件、3 个测试文件**，新增 **1 个原始响应测试 fixture**；未修改 P1/P2 核心、Learning、共享 Runtime、SSE 或 Provider 路由。

| 文件 | 变化 |
|---|---|
| `src/lib/domain/work-preparation.ts:19` | 独立模型议程建议契约，去掉模型对 reason/background/currentStatus 的所有权；严格兼容旧响应并丢弃这些字段；保留现有文档存储格式 |
| `src/lib/server/work-review/preparation-context.ts:30` | 在现有上下文上投影系统事实：当前正式决定、Todo 状态/期限、P2 问题状态、已确认历史来源；不增加事实权威或推理引擎 |
| `src/lib/server/work-review/preparation-model.ts:8` | 模型只组织标题、讨论问题、预期结果、顺序、优先级和有效引用；明确日期职责 |
| `src/lib/server/work-review/preparation-repository.ts:65` | 新生成保存前规范化；旧草稿读取也使用同一事实投影；编辑保存不信任客户端上传的事实字段，用户讨论内容仍保持原版本 |
| `src/components/work-review/work-preparation-panel.tsx:27` | 区分“Agent 讨论建议·待核实”“用户保存的讨论计划”和“系统业务记录”；展示独立日期，不只隐藏错误文字 |
| `src/lib/server/work-review/preparation.test.ts` | 原响应契约、正式保存、事实投影、编辑/重开、日期与过期回归 |
| `src/app/api/work-reviews/work-preparation-routes.test.ts` | 新建议 schema 经正式 SSE/API 保存，拒绝客户端事实注入，关联会议后真实日期与会后对照 |
| `src/components/work-review/work-preparation-panel.test.tsx` | 事实/建议展示边界、日期区分、原编辑操作回归 |
| `src/lib/server/work-review/preparation-302.test-fixture.json` | 原 #302 完整合成响应，文件摘要与原件一致 |

没有新增数据库表、字段、迁移、依赖、第二 Agent 或第二模型审核。原 `reason/background/currentStatus` 字段由程序填写，模型的 `question` 继续承担具体讨论重点，避免无必要的字段重命名与文档迁移。

### 当前事实如何产生

- 当前决定来自 P2 已确认关系投影；历史引用仍标注会议当时的记录，候选不转为当前决定。
- 部署显示正式采用 B、Todo open、待办截止日期，以及“该待办尚无完成确认记录，实际进展需要核实”；不说“尚未上线”。
- 供应商显示实际等待记录；日志显示 P2 未解决状态；已完成测试显示正式完成记录，不进入未完成雷达。
- 独立问题按现有关系状态判断，不根据 Todo 完成自动关闭。
- 事实字段在保存前重建，读取时按当前业务记录更新。用户的标题、问题、预期结果、排序和增删不被模型覆盖；过期提醒仍基于原 fingerprint。
- 原来源、账号、项目、权限与版本检查保留。无法确定时说明待核实。没有针对 B、上线或供应商的生产关键词黑名单。

## 4. 日期修复

- `asOf` 是服务端读取项目状态的时间，界面标注“状态更新于”。
- 未关联实际会议时 `meetingDate=null`，显示“会议时间：未指定”。
- 已明确关联会议时，从同账号、同项目会议记录读取真实 `meetingDate`；日期改变或关联失效继续遵循既有来源规则。
- Todo deadline 仅标为“待办截止日期”，不填入会议日期。未增加自然语言日程推断或预约功能。

## 5. 验收逐项结果

| 验收项 | 结果与证据层 |
|---|---|
| B 已采用、部署 open | PASS：原响应正式服务回放、API、production 页面均显示需核实实际进展 |
| 原模型写“B已上线” | PASS：保存前丢弃模型事实文本，生成事实字段无此断言；原始响应及旧历史不改 |
| 供应商未回复 | PASS：生成议程和系统记录仍为等待；用户删除议题只改变会议计划，原等待 Todo 不变 |
| 日志期限未确定 | PASS：保留具体期限/负责人讨论问题，系统记录仍未解决 |
| 测试已经完成 | PASS：正式 Todo 事实为完成；项目简报与雷达不列为未完成工作 |
| 未指定会议日期 | PASS：模型输入、API、页面均为空/未指定 |
| Todo 截止日期 | PASS：2026-10-30 仅作为待办期限；没有被用作会议日期 |
| 最多三项 | PASS：原 #302 三项完整保留，无自动补题；编辑后仍为三项 |
| 用户编辑保存/重开 | PASS：实际页面删除供应商议题、上移日志、修改讨论重点、新增临时议题，保存版本2；刷新及新标签重开保持用户版本 |
| 项目变化与过期 | PASS：正式服务测试修改 Todo 期限后过期标志为 true，用户讨论内容不变、系统事实读取新期限；页面过期组件测试通过 |

没有把所有议题降为泛泛问题：原 #302 部署进度/发布支持、日志具体期限/负责人、供应商继续跟进/关闭条件等具体问题和优先级保持；新模型契约也通过正式 SSE/API 测试。

P3 原 M1—M4 测试继续覆盖保存、关联 M4、会后对照、用户确认进入 P1、Todo/关系事务、P2 状态变化、重复操作、重启恢复、来源失效、账号/项目隔离和取消/unknown。此次浏览器聚焦本修复，不声称重新完成真实 M4 模型验收。

## 6. 实际测试与构建

| 命令 | 实际结果 | 退出码 |
|---|---|---:|
| `node --require ./scripts/cloud/offline.cjs --import tsx output/work-agent-p3-facts-20261030/replay.ts before -3` | 修复前成功复现两项错误；无真实请求 | 0 |
| 同命令将参数换为 `after` | 原响应修复后通过，三项有效议程 | 0 |
| `node --require ./scripts/cloud/offline.cjs --import tsx output/work-agent-p3-facts-20261030/legacy-read.ts` | 旧草稿安全投影，原行不改 | 0 |
| `npm test -- @files --maxWorkers=2` | **12 文件 /162 用例全部通过**，无跳过 | 0 |
| `npm run lint` | Next typegen + 完整 TypeScript 通过 | 0 |
| `node output/work-agent-p3-facts-20261030/run.mjs build` | production build 及内置类型检查通过 | 0 |
| `node scripts/sanitize-next-traces.mjs` | manifests=183、removed=42、forbidden=0 | 0 |
| Playwright CLI 正式页面操作 | 原响应生成、来源打开、编辑、保存、刷新、新标签重开、同请求重复保存通过 | 0 |
| `node output/work-agent-p3-facts-20261030/closeout.mjs` | 文件/账本/行保护、SQLite、进程和端口通过 | 0 |
| `git diff --check` | 通过 | 0 |

`$files` 的原始12路径保存在 `output/work-agent-p3-facts-20261030/test-files.txt`，完整展开命令与计数在 `tests-regression.log`。其中 P3 为3文件23例，其余为 P1/P2、Todo、项目删除和受影响页面/API 回归。

实际浏览器构建 ID：**`lWqMqGIEMas13yHSwgN5m`**。模型传输由本地离线流回放原 #302，没有真实 Provider。浏览器证据位于 `output/playwright/work-agent-p3-facts-20261030/`：`facts-expanded.txt`、`deployment-source.txt`、`generated-facts.png`、`saved-api.txt`、`refreshed-api.txt`、`reopened-api.txt`、`reopened.txt`。

### 保留的中间失败

- 保护脚本首次 `spawnSync git EPERM`，未开始快照；使用获准本地执行后成功。
- 第一次辅助回放目录与源码备份目录重名（EEXIST）；第二次只复制 SQLite 主文件、漏 WAL，来源不完整，任务 needs_attention。两次辅助失败保留；第三次完整复制后成功复现，未改响应或来源绕过校验。
- 首次类型检查2处错误：测试样本缺新日期字段，以及误用了 Todo 不支持的 cancelled 状态；已按真实契约修复。
- 初轮3文件18例：17过/1失败，旧测试要求已完成工作状态保持旧快照。保留用户讨论版本断言，增加当前状态完成断言；没有删除 M4 闭环测试。
- 下一轮3文件23例：22过/1失败，“尚未解决/仍未解决”两种投影文案不一致；统一为“仍未解决”。单例复验1过/15未选中，最终12文件162例全过。
- 浏览器匿名进入时2条预期 auth/me 401、登录入口2条 CSS preload 警告；没有会议准备流程错误。Windows 自有服务受控停止返回1，已确认进程退出和端口释放，非构建失败。

## 7. 数据保护和收尾

- **7819 个原历史证据文件摘要不变**；原账本文件 SHA-256 不变，累计302；没有重试/追认 #287 或重置任何历史记录。
- 本轮仅修改前述8个已有源码/测试文件，新增原响应 fixture、报告及隔离验收材料；P1/P2/SSE、Learning、Runtime 的原有文件摘要保持。
- 浏览器合成副本的原3会议、14 Findings、4 Todo、6 Todo 事件、3持续议题、4关系事件、2 P1 成果逐行不变；所有旧任务/调用/action 行保持。
- 浏览器只新增1个准备任务、2个工具 action、3个**离线**调用、1条准备及1条用户保存回执。重复同一 PATCH 未增加版本或记录，仍版本2。
- 3个自有 SQLite 均 `integrity_check=ok`、外键检查为空。浏览器与服务 PID 已退出，37955 端口释放。
- `UPDATE_HISTORY.md` 只追加中文记录，原前缀保留。未运行无关全仓测试，不把本轮离线结果表述为真实模型验收。

## 8. 尚存限制

本修复保证事实栏由现有权威业务记录产生，并消除 #302 已证实的两处错误进入新草稿事实的路径。模型标题、讨论问题、预期结果仍是**待核实建议**，其中复杂语义或错误前提不等于已经自动验证；页面将其与事实分开，不作为完成、关闭或正式决定的写入依据。没有增加通用语义判定或第二模型。

受 P1/P2 现有覆盖范围和关系粒度限制；复合 Finding 不自动拆成新的事项身份。未关联实际会议时不推断日程日期。新版 Prompt 和建议质量尚未进行真实 Provider 复验，需用户另行决定；本轮到此停止。

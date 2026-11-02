# Work Review Agent P1 集中修复报告

日期：2026-10-29（Asia/Shanghai）。本轮本地实现与离线验收完成；真实 Provider 请求 **0**，未提交、推送、合并或部署，未进入 P2。

## 1. 基线与范围

- 工作区：`C:\Users\50245\.codex\worktrees\work-review-agent-p1\daily-brief-source-20260708-122232`；分支：`codex/work-review-agent-p1`。
- HEAD 始终为 `0653b3f18d56c121935f50502a0dedef06ba5bcd`；原工作区已包含未提交 P1 和 SSE 修复。没有创建 Worktree，没有 reset、stash、清理或覆盖旧修改。
- 启动状态、1,846 个源文件摘要及 161 个历史证据/账本文件摘要：[baseline.json](output/work-agent-p1-final-repair-20261029/baseline.json)。本次差异以该现场快照为基准；不能把当前全部 Git dirty 都算成本次改动。
- 最终 production build：Next 15.5.19，BUILD_ID **V96M1PjYFTLmra2SZiYKc**；使用隔离数据目录与外网阻断环境。最终浏览器运行的就是该构建。

## 2. 实际根因与修复

**建议问题**：原 `validateComparison` 检查账号、项目、Finding 身份、结果类型、日期先后及 Todo 是否存在；“本次会议的有效引用”不代表“原文支持这个操作”。因此“尚未回复”的引用也能通过完成建议检查；更新预览直接展示模型 title，label 与实际写入字段没有一致性检查。

新增办公专属的有限检查函数 [agent-consistency.ts](src/lib/server/work-review/agent-consistency.ts:37)。它读取实际 Canonical 原文分句及目标对象，不用模型 label 证明操作正确，不增加模型调用，不改 Prompt。

- 完成/解决：把目标名称与原文分句对应；本次实际读取的会议中有明确反证则阻止。仅有缺少记录、问句、条件、无目标对应或无完成依据时标为待核实；历史未完成语句不直接否定后来的完成证据。
- 替代/暂停/撤回：在既有类型/最终决定门槛之上，核对该操作的实际谓词和否定/条件，不能只凭 Finding 是 final decision 放行。
- 更新：比较真实 title、负责人和期限。原文明确“调整为某内容”时，旧 title 原样保留、缺少该新内容或新 title 否定新内容均不能批准。负责人/期限单独更新仍能正常通过，不强迫同时修改标题。没有硬编码 A/B、供应商或 fixture ID。
- 检查结果为“待用户确认 / 已阻止 / 待核实暂不能批准”，不是“语义已验证”。反证来源可直接打开。错误建议原文和检查原因保留在固定预览中，**不属于可选可批准操作**；全选只选可确认项。
- [agent-repository.ts:61](src/lib/server/work-review/agent-repository.ts:61)、[:153](src/lib/server/work-review/agent-repository.ts:153)、[:169](src/lib/server/work-review/agent-repository.ts:169)、[:179](src/lib/server/work-review/agent-repository.ts:179)、[:199](src/lib/server/work-review/agent-repository.ts:199) 共用同一检查：创建预览、重读旧待处理预览、选择、批准准备和事务应用。服务端不信任浏览器的 disabled 或历史 review 字段。已应用历史不重算为新结果、不重放。
- 固定预览仍绑定原操作字段、来源指纹、任务版本与账号；批准摘要也展示旧/新值。没有通过改标签或改原会议来掩盖实际 payload。

**状态问题**：原状态投影把所有 open 议题都作为“尚无关闭关系”的 question 提示；tracks 是一个工作关联，不会自然产生 resolves。Todo 已完成后，工作承诺因此被误显示成未解决问题。

[agent-context.ts:65](src/lib/server/work-review/agent-context.ts:65) 从有效的锚点 Finding 区分工作、独立问题、决定和其他事项，并从有效且未撤回的 tracks 关系读取当前 Todo 状态。[agent-service.ts:68](src/lib/server/work-review/agent-service.ts:68) 将工作和问题分别投影：已完成工作不再重复进入未闭环列表；独立问题继续保持 open，并明确显示“关联待办已完成，问题仍未解决”。只有用户确认的 resolves 才关闭问题。

共同的边界问题是把一种对象的状态当成另一种对象的证明；两处分别修复各自职责。没有新增第二个事实状态，也没有为页面另写一套校验。

## 3. 修改文件与数据结构

| 文件 | 本次内容 |
| --- | --- |
| `src/lib/server/work-review/agent-consistency.ts`（新增） | 有限、确定性的操作与证据检查 |
| `src/lib/server/work-review/agent-repository.ts` | 预览检查结果持久化、旧预览投影、选择/确认/应用门槛 |
| `src/lib/server/work-review/agent-context.ts` | 议题类别与关联 Todo 当前状态 |
| `src/lib/server/work-review/agent-service.ts` | 未闭环提示区分工作与独立问题 |
| `src/lib/domain/work-agent.ts` | preview.review 与派生 thread kind/linkedTodos DTO |
| `src/components/work-review/work-agent-page.tsx` | 阻止/待核实原因、选择范围、准确的保存后状态和议题展示 |
| `agent-consistency.test.ts`（新增）、`work-agent-routes.test.ts`、`work-agent-page.test.tsx`、`e2e/fixtures/work-agent-p1.spec.ts` | 下述离线验收与边界回归 |
| `UPDATE_HISTORY.md` | 仅在末尾追加本次真实记录 |

**不需要数据库迁移或新表**：review 保存在现有 preview_json 中，旧预览未应用时动态重查；thread kind/linkedTodos 从现有事实派生，不持久保存第二套状态。Todo Repository、原始来源、Todo 操作事件、已确认关系事件、事务和稳定操作键继续复用。Learning、共享 AgentRuntime、SSE 修复、Provider 路由、Prompt、预算及配置未修改。

## 4. 12 项离线验收

| # | 场景 | 实际结果与证据 |
| --- | --- | --- |
| 1 | 错误供应商完成建议不可批准 | PASS：preview 为 blocked，组件不可勾选；绕过 UI 向正式 PATCH 选该 key 返回 409，批准记录和业务写入均未产生。 |
| 2 | A 改 B，内容/预览一致，保留 Todo ID | PASS：正式服务/API 批准后原 ID 的 title 为 B方案部署，期限 10/30；原 sourceFindingId 不变，不新建部署 Todo。 |
| 3 | label 改 B 但 title 仍 A | PASS：操作被阻止；不同项目名、错误新值、否定新值及候选表述也有确定性用例。 |
| 4 | 已完成测试不作为未完成待办 | PASS：Todo 为 completed；工作 tracks 不再进入 question/open Todo 提示，页面显示工作记录及关联待办已完成。 |
| 5 | 关联 Todo 完成，独立问题仍开放 | PASS：独立 question 保持 open，展示已完成 Todo 与未解决问题两个状态。 |
| 6 | 有明确依据的回滚问题关闭 | PASS：批准 resolves 后为 resolved；没有依靠 Todo completion 自动关闭。 |
| 7 | 日志期限、供应商等待仍未解决 | PASS：日志问题保持 open，供应商 Todo 保持 waiting_for_other/open。 |
| 8 | 用户拒绝操作零业务写入 | PASS：既有 Runtime 拒绝确认测试保留且通过；未选或 blocked 项不应用。 |
| 9 | 批准操作真实落库且历史/回执一致 | PASS：同一办公 SQLite 事务，原 Todo 更新/完成、一个监控 Todo、关系事件与应用回执一致；后项故障回滚整批。 |
| 10 | 刷新、重开、重复确认与中断恢复 | PASS：API 重复事件不增 Todo/事件；组件卸载重挂和浏览器刷新读回结果；业务已提交而 Agent 回执写入失败后，重开 Runtime 按原操作键检查恢复，不重做。 |
| 11 | 跨账号/项目、失效来源、取消 | PASS：现有及新增定向测试覆盖越界、未关联、Todo/会议变化、删除/解除关联、取消晚到结果；B 失效不自动恢复 A。 |
| 12 | #287 和历史账本保护 | PASS：161/161 历史文件摘要不变；账本仍 290/293；#287 原记录仍 unknown，input/output tokens 仍 NULL，没有追认、重试或归零。 |

正常操作未被全部拦截：M3 的替代关系、更新原部署、完成测试、解决回滚、新建监控 **5/5 可确认并成功应用**。另验证正常负责人/日期单字段修改、独立事项的反证不误拦，以及旧待批准错误项重新读取后的阻止。

主要证据：`agent-consistency.test.ts` 28 用例；`agent-p1.test.ts` 的事务/恢复/隔离测试；正式 `work-agent-routes.test.ts` 4 用例；实际页面组件 4 用例；浏览器三会议闭环 1 用例。

## 5. 命令、退出码与证据层

| 执行 | 实际文件/用例 | 退出码 |
| --- | --- | --- |
| 完整受影响回归 regression | 75 文件，1,641 PASS，0 FAIL/0 SKIP | 0 |
| 最终业务边界 final-boundaries（补充问句/假设句后） | 6 文件，67 PASS，0 FAIL/0 SKIP | 0 |
| 保存后文案 ui-state-final | 1 文件，4 PASS | 0 |
| 最终 Chromium browser-final | 1 文件，1 PASS；桌面及 390px 移动截图、无横向溢出 | 0 |
| npm run lint：Next typegen + 完整 TypeScript | lint-final | 0 |
| npm run build + postbuild | build-final；44/44 页面；包含最终 TypeScript 检查 | 0 |
| git diff --check；历史账本保护 audit-final | 未改写原始文件；副本 SQLite integrity_check=ok | 0 |

重复范围不能相加冒充独立用例数。最后的小范围复验覆盖了完整回归之后新增的问句保护和保存后文案。

以下为实际执行命令（完整数组、起止时间及退出码另存同名 command.json）：

```text
regression: node output/work-agent-p1-final-repair-20261029/run.mjs regression node_modules/vitest/vitest.mjs run --maxWorkers=2 src/lib/server/work-review src/components/work-review src/app/api/work-reviews src/lib/server/agent src/lib/domain/work-review.test.ts src/lib/domain/work-todo-finding-defaults.test.ts src/lib/server/openai/structured-json.test.ts src/lib/server/openai/structured-json-limits.test.ts src/lib/server/openai/structured-json-socket.test.ts
final-boundaries: node output/work-agent-p1-final-repair-20261029/run.mjs final-boundaries node_modules/vitest/vitest.mjs run --maxWorkers=2 src/lib/server/work-review/agent-consistency.test.ts src/lib/server/work-review/agent-p1.test.ts src/lib/server/work-review/agent-model.test.ts src/lib/server/work-review/agent-stream.test.ts src/app/api/work-reviews/work-agent-routes.test.ts src/components/work-review/work-agent-page.test.tsx
ui-state-final: node output/work-agent-p1-final-repair-20261029/run.mjs ui-state-final node_modules/vitest/vitest.mjs run --maxWorkers=2 src/components/work-review/work-agent-page.test.tsx
lint-final: node output/work-agent-p1-final-repair-20261029/run.mjs lint-final npm run lint
build-final: node output/work-agent-p1-final-repair-20261029/run.mjs build-final npm run build
node output/work-agent-p1-final-repair-20261029/run-browser.mjs browser-final
node output/work-agent-p1-final-repair-20261029/audit.mjs audit-final
git diff --check
```

运行包装器清除继承的业务凭据，使用现有 cloudEnvironment/offline guard；不探测真实 Provider。SQLite 业务结果通过现有 repository、Runtime 和 API 写入，没有直接 INSERT 成功回执或已完成 Todo。测试故障注入只模拟事务失败/Agent 回执丢失，用来验证回滚与恢复。

**证据层区别**：API 测试调用正式 Next 路由函数，注入合成认证账号及确定性模型/离线 SSE；浏览器使用 production 页面组件及真实隔离 SQLite/Runtime，但 HTTP/auth 由 fixture 截获，真实 API 边界由独立路由测试覆盖。不是一次真实 Provider 或真实登录系统验收。没有把离线网络拦截响应描述为真实模型通过。

中间失败全部保留：

- `repro-before.log`：修复前 1 文件/2 用例失败，确认负面依据可选及完成 tracks 被误报的问题。
- `focused-1.log`：3 文件中 4 用例失败；中文分词拆散术语导致正常解决关系被误拦，修复身份词匹配后通过，未降低断言。
- `focused-3.log`：1/29 用例因三个完整 Runtime 流程超过默认 5 秒超时；该业务套件改为与既有 P1 同等的 20 秒上限，断言完整保留。
- `lint-1.log`：一次 string/never 空数组推断类型错误；修正后 lint-final 和最终构建均通过。
- `audit.log`：辅助审计脚本误用了 request_id 列，退出 1；只读取隔离审计副本。按实际 agent_calls.id 修正后 audit-final 退出 0，旧文件未打开为 SQLite 连接。
- 第一次 build/browser 均通过，但截图发现保存后文案仍显示待确认；已修正并完成 ui-state-final、build-final、browser-final，保留第一次日志与截图。完整回归中的既有 React act 警告也保留，未改无关周回顾组件。

## 6. 数据、Git 与进程保护

[audit-final.json](output/work-agent-p1-final-repair-20261029/audit-final.json) 记录了本轮代码差异、历史文件和账本保护。原账本 SHA-256 为 `293a229befa8442be2b6c5161c10bf95b050e88a1e61f86414eb063029c6f41a`，前后相同；累计 **290**，新增真实请求 **0**。只在隔离审计目录字节复制后打开 SQLite，避免只读连接也改动原 -shm。所有历史证据文件（包括侧文件）本轮均未变。

#287 调用 id `e8c1cffa-0a93-4474-8508-fb4dce2645d7` 保持原始 unknown，NULL usage 仍是未知，不计为零。没有访问服务器、生产数据库或真实用户内容。既有所有其他 dirty 文件与历史报告保持启动时内容。UPDATE_HISTORY 原内容作为完整前缀保留，只追加中文记录。

最终自有 Next/Playwright 进程已停止，端口 3210 已释放。浏览器身份/清理见 [browser-final.command.json](output/work-agent-p1-final-repair-20261029/browser-final.command.json)。截图：[桌面](output/playwright/work-agent-p1-final-repair-verified-desktop.png)、[移动](output/playwright/work-agent-p1-final-repair-verified-mobile.png)。

## 7. 已知限制与未执行事项

- 检查覆盖有限的中文显式完成/否定/条件/变更表达和可直接对应的字段；不是通用语义证明。复杂指代、同义转述、多重否定、多事项混在同一句或读入容量之外的反证仍有漏判/保守拦截风险。页面明确提示有限检查，人工确认仍是必要步骤。
- 本轮没有模型自动修正器，也没有就地改写已冻结预览。待核实/矛盾项需调整后重新比较产生新预览；不会在用户批准后重新生成另一份操作，也不自动重试。旧版待批准任务可能因新检查或确认内容绑定而要求重新比较，已提交回执不会重放。
- 时间线仍是 P1 简要投影，未做 P2 雷达/完整时间线或会前准备。旧会议不自动回填已确认关系。
- **真实 Provider 复验 NOT RUN**（本轮明确 0 次）；ASR、生产/服务器验收 NOT RUN。不以本轮离线 PASS 推定正式 Provider 的后续建议质量。

## 8. 结论

已识别的错误完成和“只改标签、不改实际内容”被服务端可靠阻止；正确 M3 操作可逐项确认并经原事务落库。工作完成与独立问题解决分开展示，原有幂等、权限、来源和恢复保护通过离线回归。本轮到此停止，等待用户检查报告，不提交或部署。

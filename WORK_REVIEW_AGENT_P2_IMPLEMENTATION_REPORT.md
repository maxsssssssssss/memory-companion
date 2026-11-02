# Work Review Agent P2 实现报告

日期：2026-10-29。结论：**P2 本地实现及离线验收完成**。项目页面可追溯已确认的决定变化，并查看未闭环事项及依据。真实 Provider、真实账号登录和生产验收未执行，不能由本报告推定通过。

## 1. 工作区、基线及原有修改

- 工作区：`C:\Users\50245\.codex\worktrees\work-review-agent-p1\daily-brief-source-20260708-122232`
- 分支：`codex/work-review-agent-p1`，沿用，没有创建 Worktree 或切换分支。
- 基线及最终 HEAD：`0653b3f18d56c121935f50502a0dedef06ba5bcd`。
- 实际 production BUILD_ID：`qTGsO0v_iBGJhnGUeRgWy`；构建退出 0，44/44 页面生成完成，构建产物清理检查 `forbidden=0`。
- 本次开始时已存在未提交 P1、SSE、最终修复和日志期限补齐。Git 的 HEAD 差异不能作为本次工作量。本轮先记录 1,850 个源码/文档文件摘要与逐字备份，以该现场快照计算增量。

完整初始 Git 状态、文件摘要和证据目录见 `output/work-agent-p2-20261029/baseline.json`，原文件快照在同目录 `before/`。原有 tracked dirty 包括 `UPDATE_HISTORY.md`、会议详情及其测试、项目页入口、`structured-json.ts`、项目删除测试、办公 schema、Todo repository 测试；原有 untracked 包括 P1 报告、项目 Agent 路由及页面、domain、Agent 服务/模型/关系/场景/测试和 SSE 测试。本轮没有把这些现存文件整体算作新增实现。

## 2. 用户可见功能

原项目“会后比较与工作脉络”入口内新增：

- **决策时间线**：默认查看议题当前状态；展开后按会议日期查看确认事实、候选/暂定方案、记录、暂停、替代、撤回、解决、重开、待办关联，以及用户撤回错误关联的历史。
- **未闭环事项雷达**：展示未完成待办、等待他人、未解决问题、缺少后续记录的行动/承诺、决定改变后需核对的关联待办、来源失效和未确认的 Agent 建议。支持“全部 / 等待他人 / 需要核实或确认”筛选。
- 每项可展开查看关注原因、事实/确认关系/建议/待核实标记、关联 Todo 实际状态和来源；会议原文通过现有证据接口重新读取。
- 保留比较、固定预览、逐项选择和最终批准流程；用户拒绝的关联不成为项目事实，也不继续冒充待确认建议。
- 补齐空、加载、错误状态；切换项目时清除旧视图，旧项目晚到的来源响应不会打开到新项目。

没有新增顶层产品入口、定时扫描、外部通知或 P3 会前准备。

## 3. 共同数据与状态计算

`src/lib/server/work-review/agent-service.ts:60` 的 `readWorkAgentProject` 同时生成时间线、雷达、议题状态和比较成果。页面只展示服务端状态、筛选和展开，不另行计算决定或问题是否已解决。

数据链：认证账号和明确项目 → 现有会议/待办关联 → 已确认 Finding 及有效 Canonical 来源 → 已确认 Work Thread 事件 → Todo 当前状态和已应用成果 → 同一份项目响应。

关键规则：

1. `readWorkThreads` 继续承担关系状态计算。`supersedes` 才产生替代后的当前决定，提议保持候选；暂停、撤回、解决、重开沿用原有关系语义。
2. 时间线新增显示原本已经持久化、此前未展开的 `retracts` 事件及会议日期。失效关系保留无正文历史标记；不借失效或撤回自动恢复旧决定。
3. 无持续关系的旧会议展示已确认事实，并明确说明无法据此还原完整变化过程。未写入任何回填关系。
4. 雷达读取当前 Todo 状态。已完成 Todo 不作为未完成工作；独立问题仍须通过确认的解决关系关闭。问题关联 Todo 时聚合展示，保留双方实际状态和等待属性。
5. 重复讨论依据同一议题的已确认跨会议关系计数；不按文本相似合并。没有关联待办/关系的行动记录标为“缺少后续记录”，不判断现实中没人处理。负责人/期限未结构化记录时要求核对原文，不声称原文一定没有这些信息。
6. 只有明确 `tracks` 关联的旧 Todo 才按决定变化提示核对。若该变化与 Todo 调整已经一起批准应用，就不再提示同一变化尚未处理。历史批准的更新来源可用于解释当前 Todo，但不覆盖 Todo 的原始来源。
7. 原通用任务列表只返回最近 50 条。P2 的项目查询按账号、项目和办公 scenario 读取完整任务历史，避免旧批准成果掉出窗口后被误报为缺少后续。模型输入容量和 Runtime 预算保持原有规则。
8. 来源删除、解除项目关联或版本变化后，继续使用 P1 的来源验证及失效屏障。删除时选择保留的独立 Todo 明确标记原来源失效，不将其伪装为仍有有效会议依据的工作。

主要复用位置：`agent-context.ts:54`、`agent-service.ts:60`、原 `agent-repository.ts`、`WorkProjectRepository`、`WorkTodoRepository` 和 `WorkReviewRepository`。

## 4. 数据结构、服务与框架范围

**不新增表、不修改 schema、不执行迁移。** 沿用现有 V10 的议题、关系事件、关系来源、Agent 成果，以及 Finding/Todo/Project 数据。

新增的是响应字段：`WorkThreadView.events` 的日期、Todo 标识和撤回目标；`timeline`；雷达的状态、判断类型、原因、来源链接和关联待办。均为即时投影，没有第二套“当前决定”或“问题完成”持久状态。

没有新增业务写入接口、模型工具、Prompt 或 Agent 平台。P1 的正式 API、Scenario、确认绑定、事务、操作键、回执和恢复仍承担所有写入。Learning、共享 AgentRuntime、SSE 修复、模型路由和预算未修改。

## 5. 本轮文件增量

以下为相对于本轮现场快照的增量，而非相对于 HEAD 的全部 P1 差异：

| 文件 | 本轮变更 |
| --- | --- |
| `src/lib/domain/work-agent.ts` | 时间线/雷达响应类型；已有事件的展示元数据 |
| `src/lib/server/work-review/agent-context.ts` | 返回原有撤回事件和日期；保留原状态计算与来源校验 |
| `src/lib/server/work-review/agent-service.ts` | 同一项目投影、旧数据事实、雷达、已批准后续来源和完整项目任务历史 |
| `src/components/work-review/work-agent-page.tsx` | 时间线与雷达展开、筛选、来源和状态展示；项目切换晚到响应保护 |
| `src/components/work-review/work-agent.module.css` | 延用现有主题变量的时间线/雷达布局与键盘焦点样式 |
| `src/lib/server/work-review/agent-test-fixture.ts` | 支持少量独立合成文本变体，用正式审核链验证撤回/重开 |
| `src/lib/server/work-review/agent-p1.test.ts` | 原两次确认断言保留，额外检查现有撤回事件的展示 |
| `src/lib/server/work-review/agent-p2.test.ts`（新增） | 三会议、旧数据、关联去重、拒绝、长历史、撤回/重开、来源/权限测试 |
| `src/app/api/work-reviews/work-agent-routes.test.ts` | 正式 API 的时间线、雷达和逐条来源校验 |
| `src/components/work-review/work-agent-page.test.tsx` | 展开/筛选/证据、加载/空/错误、跨项目晚到响应测试 |
| `e2e/fixtures/work-agent-p1.spec.ts` | 扩展现有 P1 浏览器闭环覆盖 P2；新截图名称不覆盖旧证据 |
| `UPDATE_HISTORY.md` | 只在末尾追加本轮记录 |
| 本报告（新增） | 实现与实际验收结果 |

P1 原始实现、确认一致性修复、日志期限补齐与 SSE 修复均保留。最终文件摘要对账及本轮差异包见 `output/work-agent-p2-20261029/audit-final.json`、`p2-only.diff`。

## 6. 三场会议的实际离线流程

使用 `seedWorkAgentCase` 的合成录音转写片段，经正式 repository 发布 Canonical、生成候选、用户接受、整场核对和项目关联。没有直接 INSERT 已确认关系或成功回执制造结果。

- **M1**：正式服务批准记录 A；当前决定为 A。回滚和日志问题开放；供应商等待 Todo 保留。
- **M2**：通过 P1 固定预览和批准保存暂停关系；A 为 suspended、当前决定为空，B 在历史中仍标候选。显式关联的原部署 Todo 提示核对。
- **M3**：批准 B 替代 A、修改原部署、完成测试、解决回滚、新建监控；错误供应商完成建议被现有一致性检查阻止且不选中。部署原 ID 不变，实际标题变为 B；日志与供应商等待仍保留。补充用例用确认关系关联 M3 的重复日志问题，雷达聚合为一个议题并显示覆盖两场会议。
- **恢复及失效**：正式 API 重复确认不增加 Todo 操作记录；Runtime 回执丢失恢复测试通过；浏览器刷新重开仍读出成果。M3 删除或移出项目后相关关系失效，A 不恢复，失效来源不可再作为有效引用。

## 7. 14 项业务断言

下表的 PASS 均指本轮离线业务证据。

| # | 断言 | 实际结果 |
| --- | --- | --- |
| 1 | M1→M2→M3 有序时间线 | PASS：repository、API 及浏览器检查日期和记录/暂停/替代顺序。 |
| 2 | B 在 M2 保持候选 | PASS：M1 为 A；M2 suspended/current=null，候选 B 未被提升；M3 批准后 current=B。 |
| 3 | 每次决定可查看原文 | PASS：API 逐条读取时间线来源；浏览器实际打开 M1、M2、M3 对话框并核对对应原话。 |
| 4 | 部署保留原 ID | PASS：原 Todo 更新为 B，原 sourceFindingId 保留，无第二条部署。 |
| 5 | 已完成测试退出未完成列表 | PASS：Todo 为 completed；雷达无该未完成项，历史保留已完成关联状态。 |
| 6 | 回滚问题有依据才关闭 | PASS：明确 resolves 后为 resolved；仅完成关联测试的问题仍 open；额外重开用例通过。 |
| 7 | 日志期限、供应商等待保留 | PASS：有/无持续关系均覆盖日志；供应商保持 waiting/open。 |
| 8 | 监控关联 M3 | PASS：实际新建 Todo 的 Finding 来源及雷达原文链接为 M3。 |
| 9 | 拒绝建议零业务写入 | PASS：未选/拒绝不产生关系或 Todo 更新；已拒绝建议不再标待确认。 |
| 10 | 刷新、重开、重复确认、恢复 | PASS：浏览器刷新、API 重复确认、原 Runtime 丢回执恢复均验证不重复写入。 |
| 11 | 删除、移出、关系变化失效 | PASS：来源/项目/Todo 删除和版本边界回归通过；M3 失效后显示待核实、没有恢复 A；浏览器也验证移出项目。 |
| 12 | 项目、账号、未关联会议隔离 | PASS：正式查询及 API 拒绝越界；其他项目为空；组件不显示旧项目晚到的来源。 |
| 13 | 旧事实、操作历史完整保留 | PASS：三会议前后 Finding 的 id/body/version 完全相同；Todo/关系操作历史及重复确认断言通过。 |
| 14 | 两处状态解释一致 | PASS：同一个项目响应驱动两处；暂停/替代和旧 Todo 核对、问题解决/重开、失效屏障均联合断言。 |

另有 **旧数据案例 PASS**：没有任何 Work Thread 时可展示已确认事实、候选和未闭环记录；查询前后关系表仍为 0，不生成假历史。

## 8. 测试、命令和实际失败

所有命令由 `output/work-agent-p2-20261029/run.mjs` 清除继承业务凭据，设置隔离数据目录及现有 offline 网络 Guard 后启动。日志和起止/退出码保存在同名 `.log`、`.command.json`，未覆盖失败日志。

| 验证 | 实际文件/用例 | 退出码 |
| --- | --- | --- |
| `regression`：完整受影响办公 + Runtime + SSE 集合 | 76 文件，1,656 PASS，0 FAIL/0 SKIP | 0 |
| `final-boundaries`：追加拒绝/分组等待/晚到响应后的定向回归 | 5 文件，68 PASS，0 FAIL/0 SKIP | 0 |
| `long-history`：新增完整任务历史专项 | 1 文件，1 PASS；10 个无关用例因 `-t` 未选中 | 0 |
| `p2-final`：最终三阶段与原 Finding 不变断言 | 1 文件，11 PASS，0 FAIL/0 SKIP；包含上述长历史用例 | 0 |
| `ui-final` | 1 文件，7 PASS | 0 |
| `api-final` | 1 文件，4 PASS | 0 |
| `lint-final`：Next typegen + 全量 TypeScript | 无类型错误 | 0 |
| `build`：production build + postbuild | 44/44 页面；BUILD_ID 见第 1 节 | 0 |
| `browser`：Chromium production 页面 | 1 文件，1 PASS；桌面及 390px 移动宽度，无横向溢出 | 0 |

重复范围不相加冒充独立用例总数。完整回归后新增边界以对应定向集合复验，没有无条件重复全仓测试。

实际执行命令：

```text
node output/work-agent-p2-20261029/run.mjs regression node_modules/vitest/vitest.mjs run --maxWorkers=2 src/lib/server/work-review src/components/work-review src/app/api/work-reviews src/lib/server/agent src/lib/domain/work-review.test.ts src/lib/domain/work-todo-finding-defaults.test.ts src/lib/server/openai/structured-json.test.ts src/lib/server/openai/structured-json-limits.test.ts src/lib/server/openai/structured-json-socket.test.ts
node output/work-agent-p2-20261029/run.mjs final-boundaries node_modules/vitest/vitest.mjs run --maxWorkers=2 src/lib/server/work-review/agent-p2.test.ts src/lib/server/work-review/agent-p1.test.ts src/lib/server/work-review/agent-consistency.test.ts src/app/api/work-reviews/work-agent-routes.test.ts src/components/work-review/work-agent-page.test.tsx
node output/work-agent-p2-20261029/run.mjs long-history node_modules/vitest/vitest.mjs run --maxWorkers=2 src/lib/server/work-review/agent-p2.test.ts -t "keeps approved follow-up provenance"
node output/work-agent-p2-20261029/run.mjs p2-final node_modules/vitest/vitest.mjs run --maxWorkers=2 src/lib/server/work-review/agent-p2.test.ts
node output/work-agent-p2-20261029/run.mjs ui-final node_modules/vitest/vitest.mjs run --maxWorkers=2 src/components/work-review/work-agent-page.test.tsx
node output/work-agent-p2-20261029/run.mjs api-final node_modules/vitest/vitest.mjs run --maxWorkers=2 src/app/api/work-reviews/work-agent-routes.test.ts
node output/work-agent-p2-20261029/run.mjs lint-final npm run lint
node output/work-agent-p2-20261029/run.mjs build npm run build
node output/work-agent-p2-20261029/run-browser.mjs browser
node output/work-agent-p2-20261029/audit.mjs audit-final
git diff --check
```

中间失败如实保留：

- `focused-1`：5 文件、60 PASS/1 FAIL。旧断言将两次确认视为全部事件；现在多展示原本就存在的撤回事件。保留原两次确认断言，另加撤回事件断言，未删除测试。
- `focused-2`：4 文件、36 PASS/1 FAIL。测试的文字匹配器无法跨 `<time>` 子节点匹配日期；改为通过日期元素定位真实 summary，仍检查原文、失效状态和筛选。
- `lint`：退出 1，新增 Testing Library `getByRole` 错用了 Playwright 的 `exact` 参数；修正类型后 `ui-final`、`lint-final` 和构建均通过。
- 完整回归中既有周回顾组件的 React act 警告保留，没有修改无关模块压制日志。

证据层：repository/API 测试使用真实隔离 SQLite、正式业务服务/路由和 Runtime，认证为合成账号、模型为确定性离线响应（含正式 SDK SSE 解析测试）。浏览器使用 production 组件、真实隔离 SQLite 和 Runtime，HTTP/auth 被 fixture 截获；真正 API 路由由独立测试覆盖。它不是一次真实 Provider 或真实登录验收。

## 9. 数据、历史和进程保护

- 真实 Provider 请求 **0**；原网络账本仍 **293**。账本 SHA-256 为 `a1705f33fd24fcb571c3502793ada4459a372cb10c25ebfd102cc1f7bf770d56`，本轮前后相同。
- 原 1,755 个历史证据/账本文件摘要全部相同；旧 #287 unknown、此前成绩和原业务数据未改写。只对账本的独立字节副本打开 SQLite，`integrity_check=ok`。
- 三会议测试数据库通过 `integrity_check=ok`；测试在自有临时目录完成并按既有 fixture 生命周期关闭。
- `UPDATE_HISTORY.md` 只追加，原前缀保留；SSE、Learning、共享 Runtime 和其他未纳入本轮清单的源码均与现场快照相同。
- 浏览器自有 Next 进程 PID 92072 已停止，3210 端口已释放。未访问服务器或真实用户内容；未 commit、push、merge 或部署。
- 视觉证据：`output/playwright/work-agent-p2-desktop.png`、`work-agent-p2-mobile.png`；已查看，无需改变办公视觉系统。

## 10. 已知限制与真实验收建议

- 只按显式、已确认关系识别跨会议议题和受决定影响的 Todo。不使用文本相似自动归并；缺少关系的多条日志/供应商讨论仍以各自确认记录展示。
- 当前只将与决定变化一起确认应用的 Todo 调整视为已经处理该提示。之后单独人工修改 Todo，不能仅凭修改时间证明它已符合新决定，可能仍需核对；未新增“已核实”持久状态或语义推断引擎。
- 已保存关系可保留失效历史标记；从未建立关系、后来被删除或移出项目的会议，不会为了补齐历史而恢复已删除正文或重新纳入项目。
- 项目页面读取完整项目事实，没有大规模项目性能验收。若实测出现读取延迟，再对现有查询做批量读取/分页；不能用截断事实制造“无后续记录”。模型比较仍遵循 P1 已有输入上限与覆盖说明。
- 没有新增真实模型质量证据。后续真实验收应在另行明确预算、账本和正式 Provider 授权后，验证实际建议质量、逐项确认、原 Todo 更新、时间线/雷达重开及来源失效；未知调用不得自动重试。

## 11. 交付边界

本轮交付了项目内可使用的时间线与雷达，复用 P1 同一份关系、来源、Todo 状态及确认成果；14 项断言和旧数据案例均有离线证据。到此停止，不进入 P3，不自行提交或部署。

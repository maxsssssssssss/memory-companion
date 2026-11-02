# Work Review Agent P3 实现与离线验收报告

日期：2026-10-30。范围：项目会议准备、用户编辑保存、明确关联实际会议、会后对照，以及接入原 P1 确认和 P2 状态读取。没有进入其他 Agent 或会议预约功能。

## 结论

P3 的本地产品闭环已经实现，并通过 production build 的实际浏览器流程：M1–M3 项目事实 → 生成 M4 准备 → 用户删改排序并保存 → 正式服务创建和审核 M4 → 用户关联 → 会后对照 → 用户确认 → P1 固定预览与正式批准 → Todo/关系事务落库 → 刷新、关闭重开及服务重启恢复。

证据等级为 **离线合成数据验收通过**，不是实际 Provider 或生产验收。真实 Provider、ASR、OCR 请求均为 **0**。真实模型对议程质量、复杂指代和优先级要求的遵循尚未验证。另保留一项继承自 P2 的复合 Finding 展示限制，见末节，不能据此声称所有历史自然语言表述已被自动归并。

## 1. 实际基线与差异边界

- 工作区：`C:\Users\50245\.codex\worktrees\work-review-agent-p1\daily-brief-source-20260708-122232`。
- 分支：`codex/work-review-agent-p1`；HEAD 起止均为 `0653b3f18d56c121935f50502a0dedef06ba5bcd`。
- 开始时 `git status --short` 有 42 条记录：8 条已跟踪文件修改、34 条未跟踪文件或目录记录，包含既有 P1/SSE/P2 及报告。不是干净 HEAD。
- 在修改前保存 1856 个既有文件的字节副本/摘要，记录 5714 个历史证据文件及原始真实账本摘要。基线见 [baseline.json](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p3-20261030/baseline.json)、[git-before.json](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p3-20261030/git-before.json)。
- 本轮在 11 个既有源码/测试文件上增量修改，新增 12 个源码/测试文件，另新增本报告并向 `UPDATE_HISTORY.md` 末尾追加记录。完整清单和 P3 相对开始快照的差异见 [closeout.json](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p3-20261030/closeout.json) 和 [p3-existing-only.patch](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p3-20261030/p3-existing-only.patch)。不能把当前相对 HEAD 的整个 diff 归入 P3。
- 最终构建 `BUILD_ID=w7R3X2O0EI0OsCazfCBKo`，构建成功于 2026-10-30 14:41:16（北京时间）；浏览器运行的就是此构建，所有本轮源码修改早于构建完成，没有构建后修改业务代码。

## 2. 用户可见功能

1. 项目页增加“会议准备”，用自然语言表达重点即可生成草稿；不要求填写任何内部 ID。会议详情按其明确关联的项目提供“准备本会议 / 关联会议准备”。
2. 会前简报读取当前正式决定、历史变化、当前 Todo 和未闭环提示；显示实际读取数量、裁剪范围和“没有记录不代表实际没做”的边界。候选与历史决定不自动成为当前决定。
3. 议程支持改标题、讨论重点、预期结果、增加临时项、删除及上下排序。保存后可重开、再编辑，显示版本、创建/修改时间。
4. 项目状态变化时显示过期提示；重新整理生成另一份草稿，不覆盖用户已保存版本。
5. 准备无需事先存在会议；保存后可明确关联本项目实际会议。已有会议也能作为准备入口。一份准备只接受一场明确会议，不根据标题相似度关联。
6. 已核对会议可生成“完成 / 形成正式决定 / 未解决 / 发生变化 / 本次未见讨论记录 / 证据不足”的对照及新增问题，附原文入口。这里是待确认的对照建议，不能直接修改项目事实。
7. 确认对照后进入原 P1 比较、固定修改预览、逐项选择与最终批准。P3 不自行创建或完成 Todo，不直接写决定关系；P2 继续读取原有权威状态。

## 3. 实现与数据结构

数据流：`明确项目 → 共用项目上下文 → P3 Agent Scenario → 可编辑准备文档 → 用户关联已核对会议 → 有依据的会后对照 → 用户确认 → 原 P1 任务 / 固定预览 / 批准事务 → 原 P2 时间线和雷达`。

主要实现文件（均位于本工作区）：

| 文件 | 本轮职责 |
|---|---|
| `src/lib/domain/work-preparation.ts` | 准备、议程、对照、来源及版本的产品契约 |
| `src/lib/server/work-review/preparation-context.ts` | 复用 `readWorkAgentContext` 与 P2 项目投影；组织当前决定、变化和雷达并标注覆盖范围 |
| `src/lib/server/work-review/preparation-model.ts` | 会前生成和会后对照的 schema / 产品指令，复用办公现有 JSON/SSE 调用路径 |
| `src/lib/server/work-review/preparation-service.ts` | `work.project-meeting-preparation.v1` Scenario；共用 Runtime、调用预算、Checkpoint、恢复与操作记录；确认后启动原 P1 |
| `src/lib/server/work-review/preparation-repository.ts` | 保存、编辑、版本冲突、幂等、明确关联、来源有效性、会后对照与确认 |
| `src/lib/server/work-review/preparation-schema.ts` | V11 会议准备文档及操作回执两张表 |
| `src/app/api/work-reviews/projects/[projectId]/preparations/route.ts` | 正式鉴权 API；生成、读取、编辑、关联、对照确认和任务控制 |
| `src/components/work-review/work-preparation-panel.tsx` | 真实编辑界面、保存列表、状态/失效提示、对照和 P1 交接 |

既有文件中的增量：

- `agent-context.ts` 支持无当前会议的项目上下文读取；有 meetingId 的 P1 语义保留。
- `agent-model.ts` 仅将原 JSON 请求函数导出供 P3 复用，不改 Provider 路由、SSE 策略或共享 Runtime。
- `schema.ts` 接入 V11；`project-deletion.test.ts` / `todo-repository.test.ts` 随当前 schema 更新迁移验证。
- `work-agent-page.tsx`、项目详情 route、`work-meeting-detail.tsx`、`work-projects-page.tsx` 接入口和交接；`work-agent.module.css` 补编辑样式。原页面测试隔离新的子组件，实际子组件另有独立测试和浏览器验收。

没有修改 Learning、共享 AgentRuntime、P1 写入仓库、P2 状态计算或已修复的 SSE 实现；没有新增依赖、全局开关或跨产品访问路径。

### 持久化及迁移

现有 P1 artifact 是绑定会议、固定比较与批准结果的对象，不能直接表达尚无实际会议且可被用户多次编辑的准备材料。因此沿办公 SQLite 迁移机制增加最小文档存储：

- `wr_meeting_preparations`：账号/项目、准备 ID、生成任务、目标、生成时项目指纹/来源绑定/简报、生成议程、用户当前议程、版本、状态、明确会议关联、对照和后续 P1 任务、时间戳。
- `wr_meeting_preparation_operations`：稳定操作键、输入摘要、操作类型、结果版本及关联记录，供重复请求返回原结果。

这两表是准备文档及回执，不是第二套决定、问题或 Todo 状态。当前决定/问题仍由原确认关系推导，Todo 当前状态和历史仍归原 Todo 服务。P3 对照确认和 P1 稳定任务创建处于同一事务；实际业务应用仍是 P1 原事务。

独立数据库测试验证 V10→V11 保留旧事实，以及仅在**未产生 P3 数据的测试副本**中撤回新增空表。没有对原历史验收库运行迁移；已有 P3 数据时不建议删表回退，应保留原库/备份后另行规划。

### 一致性与保护

- 编辑绑定当前版本和稳定操作键；重复请求不新增记录，内容不同的键复用被拒绝。网络失败保留前端未保存编辑与请求身份。
- 生成前后校验任务活性和项目指纹；旧任务晚到不得覆盖用户版本。已持久化成果可以恢复工具回执，unknown 不自动重发。
- 议程引用重新检查账号、项目、确认结果、当前来源以及完整项目 Todo 范围，不以有限 Prompt 窗口作为授权列表。
- 对照来源只能来自明确关联且完成核对的实际会议；完成判断复用现有有限操作一致性规则，冲突或缺少明确依据标为证据不足。正式决定必须有 final 决定；未见讨论不能推成完成。
- 来源失效后保留准备身份和用户计划、明确失效提示，清除失效生成摘要/对照，不继续展示失效原文。用户编辑内容不被新模型覆盖。源删除和项目删除通过正式服务测试。

## 4. M1–M4 实际执行

M1/M2/M3 使用现有合成案例，通过正式会议/审核/项目/Todo 服务及原 P1 确认形成前置状态：A → 暂停 A（B 候选）→ 正式 B 替代 A；原部署 Todo 改成 B、测试完成、回滚问题解决、监控待办建立；日志期限与供应商等待保留。

运行环境为独立的 `output/work-agent-p3-20261030/data/`，假凭据、隔离环境和网络 Guard；只允许本地页面流量，模型 SDK 的请求由确定性离线 SSE 响应接管。不是实际 Provider 响应，也未直接 SQL 插入业务成功结果。

浏览器实际步骤：

1. 正常登录合成账号并进入项目；输入“帮我准备一下这个项目下一次会议，重点看看还剩什么没处理，以及需要确认哪些事情。”；只生成一次准备。
2. 简报读取 **3/3 会议、14/14 已确认 Findings、4/4 Todo、3/3 议题**；B 为当前正式决定。打开 M3 原文核对。
3. 删除“客户约束清单”，把“日志保留期限”移到首项，改讨论重点为“确定日志保留期限和责任人，保留用户编辑”，新增“临时支持交接”；正式 UI 保存为版本 2。
4. 正式服务创建、核对并关联项目 M4：部署完成、日志期限确定 30 天、供应商仍未回复、监控完成、新增“告警升级阈值”下周继续。刷新旧准备出现过期提示，用户编辑仍在。
5. 用户从项目内会议列表选择 M4 并确认关联，版本 3；生成一次会后对照。读取 **4/4 会议、19/19 Findings**。
6. 对照五项分别为：日志期限正式决定、部署完成、供应商未解决、监控完成、临时支持未见讨论记录；新增告警升级阈值问题。逐项打开了 5 处 M4 引用。
7. 用户确认对照，版本 4；原 P1 生成三项固定预览。逐项选择，再通过正式确认对话框批准：完成原部署 Todo、完成监控 Todo、关闭日志期限问题。
8. 正式 API/SQLite 核对：Todo 总数仍为 4；原部署 ID 不变、标题仍为 B 且 completed；测试 completed；监控 completed，来源仍为 M3 原始行动；供应商 open/waiting。日志和回滚议题 resolved，新增告警问题 unresolved。没有给临时议题或供应商写完成结果。
9. 同一原始批准请求重复两次返回 `202/202`；刷新、关闭原标签页重开、停止并重启同一 production 服务，完整项目/准备 API JSON 均与批准后结果一致，离线模型请求始终 9 次，无新增调用。
10. 保存正向证据后，以正式 API 依次将 M4、M3 移出项目作负向验收。M4 不再可用、对照失效；M3 失效后自动生成的依赖内容被遮蔽，原用户文字保留，决定状态 unknown，A 没有恢复为当前方案。该合成库最终停留在此负向验收状态，正向结果保存在 JSON/截图中。

证据：[浏览器业务与数据库断言](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p3-20261030/browser-audit.json)、[失效断言](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p3-20261030/browser-invalidation.json)、[正向完整 API](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p3-20261030/applied-api.json)、[实际批准请求](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/playwright/work-agent-p3-20261030/approval-request.txt)、[引用核对](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/playwright/work-agent-p3-20261030/sources-reviewed-result.txt)、[桌面截图](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/playwright/work-agent-p3-20261030/desktop.png)、[窄屏截图](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/playwright/work-agent-p3-20261030/mobile.png)。

## 5. 必须断言逐项结果

| 断言 | 实际结果与证据范围 |
|---|---|
| 会前简报读取当前项目状态 | PASS：正式 repository / API 与 production 浏览器均读取三场历史、当前 Todo 及 P2；不是只读最近会议 |
| B 当前正式决定，不显示 A 为当前 | PASS：上下文、页面与原文核对；来源移出后 unknown，不恢复 A |
| 未完成、等待及未解决事项 | PASS：部署/监控未完成，日志未解决，供应商等待；完成测试不作为未完成工作。复合 Finding 限制单列在末节 |
| 用户议程保存及重开 | PASS：删除、排序、修改重点、增加临时项，实际 UI 保存版本 2，后续版本 4仍保留 |
| 模型不覆盖已保存版本 | PASS：重新生成另建草稿的 repository 测试；浏览器 M4 状态变化不会覆盖原议程 |
| 新会议关联旧准备 | PASS：准备生成时没有 M4；正式服务随后创建核对，UI 明确关联 |
| 错误项目/未关联会议不能进入 | PASS：正式 repository/API 账号项目隔离测试；浏览器解除关联后失效 |
| 完成、未解决、变化、未讨论 | PASS：浏览器完成/正式决定/未解决/未讨论及新增问题；独立 changed 和证据不足由 repository/API 测试覆盖 |
| 未讨论不自动完成 | PASS：临时支持议题显示未见讨论，未写 Todo 或关系；负向测试同样验证 |
| P1/P2 关系、Todo、时间线一致 | PASS（对象身份范围）：原部署 ID 保留，完成和关闭经 P1；P2 从相同已保存事实更新，没有 P3 直接状态写入。未声称自动拆分复合 Finding |
| 刷新、重复确认、重启幂等 | PASS：同批准请求两次202，重开/重启数据等同，1份准备、3条准备操作回执、4条Todo不增加；回执丢失和事务失败有定向测试 |
| 来源删除/移出项目失效 | PASS：浏览器移出 M4/M3，repository 正式删除与项目删除；不展示无效依据、不复活旧决定 |
| 账号和项目隔离 | PASS：正式 API/repository 拒绝其他账号/项目及无明确关联的会议；范围不扩展其他产品数据 |

## 6. 验证命令与真实结果

下列命令均在本工作区执行，测试为离线环境。日志保留在 `output/work-agent-p3-20261030/`。

| 命令 | 文件 / 用例 | 退出码及结果 |
|---|---:|---|
| `npm test -- src/lib/server/work-review/preparation.test.ts src/app/api/work-reviews/work-preparation-routes.test.ts src/components/work-review/work-preparation-panel.test.tsx` | 3 / 18 | 0，全通过；`tests-p3-final.log` |
| `npm test -- src/lib/server/work-review src/app/api/work-reviews src/components/work-review src/lib/server/agent src/lib/server/openai/structured-json-limits.test.ts src/lib/server/openai/structured-json-socket.test.ts --maxWorkers=2` | 77 / 1603 | 0，全通过；受影响完整集合，含 P1/P2、权限、来源、幂等、共享运行时及 SSE 相邻回归；`tests-work-regression.log` |
| `npm run lint`（含 Next typegen + 完整 TypeScript） | 不适用 | 0；`lint-final.log`，不重复单独 tsc |
| `node output/work-agent-p3-20261030/run.mjs build` | 44 个页面 | 0；隔离环境运行 `node node_modules/next/dist/bin/next build`，`build-runtime.json` |
| `node scripts/sanitize-next-traces.mjs` | 183 manifests | 0；removed=42，forbidden=0，`postbuild.log` |
| `node output/work-agent-p3-20261030/run.mjs seed` / `m4` | 合成案例 | 均0；正式业务服务建立前置状态和 M4，日志及 runtime.json 保留 |
| `node …/@playwright/cli/playwright-cli.js -s=wrp3-20261030 …` | 1条完整生产浏览器流程，非 Vitest 用例数 | UI 生成、编辑、关联、对照、批准、重开与失效；步骤输出见 `output/playwright/work-agent-p3-20261030/` |
| `node output/work-agent-p3-20261030/browser-audit.mjs` | 浏览器/API/实际SQLite交叉断言 | 0，PASS；正向审核在负向移出来源前执行 |
| `node output/work-agent-p3-20261030/closeout.mjs` | 数据/构建/端口/保护核对 | 0；4个合成SQLite integrity=ok、foreign_key_check空；历史摘要不变 |
| `git diff --check` | 当前工作区 | 0；不提交 |

没有重跑与本阶段无关的全仓业务测试；没有用零测试、跳过断言或放宽共享契约制造通过。新增 18 个用例属于最终 1603 个的子集，不能相加重复统计。

### 中间失败与修复

- 首次测试在加载配置时 `spawn EPERM`，退出1、未执行测试；在获准的本地执行环境运行后才产生有效测试结果。
- 首轮新仓库测试 1文件11例中 8失败/3通过：新工具使用 handoff 但缺少 Runtime 要求的 `validateResult`。补齐产品工具结果核对，没有改 Runtime 门槛。
- 次轮 3文件16例中 1失败/15通过：用户新增议题没有对应生成议题，对 undefined 做 hash。改成明确 null 比较，保留新增议题测试。
- 定向复验 1失败/10未选中：后续任务 ID 包含共享 AgentStore 不允许的下划线。仅改 P3 稳定任务 ID 格式，未放宽 store 校验。
- 最终上述故障均在 18例和1603例集合通过后收口。原失败日志完整保留。
- 辅助工具问题另记录：baseline Node 内 spawn git EPERM 改为 PowerShell 获取 Git 元数据；离线 npx 缓存缺失，改用已安装的 Playwright CLI，无下载；最初 `/login` 路径404，改走现有正式登录入口；初次辅助读取把 status 字符串误当数组、Windows rg 路径通配符用法错误，改为实际类型和 `-g`，没有影响产品测试或数据。原错误没有删掉。
- 两次自有服务停止返回 Windows 终止退出码1，均是明确发出 stop 信号后退出，非业务崩溃；已另核对进程不存在和端口释放。最终重开页面 console：0 errors / 0 warnings；初始未登录401/错误导航404不计为登录后的功能成功。

## 7. 保护结果与已知限制

- 未新建 worktree、切分支、reset、stash、clean；未提交、推送、合并、部署或访问生产。
- 5714 个原历史证据文件摘要全部不变；原账本文件 SHA-256 与开始一致，原 #287 unknown 和历史成绩未被打开修改或追认。**本轮真实调用0**，浏览器的9次是合成 SSE，记录的123/45 token也是 fixture，不是真实用量。
- 已有 P1/SSE/P2 修改保留；UPDATE_HISTORY 原始字节前缀不变，仅末尾追加。旧报告未覆盖。
- 本任务 production 服务与浏览器已停止，37953端口释放；4个本任务合成数据库完整性和外键检查通过。
- **继承限制**：M3 中“仍待处理的事项”是包含日志、供应商、客户清单的复合 Finding，没有与独立日志议题建立确认身份。M4 关闭独立日志议题后，这条旧复合记录仍在 P2 标为“尚无解决关系”，其原文仍包含当时“日志未解决”的描述。本轮没有凭文字相似替用户关闭整条记录，也没有自动拆分/伪造历史关系。独立日志状态已正确 resolved；需人工理解这是旧会议记录，并在后续按明确关联处理复合来源。它是既有事实粒度/展示限制，不应把该原文当作新的日志当前状态。
- 对照的语义校验采用明确来源身份和已有有限完成规则，不是通用语义证明器。复杂指代、混合主题、用户“只要三项/只看风险”等自然语言要求的真实模型效果 **NOT RUN**；仍需另行授权的有界 Provider 验收。
- 只保存当前用户版本和操作回执，没有历史议程版本回滚界面；重新整理不覆盖旧准备。不支持一份准备拆分多场会议、自动邀请/通知/预约或后台扫描。
- 来源被删除/移出后，生成内容在正式读取时失效清理，保留用户计划与必要身份；没有新增后台清理机制。

建议后续真实验收仅用新的独立合成库，先核对当前构建与实际账本，确认本轮新增调用预算后执行一条 M4 用户流程。重点检查议程是否遵循目标、引用是否支持对照、未讨论是否被误判完成，以及复合来源的可理解性；不重试历史 unknown，不用离线通过代替真实结果。

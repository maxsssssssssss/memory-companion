# 约会陪伴 Agent P0＋P1 实现报告

日期：2026-11-05（Asia/Shanghai）。交付范围：本地实现与离线验收；真实 Provider、生产环境均未访问。

## 用户现在可以做什么

- 从约会空间「准备」直接说话。全新账号没有录音、没有历史时，也能直接开始，不必先建任务、填写日期或选择人物。
- 在同一段讨论里聊相处疑问、找过去的记录、准备见面，再回来反馈。重开默认恢复最近更新的讨论，其他讨论可以从“聊过的”找回；已保存的选择、原始反馈和对话保持不变。
- 需要历史时打开「资料范围」，为本次讨论选择已确认记录；不选资料也能继续。这个动作不会开启长期记忆。
- 助手按需检索并读取原话，通过「看看来源」核对日期、原话和原记录。找不到也能继续讨论。
- 可选准备最多三条，可以「改一下」「留下这条」或「这条先不留」。留下后展示紧凑的「这次想记得的事」。明确且对象唯一的“这条留下”会真正保存；模糊肯定不会自动选用。
- 用「回来记一下」或自然文字反馈后来发生的事。反馈是用户转述，新的建议仍等待选择；不会把准备变成 Promise、Memory、Person 事实或办公 Todo。
- 可以撤回资料、纠正理解、暂停或删除讨论。新决定优先，晚到生成不会覆盖它。已提交到服务端的输入在生成前保存；网络失败时当前页面保留草稿与原幂等请求，重新读取不清空草稿，不自动重发未知请求。未发送草稿不保证关闭后恢复。

## 基线与 P0 判断

目标提交严格采用 `ae329e9c45a7eca7e8b4eb09dd83934cfbdb27be`。原目录 `C:\Codex\daily-brief-source-20260708-122232` 的 HEAD 实为 `dd3e131`，存在大量既有 dirty，包括另一产品和共享 Runtime 未提交内容，因此没有在原目录实现、回退或覆盖。

本轮工作区：`C:\Users\50245\.codex\worktrees\date-companion-agent-p1\daily-brief-source-20260708-122232`，从指定提交创建的 managed worktree，detached HEAD。复用现有本地 node_modules，没有新增依赖。未提交、推送、部署；原目录数据、历史证据和调用账本未操作。

实际读取 AGENTS.md、PRODUCT.md、DESIGN.md、docs/validation-tools.md，并沿准备页/Shell/session → relationship/recap → search/QA canonical context → Promise/Person source catalog → Memory bridge → AgentRuntime/AgentStore/model 调用链核对：

1. 当前约会空间只有唯一 Ta；复用已有 `createOrGetRelationship`，没有新增人物选择或全局空间。
2. 已确认、kept、未明确删除、说话人已确认且 provenance digest 有效的复盘可以按次授权使用，不以长期 Memory 准入为前提。
3. 原关系搜索 API 已收窄到合法 Person 来源，不能冒充临时复盘授权。新适配使用既有 repository.search 与 relationship QA canonical allowlist，再交集本次 interaction 范围。
4. 长期资料读取复用 Person catalog、publication/receipt/revocation 和现有 retained context 的合法性检查，不调用首页旧生成器，不把缓存或旧助手输出当事实。
5. 长期设置初始 `enabled=true/version=0` 不能推断明确授权；复盘 UI 的“这次也整理进长期记忆”原为独立且初始未选。本次范围默认空，长期资料读取还需显式选择，既有准入仍是最终门槛。
6. 准备页原来会激活首页 proactive 生成。新准备入口排除了该路径，每次模型调用只经过共享 Runtime 的 `ctx.call` 和调用账本。

## 实现与业务边界

新增 `src/lib/domain/date-companion-preparation.ts`，`src/lib/server/date-companion/preparation-{repository,sources,agent,service}.ts`，`src/app/api/date-companion/preparations/`，`src/lib/client/date-companion-preparation-api.ts`，`src/components/date-companion/companion-preparation.{tsx,module.css}` 及定向测试；集成修改现有 Shell、首页轻入口与样式。schema 由 12 增至 13。

约会 SQLite 只新增 `dc_preparations`（本次准备聚合，含完整 messages/events/items、日期/约束与来源关联）和 `dc_preparation_operations`（账号内幂等收据）。现有录音对象无法表达无录音讨论、反馈及选择恢复，因此需要这个独立业务对象；它不承担 Promise、Person 或长期 Memory authority。没有新增 production dependency、全局 feature flag、执行平台或 Memory 系统。

输入与反馈先事务保存再生成；服务端生成条目 ID；普通 PATCH 完成选择、编辑、撤回和暂停。业务版本、generationId、Runtime lease/version 与幂等 operationKey 共同阻止重复写与晚到覆盖。删除清除该讨论正文，保留调用用量账本，原相处记录不受影响。

场景 `date_companion_preparation_v1` 提供 `search_records`、`read_source`、`query_promises`、`person_sources`、`read_progress`、`respond`。搜索/目录只返回定位信息，原话必须另行读取；引用验证真实 ID 与 fingerprint。运行收据只存 ID/指纹，不把原话编码进 resultRef。完整进展落库，模型只取有限当前窗口，必要时通过 `read_progress` 分页读取更早进展。

模型沿用约会产品 TokenHub `deepseek-v4-pro`、既有 endpoint/raw Authorization 规则。每轮最多 8 次记账调用、10 steps、180 秒计算预算；SDK 不做隐藏重试。这里的固定预算是首版资源上限，达到上限保留输入并明确本轮未完成；后续只有真实有预算验收证明合法常见任务持续撞上限时再调整，未提前另建编排层。

自然讨论 UI 使用现有约会 tokens、ProductDialog、ProductEvidence。消息内部滚动，输入区持续可见；上翻不被新消息拉回；visualViewport 与安全区处理手机可见区域。历史、资料范围和删除按需展开，页面不展示工具轨迹、意图分析、版本或预算。

## 实际验证

模型传输由 `scripts/date-companion-agent-fixture.cjs` 替代；正式页面、API、service、SQLite、共享 Runtime、SDK parser 和 ledger 均实际运行。沿用项目网络 guard，测试只允许本机 loopback。

| 检查 | 实际结果 |
| --- | --- |
| `npm test -- src/lib/server/date-companion/preparation-agent.test.ts src/lib/server/date-companion/preparation-sources.test.ts src/lib/server/date-companion/schema.test.ts src/app/api/date-companion/preparations/routes.test.ts` | 4 文件 / 21 用例 PASS，exit 0；日志 `output/date-companion-agent-p1/backend-tests.log` |
| `npm test -- src/lib/server/date-companion/preparation-sources.test.ts src/lib/server/date-companion/relationship-qa.test.ts src/lib/server/date-companion/person-source-catalog.test.ts src/lib/server/date-companion/proactive-value-context.test.ts` | 4 文件 / 37 用例 PASS，exit 0 |
| 最终来源与 Agent 联合复验（上述两准备测试文件） | 2 文件 / 15 用例 PASS，exit 0；补测旧原话存入 constraints 后撤回，后续完整模型输入没有旧摘录 |
| `npm test -- src/components/date-companion/companion-preparation.test.tsx src/components/date-companion/date-companion-shell.test.tsx` | 2 文件 / 39 用例 PASS，exit 0；首次无录音、请求恢复、晚到加载覆盖防护与上翻保留 |
| `npm test -- src/components/date-companion/companion-home.test.tsx` | 1 文件 / 12 用例 PASS（在首次 UI+Shell+Home 组合命令中执行），exit 0 |
| `npm run lint` | 修复类型后 exit 0，日志 `output/date-companion-agent-p1/backend-final-lint.log`；随后最终 metadata 变动由最终 build 的类型检查再次覆盖 |
| `git diff --check` | exit 0 |
| `node scripts/run-date-companion-agent-p1.mjs` 最终生产构建 | `2026-11-05T03-42-50-868Z` 的 buildExit=0；Next 编译、完整类型检查、46/46 静态页面和既有 postbuild 完成；trace 清理 `manifests=188 removed=447 forbidden=0` |
| `node scripts/run-date-companion-agent-p1.mjs --reuse-build` | 复用上述成功且产品源码未变的 `.next`，3/3 浏览器流程 PASS，exit 0，7.5 秒；证据 `output/date-companion-agent-p1/2026-11-05T03-46-14-859Z/` |

以上运行之间有重叠用例，不相加为独立测试总数。仅运行受影响及必要相邻测试，没有全仓测试。

开发模式三核心浏览器流程：3/3 PASS，证据 `output/date-companion-agent-p1/2026-11-05T03-30-42-186Z/`。第一次运行 `2026-11-05T03-26-18-203Z/` 第 1 条通过、第 2 条发现旧加载响应覆盖新讨论，第 3 条未运行；修复 request epoch fencing 后复验通过，失败证据保留。

其他真实失败与修复：来源测试首次受 sandbox `spawn EPERM` 阻止启动，获准本地执行后通过；schema 测试新增版本的旧硬编码断言失败后修复；类型检查发现 fixture 模型 literal 和新增 API/闭包可空类型问题，按实际 contract 修正，没有放松 schema。

第一次 production build（`2026-11-05T03-36-03-051Z`）webpack 编译成功，TypeScript 因事务闭包未保持收窄类型而失败，exit 1，postbuild 和浏览器未执行。修正后复验属于这次实际失败的收口。一次后续命令在自动权限审批阶段超时、未启动；按返回指引重试后正常启动。所有失败目录保留。

成功构建后的第一次 browser run 因新增测试把 fixture 种子复盘已有的 bridge outbox 事件错误要求为零而失败（该构建仍为 PASS）。已改为比较 Agent 使用前后不增加，没有修改产品逻辑或重新构建。最终同时检查实际 Memory/Person 零写入与办公数据库未创建，没有用 outbox 比较替代这些检查。

三条最终浏览器流程：

1. 有历史连续使用：正式 repo 创建独立合成已确认记录；页面按次选择后 Runtime 真正执行 search_records → read_source，再生成待选建议。页面选用、关闭重开、保存文字反馈、看到变化后的帮助且新建议未自动选用。正式 API/SQLite 读回验证。
2. 无历史与只讨论：新增全新账号从约会首页直接聊天；另一次讨论明确不用历史、连续长对话与暂停。390×844、390×480 无横向溢出，发送区域在视口内。组件测试补充用户上翻时晚到消息不跳底。
3. 纠正撤回：页面撤回资料，保存纠正表达，检查后续实际模型传输输入不含旧原话，已选准备仍保留，重开后纠正仍在。

最终隔离 SQLite 只包含 3 个准备对象、12 条成功的 `agent_decision` 合成调用账本（model 标识沿用 deepseek-v4-pro）、1 次 search_records、1 次 read_source、10 次 respond。Promise=0、Memory items=0、Person facts=0，`work-review.sqlite` 不存在。模型传输全部由本地 fixture 返回；网络 guard 与浏览器 loopback 限制在运行中生效，真实 Provider 请求为 0。本次拥有的服务已退出，构建/浏览器使用端口 13065、13422 最终无监听。

## 已知限制与未验证事项

- 真实 LLM/ASR/Provider 调用：0；真实语义质量 `NOT RUN`，需要后续独立有预算验收。fixture 回复只证明工具接线、持久化、权限和产品操作闭环，不能证明真实模型一直自然或准确。
- 生产、服务器、远程运行环境：`NOT RUN`。未发布。
- 真机软键盘：`NOT RUN`。浏览器移动视口和缩短可见高度是模拟证据，不是真机认证。
- 录音复盘完整对照属于 P2，本轮只读取获准已有记录；没有订位、自动发消息、后台提醒、多人管理、关系评分或诊断。
- 长期 user_reflection 来源沿用现有 resolver 的近期 24 条/人物 Memory 查询上限 200；临时已确认复盘与 direct catalog 不依赖该近期转述窗口。遇到用户明确需要更早长期转述且当前 resolver 未返回时，应说明查不到，再按实测需求扩展现有检索，不能假称全量覆盖。
- 当前权威是持久化业务状态，助手自然语言表达仍需真实模型语义验收；来源合法性、选用写入、幂等与取消由服务端校验。

## 页面截图

下列均为最终生产构建的本地真实页面、合成数据，已实际查看。截图不代表真实模型语义质量。

默认入口，无任务表单与内部状态面板：

![默认自然对话入口](C:/Users/50245/.codex/worktrees/date-companion-agent-p1/daily-brief-source-20260708-122232/output/date-companion-agent-p1/2026-11-05T03-46-14-859Z/01-default-desktop.png)

反馈后的帮助发生变化，已选内容与新的可选建议分开：

![反馈与可选准备](C:/Users/50245/.codex/worktrees/date-companion-agent-p1/daily-brief-source-20260708-122232/output/date-companion-agent-p1/2026-11-05T03-46-14-859Z/03-feedback-desktop.png)

手机长对话内部滚动，输入区持续可见：

![手机长对话](C:/Users/50245/.codex/worktrees/date-companion-agent-p1/daily-brief-source-20260708-122232/output/date-companion-agent-p1/2026-11-05T03-46-14-859Z/04-mobile-long-chat.png)

缩短可见高度后的发送区域（视口模拟，非真机软键盘）：

![手机缩短视口](C:/Users/50245/.codex/worktrees/date-companion-agent-p1/daily-brief-source-20260708-122232/output/date-companion-agent-p1/2026-11-05T03-46-14-859Z/05-mobile-compact-viewport.png)

`02-selected-source.png` 另保存选用与来源入口状态，但展开原话位于记事区内部滚动中，截图存在裁切，不以该图宣称完整原话可读；浏览器测试实际展开并核对了原话文字。

本轮 P0＋P1 本地实现和离线验收完成，停止扩展，等待用户检查。

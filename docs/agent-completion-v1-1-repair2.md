# Learning Agent V1.1：R1–R3 集中返修交接

基线：`b7d8fcc1ada69ffe5c76402cd9f5fe5d823aceee`。分支：`feat/learning-agent-completion-v1-1`。本轮仅处理 Windows 第二份整包确认的解释反馈、目标来源关联与预算分类问题。Windows 对该基线的结论仍是 **BLOCKED**；本交付的真实 DS 验收 **PENDING**。早前 F1/F2/F3 的实现、严格行动协议及工程证据保留，但不能代替这轮真实验收。

## 证据身份

新 ZIP SHA-256：`7bafbbb2e318ee9d1f1c96c33789f34539f05d0a4435ee5a1aaa8ebedfeb7472`。138 个文件，其中 `FILES_SHA256.json` 列出 137 项，大小与哈希全部匹配；独立上传的 REPORT 与 ZIP 内字节一致。已读取 REPORT、business-evidence、provider-accounting、independent-semantic-review、portable-repro-README、w2-budget-state-diagnostic。

原样 W1 脚本在修改前以独立副本运行，8 项断言、exit 0、fetch 0，结论为 `REPRODUCED_CURRENT_BLOCKER`：原错误关联仍返回 409，当时没有解释 technicalBlocker。脚本会写相邻结果，因此没有在原附件目录执行，没有覆盖 Windows 结果。

新包是公开业务投影，包含原计划、解释、两题完整保存内容、稳定选项及理由、来源和模拟学生操作；**不包含 W3 原 raw codec envelope、原逐题关联 rationale 或完整 Windows 数据库**。新增回放明确使用保存内容合同及标明的离线关联元数据，不冒充缺失的响应/原库。旧 129 文件完整 W2 包仍在 Cloud；另外执行原正式回放，不把新包公开投影当成 129 原库回放。

## 集中修复

| 问题 | 改动 | 保持的限制 |
|---|---|---|
| R1 原明确解决 409 | 反馈 validator 与 assessment 共用当前解释、purpose、版本及来源关联校验。错误关联仍 409，同时展示解释 technicalBlocker，隐藏不可用的确认按钮，进入现有明确调整流程。 | 不修改原计划/解释，不接受旧版本解释。普通“谢谢”仍不是解决。新版本合法解释收到明确确认后零额外模型结束。 |
| R2 未见原文便绑定段号 | 未建立计划时 observation 提供当前授权的完整原文段落（有界），正式建计划工具仅接受该上下文中可用或当前版本成功 read_source 回读的来源。explain 在预留/生成前检查所选来源与每个目的目标的来源相交。 | 看到、回读、存在或相交都不是语义蕴含证明；DS 仍负责目标及来源意义判断。没有新增关键词/数学/语义判断引擎。 |
| R2 调整后再次猜错来源 | 既有“调整本轮复习”增加可选“保持目标与检查要求，仅核对来源关联”。展示授权原文，逐目标明确选择并预览；提交只更正来源，原目标、目标 ID、类型和 requirements 不变。 | 不默认选全部，不自动扩大范围。用户可继续使用原普通目标/范围调整。重新使用旧作答仍须明确历史授权、实际读回及关联。 |
| R3 本地预算误报 unknown | 预算门禁的已知未发出拒绝直接停止，不关联前一成功行动；存在实际未决调用或行动时才保留 unknown。旧精确可证明的误标只在读取投影纠正，原行不改写。 | 16/16 不因调整重置；真正 unknown 不重发、不宣称成功。 |
| R3 虚构总结未知请求 | 专项归纳未确认文案仅依据当前版本确实存在的 reserved/unknown 总结 artifact。 | 任务级 unknown 不证明总结请求存在；无调用/无artifact不能显示请求失败或未确认。 |

### 来源更正的持久化与权限

- 新版仍由原 `AgentStore.adjust` 产生，使用原 eventId 去重、expectedVersion 防并发覆盖；累计调用、Token 与计算量不重置。旧事件不能推进新版本。
- 来源更正只接受原计划全部目标的来源列表，不接受新的目标文本/降低要求。来源必须属于用户实际可预览的原文、同时仍在新授权范围中；源 hash、账号与页面照常复查。
- `LearningAgentScope.planSourceAdjustment` 保存用户确认的旧 plan ID/hash/version、来源引用和固定原因 `user_confirmed_sources`，不复制原文。它是现有版本化授权快照中的恢复依据；归一化计划仍保存在现有 `learning_agent_artifacts`，不增加第二评分权威。
- 新版本的本地计划写入不消耗模型请求；提交后、observe 和工具前按同一恢复依据幂等完成。写入前检查任务活动状态/版本，取消或再次调整后不能补写旧执行点。崩溃恢复不重新付费建计划。
- 原计划、讲解、题组和成绩保留。按照原调整合同，旧 action args/reason 和 event 正文会被清理以防撤权绕过；不能声称全部旧行字节不变。
- 不自动把旧解释复制成新解释或继承旧确认。解释任务在新版本形成合法的当前讲解后再明确确认。旧 Quiz 则按显式历史权限重读及重新关联，提示、错误、争议等事实不变。
- 计划原文上下文上限为 10,000 字符、60 个完整段落；用户更正预览上限为 20,000 字符、60 段。没有截断段落冒充全文。省略内容由 read_source 获取，或先明确缩小范围；预览不提供无限全材料扫描。历史读取收据只证明曾读取，不保证模型每次决策保有全部旧正文。

## 数据、接口和兼容

没有新增依赖、数据库表或 SQL 列迁移，锁文件不变。新增内容是 Learning 专属来源服务、现有任务授权 JSON 中经过 schema 校验的更正快照、既有 PATCH adjust 的可选 `sourceCorrections`、任务 GET 的可选 `sourceAdjustment`。GET 只读/投影、零模型；来源删除或授权失效不返回原文预览。

共享层只修正实际预算失败分类和旧误标的精确投影，不导入 Learning 类型。`structured_action_v1`、正式 Prompt、工具严格 Zod、F1 脱敏诊断、F2 完整参数合同、审批与稳定选项保护不变。旧任务没有新增字段时继续原合同；新字段不能授权跨页或跨产品。

## 离线原证据与回归

新包解压到独立目录后：

```powershell
node --require ./scripts/cloud/offline.cjs --import tsx scripts/agent-trial/completion-repair2-replay.ts --evidence-dir output/learning-completion-repair2/windows-evidence --output-dir output/learning-completion-repair2/public-replay
node --require ./scripts/cloud/offline.cjs --import tsx scripts/agent-trial/completion-repair-replay.ts --evidence-dir output/agent-v1-1-windows-final-20261016 --output-dir output/learning-completion-repair2/old-w2-final
```

证据目录参数可替换为实际解压目录，输出必须在原证据目录外。第一条 23 项检查包括：W1 原错误关联保留；W3 原题正式保存、原稳定 ID 提示/选择/交卷后仍为 1/2、hinted 1、unassisted 0；原来源错配安全交回；随后在独立本地任务中正式 adjust v2、授权历史、回读并关联同一原作答后，技术阻塞解除，提示答对仍非独立、真实错误仍是反证，不能通过，可进行针对性解释，不新增题组。

这段 W3 正向恢复使用本地新任务账本（0），不是复制或重置原 Windows 任务用量，不宣称 Windows 原任务已恢复。原包全部字节保持不变。

第二条是原 129 文件完整 W2 回放，16 项检查：原完整快照仍 partial，原第三组 pending；生成前时序使用既有只读原 artifact 投影，不能把 pending 当作初始错配根因，不修改旧评估制造通过。

集中测试包含 F1/F2/F3、C01–C10、解释原负例/服务正例、API/UI 来源调整、提示/错误重关联、prepared/unknown、预算/版本/撤权/重复并发、答案隐藏、稳定 ID、手动 Quiz 与旧历史兼容。 本轮最终集中运行 **59 文件 / 1096 用例，exit 0**；完整 `cloud:check`（9 环境合同 + 项目 lint/Next typegen/TypeScript）**exit 0**，`cloud:build` **exit 0**（编译 84 秒，180 trace manifests、forbidden 0）。最终实际文件/用例数及命令退出码记录在同目录 `verification-matrix.json`、`tests-command-result.json` 和交付报告，不累加重叠定向复验。

```bash
npm run cloud:check
npm run cloud:build
```

`cloud:check` 已包含完整项目 lint（Next typegen + TypeScript），不另跑重复检查。相关精确测试清单见下方；Windows 可把 `npm run cloud:test --` 换成 `npm test --` 运行相同集合。

## 浏览器、重启与失败记录

受影响 production 浏览器流程 **11 项 PASS**（停机前 6、重启后 5，各 exit 0），使用正式 API、SQLite/checkpoint、原 UI 和明确标记的离线响应：原错误解释仍 409 → 预览原文并明确更正来源进入 v2 → 正式服务保存新的合法解释 → 正常停机/重启后仍等待 → 明确“疑问已解决”零额外调用结束，没有创建 Quiz。刷新、重登不增加调用；原计划/解释保留，仅一条确认，3 个 SQLite 完整性检查通过。

浏览器使用新的 Cloud 合成目录，不重建 Windows 历史。5 次离线 Provider 响应（4 决策、1 解释）及另外 3 次明确标记的旧状态 fixture 决策分别记账，真实 Provider 请求 0。统一 launcher 两次正常 stop 均 exit 0，自有进程全部停止，合成数据保留。此 Linux 退出证据不改写原 Windows taskkill 子进程 exit 1。

完整命令、截图和结果见交付证据 `browser/browser-command-results.json`。首轮新脚本的精确标签定位失败 exit 1；调整为表单中唯一文本域定位后，同一任务原断言复验通过，没有修改产品或重新 seed。开发期还修正了新测试的 createdAt 缺失（首次类型检查 exit 1）、错误方法名，以及对 JSON undefined、未提交 score=null、计算耗时与本地结束步骤的错误预期。原安全断言未降低；失败记录保留。最终相关测试、类型、构建与浏览器均通过；无关扩展全仓回归 **NOT RUN**。

### 集中验证矩阵

| 范围 | 本轮依据 | 结论 |
|---|---|---|
| R1 原错误反馈、technicalBlocker、明确新版本解决 | 原样修改前脚本 8 项；修后公开证据回放、completion/API/UI、浏览器 | 原负例仍拒绝；合法新解释确认零额外调用结束 |
| R2 原 W3 题目/提示/错误与来源恢复 | 23 项回放及 API；原稳定 ID、原选项理由、正式事件/交卷 | 1/2、提示后正确 1、无辅助正确 0 保持；来源更正不消除错答反证 |
| R2 原完整 W2 时序 | 129 文件完整包、正式 assessor 回放 16 项 | 技术问题独立识别；第三组 pending 及原成绩保留 |
| R3 known budget / true unknown / 总结 | runtime 59、summary 33（均已含在最终 1096 内） | 未发出预算拒绝不造 unknown；真正未决不重发、不造总结调用 |
| C01–C03 已有支持、覆盖缺口、提示 | completion/API/completion-flow | 足够时停止；未覆盖/提示不冒充独立通过 |
| C04–C06 重复订正、边界错误、争议/已知错题/撤权 | completion、Quiz、source-binding、API | 保留反证、排除无效证据；原成绩不改写 |
| C07–C10 无进展、明确解释反馈、过早结束、足够后仍出题 | completion、runtime、正式场景/API | 不能用新 ID 造进展；模型不能越过事实检查 |
| prepared、重启、重复/并发、版本/来源晚到 | runtime、agent-a2、agent-routes、source 服务/API、浏览器 | 本地来源计划写入可恢复；取消/再次调整阻止旧写入；预算不重置 |
| F1/F2/F3 与共享协议、答案/稳定 ID、旧 Quiz | diagnostics/model/plan-contract、structured-json、Quiz/API/UI | 相邻回归通过；不推断缺失真实响应的准确拒绝字段 |

上述分组会覆盖同一测试，不能相加为新的用例总数。最终唯一集中测试口径为 59 文件 / 1096 用例。

## Windows 定向接回：不重开账本

1. 停止原自有服务并备份当前整个隔离数据目录、SQLite/WAL/checkpoint/账本和证据。检出报告提供的完整新 SHA，按既有锁文件安装；沿用既有配置和 `AGENT_TRIAL_DIR`，**不要对原 Windows 数据重新 seed**。无新凭据、无新 Provider、无新环境变量。
2. 先零调用执行上述两种原证据回放、正式定向测试、完整类型与构建。原 35 请求、原题/成绩/未答第三组与备份比对；旧成功行动不再误标未知，不出现不存在的专项归纳请求提示。
3. W1 原任务只读打开：显示解释来源关联问题，不再提供必定 409 的确认按钮。直接对错误解释提交原确认依旧应 409，零写入/零请求。选择来源更正，核对实际第 3/4 段，预览原目标和新来源；明确提交生成新版本，目标标准不变、预算保留。**不自动继承旧解释或旧 resolved**。
4. W3 来源更正选择实际第 5/6/7 段，明确允许旧作答历史。重读原正式作答后，提示答对仍不能算无辅助支持，适用条件错误仍待处理；允许有目的解释或检查，不应以技术错误要求重复出题或声称通过。先使用离线故障/回放验证这些规则，真实 DS 行动仍另记证据。
5. W2 原任务已 16/16：不重置上限，不借新 SHA 继续计成新任务。原两组成绩和第三组未答保留；预算停止提示应准确，无不存在的未知请求。它在剩余任务预算下无法完成真实恢复链，交接必须保留证据不足。
6. 当前同一 V1.1 总账本 **35/36，余 1**，180,126 输入 + 11,157 输出 tokens。200 总授权余 165，但不能绕过 guard 的 1 次余额；不提高上限、不拆账、不清账、不借旧 V1 余额。**1 次不足以保证 W1 新解释及 W3 完整决策/生成/反馈链真实复验**。Windows 应先完成零调用检查；若安排那 1 次请求，须先明确具体目标、停止条件和实际剩余额度，不能宣称本文件额外授权付费。其余真实验收保持 PENDING，预算事项由用户后续决定。
7. 如失败，保留任务/version、明确操作、HTTP状态、脱敏diagnostics code/path、实际call与artifact、前后source/plan及账本差异。不要复制凭据、猜测缺失响应或传真实用户资料。用户手动交回本开发分支，不自动联系另一会话。

## 限制、回退和停止

首次解释请求 #21 为 HTTP200/completed、20 输出 tokens 后业务失败，准确底层解析/Zod路径未保存。生成请求未全部具有 client_request_id，此限制保留；不据此新建框架或猜测错误参数。旧 W1/W3 首轮拒绝的原 decision 仍不可恢复。

原文呈现、用户来源选择、合法映射、程序判分都不是教学语义核验；暂定支持不等于 verified。S32、有限数学检查、来源支持、情境迁移及长期掌握未验证的限制不变；模拟学生不是学习效果证据。

回退前停止服务、保存本轮一致的数据/账本/checkpoint备份。旧代码可能不理解未完成写入的新来源更正快照，不能让它自动继续这类 ready 任务；在独立副本恢复与旧代码配套的完整备份。单纯 checkout 不回退数据，禁止删除账本记录或改成绩。

本轮没有 dev/cloud-code 集成、main 合并或生产部署。Cloud 完成集中修复后停止，Windows 最终真实验收仍由用户手动接回。

## 精确相邻测试命令

```bash
npm run cloud:test -- \
  scripts/agent-trial/a2-fixtures.test.ts \
  scripts/agent-trial/a2-migration.test.ts \
  scripts/agent-trial/completion-fixtures.test.ts \
  scripts/agent-trial/offline-provider.test.ts \
  scripts/agent-trial/request-budget.test.ts \
  scripts/agent-trial/script-contract.test.ts \
  src/app/api/learning/agent-completion-flow.test.ts \
  src/app/api/learning/agent-completion-repair.test.ts \
  src/app/api/learning/agent-routes.test.ts \
  src/app/api/learning/framework-routes.test.ts \
  src/app/api/learning/learning-routes.test.ts \
  src/app/api/learning/preparation-routes.test.ts \
  src/app/api/learning/quiz-routes.test.ts \
  src/app/api/learning/study-routes.test.ts \
  src/components/learning/learning-agent-completion.test.tsx \
  src/components/learning/learning-agent-panel.test.tsx \
  src/components/learning/learning-agent-source-adjustment.test.tsx \
  src/components/learning/learning-framework.test.tsx \
  src/components/learning/learning-mind-map.test.tsx \
  src/components/learning/learning-pages.test.tsx \
  src/components/learning/learning-preparation.test.tsx \
  src/components/learning/learning-quiz.test.tsx \
  src/components/learning/learning-reading-state.test.tsx \
  src/components/learning/learning-study.test.tsx \
  src/components/learning/learning.test.tsx \
  src/lib/server/agent/decision-diagnostics.test.ts \
  src/lib/server/agent/model.test.ts \
  src/lib/server/agent/runtime.test.ts \
  src/lib/server/learning/agent-a2.test.ts \
  src/lib/server/learning/agent-completion.test.ts \
  src/lib/server/learning/agent-context.test.ts \
  src/lib/server/learning/agent-plan-contract.test.ts \
  src/lib/server/learning/agent-plan-sources.test.ts \
  src/lib/server/learning/agent-review-summary.test.ts \
  src/lib/server/learning/agent-scenario.test.ts \
  src/lib/server/learning/agent-source-binding.test.ts \
  src/lib/server/learning/framework-generator.test.ts \
  src/lib/server/learning/framework.test.ts \
  src/lib/server/learning/generation-diagnostics.test.ts \
  src/lib/server/learning/generation-parts-preflight.test.ts \
  src/lib/server/learning/large-generation.test.ts \
  src/lib/server/learning/model-input.test.ts \
  src/lib/server/learning/parsed-document.test.ts \
  src/lib/server/learning/quiz-compact.test.ts \
  src/lib/server/learning/quiz-composition.test.ts \
  src/lib/server/learning/quiz-failure-display.test.ts \
  src/lib/server/learning/quiz-option-identity.test.ts \
  src/lib/server/learning/quiz-reference.test.ts \
  src/lib/server/learning/quiz-request-packing.test.ts \
  src/lib/server/learning/quiz-request-resume.test.ts \
  src/lib/server/learning/quiz-review-purpose.test.ts \
  src/lib/server/learning/quiz-set-cardinality.test.ts \
  src/lib/server/learning/quiz-set-context.test.ts \
  src/lib/server/learning/quiz-set-identifiers.test.ts \
  src/lib/server/learning/quiz.test.ts \
  src/lib/server/learning/repository.test.ts \
  src/lib/server/learning/study.test.ts \
  src/lib/server/openai/client.test.ts \
  src/lib/server/openai/structured-json.test.ts
```

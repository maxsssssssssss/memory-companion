# Learning Agent V1.1：B1–B3 集中返修与 Windows 交接

冻结验收基线：`24eead02f2825dbc029ab4b62c211c291982de73`。开发分支：`feat/learning-agent-completion-v1-1`。最终修复 SHA 以本轮提交报告及远端核对结果为准。

Windows 对冻结基线的真实验收仍为 **BLOCKED**，本交付新 SHA 的真实 DS 验收为 **PENDING**。本轮 Cloud 只修复本包 B1a/B1b/B2/B3，真实 LLM、ASR、OCR 请求为 **0**；不集成 `dev/cloud-code`、不合并 main、不部署。旧 V1、之前离线通过或 Windows 安全审计不代替本轮语义场景验收。

## 一、证据身份与回放边界

附件 `DAILY_BRIEF_LEARNING_AGENT_V1_1_WINDOWS_REAL_FINAL_EVIDENCE_24eead0.zip`：

- 大小：23,091,033 bytes。
- SHA-256：`1d8adb6a7994fec13a3b3ed7494e1c9963ecfb5110c76c35e81f20422d58403e`。
- 258 个文件，其中 `FILES_SHA256.json` 列出 257 项；**257/257** 大小及哈希一致。独立上传的 REPORT 与 ZIP 内文件字节一致。
- 已读取 REPORT、business-evidence、三个 `semantic-review-*.json`、W1/W3 path-analysis、provider-accounting 和对应 browser-steps。包内没有单独的 `semantic-review-w3.json`，W3 分析在 `w3-path-analysis.json`。
- 原样 `reproduce-evidence.mjs` 经检查仅只读文件、运行断言，无网络或数据库操作。**9 项、exit 0**，意义是原 Windows 失败事实复现，不能标为修复成功。

| 证据包 | 校验 | manifest SHA-256 | 最终正式回放 |
|---|---:|---|---:|
| 本次 24eead0 公开业务投影 | 257/257 | `0f76de1ff7b8fd338ee7d855f805297254f399ce7e70b087065df3391542871f` | 25 项，exit 0 |
| 上轮 b7d8fcc 公开业务投影 | 137/137 | `8d8c3f51fc0386a986f043c39370c8554b90d14ef93a27acc7643ad2f60bce65` | 23 项，exit 0 |
| 首轮 495c2e1 原 W2 完整回放包 | 129/129 | `74cbb5d2ecc6cdeeab73198b4f30fb76bfde82418798f012c808377a50448fd5` | 16 项，exit 0 |

本次新包是公开保存业务投影，**不含完整 Windows SQLite/checkpoint、原 Provider raw envelope、私有工具参数或模型私有推理**。Cloud 没有接触 Windows 私人目录或凭据。

新的正式回放逐字保留 W1 原解释、目标计划、原文及来源 ID；通过原 Quiz 服务保存并提交原稳定选项选择，复现 **7 道已提交原题**：旧 W3 两题、新 W3 一题、W2 第一组三题及第二组一题。题文、选项/顺序/稳定 ID、全部选项理由、来源与正式分数逐项核对；不直接写分数或通过状态。回放提交时刻是新隔离 SQLite 的实际本地事件时间，不伪造原 Windows 时间戳。

第八道原题，即 W2 第三组，公开投影未揭示其正式答案和理由；原未答快照完整保留，**不为填满数据库而猜答案或补造评分**。本次回放评估的是已提交子集，并另外展示原最终 pending 快照，不能称完整 Windows 原库恢复。

解释 artifact 外壳及公开投影缺失的关联元数据有明确离线标记。W2 index0 的原始 `relevance`/`contentStatus` 未公开，不能判断是哪一个字段造成 uncertain；回放先保留原 uncertain，再用单独标记的新离线提案验证合法重新关联，不能把它说成原 DS 已恢复。

本包还缺少 W3 原 Quiz 的私有 `review.context`、`purpose` 与完整来源更正快照。原题/成绩的领域函数回放不能替代历史恢复队列的真实运行时重放；该队列另以正式保存 review、版本调整、权限、实际作答及运行时测试验证。旧 129 文件 W2 回放独立执行，保留原两组成绩、第三组 pending 及生成前时序；不将新包投影冒充该旧原库。

## 二、修复与职责

| 问题 | 本轮改变 | 不作出的推定 |
|---|---|---|
| B1a 无当前解释却要求确认 | Learning assessment 为解释目标投影 `missing / available / needs_review / resolved`，无当前解释明确提示先讲解。request_feedback 增加可选 intent/explanationId 合同；明确解决询问必须对应当前可用解释，仍允许澄清信息与核对来源。 | 不把来源调整误判为旧 checkpoint 泄漏；不禁止所有无解释反馈。 |
| B1b 原讲解自相矛盾 | 基于实际引用原文和原保存讲解做有限负例检查：明确、相同的两个字面有限集合中，共同元素被肯定因果句否定属于交集。原矛盾文本照常保留，标记 known_issue，阻止 resolved 与追加笔记，并诚实等待核对。 | 没发现该模式不等于 verified；不宣称数学/所有自然语言正确，不自动改写生成文本。 |
| B2 更正后遗漏旧反证 | 显式来源更正、历史授权和未变的目标/requirements 共同开启有限的同任务历史待核对列表；需当前版本实际 read_answers 收据与新的逐题 associate_evidence。读取/关联前，不能直接用新题绕过旧反证。 | 授权不等于已读取；unresolvedErrors 为空不代表旧错答已纠正；不自动继承历史成绩为支持。 |
| B2 followup 与无进展 | 生成题的 followup 关联只采用目的中已关联到相同目标的真实 priorEvidenceRefs；没有前序依据仍是 initial。新增有界观察指纹区分首次取得有用作答与无新增反馈重复尝试，学习支持指纹仍按证据判定。 | 一个新题 ID、初次简单答对、方法改名或 repeated wrong 不能证明学习进展、迁移或纠错。 |
| B3 成员题错误支持计数 | 针对明确基数计算 application 要求，若所有选项实际仅判断交/并集成员归属，标记 `requirement_mismatch` 并排除该关联；正式关联工具返回准确已知失败，不要求靠再出题修复系统错配。 | 来源相交、主题相关、模型填 objectiveId 都不证明覆盖；不建立通用语义引擎。 |
| B3 合法题保守 uncertain | UI/评估明确显示关联不确定及原真实依据；实际回读后可提出新有据关联。原 known_issue、争议、错答、提示和来源问题不能被新标签抹去。 | 不自动把原 index0 uncertain 升成正确；Cloud 的新离线提案不是 Windows DS 原行动。 |

主要代码仍归 Learning：`agent-completion.ts`、`agent-completion-history.ts`、`agent-completion-evidence.ts`、`agent-explanation-content.ts`、`agent-requirement-alignment.ts`、`agent-scenario.ts`、`agent-notes.ts`，以及现有复习面板/完成组件。共享 LangGraph、AgentRuntime、预算和 SQLite 权威边界不重构。

### 讲解检查的准确能力上限

检查复用已有有限集合字面解析，只在讲解中存在唯一明确集合对、集合定义与所引原文一致、元素确属二者、且出现有限可识别的肯定因果反向断言时标错。引用错误说法、提问、假设、纠错语境和无法判明表达不借此作正向语义结论。问题位置仅用原文 offsets/code 标识，不新存一份原文。

本轮覆盖原句：

> 元素 3 同时属于两个集合，所以不满足交集的双条件，但满足并集的“或”条件，且只出现一次。

生成服务确实读取了第 3/4 段；问题不是“没有回源”。已保存的该解释不可被确认解决，也不可通过新提案或旧 pending 审批追加为笔记。已经完成的历史笔记写入不被偷偷撤销或重写。

存在合法新讲解时，可以通过原有有目的解释工具产生新 artifact；不得覆盖旧错误文本。新的当前相关解释仍需版本、权限、来源与明确反馈检查。旧错误作为历史问题保留；合法新解释及明确确认可以解除当前解释阻塞。普通“谢谢”始终不是 resolved，明确确认满足条件时零额外模型调用结束；没有必要为结束再请求模型总结。

### 历史恢复、followup 与停止

- 恢复范围是有明确来源更正授权的同任务旧版本实际题组；目标含义/类型/requirements 不变才适用。不扩大到未授权历史或其他页面。
- 更正快照、旧 plan hash、保存的 review 映射、来源及版本逐项复查；多次来源更正不能藏掉更早的同目标旧错答。缺失/不完整映射、失效来源或超出有界处理范围会诚实交回，不伪装无反证。
- 列表最多处理 50 个旧题组、200 个待核对引用；它仅承载业务引用与读取/关联状态，不建立另一份成绩库。达到上限明确交回。
- 正式 associate_evidence 要求同版本成功 `learning.read_answers` 收据；导航概况或授权开关不能替代真实逐题回读。读到后仍须模型对具体目标提出语义关联；未验证内容保持暂定/不确定。
- hinted 正确不独立；旧真实错答仍需相关、新的独立后续支持。`role=followup` 自身不构成 relation=followup，不靠简单新题把历史反证清零。
- 已有充分有效支持仍可在零额外决策下结束；待处理反馈、审批、争议或历史关联未处理时不能抢先完成。
- 原无进展保护保留。观察指纹只允许有实质新事实时再选行动；反复同类观察、新 ID 或仅改方法名不会无限开放生成。目的必须围绕当前缺口，旧 prepared 动作仍经过工具前检查。

## 三、数据、API 与兼容

没有新增依赖、SQL 表或列迁移；原题、答案、成绩、选项顺序和笔记权威不变。没有更换模型、正式 Prompt、`structured_action_v1` 或自动重试/回退协议。Windows 的 Guard 36→67 补丁未混入本产品分支。

最小增量包括：解释状态/内容问题/历史待核对的可选只读投影、现有 `check_purpose` 记录的可选观察指纹、现有反馈工具可选 `intent` 和 `explanationId`。严格本地 schema 仍生效；没有新任务平台、长期掌握表、Verifier、跨产品接口或新环境变量。任务 GET 只读投影，零模型调用，失效来源不能继续显示有效结论或原文。

旧调用不提供可选反馈 intent 时保留澄清能力，但明确询问“是否讲清”的已知不合法前提仍受检查。旧 check_purpose 没有观察指纹按保守原无进展路径处理，不借升级重放旧生成。旧任务与审批仍遵循原版本、来源、目标及稳定操作身份检查。

## 四、可重复零真实调用检查

在指定新 SHA 的隔离 checkout 使用现有锁文件安装。不要把任何 `.env.local`、登录态或真实业务数据库复制进 Cloud/新测试目录。全部命令在仓库根执行；证据目录可改成实际解压位置，输出目录必须位于原证据目录之外。

```powershell
node output/learning-completion-repair3/windows-evidence/reproduce-evidence.mjs
node --require ./scripts/cloud/offline.cjs --import tsx scripts/agent-trial/completion-repair3-replay.ts --evidence-dir output/learning-completion-repair3/windows-evidence --output-dir output/learning-completion-repair3/replay --phase final
node --require ./scripts/cloud/offline.cjs --import tsx scripts/agent-trial/completion-repair2-replay.ts --evidence-dir output/learning-completion-repair2/windows-evidence --output-dir output/learning-completion-repair3/repair2-compatibility
node --require ./scripts/cloud/offline.cjs --import tsx scripts/agent-trial/completion-repair-replay.ts --evidence-dir output/agent-v1-1-windows-final-20261016 --output-dir output/learning-completion-repair3/old-w2-final
```

应分别看到 9 项原证据事实、25 项新正式回放、23 项旧公开回放、16 项原 W2 回放通过；这四组具有不同证据层，不相加为新的用例总数。若缺少旧包，应标该项 BLOCKED，不以新包投影或新造样例替代。

定向检查入口（测试仅合成材料、离线响应及正式业务服务）：

```powershell
npm run cloud:test -- src/lib/server/learning/agent-explanation-content.test.ts src/lib/server/learning/agent-note-content.test.ts src/app/api/learning/agent-completion-repair3.test.ts src/lib/server/learning/agent-completion-history.test.ts src/lib/server/learning/agent-requirement-alignment.test.ts src/lib/server/learning/agent-completion.test.ts src/lib/server/learning/agent-scenario.test.ts src/lib/server/learning/agent-a2.test.ts src/lib/server/learning/agent-context.test.ts src/lib/server/learning/agent-plan-contract.test.ts src/lib/server/learning/agent-plan-sources.test.ts src/lib/server/learning/agent-source-binding.test.ts src/app/api/learning/agent-completion-flow.test.ts src/app/api/learning/agent-completion-repair.test.ts src/app/api/learning/agent-routes.test.ts src/components/learning/learning-agent-completion.test.tsx src/components/learning/learning-agent-panel.test.tsx src/lib/server/agent/runtime.test.ts src/lib/server/openai/structured-json.test.ts
npm run cloud:check
npm run cloud:build
```

`cloud:check` 包含项目 lint、Next typegen 与完整 TypeScript；不把重复执行计成更多覆盖。集中完整相邻清单和唯一实际文件/用例口径在本轮证据 `test-files.json`、`verification-matrix.json` 及报告中。

仅需另建独立离线体验数据时，PowerShell 示例如下；**不要把 AGENT_TRIAL_DIR 指向原 Windows real 目录执行 seed 或 offline start**：

```powershell
$env:AGENT_TRIAL_DIR = Join-Path $PWD 'output/agent-completion-repair3-offline'
node --require ./scripts/cloud/offline.cjs --import tsx scripts/agent-trial/seed.ts --a2
node scripts/agent-trial/launch.mjs start --production
```

另一终端可检查/停止：

```powershell
$env:AGENT_TRIAL_DIR = Join-Path $PWD 'output/agent-completion-repair3-offline'
node scripts/agent-trial/launch.mjs status
node scripts/agent-trial/launch.mjs stop
```

默认离线，无真实 Provider 请求。停机保留合成材料、题组、作答、任务与笔记；等待拥有进程的 launcher 实际退出后确认端口释放。该通用 seed 不等于导入 Windows 原失败状态；精确问题使用上述回放/测试与本轮浏览器 fixture。原 Windows taskkill 子进程实际 exit 1 是原证据事实，不能改写成优雅退出 0。

## 五、最终 Cloud 验证记录

以下按本轮最终源码实际命令记录；定向复验不累计为额外用例：

| 验证 | 实际数量/退出码 | 当前记录 |
|---|---|---|
| 本轮相关 Agent/Learning/JSON/API/UI/恢复回归 | 64 文件 / 1171 用例，exit 0 | 精确清单、日志和失败留存 |
| cloud:check | 9 个环境合同、完整 lint/Next typegen/TypeScript，exit 0 | 不复用旧 SHA 结果 |
| cloud:build | exit 0；180 trace manifests，forbidden 0 | 最终生产源码构建 |
| 浏览器、刷新/重登、停机/重启 | 13 项（重启前 8、后 5），两阶段 exit 0；两次 launcher/子进程正常退出 0，13 个 SQLite 完整性检查通过 | 正式 API/SQLite 与离线 Provider |
| 原证据回放 | 25 / 23 / 16 项，各 exit 0 | 257 / 137 / 129 哈希全部一致 |
| 无关扩展全仓回归 | NOT RUN | 不将相关集合称全仓 |
| 真实 Provider | 0 | Windows 真实验收 PENDING |

最终浏览器使用 3 个隔离合成任务，6 次受控 fixture 决策与 6 次 server 离线响应（5 决策、1 解释）分别记录；网络 Provider 请求 0。刷新、重登、重启、明确确认及重复确认不增加该账本。4 个自有 PID 均消失，端口关闭；原合成目录及 4 张截图保留。这里的 Linux 正常退出 0 不覆盖原 Windows 子进程 exit 1。

首次新回放曾将浏览器专用 `option.label` 与不含该展示字段的正式业务对象直接比较而失败；后按稳定 ID、文字、顺序和完整理由/来源比较，原业务断言含义不变，失败结果保留。修复前 16 项正式回放只说明缺陷复现，不加入修复后 25 项数量。集中首轮 64 文件 / 1170 用例中 2 项失败：旧离线 fixture 缺少本版本真实 read_answers 行动，已补正式读取并保留 known_issue、成绩、结束及预算断言。新增多目标无进展回归后，最终为 1171。开发期类型检查曾因新测试使用不存在的 AgentAction 字段及遗漏历史投影字段失败，已按正式类型修复。有限检查开发期的正则语法/集合定义边界失败、新 UI/API fixture 的等待排程错误均保留记录；没有降低原安全断言。

## 六、Windows 定向接回与真实预算

本轮文档不授权付费调用。Windows 真实复验仍由用户后续单独安排，Cloud 不自动联系 Windows、不消耗或扩容余量。

1. 停止自有服务并备份原隔离数据、SQLite/WAL、checkpoint、账本与证据；核对新完整 SHA。保留 Windows 用户批准的本地 `request-budget` 最高值 67 及其测试补丁，核对不混入本产品提交。它是验收工具本地补丁，不是产品任务预算变更。
2. 同一 V1.1 原账本现为 **54/67，余 13**；原 35 条保持，新增 19 条全 completed/HTTP200，unknown 0。累计 tokens 为输入 301,803、输出 20,646。本新包的 `original35RowsExact=true` 是 Windows 审计记录，Cloud 验证其不可变附件身份，没有声称持有完整原 35 条数据库。没有新开、拆分、清除账本或继承旧 V1 余额。
3. 先完成零调用回放与定向工程检查。新源码不能直接沿用旧 build；如 Windows 构建输入变化，运行对应类型/构建。只读打开、刷新、重登、查看当前评估均应零新增请求，不能通过“继续”绕过终态或安全拒绝。
4. 按下表处理原任务。不要为制造恢复成功直接改 status、预算、成绩、计划或审批行，也不要 reseed 原数据。

| 原任务 | 实际冻结事实 | 新 SHA 应核对的零调用行为 | 不能宣称 |
|---|---|---|---|
| W1 `07a4bae2-7f6e-422f-a458-5d065bc03104` | v2、16/16；保存了原矛盾解释；未点击 resolved | 原文保留、内容问题可见，错误解释不可 resolved/新存笔记，仍允许反馈问题；不新增题组或请求 | 不能在已用尽任务预算中伪造一次新解释/真实解决成功 |
| W3 `4f33452e-1d8e-407e-91d6-5de9a7416311` | v2、10/16，但已 ended/partial；旧1/2提示事实和新1/1保留 | 旧成绩/结束事实不重写，历史遗漏不是纠错成功；不会因升级自动复活运行 | “剩6次”不是自动恢复 ended 的授权，不能改数据库解锁 |
| 原 W2 `1cbcc1cb-820c-4551-9c9a-60bd3fc2e783` | v2、16/16、budget_exhausted；旧第三组未答 | 真实预算停止，无虚构 unknown/总结请求；原成绩/未答保留 | 不通过新 SHA/改目标重置原任务预算 |
| 新 W2 `223f930d-f77a-4fd1-a1f7-3937f55be1cb` | v1、10/16、两组3/3与1/1；第三组已生成未答 | index2 错误计数关联排除，index0 原uncertain保留；实际 concept/边界缺口仍可见；未答不计支持 | 第三组数量本身不是缺陷，也不证明充分证据后仍出题 |

5. 真实复验若安排新的有界任务，需要用户明确其目的与沿用同一账本；这不是让旧用尽/已结束任务借新 ID 规避预算。不要默认重跑模型比较、原协议 smoke 或全部历史四轮。
6. 建议优先安排三个有限观察：解释任务在真正生成当前合法讲解后明确 resolved，结束与重复确认零额外调用；具备真实历史授权的目标更正任务先回读并关联原提示/错答，再做有目的行动；逐题核对 W2 成员/计数要求，确认相关证据足够才停止、仍有缺口则诚实说明。13 次是全账本余额，决策和工具生成都计入，不能保证三条完整轨迹都可完成。执行前由 Windows 固定范围/调用计划并按实际余额停止。
7. 凭据继续用已有安全子进程适配；名称仍为 `LEARNING_AGENT_API_KEY` 或明确确认属于获准通道的 `OPENAI_API_KEY`，由已有 `--credential-env` 选择。模型/Provider 仍使用已有 `LEARNING_AGENT_DECISION_*`、`LEARNING_AGENT_GENERATION_*`、`AGENT_TRIAL_DIR` 与 Guard 配置。不要输出秘密、扫描私人文件、复制 `.env.local` 或为了验收增加新服务。
8. 失败材料仅保留脱敏 task/version/action/request 关联、工具/安全原因码、HTTP、实际模型用量、原文/题目/全部理由的合成公开投影、真实作答与来源引用、前后状态及账本差异。不要补猜缺失私有参数/隐藏推理，也不要为了覆盖本次缺口重新付费制造旧失败。

真实有限验收必须区分：内容本身错误、关联不恰当、正确保守交回和真正安全失败。Windows 本次 W1 没有确认错误讲解、W2 未达充分覆盖，因此本轮修复不能引用这些旧轨迹声称新的成功结束已经通过。

## 七、限制、回退与收口

- 未识别到有限负例不代表题目/讲解正确；S32、语义提案非 verified、来源存在不等于蕴含、有限数学校验及迁移判断限制保留。
- W2 index0 的原 uncertain 精确私有字段不可追溯；后续应由实际回读后的有据语义关联处理，不自动提权。成员题排除不会必然改变计数 application 已支持，因为原 index1 本身是合理计数题。
- 回放与浏览器学生均为明确模拟学生；不证明真人学习效果或长期掌握。章节约定目标也不代表穷尽整章所有知识。
- 原失败解释请求 #21 HTTP200/20 输出 tokens 后业务失败的底层解析详情仍未保存；不猜 Zod path。此前 F1 原 decision 缺失限制不因此消失。当前包没有私有参数或逐请求精确结束时间，不捏造耗时或因果链。
- 没有新数据库迁移，但代码回退不自动撤销运行期间新增的题组、反馈、审批或账本。回退前停机并一致备份；在独立副本使用匹配代码/数据恢复，原账本与新增审计不得丢弃。旧代码不会执行本轮 known-issue/关联保护，不能用回退接着确认已知错误内容。
- Cloud 完成本包后停止；新 SHA 的 Windows 真实验收仍 PENDING，生产部署 NOT RUN。不启动新 Agent 阶段、A4、Work Agent、跨入口总管或长期调度。

## 本轮完整相邻测试命令（Cloud Bash）

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
  src/app/api/learning/agent-completion-repair3.test.ts \
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
  src/lib/server/learning/agent-completion-history.test.ts \
  src/lib/server/learning/agent-completion.test.ts \
  src/lib/server/learning/agent-context.test.ts \
  src/lib/server/learning/agent-explanation-content.test.ts \
  src/lib/server/learning/agent-note-content.test.ts \
  src/lib/server/learning/agent-plan-contract.test.ts \
  src/lib/server/learning/agent-plan-sources.test.ts \
  src/lib/server/learning/agent-requirement-alignment.test.ts \
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

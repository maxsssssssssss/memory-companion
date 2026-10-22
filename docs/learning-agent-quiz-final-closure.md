# Learning Quiz 集中修复与 Windows 收口

本轮以 Windows 产品基线 `c6dd17158df3d6ac57e90c23554089d0eecfac94` 为依据，在 `feat/learning-agent-natural-language-quiz` 的 `d4262511f8e2fa65cda547f5e15cce35f4403840` 继续；后一个提交只上传证据。Cloud 使用合成材料和离线响应，不调用真实 Provider、不改 Windows 账本或 Guard。最终业务 SHA、实际命令及退出码以同批交付报告为准。

## 本轮行为变化

1. **集合身份与表示形式**：题目明确询问同一个集合时，不能仅因“写法”“表示法”关闭有限集合等价检查。真正逐字/原样文字比较，以及字符串、列表、序列、多重集等仍区别处理。原 G3 第二组的 A/B 两个正确项在发布前以 `equivalent_options` 拒绝；评分算法不变。
2. **已声明实体**：P/Q 等本题已声明集合在逗号跨分句中的正常使用不再被当作选项组合。明确选项身份、组合选择、序数、跨题和数学内容混合的位置依赖仍拒绝。原 G5 index1 本身有等价选项，修复诊断后仍拒绝，不能称为合法题恢复发布。
3. **一个明确题型别名**：仅在生成输出入口、引用绑定和题目身份计算前，把精确的 `kind="boundary"` 规范化为 `application`。题型是粗粒度展示/提示分类，不证明题目或目标关联正确；`reviewCheck.role`、答案、来源、目标 ID 不变。原 domain 严格枚举继续拒绝 `boundary`，其他未知值不兜底。已有私有 `candidateDiagnostics` 保留原始最终候选白名单投影和原 kind，并将规范化记录单列为 `normalizations`；沿用限量、7 天及来源/版本清理，不新存完整 HTTP 或私有推理，也不回写历史题目。
4. **已知零发布的一次修复**：这是本轮明确批准的产品规则调整。已知格式或候选校验失败且零发布，可由 Agent 后续选择出题，或解释后在用户反馈下选择出题，按原目的和实际拒因修正一次。它不是学生没有进步，也不是学习进展。无题且没有具体可修复失败依据、真实 unknown、失效来源、权限、取消和预算停止不获得自动修复。

## 一次修复的归属与边界

复用已有 `learning_agent_artifacts/check_purpose` 保存明确区分的修复收据，没有新表、迁移或第二个重试系统。收据身份绑定账号下的任务、版本、排序后的目标 ID 集合及检查 role；不依赖 runId、method、题量、难度或反馈 ID。原 purpose 全字段与安全拒绝代码/数量进入真实 Quiz 生成输入，新的题目仍经过全部来源、唯一答案、位置、稳定 ID、reviewCheck 和发布校验。

自动继续、用户反馈后的继续、明确原 operation 恢复共享这一个收据。刷新、重复事件、并发或重启不能重新获得机会；真实成功结果的恢复读回原业务对象，不再生成。修复后仍零发布则直接说明未能准备可靠题目并交回，不再额外调用模型决定第三次生成。部分发布立即交付已有题，不用修复机会补足数量。

所有决策、规划和生成仍走既有累计预算。收据在第一次修复生成调用前保守占用；若随后本地预算门禁拒绝，真实请求为零、顶层仍是预算停止，机会不会退还，不制造 unknown，也不赠送预算。任务调整不重置累计调用预算。不同版本的目标变化仍按已有明确授权规则处理。

新收据不参与完成证据或学习进展计算。已支持目标仍由原 assessor 自动停止；新题组 ID 或“修复成功”不代表目标已达到。旧已结束任务、旧失败和题组不被改写，也不会自动启动新调用。

## 原证据与逐题期待

收到 `LEARNING_AGENT_N1_N2_WINDOWS_REAL_EVIDENCE_c6dd171.zip`，5,049,467 bytes，SHA-256 `e901bcc807e01007160c551ecaa02aa6f75f6d019c4bf8d3044aa9935b082240`。外层 46 项、内嵌原 91 项均核对。原两个复现脚本的 exit 0 表示旧缺陷复现，不表示修复通过。

旧 7 题仍为 5 发布、2 真等价拒绝。本轮新 7 题（下表使用 Windows 的零基题号）：

| 原候选 | 正式期待 |
|---|---|
| G3-R1-0 | 发布 |
| G3-R1-1 | publication / equivalent_options |
| G3-R2-0 | publication / equivalent_options，不能进入判分 |
| G3-R2-1 | 发布，保留合法邻题 |
| G5-R1-0 | publication / equivalent_options |
| G5-R1-1 | publication / equivalent_options，不再误报 position_dependency |
| G5-R1-2 | 原 kind 严格拒绝；明确入口规范化后发布，两个事实分开记录 |

原字段与原合成来源保持不变。仅 G5-R1-2 的生成入口显式规范化产物与原候选分层比较，不把产物冒称 DS 原值。公开投影不是完整 HTTP 或私有 SQLite；历史缺失 HTTP/候选仍 UNKNOWN。Windows 原 G3 第二组尚未作答；其错误题不要用来继续验收，不把隔离模拟判分当作原任务成绩。

## 可重复离线检查

在新的隔离目录解压本轮 ZIP，Windows ZIP 条目分隔符按平台解压为目录即可；再解压其中 `offline-baseline/original-91-evidence.zip`，找到直接包含旧 `MANIFEST.json` 和 `semantic/` 的 `public-evidence` 目录。输入证据保持只读，输出目录必须全新。

```sh
node --require ./scripts/cloud/offline.cjs --import tsx scripts/agent-trial/natural-quiz-final-evidence.mjs --evidence-dir <本轮外层证据目录> --original-evidence-dir <旧public-evidence目录> --output-dir <全新回放输出目录>
npm run cloud:test -- src/lib/server/learning/quiz-final-c6dd171.test.ts src/lib/server/learning/quiz-retained-validator.test.ts src/lib/server/learning/agent-quiz-repair.test.ts src/lib/server/learning/agent-generation-progress.test.ts
npm run cloud:check
npm run cloud:build
```

便携回放核验 manifest、14 个候选、正式 codec/发布/SQLite、稳定 ID 作答、重复提交及重开；题型的原始拒绝、规范化记录和规范化后保存分别报告。更完整的相关测试精确文件清单随交付包提供，不累计重复测试数量。

隔离体验沿用 [现有安装、seed、启动说明](learning-agent-natural-language-quiz.md)，不要重新 seed Windows 历史目录。浏览器继续使用现有 `natural-quiz-browser.mjs`，`--case B,E,F` 只选择本轮零发布修复、G5 两轮与 G3 两轮；`before-restart`、正常停机/重启、`after-restart`、`inspect` 顺序执行。模型响应、模拟学生与正式业务结果要分层标识。

## Windows 最小真实验收

沿用原 V1.1 账本与当时有效授权。当前交接事实是 190/227、剩余 37 次、历史 unknown 1；本说明不新增调用授权或修改 Guard。Cloud 没有复制或重置真实账本。

1. 取得交付完整 SHA，先备份现有隔离数据目录及 WAL/checkpoint/账本；安装按锁文件，执行上面的原题便携回放。旧任务、题目、作答与未答坏题原样保留。
2. 使用原短句“先出两道题看看。”及“我总分不清交集和并集，帮我练练。”，选择现有获准合成材料；不要补工程参数、改原话、降低目标或提高 16 次任务预算。
3. 每轮至少一道有效相关题即可。完成首轮模拟作答、实际成绩读回、分析/讲解、第二轮有效题及再次提交；证据不足可 partial 或诚实交回，不要求固定题数或长期掌握。
4. 若遇已知零发布，观察正式下一行动中的一次修复是否带原目的/拒因，且成功题仍通过所有门槛。部分发布不追加凑题；再次零发布要交回。unknown 保留，不能重发原请求。一次机会的并发/重启故障注入可使用离线证据，不必故意中断付费请求。
5. 失败时保留新 SHA、任务/版本/行动关联、公开候选及规范化记录、实际发布原因、稳定选项 ID 和账本计数，由用户一次集中转交 Cloud。不要把离线受控结果或高分写成 DS 质量、真人学习效果 PASS。

没有数据库迁移。回退需先正常停止并备份完整隔离数据，选择代码及匹配数据快照；仅 checkout 不回滚新作答、修复收据或请求账本。不会自动集成 dev/cloud-code/main 或部署。

有限字面量数学检查、S32、来源存在不等于语义蕴含、模型关联非 verified、模拟学生非真人效果、长期掌握未验证仍是明确限制。本轮不建设通用语义或数学核验系统。

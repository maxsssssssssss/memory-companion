# Learning Agent V1.1：目标、证据与结束结果

> 最新 B1–B3 修复、证据边界及 Windows 接回步骤见 [集中返修交接](agent-completion-v1-1-repair3.md)。本文保留原实现阶段说明；旧 Cloud 通过不代表最新真实语义验收通过。

本轮基线为 `dev/cloud-code` 的 `d77a6911b2b9d626ab0f82950214ac073e54ec35`，开发线 `feat/learning-agent-completion-v1-1`。最终源码身份、实际命令/数量/退出码和浏览器证据以交付报告为准。Cloud 不调用真实 Provider；Windows 真实模型语义验收不由离线响应代替。

2026-10-16 Windows 首次 V1.1 集中验收在 `495c2e1fa81a892080f55cc5bcf56cbfe3ab48e6` 发现 F1–F3 阻塞。后续定向修复、两项 nullable 诊断列与原 W2 保守交回流程见 [整包返修交接](agent-completion-v1-1-repair.md)；本文以下“本轮无迁移”描述的是初始 V1.1 实现，不涵盖此次诊断增量。

## 责任与不变量

共享 AgentRuntime、LangGraph 和 SQLite Saver 保持任务执行、租约、行动收据、预算、暂停/取消/恢复职责，不导入 Learning 评分或完成类型。共享 `ended` 仍只表示执行结束。Learning 专属完成模块把停止原因、当前目标支持和长期掌握分开；长期掌握始终是未验证。

`learning_agent_artifacts` 保存版本化计划、目的、语义关联和完成评估引用；Quiz repository 仍是题组、稳定选项、作答事件和成绩的权威。checkpoint 仍只负责执行位置，不存第二份教材或评分。没有新增 production dependency、数据库、全局开关或跨产品访问路径。

| 入口 | 职责 |
| --- | --- |
| `src/lib/domain/learning-agent-completion.ts` | 严格计划/目的/证据提案/明确反馈 schema 及客户端只读评估类型 |
| `src/lib/server/learning/agent-completion.ts` | 一版本一计划、真实证据重读、逐目标缺口、完成结果、目的与无进展检查 |
| `src/lib/server/learning/agent-completion-evidence.ts` | 首次提交事件、辅助与答案可获得时序、授权内重复识别、来源/争议/质量分类 |
| `src/lib/server/learning/agent-scenario.ts` | Learning 工具、解释/Quiz 的目的传递、执行前与恢复检查、事实型 finish |
| `src/lib/server/learning/agent-context.ts` | 决策前注入当前事实评估；已满足条件时直接使用既有 finish，无额外 DS 请求 |
| `src/lib/server/learning/quiz-review-purpose.ts` 及 `quiz-service.ts`、`quiz-repository.ts` | Agent 专属生成上下文；经过原 codec、候选过滤与实际保存后关联实际题序 |
| `src/lib/server/learning/agent-api-service.ts`、Agent route | 受认证、版本绑定与去重反馈；GET 读取/投影；来源失效时不返回旧通过 |
| `src/components/learning/learning-agent-panel.tsx` 及相关组件 | 本轮要检查什么、支持与缺口、依据与限制、疑问已解决/仍需说明 |

## 四类目标及完成含义

计划由 DS 在获准材料范围内提出，保存到当前目标版本。一旦建立，模型不能在同版本内删目标或降低要求；需要用户明确调整目标/授权进入新版本。必要的范围、导航、原文读取与澄清允许先于计划；没有要求每个任务先填审批表。

| 类型 | 完成规则 | 不代表什么 |
| --- | --- | --- |
| `explanation` 解释疑问 | 存在当前版本相关解释，用户通过明确反馈确认其疑问已解决 | “谢谢”、沉默和离开不是解决；无须 Quiz，不写考试通过 |
| `diagnosis` 诊断薄弱点 | 对约定检查要求有合格实际观察，并呈现发现与未覆盖部分；答错可完成诊断 | 不自动转为补到全对，不代表已会 |
| `targeted_review` 针对性复习 | 指定困难有相关后续表现；原关键反证经有关联的、应用内无辅助且非已知重复的后续检查得到支持 | 看答案后的原题订正、无关容易题或模型标签不能单独纠正误解 |
| `chapter_check` 章节检查 | 约定核心目标逐项满足适用要求，无未解决关键反证或影响结论的问题 | 总体高分不替代覆盖，不声称穷尽整章 |

结果为 `check_passed`、`explanation_resolved`、`diagnosis_complete`、`partial`、`insufficient`、旧任务 `legacy` 或失效 `stale`。当前任务可以因为用户结束、取消、预算、无进展、来源或 unknown 停止，同时保留实际已有支持；执行结束不是学习通过。

## 证据分类与能力上限

证据引用实际 `quizId + questionIndex + attemptId`，不另存可修改的答案/分数。程序重新读取提交、稳定选项判分、提示、跳过、显式揭示、首次提交时刻和当前来源。首次提交之后正常展示解析不反过来污染此前首答；答案之后已可获得会影响未来同题重复/订正。

`independentInApp` 只描述应用已记录的首答辅助事实，不证明应用外无帮助。关闭历史权限时不查未授权历史，答案可获得性保持 unknown。即使允许历史，也不把缺少历史争议记录当成已核验；未授权材料/整章题组不会借重复识别泄漏正文。

已知重复使用题干与选项内容的确定性规范化比较，保存前序引用；换题组 ID、数值或措辞不证明迁移。DS 的 `relation`、目标关联和理由是有来源的语义提案，非 verified。相关但无法判断的内容保留 uncertain；错误回答只支持“可能存在混淆”，不推断用户心理原因。

没有已知重大问题的当前证据是 `tentative`，可按明确目标要求提供暂定支持。`disputed`、`known_issue`、`uncertain`、历史质量未知或来源无效的证据不能撑起通过；同一题的重大问题不能换一个目标/角色标签后消失。来源有效、稳定 ID 判分正确并不核验题意、答案或教学意义。保留 S32 与有限数学检查，不建立通用数学引擎或第二模型 verifier。

合法题组尚未完整交卷时是 `pending`，显示尚未检查和等待作答，不误报来源或语义问题，也不计覆盖。测验部分提交仍不返回正确与否、答案或映射理由；缺失记录、真实争议和来源失效不会被这一等待状态掩盖。

## 目的真正进入生成与停止检查

新增 Learning 工具 `learning.establish_review_plan` 与 `learning.associate_evidence`，仍使用既有 `structured_action_v1` 的 tool/args、wait、finish，没有第二套行动协议。`learning.create_quiz` 与 `learning.explain` 增加受限 `purpose`：目标 ID、检查角度、方法、明确意图和前序证据引用。

Agent Quiz 通过服务内部 `reviewContext` 传入正式生成器。候选返回的 `reviewCheck` 先检查目标/角度范围，再进入既有 codec、Evidence、位置依赖、等价选项、唯一答案和洗牌保护。只给实际发布的题目保存关联；拒绝中间候选后映射仍指向实际题序。没有关联的题不假造覆盖。普通手动 Quiz 无此上下文时保持原行为与契约。

三道 Learning 检查为：决策前重读当前计划与缺口；工具执行前重查版本/权限/目的与必要性（包含 prepared/恢复）；finish 再读事实。条件足够且没有新反馈、争议或审批时直接结束。DS 提前 finish 可以产生部分/不足结束，不能制造通过；程序拒绝通过不强迫继续练习。

事实型结果不依赖额外模型总结成功。保留既有历史回顾，但其 `kind=completed` 不是检查通过。可选总结失败/unknown 不能改写已保存的业务事实，unknown 不重发。无进展检查关注目标覆盖、有关联反证的后续支持、处理证据问题或明确解释解决；新 ID、分数上涨或仅换方法名称不构成进展。同一缺口同类方法而无有效进展时交回；改用另一方法需 `methodChange` 引用前次结果，写明具体区别和预期新观察，语义合理性仍由 Windows 有限审阅。

## API、数据与旧版本兼容

新创建的本轮任务使用 `scope.completionVersion: 1`，其后续目标/授权调整保留这一标记。旧任务及其调整仍保留 legacy 语义，不因编辑目标静默升级为新完成机制。计划与评估绑定任务版本、scope fingerprint、业务证据指纹；GET 不请求模型，不以陈旧缓存展示通过。旧任务没有计划时继续历史回顾，不自动为其猜计划或补通过。新的 prepared 行动恢复后仍重新检查目的；旧执行点不能被当成已经具备新计划与检查目的。

继续使用既有 artifacts 表，扩展明确类型的计划、证据提案、检查目的、解释反馈和评估记录；每种数据由领域 schema 校验及稳定身份约束，不建立评分 authority。Quiz 保存可选复习映射；旧题目、选项顺序、成绩、笔记和用户编辑不重写。本轮无新增 SQL 表/列迁移或依赖。

Agent PATCH 增加 `action: "explanation_feedback"`，带 `expectedVersion`、`explanationId`、`outcome: "resolved" | "needs_clarification"` 及可选消息。目标由服务端从保存解释/目的找到，客户端不能指定任意 objectiveId。每次正式请求反馈持久化独立等待身份；新任务的模型直接 wait 也通过现有请求反馈工具保存等待身份。一次等待里的回答/事件不可覆盖，重复收据不推进后来等待。

“仍需说明”不是对该解释永久拒绝：经过下一次明确请求反馈，可以对同一解释确认“已解决”，保留此前反馈记录，不必生成新解释或 Quiz。旧反馈重放不能充当新一轮回答；同一事件改正文/结果返回冲突。已经结束后相同最终正文使用新事件 ID 重复提交，也是零调用的只读收据。早期没有等待身份的记录采用原解释 ID 的保守兼容，不重写历史事件或无计划的旧任务。

目标/范围调整保留累计预算和旧成绩；旧事件、旧计划与通过不沿用。允许在新授权内显式重新关联原始证据，但需重新核对；新缩小范围的结论只属于新范围。来源变化仍保留既有整体 fingerprint 保守交回，不建设逐目标自动恢复。

界面只展示用户能理解的目标、依据、缺口、停止原因和限制，不重加调用次数、Token 或工程日志面板。进行中的任务可明确调整目标；已经结束后仍可开始后续任务，不锁在结果页。

## 验证与交接

冻结十组预期见 [agent-completion-v1-1-validation.md](agent-completion-v1-1-validation.md)，Windows 单次集中验收与回退见 [agent-completion-v1-1-windows.md](agent-completion-v1-1-windows.md)。Cloud 的正式 API/SQLite 测试、浏览器、类型与 build 证明离线工程行为；真实目标拆解、逐题语义关联、题目质量与真人学习效果不能由它们推定。

本轮不开发长期掌握度、BKT、知识图谱、排程、全站审批、其他产品 Agent 或平台。完成后保留合成数据与证据，停止本轮自有服务，等待 Windows 对最终 SHA 验收。

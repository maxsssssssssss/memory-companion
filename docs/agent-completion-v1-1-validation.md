# Learning Agent V1.1：冻结的离线检查集

本检查集在实现验收前固定预期，针对 `d77a6911b2b9d626ab0f82950214ac073e54ec35` 之后的完成判定增量。它是测试合同，不是已通过报告。实际命令、发现的文件/用例数和退出码随最终交付记录；重叠执行不重复计数。

模型决策和生成响应使用明确标记的合成响应；任务、执行循环、SQLite checkpoint、Quiz 生成保存、作答与事件走正式业务接口。测试不能直接修改分数、任务状态或审批结果制造通过。离线响应验证可接受的不同选择及真实工具回传，不证明模型自主决策或教学效果。

## 十组必验场景

| 编号 | 已冻结输入与变化 | 期望结果及有限结束条件 |
| --- | --- | --- |
| C01 | 当前版本目标所需的有效表现已经全部存在，没有新反馈/争议/审批 | 直接以有依据的当前结果结束；不新增 Quiz，不为决定是否结束再请求模型。 |
| C02 | 约定两个核心目标，只检查第一个且全对 | 第二个目标仍显示未检查；下一检查目的只能解释其实际缺口，不把整体高分当覆盖。 |
| C03 | 先使用提示，再提交正确选项 | 保留正确成绩和提示事实；不能满足要求应用内无辅助首答的检查项。 |
| C04 | 原题答错，获知答案后在重复题订正正确，相关不同情境仍答错 | 旧成绩不改写；重复题不单独消除关键反证，后续错误仍是未解决部分。 |
| C05 | 能应用规则，但在条件不满足时误用 | 已约定的适用边界项保持缺口，其他正确项不覆盖该反证。 |
| C06 | 已用于结论的题组被质疑、发现已知内容错误，或其来源失效 | 当前结论降级/失效，不继续显示有效通过；题目与历史成绩保留，来源删除不恢复正文。 |
| C07 | 同一缺口反复解释，没有新的有用反馈 | 不以新 artifact、题组 ID、方法名字计进展；选择实质不同方法、请求澄清或诚实交回，不能无限生成。 |
| C08 | 解释型目标：分别收到“谢谢”、明确解决、主动结束；另在等待中调整目标 | “谢谢”不等于解决；明确解决可无 Quiz 完成；主动结束不等于通过；新版本不继承旧结论和事件。 |
| C09 | 证据不足时 DS 请求 finish，并声称已通过 | 可以结束，但只保存部分/不足结果；模型文本不能把它改为通过。 |
| C10 | 目标已满足后 DS 或重放的 prepared 行动继续提出出题 | 工具执行前再次检查，不调用生成器、不写新题组；保留原行动、预算和结论事实。 |

不同目标的完成含义固定：解释是明确解决反馈；诊断是取得约定观察并报告发现，不强制答对；针对性复习需要相关后续表现且不忽略反证；章节检查逐项满足约定核心目标，不代表穷尽章节。长期掌握始终未验证。

## 边界与相邻回归

- 首答之前的提示/显式揭示影响该次证据；首答之后正常展示解析不追溯污染首答，但影响后续重复检查。
- 同题跨题组可确定的重复、历史未知、未授权历史分别记录；不越权查历史，不把换 ID、换数值/措辞或 DS 标签视为已证明迁移。
- 过滤中间候选后，实际保存的题目索引、稳定选项 ID、洗牌后身份与目标关联仍一致；被拒候选不产生覆盖。
- 新反馈、待处理争议或审批阻止抢先自动结束。
- 解释反馈按持久等待轮次绑定：先“仍需说明”→下一次请求反馈→同一解释“已解决”，可以零新解释/零 Quiz 结束；旧轮次的事件重放不推进新等待，同一事件/待处理轮次改答冲突，最终相同正文换事件 ID 重复提交不增加调用。两轮原反馈都保留。
- GET 只读取/投影，不请求模型；目标/范围/来源变化后不显示旧通过。旧任务没有计划，不补造目标或通过。
- 工具前检查覆盖 prepared 行动、重启与重复/并发恢复；既有 operation id 不产生重复副作用。
- 可选总结失败不影响事实型结论；unknown 仍可见且不重发。
- 取消、撤权晚到、跨账号、来源、答案揭示、嵌套调用预算及非 Learning 合成场景沿用相邻回归；不重复另造执行器。

## 证据分层与不变限制

正式判分只证明选项 ID 对应保存答案，不证明题目语义正确。有效来源引用只证明当前来源绑定有效，不证明引用支持全部结论。未见争议是暂定可用，不是 `verified`。DS 提出的目标关联、情境区别和误解假设始终标为语义判断；影响核心结论且无法判断时，保留证据不足。S32 与既有有限数学检查的能力上限保留。

Cloud 本轮真实 Provider 请求必须为 0；Windows 真实模型语义和完整业务验收另行授权，不使用旧轮余额。浏览器中的模拟学生操作不能称为真人学习效果。

## 执行入口

最终集中执行 `npm run cloud:test -- <本轮测试及相邻文件>`、`npm run cloud:check`、`npm run cloud:build`，并记录代表性浏览器、重登及正常停止重启结果。以当前源码实际执行为准，旧提交报告不能替代本轮结果。

## 覆盖落点与结果归属

| 文件/入口 | 本轮责任 |
| --- | --- |
| `src/app/api/learning/agent-completion-flow.test.ts` | 十组场景的正式受认证 API/实际 Quiz 生成保存/作答/SQLite checkpoint 闭环；额外覆盖辅助时序、事实回传、重复事件与并发、GET/暂停/等待零请求、新版本与历史重新关联 |
| `src/lib/server/learning/agent-completion.test.ts` | 精确事实与语义提案边界：来源/账号/历史授权、反证、重复题、内容问题跨关联、待审批/反馈、计划不可降级及本地事务 |
| `src/lib/server/learning/quiz-review-purpose.test.ts` | 正式生成输入接线、过滤中间候选后的实际题序、稳定选项、洗牌、来源保护、手动调用兼容 |
| `src/lib/server/learning/agent-scenario.test.ts`、`agent-a2.test.ts`、`agent-source-binding.test.ts` | prepared/恢复、来源与权限、取消晚到、unknown、笔记审批及旧业务合同 |
| `src/lib/server/agent/runtime.test.ts` | 同一共享机制的非 Learning 场景、预算、租约、事件去重及 checkpoint 恢复；本轮不把它说成新产品 Agent |
| `src/components/learning/learning-agent-completion.test.tsx`、`learning-agent-panel.test.tsx` | 目标/结果/依据/限制和明确反馈；不泄漏答案、不重新展示工程台 |
| `scripts/agent-trial/completion-fixtures.test.ts`、`completion-browser.mjs` | 离线响应明确标识，原浏览器组件/API/SQLite 连通、重登与实际停止重启 |

开发调试中，针对性复习的 fixture 补齐正式 schema 的 `followup` 要求，换方法 fixture 补齐 `methodChange` 的前次结果/区别/预期观察；业务预期保持不变。历史未授权时答案可获得性应为 unknown，不能误断言为排除了所有历史帮助。结束文案中“无法可靠给出检查通过”是拒绝通过的说明，测试核对结构化不足结果与肯定句，不能按任意出现“检查通过”四字误判。以上是测试输入/断言语义的明确修正，不是放宽题目或完成规则。

最初正式闭环暴露的业务缺陷（工具交回缺少后置校验、重复待处理作答通知并发冲突、未交卷映射理由外泄及来源删除后的旧通过文案）应由对应正式代码修复和精确回归关闭；不能以旧测试已绿替代这些断言。最终验证数量以单次最终组合执行记录为准。

## 本轮精确相邻集合

Cloud 使用以下明确的 54 个文件；这是相关集合，不代表扩展全仓或真实 Provider 回归。Windows 的有限集中验收另见交接文档。

```bash
npm run cloud:test -- \
  scripts/agent-trial/a2-fixtures.test.ts \
  scripts/agent-trial/a2-migration.test.ts \
  scripts/agent-trial/completion-fixtures.test.ts \
  scripts/agent-trial/offline-provider.test.ts \
  scripts/agent-trial/request-budget.test.ts \
  scripts/agent-trial/script-contract.test.ts \
  src/app/api/learning/agent-completion-flow.test.ts \
  src/app/api/learning/agent-routes.test.ts \
  src/app/api/learning/framework-routes.test.ts \
  src/app/api/learning/learning-routes.test.ts \
  src/app/api/learning/preparation-routes.test.ts \
  src/app/api/learning/quiz-routes.test.ts \
  src/app/api/learning/study-routes.test.ts \
  src/components/learning/learning-agent-completion.test.tsx \
  src/components/learning/learning-agent-panel.test.tsx \
  src/components/learning/learning-framework.test.tsx \
  src/components/learning/learning-mind-map.test.tsx \
  src/components/learning/learning-pages.test.tsx \
  src/components/learning/learning-preparation.test.tsx \
  src/components/learning/learning-quiz.test.tsx \
  src/components/learning/learning-reading-state.test.tsx \
  src/components/learning/learning-study.test.tsx \
  src/components/learning/learning.test.tsx \
  src/lib/server/agent/model.test.ts \
  src/lib/server/agent/runtime.test.ts \
  src/lib/server/learning/agent-a2.test.ts \
  src/lib/server/learning/agent-completion.test.ts \
  src/lib/server/learning/agent-context.test.ts \
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

## 2026-10-16 Cloud 实际收口记录

- 精确相邻集合：`npm run cloud:test -- <上述54文件>`，54 文件 / 1023 用例 PASS，退出 0；包括十组完成规则、原 Agent/笔记/权限/恢复、Quiz/手动 Learning、UI/API、共享 JSON/传输及非 Learning 场景。
- 最后仅补齐新测试 fixture 的空值保护，`npm run cloud:test -- src/lib/server/learning/agent-completion.test.ts` 1 文件 / 33 用例 PASS，退出 0。浏览器脚本精确文案断言修正后，`npm run cloud:test -- scripts/agent-trial/completion-fixtures.test.ts scripts/agent-trial/script-contract.test.ts scripts/agent-trial/offline-provider.test.ts` 3 文件 / 30 用例 PASS，退出 0；这些与组合重叠，不累加。
- `npm run cloud:check` 最终退出 0：9 项环境/自有进程合同 + Next typegen + 完整 TypeScript。`npm run cloud:build` 在最后产品代码上退出 0；trace manifests=180，forbidden=0。没有新增依赖或改变锁文件。
- 实际 production 页面：`seed.ts --manual` 两次退出 0，第二次零写入；`completion-browser.mjs before-restart / after-restart / inspect` 最终分别 4 / 6 / 4 条检查通过、退出均 0，阶段之间有重叠，不合计为独立用例数。浏览器会话刷新、退出/重登、正常停止重启都保留原任务与数据。
- 解释轨迹明确确认后 `explanation_resolved`，零 Quiz；章节轨迹通过原组件实际提交 2/2，按两个约定目标得到 `check_passed`。二者反馈/交卷后新增模型响应均为 0。浏览器账本共 12 条离线响应（10 决策、1 解释、1 Quiz），真实 Provider 网络请求为 0。它们不证明模型自主语义或真人学习效果。
- 3 次自有生产进程停止均 exit 0 / signal null；停止后 12 个 SQLite 完整性检查全部 `ok`。合成数据保留在 `output/learning-completion-v1-1-trial`；工程日志在 `output/learning-completion-v1-1`。

中间失败未删除或冒充通过：初次类型检查发现测试可空值/不完整类型转换，均修正；组合回归曾有 3 项普通反馈未绑定新等待轮次失败，正式路由修复后通过。浏览器首次发现未交卷被误标为无效证据，新增 pending 分类与四项精确回归，仍使用原 A/B 任务通过。重启后的真实点击/交卷已经成功，但脚本对完整产品文案使用了不连续的短子串，造成一次 exit 1；修正精确匹配后仅只读复验已完成任务，结果明确标记 `reusedCompleted: true`，没有重新提交答案或创建题组。首次失败日志和截图与最终记录一并保留。

相关离线工程验收 PASS；扩展全仓回归 NOT RUN（未重跑无关产品/历史 PDF fixture）；Windows 最终 SHA 真实模型语义与业务验收 PENDING；生产部署 NOT RUN。Cloud 未继承任何旧真实调用额度。

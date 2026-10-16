# Learning Agent V1.1：Windows 整包返修交接

> 当前整包 R1–R3 返修优先按 [集中交接](agent-completion-v1-1-repair2.md) 验收；以下内容保留原阶段证据身份，旧请求数量不代表当前余额。

日期：2026-10-16。基线 `495c2e1fa81a892080f55cc5bcf56cbfe3ab48e6`，开发线 `feat/learning-agent-completion-v1-1`。本文件针对 Windows 首次 V1.1 集中验收的 F1/F2/F3，不扩大到其他 Agent。Windows 冻结版结论仍是 **BLOCKED**；修后 SHA 的真实验收是 **PENDING**，Cloud 离线通过不替代它。

## 收到的原始证据

- ZIP SHA-256：`8f097725de8228600d3abec4203884bc29d3d230ff82eab3cecc4440e825ad97`。
- `FILES_SHA256.json` 列出的 129 个文件，大小与哈希全部一致；清单自身不包含在自己的哈希列表中。单独上传的 REPORT 与包内报告字节一致。
- 已读取 REPORT、scenario-plan、w2-semantic-audit、business-records、network-ledger-export、schema-contract-gap 和 W2 正式 assessor 回放；合成业务副本与原来源齐全。
- W1/W3 的被拒绝原始 decision 没有保存。不能精确重放其 tool/args、判定原 JSON 是否修复，或宣称 F2 必然是其拒绝原因。
- 附件脚本在基线上原样执行：schema 缺口 5 条规则、6 反例、6 修正例、2 严格性保护对照；W2 正式 assessor 5 项缺陷复现断言。退出 0 表示原缺陷被复现，不是产品通过。

原包放在忽略的 `output/agent-v1-1-windows-final-20261016`。回放在独立副本进行，原始题目、答案、作答、来源、计划、评估和附件字节均保留。

## F1：首次行动拒绝可诊断

正式决策请求使用随机 UUID `X-Client-Request-Id`，与现有 `agent_calls.id` 相同。现有调用表新增 nullable `diagnostics_json`；试用 guard 的现有 requests 表新增 nullable `client_request_id`。这是关联与诊断字段，不是新调用账本或评分权威。

拒绝记录包含任务、版本、决策、调用/请求关联，失败层（响应、JSON、根行动 schema、工具选择、工具参数）、固定原因码及 Zod issue code/path。最多 32 项问题、每项最多 12 层路径；动态 key 脱敏。已注册工具保存准确工具名，未注册任意字符串记为 null 加 `tool_not_registered`，防止模型把正文或秘密塞进日志。

不保存参数值、原响应、Zod message、私有推理或凭据。HTTP 完成后的业务拒绝仍保留已发生用量；unknown 不重发；严格 schema、正式 Prompt、`structured_action_v1` 与禁重试规则不变。老行保持原状态/用量，新字段为 null，不补造旧关联。

诊断通过 `AgentStore.decisionDiagnostics(accountId, taskId)` 鉴权读取，不增加产品主界面的工程面板。Windows 可在停止服务后的验收副本，用已有导出方式读取这些新增列；正式决策行可由 `requests.client_request_id = agent_calls.id` 关联。旧请求及非决策生成的 ID 可以为 null，不能反推原来未记录的信息。

## F2：正式计划合同完整可见

`LearningReviewPlanInput` 的实际工具参数 schema 描述明确列出：

1. 同计划 objective ID 唯一。
2. 非 explanation 的每个目标 requirements 至少一项。
3. 同目标内 role 唯一。
4. targeted_review 每个目标必须有 followup。
5. targeted_review/chapter_check 的全部 requirement 必须 independent=true。

`purpose.objectiveIds` 的唯一性也在对应参数说明中可见。完整 Zod refinement 继续强制校验，并提供准确字段路径；可见说明不声称 JSON Schema 引擎已经执行了这些跨字段条件，也不声称真实模型必然遵守。回归从实际 Learning 场景工具经过正式 `agentDecisionRequest` 检查发送内容，保留六反例拒绝、六修正例接受和两个额外字段/未知 role 保护。

## F3：系统关联异常停止补题并明确交回

采用有界的**显式调整路径**，不自动改写来源：

- 将授权有效但与冻结目标来源段落不相交的证据标记 `diagnosticCode=plan_source_mismatch`。仍然无资格支持通过，原记录不删除。
- 完成投影输出 `technicalBlocker`，明确这是资料关联问题，不是学生错答或学习困难。`associate_evidence` 返回准确原因，不再笼统要求“先读取作答”。
- 决策前直接走现有 `learning.request_feedback` 持久等待，不新增 DS 调用；Quiz/解释执行前（含 prepared 恢复）返回同等等待，不创建新业务对象或生成请求。
- 使用现有“调整本轮复习”核对目标与范围，明确提交后建立新版本；或者结束本轮。保留旧计划、题组、作答、成绩和累计预算。相同旧版本内不修改目标、检查要求或来源。
- 新版本如需复用旧作答，用户须明确允许相应历史，重新回读当前授权原文与实际作答后关联；未授权历史不读取。仍不能把来源重叠当作语义核验。
- 错答、提示/提前揭示、重复、争议、已知错题、撤权、来源失效与 unknown 继续独立阻止虚假通过。技术分类不清除这些事实。

UI 使用既有组件，显示“先核对目标与来源”和现有调整/结束操作；不再提示靠多答题解决关联问题。原 W2 第三组仍未提交，保留可查看的原题，不伪装已经完成。

## 原 W2 回放与确定性验证

```powershell
node --require ./scripts/cloud/offline.cjs --import tsx scripts/agent-trial/completion-repair-replay.ts --evidence-dir output/agent-v1-1-windows-final-20261016 --output-dir output/learning-completion-repair
```

该入口先校验原包 129 个哈希，再复制合成 B 账户给正式 repository/assessor。它分别检查当前完整快照和原第二组/第三组生成之前的时间界限。历史检查使用按实际 created_at 截断的只读 artifact 投影，保留原任务状态与预算，并验证所用作答确实在界限前完成；它不是伪造的完整历史数据库备份。

实际顺序：第二组 UI 完成交卷 `06:26:37.843Z` → 读回答案 action10 `06:26:43.223Z` → 关联 action11 `06:26:49.211Z` → 第三组 create action12 `06:26:56.143Z`。旧 mismatch 在第三组之前已经存在；当前第三组 pending 是另一个事实，不是初始根因。两个具体 requirements supported 也不能让资料关联问题自动消失。

修后预期是精确等待调整、零新增模型或题组，而不是把原 W2 改成通过。新增 API 测试另外使用明确合成数据证明版本化调整后重新关联的路径，不能冒充原 W2 已由真实 DS 恢复。

受影响回归包含现有 C01–C10、prepared、unknown 禁重发、版本/来源/撤权、重复/并发、答案保护、稳定选项、手动 Quiz 与历史兼容；新增诊断、参数合同、资料关联及 API/UI 用例。最终命令、实际数量与退出码见交付报告和 `output/learning-completion-repair`，重叠定向运行不累计覆盖数量。

本次集中回归实际为 **57 文件 / 1060 用例，exit 0**。新增测试泛型 mock 的一次类型错误修正后，受影响 API 文件 **7/7、exit 0**，完整 `cloud:check`（9 项环境合同、Next typegen、TypeScript）**exit 0**。最终 `cloud:build` **exit 0**，生产编译 84 秒，trace manifests=180、forbidden=0。原 W2 修后正式回放 **16 项、exit 0**。API/UI/SQLite 重开和原 persisted prepared/checkpoint 用例包含在上述集合内；本轮不重复完整浏览器演练，也不使用旧浏览器结果冒充新结果，扩展全仓回归 NOT RUN。

保留实际开发失败：合同测试最初误用不存在的 scene.name，改成实际 scene.id；新回放脚本首版 TEMP VIEW 同名遮蔽主表影响建索引，修正为具名临时视图和只读 SELECT 投影，未改产品构造器；新增测试的泛型 mock 类型错误如上。均有原失败输出，最终对应验证通过。它们不改写 Windows 原 F1/F2/F3 证据身份。

## Windows 定向复验（沿用同一 V1.1 账本）

先正常停止自有服务，完整备份现有 V1.1 隔离目录、SQLite/WAL/checkpoint、账本和证据。核对本次交付完整 SHA，再使用锁文件安装；不要重新 seed 已有 Windows 任务或清理账本。无需新 Provider、凭据或协议配置；启动仍使用现有 `agent-trial/launch.mjs` 和原 `AGENT_TRIAL_DIR`，真实模式仍需 Windows 有效授权。

1. **零调用先验**：运行上述原包回放、参数合同与相邻测试；原 17 条请求和旧任务/成绩不变。新增两列为兼容扩展，老记录 null。
2. **W1/W3 新 SHA 定向真实复验**：保留原失败任务，用相同目标开始获准的新定向任务；如再拒绝，保存新 request/call/task/version、失败层、code/path，不反复付费重试。W1 检查解释与明确解决；W3 检查提示/边界反证。不能将合同离线 PASS 视为它们的真实 PASS。
3. **W2 原任务只读检查**：显示资料关联问题和第三组未作答；刷新不调用模型，不要求继续提交第三组解决系统问题。直接结束可零调用保留部分/不足结果。
4. **如继续 W2**：用户明确“调整本轮复习”，核对相同目标标准与合适原文范围；需要复用旧作答时明确授权历史。新版本读取原文和正式结果后关联。旧记录、累计用量仍在，不能回改旧计划或降低标准制造通过。若模型关联仍不可靠，保留不足并交回。
5. 停止/重启/重复反馈不补发 unknown，不重复生成。任何新增拒绝、无意义补题、错误通过、来源或答案泄漏均保留脱敏现场，交回同一分支。

本轮 Windows 既有账本是 **17 次**，其中 14 决策、3 Quiz 生成；98,533 input + 6,734 output = 105,267 tokens，unknown 0。用户授权 200 余 183；冻结 guard 硬上限 36 余 19；报告提到的文档 48 也超出该 guard 接受范围。这是独立工具限制，**本次不提高上限、不绕过、不拆账、不清账**。Cloud 请求 0，不使用 Windows 余额，也不继承旧 V1 的 34/36。

回退须先保存新增列后的整套数据，使用另一隔离副本恢复一致备份与对应代码。切旧 SHA 不会回退数据库，不能通过删除列或恢复旧账本抹去已发生请求。Windows `taskkill /T /F` 的旧 exit1 保留原证据身份，不改写为优雅退出0。

## 能力边界

尚未确定 W1/W3 原拒绝字段；尚未验证修后真实模型是否正确建立计划。来源授权及段落重叠只提供可检查边界，S32、题目语义、来源支持、情境迁移和有限数学检查限制均保留。没有自动来源纠错器、通用语义/数学引擎或第二模型 verifier。开发集成 PENDING；main 合并、生产部署 NOT RUN。后续真实验收由用户手动交接。

## 本次最终工程命令

下面集合与最终57文件回归一致；Cloud 命令自动隔离业务配置并阻止真实外联。Windows 可用 `npm test --` 加相同文件列表离线执行。

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

npm run cloud:check
npm run cloud:build
git diff --check
```

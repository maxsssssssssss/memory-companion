# Learning Agent V1.1：C1–C4 集中返修与 Windows 收口

Windows 冻结验收 SHA：`392fb07edd2f31d8299e50cefd34717df22c858c`。本轮在 `feat/learning-agent-completion-v1-1` 的 `b327075d948eb0a794504a24c0eeccb33eb9afc3` 上继续；中间两个提交仅用于证据包交付与移除，产品输入相同。最终交付 SHA 以提交报告及远端核对为准，不把旧 Windows PASS 套用到新提交。

Windows 对原版本的结论是 **BLOCKED：W1 PASS，W3/W2 PARTIAL**。真实工具、Quiz、UI 作答及历史恢复已经运行；本轮修复不意味着此前所有工具不可用。Cloud 全程离线，真实 LLM/ASR/OCR 请求 **0**；Windows 新 SHA 真实收口仍 **PENDING**，开发集成与生产部署均未运行。

## 证据身份和边界

- 附件 `DAILY_BRIEF_LEARNING_AGENT_V1_1_REAL_CLOSURE_392fb07.zip`，7,952,917 bytes，SHA-256：`12eb43391fc8bb72978d5c4f3bdc2a91c25e0aad1e227ab14b0a2799dabcc8f7`。
- 包内共 299 个文件，`MANIFEST.json` 列出 298 项；全部大小、哈希一致。manifest SHA-256：`54ba26012e58fa555ac947f7fae950ed364b1f80e6bdf2f7dcd25d118e14f924`。独立 REPORT 与包内字节一致。
- 原 `verify-evidence.mjs` 的 6 项只读事实通过，含原 54 条账本保留、累计 93/200、余 107、网络 unknown 0。它证明原证据完整，不证明产品修复通过。
- 这是脱敏公开业务投影，**不是完整 Windows SQLite/checkpoint、原始 Provider envelope 或私有行动参数**。12 道被拒候选原文已经缺失，只能核对 8 个位置依赖和 4 个 reviewCheck 拒绝标记；不能断言它们都是正确拒绝或误杀。
- 新回放通过正式 Quiz 服务保存、提交 9 道已提交原题：W3 两题、新 W2 两题、原 W2 续做五题。逐项核对题文、全部理由、稳定选项 ID/排列、来源、原选择及成绩；不直接写分数。回放事件时间是本地新事件，不伪造原 Windows 提交时刻。
- 原计划与公开关联文本保留；缺失的 artifact 外壳、私有 relevance 等有明确的离线重建标记，不称恢复了原决策。原 W2 第四组仍未答，只保留公开快照，不猜隐藏答案。原第三组 E=3 的理由算术措辞问题原样保留为内容质量观察，没有改题或另建数学核验器。

## 修复矩阵

| 项目 | 根因与改动 | 安全边界与限制 |
|---|---|---|
| C1 子层预算误报 unknown | `generation-parts` 与 `quiz-service` 识别明确 Agent 预算/已知失败/真 unknown；调用前拒绝保存为 failed，准确预算原因，不再误报 Provider 故障。预算停止不开放脱离任务的 Quiz resume。 | compute 超限也可能发生在完整响应后，仍保留实际调用和用量，不谎称全部未发出。真正 unknown、不明异常继续不可重发。旧 Windows 已误标行不无依据迁移或推定；原耗尽任务不复活。 |
| C2 总结遗漏授权旧错答 | 总结复用当前完成证据，要求本版本真实 `read_answers` 收据、显式关联、历史授权及当前来源核对，仅纳入具体旧题，重新读取原作答。失败生成、未知结果、争议、记录/来源不可用分开显示。 | 不把授权等同已读，不整组或跨页扩读；旧错答、提示、成绩不变。总结明确回顾范围，GET 不生成。总结是回顾，不成为第二评分或完成权威。 |
| C3 流程型检查要求 | 新计划合同明确要求可观察知识表现，有限拒绝本包两类纯流程描述；旧计划以原严格合同读取并标技术阻断，保留所有要求，交回现有明确调整流程。 | 不删除 followup，不降低知识要求或追认旧任务通过；已有冻结来源调整可幂等落地，但仍保留技术阻断。检测未命中不等于语义 verified。 |
| C3 作答方式 | 证据明确 `responseMode=single_choice`；保留原模型关联理由，但提示选择正确解释不是学生独立组织语言作答。明确要求“用自己的话解释”等不能由单选题满足。 | 普通概念选择仍可提供暂定线索；不将全部题目强制 verified，也不建设新题型或口述评分。 |
| C4 连续生成失败 | 已知失败也保存稳定的检查目的及安全原因，真实失败进入下一决策；无相关新观察的同类生成在调用前停止，允许解释、核对、必要澄清或有明确区别的合法方法。 | 新 ID、题量变化、方法改名或无关目标进展不能当作本缺口进展。原 operation 显式恢复、prepared、幂等、来源与预算仍检查；unknown 不进入已知失败重试路径。 |

实现仍归 Learning：`agent-completion`、`agent-scenario`、`agent-review-summary`、计划/证据/来源合同及现有 UI。共享 AgentRuntime、LangGraph、正式 `structured_action_v1`、Quiz 发布/来源/唯一答案/洗牌/评分保护不改。没有新依赖、SQL 表/列迁移、模型 Provider、全局开关、worker 或平台。

新数据仅是现有 artifact 内有界的失败目的/进展字段，以及只读证据作答方式和技术阻断类型。原兼容计划 schema 保留原有唯一 ID、非空要求、role 唯一、targeted followup 和 independent 五条约束；只把新接纳检查与旧记录读取分开，不产生第二计划权威。

## Cloud 可重复验证

在最终 SHA、相同锁文件和隔离数据目录运行。证据目录按实际解压位置替换，输出放到原证据目录之外。不要复制 Windows `.env.local`、真实数据库、账本或 Cookie；不要运行包中的 Windows Guard200 补丁。

```powershell
node output/learning-completion-repair4/windows-evidence/verify-evidence.mjs
node --require ./scripts/cloud/offline.cjs --import tsx scripts/agent-trial/completion-repair4-replay.ts --evidence-dir output/learning-completion-repair4/windows-evidence --output-dir output/learning-completion-repair4/replay
npm run cloud:test -- src/lib/server/learning/agent-budget-generation.test.ts src/lib/server/learning/agent-review-summary-history.test.ts src/lib/server/learning/agent-generation-progress.test.ts src/lib/server/learning/agent-plan-contract.test.ts src/lib/server/learning/agent-plan-sources.test.ts src/lib/server/learning/agent-completion.test.ts src/lib/server/learning/agent-requirement-alignment.test.ts src/components/learning/learning-agent-completion.test.tsx
npm run cloud:check
npm run cloud:build
```

附件原 C1 脚本包含 2 项缺陷复现以及 known-local/true-unknown 两项保护对照：首次在未修源码执行四项通过并保留，其含义不是修复 PASS。修后在独立副本改为正确分类断言，原附件未改；正式 CI 回归为 `agent-budget-generation.test.ts`，不要求新代码维持错误断言全绿。

Windows 包中的 `run-focused.mjs` 绑定旧 SHA、Windows npm 路径并写入脚本目录；`run-replays.mjs` 绑定旧证据布局及固定 output 路径。Cloud 采用当前 `cloud:test` 和对应正式回放入口等价运行；初次非法 fixture 仅是旧脚本准备错误，Guard200 三文件仅参考。不执行真实 driver，也不把这些参考脚本称作产品验收。

本轮最终命令、逐文件用例数、退出码、公开回放、旧包兼容回放、类型、构建及浏览器结果在 `output/learning-completion-repair4/verification-matrix.json` 和同目录报告。重叠定向测试不累加覆盖量；全仓无关回归不冒称已运行。

最终源码上的集中验证：

| 验证 | 实际数量 | 退出码 |
|---|---:|---:|
| 本文末尾完整 `cloud:test` 清单 | 67 文件、1229 用例，失败/跳过 0 | 0 |
| `cloud:check` | 9 项环境合同、Next typegen、完整 TypeScript（项目 lint） | 0 |
| `cloud:build` | production build；180 项 trace 检查、forbidden 0 | 0 |
| 新附件 `verify-evidence.mjs` | 298 项哈希、6 项原事实 | 0 |
| `completion-repair4-replay.ts` | 31 项，9 道原题正式业务保存/提交 | 0 |
| 旧 `reproduce-evidence.mjs` | 9 项原事实 | 0 |
| `completion-repair3-replay.ts` | 25 项 | 0 |
| `completion-repair2-replay.ts` | 23 项 | 0 |
| 原 `completion-repair-replay.ts` | 129 文件原包、16 项检查 | 0 |
| C1 正确分类独立脚本 | 4 项；原错误断言副本另行保留 | 0 |
| production 浏览器及正常重启 | 16 组检查（4+5+7），原失败与续验分开保留 | 最终续验 0 |
| 两次正常停止及 SQLite | Next 子进程各 exit 0、signal null；15 库 integrity_check 全 ok | 0 |

这些数字分别代表测试用例、原事实或回放断言，不相加成更大的覆盖数。开发期间曾有新来源调整测试预期错误码不准确、已知失败 fixture 误用了结果未知的 HTTP 502 两项失败；修正测试材料/准确断言后，保留对应安全对照并纳入上述最终结果，没有删减保护。

浏览器准备期两次新合成题理由被既有字母位置依赖保护拒绝，仅调整新合成表述，未修改 Windows 原题或产品门槛。另有两次验证脚本 exit 1：局部变量未声明、把已提交历史结果误定位为未作答组件；失败截图/日志保留。修后仍实际打开原历史错题并核对原错选与 0/1、提示非独立、调整入口、明确失败交回；W1 重启后的解决与重复确认零额外调用。最终完成 16 组，全部自有进程已停、端口关闭，数据留在 `output/learning-completion-repair4/browser/data`。这次 Linux 的实际退出 0 不改写 Windows 原退出 1 的证据。

本地继续体验无需再次 seed：设置 `AGENT_TRIAL_DIR` 为保留的 `output/learning-completion-repair4/browser`，运行 `node scripts/agent-trial/launch.mjs start --production`，用同目录已保存的合成账号登录；结束运行 `node scripts/agent-trial/launch.mjs stop`。不加 `--real`，不把真实目录重标为离线。

## Windows 集中复验

本文件不授权新增真实请求。沿用唯一 V1.1 账本 **93/200、余额 107、unknown 0**；不要重置、拆账、重新 seed 旧数据或提高单任务预算。Windows 本地 Guard200 只是获准的验收工具差异，没有进入产品分支。

1. 正常 fetch，独立检出交付 SHA，核对祖先包含 `392fb07`。停机备份原数据库、WAL/checkpoint 与唯一账本后使用匹配代码；锁文件未变时可复用已验证安装，否则 `npm ci`。无需新迁移，也不要把原真实目录改成 offline。
2. **零真实请求**先跑上述 C1/C2/C3/C4 聚焦回归及公开投影回放。预算前置拒绝必须同时检查 task、call、generation part 和 Quiz：不新增 call、不调用生成器、failed/non-uncertain/non-resumable；真 unknown 对照仍不重发。
3. W1 保留已通过的原任务和解释。用最终版本只读查看、刷新/重新登录、重启，以及原“疑问已解决”重复事件验证零新增请求。另一个合成未确认解释的“谢谢”回归继续等待。原 Windows PASS 仅绑定旧 SHA，新的完整语义生成仍不由 Cloud 声称通过。
4. W3 原任务已经 16/16 且终态，不复活。最终版本查看合法关联旧错答的总结，必须保留错题与提示事实，失败组不能写成用户争议。新真实恢复/换方法试验只在另行授权的有界任务进行；必须读回并关联授权旧反证，不能用新简单题消除它。若没有可发布题，应有信息地换法或交回，不能耗尽额度寻找偶然通过。
5. 新 W2 原任务已经 ended/partial，旧流程要求不删除、不追认通过。查看技术说明；要继续检查，用户明确建立新版本或新任务，约定具体知识表现。仍活动的旧计划可使用“调整本轮复习”，取消“仅更正来源”并确认新目标；来源调整不能悄悄改变检查标准。Ended/预算耗尽任务沿用原契约开始后续任务。
6. 后续经授权的少量 DS 检查重点是：实际计划是否可观察，followup 是否对应真实前序表现，关联是否覆盖具体要求，单选不称口述，证据足够后是否停止。不要为了复验删困难要求，也不要把原 W2 第四组有真实概念缺口的继续出题当作无限循环。
7. 保留失败时的 SHA、任务/版本、HTTP 状态、安全错误码、公开计划/来源/题目/实际提交、调用账本增量及 UI 截图。不要导出秘密、私有推理或真实用户库。由用户整包手动交回 Cloud 同分支，双方不自动联系。

Windows 聚焦离线回归可复用同一 `cloudEnvironment` 和 Vitest，避免调用含 Linux Redis/Chromium 预检的 `cloud:test` 包装器。下面命令没有硬编码 Windows 用户名或 npm 安装路径：

```powershell
@'
import { spawnSync } from "node:child_process";
import { cloudEnvironment, assertCleanConfig } from "./scripts/cloud/environment.mjs";
const root = process.cwd();
assertCleanConfig(root);
const files = [
  "src/lib/server/learning/agent-budget-generation.test.ts",
  "src/lib/server/learning/agent-review-summary-history.test.ts",
  "src/lib/server/learning/agent-generation-progress.test.ts",
  "src/lib/server/learning/agent-plan-contract.test.ts",
  "src/lib/server/learning/agent-plan-sources.test.ts",
  "src/lib/server/learning/agent-completion.test.ts",
  "src/lib/server/learning/agent-requirement-alignment.test.ts",
  "src/components/learning/learning-agent-completion.test.tsx"
];
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--maxWorkers=2", ...files],
  { cwd: root, env: cloudEnvironment(root, process.env, false), stdio: "inherit" });
process.exitCode = result.status ?? 1;
'@ | node --input-type=module
```

这是 Windows 待执行命令；Cloud 使用正式 `cloud:*` 的通过不替代它的实际运行结果。真实启动继续用原 `agent-trial/launch.mjs start --production --real` 及已获准的安全凭据适配；Guard200 的本地差异需由 Windows 原样保全，不提交功能分支，也不把上述离线命令接到原真实账本目录。

## 已知限制与回退

- 纯流程检测是针对本次确定表达的有限负例；不保证任意自然语言目标可观察或来源蕴含。S32、有限数学检查、模型语义提案不等于 verified、选择题不证明迁移、长期掌握未验证均保留。
- 旧 W2 稳定选项 E 的算术措辞问题未改变唯一答案，原文本/分数原样保留；不据此宣称全部解释已核验。12 道缺失被拒原文不能补造。
- C2 新历史路径排除不合格证据。既有当前版本逐题回顾仍是保存作答/解析的回顾，并非独立内容核验器；不以总结文字覆盖 completion 的争议、已知问题或通过判断。
- 改代码不能自动回退运行期间新写入的计划、题组、反馈、审批或账本。回退前停机一致备份，在独立副本恢复匹配代码/数据；不删新增审计、不回滚账本以恢复额度。旧代码会恢复本次缺陷，不能靠 checkout 旧 SHA 当作安全复验。
- Cloud 仅证明离线工程行为。真实 DS 的可观察计划、语义关联及有效换法仍由 Windows 验收；模拟学生不是教学效果证据。本包结束后不自动启动新阶段、其他 Agent、集成或部署。

## 最终 Cloud 相邻回归完整命令

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
  src/lib/server/learning/agent-budget-generation.test.ts \
  src/lib/server/learning/agent-completion-history.test.ts \
  src/lib/server/learning/agent-completion.test.ts \
  src/lib/server/learning/agent-context.test.ts \
  src/lib/server/learning/agent-explanation-content.test.ts \
  src/lib/server/learning/agent-generation-progress.test.ts \
  src/lib/server/learning/agent-note-content.test.ts \
  src/lib/server/learning/agent-plan-contract.test.ts \
  src/lib/server/learning/agent-plan-sources.test.ts \
  src/lib/server/learning/agent-requirement-alignment.test.ts \
  src/lib/server/learning/agent-review-summary-history.test.ts \
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

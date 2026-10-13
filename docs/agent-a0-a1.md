# Daily Brief Agent A0/A1

本轮范围是共享执行机制和学习页内「自适应复习·试用」。不新增入口，不接入 Work/Date/Daily 业务、网络搜索、shell、全局 Memory 或跨入口总管。原型结束状态不表示已学会、题目正确或生产可用。

当前协作合同：Cloud 交付实际实现和离线工程验收；Windows 在指定提交上验收真实 Provider 和业务；生产部署未执行。后续真实通道步骤见 [Windows 交接](agent-a0-a1-windows.md)。默认体验启动使用离线 Provider，真实模式必须显式选择，不是 Cloud 的日常入口。

## 开源决策与可追溯复用

采用正式 npm 包，直接调用公开接口，不复制上游引擎或维护 fork：

- `@langchain/langgraph@1.5.0`：`StateGraph` 串行执行图、`interrupt`/`Command`、递归限制、AbortSignal。
- `@langchain/langgraph-checkpoint-sqlite@1.1.0`：正式 `SqliteSaver`，复用现有 better-sqlite3；传递 checkpoint 版本为 1.2.0。
- `@langchain/core@1.2.17`：公开 `toJsonSchema`，把工具的同一 Zod 参数契约提供给模型。没有手写第二份参数 schema。

LangGraph 上游 [4510774dd362264f44efd34b29b4f5648eeb4c4c](https://github.com/langchain-ai/langgraphjs/tree/4510774dd362264f44efd34b29b4f5648eeb4c4c) 对应上述 graph/saver tags。实际检查 `libs/langgraph-core/src/pregel/{index,loop,runner,retry}.ts`、`src/interrupt.ts`、`src/graph/state.ts`、中断测试，以及 `libs/checkpoint-sqlite/src/index.ts` 与 checkpoint/migration 测试。MIT 许可证随正式包保留；本项目无复制源码新增 NOTICE 义务。实际主仓安装新增 20 个包；不是零依赖方案，包含 LangSmith、SDK/protocol、tiktoken 等传递依赖，不使用它们的托管服务。

同时深入比较 OpenAI Agents JS core 0.20.0（源码 `89a9ddf1e241e75f2e0ad4c15d89de9e215ebac6`）的 run/RunState/Session/恢复测试，以及 Vercel AI 7.0.138（源码 `6617f11b68273e743a66a271b2b5d91d1e1c6d44`）的 ToolLoopAgent、generate-text、telemetry 和 WorkflowAgent 文档。前者需额外映射自定义模型与持久 RunState/任意等待，且要求 Zod4/OpenAI7；后者工具循环本身不提供持久 SQLite 等待，durable workflow 另需 runtime。只有 LangGraph 一条路线做了最小兼容验证，没有并存第二正式运行时。

版本证据：选定 SQLite 版本包含 [#2516](https://github.com/langchain-ai/langgraphjs/pull/2516) 的 interrupt/resume 写入覆盖修复；源码与发布 dist 都使用 `WRITES_IDX_MAP`。也包含 [#2961](https://github.com/langchain-ai/langgraphjs/pull/2961) 的 task_path 排序/迁移及 checkpoint serializer 安全修复 [#2709](https://github.com/langchain-ai/langgraphjs/pull/2709)、依赖下限修复 [#2714](https://github.com/langchain-ai/langgraphjs/pull/2714)。依据 CHANGELOG、实际实现和测试核对，不以 PR 关闭替代发布证明。

## 三层及状态权威

共享层位于 `src/lib/server/agent/`：图调度、任务/行动/调用/事件持久化、租约、权限回调、统一预算、未知结果和模型协议。它不导入 Learning repository、知识点类型或 Quiz 规则。业务指令通过场景注入。

Learning 适配位于 `src/lib/server/learning/agent-*.ts`：固定材料/章节/知识点及历史/笔记/补充授权，当前来源指纹，7 个 `learning.*` 工具，任务内解释与疑题标记。Quiz 创建、分段生成、真实作答、评分与答案揭示沿用原服务。没有自动写个人笔记或重写框架。

每账号 `agent-tasks.sqlite` 是任务生命周期、授权、预算、事件和行动收据的权威。`agent-checkpoints.sqlite` 是 SDK 执行位置；只保存 taskId/actionId/路由，不存工具原文、模型对话或私有推理。原文观察在每次决策前经当前授权重新读取。Learning SQLite 保存题组/作答及 `learning_agent_artifacts`；后者只负责任务解释和业务引用，不是第二 checkpoint。

等待节点单独调用 interrupt，其前面没有副作用。创建题组使用稳定行动衍生 operation ID；重复事件先去重，丢通知先查原业务结果。未知外部结果不自动再发。正常 waiting 重启可恢复；运行中异常崩溃保守交回 `needs_attention`，不承诺全系统 exactly-once。

## 正式行动协议及预算

协议固定为 `structured_action_v1`：真实模型选择一个受限工具及参数，或请求反馈/交回；本地严格校验，实际执行并重新读取结果，再调用模型。没有原生工具/JSON 隐式回退。

在协作合同更新前的单次授权试验中，原生 Responses 首轮返回实际 function_call，但工具回传轮未取得完整完成事件，重建回传验证收到 HTTP 400；这不证明通道完全不支持，也不能声明原生工具闭环兼容。结构化协议两次历史试验完成读取后决策。合同更新后停止全部真实通道，历史部分证据不作为 Windows 的验收 PASS。当前正式协议为结构化动作，Windows 须验证完整真实链路。

决策配置 `LEARNING_AGENT_DECISION_*` 与工具内部生成 `LEARNING_AGENT_GENERATION_*` 分开；均不修改手动 Learning 默认模型。当前显式支持已采用的 TokenHub/DS 通道，无未知 Provider 回退。API key 只来自受控进程配置，不进入响应/日志/数据库。

每一决策或工具内部生成都经共享 `ctx.call`，按真实调用计数、输入/输出限额和实际计算时间控制。等待时间不计计算时间，未知 usage 为 null，未提供价格不计算虚构金额。LangGraph maxAttempts=1，OpenAI maxRetries=0；unknown 停止。固定 scope、动作白名单、服务端账号、来源重新检查都由程序控制；选择诊断、回源、解释、练习、反馈或交回由模型控制，没有“无历史必测”规则。

四项 LANGSMITH/LANGCHAIN tracing 环境标记在入口禁用。独立负向测试发现仅 callbacks=[] 或 traceable(false) 不足：上层开启 tracing 时尝试请求 api.smith.langchain.com/info（被 mock fetch 拦截）；显式禁用后实际 fetch=0。验收进程另有严格目标限制及持久总网络账本，拒绝其他业务外发。

## 隔离启动与证据

```bash
node scripts/agent-trial/launch.mjs start
node --import tsx scripts/agent-trial/seed.ts
# 默认受控离线 Provider，实际 API / SQLite / Quiz / UI 全部照常运行
node scripts/agent-trial/browser.mjs before-restart
node scripts/agent-trial/launch.mjs stop
node scripts/agent-trial/launch.mjs start
node scripts/agent-trial/browser.mjs after-restart
node scripts/agent-trial/launch.mjs stop
```

默认 loopback `http://127.0.0.1:37951`；仅 `output/agent-a0-a1-offline/data` 内合成资料。默认启动不读取业务密钥，套用 Cloud HTTP/socket 外联保护；受控响应只替换模型传输，不 mock 业务 API、评分、存储或运行图。离线动作选择及生成内容是手工 fixture，调用用量未知，不制造真实 token。生产构建后可 `start --production`。合成账号登录信息保存在忽略目录 `synthetic-accounts.json`，seed 重跑保留课程与冻结哈希。停止不删除课程、题组、任务或作答。

Windows 显式 `--real` 模式使用独立 `output/agent-a0-a1-windows` 和配置中的 `DAILY_BRIEF_OPENAI_API_KEY`；默认不启用。`network-ledger.sqlite` 限制 36 请求/A0最多6、总输入48000字符、输出8000 tokens；硬上限不是调用授权。协议脚本必须带 `--real` 并加载 guard，不能裸跑跳过账本。失败/未知请求也计数，不重置额度。API key、原始 Provider 错误正文不落盘。离线统计另存 `offline-provider.sqlite`，不计作真实请求。启动器与两种 preload 均在写入前拒绝相反模式的 runtime/账本，不能重标旧 fixture。历史已授权试验保留在原 `output/agent-a0-a1`，不覆盖、不续用。

界面保留手动框架、追问和 Quiz。在学习页的同页导航打开「自适应复习·试用」，确认范围与可选历史/笔记/补充，输入目标并开始。等待题组时使用原答题组件，整组提交后明确继续；可以提出疑题，任务停止使用该题组分数判断，而旧答案/成绩保留。可暂停、继续、取消、刷新和重登。

## 本轮 Cloud 实测（2026-10-13）

Cloud 离线工程验收 **PASS**；Windows 真实 Provider 与业务验收 **PENDING**；生产部署 **NOT RUN**。离线决策与生成由明确标注的固定 fixture 提供，以下成绩来自模拟学生通过实际 Quiz UI/API 保存，不证明真实模型选择或教学效果。

- A：任务 `f1b1735a-f7fa-4506-8828-9033c8e501c2`，读取范围/导航 → 创建实际 Quiz `70c43447-fe3b-41f9-86b6-622d317c3822` → 持久等待 → 页面交卷 0/2 → 读取真实作答 → 回源第 6 段 → 保存解释 → 等待反馈。
- B：任务 `f7641f84-370c-4f34-b9ce-f42fcc9d694a`，读取范围/导航及第 3、4 段 → 保存解释 → 等待用户反馈 → 创建实际 Quiz `5ba8f256-1953-4ba8-8051-380ef8766ad7` → 页面交卷 2/2 → 读取真实作答 → 等待反馈。随后通过 UI 取消，已保存题组/作答仍在。
- 两阶段浏览器分别 7 项和 14 项检查通过，退出码均为 0；正常停应用后从生产构建重新启动同一 SQLite 数据，刷新、重登、等待零调用、重复事件零新增、跨账号拒绝及手动框架/Quiz 可达均通过。共 20 次受控离线响应，真实 Provider 网络请求 0；usage 未提供，保持未知。
- 首次第二阶段因 Playwright `check()` 早于受控 radio 的保存回执而失败（退出 1）。脚本现使用正常点击、等待对应 PATCH、再断言 checked；复验读回并保留已保存选择，没有改写答案或分数。首次失败证据保留。
- 最终聚焦与相邻回归为 13 文件、173 用例通过；Cloud check 的 9 项环境契约及完整 TypeScript 通过；production build 通过，trace 清理检查 forbidden=0。未运行全仓测试、历史缺失 PDF fixture、真实音频/设备或真实 Provider 验收。

可重复的最终离线测试命令：

```bash
npm run cloud:test -- src/lib/server/agent/runtime.test.ts src/lib/server/learning/agent-scenario.test.ts src/app/api/learning/agent-routes.test.ts src/components/learning/learning-agent-panel.test.tsx src/components/learning/learning-quiz.test.tsx src/components/learning/learning.test.tsx src/lib/server/learning/quiz.test.ts src/lib/server/learning/quiz-reference.test.ts src/lib/server/learning/quiz-request-resume.test.ts src/lib/server/learning/study.test.ts src/lib/server/learning/repository.test.ts scripts/agent-trial/offline-provider.test.ts scripts/agent-trial/student-policy.test.mjs
npm run cloud:check
npm run cloud:build
```

本地证据在忽略目录 `output/agent-a0-a1-offline`：最终测试/check/build 日志、两阶段结果、轨迹、截图、合成课程与持久任务。进程已停止，保留 A 的反馈等待与 B 的取消状态；同目录启动即可继续体验。Windows 独立 checkout 需运行 seed 重建合成课程，不能依赖 Cloud 忽略目录随 Git 同步。

协作合同更新前按原授权发生过 18 次真实试验请求（协议 5 次），其中 16 次提供的已知 usage 合计 input 29017/output 4466 tokens，另 2 次用量未知，不能当作完整总量或精确费用。合同更新后真实请求为 0。历史试验没有完成最终版本的两条作答后真实闭环，保留为部分兼容证据，不能替代 Windows 验收。

## 阶段边界

A0/A1：本轮共享图、窄场景、任务面板、持久等待与恢复、有界验证；最终实测结果以本轮报告和证据为准。合成教材与手工框架、mock 决策测试、真实模型生成、模拟学生作答是不同证据层。

A2 待补：复杂中途变更目标/授权、完整审批中心、长期调度、运行中崩溃的产品级结果对账交互。不会自动进入后续开发。

A3 待验收：多场景实际复用价值、跨产品任务/权限设计和长期可靠性。非 Learning 假场景仅证明共享层未绑定 Learning，不代表第二产品 Agent 或跨入口总管完成。

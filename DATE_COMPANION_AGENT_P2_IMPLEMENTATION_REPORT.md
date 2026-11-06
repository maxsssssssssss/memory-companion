# 约会陪伴 Agent P2 本地交付报告

现在可以回到原来的「准备」聊天，把见面前留下的事和见面后的实际经历放在一起聊。可以手选一份已确认的相处记录，也可以只说自己的感受。想准备下一次时，建议就在回复里，能直接改、留或放下。

**本地离线验收通过。** 三条流程均使用最终 production build 的正式页面、API、SQLite 和共享 AgentRuntime。账号和录音记录为合成数据，模型传输使用 fixture。P2 真实模型语义质量 **NOT RUN**，真实 LLM、ASR 请求均为 **0**。

## 用户怎样使用

1. 在原讨论里点「用一份相处记录聊聊」，选中想回看的日期和记录，再点「用这份记录」。没有预选项。关掉抽屉而未确认，不会授权。
2. 点「回来记一下」，写下实际经历或在意的问题。在合成场景中，用户原先准备聊旅行，后来觉得 Ta 可能有些累，两人出去走了走。助手找到了 Ta 说想沿河散步的片段，能展开日期、说话人和逐字原话，也能打开对应复盘。回复把“觉得累”归于用户的理解；录下的片段足以核对散步的话题，无法据此断言两人整场都没聊旅行。
3. 想继续时，可直接输入，或在已关联记录里点「接着准备下一次」。这个入口会把问题带回输入框，由用户决定是否发送。验收中用户只要一条，随后在手机上将其改成“见面时先问：‘今天有什么想做的吗？’”，再明确选用。关闭、重开并刷新后，原来的旅行话题和改过的新建议都在，各有自己的相处背景。下次日期仍未定。
4. 可以纠正之前的理解，或在关联记录里点「取消关联」。直接说“不再用这份记录”也能解除本次关联。单独勾选过的历史资料仍可在「资料范围」中管理。没有录音时可以直接反馈或只聊天。

## 三条正式页面流程

| 场景 | 核对到的结果 |
| --- | --- |
| A　选用准备、关联复盘、回顾、准备下一次 | 用户从两份合法候选中手选了一份。每次回顾请求的实际输入均含原选用 ID 与文字，以及原始反馈和 user_reflection 归因。Runtime 先定位关联记录，随后读取原话，再发布带来源的回顾。定位结果未提前包含原话，其他记录及排除的片段未进入输入。实际打开了所选复盘。手机上编辑、选用，随后关页重开、刷新，内容与条目 ID 一致，此段操作新增模型调用 0。 |
| B　只有文字 | 独立账号无录音、无关联、无历史授权。用户谈见面时的不安，回来继续聊。刷新后找回同一段反馈；准备、日期和来源均为空。 |
| C　纠正和撤回 | 用户把“Ta 累了”的理解纠正为自己紧张。后续实际输入携带纠正，回复转向用户自己的感受。撤回后，原始反馈和合法的已选准备仍在。检查本轮全部三次传输的完整输入，包括两页 read_progress，均未发现撤回的原话、派生总结或旧 P1 错误前言。 |

最终批次 3/3 通过，0 跳过，用时 8.7 秒。16 次 fixture 决策的请求 ID 均与相应业务资源的共享调用账本对齐。合成库中 Promise、Memory 条目、Person 事实均为 0，未创建办公数据库；三条 bridge outbox 记录来自预置复盘的确认，准备操作未增加写入。[浏览器日志](output/date-companion-agent-p2/2026-11-05T08-50-27-710Z/browser.log) · [传输与持久化核对](output/date-companion-agent-p2/2026-11-05T08-50-27-710Z/verification.json) · [选用及恢复](output/date-companion-agent-p2/2026-11-05T08-50-27-710Z/A-recovery.json) · [撤回后的实际进展](output/date-companion-agent-p2/2026-11-05T08-50-27-710Z/C-fencing.json)

### 实际画面

桌面聊天中展开来源，可以核对日期、Ta 的原话及原记录入口。

![桌面回顾中的原话和来源入口](output/date-companion-agent-p2/2026-11-05T08-50-27-710Z/A1-reviewed-source.png)

手机 390×844 视口中，新建议、编辑和选用按钮、输入区及关联记录入口均可见。编辑与选用确实在此视口完成。

![手机上编辑或留下一个下次建议](output/date-companion-agent-p2/2026-11-05T08-50-27-710Z/A-mobile-next-option.png)

取消关联后，用户继续聊自己的紧张，原来留下的准备仍可找回。顶部清单在较矮的桌面视口限制高度，可在清单内滚动；聊天记录单独滚动。[撤回后继续聊天](output/date-companion-agent-p2/2026-11-05T08-50-27-710Z/C-withdrawn-record.png) · [两次选用重开后](output/date-companion-agent-p2/2026-11-05T08-50-27-710Z/A2-edited-and-reopened.png) · [无录音的手机讨论](output/date-companion-agent-p2/2026-11-05T08-50-27-710Z/B-discussion-mobile.png)

## 实现和兼容

- 基线为指定工作树的 detached HEAD `ae329e9c45a7eca7e8b4eb09dd83934cfbdb27be` 加既有未提交 P1。沿用 schema 13 的 preparation JSON、事件及操作回执。复盘关联保存记录 ID、日期、单次授权 ID、原选用条目 ID，以及原来与下一次的见面标识。用已有选用、编辑事件还原关联时的原文。旧 P1 讨论按已有事件恢复归属，读取旧数据不会自动关联复盘。[业务类型](src/lib/domain/date-companion-preparation.ts) · [仓储](src/lib/server/date-companion/preparation-repository.ts)
- 已确认、保留且具备可核对 canonical Evidence 的记录可供关联。选定后按账号、当前关系和记录 ID 获取复盘详情，复用已有证据、说话人及指纹检查。Agent 可以先定位当前关联记录，再按需读原话；读取现有承诺仍走原有授权路径。录音及 Toy 导入继续使用既有复盘确认结果。[来源读取](src/lib/server/date-companion/preparation-sources.ts) · [Agent 场景](src/lib/server/date-companion/preparation-agent.ts)
- 关联、解除、编辑和选用走普通版本化 API。独立授权未改动基础资料范围或长期准入。重复回执不会取消较新的生成。撤回或源删除后，核对权限、来源指纹及关联身份；旧生成无法覆盖后来选择。连续回顾同一次见面时能保留用户已经明确的新安排；只有上次日期或只说“下次”时，记录日期不会被写成下次安排。[页面组件](src/components/date-companion/companion-preparation.tsx) · [准备 API](src/app/api/date-companion/preparations)
- 对照和实际读取的依据一起保存。若模型通过上一轮准备或约束间接看到了来源，后续产物也保留这项依赖。撤回后普通对话和分页进展共同屏蔽失效的派生内容。旧 P1 存在未记录跨轮依赖的情况：较早来源失效后，无依据确认的旧派生正文会保守退出模型上下文，用户自己的反馈、选择标识和原始业务记录保留。
- **P1 前言核对。** 已修正的 P1 新写入会留下一条建议和空的自由前言。修复前保存的无来源反馈前言还可能存在于助手消息和进展事件。P2 在读回这两处时统一投影原选项，隔离保留原始数据和调用账本。额外的定向回归在尚未纠正或撤权时读取普通对话和早期进展，验证发给模型的输入不含旧前言，同时验证原事件和 Runtime 行动参数仍保留原文。[专项回归](src/lib/server/date-companion/preparation-agent.test.ts) · [执行日志](output/date-companion-agent-p2/checks/p1-context-probe.log)

## 工程验证

| 检查 | 实际结果 |
| --- | --- |
| 定向 Vitest | `npm test -- --maxWorkers=1 --reporter=verbose` 指定 preparation-agent、preparation-review、preparation-sources、companion-preparation、preparations/routes、relationship-qa、person-source-catalog 七个测试文件。7 文件、70 项通过，exit 0。另用精确测试名核对旧 P1 前言，目标 1 项通过、同文件其余 19 项按名称未运行，exit 0。两次执行分别记录。[定向测试](output/date-companion-agent-p2/checks/focused-tests.log) |
| 类型与差异 | `npm run lint` 完成 Next typegen 及 TypeScript，exit 0。针对最终改动与浏览器脚本的定向 `tsc --noEmit` 和 `git diff --check` 通过。[项目检查](output/date-companion-agent-p2/checks/lint.log) · [最终定向类型检查](output/date-companion-agent-p2/checks/typecheck-final.log) |
| 本地 production build | `npm run build` 含既有 postbuild，最终 BUILD_ID 为 `286kyAMQSaU9ZZBLlXiC4`。46/46 个静态页面生成，188 份 trace 清单，清理后禁用引用为 0。独立输出到 `output/date-companion-agent-p2/production-final`，P1 的 `.next` BUILD_ID 仍为 `o2sOf_SoF_-DU-vgooiaQ`。[最终构建日志](output/date-companion-agent-p2/checks/build-final.log) |
| 浏览器与网络 | `node scripts/run-date-companion-agent-p1.mjs --p2 --reuse-build` 通过相同 dist 启动本机服务与 Chromium，使用独立合成 SQLite。仅模型传输替换为 fixture，浏览器和 Node 网络均有限制。最终批次真实请求 0，意外外部请求拦截数 0。验收进程已退出。[最终运行摘要](output/date-companion-agent-p2/2026-11-05T08-50-27-710Z/summary.json) |

保留了中途失败。最初本机可提交内存不足，定向类型检查及一次测试 worker 启动失败；恢复资源后串行完成。首次隔离构建的临时配置把源码别名解析到了输出目录，webpack 未通过。修正验收配置并验证别名后完成最终构建。首次浏览器的三个场景均在重开后使用独立请求读取状态时返回 401，随后改用页面自身的同源登录态，复用同一产品构建复验。[内存失败日志](output/date-companion-agent-p2/checks/typecheck.log) · [首次构建日志](output/date-companion-agent-p2/checks/build.log) · [首次浏览器日志](output/date-companion-agent-p2/2026-11-05T08-48-46-929Z/browser.log)

## 验证边界

同一讨论同时关联一份复盘；要改用另一份，先明确解除现有关联。撤回这次授权不会删除原复盘或改变其他独立授权。操作可以在没有任何记录时继续。

本轮只验本地接线、授权、状态和页面体验。P1 的真实额度保持 **12/12**，包括原工具格式失败和归因修复的回放证据。P2 新生成的真实语义质量、真机中文键盘和生产运行均为 **NOT RUN**。未提交、推送、部署，工作止于 P2。

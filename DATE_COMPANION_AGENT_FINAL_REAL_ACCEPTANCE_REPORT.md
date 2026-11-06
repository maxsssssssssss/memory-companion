# 约会陪伴 Agent P1—P3 最终真实验收

日期：2026-11-06。用户可以从一条准备开始，手选会后记录，查看真实读取的原话，补充自己的反馈，再编辑、选用一条下一次准备。关闭重开后，旧选择、新选择、原始反馈和关联仍在；下次时间未定时没有沿用上次日期。无录音、无历史的另一账号也完成了只讨论，助手围绕顾虑追问，没有补造往事或生成清单。

**两条指定流程已实际完成，连续流程包含失败后的恢复和定向纠正。新预算使用 11/12 次，unknown 0；剩余 1 次未使用，已停止调用。** 首轮回顾发生格式失败，恢复后又发现一处可见的来源归属错误，均保留原始证据。最终纠正回复通过，不把自动断言通过等同于语义通过，也不将这些样本外推为模型整体稳定性。

## 用户实际看到的结果

| 检查 | 实际结果 |
| --- | --- |
| 数量与选择 | 首次只给一条“准备一个你自己最近想去或去过的地方，等聊到空闲时间时自然地提一句”。下一次也只有一个开场提问条目。均先为 suggested，用户点击后才 selected。 |
| 检索与原话 | 用户手选 2026-11-07 的合成确认复盘；真实模型自行调用 `list_review_sources → read_source → respond`。页面可展开日期、Ta 原话“今天想沿着河边慢慢走，在石拱桥边看看水”，并打开原复盘。不是预置助手答案或只读摘要。 |
| 回顾与归属 | 最终回复分别说明“你之前留下的准备”和“这份录音里 Ta 的原话”，明确录音不能证明用户做过旅行准备。录音没有旅行原话，不能据此认定没聊过。第一次恢复的回顾曾混淆这两类依据，详见失败记录。 |
| 主观理解 | “我觉得 Ta 工作有点累”原文以 `user_reflection` 保存。最终可见建议问“今天累不累”，没有把疲劳当作 Ta 已确认事实。模型原始额外前言仍有问题，现有发布规则将其排除，见下文限制。 |
| 日期 | 首次显式“明天下午（11 月 7 日）”保存为 2026-11-07。会后及下一次日期均为 null。选用内容没有带入旧日期，也没有强迫补日期。 |
| 编辑与重开 | 在 390px 手机视口点击“改一下”，给同一条建议追加“如果当时不想聊，也可以先放下”。页面、PATCH、SQLite、关闭重开文字和条目 ID 一致。当前准备 1 条、以前留下的 1 条，见面归属不同。手动编辑、选用、重开没有模型请求。 |
| 无历史只讨论 | 回复：“这种担心挺自然的，尤其是不确定对方现在怎么看那件事的时候。你是在担心话题本身会重新引发情绪，还是更担心自己不知道怎么开口？”没有虚构过往、建议条目、来源或日期。刷新恢复一致。 |

连续使用在**同一合成账号、同一 SQLite、同一 preparation** 上恢复，没有复制另一条讨论冒充闭环。重新登录使用正式本地会话写入器，先核验原合成账号，再经 `/api/auth/me` 确认；没有重置密码、修改业务正文或注入助手回复。[恢复身份与状态](output/date-companion-agent-final-real/20261106-final/final-recovery-auth-proof.json)

合成场景压缩演示会前、会后两个时段，录音日期人为设为 11 月 7 日；这不是跨自然日真实设备运行测试。原话来自合成的正式确认链路，模型回复均为本轮真实生成。

## 请求、失败与定向复验

使用原约会模型 `deepseek-v4-pro`、正式页面/API/SQLite/shared AgentRuntime。网络守卫逐请求核对调用 ID、场景、业务资源和 generation/version，硬限制 12 次，SDK 重试为 0。P1 历史 12/12 位于原目录，独立保留，账本哈希未变。

沿用真实验收脚本的隔离设置：ASR、其他生成路径和 Memory bridge/consumer 均关闭，避免复盘种子触发额外工作；用户只授予单次记录范围，长期资料开关仍为 false。长期写入结论同时核对准备操作未增加 bridge outbox，不能仅凭禁用消费者后的 Memory 空库断言所有生产配置都已验过。

| 新请求号 | 行为与质量 | 处理 |
| --- | --- | --- |
| 1 | 首次单条准备，通过，明确点击选用。 | 原 P3 构建。 |
| 2—3 | 按“旅行”过滤得到空结果，随后模型返回裸正文；还误称整份关联记录没有原话。 | 第 3 次 Runtime 为 failed，正文未发布。用户输入、选择、关联保留；未自动重试。 |
| 4 | 独立无历史只讨论，通过。 | 未追加行动，刷新正确。 |
| 5—7 | 修复后重新定位、读取原话并回答；接线和页面通过，但第 7 次把“原来准备过什么”说成了录音支持的内容。 | 人工语义审查判为失败，不能用 Runtime succeeded 或浏览器绿色结果掩盖。 |
| 8 | 反馈后给一条下一次建议；编辑、选用、关闭重开通过。 | 原始多余前言被既有规则移除，用户只看到同一个可编辑条目。 |
| 9—11 | 在原讨论明确纠正来源归属，重新定位、读取并解释。 | 最终定向语义通过：准备依据和录音依据分开，没有新增建议或覆盖选择。 |

网络账本 **11 completed，0 unknown，0 active**；共享账本 **10 succeeded、1 failed**，全部逐 ID 对齐，模型、场景和资源一致，完整合成输入与返回哈希核对一致。总计输入 35,215 tokens、输出 790 tokens。已发送的失败也在 11 次之内。第 7 次属于“传输和结构成功、内容判断失败”。[最终对账](output/date-companion-agent-final-real/20261106-final/final-verification.json)

原始失败及实际可见结果：

- [第 3 次裸返回](output/date-companion-agent-final-real/20261106-final/response-003.json) · [首批失败日志](output/date-companion-agent-final-real/20261106-final/browser.log) · [用户看到的失败提示](output/date-companion-agent-final-real/20261106-final/final-1-failure.png)
- [第 7 次归属错误和第 8 次反馈结果](output/date-companion-agent-final-real/20261106-final/final-recovery-quality-review.json) · [第 8 次原始返回](output/date-companion-agent-final-real/20261106-final/response-008.json)
- [最终可见纠正回复](output/date-companion-agent-final-real/20261106-final/final-attribution-visible.json) · [仅本轮新任务的工具证据](output/date-companion-agent-final-real/20261106-final/final-attribution-new-task-ledger.json)

原始第 8 次前言带有“她还是带着疲惫感”的预设；实际页面与助手消息没有保留它。第 9—11 次完整模型输入也不含这段前言或第 3 次无效正文。原始传输及 action 账本继续保存，未以清理上下文为由删除证据。**这证明当前发布和上下文保护生效，不证明裸模型的主观归因或性别措辞已稳定。**

最后的来源解释没有再次接一句“按你的反馈，这次没聊旅行”，衔接仍略生硬；其中“不能据此确定没聊过”明确指录音的证明范围，没有否定用户反馈。此次不再消耗剩余额度打磨措辞。

## 最小修复和工程检查

产品改动仅限 [preparation-agent.ts](src/lib/server/date-companion/preparation-agent.ts)：

1. 空的筛选/分页结果明确不等于整份记录没有原话；工具说明给出省略 query 浏览关联复盘的现有路径。继续使用原权限与 `read_source`，不扩大资料范围。
2. 明确工具返回后仍使用 JSON 动作，通过 `respond` 回复；没有包装非法正文、放松 schema 或添加自动重试。
3. 明确选用记录、录音原话、用户反馈各自支持什么。最终 prompt version 为 `date_companion_p3_v3`。

无新数据库结构、Provider、生产依赖或共享 Runtime 修改。辅助变更为原真实 runner、预算测试、原浏览器 spec 和 Agent 回归测试；两个明确的同账本续跑各有独立 claim/log/summary，旧文件未覆盖。仅接受网络已完整结束且诊断可证的 JSON/schema 失败作为人工复验前提，unknown 仍阻断。

| 实际检查 | 结果与证据 |
| --- | --- |
| 初始预算/网络 guard | 2 文件 47/47。沙箱第一次启动失败，未执行用例；允许本地 worker 后通过。[复验日志](output/date-companion-agent-final-checks/budget-tests-rerun.log) |
| 同账本恢复保护 | 2 文件 49/49，包含前述 47 项的重叠，不累加。覆盖未知、未结束、ID 变化、授权变化和耗尽拒绝；初次环境启动失败也保留。[日志](output/date-companion-agent-final-checks/resume-budget-tests-rerun.log) |
| 第一处修复 | Agent、来源、复盘、共享模型 4 文件 62/62。含本轮第 3 次原始返回的精确离线回放，验证失败不发布、不重试、选择和用户输入保留。[日志](output/date-companion-agent-final-checks/fix-tests.log) |
| 第二处修复 | 受影响 Agent 文件 27/27，是上批子集。[日志](output/date-companion-agent-final-checks/attribution-tests.log) |
| 类型与差异 | 初始及第一次修复 `npm run lint`（Next typegen + TypeScript）exit 0；最终版本 production build 自带类型检查通过；最终 `git diff --check` exit 0。[lint](output/date-companion-agent-final-checks/fix-lint.log) |
| 构建与受影响页面 | 两次产品修复分别构建，均含 postbuild，各只复验关联记录 A 流程，1/1，通过，无真实请求。最终构建 46/46 静态页、188 份 trace、forbidden 0。[最终构建和页面日志](output/date-companion-agent-final-checks/attribution-build-browser.log) |

真实浏览器首批为 2 条流程：1 通过、1 失败，exit 1；第一轮恢复 1/1、exit 0，但人工另指出第 7 次内容错误；最终归属纠正 1/1、exit 0。恢复和纠正是同一连续流程的复验，不计成额外独立场景。

**构建边界：** 初始两流程使用 P3 `RdaWHDYVlAS_lOA17MxkJ`；完成回顾、反馈、选用和重开使用第一处修复构建 `oIQ-orWmg_dELG0v4C_1Z`；最终来源归属纠正使用 `d2Xgdb0QX4f1Z4k1dIqf8`。最终构建位于 `output/date-companion-agent-p3/2026-11-06T02-53-54-768Z/production`。没有在最终版本重新从零跑全链或再次生成无历史回复；采用的是有证据绑定的定向复验。[最终产品文件哈希](output/date-companion-agent-final-checks/release-final-scope.json)

## 页面与数据

已实际查看桌面、手机的真实回复、来源、失败提示、编辑和恢复截图。桌面 1280×720 页面高 720px、消息区内部滚动；手机 390×844 及缩短视口 390×480 无横向溢出，发送按钮底边分别为 780px、420px。页面没有工具轨迹、JSON 或内部判断卡。[尺寸、文字与条目身份](output/date-companion-agent-final-real/20261106-final/final-recovery-continuous-layout-and-identity.json)

![手机看到反馈和唯一可选建议](output/date-companion-agent-final-real/20261106-final/final-recovery-mobile-next-option.png)

![桌面关闭重开：当前准备与折叠过往选择](output/date-companion-agent-final-real/20261106-final/final-recovery-desktop-reopened.png)

![无历史时只讨论顾虑](output/date-companion-agent-final-real/20261106-final/final-discussion-mobile-reply.png)

最终纠正的[桌面画面](output/date-companion-agent-final-real/20261106-final/final-attribution-desktop.png)与完整可见文本另存。最终手机截图仍停在旧反馈和已选内容的阅读位置，未被强制带到最新消息；它不是最新回复的整屏截图。

业务库最后有两段讨论。连续讨论保留两条不同归属的已选内容、1 条原始 `user_reflection` 反馈及明确关联，日期为空；无历史讨论没有准备。Promise 0、Memory items 0、Person facts/entities 0、办公数据库不存在。唯一 bridge 事件来自预置复盘确认，准备操作未增加。编辑、选用、重开前后请求数均为 8。最终纠正后旧条目、反馈、关联和历史事件继续保留。[关闭重开](output/date-companion-agent-final-real/20261106-final/final-recovery-closed-reopened.json) · [纠正后再刷新](output/date-companion-agent-final-real/20261106-final/final-attribution-reloaded.json)

## 交付边界和未验证项

- 当前工作区仍为 `C:\Users\50245\.codex\worktrees\date-companion-agent-p1\daily-brief-source-20260708-122232`，HEAD `ae329e9c45a7eca7e8b4eb09dd83934cfbdb27be` 加原 P1—P3 dirty 和本轮最小修改。未提交、推送、部署，没有合并其他工作区 dirty。
- **真实 LLM：本轮上述两条合成流程和定向复验已执行。** 旧 P1 12/12、历史失败与回放独立保留。此前 P2/P3 的离线报告仍是其当时结论；本报告只补充本轮实际覆盖，不把回放当作新的生成。
- **真实 ASR、其他 Provider、生产访问/验收：NOT RUN。** 未读取服务器配置、数据库或日志。正式模型调用是当前明确授权范围，业务应用和数据均在本地隔离环境。
- **真机中文键盘：NOT RUN，待人工快检。** 当前未提供可控制的触屏真机。移动视口检查不能证明拼音候选栏、安全区、键盘展开/收起或真机滚动恢复。
- 来源修改、撤回、晚到结果和长上下文的广泛边界沿用 P3 离线证据，本轮未扩展为真实全量验收。最终不经用户纠正的一次性全链语义质量没有额外复验；不能由这一条纠正成功推定普遍稳定。
- 本任务启动的本地服务均停止，所有使用端口均已释放。[退出及端口核对](output/date-companion-agent-final-checks/ports-after.json) 数据、授权、输入、原始返回、失败和账本均保留在 `output/date-companion-agent-final-real/20261106-final/`。

本轮完成后停止，剩余 1 次不自动使用。发布、真机快检或后续真实验收需按下一步明确安排进行。

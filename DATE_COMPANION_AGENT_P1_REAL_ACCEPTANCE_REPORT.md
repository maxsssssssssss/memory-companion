# 约会陪伴 P1：轻量真实验收

**修复后的结果**　回来反馈并要一个小建议时，现在可以在回复里直接留下那一条。重开会找回原选择、实际反馈和后来选用的建议。最终修复已通过真实失败输出的离线页面回放。三批真实请求已用满 12 次，原始失败保留在下文。[四项修复及定向复验](#targeted-retest)

2026-11-05，本地生产构建、两个新建合成账号、真实约会模型。**结果：部分通过。** 原话能查准，选择可保存并跨关闭恢复，回来反馈确实改变了帮助。反馈后的建议没有严格服从用户指定的数量，还沿用了不再确定的日期。无历史账号能只讨论，不会生成准备清单。

## 用户实际看到的结果

| 操作 | 核对结果 |
| --- | --- |
| 允许使用一条已确认的旅行记录，询问 Ta 原话和一个轻松的准备 | 实际调用 search_records、read_source、respond。回复正确指出 2026-11-01，逐字引用“旅行时我更想在海边慢慢散步。”，引用的说话人是 Ta。展开后看到日期、原话与指向该记录的入口。生成 1 条可选准备，未自动选用。 |
| 点“留下这条”，关闭页面后重开 | 同一讨论、同一条目 ID 与正文仍为 selected。没有生成请求，也没有把它变成承诺。 |
| 告知上次没聊旅行、觉得 Ta 工作累、实际安静散了步，只要一个下次建议 | 原始反馈以 user_reflection 保存。第 4 次真实请求的已选 ID、选用正文和反馈原文哈希均与保存记录相符。回复从聊旅行转为“坐坐还是走走”；刷新后原选择未改变，新建议也均未自动采纳。**数量断言失败：要求 1 条，实际登记 2 条。** |
| 新账号明确不用历史，只想讨论提起分歧的顾虑 | 1 次真实请求。没有杜撰旧事、引用历史或登记建议，结尾聚焦“更担心对方的反应，还是自己开口时的不自然”。浏览器断言通过。语气仍有轻微越界：“你不一定需要主动提起”带有用户谢绝的行动建议。 |

**反馈轮另有两处内容问题。** 用户回来反馈后只说“下次”，助手却写“明天下午”，把上轮的时间当作新的安排。正文提出咖啡馆、河边或公园，页面条目则是询问坐还是走、该怎么回应；两处没有呈现同一条可执行建议。其中“那会儿累坏了吧”也将“我觉得 Ta 那天工作很累”说得更肯定。这些问题来自本轮真实生成；选用、恢复和反馈传递有独立证据支持，不是数据丢失。

建议先复用这组失败样本，核对反馈轮只保留仍有效的时态和约束、仅输出用户要的条数、同一建议同时用于正文和可选条目，并保留用户转述的归因。不要靠截断已显示条目或重生成一遍掩盖差异。本轮仅验收，未修改产品或 prompt。

## 请求与验证

- 工作区基线：`ae329e9c45a7eca7e8b4eb09dd83934cfbdb27be` 加当前 P1 未提交改动，沿用上轮通过的生产构建 `DxbHwaMV8txZNzsw7qBVq`。产品非测试源码均未晚于该构建。不重新 build、postbuild 或运行全仓测试。
- 唯一真实批次：`node scripts/run-date-companion-agent-real.mjs 20261105-p1-light`。正式页面、API、SQLite、共享 Runtime 和约会产品模型 `deepseek-v4-pro`，未注入模型回复。执行前验证已有产品配置、隔离数据目录、预算文件与进程守卫就绪证明；没有额外模型探测。浏览器仅访问本机应用，未连接生产、ASR 或其他 Provider。
- **真实请求 5/12**：主流程首次检索、阅读、回答 3 次，回来反馈 1 次，无历史讨论 1 次。全部 HTTP 200 且返回完整完成事件；网络请求 ID、共享账本的成功状态、模型及用量逐项相符。输入 9,015 tokens，输出 687 tokens。0 未知、0 遗留运行中调用，未重试。没有为追求全绿使用剩余 7 次。
- 核对 2 个准备对象；Promise=0、Memory items=0、Person facts=0，办公数据库不存在，复盘种子的 bridge 事件未因准备操作增加。本次本地服务已停止，原 PID 和端口均无监听进程。
- 正式浏览器结果：**1 文件、2 用例，1 通过、1 失败，0 跳过，exit 1**；唯一失败断言是反馈生成数量 2 ≠ 1。使用软断言保留失败，同时继续验证刷新、原选择不变和新建议未采纳。网络成功不等于语义通过。
- 验收辅助代码：`scripts/run-date-companion-agent-real.mjs`、`e2e/date-companion-agent-real.spec.ts`、既有 `scripts/reflection-thinking-real-network-guard.cjs` 及其测试。守卫复用原 12 次事务计数；约会请求预留前核对约会库内 running call、scenario、kind、资源、generation 和 version。未新增生产依赖或产品配置。守卫定向 Vitest 1 文件 / 44 例均通过（含 8 条约会场景回归），exit 0；`npm run lint`（含类型检查）及 `git diff --check` 通过。
- [传输统计与进程退出](output/date-companion-agent-real/20261105-p1-light/summary.json) · [逐项对账结果](output/date-companion-agent-real/20261105-p1-light/verification.json) · [真实浏览器日志，含失败断言](output/date-companion-agent-real/20261105-p1-light/browser.log)。证据与失败保留在本次独立目录；未动历史账本、未提交、推送、部署。

## 实际画面

桌面来源可展开，能看清日期、原话和原记录入口；重开后顶部保留一条已选准备。

![桌面核对原话](output/date-companion-agent-real/20261105-p1-light/history-verified-source.png)

![桌面重开反馈](output/date-companion-agent-real/20261105-p1-light/history-feedback-reloaded.png)

手机 390×844 的真实对话与缩短到 390×480 的视口均已查看。消息内部滚动，未见横向溢出，输入与发送留在可见区域。

![手机无历史讨论](output/date-companion-agent-real/20261105-p1-light/discussion-mobile-reply.png)

![缩短视口下的输入区](output/date-companion-agent-real/20261105-p1-light/discussion-mobile-short-viewport.png)

**发布前快检（待做）**：在一台实际触屏手机打开准备页，唤起中文键盘，输入并发送一条文字，核对候选栏和安全区不遮住发送按钮；收起键盘后检查滚动位置和输入区恢复。本次只验证浏览器移动视口，未做真机或生产验收。两个合成场景的结果也不能外推真实用户总体质量。

<a id="targeted-retest"></a>

## 四项修复及定向复验

用户回来写下“我觉得 Ta 那天工作很累”，希望得到一个下次见面的小建议。最终页面保留用户原话，下面是一条可以直接选用的建议。旧的“明天下午”只属于上一次准备。点击“留下这条”后关闭、重开，原选择和新选择都能找回。

| 用户关心的事 | 实现和核对结果 |
| --- | --- |
| 只要一条 | 本轮数量上限进入正式模型请求中的工具参数，发布前再次校验。重放先前的两条越界输出会拒绝整次发布，保留反馈和已选项，无自动重试。明确要两个方案的用例仍能登记两条。 |
| 时间未定 | 收到见面后的反馈时重新确定当前意图、日期和约束。之前的目标和选择仍可回看，带有此前见面的标记。既有数据中无法确认属于哪次见面的日期不会带入下次。定向用例分别验证未给新日期、明确新日期、同次见面只改地点。 |
| 看到什么就留下什么 | 每条可选准备直接显示在生成它的助手回复里。展示、修改、选用和重开复用同一条目 ID 和文字。用户留下一条调整前，旧选择保持原状。 |
| 主观归因 | 第 8 次真实返回的额外正文把“我觉得”写成了“照顾到 Ta 累了”。最终发布规则处理用户回来反馈、有一条建议且本轮未阅读个人来源的情形，只发布可选条目本身。用户的原始反馈保留为 user_reflection。只讨论的回答和本轮核对过的原话仍可正常显示。 |

### 真实请求及失败经过

- 前一轮用去 5 次，本轮新增 7 次。新批次继承已封存的网络账本副本并逐 ID 对齐各批业务账本。累计 **12/12**，输入 23,093 tokens、输出 1,125 tokens、0 未知、0 在途。共享调用 11 次 succeeded、1 次 failed。全部请求均已纳入预算。[三批逐项对账](output/date-companion-agent-real/20261105-p1-light-retest-feedback/verification.json)
- 本轮首批 2 个真实用例均失败。第 6 次把 reason 放入检索工具的参数对象，第 7 次返回了缺少工具外层的回复。场景校验阻止发布。随后在约会场景加入合法的检索和回复示例，保留共享 Runtime 和原有严格校验。[两条失败记录](output/date-companion-agent-real/20261105-p1-light-retest/browser.log)
- 最后一批真实浏览器 **3/3**。第 8 次在独立账号预置一条已选准备后，以真实模型处理返回反馈；新建议 1 条、日期为空，选用和重开新增模型调用为 0。第 9 次在新账号只讨论，围绕“显得太认真”的顾虑提问，准备条目和历史来源均为 0。第 10–12 次在另一账号依次检索、阅读和回答，日期、逐字原话及说话人均与获准记录相符。三个账号各自检查业务结果，未将其算作同一真实账号完整重跑。没有额外 Memory、Person、Promise 或办公写入。[浏览器记录](output/date-companion-agent-real/20261105-p1-light-retest-feedback/browser.log) · [真实反馈页面](output/date-companion-agent-real/20261105-p1-light-retest-feedback/independent-feedback-visible-turn.json)
- 逐字复核发现第 8 次的屏幕正文仍多给了做法，并把用户的印象说得过于肯定。到达真实预算上限后，修正单条反馈的发布规则。将**同一份第 8 次返回**经离线模型传输送回最终构建，再走正式页面、API、SQLite 和共享 Runtime。原反馈摘要匹配，额外正文没有进入助手消息，唯一条目的文字与原返回中的建议逐字一致，手动选用后两条选择均恢复。该建议含一个有条件的后续问句；此次验证的是一个完整选项的呈现和保存。最终版本的新生成措辞仍待另行有预算验证。[原始返回](output/date-companion-agent-real/20261105-p1-light-retest-feedback/response-008.json) · [最终回放对账](output/date-companion-agent-p1/2026-11-05T06-52-25-452Z/replay-verification.json)

### 最终工程检查

- 目标工作树 HEAD 为 `ae329e9c45a7eca7e8b4eb09dd83934cfbdb27be`，包含当前未提交 P1 改动。最终定向 Vitest **6 文件、80/80** 通过，覆盖 Agent、来源、API、页面和两组请求守卫。最终构建 **`o2sOf_SoF_-DU-vgooiaQ`** 完成 46/46 静态页面和既有 postbuild，188 个 trace 清单，残留禁用引用 0。最终离线浏览器 **3/3**，真实请求 0。[测试日志](output/date-companion-agent-p1/20261105-targeted-types/canonical-tests.log) · [构建日志](output/date-companion-agent-p1/20261105-targeted-types/build-canonical.log) · [最终页面流程](output/date-companion-agent-p1/2026-11-05T06-52-25-452Z/summary.json)
- 受影响代码、浏览器用例及其依赖的 TypeScript 检查通过。全项目 `npm run lint` 的 Next typegen 成功，TypeScript 遇到 Windows 提交内存不足，调整堆容量后仍中止。首次定向配置漏掉 Vitest matcher 和本地类型声明，补入项目既有声明后通过。构建曾遇到守卫路径、沙箱 worker 和内存错误，修正路径、允许本地 worker 并限制并行后通过。构建采用同一份定向类型配置；全仓 lint 未取得通过结论。未运行全仓测试、真实 ASR、生产访问或真机键盘检查。保留旧工作区、数据库、失败证据和调用账本，未提交、推送、部署。

桌面图为最终构建回放第 8 次真实返回的结果。回放中的“留下这条”直接操作所示建议。

![最终桌面反馈回放](output/date-companion-agent-p1/2026-11-05T06-52-25-452Z/03-feedback-desktop.png)

手机 390×844 回放中，用户原话、唯一可选条目及输入区同时可见。

![最终手机反馈回放](output/date-companion-agent-p1/2026-11-05T06-52-25-452Z/03-feedback-mobile-replay.png)

真实检索展开后可核对日期、Ta 的原话并打开原记录。[真实桌面原话画面](output/date-companion-agent-real/20261105-p1-light-retest-feedback/independent-quote-verified.png) · [真实手机只讨论画面](output/date-companion-agent-real/20261105-p1-light-retest-feedback/independent-discussion-mobile-reply.png)

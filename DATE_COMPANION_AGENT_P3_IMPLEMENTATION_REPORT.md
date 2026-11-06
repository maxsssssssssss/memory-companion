# 约会陪伴 Agent P3 本地交付报告

打开约会首页，可以从一句话开始，也可以从录音开始。回到一段讨论时，先看到这次仍想记得的事；想知道以前打算过什么，可以展开「以前留下的」，或直接问助手。用户可以把已确认复盘用于这段讨论，也可以只写自己的感受。没有新进展时，可以放下这段聊天，回来再接着说。

## 持续使用的实际行为

- 「聊过的」能打开先前的讨论。选中讨论后，刷新同一个地址可回到该段。历史标题保留最初的话，当前页显示最近表达。已有准备放在所属见面下；用户明确放下某条后，仍能看到它当时被选用过。只说“上次没用上”会留下反馈。
- 聊天里可以找回很早的一次选用和当时的原因。最近反馈、明确纠正、过往选择有各自的归属。用户明确说又见了一次，会开始新的相处阶段，上一场日期和约束不会顺延。旧关联仍可作为早先见面的资料；要换一份复盘须由用户主动选择。
- 用户要一条下一次建议时，回复中的条目可以直接修改、选用和重开。改选、暂停或只谈感受，都可以接着原讨论。阅读旧消息时保留滚动位置。手机和桌面分别检查输入、来源和选用，详见下文。
- 已知生成中断时，页面提示用户的话已保存，并可接着说。网络中断而提交结果未知时，当前页保留草稿和原请求标识，可以先「重新读取」。停止等待只中止本次等待；已确认版本冲突后重读再发送，才使用新版本。未发送的草稿不保证在关页后恢复。
- 首页和资料范围中的「回看准备卡」保留原卡的读取权限。某条明确约定已经在单次复盘确认时，原复盘可以查看；它是否进入跨次准备卡，还取决于原话与归属是否已获长期准入。聊天里关联一份复盘不会改变这个设置。人物映射、长期保留设置与 Promise 的完成或恢复继续走原入口。[原卡数据筛选](src/lib/client/date-companion-adapter.ts)
- 普通录音与 Toy 仍走原上传路径。确认前可改复盘整理文字；确认后按既有规则只读，可以展开原话。修改后的来源指纹校验在隔离库直接制造原话版本变化进行了验证，没有放开已确认复盘的编辑权限。

## 三组正式页面验收

**本地离线通过。** 三组使用同一最终 production build `RdaWHDYVlAS_lOA17MxkJ`，正式页面、API、SQLite、共享 Runtime 与调用账本实际运行。仅模型传输使用本地 fixture。B、C 在最终构建的三组批次通过，A 在同一构建的单组复验通过。实际 LLM、ASR、其他 Provider 请求均为 **0**。

| 流程 | 实际核对 |
| --- | --- |
| A　旧入口和数据 | 新账号在首页既能输入，也能显式打开录音及 Toy 选择。打开原准备卡，检查一个已存在但未经长期准入的 Promise 在原复盘可见、在跨次卡不显示。回到合成 P1 讨论，未自动关联复盘；随后手选记录，实际经工具定位和阅读原话，展开来源并打开原记录。编辑、选用下一条并关页重开，原始反馈、选择、关联和早期事件 ID 保留。另查了无人物映射时的人物与长期保留入口。[A 的恢复数据](output/date-companion-agent-p3/2026-11-05T09-43-52-500Z/A-compatible.json) · [A 单独复验日志](output/date-companion-agent-p3/2026-11-05T09-43-52-500Z/browser.log) |
| B　持续使用 | 从无历史首页只聊天，刷新回到刚建立的讨论。长讨论在重开时有 29 条消息、32 个事件。关于旧车票的原始表达在最近消息窗口之外，助手实际翻到第一页后才回答。结合最新纠正和反馈给一条无日期建议，在手机视口修改并选用，重开后条目 ID、文字与归属相符。没有新进展时只聊天，之后明确放下该条仍保留历史，并可暂停。桌面页面高 720px，消息区内部滚动。宽 390px 的手机在高 844px、480px 时输入框与发送按钮底边分别为 780px、420px。[分页、选用与视口实测](output/date-companion-agent-p3/2026-11-05T09-37-45-776Z/B-continuity.json) |
| C　来源变化和晚到结果 | 直接读回 schema 13 的 P2 历史关联和对照。纠正后，第一标签页在取到原话后等待；另一标签页解除关联，正式 PATCH 成功后才释放旧传输。前后业务版本均为 11，旧回答和旧建议均未落库。两次已完成工具决策在账本中为 succeeded，在途请求为 unknown，任务为 cancelled。后续完整模型输入及两个非空进展页排除了撤回原话和派生内容，用户反馈、纠正与合法选用仍在。[C 的版本与账本](output/date-companion-agent-p3/2026-11-05T09-37-45-776Z/C-fence.json) · [完整合成传输](output/date-companion-agent-p3/2026-11-05T09-37-45-776Z/fixture-inputs.jsonl) |

核对两批各自的传输 ID、业务资源和账本：B/C 所在批次为 14 条（含上述 1 条 unknown），A 最终复验为 4 条。两批均无 running 调用、意外外部尝试、Memory 条目、Person 实体或办公库写入；各自预置的 Promise 仍为 open。两批的 bridge 事件均来自复盘种子。验证用本机监听均已释放。[持久化与调用对账](output/date-companion-agent-p3/checks/final-verification.json)

**实际画面。** 无历史的[首次进入](output/date-companion-agent-p3/2026-11-05T09-37-45-776Z/A-first-visit.png)可以直接开聊。下图分别是展开原话、手机上选用前，以及桌面重开后。

![打开关联记录的原话和日期](output/date-companion-agent-p3/2026-11-05T09-43-52-500Z/A-linked-source.png)

![390 像素移动视口中的单条建议和输入区](output/date-companion-agent-p3/2026-11-05T09-37-45-776Z/B-mobile-option.png)

![桌面重开后当前准备可见，过往准备收起](output/date-companion-agent-p3/2026-11-05T09-37-45-776Z/B-desktop-reopened.png)

## 实现与升级

本地路径为 `C:\Users\50245\.codex\worktrees\date-companion-agent-p1\daily-brief-source-20260708-122232`。起点是 detached HEAD `ae329e9c45a7eca7e8b4eb09dd83934cfbdb27be` 和当前未提交的 P1、P2。起始状态见[工作树清单](output/date-companion-agent-p3/checks/starting-status.txt)。未从其他 checkout 合并 dirty，没有生成提交。

1. 在 preparation 的消息、条目和事件上复用既有见面标识、选用状态及授权。明确的放下操作与用户原话同一事务入库，记录此前选用状态与对应输入。歧义时保留原决定。纠正、暂停、改选、撤回仍使用账号与关系校验、操作回执、版本与 generation fencing。[业务类型](src/lib/domain/date-companion-preparation.ts) · [仓储](src/lib/server/date-companion/preparation-repository.ts)
2. Date Companion 场景使用既有 AgentRuntime、AgentStore、`agentDecisionRequest` 和约会模型配置。普通上下文优先保留当前表达、反馈、纠正和选择。按实际传输序列化长度收缩已读页和较低优先级内容；历史保留在 SQLite，`read_progress` 返回事件原文、当时的归属、现在的选用状态和下一页位置。仍沿用每轮 8 次调用、每次 48,000 字符等上限，必要输入本身超限时以已有失败流程收口。[场景与来源约束](src/lib/server/date-companion/preparation-agent.ts) · [共享请求构造](src/lib/server/agent/model.ts)
3. 先前生成、已放下选用及来源派生内容沿用已有指纹检查。一个工具步骤读完原话后，若原文、许可或授权代次变化，继续执行前重新核对。普通消息和分页历史都屏蔽失效资料与已知 P1 错误前言；原始存储、历史模型返回和调用账本保留。测试分别覆盖语义相近但指纹不同的替换原话、源删除和用户撤权。[来源适配](src/lib/server/date-companion/preparation-sources.ts) · [定向回归](src/lib/server/date-companion/preparation-agent.test.ts)
4. UI 复用原约会壳、组件和样式。原卡片仅在显式打开时加载详情，查看卡片不会扩大聊天的历史授权。当前聊天、旧卡和复盘都在原产品空间内；没有新增产品入口、Provider、共享执行框架或生产依赖。[约会壳](src/components/date-companion/date-companion-shell.tsx) · [准备聊天](src/components/date-companion/companion-preparation.tsx) · [原准备卡](src/components/date-companion/companion-prepare.tsx)

| 数据路径 | 隔离验证结果 |
| --- | --- |
| 老约会库 v12 → v13 | 正式迁移追加 preparation JSON 表和账号操作回执表。合成 v12 的原始关系、已确认复盘、Evidence 和 Promise 行逐项保留；重复迁移保持稳定，准备和授权初始为空。P3 沿用 v13。[迁移实现](src/lib/server/date-companion/schema.ts) · [升级断言](src/lib/server/date-companion/schema.test.ts) |
| v13，旧 P1/P2 → P3 | 分别运行保留的 P1、P2 生产模块在独立合成库写出真实旧形状。P3 读取不写库；首次普通写回后旧消息、已选项、原始反馈、事件、来源依赖和既有关联保持，版本各增 1，bridge 增量 0。旧 P1 无关联仍无关联；缺失会面归属从可辨认事件补齐。处于反馈后的无归属旧日期按未知处理。[正向探针](output/date-companion-agent-p3/compatibility-2026-11-05T09-21-35-247Z/upgrade-originals/proof.json) |
| P3 → 旧 P1/P2 | 两个历史构建在合成数据库副本上能读取、暂停、写回，新字段在这条路径上获保留。但 P1 无关联语义，新消息缺少见面字段；P2 能读原关联，未能为探针中又一次见面推进归属。两者均未向旧模型投影已撤回选择的历史含义。旧代码写入后，只能还原有证据的归属。[回退探针及编译块哈希](output/date-companion-agent-p3/compatibility-2026-11-05T09-21-35-247Z/proof.json) |

## 工程检查与保留的失败

- 使用 Vitest 定向运行。最终 preparation-agent、preparation-review、preparation-sources 三文件 **41/41**；仓储 9 项、schema 5 项分别通过。聊天组件 18 项、首页组件 12 项通过。相邻回归命令 `npm test -- --maxWorkers=1 --reporter=verbose` 指定约会 shell、screen page、旧准备卡、人物、复盘、preparation API、约会仓储、person-source-catalog 八文件，**124/124，exit 0**。其中有权限、幂等、取消、晚到保护及原复盘编辑约束的既有和新增断言；各次运行有交集，未累加为独立用例数。[相邻文件与断言日志](output/date-companion-agent-p3/checks/adjacent-rerun.log) · [聊天恢复测试](src/components/date-companion/companion-preparation.test.tsx) · [仓储测试](src/lib/server/date-companion/preparation-review.test.ts)
- `npm run lint`（Next typegen 与 TypeScript）、`git diff --check` 通过。用 `node scripts/run-date-companion-agent-p1.mjs --p3` 在单独目录运行 `npm run build` 与既有 postbuild。最终 46/46 个静态页面，188 份 trace 清单，移除 3,803 个越界引用后剩余禁用引用 0。16 个改动产品文件的当前哈希与最终清单一致。原 P1、P2 构建及真实账本保留。[最终类型检查](output/date-companion-agent-p3/checks/lint-final.log) · [最终构建及 postbuild](output/date-companion-agent-p3/2026-11-05T09-37-45-776Z/build.log)
- 初次 Vitest 在沙箱内启动子进程遇到 `spawn EPERM`，尚未执行用例，切换允许的本地进程后复验。领域测试首次发现混合 JSON 缺失消息归属时没有从已有事件还原原选择，已修复。组件测试首次发现解除关联后下一次准备的标签丢失，改为按已有事件还原后通过。[环境启动失败](output/date-companion-agent-p3/checks/adjacent.log)
- 首次实页批次 B/C 通过，A 发现聊天 CSS 隐藏首页录音按钮。已把隐藏规则限制为空导航区，原准备卡恢复普通长页布局，同时修复从首页发首条消息后的刷新地址；最终产品因此重新构建。最终构建首次联合跑 B/C 通过，A 的验收断言误把单次复盘确认当作长期准入。按原 adapter 改为核对原复盘内可见、跨次卡受限。后一次复验点击切页后过早刷新，浏览器仍处于旧卡；该次用例名过滤也额外匹配了 B，B 通过。改为等待聊天加载再刷新，并精确过滤 A，复用同一构建完成 A，**1 文件、1/1，exit 0**。没有改动确认与长期准入规则。[首次实页失败](output/date-companion-agent-p3/2026-11-05T09-31-48-845Z/browser.log) · [最终构建联合批次](output/date-companion-agent-p3/2026-11-05T09-37-45-776Z/browser.log) · [切页复验记录](output/date-companion-agent-p3/2026-11-05T09-42-25-693Z/browser.log) · [最终 A 结果](output/date-companion-agent-p3/2026-11-05T09-43-52-500Z/summary.json)

## 发布与回退边界

- 发布候选是经验证的本地工作树，包含原 P1 schema 13、preparation API、共享运行时依赖、P2 的复盘来源检查，以及本轮的仓储、场景和界面。裸 HEAD 属于更早的功能集。正式交付前应把所需文件作为同一版本保存并记录构建标识。[相对 HEAD 的 16 个产品文件及 SHA-256](output/date-companion-agent-p3/checks/release-scope.json)
- 部署前应在实际环境获授权后核实数据根目录，并制作可恢复的一致性备份。覆盖 `date-companion.sqlite`（复盘、Evidence、Promise、授权、preparation、回执、Agent 调用账本）、`date-preparation-checkpoints.sqlite`、关系引用的 `memory.sqlite`（含 Person 与准入状态），以及账号映射、每账号上传与来源文件、相关索引/存储。在写入静止时做完整副本，或用 SQLite 支持的一致性备份获得同一恢复点；直接复制运行中库的主文件可能遗漏 WAL。保留对应代码/构建、受保护的配置、独立真实验收账本和失败证据。此次只核对了本地存储实现。[约会库](src/lib/server/date-companion/db.ts) · [数据路径](src/lib/server/storage/paths.ts) · [账号存储](src/lib/server/auth/session.ts)
- 优先恢复能够理解新旧 JSON 的 P3 版本。P2 构建 `286kyAMQSaU9ZZBLlXiC4` 与 P1 构建 `o2sOf_SoF_-DU-vgooiaQ` 是本地可考证的历史候选，用副本评估后再决定如何恢复。HEAD 的 v12 初始化器在探针中保留 v13 行，但既有 Memory bridge preflight 判定 `date_companion_schema_incompatible`。旧版本不能直接作为可安全续写现库的替代。必须回到旧版本时，先停写、保全当前完整副本，再在隔离副本上验证与该版本匹配的备份；回到升级前备份会缺少备份后进展，需保留增量并单独核对恢复。禁止以删字段或下调版本号处理差异。
- 真实运行环境的版本、数据目录、备份可恢复性、配置及服务状态均未核实。无提交、推送、部署或生产读取。

## 历史真实证据与待验事项

P1 真实请求累计 **12/12**。历史中存在数量、旧日期、正文不一致、主观归因和工具格式失败；第 6、7 次的原始失败保留，第 8 次真实返回保留了错误前言。最终归因呈现规则用同一份真实返回做过离线回放，证实其处理、展示及保存行为。修复后新生成的语义质量未由回放验证。[P1 真实报告](DATE_COMPANION_AGENT_P1_REAL_ACCEPTANCE_REPORT.md) · [原始返回](output/date-companion-agent-real/20261105-p1-light-retest-feedback/response-008.json) · [回放证据](output/date-companion-agent-p1/2026-11-05T06-52-25-452Z/replay-verification.json)

**P2/P3 新生成的真实语义质量 NOT RUN。生产验收 NOT RUN。** 真机中文键盘、拼音选词、键盘展开/收起与安全区留作发布前快检。P2 离线结果独立保存于 [P2 报告](DATE_COMPANION_AGENT_P2_IMPLEMENTATION_REPORT.md)。

后续若另行授权，建议新预算**最多 12 次实际 Provider 请求**，跨工具调用、格式失败和手动复验统一计入。用一个合成账号走明确授权、原话核对、会后回顾、纠正、无日期的下一次单条建议，再选用并关闭重开，最多 8 次。另一个无历史账号只谈主观感受与顾虑，最多 2 次。余下最多 2 次仅用于一次有具体失败证据的定向复验。逐请求对齐共享账本与传输记录，核对主观归因、录音覆盖范围、时间、数量及正文一致；出现未知结果时停止相应生成。P1 真实脚本中仍有针对当时合并清单的页面断言；下一轮须对准当前分组，并使用新授权与独立预算账本。本轮未执行此计划。

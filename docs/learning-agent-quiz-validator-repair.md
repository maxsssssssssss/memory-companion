# Quiz 数学实体与有限集合字面量返修

本轮针对 Windows 在 `d84eaa97173f9fba88c596c94c04e167603589b2` 上发现的 N1/N2。继续使用 `feat/learning-agent-natural-language-quiz`，起始 HEAD `5a15025d9bd09067a90596188b2f9d57f1e08d63` 只比验收版本多一次证据包上传，没有额外产品改动。Cloud 只运行离线响应与合成数据，不修改 Windows 的任务、原题、成绩或账本。

## 收到的原证据

`LEARNING_AGENT_NATURAL_QUIZ_WINDOWS_EVIDENCE_d84eaa9.zip`：3,633,173 bytes；SHA256 `773f79d63db86985f9657bb7c4648c781fccc49a89ff83a9d6fa690f56dfc11f`。91 个 manifest 条目均校验一致。报告、候选矩阵、G3/G5 完整公开业务投影、原正式函数检查和合成来源已读取。

冻结脚本在独立导出的 d84eaa9 快照原样运行，6 项缺陷及控制检查复现，退出 0。这个退出码表示缺陷存在，不表示产品通过。活动分支没有切换或回退。

新回归保留全部 7 题的题干、场景、选项、答案、理由、来源及检查注解：5 道有未截断的 composed 候选投影；另 2 道只有正式保存的 decoded 候选，使用实际来源映射做无损 compact-codec 往返，并逐字段比较。后者不是原始生成 HTTP 回放。本地新请求使用新的合法 scope，没有猜测或替换缺失的历史 referenceScope。之前缺少正文的 5 个旧候选仍为 UNKNOWN。

## 两处产品修改

`quiz-entity-context.ts` 从当前题干和场景中的有限集合声明建立名字上下文。检查具体出现位置时，已声明名字不再依赖后面的中文谓词恰好命中某个短语。显式选项前缀、选项名词及肯定/否定判词优先；组合答案、序数、跨题依赖继续检查。数学内容只保护相应片段，不豁免整句，不读取其他题目或来源目录中的定义。既有明确数学表达式、带类型的元素说明及字母枚举继续处理。

`quiz-set-cardinality.ts` 统一有限集合字面元素解析：整数按值、单个英文字母按大小写身份、中文名称按原字面身份比较；集合去重且与顺序无关。中文名称没有颜色词表，不拆成单字，也不推断同义词。嵌套集合、表达式、带引号字符串等不在该有限语法内。`quiz-grounding.ts` 复用同一个解析器进行字面等价与既有有限检查；字符串、列表、多重集和表示法题不按集合等价处理。没有通用数学或语义求解器。

没有修改 Agent 行动协议、Prompt、意图策略、目标完成标准、运行时、预算或数据库；没有新增依赖、迁移、API、功能入口。已有服务、codec、部分发布、稳定选项 ID、洗牌、来源、答案隐藏和评分合同继续使用。

## 原题结果

| 原候选 | 预期与正式结果 | 拒绝层级/原因 |
|---|---|---|
| G3-1 index0 集合重复与顺序 | 发布并保存 | 无 |
| G3-1 index1 E/F | 发布并保存 | 无 |
| G3-2 index0 X/Y | 发布并保存 | 无 |
| G3-2 index1 颜色并集 | 拒绝 | publication / equivalent_options |
| G5-1 index0 A/B 交集 | 发布并保存 | 无 |
| G5-1 index1 数值并集 | 拒绝 | publication / equivalent_options |
| G5-1 index2 C/D 空交集 | 发布并保存 | 无 |

三批正式保存为 2/2、1/2、2/3。两个坏题先通过结构及身份绑定，再由真正的集合等价门槛拒绝，没有借位置误判拒绝。5 个合法题经过 repository.complete、SQLite、正式模拟学生 stable-ID 作答、重复提交及数据库重开；过滤后的题序和 reviewCheck 对应关系也被核对。

变化测试单独标为 synthetic：一致改集合名字、空格、元素顺序和重复次数；负例保留明确选项引用、序数、矛盾判词及混合数学句。不替换原 7 题。

## 可重复离线验证

安装和隔离启动继续使用 [现有说明](learning-agent-natural-language-quiz.md)。先备份现有隔离数据，选择新的离线目录；不要把 Windows 验收目录重新 seed。

将本次原 ZIP 解压到 `<证据目录>`，该目录下应直接包含 `MANIFEST.json` 和 `semantic/`：

```sh
node --require ./scripts/cloud/offline.cjs --import tsx \
  scripts/agent-trial/natural-quiz-validator-evidence.mjs \
  --evidence-dir <证据目录> \
  --output-dir <全新回放输出目录>
```

脚本先核对全部 manifest 和跟踪 fixture 与原包的逐字段一致性，再执行正式 codec/发布/保存/作答。预期 7 题矩阵一致、5 发布、2 等价拒绝、3 批保存与重开成功、真实 Provider 请求 0。输出目录不可已存在，不会覆盖输入证据。

```sh
npm run cloud:test -- src/lib/server/learning/quiz-retained-validator.test.ts src/lib/server/learning/quiz-entity-context.test.ts src/lib/server/learning/quiz-finite-literals.test.ts
npm run cloud:check
npm run cloud:build
```

本轮完整相邻测试清单、命令、实际数量、退出码及浏览器结果随交付报告提供；不把这里的聚焦测试与集中测试重复相加。

浏览器复用 `natural-quiz-browser.mjs before-restart / after-restart / inspect` 和现有离线启动器，保留原 E（G5）流程，另用合成 F 验证 G3 原短句的两轮诊断。两条均经原组件首轮作答、真实 read_answers/associate_evidence、解释、反馈、第二轮题和再次作答。F 在约定诊断观察齐备后结束，不代表学会；E 保留未满足的 followup 与原错答并诚实交回。不是重放 Windows 的私有决策或真实 DS。

## Windows 定向复验与限制

先在新 SHA 运行原题便携回放，再按当时有效授权集中验证原话 G3“先出两道题看看。”及 G5“我总分不清交集和并集，帮我练练。”。核对合法题可交付、颜色/数值等价仍拒绝、两次实际作答和反证保留、后续目的与真实表现相符。不要通过改变原话、放宽目标、随机重试或提高单任务预算取得通过。

本包记录累计 177 个请求，新增 16 个均 completed，新 unknown 为 0；历史 unknown #101 保持。附件中的 Windows Guard 补丁不属于本次产品改动，本文不授予任何真实调用额度。Cloud 不调用 Provider，不更改账本。

S32、来源存在不等于蕴含、模型语义关联仍为暂定、有限数学覆盖、模拟学生不等于教学效果、长期掌握未验证均保留。原 G3 非法行动顺序/冗余读取及 G5 同类再试属于已有真实质量观察，没有据此重构 Agent。新 SHA 的真实 DS 体验必须由 Windows 复验。

回退时先正常停机并备份整个隔离数据目录（含 SQLite/WAL/checkpoint/账本），保存当前证据，再选择代码及匹配的数据备份。本轮没有迁移，但 checkout 旧代码不会回退新产生的业务数据。不得改写原 Windows 成绩或账本。不集成 dev/cloud-code/main，不部署。

## 本轮工程结果

集中相邻 `cloud:test`：42 个实际文件、901/901 用例通过，0 跳过，退出 0；包含 Quiz、目标/证据、Agent、API/UI、预算、unknown、prepared、权限/版本/审批及非 Learning 运行时。`cloud:check`：9 项环境合同及完整 lint（Next typegen + TypeScript）通过，退出 0。`cloud:build`：退出 0，180 个 trace manifest，forbidden=0。没有运行无关全仓测试或真实 Provider。

原 7 题便携正式回放最终退出 0。先前新 N1 变化测试 10 项中 5 项失败、N2 30 项中 10 项失败，记录了修前缺陷。中间聚焦检查的 3 项失败来自诊断文字“整数”改成“有限”后的旧文字预期，保留相同拒绝断言并更新文字；最终聚焦 7 文件 226 项通过，不与集中 901 项重复累计。回放辅助脚本曾误用不存在的 exam 模式，改为正式 test 模式；该辅助失败不冒充产品基线。

最终 production 产物完成正式 UI 离线流程：E/G5 首答 0/1 → 读回/关联 → 解释 → 用户反馈 → 第二题 1/1 → 再读/关联 → partial，保留 followup 缺口及原错答；F/G3 首轮部分发布并正式 0/1 → 读回/关联 → 解释 → 第二题 1/1 → diagnosis_complete，结束无需额外模型调用。两者计划不变，不声称掌握。

浏览器首轮重启前 12 项通过，重启后 10 项通过、F 的新脚本调用次数预期失败 1 项，只读检查 14 项通过。F 原本多预期了两次模型调用，实际正式 assessor 已取得充分诊断观察，零调用结束符合现有合同；保留事实及全部目标/反证断言后，用 `--case F` 单独重跑，重启前/后/只读各 2 项通过，均退出 0。不是修改产品或降低完成标准。另有辅助 readiness 脚本误查 `/login` 的 404，尚未执行业务就停止；修正实际入口后继续，失败记录保留。

全流程与 F 定向目录分别有 18、8 个 SQLite 完整性检查通过；重复 seed 不改变 DB/WAL，四次正常服务停机均退出 0，端口关闭。77 次受控离线响应、真实 Provider 0；重叠的阶段检查和复验不累计为独立测试量。所有模拟数据与截图保留。构建后仅修正浏览器验收脚本，生产源码未变；脚本语法、16 项 fixture 检查及定向浏览器已补验。

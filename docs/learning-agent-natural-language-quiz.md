# Learning Agent：自然语言入口与 Quiz 交付

本次基线：`e3ec34b7e678402c860b63d290490afc721fd26f`；独立开发线 `feat/learning-agent-natural-language-quiz`。本说明提供离线复现方法，不授权真实 Provider、集成或部署。Windows 需按交付的最终 SHA 另行验收，旧 SHA 的真实结果不移用。

## 用户入口与完成含义

用户原句不被扩写成验收脚本。既有决策模型读取当前授权材料和目标，自主选择四种现有计划：

- 普通“练习/考考我”：优先小范围 diagnosis，由模型选择基础题量、难度和可观察知识点；没有已知困难时不机械添加 targeted_review/followup。
- “不理解/是什么意思”：可以先回源解释，或在对象确实影响行动时做一条必要澄清。解释与明确解决反馈可以无 Quiz 完成。
- 泛泛复习：当前范围明确时可先小型诊断或说明；不反复询问题量、工具角色、ID 等参数。
- 明确“只解释/不要做题”和首组 1–5 题限制：模型可见且工具执行前复核。窄规则只处理明确限制，不是通用意图分类器；复杂歧义仍由模型澄清。权限始终来自用户现有选区，不能从自然语言猜出跨页面授权。

没有授权材料时，入口引导选择/上传材料并授权，仍不创建任务或调用模型。已建立的目标和要求冻结不变；诊断完成不等于全部答对，解释解决不等于考试通过，更不声称长期掌握。

重复讲解保护继续阻止无进展生成，但对当前版本、来源、关联均有效的已保存解释，保留持久反馈入口。普通“谢谢”不算解决；显式“疑问已解决”经正式反馈 API 重读事实后可零额外模型调用结束。来源或关联不正确的解释不能由该等待入口变成有效证据。

用户明确提出新的具体疑问时，该条当前版本的“仍需说明”反馈可支持一次针对讲解，并传入实际生成器；处理过的同一反馈不重复解锁生成。普通礼貌回复、页面刷新和新 artifact ID 仍不算学习进展。多轮练习继续使用原计划、真实作答和前序错误关联；没有固定“两轮后通过”规则。

## Quiz 合同与安全交付

生产 composed Quiz codec 的请求闭包保留 account/page/request/expiry、来源映射及一次性消费检查。模型不再必须重复输出固定 64 位 `referenceScope`；省略时由同一服务器闭包衔接内部 compact codec。旧响应仍可携带该字段，但显式非法格式、空值或错误绑定仍严格拒绝，不修复错误值。直接 compact 合同不变。

这是减少冗余固定元数据，不是修补模型选择的来源：每个 `rN` 仍必须在本请求映射中，选项理由、实际来源版本、稳定选项 ID、洗牌、唯一答案及等价集合等发布门槛保持。来源存在只证明结构关联，不等于语义蕴含。正式 Agent 协议仍为 `structured_action_v1`。

合法候选仍通过原 Quiz 服务和 repository 发布、建立真实 attempt。候选过滤后的目标关联通过原题目内容与稳定选项身份绑定，不依赖原数组下标；部分发布不能算作全部目标覆盖。明确错误候选只拒绝该题，不为了凑题改答案或关闭位置检查。

如果返回候选少于请求数且没有减少原因，服务器只补充实际数量说明，不编造教学原因，也不丢弃合法题。跨分段生成时，后段明确失败可保留前段经正式检查可发布的题目，失败 part 和已发生调用继续记账，不额外请求补齐。预算、取消、来源变化及 unknown 不走该部分成功分支。

交付摘要区分请求数、实际可用题数与已知拒绝类别。只有根结构成功后实际检查过候选才报告候选数量；失败响应未取得数量时保留未知，不把请求数当返回数。零发布不创建可作答 attempt，也不成为学生的错误证据。

摘要传入下一轮决策并展示在原任务面板；内部原因码、模型正文、未答题的答案和原文不进入该展示。已知失败允许现有有界换方法/回源/反馈；同缺口、同方法、同观察重复生成仍被拦截。真实 unknown 不自动重发，预算不因失败、暂停、调整或重启而重置。

## 诊断、兼容与证据边界

使用现有 Quiz diagnostics/result JSON 的受约束增量，保存候选数量、候选序号和固定拒绝类别；不新增表、依赖、Provider、评分权威或长期内容库。诊断只归属于原业务 run，随删除处理；公开摘要重新检查账号、页面、当前版本、scope fingerprint 及实际来源。不会从旧日志或 artifact 恢复撤销来源。

新生成 Prompt 改变了未完成 part 的输入指纹。旧已完成题组、选项顺序、成绩和引用不迁移；未完成旧生成不能在新 Prompt 下静默续发，按原指纹/来源冲突合同交回。unknown 保持未知，不以升级作为重试授权。

Windows 交接包 SHA256：`0f0e17981eb80e74c9affc121c612cc0e464de9d6a0a9c159e61fe1822f088e9`。134 文件，133 项 manifest 通过；独立 REPORT 与包内一致。冻结基线的一键四阶段复现均完成，包括确认解释过早终止的缺陷。

原留存 11 个 decoded 槽只有 7 道完整题文：6 题发布、1 题因等价选项正确拒绝；另 4 个位置依赖占位无原文，结论仍 UNKNOWN。整批 `referenceScope/invalid_string` 的原值和响应也未保存，不能完整原样 codec 回放。留存 decoded 发布回放、新合成正式链验证与真实 DS 质量是三层不同证据。

保留 S32、有限数学规则、语义提案非 verified、模拟学生非真人效果、长期掌握未验证等限制。本次没有修改位置依赖识别正则来追求发布数量，也不承诺所有模型题目与解析都正确。

## 本次工程验证范围

最终统一相邻 `cloud:test` 为 75 文件、1384 用例，全部通过、无跳过；不是全仓回归，开发期重复聚焦执行不累计。覆盖 Agent、Learning 完成与目的、Quiz 发布/作答/来源/历史、API/UI、JSON 与传输相邻合同、离线启动器。`cloud:check` 的 9 项环境合同、Next typegen 和完整 TypeScript（项目 lint）通过；最终 `cloud:build` 通过，180 个构建 trace 无禁止路径。

附件冻结基线四阶段复现完整执行；修后分别重跑留存候选与十条短输入。原缺陷脚本用“应提前结束”确认旧缺陷，不改它来伪造修复后 PASS；修后行为由正式反馈 API、Runtime/SQLite 与浏览器回归验证。原 repair4 公开投影也通过 31 项检查、9 道原已提交题的正式保存/作答重读；它仍不是私有 Windows 数据库完整还原。

原四组可回放发布数量保持 `0/3、2/2、3/3、1/3`。新的完整生成链覆盖 `3/3、2/3、1/3、0/3`、少题无减少原因、跨 part 已知失败后保留合法前缀，以及 unknown/预算不得转为部分成功。前者验证原留存证据不被改写，后者验证本轮确定性行为，两者不互相替代。

最终浏览器结果与命令、截图、退出码保存在交付证据的 `verification-matrix.json` 及各 phase 记录。任何中间脚本失败均保留，不用最后一次成功抹去此前记录。真实 Provider 与真实模型质量本轮未运行。

## Windows 集中验收与回退

先在独立 checkout 核对最终 SHA，按锁文件 `npm ci`，用既有 agent-trial 的 seed/start/status/stop 和显式隔离数据目录。已有 Windows 验收数据/账本不能复制重标为新账本，也不要重新 seed 历史目录。Cloud 的新合成目录与真实账本分离。

### 可重复的离线浏览器流程

先完成当前平台的 production build。Cloud 使用 `npm run cloud:build`；Windows 沿用 `npm run build`。在两个终端设置**同一新目录**（PowerShell 示例）：

```powershell
$env:AGENT_TRIAL_DIR = Join-Path (Get-Location) "output/natural-language-quiz/browser"
```

终端 A 启动并保持运行：

```powershell
node scripts/agent-trial/launch.mjs start --production
```

终端 B：

```powershell
node scripts/agent-trial/launch.mjs status
node --import tsx scripts/agent-trial/seed.ts
node --import tsx scripts/agent-trial/seed.ts
node scripts/agent-trial/natural-quiz-browser.mjs before-restart
node scripts/agent-trial/launch.mjs stop
```

重复 seed 应保留已有成果且不发起模型请求。等待终端 A 确实退出，再用相同目录、相同 start 命令重启；终端 B 继续：

```powershell
node scripts/agent-trial/natural-quiz-browser.mjs after-restart
node scripts/agent-trial/natural-quiz-browser.mjs inspect
node scripts/agent-trial/launch.mjs stop
node scripts/agent-trial/launch.mjs status
```

五个隔离账号分别验证：A 部分发布与正式提交；B 全部失败后回源解释；C 重复解释持久等待、普通谢谢、重启后明确解决；D 删除来源后不再公开旧结果；E 首轮错答 → 读回 → 针对说明 → 第二组等待时重启 → 第二次正式作答 → 根据关联证据结束。脚本使用原 UI 点击和原 API 保存，仅读取隔离合成库来模拟学生选择，不直接写分数或通过状态。

`offline-natural-quiz.json` 仅为现有离线 Provider 的显式 fixture 选择文件；原始用户目标不带测试标记。固定响应验证正式执行链，不证明真实模型语义质量。终端退出码、截图、每步公开任务/作答及离线账目保存在该目录，停止后不删除。再次启动同目录可查看成果；不要将已完成的一轮证据改名充当新运行。

聚焦自动测试命令：

```text
npm run cloud:test -- src/lib/server/learning/agent-natural-language.test.ts src/lib/server/learning/quiz-delivery.test.ts src/lib/server/learning/agent-budget-generation.test.ts src/app/api/learning/agent-completion-flow.test.ts src/app/api/learning/agent-routes.test.ts src/components/learning/learning-agent-panel.test.tsx src/components/learning/learning-quiz.test.tsx scripts/agent-trial/natural-quiz-fixtures.test.ts
npm run cloud:check
```

完整相邻回归的精确文件清单、命令、数量和退出码见本次交付证据；不要把上述聚焦命令的重复结果累加为覆盖量。

建议真实验收只选普通原句：

1. “练习交集与并集”：当前授权材料足够，模型自选小范围诊断，无工程参数追问；至少一个合法实际题组通过原组件提交，再读取实际作答决定后续。
2. “我不理解具体的定义，帮帮我”：允许一条必要澄清或直接讲解；保留首次反馈，明确解决零额外调用结束；“谢谢”不等于解决，新的具体问题能继续帮助。
3. “先出两道题看看”与“只解释，不要做题”：分别检查显式限制；自然语言语义质量由 Windows 判断，离线固定选择不证明真实意图识别成功率。
4. “我总分不清交集和并集，帮我练练”：首组通过原组件作答、读取实际错答后讲解，再进行与前序错误相关的新检查；第二次作答后按有效证据结束或诚实交回。第二组等待期间停止、重开和重新登录仍应保留任务与首轮成绩。不是要求真实模型每次固定生成两组，也不以模拟学生成绩证明教学效果。

部分发布和全失败用离线故障注入即可验收，不需要故意消耗真实请求制造坏题。核对失败原因是否准确、合法题是否丢失、模型是否有用地转向回源/不同方法或反馈，以及 unknown 是否保持不重发。

真实请求与费用预算必须由用户后续明确授权。本次附件报告的 Windows 唯一账本为 129/225、unknown 1；此数字只是证据身份，Cloud 不使用余额、不修改 Guard、不联系 Windows 会话。

回退前正常停止本任务进程并备份整个隔离数据目录及 SQLite/WAL/checkpoint/账本。无新增数据库迁移；回退代码不会撤销已经创建的题、作答、任务或解释。旧版本可能忽略新增展示字段，不能宣称自动恢复所有新运行点；无法确认兼容的执行点交回用户，不自动重放生成。不要覆盖原始验收数据或删除本次证据。

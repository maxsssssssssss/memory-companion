> 本文件是项目代码修改的追加式历史。初始化内容根据仓库中的设计文档、实现文件、测试、`.data/evaluation` 报告和当前 Git 状态重建。
>
> 维护规则：只在文件末尾追加，不改写或删除既有记录；每个 coding task 完成后记录真实文件、真实命令和真实结果；未运行的测试必须明确写明；不得记录密码、API Key、Token、完整模型响应或不必要的用户数据。
>
> 历史说明：仓库当前只有一个 `2026-07-13` 的基线提交，部分早期任务日期依据设计文档日期和产物时间重建，不代表每项修改都具备独立 Git commit。

# 2026-07-08 - Evidence Layer 与基础 Pipeline

## 1. 修改背景

项目需要把录音转换成可追溯的每日复盘，而不只是保存一份转写文本。基础目标是建立从音频、说话人转写、语义时间线、Daily Brief、关系信号到问答的 Evidence Layer。

---

## 2. 设计思路

采用 Evidence First：所有摘要、关系信号和问答结论都应回到 transcript segment。持久化先沿用用户级 JSON Store，处理任务通过 Next.js 后台生命周期执行，先验证完整产品链路，再引入更重的队列设施。

---

## 3. 架构变化

Before:

```text
Audio Recording -> Transcript
```

After:

```text
Audio Recording
-> ASR + Speaker Diarization
-> Audio Insights + Acoustic/Emotion Evidence
-> Semantic Timeline
-> Daily Brief
-> Relationship Signal Cards
-> current/week/all QA
```

新增证据层、派生分析层和范围问答；基础数据仍以 transcript 为事实来源。

---

## 4. 核心技术实现

主要实现位于 `src/lib/server/pipeline/process-upload.ts`、`src/lib/processing/`、`src/components/daily-brief.tsx`、`src/components/relationship-signal-cards.tsx`、`src/lib/server/storage/json-store.ts` 和问答 API 路由。

`TranscriptSegment` 保存时间、说话人、文本和来源；Semantic Timeline 与 Brief 条目引用 segment；Relationship Signal Cards 同时保存 interaction、counter 和 acoustic evidence。

---

## 5. 技术决策与原因

Decision:

选择先用 JSON Store 和 Next.js 后台任务完成端到端产品验证。

Reason:

开发阶段依赖少、可直接检查证据文件，并能快速验证 UI 和 Agent 链路。

Alternative:

未直接引入 Redis、Queue 和独立 Worker，因为当时尚未确认长任务的真实瓶颈。

---

## 6. 测试和验证

项目交接记录中的基线结果为 `42` 个测试文件、`312` 个测试通过；lint 和 build 通过。该数据属于当时本地验证，不等同于长录音生产压力测试。

---

## 7. 当前限制

JSON Store 不适合高并发事务；后台任务依赖 Next.js 进程；没有 checkpoint、resume 或独立 Worker；speaker identity 只在单次转写内部有效。

---

## 8. 下一步计划

建立 SQLite Memory Index，让证据从当日复盘进一步演化为可去重、可关联、可管理的长期记忆。

# 2026-07-10 - Memory Index v1 与 v1.5

## 1. 修改背景

原系统只能存储历史录音和 JSON 派生结果，无法管理记忆重要度、重复项、状态变化或记忆之间的关系。

---

## 2. 设计思路

新增独立 SQLite Memory Index，保留 JSON retrieval 和 transcript evidence。重要度、去重和关系推断优先采用 deterministic 规则，不引入 embedding、vector database 或新的 LLM 调用。

---

## 3. 架构变化

Before:

```text
Upload artifacts -> JSON history
```

After:

```text
Upload artifacts
-> deterministic memory extraction
-> SQLite memory_items + memory_evidence
-> importance + deduplication + lifecycle
-> memory_relations
```

Memory 写入失败保持 fail-open，不阻塞 upload 到达 `ready`。

---

## 4. 核心技术实现

主要文件：`src/lib/server/memory/schema.ts`、`db.ts`、`types.ts`、`repository.ts`、`extractor.ts`、`importance.ts`、`deduplication.ts`、`relations.ts`、`migration.ts`、`upgrade.ts` 及对应测试。

`memory_items` 增加 `importance_score`、`importance_reason`、`status`、`occurrence_count`、`first_seen_date`、`last_seen_date`、`access_count`、`last_accessed_at`。关系支持 `related`、`repeated`、`resolved_by`、`contradicted_by`、`follow_up`。

升级命令由 `scripts/migrate-memory.ts` 和 `scripts/upgrade-memory.ts` 提供，迁移设计要求幂等并兼容旧 Memory。

---

## 5. 技术决策与原因

Decision:

选择 SQLite + deterministic scoring。

Reason:

当前数据规模适合本地事务存储；规则评分可解释、可测试，并能保持证据回溯。

Alternative:

未选择 embedding 相似度和 vector database，避免在长期数据不足时引入不可解释的召回和额外成本。

---

## 6. 测试和验证

覆盖 importance、重复 occurrence 更新、evidence 保留、relation 去重、migration 幂等和 pipeline fail-open。历史设计与执行记录见 `docs/superpowers/specs/2026-07-10-memory-index-v1-5-design.md` 和对应 plan。

---

## 7. 当前限制

相似判断仍依赖规则和规范化文本；状态生命周期的语义覆盖有限；当时尚未接入 QA 或 Proactive Agent。

---

## 8. 下一步计划

将高价值 Memory 作为 QA 的补充 evidence source，同时保持 JSON retrieval 和原始 citation。

# 2026-07-10 - Memory-aware QA

## 1. 修改背景

SQLite Memory Index 已进行 shadow retrieval，但 QA prompt 仍只使用 JSON evidence，无法利用跨录音的承诺、未决问题和关系记忆。

---

## 2. 设计思路

把 Memory 作为长期导航和补充上下文，而不是替代原始证据。先按 scope、类型、状态、importance 和 evidence 过滤，再把 Memory 关联到可引用的 transcript/brief/relationship source。

---

## 3. 架构变化

Before:

```text
Query -> JSON retrieval -> QA -> citation
```

After:

```text
Query
-> JSON retrieval + Memory Index retrieval
-> evidence ranking
-> QA prompt
-> citation validation
-> answer
```

Memory 本身标记为压缩观察，最终 citation 仍优先指向原始证据。

---

## 4. 核心技术实现

核心适配器为 `src/lib/server/retrieval/memory-index-evidence.ts`，scope 行为及回归覆盖位于 `memory-index-evidence.test.ts`、`memory-scope-qa.ts` 和对应测试。

`current` 默认不引入历史；`week` 使用 reference date 所在自然周的近期 active memory；`all` 使用更严格的高价值和多日期证据。类型过滤优先 commitment、question、relationship_signal 和 preference。

---

## 5. 技术决策与原因

Decision:

Memory 只影响上下文和 ranking，不成为独立 citation。

Reason:

Memory 是压缩观察，可能丢失语境；引用原始 evidence 才能保持可验证性。

Alternative:

未替换 JSON retrieval，也未让模型仅凭 memory summary 回答。

---

## 6. 测试和验证

测试覆盖高/低 importance、active/resolved、类型过滤、current 隔离、week 自然周、all 多日期限制，以及 Memory 读取失败不影响 QA。

---

## 7. 当前限制

无 embedding 时 query relevance 依赖规则；week/all 的长期效果当时缺少真实多日数据验证。

---

## 8. 下一步计划

把相同长期记忆能力接入主动洞察，但继续限制长期趋势推断。

# 2026-07-11 - Memory-aware Proactive Insight Agent

## 1. 修改背景

主动洞察只看当前录音，无法提醒历史未决问题、承诺或重复出现的关系内容。

---

## 2. 设计思路

在当前 evidence builder 之后增加 memory context，选择少量 active、高 importance 且有真实 evidence 的 Memory，作为 DeepSeek Proactive Agent 的可选上下文。Memory 失败时沿用 current-only 行为。

---

## 3. 架构变化

Before:

```text
Current evidence -> DeepSeek -> validator -> insights
```

After:

```text
Current evidence + filtered historical memory
-> DeepSeek
-> safety validator
-> existing ProactiveInsight output
```

没有修改 QA、Memory schema、Relationship Signal Cards 或前端数据契约。

---

## 4. 核心技术实现

核心文件包括 `src/lib/server/proactive-insights/memory-context.ts`、`evidence.ts`、`deepseek-provider.ts`、`validator.ts`、`provider.ts` 和相应测试。

初始限制为 current evidence 最多 `24` 条、Memory 最多 `10` 条；筛选 commitment、active question、relationship_signal、preference 和 repeated event。Prompt 明确 Memory 不是 ground truth，单日期不能形成长期模式。

---

## 5. 技术决策与原因

Decision:

复用现有 DeepSeek provider，不新增一次模型调用。

Reason:

Memory 只是上下文增强，单次调用能控制成本和 pipeline 延迟。

Alternative:

未实现长期趋势分析或关系诊断，因为当时没有足够多日数据。

---

## 6. 测试和验证

覆盖 active memory 查询、low importance/resolved/evidence 缺失过滤、有无 Memory prompt 行为、provider failure fallback 和安全表达。

---

## 7. 当前限制

importance 高不等于和当前录音相关；Memory 可能被强行带入不相干的场景。

---

## 8. 下一步计划

扩展 lifecycle context，并增加 relevance gate，做到“记得很多，但只在合适时提起”。

# 2026-07-12 - Proactive Agent v2 与主动洞察质量

## 1. 修改背景

第一版主动洞察候选较多，语言偏咨询师，且未充分利用 active commitment、unresolved question、repeated memory 和 memory relations。

---

## 2. 设计思路

把 Agent 定位为基于证据的陪伴助手。输入扩展为 memory lifecycle，输出仍保持前端兼容；通过 deterministic ranking 和 validator 限制数量、抽象语言与越界结论。

---

## 3. 架构变化

Before:

```text
Current evidence + important memories -> generic questions
```

After:

```text
Current evidence
+ unresolved questions
+ active commitments
+ repeated memories
+ relationship signals/preferences
+ memory relations
-> companion-style insight generation
-> safety/quality validation
-> ranked top 3
```

---

## 4. 核心技术实现

主要文件：`src/lib/domain/proactive-insights.ts`、`proactive-insight-quality.ts`、`src/lib/server/proactive-insights/ranking.ts`、`validator.ts`、`memory-context.ts`、`deepseek-provider.ts`。

schema 增加 `memoryRefs` 和 `insightType`：`reminder`、`reflection`、`follow_up`、`pattern_observation`。候选优先级为 unresolved、active commitment、memory change/repeated、relationship signal、positive reflection，默认展示最多 `3` 条。

Validator 要求历史表达存在 memoryRefs；“一直、总是、长期、经常”等 pattern 至少包含两个不同日期；禁止人格判断、心理诊断、分手建议和无证据的违约判断。

---

## 5. 技术决策与原因

Decision:

先用 deterministic ranking/quality gate 约束 LLM，而不是增加第二个 LLM critic。

Reason:

规则可复现、无额外成本，并能直接保护 Evidence First 和安全边界。

Alternative:

未新增模型评审层，也未让前端自行截断未排序的候选。

---

## 6. 测试和验证

覆盖 lifecycle context、ranking、单日期 pattern 拒绝、commitment 谨慎表达、memoryRefs 缺失、抽象词降分，以及 `5+` 候选只保留高价值 `3` 条。

---

## 7. 当前限制

此阶段仍可能选择“重要但不相关”的 Memory；语言质量依赖 provider 输出，validator 只能拒绝或降级。

---

## 8. 下一步计划

在 Proactive Agent 前增加独立 Memory Relevance Gate，并优化 QA 面板交互。

# 2026-07-13 - Memory Relevance Gate 与 QA 面板固定输入区

## 1. 修改背景

高 importance Memory 可能与当前场景无关；同时 QA 消息增长后输入框会被推到面板底部，影响连续提问。

---

## 2. 设计思路

先用 deterministic candidate filter 控制候选，再让独立 DeepSeek Judge 只判断 relevance/usefulness；Judge 失败时不传历史 Memory。UI 将消息区和输入区分离，历史消息独立滚动。

---

## 3. 架构变化

Before:

```text
Memory filter -> Proactive Agent
QA messages + input in one growing flow
```

After:

```text
Memory filter -> DeepSeek relevance judge -> max 5 relevant memories -> Proactive Agent
QA panel -> scrollable messages + fixed composer
```

---

## 4. 核心技术实现

Relevance 模块位于 `src/lib/server/memory/relevance/types.ts`、`validator.ts`、`deepseek-judge.ts`、`judge.ts`、`index.ts`。输入仅包含当前摘要/主题和候选 Memory 元数据，不发送整段 transcript。

候选先满足 active、evidence 和重要类型/重复条件，最多 `20` 条；Judge 输出严格 JSON，综合 relevance、usefulness 和 importance 后最多保留 `5` 条。UI 修改集中在 `src/components/qa-panel.tsx` 与 `src/app/globals.css`。

---

## 5. 技术决策与原因

Decision:

Relevance Judge 作为窄职责 LLM 层，失败时返回空历史上下文。

Reason:

错误地提起无关记忆比少提一次更伤害陪伴感；fail-closed 只影响 Memory 增强，不影响当前 evidence。

Alternative:

未引入 embedding，也未改 relevance gate 核心外的 Memory retrieval。

---

## 6. 测试和验证

覆盖相关 Memory 接受、无关 Memory 拒绝、invalid JSON fallback、失败不阻塞 Proactive Agent，以及 QA 10+ 消息时输入框持续可见、滚动和提交状态。

---

## 7. 当前限制

Judge 本身增加一次模型延迟；尚无向量语义召回；QA 面板的高分辨率显示密度仍需单独调整。

---

## 8. 下一步计划

优化 2K 屏幕响应式尺寸，并完成生产部署和运行流程校验。

# 2026-07-13 - 高分辨率响应式 UI 与滚动条处理

## 1. 修改背景

在 2K 屏幕上 QA 主内容区过窄、字号和间距显得紧凑，消息区还显示突兀的白色原生滚动条。

---

## 2. 设计思路

不使用 viewport 宽度直接缩放字体，而是通过响应式容器宽度、`clamp` 高度、合理的 max-width 和滚动区布局，让面板在普通桌面和高分辨率屏幕上都可读。

---

## 3. 架构变化

Before:

```text
Fixed narrow QA content + visible native scrollbar
```

After:

```text
Responsive QA container
-> independent message viewport
-> sticky composer
-> visually hidden scrollbar with scroll preserved
```

---

## 4. 核心技术实现

修改 `src/app/globals.css`、`src/components/qa-panel.tsx` 和相关布局。消息区保留 `overflow-y: auto`，使用浏览器兼容的 scrollbar 隐藏样式；尺寸由稳定的 min/max/clamp 约束控制。

---

## 5. 技术决策与原因

Decision:

隐藏滚动条但保留鼠标、触控板和键盘滚动能力。

Reason:

解决视觉干扰，同时不牺牲历史消息访问。

Alternative:

未使用全局页面缩放或按 viewport 宽度放大字号，避免不同 DPI 下出现不可控布局。

---

## 6. 测试和验证

通过 QA 组件测试和桌面视口人工检查验证输入区、消息滚动与提交交互。该记录不声称完成所有浏览器和移动设备视觉回归。

---

## 7. 当前限制

原生滚动位置提示被隐藏；极小屏幕仍依赖操作系统输入法和安全区行为。

---

## 8. 下一步计划

继续处理 pipeline provider 稳定性，并完善可重复的真实/fixture 数据验证。

# 2026-07-13 - 生产部署、Git 与 PM2 运行流程

## 1. 修改背景

项目需要从本地开发状态迁移到可更新的线上运行目录，并建立可重复的 Git 与 PM2 发布流程。

---

## 2. 设计思路

采用私有 Git 仓库管理源码，线上使用 Node.js 22、Next.js 和 PM2 运行固定 release 目录；部署与业务数据分离，保留 `.data` 和环境配置。

---

## 3. 架构变化

Before:

```text
Local workspace -> manual run
```

After:

```text
Private Git source
-> server release directory
-> install/build
-> PM2 managed Next.js process
-> port 3200 service
```

---

## 4. 核心技术实现

部署交接文档记录 Ubuntu、Node.js 22、Next.js `15.5.19`、PM2 和 `/opt/daily-brief/releases/daily-brief-v1` 运行方式。线上 Pipeline 已验证 ASR、Audio Insight、Extraction、Relationship Signal、Memory 和 Proactive 链路可到 `ready`。

---

## 5. 技术决策与原因

Decision:

先使用 PM2 管理单个 Next.js 服务进程。

Reason:

符合当前单机规模，并为后续 Git 更新和进程守护提供最低成本基础。

Alternative:

未在此阶段引入容器编排或独立 Worker 集群。

---

## 6. 测试和验证

交接记录中的线上样例结果为 `20` 个 transcript segments、`2` 个 speakers、`7` 个 Audio Insights、`13` 个 semantic segments、`6` 个 brief items、`1` 张 Relationship Card、`2` 条 Proactive Insights，约 `136s` 到 `ready`。

---

## 7. 当前限制

旧线上历史数据迁移尚需单独执行；speaker-ASR 有超时风险；PM2 仍承载长任务，没有 Queue/Worker 的崩溃恢复。

---

## 8. 下一步计划

修复 Relationship Signal schema 稳定性，并建立无需远端调用的多日 fixture 验证体系。

# 2026-07-13 - Pipeline 可观测性与 Audio Insight Provider 隔离

## 1. 修改背景

真实 sample 在 ASR 完成后出现约十几分钟无日志等待，无法判断阻塞发生在 Audio Insight、ffmpeg acoustic features、Semantic Timeline 还是 processUpload await 链路。Audio Insight 又复用长 timeout 和 structured/JSON 双重尝试，单次失败可能拖慢整条 Pipeline。

---

## 2. 设计思路

先在每个阶段增加 start/end/elapsed 脱敏日志，再把 Audio Insight 配置从 QA/Tokenhub 配置中隔离。Provider 使用单次 JSON 请求、严格 validation 和 deterministic rule fallback，超时后快速继续 Pipeline。

---

## 3. 架构变化

Before:

```text
ASR -> opaque wait -> structured request -> JSON retry -> long retry chain
```

After:

```text
ASR
-> logged parallel/serial stages
-> DeepSeek Audio Insight single JSON request
-> strict schema validation
-> rule fallback on timeout/invalid JSON
-> Semantic/Brief/Memory continue
```

---

## 4. 核心技术实现

主要修改位于 `src/lib/server/pipeline/process-upload.ts`、`src/lib/server/audio-insights/deepseek-provider.ts`、`provider.ts`、`rule-provider.ts` 及相关测试。日志覆盖 audio insights、ffmpeg features、semantic segments 和 extraction，并记录 count 与 elapsed，不记录 transcript 或密钥。

Audio Insight 使用独立 provider/model/timeout 配置，默认目标为约 `60s` attempt budget、最多一次请求路径和现有 rule fallback；QA 继续使用独立 Tokenhub 配置。

---

## 5. 技术决策与原因

Decision:

采用 fail-fast + deterministic fallback，而不是延长 Audio Insight 的模型等待时间。

Reason:

Audio Insight 是增强模块，不应阻塞 Brief、Memory 和 ready；可观测性比盲目提高 timeout 更重要。

Alternative:

未修改 QA、Memory、Relationship Signal 或 Proactive Agent，也未增加新的模型框架。

---

## 6. 测试和验证

覆盖 provider success、timeout、invalid JSON、rule fallback，以及 Audio Insight 失败后 extraction、Relationship、Memory 和 ready 继续执行。

---

## 7. 当前限制

Provider 返回 JSON 的稳定性仍依赖模型；60 秒超时只是单阶段保护，不解决长录音 context 增长。

---

## 8. 下一步计划

使用 chunk 架构从根本上限制长录音请求体，并在真实长录音中统计 per-chunk fallback。

# 2026-07-13 - Memory 类型分布与 Week Retrieval 校准

## 1. 修改背景

早期 Memory 数据中过度集中为 `event`，commitment、question、preference 和 relationship_signal 识别不足；week scope 又沿用接近 all 的高 importance 阈值，近期但单次的重要 Memory 容易被过滤。

---

## 2. 设计思路

在不增加 Memory type 和不改 schema 的前提下，强化未来行动、未决事项、稳定偏好和关系信号的 deterministic 分类；week 使用“近期 + active + 类型价值”的宽松准入，all 保持长期高价值门槛。

---

## 3. 架构变化

Before:

```text
Most extracted items -> event
week ~= all high-importance filter
```

After:

```text
Evidence cues -> commitment/question/preference/relationship_signal/event
week -> recent OR active OR valuable short-term type
all -> strict importance/repetition/multi-date evidence
```

---

## 4. 核心技术实现

修改集中于 `src/lib/server/memory/extractor.ts`、`importance.ts`、`src/lib/server/retrieval/memory-index-evidence.ts` 和测试。Memory 记录 extraction/importance reason，便于解释为什么归类和打分。

week 接受约 `importance_score >= 0.4` 的近期 Memory，或 active commitment/question 及有短期价值的 relationship/preference；resolved 仍不优先。all 不降低长期阈值。

---

## 5. 技术决策与原因

Decision:

按 scope 使用不同 retrieval policy。

Reason:

week 回答“最近发生了什么”，all 回答长期问题，两者不能共享同一严格度。

Alternative:

未整体降低所有 importance threshold，避免长期索引被局部事件污染。

---

## 6. 测试和验证

覆盖 commitment 不降级为 event、preference/question 分类、week `0.4` Memory、active commitment、resolved 降权和 all 策略不变。

---

## 7. 当前限制

规则分类仍可能把宽泛事件或一次性选择误认为长期内容；后续需要 admission policy，而不只是 extraction 分类。

---

## 8. 下一步计划

在真实数据集上审计 type distribution，并把长期 Memory 准入从 Daily Card 生成中拆开。

# 2026-07-14 - Relationship Signal Evidence Normalization

## 1. 修改背景

线上模型偶尔把 `interactionEvidence`、`counterEvidence` 或 `acousticEvidence` 返回为字符串，而 strict Zod schema 要求字符串数组，导致整个 provider 结果 validation 失败并触发 fallback。

---

## 2. 设计思路

在 JSON parse 与 Zod validation 之间增加窄范围 normalization：只修复 evidence 容器形状，不修改业务字段、不放宽 schema，也不绕过 Evidence First。

---

## 3. 架构变化

Before:

```text
LLM JSON -> Zod -> string evidence causes full fallback
```

After:

```text
LLM JSON
-> normalizeEvidenceField
-> strict Zod schema
-> existing evidence validation
-> save or fallback
```

---

## 4. 核心技术实现

修改 `src/lib/processing/relationship-signals.ts`、`src/lib/server/relationship-signals/openai-provider.ts` 及测试。统一 helper 将 string 转为单元素数组，合法数组保持，`null`、缺失或非 string/array 转为空数组。

Prompt 同时明确所有 evidence 字段必须是 JSON string arrays，但 normalization 仍是最终防线。

---

## 5. 技术决策与原因

Decision:

修复 provider 边界数据，而不是把 schema 改为 `string | string[]`。

Reason:

下游依赖 evidence 可多值和统一遍历；宽松 schema 会把模型不稳定扩散到存储和 UI。

Alternative:

未增加第二次 LLM 修复调用，也未删除 evidence requirement。

---

## 6. 测试和验证

测试覆盖 string、array、null/缺失、非法类型和当前合法 JSON 完全不变；Relationship provider 与 upload pipeline 回归通过。

---

## 7. 当前限制

Normalization 只修复容器形状，不会补造缺失 evidence，也不能解决 provider timeout 或语义错误。

---

## 8. 下一步计划

构建多日、双人、可重复生成的数据集，验证 Memory dedup、relations 和 scope。

# 2026-07-14 - 多日 Memory 评估数据集

## 1. 修改背景

缺少真实多日录音导致 week/all、dedup、occurrence 和 relation lifecycle 无法稳定复现；直接重复调用远端服务成本高且不可重复。

---

## 2. 设计思路

创建 8 天、跨两个自然周的中文双人连续故事数据集。用本地 Windows OneCore TTS 和 ffmpeg 确定性生成音频，manifest 保存真实 `recordingDate`，expected results 使用 must/should/mustNot 而不是精确 LLM 数量。

---

## 3. 架构变化

Before:

```text
Ad-hoc public samples -> manual upload -> hard-to-repeat results
```

After:

```text
dialogue fixtures + manifest
-> local deterministic TTS
-> 8 dated WAV files
-> static validator
-> repeatable Memory evaluation baseline
```

---

## 4. 核心技术实现

新增 `test-data/memory-multiday-v1/README.md`、`manifest.json`、`expected-results.json`、`generate-audio.mjs`、`validate-dataset.mjs`、`scripts/day-01.txt` 至 `day-08.txt`、`audio/.gitignore` 和 `.gitkeep`。

日期为 `2026-06-29` 至 `2026-07-12`，跨度 `13` 天；故事覆盖简历承诺、咖啡偏好、博物馆计划与关系互动。音频使用 Microsoft Yaoyao/Kangkang，`pcm_s16le`、`16kHz`、mono，单段约 `120-129s`。

---

## 5. 技术决策与原因

Decision:

提交文本、manifest、生成器和验收标准，不提交 WAV。

Reason:

二进制音频体积大；本地生成可复现且不产生远端 TTS 成本。

Alternative:

未从 WAV 重新做 ASR，也未篡改生产日期逻辑；上传接口原有 `recordingDate` 直接使用 manifest 日期。

---

## 6. 测试和验证

`node test-data/memory-multiday-v1/validate-dataset.mjs --require-audio` 通过；8 段均满足格式和时长要求；Day 1 连续生成 SHA-256 一致；生成和校验脚本无 HTTP/模型调用。

---

## 7. 当前限制

合成语音不能代表真实情侣录音的声学复杂度；数据跨度只有两周；静态数据集本身不验证远端 ASR 和模型质量。

---

## 8. 下一步计划

增加 development/test-only fixture replay，从 transcript fixtures 直接复用真实下游业务代码。

# 2026-07-14 - Development-only Fixture Replay

## 1. 修改背景

完整上传每次都会调用远端 ASR/LLM，难以快速回归 Memory、relevance、Proactive 和 scope；直接写 SQLite 又会绕过真实业务逻辑。

---

## 2. 设计思路

通过 dependency injection 构造与真实 ASR 输出兼容的稳定 transcript segments，并为远端阶段提供 deterministic fixture providers。Replay 仍进入真实 normalization、Zod、Memory writer、dedup、relations、relevance 和 Proactive validator。

---

## 3. 架构变化

Before:

```text
Fixture -> remote upload/ASR/LLM -> downstream
```

After:

```text
manifest + transcript fixture
-> production-shaped ASR output
-> deterministic fixture providers
-> real processUpload downstream modules
-> SQLite + evaluation report
```

production 环境明确拒绝执行。

---

## 4. 核心技术实现

新增 `src/lib/server/fixture-replay/` 下的 `dataset.ts`、`providers.ts`、`replay.ts`、`reset.ts`、`evaluation.ts`、`types.ts` 及测试，入口为 `scripts/replay-memory-fixtures.ts` 和 `npm run memory:replay-fixtures`。

sourceId 稳定绑定真实 fixture segment；`--reset-user` 只清理指定测试用户和 fixture artifacts；支持 `--dataset`、`--user`、`--from-day`、`--to-day`、`--report`、`--fail-fast`。

---

## 5. 技术决策与原因

Decision:

在 provider 接口处注入 fixture，而不是复制一套 Pipeline 或直接写最终数据库。

Reason:

可以无网络、低成本地回归下游真实代码，同时避免“为了测试写答案”。

Alternative:

未暴露 production API，也未使用 fixture 代替真实远端验收。

---

## 6. 测试和验证

首版多日 replay `pass=true`、网络访问为零，Must `14/14`，Should `6/7`；唯一 Should 缺口是 museum plan relation。首版 deterministic digest 为 `f1ea...`，用于检测重复运行变化。

---

## 7. 当前限制

Fixture provider 验证架构和规则，不代表真实 ASR/LLM 输出分布；museum lifecycle 当时仍未闭环。

---

## 8. 下一步计划

拆分 Proactive observation 和 suggested question 的产品语义，并继续建设长录音数据契约。

# 2026-07-14 - Proactive QA 观察与推荐问题分离

## 1. 修改背景

“AI 主动观察”和“你可能想问”共用展示与交互，问句被当作观察卡；点击后直接发送，导致“你们后来……”等第三方人称成为用户提问。

---

## 2. 设计思路

不重做 Agent，只在后端结果到 UI 之间增加 presentation/validation：Observation 是只读陈述并展示 evidence；Suggested Question 必须是用户可编辑的第一人称问题。

---

## 3. 架构变化

Before:

```text
Proactive insight/question -> one card -> click sends QA immediately
```

After:

```text
Proactive output
-> ProactiveObservation -> read/expand evidence
-> SuggestedQuestion -> fill textarea -> user edits -> explicit send
```

---

## 4. 核心技术实现

新增 `src/lib/client/proactive-qa-presentation.ts`、`proactive-qa-suggestions.ts` 及测试；修改 `src/components/qa-panel.tsx`、`src/app/page.tsx` 和 `src/app/globals.css`。

Observation 禁止问号、“你是否”“你们后来”“请问”等问句形式；Suggested Question 点击只调用 `setInput` 并 focus textarea，不调用 QA API。

---

## 5. 技术决策与原因

Decision:

把“AI 已发现什么”和“用户可以继续问什么”定义为两个数据结构和两个区域。

Reason:

两者拥有不同语义、视角和交互，合并会降低可信感并剥夺用户确认权。

Alternative:

未继续用一个字段配合前端猜测类型，也未保留点击自动发送。

---

## 6. 测试和验证

覆盖 Observation 不渲染为 question、点击 Observation 不发送、Suggested Question 填入并聚焦输入框且不发请求，以及 current/week/all、citation 和 QA retrieval 回归。

---

## 7. 当前限制

旧 provider 文案仍可能需要 post-processing 拒绝；“基于此提问”只使用已有相关问题，不增加新 LLM 调用。

---

## 8. 下一步计划

建立 provider-neutral Unified Chunk Model，为长录音并行和恢复提供稳定契约。

# 2026-07-14 - Unified Chunk Model

## 1. 修改背景

OpenRouter ASR、Daily Brief extraction 和 Semantic Timeline 各自存在不同 chunk 概念，字段、ID、状态和来源追踪不统一，无法作为并行处理与 checkpoint 的共享基础。

---

## 2. 设计思路

先只建立 domain contract，不立即改生产 Pipeline。AudioChunk、TranscriptChunk、AnalysisChunk 使用 provider-neutral metadata、稳定 ID、严格 Zod 和通用生命周期。

---

## 3. 架构变化

Before:

```text
Provider-specific audio chunks
Extraction text chunks
Timeline windows
```

After:

```text
AudioChunk
-> TranscriptChunk
-> AnalysisChunk
-> existing domain outputs
```

不同阶段可以逐步迁移，不要求一次替换所有实现。

---

## 4. 核心技术实现

新增 `src/lib/domain/chunks/chunk-status.ts`、`audio-chunk.ts`、`transcript-chunk.ts`、`analysis-chunk.ts`、`index.ts`、`chunks.test.ts` 和 `docs/architecture/unified-chunk-model.md`。

模型包含 stable id、uploadId、index、start/end/duration、source、status、retry/error/timestamps 和 metadata。Provider req_id 等特有字段只允许存在于 metadata。

---

## 5. 技术决策与原因

Decision:

先稳定数据契约，再迁移 ASR 和分析模块。

Reason:

降低一次性重构风险，也使未来 Queue/Worker 可以复用相同 payload。

Alternative:

未把 speaker-ASR request ID 或 OpenRouter 字段写入核心 domain。

---

## 6. 测试和验证

覆盖 AudioChunk 创建、时间范围、index 唯一性、TranscriptChunk timestamp、merge 输入结构和 provider-specific 字段隔离；lint 与相关 Vitest 通过。

---

## 7. 当前限制

此阶段只有 contract，没有 scheduler、持久化 checkpoint 或生产集成。

---

## 8. 下一步计划

实现 Audio Chunk Planner、有限并发 ASR Scheduler 和 Transcript Merge。

# 2026-07-14 - 长录音 ASR 分片处理基础设施

## 1. 修改背景

speaker-ASR 对完整长音频单次提交，timeout 和单点失败风险高，无法并发、重试或记录 chunk 状态。

---

## 2. 设计思路

使用可扩展 Planner 生成固定 `300s` AudioChunk；bounded scheduler 控制并发；每个 chunk 独立 retry/checkpoint/failure；全部成功后合并为现有 `TranscriptSegment[]`。任何最终失败 chunk 都显式失败，不能静默缺失。

---

## 3. 架构变化

Before:

```text
Full audio -> one speaker-ASR request -> TranscriptSegment[]
```

After:

```text
Full audio
-> AudioChunk Planner
-> bounded ASR scheduler
-> TranscriptChunk[]
-> Transcript Merge
-> existing TranscriptSegment[]
```

---

## 4. 核心技术实现

新增 `src/lib/server/transcription/chunks/audio-planner.ts`、`scheduler.ts`、`adapter.ts`、`checkpoint-store.ts`、`process-audio.ts` 及测试；接入 `src/lib/server/pipeline/process-upload.ts`。

Planner 使用 ffprobe 获取时长、ffmpeg 生成片段，策略接口预留 VAD/silence/size；默认 concurrency `3`。Checkpoint 复用 JsonStore 风格，记录 status、retryCount、lastError 和 timestamps，不污染 domain。

---

## 5. 技术决策与原因

Decision:

使用有限并发 scheduler，不使用全量 `Promise.all`。

Reason:

100 个 chunk 时需要 backpressure，避免压垮 ASR 服务或进程内存。

Alternative:

未引入 Redis/Queue/Worker；第一阶段仍在当前进程内调度。

---

## 6. 测试和验证

覆盖长音频规划、metadata、并发上限、retry、partial failure、30 分钟生成 6 chunks、checkpoint 和原 `TranscriptSegment[]` 兼容。

---

## 7. 当前限制

Checkpoint 只解决 ASR chunk 基础恢复；Next.js 进程重启和跨服务器 claim 尚未生产化；固定时间切片可能从句中切开。

---

## 8. 下一步计划

把 timestamp、ID、source tracking 和边界 dedup 收敛到独立 TranscriptMergeService。

# 2026-07-14 - TranscriptMergeService

## 1. 修改背景

多个 ASR chunk 可能都从 `0s` 开始并复用 `seg_1`，直接拼接会产生时间错乱、ID 冲突和证据不可追踪；边界 overlap 还可能生成重复文本。

---

## 2. 设计思路

Provider 只产生 chunk-local TranscriptChunk；统一 Merge Service 负责全局 offset、稳定 ID、排序、验证、source map 和保守边界去重。

---

## 3. 架构变化

Before:

```text
Provider-specific offset/id/ordering logic
```

After:

```text
TranscriptChunk[]
-> validate local range
-> apply chunk offset
-> generate stable global IDs
-> boundary dedup
-> global ordered TranscriptSegment[] + stats/warnings
```

---

## 4. 核心技术实现

核心文件为 `src/lib/server/transcription/chunks/transcript-merge.ts` 和测试。

ID 由 upload、chunk index 和 original segment index 稳定生成；segmentSources 保存 `chunkId`、`chunkIndex`、`originalSegmentId`。边界重复判定要求时间重叠约 `0.6`、文本相似度约 `0.78` 且 speaker 一致；最终返回 segments、chunk/segment/duplicate stats 和 warnings。

---

## 5. 技术决策与原因

Decision:

使用稳定 deterministic ID，不使用随机 UUID。

Reason:

重跑、checkpoint、evidence 和 debug 需要同一输入产生同一来源标识。

Alternative:

未尝试跨 chunk speaker reconciliation；仅保留扩展 hook，不伪造 A/B 全局身份。

---

## 6. 测试和验证

覆盖 offset、ID 唯一/稳定、乱序输入、边界重复、speaker 保留、范围越界和 warning；原 pipeline transcription tests 继续通过。

---

## 7. 当前限制

文本相似度是轻量规则；非重叠但重复说话不会去重；speaker 仍可能是 chunk-local。

---

## 8. 下一步计划

迁移 OpenRouter 内部 merge，确保所有 transcription provider 共享同一实现。

# 2026-07-14 - OpenRouter Transcript Merge 统一

## 1. 修改背景

speaker-ASR 已使用 TranscriptMergeService，但 OpenRouter provider 仍维护自己的 chunk offset、segment ID、ordering 和 merge，存在行为漂移风险。

---

## 2. 设计思路

将 OpenRouter provider 收窄为“audio chunk -> ASR response -> TranscriptChunk”，全局处理统一交给 TranscriptMergeService。

---

## 3. 架构变化

Before:

```text
OpenRouter -> provider-local merge -> TranscriptSegment[]
speaker-ASR -> shared merge -> TranscriptSegment[]
```

After:

```text
OpenRouter / speaker-ASR
-> TranscriptChunk[]
-> TranscriptMergeService
-> TranscriptSegment[]
```

---

## 4. 核心技术实现

迁移范围记录于 `docs/superpowers/plans/2026-07-14-openrouter-transcript-merge-migration.md`，并修改 OpenRouter transcription provider、共享 chunk adapter/merge 及测试。Provider-specific metadata 留在 chunk metadata。

---

## 5. 技术决策与原因

Decision:

删除重复 merge 逻辑，保留 provider 的协议转换职责。

Reason:

全局时间线、ID 和 dedup 必须对所有 provider 一致，Evidence First 才能稳定。

Alternative:

未修改 TranscriptSegment schema、Memory、QA 或 Relationship Signal。

---

## 6. 测试和验证

测试比较迁移前后 timestamp 行为、稳定 ID、source tracking 和 merge stats；不调用远端 OpenRouter。

---

## 7. 当前限制

不同 provider 的原始 diarization 质量仍可能不同；统一 merge 不等于统一 speaker identity。

---

## 8. 下一步计划

优化 ASR 后独立分析支路的 wall-clock。

# 2026-07-14 - ASR 后分析阶段并行 DAG

## 1. 修改背景

ASR 后 Audio Insight、Acoustic Features 和 Emotion Evidence 顺序 await，三者没有直接数据依赖却累计延迟。

---

## 2. 设计思路

先审计依赖，只并行三个以 transcript/audio 为输入的独立分支；Semantic Timeline 和后续 Brief/Relationship 保持依赖顺序。每个 optional branch 使用现有 fallback 包装，避免 `Promise.all` 被单点 reject。

---

## 3. 架构变化

Before:

```text
ASR -> Audio Insight -> Acoustic -> Emotion -> Semantic -> Brief
```

After:

```text
ASR
-> [Audio Insight | Acoustic | Emotion] in parallel
-> Semantic Timeline
-> Daily Brief
-> Relationship
-> Memory
```

---

## 4. 核心技术实现

主要修改 `src/lib/server/pipeline/process-upload.ts` 及 pipeline tests。增加 `[analysis-parallel]` start/end 和各分支 duration 日志，结果结构、prompt、schema 和 fallback 不变。

---

## 5. 技术决策与原因

Decision:

只并行确认无依赖的分支。

Reason:

保持业务 DAG 正确；Semantic Timeline 和 Daily Brief 不能在上游输入未准备好时提前执行。

Alternative:

未引入 Queue/Worker，也未把整个 Pipeline 粗暴放入一个无界 Promise.all。

---

## 6. 测试和验证

通过 mock delay 验证三个分支时间重叠、失败隔离、输出 schema 一致，以及 Semantic/Daily Brief 的依赖 ordering。

---

## 7. 当前限制

Audio Insight 和 Relationship 当时仍以完整 transcript 发起请求，长录音 context 和 timeout 问题未解决。

---

## 8. 下一步计划

复用 TranscriptChunk/AnalysisChunk，将 Audio Insight 和 Relationship Candidate chunk 化。

# 2026-07-15 - Audio Insight 与 Relationship Signal Chunk 化

## 1. 修改背景

ASR 已支持分片，但 Audio Insight 和 Relationship Signal 仍接收完整 transcript。长录音导致 context 增长、单请求 timeout、failure blast radius 过大，且无法复用已有 bounded scheduler。

---

## 2. 设计思路

Audio Insight 采用 chunk provider + deterministic merge；Relationship Signal 采用“chunk candidate extraction + daily deterministic reducer”两阶段。两个模块都有限并发、retry、timeout 和 failure isolation，最终输出 schema 保持不变。

---

## 3. 架构变化

Before:

```text
Full transcript -> one Audio Insight request
Full transcript + all context -> one Relationship Signal request
```

After:

```text
TranscriptChunk[]
-> bounded Audio Insight chunk processing -> insight merge
-> bounded Relationship candidate extraction -> deterministic daily reducer
-> existing AudioInsight[] / RelationshipSignal[]
```

---

## 4. 核心技术实现

核心文件：`src/lib/server/analysis-chunks/transcript-chunks.ts`、`src/lib/server/chunks/bounded-scheduler.ts`、`src/lib/server/audio-insights/chunk-processing.ts`、`merge.ts`、`src/lib/server/relationship-signals/chunk-processing.ts`、`candidates.ts` 及测试。

Audio Insight 默认 bounded concurrency `3`、chunk retry `1`、attempt timeout 约 `60s`；merge 按 evidence/source 去重并保留 chunk 来源。

Relationship Candidate 只接收当前 chunk transcript 和对应 insights，默认首轮 concurrency `2`，timeout 后进入 concurrency `1` 的恢复队列，每个 chunk 最多一次恢复；Daily reducer 只合并候选，不再次调用 LLM。

---

## 5. 技术决策与原因

Decision:

Relationship 使用 deterministic reducer，而不是第二次 LLM summarize。

Reason:

降低成本和延迟，保持 Evidence First，避免 reducer 生成 transcript 中不存在的新结论，并让同一输入可重复。

Alternative:

未让每个 chunk 直接产生最终 Card，也未使用无界 `Promise.all`。

---

## 6. 测试和验证

覆盖多 chunk 并发、merge、evidence 来源、单 chunk failure isolation、Relationship candidate extraction、多 chunk reduction、无关系内容为空及下游 schema 回归。此阶段测试不调用远端服务。

---

## 7. 当前限制

候选 reducer 初版聚类能力有限；chunk provider 仍可能 invalid JSON 或 timeout；跨 chunk speaker identity 未解决。

---

## 8. 下一步计划

创建 45 分钟可控基准并只运行一次真实 Pipeline，量化 fallback、wall-clock、Memory 和 Evidence。

# 2026-07-15 - 45 分钟长录音基准与首次真实 Pipeline

## 1. 修改背景

短 sample 无法验证 9 个固定时长 chunk、并发波次、全局 transcript、chunk 分析和长任务稳定性，需要一条内容分布可控但通过真实 Provider 的长录音。

---

## 2. 设计思路

使用本地 TTS 生成 `44:42` 中文双人对话，覆盖低价值闲聊、工作支持、简历承诺、咖啡偏好、博物馆计划、轻微回避、线上争执担忧和边界修复。音频只生成一次，真实远端 Pipeline 最多运行一次并保存审计报告。

---

## 3. 架构变化

Before:

```text
Short samples -> partial performance evidence
```

After:

```text
Deterministic 44:42 benchmark
-> 9 x 300s AudioChunk
-> real ASR/LLM pipeline
-> chunk/relationship/memory/evidence audits
```

本项主要新增测试资产和报告，不修改核心算法。

---

## 4. 核心技术实现

新增 `test-data/long-recording-45m-v1/dialogue.json`、自动导出的 `dialogue.txt`、`manifest.json`、`expected-results.json`、`generate-audio.mjs`、`validate-audio.mjs`、`audit-pipeline.mjs`、README 和音频 ignore 规则。

音频包含 `154` 个 utterances，时长 `2682s`，大小 `85,824,078` bytes，Microsoft Yaoyao/Kangkang，WAV `pcm_s16le`、`16kHz`、mono；固定日期 `2026-07-15`。

---

## 5. 技术决策与原因

Decision:

用本地 TTS 控制内容与时长，但使用真实 ASR/LLM 验证 Pipeline。

Reason:

既能知道预期主题和 evidence，又能暴露真实 Provider 的 latency、JSON 和 timeout 问题。

Alternative:

未用 fixture provider 冒充真实性能，也未因结果不理想重复整段上传。

---

## 6. 测试和验证

首次真实 upload `c5fa4170-9db3-4cbd-9e76-990937aed1bb` 到达 `ready`，Pipeline `667.406s`：ASR `76.235s`、ASR 后并行组 `74.703s`、Daily Brief `219.003s`、Relationship `290.560s`、Memory `0.250s`、Proactive `6.530s`。

9 个 ASR chunk 全部完成，最终 `232` segments、ID 唯一、时间有序、source 完整；Audio Insight fallback `5/9`，Relationship fallback `6/9`。生成 `15` Cards、`47` Memory、`420` evidence、`2` relations。

验收为 Must `15/17`、Should `5/9`、Must Not `5/6`。Evidence 中 invalid source `0`、orphan `0`，但有 `22` 条非逐字 quote。

---

## 7. 当前限制

功能未完全通过：咖啡 preference 缺失，Evidence quote 不满足逐字契约，Memory 高分过多，museum relation 缺失；Provider fallback 比例高。单日 benchmark 不验证跨周长期关系。

---

## 8. 下一步计划

先修 Evidence First 与 Provider 稳定性，再处理卡片/Memory 选择质量；不立即做 Daily Brief 二级 LLM 摘要。

# 2026-07-15 - Evidence First 契约与 Provider 稳定性修复

## 1. 修改背景

首次长录音中 `22/420` Memory evidence quote 不是对应 transcript 的连续原文；Audio Insight 有 `5/9 invalid_json` fallback；Relationship 有 `6/9 timeout` fallback。

---

## 2. 设计思路

先用失败测试分类真实产物，再分别在三个边界修复：Memory repository 强制 source/quote 契约；structured JSON parser 做保守解析清理；Relationship provider 使用独立 timeout/concurrency/recovery，且明确标记 fallback provenance。

---

## 3. 架构变化

Before:

```text
Aggregated/rewritten evidence quote -> Memory DB
Provider text -> fragile JSON parse -> fallback
Relationship timeout -> repeated heavy path
```

After:

```text
Derived candidate
-> expand to individual transcript sources
-> copy verbatim quote
-> repository sourceId/uploadId validation
-> reject Memory with zero valid evidence

Provider response
-> structured JSON extraction/cleanup
-> strict Zod + evidence validation
-> classified retry
-> explicit rule fallback
```

---

## 4. 核心技术实现

Memory 修改位于 `src/lib/server/memory/extractor.ts`、`repository.ts` 及测试：多个 segment 拆成多条 evidence，同一 memory/sourceId deterministic dedup，quote 从真实 segment text 复制；sourceId 不存在、upload 不同或 quote 不匹配时拒绝。

JSON 基础设施位于 `src/lib/server/openai/structured-json.ts`：处理 code fence、Responses API 多 content block、JSON 前后说明、唯一完整 object 和确定性 trailing comma；不猜测缺字段，最终仍严格 Zod。

Audio Insight 修改 `deepseek-provider.ts` 和 chunk processing；Relationship 修改 `openai-provider.ts`、`chunk-processing.ts`，独立配置包括 chunk concurrency、max retries、retry delay、attempt timeout 和 total budget。fallback 明确区分 `provider_success`、`provider_retry_success`、`rule_fallback`、`empty_safe_result`。

---

## 5. 技术决策与原因

Decision:

持久化 quote 必须复制真实 source segment，而不是保存规范化或模型摘要。

Reason:

summary 可以概括，evidence 不能概括；只有逐字来源才能审计、引用和重放。

Alternative:

未放宽 Zod、未删除失败 evidence 检查、未用另一次 LLM 修 JSON，也未机械延长所有 timeout。

---

## 6. 测试和验证

本地 post-fix replay：Memory candidates `47`、持久化 `46`、evidence `420`、relations `6`；Must `16/17`、Should `6/9`、Must Not `6/6`，`no_small_talk_memory_flood` 通过。

Evidence 指标全部为零：`invalidSourceIds=0`、`nonVerbatimQuotes=0`、`duplicateEvidence=0`、`memoriesWithoutEvidence=0`、`orphanEvidence=0`。剩余 Must 缺口是 coffee preference，不属于本项 Evidence 修复范围。

---

## 7. 当前限制

本地 replay 不能证明远端 Provider fallback 已降低；Relationship 单次请求仍较重；Memory 数量和 importance 质量尚未校准。

---

## 8. 下一步计划

增强 Relationship deterministic clustering/selection，并建立独立长期 Memory admission、preference 和 event lifecycle。

# 2026-07-15 - Relationship Reducer 与 Memory 质量治理

## 1. 修改背景

基线有 `22` candidates、`15` Cards，仍存在同义重复；所有 `15` Cards 都进入长期 relationship_signal Memory；Memory `47` 条且 high importance `36/47`；coffee preference 为 `0`；museum 提出、调整、完成没有生命周期关系。

---

## 2. 设计思路

把“当日 Relationship Card”和“长期 Memory”分开。Reducer 先做 deterministic fingerprint/clustering，再按证据质量和信息增量选择；Memory 通过 type-specific admission、可解释 importance 和通用 event identity 进入长期索引。

---

## 3. 架构变化

Before:

```text
Candidates -> light merge -> many Cards -> every Card becomes Memory
Memory score grows with broad evidence volume
Event matching by shallow similarity
```

After:

```text
Candidates
-> normalize/fingerprint
-> type + topic/event clustering
-> cluster merge
-> quality scoring + diversity selection
-> Daily Cards
-> independent long-term admission

Memory candidates
-> type-specific admission
-> calibrated importance factors
-> event lifecycle matching
-> Memory/relations
```

---

## 4. 核心技术实现

Relationship 核心为 `src/lib/server/relationship-signals/candidates.ts`；Memory 核心为 `admission.ts`、`extractor.ts`、`importance.ts`、`deduplication.ts`、`relations.ts`、`repository.ts` 及测试；评估入口为 `scripts/evaluate-memory-quality.ts`。

Candidate fingerprint 考虑 signal type、normalized topic/event、participant context、evidence IDs、chunk 和时间；不同 signal type 或不同事件不合并。评分包含 evidence quality、confidence、diversity、temporal coverage、actionability、specificity、information gain、redundancy 和 safety penalty。

Relationship admission 默认把单次 active listening、emotional support、轻微 evasion 留在 daily-only；有明确行动/期限的 commitment、可复用 boundary agreement 或多日重复强证据可进入 long-term。

Preference 使用通用稳定偏好语言识别，区分“平时更喜欢/不喜欢/通常选择”和“今天先选”；importance 不再按 evidence row count 线性加分；event key 支持计划提出、更新和完成的 follow_up/resolved_by。

---

## 5. 技术决策与原因

Decision:

使用质量阈值、聚类和 diversity-aware selection，而不是 `sort().slice(0, 12)`。

Reason:

目标是保留每张具有独立信息增量的卡片，不是机械满足数量。

Alternative:

未硬编码咖啡、博物馆或测试台词；未增加 embedding 或远端 LLM；仅保留异常安全上限 `50`。

---

## 6. 测试和验证

45 分钟离线 replay：历史持久化 Cards `15 -> 12`，Memory `47 -> 25`，relationship Memory `15 -> 2`，preference `0 -> 1`，high importance `36/47 -> 11/25`，medium `14/25`，relations `2 -> 10`，evidence `420 -> 99`。

多日 replay：`12` Memory、`42` evidence、`9` relations；Must `14/14`、Should `7/7`、mustNot violations `0`；coffee preference 跨 Day 1/5 合并，resume 和 museum lifecycle 闭环，current/week/all 通过。两次 digest 均为 `69787edf372200084a055431ae3bca36926fc1225e4bcd70dd8f7d8169d08b66`。

聚焦质量/回归套件 `31` files、`207` tests 通过；lint 通过。完整 `npm test` 为 `94` files、`662` tests 通过，另有 `6` 个既有 Windows/POSIX 路径断言失败及 `1` 个 Playwright spec 被 Vitest 收集。

---

## 7. 当前限制

45 分钟历史产物只保存 reducer 后的 `15` Cards，原始 `22` candidates 无法离线完整重建，因此跨 chunk clustering 主要由单元测试验证；真实 Provider 输出仍需重新验收。

---

## 8. 下一步计划

为 Audio Insight、Daily Brief 和 Relationship Candidate 增加通用 AnalysisChunk checkpoint，并把 Daily Brief chunk 从串行改为有限并发。

# 2026-07-15 - AnalysisChunk Checkpoint 与 Daily Brief 有限并发

## 1. 修改背景

Daily Brief 已有 semantic-guided chunk 和 deterministic merge，但 6 个 provider 请求串行；Audio Insight、Daily Brief 和 Relationship Candidate 成功结果只在当前进程中，重入会重复付费调用。

---

## 2. 设计思路

在 provider 之上、deterministic merge/reducer 之前建立通用持久化 AnalysisChunk checkpoint。Daily Brief 复用现有 bounded scheduler，按 chunk index 恢复稳定顺序；三个阶段共享 stable ID、input/processor fingerprint、validation 和 single-flight。

---

## 3. 架构变化

Before:

```text
Analysis chunk -> provider -> in-memory result -> merge
Daily Brief chunks -> serial await
```

After:

```text
Analysis source chunk
-> stable checkpoint lookup
-> bounded scheduler/provider/fallback
-> strict validation
-> atomic completed checkpoint
-> deterministic merge/reducer

Daily Brief chunks -> concurrency 2 -> index reorder -> existing merge
```

---

## 4. 核心技术实现

新增 `src/lib/server/analysis-chunks/checkpoint.ts`、`checkpoint.test.ts` 和 `scripts/verify-analysis-checkpoints.ts`；接入 `audio-insights/chunk-processing.ts`、`extraction/chunk-processing.ts`、`relationship-signals/chunk-processing.ts`、`process-upload.ts`、upload 删除逻辑和 JsonStore。

Checkpoint kind 为 `audio_insight`、`daily_brief`、`relationship_candidate`，保存 user/upload/source chunk、input fingerprint、processor fingerprint、status、resultSource、attempt、timestamps、脱敏 error 和 validated output。写入采用临时文件 + atomic rename；同进程相同 key 使用 single-flight。

completed + fingerprint 一致 + output/evidence 仍有效才命中；stale/corrupt/failed 重新处理。Relationship fingerprint 包含对应 Audio Insight，因此 insight 变化只使相关 candidate checkpoint 失效。默认 `DAILY_BRIEF_CHUNK_CONCURRENCY=2`。

---

## 5. 技术决策与原因

Decision:

Checkpoint 放在共享 AnalysisChunk 层，不放进各 provider 内部。

Reason:

三个分析模块共享生命周期；未来 Worker 化只替换 scheduler/claim，fingerprint、store、provider adapter 和 reducer 可继续复用。

Alternative:

未引入 Redis、Queue、分布式 lease 或最终 Card checkpoint；廉价 reducer 每次从 candidate checkpoint 重新计算。

---

## 6. 测试和验证

Daily Brief mock `6 x 100ms`：concurrency `1/2/3` wall-clock 分别为 `648/319/216ms`，最大 active 分别为 `1/2/3`，digest 完全一致。

多日 replay 第一次每阶段 `8` misses，第二次每阶段 `8` hits、provider 调用为零；partial invalidation 每阶段 `7` hits + `1` stale。45 分钟 fixture 第一次 Audio/Relationship 各 `9` provider calls，第二次均为 `0`；hits 为 Audio `9`、Daily Brief `7`、Relationship `9`，digest 一致，网络访问 `0`。

Evidence First 回归全部为零违规。

---

## 7. 当前限制

支持重入和本地恢复，但没有跨进程精确 claim/lease、startup scanner 或多服务器一致性；ready 后 checkpoint 保留，删除 upload 时会随该 upload 清理。

---

## 8. 下一步计划

在引入 Queue/Worker 前执行一次干净账号的真实 45 分钟 Pipeline，验证 checkpoint 写入、Daily Brief 并发和真实 Provider 质量。

# 2026-07-15 - 最终 Pre-Worker 45 分钟真实验收

## 1. 修改背景

需要确认本地 chunk、reducer、Memory 和 checkpoint 改造在真实 Provider 下是否工作，并判断 Queue/Worker 改造前是否仍有阻塞项。

---

## 2. 设计思路

使用全新专用测试账号和相同 `44:42` 音频，只运行一次真实 Pipeline；不运行额外 QA、不改配置、不因失败重跑。按新 uploadId 保存脱敏阶段日志和审计报告。

---

## 3. 架构变化

Before:

```text
Local fixture evidence for checkpoint/quality
```

After:

```text
One real 45m upload
-> 9 ASR chunks
-> checkpointed chunk analyses
-> bounded Daily Brief
-> Relationship recovery/reducer
-> Memory + Proactive
-> pre-Worker audit
```

本项只执行和审计，没有修改源码。

---

## 4. 核心技术实现

报告保存在 `.data/evaluation/long-recording-45m-v1/final-pre-worker-20260715-174250/`，包括 `pipeline.log`、`report.md/json`、各阶段 audit 和 baseline comparison。

真实 upload 为 `e59fba75-a4b3-4fd8-b380-22e79563fa8a`，job 为 `ff6bff75-0c8d-45c7-8ecc-12c207f5e1c3`。运行期间没有源码改动，也没有额外 QA 调用。

---

## 5. 技术决策与原因

Decision:

失败后不修改代码、不调整 timeout、不重复昂贵上传。

Reason:

单次受控运行才能保留可比较的真实基线，避免现场调参污染结论。

Alternative:

未把 fixture 结果当作生产 Provider 验证，也未因 UI 删除数据而重跑。

---

## 6. 测试和验证

Pipeline 到达 `ready`，处理耗时 `1187.426s`，命令 wall-clock `1433.543s`。ASR 规划 `9` chunks，全部无 retry 完成，`232` segments；ASR `314.830s`，merge 仅有一条“speaker 未跨 chunk 对齐”warning。

Audio Insight `0/9` fallback，`54.654s`；ASR 后并行组 `54.641s`。Daily Brief `6` chunks、concurrency `2`，乱序完成后按 index merge，`105.345s`，相比 `219.000s` 明显下降。

Relationship 仍是瓶颈：`29` raw candidates、`25` clusters、`22` Cards，chunks `2/4/5/7/8` 首轮和 concurrency-1 恢复均 timeout，fallback `5/9`，阶段 `704.696s`。无 `429` 或 fatal error。运行日志报告 Memory results `29`、relations `8`、Proactive `3`。

运行前 lint 通过，聚焦测试 `16` files、`138` tests 通过，`git diff --check` 通过。

---

## 7. 当前限制

一个已打开的 local-data UI 在 ready 后约 `1s` 调用 upload DELETE，删除了该 upload 的 server artifacts、AnalysisChunk checkpoints 和 SQLite rows。因此 post-run Memory 类型、preference、importance、relation lifecycle、Evidence First 和 checkpoint 保留无法审计；空表不能视为通过。

官方 evaluator 未运行。只能确认 Must `6` 项、Should `4` 项和 Must Not `1` 项；`few_high_value_cards` 已知失败。总耗时比基线更高，主要由 ASR 波动和 Relationship `704.696s` 导致。Queue/Worker 不会自动解决 provider latency。

---

## 8. 下一步计划

Queue/Worker 前先隔离 benchmark 与 UI 自动删除流程，并继续诊断 Relationship provider timeout/候选过量；Worker 后续直接复用 stable AnalysisChunk ID、checkpoint、fingerprint、provider adapter 和 deterministic reducer。

# 2026-07-16 - Update History 初始化

## 1. 修改背景

项目已连续完成 Memory、Agent、长录音和生产验证，但设计原因、真实指标和限制分散在聊天、plan、docs 与 `.data/evaluation` 中，后续维护容易只看到代码结果而丢失决策上下文。

---

## 2. 设计思路

在项目根目录建立单一 append-only `UPDATE_HISTORY.md`。按独立 coding task 拆分记录，每条统一包含背景、设计、架构、实现、决策、验证、限制和下一步；历史内容以仓库可验证产物为依据重建。

---

## 3. 架构变化

Before:

```text
Chat + scattered plans + evaluation reports + dirty worktree
```

After:

```text
Existing sources
-> append-only UPDATE_HISTORY.md
-> future coding task completion record
```

本项不修改任何运行时代码、schema、配置或 Pipeline。

---

## 4. 核心技术实现

新增根目录 `UPDATE_HISTORY.md`。文件顶部写明追加规则、真实性要求、敏感信息限制和历史重建边界；初始化记录覆盖 Evidence Layer、Memory、Agent、UI、数据集、Chunk、Provider、Checkpoint 和真实验收。

未来 coding task 必须在完成后向文件末尾追加一条；typo、纯格式和单纯 rename 可不记录。

---

## 5. 技术决策与原因

Decision:

只创建一个 Markdown 历史文件，不修改代码或增加自动 hook。

Reason:

用户明确要求本次只创建文档；先建立低风险、可审阅的事实记录，再决定是否需要 CI 强制检查。

Alternative:

未修改 `package.json`、Git hooks、CI、AGENTS 或业务逻辑来自动生成历史。

---

## 6. 测试和验证

本项验证包括 Markdown 结构检查、历史记录章节完整性、`git diff --check` 和 `git status --short`。没有运行应用测试，因为没有代码逻辑变化。

---

## 7. 当前限制

早期历史不是逐 task commit，部分日期由设计文档和报告时间重建；聊天中的临时排查若未形成代码或持久化产物，不作为独立发布记录。追加要求目前是团队流程约束，不是 CI 强制门禁。

---

## 8. 下一步计划

从下一次 coding task 起，使用真实修改文件、测试命令和性能数据在本文件末尾追加记录；如未来需要强制执行，可单独设计 CI 校验，但不得在本任务中引入。

# 2026-07-16 - Evaluation Retention Mode 与 Relationship Signal 稳定性治理

## Background

45 分钟真实 Pipeline `e59fba75-a4b3-4fd8-b380-22e79563fa8a` 到达 `ready` 后，已打开的 local-data 页面把 server payload 写入 localStorage，随后发出无 intent 标记的 `DELETE /api/uploads/:uploadId`。DELETE 删除 upload、ASR/Analysis checkpoints、各阶段 JSON artifacts，并调用 Memory repository 删除该 upload 的 evidence、重算 Memory 和 relations，导致 Preference、importance、Evidence First、lifecycle 和 checkpoint retention 无法做最终审计。Pipeline 自身还会在成功时先删除原始音频并移除 `filePath`，所以只拦 DELETE 也不足以保留完整验收数据。

同一次真实 Pipeline 的 Relationship Signal 阶段耗时 `704.696s`。9 个 chunk 中 2/4/5/7/8 在首轮与一次恢复请求中都到达 `75s` attempt timeout，最终 fallback `5/9`；29 candidates 只合并成 25 clusters，最后保留 22 Cards，前 5 分钟低价值闲聊仍产生多张卡。失败请求在超时前没有响应文本，也未进入本地 JSON parse 或 Zod validation，因此只能确定为非流式 provider wait 长尾，现有证据无法继续区分上游排队与模型生成慢。

本任务目标是在不引入 Queue/Worker、BullMQ、Redis、Docker、部署或远端调用，且不修改 ASR、AudioChunk、Transcript Merge、Memory schema、QA、frontend 和 expected-results 的前提下，保留下一次真实验收数据，并降低 Relationship 请求负载、改进候选质量与 reducer 审计。

## Design

Retention 使用独立、显式且默认关闭的 `EVALUATION_MODE`，不复用 `NODE_ENV` 或 `APP_STORAGE_MODE`。普通 production/development 在未设置或设置为 `false` 时保持原成功清理行为；专用 evaluation 实例设置为 `true` 后保留原始音频、upload record、transcript、阶段 artifacts、ASR/Analysis checkpoints、Memory/evidence/relations，并在对外发布 job `ready` 前生成 `evaluation-reports/{uploadId}`。

自动 cleanup 与 UI 主动删除目前是完全相同的 DELETE 请求，且本任务禁止修改 frontend，服务端无法推断 intent。因此 evaluation 模式对未确认 DELETE 返回 `409 evaluation_retention_active`；受控用户或验收脚本需要显式发送 `x-evaluation-delete-confirmed: true` 才执行真实删除。该 header 是防止 evaluation mode 变成永久保护的明确 override，而不是把用户数据设为不可删除。

Relationship 优化采用四层方案：只发送当前 TranscriptChunk 与对应 Audio Insights 的紧凑证据；保留一次 bounded retry 和原 `75s` timeout，不无限延长；在 candidate 与 cluster 之间加入 deterministic quality gate；reducer 使用 evidence、specificity、actionability、information gain、redundancy、confidence 和 safety 的可解释评分，而不是固定 Card 数量截断。

Daily Card 与长期 Memory 继续分层：具体、可追溯的单次 active listening 或 emotional support 可以保留 Daily Card；现有 Memory admission 仍默认把单次普通支持留在 daily-only，只有明确未来行动、可复用 boundary agreement 或重复强证据才可进入 long-term。本任务未修改最终 Relationship Card schema、Memory schema 或 Evidence First 契约。

## Architecture Change

Before:

```text
ready job
-> delete uploaded audio + strip filePath
-> open UI caches payload
-> unmarked DELETE
-> upload/checkpoints/artifacts/Memory evidence removed

TranscriptChunk + semantic summary + repeated insight evidence
-> JSON provider request, max_output_tokens=2400
-> candidate
-> permissive cluster/selection
-> Card
```

After:

```text
EVALUATION_MODE=false
-> retain existing production cleanup behavior

EVALUATION_MODE=true
-> retain audio + upload + artifacts + checkpoints + Memory/evidence/relations
-> read persisted artifacts back
-> write evaluation-reports/{uploadId}
-> publish job ready
-> unconfirmed DELETE blocked
-> confirmed DELETE performs scoped cleanup

current TranscriptChunk + current chunk compact Audio Insights
-> one JSON Responses request, max_output_tokens=2000
-> candidate
-> evidence/specificity/actionability quality gate
-> complete-link topic clustering
-> quality-aware redundancy selection
-> unchanged RelationshipSignalCard[]
-> per-candidate selected/rejected audit
```

## Technical Implementation

Evaluation 入口新增 `src/lib/server/evaluation/retention.ts`，只把大小写无关的显式 `true` 视为开启；`.env.example` 增加默认 `EVALUATION_MODE=false`。`src/app/api/uploads/[uploadId]/route.ts` 在任何 destructive write 前检查 retention，未确认请求不写 deleted marker、不删除文件/checkpoints/Memory；确认删除同时清理 evaluation report、audio-insight corrections 和 speaker aliases。生产默认 DELETE 路径保持可用。

`src/lib/server/pipeline/process-upload.ts` 在 evaluation 模式下不删除成功或失败的原始音频，不移除 `filePath`。成功阶段从 JsonStore 重新读取 upload、segments、audio insights、semantic timeline、brief、relationship cards 和 proactive cache，并重新枚举 ASR/Analysis checkpoints；`src/lib/server/evaluation/audit-report.ts` 记录 artifact 数量、checkpoint kind/status、Relationship stats、完整 reducer audit、Memory admission/update 状态、user-scope Memory/relation 数量和 current-upload evidence 数量。Evidence audit 对 transcript、brief、timeline、audio insight、relationship signal 五种 source type 校验真实 artifact ID，逐字 quote 仍以 transcript 为依据；无法观测的指标写 `null`，Memory 失败不会伪装成零违规。report 写完后才把 job 更新为 `ready`。

`src/lib/server/relationship-signals/openai-provider.ts` 的请求不再发送 semantic summary，也不再重复发送 Audio Insight 的长 evidence 原文；TranscriptChunk 原文、segment ID、时间、speaker 全量保留，Insight 只保留 id、当前 chunk source refs、时间、speaker、labels 和短 summary。局部 fixture 的 context 从 `860` chars 降到 `297` chars，减少 `65.5%`；当前完整 prompt 为 `1644` chars。该数字来自本地 provider 单测 fixture，不是已删除 45 分钟 artifacts 的追溯测量。默认输出上限从 `2400` 调整为 `2000`，仍为单次 `responses.create` JSON mode，SDK retry 为 0，chunk 层最多一次 recovery。

`src/lib/server/openai/structured-json.ts` 增加完整响应、parse、validation 和 total duration diagnostics，并明确区分 incomplete/invalid JSON 与 Zod failure。`src/lib/server/relationship-signals/chunk-processing.ts` 记录脱敏 request start、context before/after chars、完整 prompt chars、output limit、response chars/status、complete/parse/validation 时间、failure phase、failure reason、will-retry 和 fallback reason；非流式接口无法观测 first response，日志诚实写 `first_response_ms=-1` 和 `finish_reason=unavailable`。相同 metrics 与 failure 分类也写入 AnalysisChunk checkpoint metadata，避免只依赖运行日志。

`src/lib/server/relationship-signals/candidates.ts` 新增 candidate quality gate。它校验 evidence/source/quote/speaker/confidence，并降低普通寒暄、简单赞同和无具体上下文支持；提高明确行动、期限、承诺、边界、具体担忧和可验证帮助。共享同一 segment 不再自动合并，仍需 summary/topic 重合；cluster 使用 complete-link 避免 transitive bridge。Reducer 不使用 `slice(0, N)` 或固定 Card 上限，按 evidenceQuality、specificity、actionability、informationGain、redundancyPenalty、confidence 等评分选择独立主题。每个 raw candidate 都记录 selected/rejected、reason、clusterId 和 score；schema/evidence rejection、quality rejection、cluster rejection 与 normalization rejection 分开计数。Card normalization 按 cluster 单独保留 provenance，不再用过滤后数组下标猜测 candidate-to-card 映射。

主要修改和新增测试文件包括 `.env.example`、upload DELETE route 与 `src/app/api/routes.test.ts`、`src/lib/server/evaluation/{retention,audit-report}*.ts`、`src/lib/server/pipeline/process-upload*.ts`、`src/lib/server/openai/structured-json*.ts`，以及 `src/lib/server/relationship-signals/{provider,openai-provider,candidates,chunk-processing}*.ts`。

## Decision & Trade-offs

没有用 `NODE_ENV=development` 代表 evaluation，因为 `validate:pipeline` 本身运行 dev server，普通开发也需要原 cleanup；显式 env 可以让 production 默认值保持不变。Retention 是实例级运行模式，下一次真实验收必须继续使用专用测试实例/账号，不能在混合真实用户流量的实例上长期打开。

没有修改 frontend 来给自动和手动 DELETE 增加 intent，因为任务明确禁止 frontend 修改。代价是当前 UI 本身不能发送确认 header；evaluation 数据的主动删除需要受控 API 请求。该限制优于让无标记的自动请求再次删除审计数据。

没有提高 `75s` timeout 或增加 retry/concurrency。真实失败的主要 wall-clock 来自五个 recovery attempt 串行占用约 `375s`，但简单提高 recovery concurrency 可能加重上游排队。当前先通过输入与输出约束降低生成负载，并增强观测；是否改变并发必须等下一次保留完整 telemetry 的真实运行。

没有机械限制 Card 数量。质量门控与冗余选择可能仍需基于下一次真实 candidates 校准，但不会因录音长度固定删除前 N 张，也不会修改 expected-results 来制造通过。

## Validation

`npm run lint` 通过，包含 Next route type generation 与 `tsc --noEmit --incremental false`。

聚焦测试最终为 `7 files / 75 tests` 全部通过；upload DELETE 的 production、evaluation retain 和 confirmed delete 三个定向用例通过。覆盖 retention parser、production 音频清理、evaluation 音频/artifact/checkpoint/Memory/report 保留、report-before-ready 顺序、全 evidence source audit、Memory failure null metrics、普通聊天/泛化支持拒绝、具体支持/承诺/边界保留、跨 chunk merge、不同主题不误合并、同 segment 独立行动、无 speaker provenance、timeout retry/fallback isolation、JSON parse/validation 分类和 provider request metrics。

隔离多日 fixture 首次尝试在 `C:\tmp` 创建 SQLite 时失败为 `unable to open database file`，未产生质量结果；改用工作区专属 `.data/evaluation/task-20260716-fixture*` 后成功，网络访问 `0`。结果为 Must `14/14`、Should `7/7`、Must Not violations `0`、Memory `12`、evidence `42`、relations `9`、warnings `0`，digest `edee78904b664968454a47bd98b5747ce8ebb2780c7b090d432698ea141d7031`。独立审计得到 `invalidSourceIds=0`、`nonVerbatimQuotes=0`、`duplicateEvidence=0`、`memoriesWithoutEvidence=0`、`orphanEvidence=0`。

`npm run analysis:verify-checkpoints` 通过。多日第二次回放 Audio Insight、Daily Brief、Relationship Candidate 各 `8 hits / 0 misses`，三阶段 partial invalidation 各为 `7 hits / 1 stale`；45 分钟 fixture 第二次 Audio/Relationship provider counters 都为 `0`。6 个 100ms Daily Brief mock 在 concurrency `1/2/3` 下为 `659/338/215ms`。Evidence First 五项均为 `0`，全程 network attempts `0`。

完整 `npm test` 运行了 `101` 个测试文件、`719` 个 tests：`98` files、`713` tests 通过。失败仍为交接中已知的 6 个 Windows/POSIX path assertions，以及 `e2e/relationship-signals.spec.ts` 被 Vitest 收集时的 Playwright runner 冲突；本任务新增聚焦套件没有新增失败。

## Limitations

本任务没有调用远端服务或重跑 45 分钟真实 Pipeline，因此不能宣称真实 timeout/fallback、`704.696s` stage time 或 `29 -> 25 -> 22` Card 数已经改善。下一次真实运行的 timeout 仍只能归类为 `provider_wait_unattributed`；非流式 Responses API 没有首字节/首 token 或 provider queue timing，无法可靠区分模型生成慢与上游排队。

evaluation 模式下 UI 主动删除仍无法自动携带确认 header；必须通过受控 API 显式确认。DELETE 中既有的 checkpoint/Memory cleanup 仍是 catch-and-continue，底层删除失败时可能返回成功但留下部分残留；本任务没有扩展为事务式删除。week/all scope answer 中引用已删 upload 的历史 citation 也未在本任务中重写。

Audit report 的 orphan evidence 是 evaluation Memory database 全局范围，Memory/relation 是当前 user 范围，current-upload evidence 单独计数；字段已明确 scope，但下一次验收仍应使用空白专用账号和隔离 data root，避免旧数据干扰解释。

Quality gate 使用可解释的 deterministic text features，不能替代真实 provider candidate audit。Speaker identity 仍只保留 provider/ASR speaker label，没有完成跨 chunk 人物身份对齐。Queue/Worker、distributed lease、startup scanner、Redis 和部署均不在本任务范围内。

## Next Steps

下一次真实验收前，在专用空白账号和隔离 data root 设置 `EVALUATION_MODE=true`，确保没有混用真实用户流量。只运行一次 45 分钟 Pipeline；观察 job `ready` 后读取 `evaluation-reports/{uploadId}`，核对原始音频、upload record、9 个 ASR chunk、transcript、三类 Analysis checkpoints、Memory/evidence/relations 和 reducer candidate audit 均存在。保持 UI 自动 DELETE 请求无确认 header；它应返回 `409` 且不写 deleted marker。

使用新日志逐 chunk 比较 `context_chars_before/context_chars_after/prompt_chars`、response complete time、output chars/status、parse/validation、failure phase、retry/fallback；将 timeout 诚实归为 provider wait，除非 provider headers 或新的流式 telemetry 能进一步证明 queue 或 generation。审计前 5 分钟候选的 selected/rejected reason 与 score，检查同义 merge 和独立主题保留，不使用固定数量截断。

验收完成并复制 audit report 后，如确需删除测试数据，发送带 `x-evaluation-delete-confirmed: true` 的 authenticated DELETE，并复查 upload、checkpoints、Memory/evidence/relations 和 report 已清理。真实验收稳定后再单独评估 Queue/Worker；继续复用现有 AnalysisChunk checkpoint 契约，不在本任务中提前引入 BullMQ 或 Redis。

# 2026-07-16 - Evaluation Retention Final Hardening and Validation Correction

## Background

在上一条 Evaluation Retention / Relationship 记录完成后，最终只读审计又发现四类需要在交付前修正的问题：全局 `EVALUATION_MODE=true` 会影响同进程普通用户；evaluation report 虽早于 job `ready`，但仍晚于 upload `ready`；DELETE 吞掉 checkpoint/Memory 清理错误后可能返回成功并留下不可重试残留；宽泛的“工作忙吗、家里人好吗”寒暄仍可能穿过 Relationship quality gate。此外，validation 阶段丢弃的 raw candidate 尚未进入逐候选 reducer audit，provider 默认值与 checkpoint fingerprint 也存在 `unset=openai` / `none` 碰撞风险。

本记录是对上一条同日记录的追加纠正，不覆盖历史文本。以下最终设计、文件状态和验证数字优先于上一条记录中“实例级 retention”“DELETE catch-and-continue”、旧 fixture digest 与旧测试总数等描述。

## Design

Evaluation Retention 改为双重显式授权：`EVALUATION_MODE=true` 只开启服务端能力；单次上传还必须带 `x-evaluation-retention: true`，服务端才在 upload record 持久化 `evaluationRetention: true`。因此同进程其他用户和未标记 upload 完全沿用 production cleanup。`validate:pipeline` 在读取到 evaluation mode 时自动发送该 header，并验证服务端响应确实标记 retention。

终态顺序固定为 `audit report -> upload ready -> job ready`。确认 DELETE 采用可重试清理：先写 deleted marker 阻止 Pipeline 继续写入，清理子资源和 Memory，最后才删除 evaluation report 与 parent upload；任一子清理失败返回 `500 upload_cleanup_failed`，parent 保留，后续可用同一 DELETE 重试。被标记的 evaluation upload 仍需要 `x-evaluation-delete-confirmed: true` 才允许删除。

Relationship gate 以实际 transcript evidence 判断寒暄，不允许 provider 用较长 summary 把“工作/家人近况”包装成 substantive context。validation rejection 按原始数组位置生成稳定 candidate ID，连同 reason 写入 checkpoint metadata；reducer audit 为它们输出 `selected=false`、`clusterId=null`、零值 score 和具体 reason。checkpoint replay 恢复 validation audit、`rule_fallback` 与 `deterministic_skip` provenance。Processor fingerprint 的 provider 默认值与实际 runtime 一致为 `openai`，显式 `none` 不再与 unset 碰撞。

## Architecture Change

Before:

```text
EVALUATION_MODE=true
-> all uploads in process retained / DELETE blocked

upload ready
-> audit report
-> job ready

DELETE child cleanup failure
-> warning swallowed
-> parent removed + deleted=true

raw candidate
-> validation reject disappears from per-candidate audit
```

After:

```text
EVALUATION_MODE=true + x-evaluation-retention=true on POST
-> only that upload has evaluationRetention=true
-> audit report
-> upload ready
-> job ready

confirmed DELETE
-> deleted marker
-> audio/chunks/checkpoints/artifacts/jobs/answers/Memory cleanup
-> report delete
-> parent upload delete
-> failure before parent delete returns retryable 500

raw candidate
-> validation audit
-> quality gate
-> complete-link cluster
-> quality-aware selection
-> per-candidate audit, including checkpoint replay
```

## Technical Implementation

`src/lib/server/evaluation/retention.ts` 新增 per-upload request header、upload marker 与判定函数；`src/app/api/uploads/route.ts` 只在 env 与 header 同时成立时写 marker；`scripts/validate-pipeline.mjs` 自动申请并校验 evaluation retention。`.env.example` 说明 production 默认关闭及双重 opt-in 语义。

`src/lib/server/pipeline/process-upload.ts` 只对已标记 upload 启用 retention，并把 report 写入放到 upload/job 两个 ready 写入之前。对应测试覆盖 `EVALUATION_MODE=true` 下未标记 upload 仍删除音频、已标记 upload 保留音频/artifacts/checkpoints/Memory/report，以及 `audit-report -> upload-ready -> job-ready` 的实际写入顺序。

`src/app/api/uploads/[uploadId]/route.ts` 不再 catch-and-continue checkpoint/Memory 错误；parent upload 最后删除，失败响应明确可重试。`src/app/api/routes.test.ts` 覆盖 production delete、evaluation block、confirmed delete、同模式未标记 upload 不受影响，以及首次 Memory cleanup 失败后 parent 保留、第二次 DELETE 成功。

`src/lib/server/relationship-signals/candidates.ts` 扩展普通寒暄识别，移除把宽泛“工作/家人/健康/项目”名词直接视为 substantive context 的豁免；validation rejection 进入最终 reducer audit。`chunk-processing.ts` 将 validation rejection 写入/恢复 checkpoint metadata，恢复 fallback/skip result source，并把 provider fingerprint 默认规范化为实际 runtime 默认 `openai`。schema/normalization fingerprint 更新为 `relationship_candidate_v2_validation_audit` / `relationship_evidence_quality_v4`，避免旧 checkpoint 伪命中。

相关最终文件包括 `.env.example`、`scripts/validate-pipeline.mjs`、upload POST/DELETE routes 与 route tests、`src/lib/server/evaluation/{retention,audit-report}*.ts`、`src/lib/server/pipeline/process-upload*.ts`、`src/lib/server/openai/structured-json*.ts`，以及 `src/lib/server/relationship-signals/{provider,openai-provider,candidates,chunk-processing}*.ts`。

## Decision & Trade-offs

选择 per-upload marker 而非 evaluation user allowlist：一次验收只保护明确上传，账号可继续存在而不会让后续普通 upload 永久保留；同时不需要把用户 ID 放入环境配置。代价是通过普通 UI POST 的上传不会仅因 env 开启而自动受保护，下一次真实验收必须使用已更新的 `validate:pipeline` 或等价 API 请求携带 opt-in header。

由于任务禁止 frontend 修改，自动 local-cache cleanup 与 UI 手动删除仍发出相同的无确认 DELETE。被标记 upload 的这两类请求都会返回 409；真正主动删除必须使用受控 authenticated API 请求加确认 header。这个限制比猜测用户 intent 后误删 audit 数据更安全。

DELETE 不是跨 JSON/SQLite/filesystem 的事务，但通过 parent-last 和幂等子删除实现可重试语义。若中途失败，部分子资源可能已删除，不过 parent 仍可寻址，第二次请求能完成剩余清理，不再返回虚假的 `deleted=true`。

Relationship 没有提高 75 秒 timeout、增加无限 retry 或固定 Card 上限。非流式 API 的 TTFT 与 provider queue 仍不可观测；日志用 `first_response_ms=-1`、`finish_reason=unavailable`，不伪造精度。

## Validation

最终 `npm run lint` 通过，包括 Next route typegen 与 `tsc --noEmit --incremental false`。最终聚焦套件为 `7 files / 81 tests` 全通过；DELETE/retention 定向 route cases 为 `6/6` 通过。`git diff --check` 无 whitespace error，仅输出工作区既有 LF/CRLF 提示。

完整 `npm test` 最终运行 `101` files、`728` tests：`98` files、`722` tests 通过，`6` tests 失败；另有 `e2e/relationship-signals.spec.ts` 被 Vitest 收集时触发既有 Playwright runner 冲突。6 个 test failure 与交接一致，均为 Windows 上的 POSIX path/本地目录断言：upload path 3 个、settings path/open-folder 2 个、provider-config path 1 个。中间一次全量运行曾暴露新增 provider resolver export 与既有整模块 mock 不兼容，导致 5 个 Pipeline tests 失败；已改为 chunk-processing 内部纯规范化并重跑，最终这些 5 个均恢复通过。

`npm run analysis:verify-checkpoints` 在默认环境首次按保护逻辑拒绝执行（要求 `NODE_ENV=test|development`）；仅在命令进程设置 `NODE_ENV=test` 后最终通过。多日第二次 Audio Insight / Daily Brief / Relationship 各 `8 hits / 0 misses`，partial invalidation 三阶段各 `1 stale`；长 fixture 第二次 Audio Insight 与 Relationship provider counters 均为 `0`；network attempts `0`。6 个 100ms Daily Brief mock 的 concurrency `1/2/3` wall-clock 为 `640/322/215ms`。Evidence First 五项均为 `0`。

隔离多日 fixture 在最终代码上连续运行两次，均为 Must `14/14`、Should `7/7`、Must Not violations `0`、Memory `12`、evidence `42`、relations `9`、warnings `0`，两次 digest 均为 `30a6fb387f47aab8001b5e0617c1feb3827a8c3fd59c998f89600f3fed1c8d43`。这些是本地 fixture 结果，不是远端或生产验证。

本任务没有调用远端服务、没有重跑 45 分钟真实 Pipeline、没有部署、没有安装 Queue/Worker/BullMQ/Redis、没有 commit 或 push。

## Limitations

下一次真实 Pipeline 的实际 Relationship prompt chars、provider response timing、timeout/fallback 数和 Card 数尚未验证，不能从本地 fixture 推断真实 `704.696s` 已下降。旧长录音日志只记录总 heuristic input chars、segment/insight count 和 75 秒 attempt timeout，没有分别记录 semantic chars 或完整 prompt chars；这些字段只能由下一次新 telemetry 给出。

当前 evaluation UI 无法发送 confirmed-delete header；这不是永久不可删，受控 API 可删除。Retention 依赖进程在上传和完成审计期间持续保持 `EVALUATION_MODE=true`，且上传必须被显式标记。

逐 attempt 完整历史以 pipeline log 为准；checkpoint metadata 保存最终 attempt 的 metrics/diagnostics 和 validation audit。非流式 Responses API 仍不能区分 upstream queue 与 model generation。跨 chunk speaker identity、Queue/Worker 和 distributed lease 不在本任务范围。

完整 Vitest 的 6 个 Windows path failures 与 1 个 Playwright collection issue 仍未修复，因为它们是既有问题且不属于本任务目标。

## Next Steps

下一次真实验收使用空白专用账号和隔离 data root，设置 `EVALUATION_MODE=true`，通过 `npm run validate:pipeline` 或等价 API 上传，确认响应含 `evaluationRetention: true`。只运行一次 45 分钟录音，不混入真实用户 upload。

job ready 后先读取 `evaluation-reports/{uploadId}`，再核对原音频、upload、transcript、ASR chunks、三类 Analysis checkpoints、Memory/evidence/relations 和 reducer candidate audit。验证自动无确认 DELETE 返回 409，且 upload/checkpoints/Memory 均仍存在。

按 chunk 审计 `context_chars_before/after`、`prompt_chars`、segment/insight/semantic chars、output limit、response complete/parse/validation timing、failure phase、retry/fallback；比较 timeout/fallback 与旧基线，并审阅前 5 分钟 candidate 的 selected/rejected reason、clusterId 和 score。完成并复制报告后，再用 authenticated DELETE 加 `x-evaluation-delete-confirmed: true` 清理测试数据，并验证 parent 与所有子资源均删除。

# 2026-07-16 - Redis Compose and PM2 Process Configuration

## Background

为后续 queue execution 提供可审阅、可复用的本地 Redis 与 Ubuntu PM2 进程配置，同时保持本次工作为纯配置变更，不启动容器、不启动 PM2，也不执行部署。

## Design

Redis 使用固定 `redis:7.4.2-alpine` 镜像，仅绑定 loopback `127.0.0.1:6379`，通过具名 volume 持久化 `/data`。AOF 采用 `appendonly yes` 与 `appendfsync everysec`，在单机内部运行场景下平衡持久性和写入成本；`noeviction` 避免队列数据在内存压力下被静默淘汰。

PM2 使用 CommonJS ecosystem 文件以兼容项目根目录的 `type=module`。Web 与 Worker 都采用单实例 fork 模式；Web 运行 `npm start`，不在配置中固定端口，因此可继承外部 `PORT`。Worker 运行 `npm run worker`，日志落到项目相对 `logs` 目录，并使用 30 分钟 `kill_timeout` 覆盖当前约 20 分钟真实长录音基线的 graceful shutdown 窗口。

## Architecture Change

Before:

```text
Next.js process
-> no repository PM2 topology

Redis
-> no repository Compose definition
```

After:

```text
compose.redis.yml
-> Redis 7.4.2-alpine
-> loopback-only port
-> AOF + persistent named volume + healthcheck

ecosystem.config.cjs
-> daily-brief (npm start, fork, instances=1)
-> daily-brief-worker (npm run worker, fork, instances=1)
```

## Technical Implementation

新增 `compose.redis.yml`，配置固定 Redis 镜像、`127.0.0.1:6379:6379`、`daily-brief-redis-data` volume、AOF everysec、noeviction 和 `redis-cli ping` healthcheck。

新增 `ecosystem.config.cjs`，两个 app 的 `cwd` 均由 `__dirname` 解析，不包含服务器绝对路径。两个进程的 env 只写入 `NODE_ENV=production` 与 `PIPELINE_EXECUTION_MODE=queue`，没有 secret、API key、`APP_DATA_DIR` 或硬编码 `PORT`。Worker 使用独立 stdout/stderr 文件、5 秒 restart delay 与 30 分钟 kill timeout。

## Decision & Trade-offs

Redis 没有配置密码，因为端口只暴露到 loopback；如果未来跨主机访问，必须另行加入认证、TLS 和网络访问控制，不能直接放宽当前端口绑定。

PM2 明确限制为单实例 fork，因为本地文件、SQLite 和当前 Pipeline 生命周期不适合 Web cluster 或多个 Worker 同时消费前直接扩容。30 分钟 shutdown 窗口有利于完成已开始任务，但会使受控重启在长任务期间等待更久。

PM2 配置不写入 production data root 或 secrets；这些值继续由部署环境提供。配置引用相对 `logs` 目录，但本次未创建或写入任何运行日志。

## Validation

使用 Node 加载 `ecosystem.config.cjs` 并断言两个 app 名称、`cwd`、单实例 fork、watch=false、命令、仅两个允许的 env key、Web 无端口参数、Worker 日志路径和至少 20 分钟 kill timeout；结果为 `ecosystem config assertions passed`。

使用 PowerShell 对 `compose.redis.yml` 的固定镜像、loopback port、AOF、everysec、noeviction、volume 和 healthcheck 字段进行静态断言；结果为 `compose field assertions passed`。没有运行 Docker Compose schema 命令，因为本次禁止启动或依赖 Docker 环境。

## Limitations

本次只验证配置结构和字段，没有启动 Redis、没有验证 health 状态、AOF 文件、volume 持久化，也没有启动 PM2 或执行 graceful shutdown。Redis 未设置认证，当前设计仅适用于 loopback-only 单机部署。

PM2 的日志目录、外部 `PORT`、生产 data root、secret 和 Redis 连接信息仍需由实际部署环境准备。配置本身不能弥补当前 Pipeline 的任务恢复、lease 或进程异常恢复语义。

## Next Steps

在获准的部署窗口中先用 Compose schema validation 检查目标 Ubuntu 环境，再创建日志和持久化目录、注入外部环境变量，并分别验证 Redis health、Web readiness、Worker graceful shutdown 与 PM2 restart 行为。

部署前确认单个 Worker 的并发与 lease 配置符合真实长录音耗时，并在无活跃验收任务时执行首次 PM2 切换。

# 2026-07-16 - Durable BullMQ Queue / Independent Worker

## Background

原上传入口在写入 upload 与产品 Job 后，使用 Next.js `after()` 在 Web 进程内调用 `processUpload()`。该模式保留了请求后后台执行能力，但生命周期仍绑定 Next.js 进程：进程退出或部署重启时没有持久任务 lease；没有独立 Worker、队列级 retry、startup scanner 或跨进程 progress；长录音也会与 Web 请求共享进程资源。

本次目标是在不重写 ASR、Chunk、Transcript Merge、Audio Insight、Daily Brief、Relationship、Memory、QA 的前提下，引入 BullMQ + Redis 负责持久调度、有限重试、Worker crash recovery 与队列状态。现有 JsonStore 产品 Job 继续作为前端唯一可见状态，现有 Transcript/Analysis checkpoints 继续作为 Pipeline 内部恢复依据。未运行远端 provider、未运行真实 45 分钟 Pipeline、未部署、未 commit 或 push。

## Design

新增 `PIPELINE_EXECUTION_MODE=inline|queue`。默认 `inline` 保持原 `after() -> processUpload()` 行为并且不连接 Redis；`queue` 在上传文件、upload record 与产品 Job 落盘后，向 BullMQ 写入严格最小 payload `{ version: 1, uploadId, userRef }`，立即返回 `waiting`，不调用 `after()`，Redis 不可用时写入 `queue_unavailable` 并返回 503，绝不自动降级 inline。

BullMQ Job ID 固定为 `pipeline-${sha256(userRef + uploadId)}`。普通 producer 对 waiting、active、delayed、completed、failed 全状态去重，因此重复上传调度不会产生第二个任务，也不会在已完成后重复执行。startup recovery 是唯一可显式设置 `reviveTerminal=true` 的调用者：当产品 Job 仍可恢复而同 ID Bull record 已是 completed/failed 时，移除终态 record 后按同一稳定 ID 重建；已有 waiting/active/delayed record 只记为 `existing`，不重复添加。

Worker 默认全 Pipeline 并发为 1；内部 ASR/Audio Insight/Daily Brief/Relationship 并发保持原实现。Queue attempts 默认 3，使用 5 秒起始的 exponential backoff；provider/chunk retry 没有增加。中间 Worker/Pipeline 异常将产品 Job 重投影为 `waiting/retry_scheduled`，最终 attempt 收敛为 `failed/queue_attempts_exhausted` 并保留音频。BullMQ progress 是产品 Job progress 的 best-effort 投影，Redis progress 写入失败不会把已经持久化成功的 Pipeline stage 变成 provider retry。

音频生命周期调整为：processing、retry、failed 均保留；production ready 先持久化 upload ready，再删除音频并移除 `filePath`，避免“音频已删除但 ready 未落盘”的 crash window；Evaluation Retention upload 继续保留音频与全部审计数据。DELETE tombstone 会让 Worker 安全 ACK cancelled；取消清理增加 Memory `deleteByUpload`，避免独立进程中 DELETE 与 Memory 写入竞态留下新插入数据。

## Architecture Change

Before:

```text
Upload API
-> upload + product Job
-> Next.js after()
-> processUpload()
-> checkpoint
-> ready / failed
```

After:

```text
inline (default)
Upload API -> upload + product Job -> after() -> processUpload()

queue
Upload API
-> upload + product Job(queueJobId/executionMode/queuedAt)
-> BullMQ producer(stable jobId, minimal payload)
-> Redis AOF
-> independent Worker(concurrency=1)
-> existing processUpload()
-> existing Transcript/Analysis checkpoints
-> product Job progress + ready/failed

Worker startup
-> scan users/jobs-by-upload
-> waiting: enqueue
-> stale processing/transcribing/extracting: reproject waiting + enqueue/revive terminal Bull record
-> existing active Bull record: deduplicate; Bull stalled-job recovery owns execution
-> ready: skip Pipeline and reconcile terminal state/production audio cleanup
-> missing audio: failed
```

Web 与 Worker 均从同一 `APP_DATA_DIR` 读取 upload、artifacts、checkpoints 与产品 Job；Memory SQLite 也位于同一数据根。因此当前实现是单机共享文件系统架构，不是多主机对象存储架构。

## Technical Implementation

依赖与运行入口：`package.json` / `package-lock.json` 新增 `bullmq@^5.80.5`、`ioredis@^5.11.1`；`tsx@^4.23.0` 从 devDependency 移到 runtime dependency，确保 production Worker 能直接执行 TypeScript 入口；Node engine 设为 `>=22`。新增 `npm run worker`、`npm run queue:health`、`npm run queue:smoke`。安装过程没有升级无关声明、没有执行 `npm audit fix`；npm 报告仍有 2 个 moderate vulnerabilities。

Redis 与 PM2：新增 `compose.redis.yml`，固定 `redis:7.4.2-alpine`，只发布 `127.0.0.1:6379`，使用 `daily-brief-redis-data` named volume，启用 AOF、`appendfsync everysec`、`maxmemory-policy noeviction` 与 healthcheck。新增 `ecosystem.config.cjs`，定义 `daily-brief` 与 `daily-brief-worker` 两个单实例 fork 进程；Worker 有独立日志、5 秒 restart delay 与 30 分钟 graceful kill window。新增 `logs/.gitkeep`。没有写入 Windows 绝对路径、Docker Desktop 条件分支或 secret。

配置：`.env.example` 新增 `REDIS_URL`、`PIPELINE_QUEUE_NAME`、`PIPELINE_EXECUTION_MODE`、`PIPELINE_WORKER_CONCURRENCY`、`PIPELINE_JOB_ATTEMPTS`、`PIPELINE_JOB_BACKOFF_MS`、`PIPELINE_PROCESSING_STALE_MS`，production 默认仍为 inline。`src/lib/server/env/runtime-env.ts` 让独立 Node 入口按 Next 风格加载 env 文件且不覆盖 PM2/系统环境变量。`next.config.mjs` 将 BullMQ/ioredis 标记为 server external packages。

队列模块：`src/lib/server/queue/types.ts` 定义严格 payload schema 与稳定 SHA-256 Job ID；`config.ts` 负责有限整数、queue name、Redis URL 与脱敏 endpoint；`producer.ts` 使用 fail-fast Redis connect/ping、exponential attempts、全状态去重及 recovery-only terminal revival；`worker.ts` 校验 payload、加载 user-scoped JsonStore、映射 progress、调用一次现有 `processUpload()`、处理 retry/final failure、ready reconciliation、tombstone 与 missing audio；`recovery.ts` 扫描产品 Job 并准确区分 `enqueued` 与 `existing`；`runtime.ts` 启动 recovery 后运行 Bull Worker，监听最终 Bull failure 并把产品 Job 收敛到 terminal state；`src/worker/pipeline-worker.ts` 处理 SIGINT/SIGTERM，先停止接收新任务，再 `worker.close()`、等待 failure reconciliation、关闭 Redis，不直接调用 `process.exit()`。

产品 Job 与上传入口：`src/lib/domain/types.ts` 增加 `processing` 与 queue metadata；`src/lib/server/jobs/job-store.ts` 在 jobs 与 jobs-by-upload 两个 projection 中持久化 executionMode、queueJobId、queuedAt、updatedAt、workerStartedAt、queueAttempt。`src/app/api/uploads/route.ts` 在 queue 模式只落盘并 enqueue，返回 waiting；inline 路径保持兼容。`src/lib/server/pipeline/process-upload.ts` 增加 Job update callback、retry-safe audio lifecycle、terminal transcript artifact resume 与 DELETE/Memory 竞态清理。Queue retry 若已经完整写入 global `segments`，第二次直接复用，避免再次调用成功的 transcription provider；Analysis stage 继续由现有 AnalysisChunk fingerprint/checkpoint 决定 hit/miss。

运维与验证脚本：`scripts/queue-health.ts` 只输出脱敏 Redis endpoint、queue name、waiting/active/failed；`scripts/queue-worker-smoke.ts` 使用真实本地 Redis 与 deterministic mock provider，输出 `.data/evaluation/queue-worker-v1/report.md`、`report.json`、`recovery-report.json`。测试覆盖 stable ID、minimal payload、duplicate enqueue、Redis unavailable、inline 无 Redis、Worker consume/progress/retry/final failure、ready/tombstone/missing audio、terminal Bull record revival、startup recovery、audio retention、Evaluation Retention 与 DELETE/Memory race。

## Decision & Trade-offs

选择 BullMQ + Redis 而不是 Kafka/RabbitMQ/Kubernetes，是因为当前只需要单机持久队列、delayed retry、stalled-job recovery、progress 与独立 Worker；它能最小化对已有 Pipeline 的侵入。Redis 使用 AOF everysec，在单机队列 durability 与写入成本间折中；noeviction 避免队列键被静默淘汰，但需要主动监控磁盘和内存。

Queue 与产品 Job 分工保持清晰：Redis 管 waiting/active/retry/failed lease，JsonStore 管用户可见 waiting/processing/transcribing/extracting/ready/failed/progress。前端不直接查询 Redis。稳定 ID 同时防止双击/重试重复任务；为了满足异常不一致恢复，只有 startup scanner 可以重建 completed/failed Bull record，普通 producer 仍永久去重。

Queue retry 只包围完整 `processUpload()`，没有叠加新的 provider retry。成功的 AnalysisChunk checkpoint 直接命中；完整 transcript artifact 也可在 whole-job retry 中复用。生产失败不再删除音频，这增加本地磁盘占用，但确保 retry/recovery 仍有输入；失败音频的最终清理需要后续显式 retention policy。

Worker concurrency 默认 1，PM2 instances 也固定 1，因为单个 Pipeline 内已有多层 chunk 并发，本地 JsonStore 写队列只在单进程内串行，SQLite/本地文件也没有多 Worker fencing。当前实现不宣称水平扩展或 distributed filesystem semantics。

## Validation

`npm run lint` 最终通过，包括 Next route typegen 与 `tsc --noEmit --incremental false`。`npm run build` 最终通过，Next.js 15.5.19 完成 production compile、类型检查、18 个 static page generation 与 build trace。

Queue/Worker/Recovery/Job/env 聚焦测试最终为 `7 files / 30 tests` 全部通过；包含 Pipeline/audio/delete race 的聚焦组合为 `6 files / 55 tests` 全部通过。Upload route 的 queue enqueue 与 Redis unavailable 定向测试通过。`git diff --check` 无 whitespace error，仅有工作区既有 LF/CRLF 提示。

本地 Redis 由 Compose 实际启动并达到 healthy；解析配置确认固定镜像、loopback port、volume 与 healthcheck，运行时 `CONFIG GET` 为 `appendonly=yes`、`appendfsync=everysec`、`maxmemory-policy=noeviction`。`npm run queue:health` 返回 `ok=true`，queue 为 `daily-brief-pipeline`，waiting/active/failed 均为 0。验证结束后已执行 `docker compose -f compose.redis.yml stop redis`，容器停止，named volume 保留；未运行 PM2 或服务器部署。

`npm run queue:smoke` 最终通过 11 项断言。第一次运行在 2 个 Audio Insight AnalysisChunk 已 completed 后强制关闭 Worker；startup scanner 检测 stale 产品 Job 并重投影为 waiting，因稳定 Bull job 仍为 active，报告准确记录 `enqueued=0, existing=1`，第二个 Worker 由 BullMQ stalled-job recovery 继续执行并达到产品 Job ready/Bull completed/progress 100。重复 enqueue 返回 `enqueued=false`，Pipeline 总调用 2 次但 transcription provider 仅调用 1 次，Audio Insight provider 在 crash 前后保持 `2 -> 2`，两个 checkpoint 的 attemptCount 均为 1；remote provider calls 为 0。

Smoke audit 的 Evidence First 为 `evidenceCount=6`，`invalidSourceIds=0`、`nonVerbatimQuotes=0`、`duplicateEvidence=0`、`memoriesWithoutEvidence=0`、`orphanEvidence=0`。报告位于 `.data/evaluation/queue-worker-v1/`。

`NODE_ENV=test npm run analysis:verify-checkpoints` 最终通过。多日 fixture 第二次 Audio Insight、Daily Brief、Relationship Candidate 均为 `8 hits / 0 misses`；partial invalidation 三类各为 `7 hits / 1 stale`；长 fixture 第二次 provider counters 为 0，checkpoint hits 分别为 Audio 9、Daily Brief 7、Relationship 9；Evidence First 五项为 0，network attempts 为 0。6 个 100ms mock 在 concurrency 1/2/3 下约为 `655/328/217ms`。

完整 `npm test` 最终收集 108 个文件、761 个 tests；105 files / 755 tests 通过，6 tests 失败，另有 `e2e/relationship-signals.spec.ts` 被 Vitest 收集时触发 Playwright runner 冲突。6 个失败与交接基线相同：upload POSIX path 3 个、settings path/open-folder 2 个、provider-config POSIX path 1 个，均为 Windows 上的既有路径断言；Queue/Worker 新增测试没有失败。

## Limitations

没有运行真实 45 分钟 Pipeline、远端 provider、Ubuntu/PM2 进程或真实部署，因此不能从本地 smoke 推断服务器吞吐、真实 API rate-limit、真实长任务 SIGTERM 时长或 Redis AOF crash-loss window。当前 graceful shutdown 由代码、单测/本地 Worker 行为与 production build 验证，尚未在 PM2 上执行 kill/restart 验收。

BullMQ completed/failed records当前设置为 `removeOnComplete=false`、`removeOnFail=false`，用于保证重复 enqueue 不重新执行；配合 AOF/noeviction 会持续增长，尚无 queue pruning/archival policy。DELETE tombstone 会阻止 Worker 再处理并清理产品数据，但不会立即删除 Redis 中的 Bull record。producer 每次 enqueue 新建并关闭短连接，简化 fail-closed 行为但有连接开销。

当前只支持单机共享 `APP_DATA_DIR` 与单 Worker。JsonStore 的写入队列是进程内锁，不是跨进程 CAS/fencing；Bull lease 防止正常重复消费，但不能把本地文件系统变成分布式事务。Web 与 Worker 必须看到同一个绝对 data root、Memory SQLite 与相同 retention 配置，不能直接把 PM2 Worker 扩为多实例或迁到另一台无共享存储的主机。

startup recovery 对单个用户/Job 的读取或 ready-audio cleanup 错误尚未做逐项隔离；一个损坏 record 可使本次 Worker 启动失败并依赖 PM2 restart 重试。`PIPELINE_PROCESSING_STALE_MS` 默认 2 小时是基于当前约 20 分钟真实基线的保守值，仍需随真实最长任务校准。

Queue retry 只有在 global transcript `segments` 已原子落盘后才能跳过 transcription。若进程在 ASR 完成全局 merge/segments 写入之前崩溃，恢复行为仍由现有 AudioChunk/TranscriptChunk 实现决定；本次没有修改 ASR scheduler 或 Transcript Merge。AnalysisChunk 已完成 provider 不重复调用已由 smoke 与 checkpoint verifier 验证。

Redis 当前没有密码或 TLS，因为 Compose 只绑定 loopback。若未来 Redis 跨主机，必须新增 ACL/TLS/网络访问控制，不能把 6379 直接暴露公网。npm 安装报告中的 2 个 moderate vulnerabilities 未在本任务执行 audit fix。

## Next Steps

在 Ubuntu Server 准备 Node.js 22、Docker Engine 与 PM2，但先不要切换生产流量。将代码与 lockfile 部署到固定目录，设置 Web 与 Worker 共同可读写的绝对 `APP_DATA_DIR`，并在受控 env 中配置 `REDIS_URL=redis://127.0.0.1:6379`、`PIPELINE_EXECUTION_MODE=queue`、`PIPELINE_WORKER_CONCURRENCY=1`、queue attempts/backoff/stale threshold；production 保持 `EVALUATION_MODE=false`。

执行 `npm ci`、`npm run build`，再运行 `docker compose -f compose.redis.yml up -d redis` 与 `npm run queue:health`。先手动以 fixture/mock 启动 `npm run worker`，验证 waiting -> processing -> ready、SIGTERM graceful drain、Worker kill 后 Bull stalled recovery、startup terminal revival 与产品 Job 最终收敛；确认后再 `pm2 start ecosystem.config.cjs`，检查两个进程日志与共享数据权限，最后执行 `pm2 save`/系统 startup 配置。

服务器切换前增加 Redis memory/AOF disk 告警与 completed/failed Job pruning policy，并用隔离 data root 运行一次 queue smoke。只有这些验证稳定后，才使用专用空白验收账号和 Evaluation Retention 标记运行一次真实 45 分钟 Pipeline；ready 后先复制 audit report/checkpoints/Memory/evidence，再验证无确认 DELETE 被阻止。不要把首次 Queue 部署与真实长录音验收合并为同一个不可回滚步骤。

# 2026-07-16 - Deployment Hardening - Redis Port, PM2 Port and Data Directory

## Background

首次服务器部署检查确认目标主机不是纯净环境：服务器由 1Panel 管理，已经运行多个 Docker 项目、一个发布到 `0.0.0.0:6379` 的 `redis:8.4.0` 服务，以及其他 PM2 应用。因此不能继续假设宿主机 `6379`、Next.js 默认 `3000` 或 release 内 `.data` 可直接使用，也不能通过停止或修改未知服务来解决冲突。

本次任务只同步和修正部署配置、环境示例与迁移文档。没有修改 Pipeline、ASR、Memory、Relationship、QA、Chunk 或 Checkpoint，也没有启动远端 Pipeline、执行服务器迁移、部署、commit 或 push。

## Design

Daily Brief 继续使用项目自带的固定版本 Redis Compose 服务，但把宿主机 loopback 映射改为 `127.0.0.1:6380`，容器内部仍监听 `6379`。BullMQ 的默认示例连接相应改为 `redis://127.0.0.1:6380`。该方案隔离 Daily Brief Queue 数据和生命周期，不复用、不修改、也不停止服务器现有的 1Panel Redis。

PM2 Web 进程显式使用 `npm start -- -p 3200`，避免 Next.js 默认端口 `3000` 与其他项目冲突。Worker 保持 `npm run worker`，不监听端口。生产数据继续完全由环境变量提供；示例统一为 `APP_DATA_DIR=/opt/daily-brief/shared/.data`，未把服务器绝对路径写入应用或 PM2 逻辑。

部署文档把完整 `APP_DATA_DIR` 作为迁移单元，而不是只迁移 `memory.sqlite`。Web 与 Worker 必须读取同一个共享数据根，首次切换时需要保留文件系统中的用户、会话、上传、Job、transcript、checkpoint、设置及 Memory SQLite/sidecar 文件。

## Architecture Change

Before:

```text
Daily Brief Redis host port: 127.0.0.1:6379
Next.js PM2 command: npm start -> default port 3000
Production data example: /var/data/daily-brief
Migration guidance: no dedicated complete-data-root procedure
```

After:

```text
Existing server services
  -> remain untouched

Daily Brief Redis
  -> host 127.0.0.1:6380
  -> container 6379
  -> dedicated Compose project and named volume

daily-brief PM2
  -> npm start -- -p 3200

daily-brief-worker PM2
  -> npm run worker
  -> no listening port

Old APP_DATA_DIR /var/data/daily-brief
  -> migrate complete directory tree
  -> /opt/daily-brief/shared/.data
  -> same absolute path for Web and Worker
```

## Technical Implementation

`compose.redis.yml` 的端口映射由 `127.0.0.1:6379:6379` 改为 `127.0.0.1:6380:6379`，固定镜像、AOF、`appendfsync everysec`、`maxmemory-policy=noeviction`、healthcheck 与 named volume 均保持不变。

`.env.example` 将默认 `REDIS_URL` 改为 `redis://127.0.0.1:6380`，说明宿主机端口与容器端口的区别，并明确不能复用或停止绑定宿主机 `6379` 的其他 Redis。生产 `APP_DATA_DIR` 示例更新为 `/opt/daily-brief/shared/.data`，默认本地值仍为相对 `.data`，没有改变生产默认 execution mode 或 retention 配置。

`ecosystem.config.cjs` 将 `daily-brief` 的参数从 `start` 改为 `start -- -p 3200`。`daily-brief-worker` 仍使用 `run worker`，没有新增端口或改变并发、retry、graceful shutdown 配置。

新增 `docs/deployment/server-deployment.md`，记录共享服务器假设、端口分配、完整数据目录迁移、Redis Compose 隔离、两个 PM2 进程、环境变化后的 `pm2 restart ... --update-env`、验证清单以及不允许操作未知服务的约束。迁移清单至少包括 `users/`、`uploads/`、`jobs/`、`jobs-by-upload/`、`segments/`、`semantic-segments/`、`sessions/`、`settings/`、`memory.sqlite`、`memory.sqlite-wal` 和 `memory.sqlite-shm`，并要求保留实际数据根中的 transcript、AnalysisChunk checkpoint、Evidence、Relations 与 retention artifacts。

## Decision & Trade-offs

选择独立的 host port `6380` 而不是复用现有 `6379`，避免 BullMQ 与其他项目共享数据、配置、维护窗口和故障域。代价是部署时必须显式维护 `REDIS_URL`，并在每台服务器上先检查端口占用；如果 `6380` 也被占用，应在受控部署配置中选择新端口，而不是停止未知服务。

显式固定 Web 端口 `3200` 可以让反向代理和 PM2 行为稳定，但仍需在目标服务器确认端口没有被其他项目占用。`APP_DATA_DIR` 放在 release 目录外可支持版本切换并避免发布覆盖数据，但需要单独管理目录权限、备份和磁盘容量。

完整目录迁移比只复制 SQLite 占用更多停机窗口和存储空间，但能保留用户身份、产品 Job、上传记录、checkpoint 和审计连续性。SQLite 正在写入时必须使用维护窗口或一致性备份方法，不能遗漏活动的 WAL/SHM sidecar。

## Validation

`npm run lint` 通过：Next route typegen 成功，`tsc --noEmit --incremental false` 无错误。

`npm run build` 通过：Next.js 15.5.19 production build 编译成功、类型检查通过并生成 18 个 static pages。

`docker compose -f compose.redis.yml config` 成功解析配置，确认 published host port 为 loopback `127.0.0.1:6380`、target 为 container `6379`，AOF/noeviction/healthcheck/named volume 保持。命令只做静态解析，没有启动或修改任何容器；本地 Docker CLI 同时报告无法读取用户级 `config.json` 的权限警告，但 Compose 解析退出码为 0。

Node 静态断言确认 PM2 存在 `daily-brief` 与 `daily-brief-worker` 两个应用，Web 参数为 `start -- -p 3200`，Worker 参数仍为 `run worker` 且没有端口参数。部署文档断言确认包含 1Panel/共享服务器假设、`3200`/`6380`、SQLite WAL/SHM、两个 PM2 进程和 `--update-env` 指引。

本次没有运行测试套件或真实 Pipeline，因为没有修改业务逻辑。最终 `git diff --check` 与 `git status --short` 在本记录追加后单独执行并报告。

## Limitations

本次是本地部署配置和文档验证，不是目标 Ubuntu/1Panel 服务器上的实际部署。没有确认服务器 `6380`/`3200` 当前是否空闲，没有创建 `/opt/daily-brief/shared/.data`、没有复制 `/var/data/daily-brief`、没有验证真实文件权限，也没有启动 Docker Redis 或 PM2 进程。

现有 1Panel Redis 绑定 `0.0.0.0:6379` 的网络暴露、认证和升级策略属于服务器既有环境，本次没有修改或审计。新 Compose Redis 仍只适合单机 loopback 使用；跨主机连接仍需要 ACL、TLS 和网络访问控制。

文档列出的目录是最低迁移清单，真实旧数据根可能存在更多应用 artifacts，迁移时必须以完整目录树为准。PM2 `--update-env` 只解决进程环境刷新，不替代共享目录权限、反向代理、Redis durability、备份或回滚验证。

## Next Steps

在服务器部署窗口开始前，先运行 `docker ps`、`docker compose ls`、`ss -lntp` 和 `pm2 list`，确认 `3200`、`6380`、项目名、容器名和 volume 不与现有项目冲突。不要停止或删除无法确认归属的服务。

备份并完整迁移旧 `/var/data/daily-brief` 到 `/opt/daily-brief/shared/.data`，校验文件数量、权限、SQLite 主文件与 WAL/SHM，并让 Web 与 Worker 使用同一个 `APP_DATA_DIR`。先启动项目 Redis并运行 `npm run queue:health`，再构建并启动两个 PM2 进程；环境变化后使用 `pm2 restart daily-brief --update-env` 与 `pm2 restart daily-brief-worker --update-env`。

确认 Web 监听 `3200`、Worker 不监听端口、现有 1Panel Redis 与其他项目未受影响、迁移后的用户/上传/Job/checkpoint/Memory/Evidence/Relations 可读后，再运行小型 fixture/smoke。服务器基础验证稳定后，才安排专用账号的真实长录音验收。

# 2026-07-16 - Relationship Validation Diagnostics

## Background

真实 Queue Pipeline 的 Relationship Candidate 请求曾出现 JSON parse 成功但 Zod schema validation 失败。原日志只能确认 `failure_phase=validation`、`parse_result=success`、`validation_result=failed` 和 `failure_reason=validation_failure`，无法判断具体是哪个 candidate、哪个字段、missing field、enum、类型还是 evidence 结构失败。

缺少结构化失败详情会让后续审计无法区分 prompt、schema、输出长度或 provider 行为问题。本次任务只增加诊断能力，不修改 Relationship prompt、schema、reducer、candidate quality gate、token limit、retry、fallback、Memory、QA 或 Pipeline，也没有运行远端服务或真实长录音。

## Design

在通用 JSON parse 成功后的 Zod validation catch 路径中提取 `ZodError.issues`，将每条 issue 转换为有限、脱敏的 `{ path, code, message }`。Path 保留数组索引以定位 candidate，例如 `items[0].signalType`；`invalid_type + received=undefined` 归一化为更明确的 `missing_field`；message 使用固定安全文案，不复用 Zod 原始 message 或 invalid value。

详细 issue 最多保留 10 条，记录原始 issue 总数和 `validationIssuesTruncated`。同时按 code 聚合完整计数，生成 `validationIssueSummary: [{ code, count }]`。正常 validation success 不生成 issue 字段。

Relationship chunk processing 在 parse success + validation failed 时新增一条 `[relationship-provider] validation_failed` 日志，只输出 issue count、去重 code、最多 10 个安全 path 和 `truncated`，不输出 response、transcript、quote、token 或 error message。

## Architecture Change

Before:

```text
JSON parse success
-> Zod schema.parse failure
-> validation_result=failed
-> generic validation_failure
-> rule fallback
```

After:

```text
JSON parse success
-> Zod schema.parse failure
-> sanitize and bound Zod issues (max 10)
-> [relationship-provider] structural validation log
-> checkpoint metadata validationIssueSummary(code/count only)
-> existing non-retryable validation handling
-> existing rule fallback
```

## Technical Implementation

`src/lib/server/openai/structured-json.ts` 扩展 `StructuredJsonDiagnostics`，新增 `validationIssueCount`、`validationIssues`、`validationIssueSummary` 和 `validationIssuesTruncated`。Validation path 只保留字母、数字、下划线、连字符和数组索引，单段与总长度均有限制；issue message 由 code 映射到固定文案。详细 issue 列表最多 10 条，summary 对所有 Zod issues 按归一化 code 计数。

`src/lib/server/relationship-signals/chunk-processing.ts` 增加有界日志格式：

```text
[relationship-provider] validation_failed
validation_issue_count=<total>
validation_issue_codes=<bounded codes>
validation_issue_paths=<at most 10 sanitized paths>
truncated=<true|false>
```

Relationship Candidate checkpoint 原本会保存 `responseDiagnostics`。写入前现在显式移除详细 `validationIssues` 与嵌套 summary，并在 checkpoint 顶层 metadata 单独保存 `validationIssueSummary`。`responseDiagnostics` 仍保留 parse/validation 状态、时长、总 issue 数和 truncated 标记。通用 AnalysisChunk checkpoint schema 的 metadata 已允许安全的 unknown record，因此没有升级 checkpoint version 或修改 schema。

`src/lib/server/relationship-signals/openai-provider.test.ts` 新增 valid JSON、missing field、invalid enum、`evidenceSegmentIds` 类型失败和 invalid value 脱敏覆盖。`src/lib/server/openai/structured-json.test.ts` 验证固定安全 issue 结构、按 code 聚合以及 12 个 issue 只保留前 10 个详情并标记 truncated。`src/lib/server/relationship-signals/chunk-processing.test.ts` 验证 provider 日志字段、path 上限、transcript/quote/token 不泄漏，以及 checkpoint 只保存 code/count summary。

## Decision & Trade-offs

本次没有直接修改 prompt 或 schema，因为当前目标是先获得可审计的失败分布。没有数据支撑时调整 prompt 可能掩盖 enum、类型或缺字段等不同根因，也可能改变 candidate 质量和 fallback 比例。

详细 issue 只存在于单次进程 diagnostics 和有界日志中；checkpoint 只保存聚合 summary，避免长期持久化错误 message 或潜在 provider 输出。固定安全 message 会牺牲部分 Zod 原始文案细节，但 code、candidate index 和 field path 足以区分主要 schema failure，且显著降低 transcript、quote 或 invalid value 泄漏风险。

通用 Structured JSON helper 获得可选 diagnostics 字段，但没有改变其他 provider 的 parse、validation、retry 或返回行为。只有 Relationship chunk processing 新增详细日志和 checkpoint summary。

## Validation

运行：

```text
npx vitest run src/lib/server/openai/structured-json.test.ts src/lib/server/relationship-signals/openai-provider.test.ts src/lib/server/relationship-signals/chunk-processing.test.ts src/lib/server/relationship-signals/candidates.test.ts
```

结果为 `4 files / 48 tests` 全部通过。覆盖 validation success 无 issues、missing field、invalid enum、evidence 类型错误、最多 10 条 issue、truncated、日志脱敏和 checkpoint summary。

`npm run lint` 通过：Next route type generation 成功，`tsc --noEmit --incremental false` 无错误。

本次没有运行真实 45 分钟 Pipeline、没有调用远端 ASR/LLM、没有修改生产数据、没有 deploy、commit 或 push。

## Limitations

Checkpoint 只保存最后一次 provider attempt 的 validation summary，延续当前 attempt history 的持久化策略；如果未来允许 validation failure retry，需要另行设计跨 attempt 聚合。

当前 path 能定位 model response 中的 `items[index].field`，但不会保存 invalid received value。对于依赖具体非法文本才能分析的极少数 custom refinement，仍只能通过受控本地复现，而不能从生产日志恢复原始内容。

Validation diagnostics 只能解释 JSON 已成功解析后的 schema failure；provider timeout、incomplete response 和 invalid JSON 仍使用现有 failure phase/code，不会产生 validation issues。

## Next Steps

在下一次受控真实 Pipeline 中统计 `validationIssueSummary` 的 code/path 分布，优先区分 missing field、invalid enum、invalid type、size constraint 和 evidence structure。只有观察到稳定重复模式后，才单独评估是否需要调整 prompt、schema 或 provider output；不要在诊断数据不足时同时修改多个变量。

验收时继续检查日志和 checkpoint 不含 transcript、quote、token 或完整 API response，并比较 Relationship validation fallback 数量与历史基线。

# 2026-07-17 - Relationship Signal Provider Latency Optimization

## Background

两次 45 分钟真实 Queue Pipeline 已确认 Relationship Signal 的主要耗时来自 provider 长尾，而不是 deterministic reducer。本地 retained run `fbf09435-48bf-4f67-aa8c-e5b46a44cd0f` 的 Relationship 总耗时为 `299.532s`：首轮 provider wall-clock 约 `208.604s`，3 个 chunk 在 75 秒超时，串行 recovery queue 约 `90.029s`，provider attempt 累计 `483.590s`，reducer 仅 `33ms`。服务器 run `5740579c-c90a-4848-adb5-3fefb6479bda` 为 `293.385s`，并出现 validation failure 与 `max_output_tokens` incomplete response。

本次只优化 Relationship provider 的输入上下文、provider-only 输出契约和 incomplete retry tail。没有修改 ASR、Audio Insight 生成、Daily Brief、Transcript Merge、Queue/Worker、Redis、Memory admission/importance/relations、QA、前端、最终 `RelationshipSignalCard` schema、Evidence First 或 Evaluation Retention，也没有运行完整 45 分钟 Pipeline。

## Design

输入侧增加 deterministic Relationship Context Selector。当前 chunk 的完整 transcript、segment ID、时间、speaker 与 evidence backfill 所需信息全部保留；Audio Insight 根据现有 value/tone/emotion/interaction/atmosphere 结构字段评分，只保留与承诺、支持、冲突、边界、情绪变化、未决问题和 follow-up 有关的补充信息。Generic low-value insight、零 source 交集 insight 和完全重复 insight 被移除；跨 chunk insight 只要与当前 chunk 有 source 交集就保留，并只发送当前 chunk 内的合法 source IDs。选择逻辑不依赖咖啡、简历、博物馆等 fixture 文本关键词。

输出侧使用 provider-only compact candidate contract：`signalType`、`severity`、`confidence`、短 `summary`、1–6 个 `evidenceSegmentIds`，以及两类负向 signal 必需的短 `caution`。`signalCategory` 由服务端根据 signal type 保守推导；explanation、reflection、speaker、quote、time range 与完整 evidence 从真实 TranscriptSegment 确定性补齐。`severity` 保留在 compact contract，避免下游 importance 语义被隐式降为 low。Segment ID 长度限制为 96，summary/caution 分别限制为 180/160 字并禁止 Markdown/多行说明。

标准请求最多返回 5 个独立高价值候选；compact recovery 最多返回 3 个。超量响应先完整 schema validation，再按 confidence、evidence diversity 与 summary specificity 做 deterministic quality ranking，并记录 raw/selected/over-limit audit；不是按返回顺序机械截断。只有 diagnostics 明确为 `incomplete_reason=max_output_tokens` 时才切换 compact recovery，content filter、timeout 和其他 retryable failure 保持 standard recovery。

## Architecture Change

Before:

```text
TranscriptChunk + all related AudioInsights
-> verbose full RawRelationshipSignalItem response
-> max_output_tokens=2000
-> timeout/incomplete retry in serial recovery queue
-> candidate validation -> reducer -> final cards
```

After:

```text
complete TranscriptChunk
+ deterministic Relationship Context Selector
+ compact AudioInsight view
-> provider-only compact candidates (max 5)
-> deterministic source-ID validation and evidence backfill
-> existing candidate quality gate and reducer
-> unchanged final RelationshipSignalCard

max_output_tokens incomplete
-> compact recovery mode (max 3)

timeout / other incomplete reasons
-> existing standard recovery
```

Development/evaluation replay:

```text
retained TranscriptChunks + AudioInsights + Relationship checkpoints
-> Relationship provider/request-plan mock + reducer only
-> no ASR / Audio Insight / Daily Brief / Memory
-> no checkpoint persistence
-> source-tree SHA-256 before/after
-> isolated report outside retained runtime data
```

## Technical Implementation

新增 `src/lib/server/relationship-signals/context-selector.ts` 与测试，提供结构化 insight relevance score、exact-content dedup、compact view 和 `insights_before/after`、`insight_chars_before/after`、`removed_reason_counts` audit。`openai-provider.ts` 增加 compact Zod contract、request plan、2800 默认输出预算、standard/compact candidate limit、quality-aware over-limit selection、确定性 Raw adapter 与 direct-analyze 全 evidence-ID 验证。

`chunk-processing.ts` 将实际 selected context 纳入 input fingerprint，升级 processor/prompt/schema fingerprint，记录每次 attempt 的 recovery mode、input/prompt/output budget、diagnostics、raw/valid/compact candidate count，并输出 `first_pass_wall_ms`、`recovery_wall_ms`、`sum_provider_ms`、`critical_path_ms`。Checkpoint metadata 继续保存有界 validation summary，并新增 request metrics、recovery mode 与 candidate contract audit；没有保存 transcript、quote、完整 provider response 或 secret。

新增 `src/lib/server/relationship-signals/replay.ts`、`replay-cli.ts`、对应测试及 `scripts/replay-relationship-signals.ts`，并在 `package.json` 增加 `npm run relationship:replay`。Replay 默认 offline，阻断全局 fetch；远端模式必须同时提供 `--remote` 和 `RUN_RELATIONSHIP_REMOTE_VERIFY=1`。Report 必须位于 retained data root 外、拒绝覆盖，源目录运行前后做逐文件 SHA-256；缺失或重复 Relationship checkpoint 会显式失败，不会被误判为空 signal。

`.env.example` 的 `RELATIONSHIP_SIGNAL_CHUNK_MAX_OUTPUT_TOKENS` 默认值从 2000 调整为 2800。单候选 schema 极限按统一 `ceil(JSON chars / 2)` 启发式估算约 533 tokens，5 candidates 加 envelope 约 2671 tokens；retained 真实候选 compact 投影中最大 chunk 只有 1714 chars（启发式约 857 tokens）。2800 是有实际 retained 数据支撑的上限余量，不代表对所有语言/tokenizer 的数学硬保证，且 provider 只按实际生成 token 计量。

## Decision & Trade-offs

First-pass concurrency 继续为 2，recovery concurrency 继续为 1，attempt timeout 继续为 75 秒，max retry 继续为 1；没有通过无界并发、无限 timeout 或最终 Cards 固定截断换取数字。先降低进入 recovery 的请求数量，再由一次受控 remote replay 判断串行 recovery 是否仍是 critical path。

完整 transcript 不做截断，因为 Evidence First 需要逐字 source backfill。Context Selector 只压缩可由 transcript 恢复的补充 insight 信息；source-ref 高度重叠但 summary 不同的事实继续保留。Provider 不再重复输出 quote、speaker、time 或 evidence object，减少 output 长尾，同时把所有 source IDs 交给既有 candidate validator 严格校验。

没有新增第二次 reducer LLM。Offline replay 复用 retained valid candidates 来验证新 request plan、context size、compact wire projection、existing reducer 与 Evidence First；它不声称验证了新模型的真实 latency 或 compact schema adherence。Compact schema/adapter 本身由 provider 单元测试覆盖。

## Validation

Retained baseline 审计确认 9 chunks 的 transcript chars 为 28,857，insight chars 为 21,798，prompt chars 为 63,876；首轮 timeout chunks 为 2/3/5（0-based），prompt size 与 timeout 的 Pearson correlation 约 0.105，insight chars 与 timeout 约 0.106，没有明显线性关系。Candidate count 与 response chars correlation 约 0.864，response chars 与成功请求 duration 约 0.749，说明 verbose output 是更明显的长尾风险。本地 retained run 的 validation issue code/path 均为 0；服务器 run 的原始 validation diagnostics artifacts 不在当前工作区，因此没有虚构其 issue 分布。

Offline retained replay 报告位于 `.data/evaluation/relationship-latency-v2/report.json`。结果：transcript `28,857 -> 28,857`；insight `21,798 -> 10,255`（减少 53.0%）；prompt `63,876 -> 51,153`（减少 19.9%）；旧真实 response diagnostics `20,881 chars` 对 compact projection `11,782 chars`（预计减少 43.6%）。所有高负载 chunks 的 insight chars 均至少降低 30%。旧 provider candidates/valid candidates 为 `34/33`，offline projection 为 `33/33`；Cards `23 -> 23`，first-window Cards `2 -> 2`，type coverage 不变。工作压力支持、简历承诺、线上争执担忧、暂停/恢复协议、博物馆计划与 preference-adjacent relationship card 的时间窗覆盖均保持 true。

Replay 的 `remoteCalls=0`、`sourceArtifactsUnchanged=true`；Evidence audit 为 `invalidSourceIds=0`、`quoteMismatch=0`、`safetyViolations=0`。该 replay 没有写 Memory，因此没有宣称验证 Memory admission 或 Preference Memory。

Relationship/Structured JSON 聚焦回归最终为 `8 files / 85 tests` 全部通过；Memory/Pipeline/QA/Evidence/fixture 回归为 `8 files / 96 tests` 全部通过。`npm run lint` 通过，Next route typegen 与 `tsc --noEmit --incremental false` 无错误。

完整 `npm test` 收集 111 files / 794 tests；108 files / 788 tests 通过。剩余 6 个 Windows/POSIX 路径断言失败和 1 个 Playwright spec 被 Vitest 收集的问题与既有基线相同，Relationship 新增测试没有失败。没有修改这些越界模块来掩盖全量结果。

`RUN_RELATIONSHIP_REMOTE_VERIFY` 在 shell 与 `.env.local` 均未启用，因此没有执行真实 Relationship-only remote replay，也没有调用远端 ASR/LLM、运行完整 45 分钟 Pipeline、修改原 upload、覆盖 AnalysisChunk checkpoint、写 Memory、deploy、commit 或 push。

## Limitations

本次没有真实 remote after 数据，不能宣称已达到 `<180s`、first-attempt success `>=8/9`、retry/fallback/timeout/incomplete `<=1` 或 429=0 的目标。Offline replay 的十几毫秒 provider wall time只是内存 retained provider，不是性能数据；compact output 的 43.6% 是基于 retained candidates 的 wire projection，不是新模型实际响应长度。

旧 SDK/provider diagnostics 没有 first-byte time、token usage 或 finish reason，因此历史 timeout 仍不能在 provider generation slow 与 upstream request queue 之间进一步拆分。服务器 validation failure 的具体 issue code/path 需要服务器同步新 diagnostics 后由下一次受控 replay 采集。

Context Selector 只对现有结构化 labels 做 deterministic 评分；新 provider/新 label taxonomy 需要同步权重测试。First-window Cards 仍为 2，offline replay 只证明没有通过删除最终 Cards 伪造性能提升，不证明这两张都应长期保留。Relationship-only replay 不写 Memory，无法单独验证后续 admission/importance/relations 的真实数量。

2800 token budget 是基于字段上限、ID 长度限制和 retained projection 的工程估计，不是使用目标模型 tokenizer 得到的严格最大 token 证明。若真实 compact response 仍出现 max-output incomplete，应先检查实际 response/candidate audit，而不是继续盲目提高预算。

## Next Steps

只有在显式设置 `RUN_RELATIONSHIP_REMOTE_VERIFY=1` 后，才对 retained upload 执行一次 `npm run relationship:replay -- ... --remote`。保持 first-pass concurrency=2、recovery concurrency=1、timeout=75s，不写 Memory/原 upload/checkpoint；比较 wall-clock、first-attempt success、retry、fallback、incomplete、429、raw/valid candidates、Cards/type coverage 与 Evidence First。

如果 remote replay 达到 retry `<=1`，保持 recovery concurrency=1；只有仍有多个独立 retry 且 recovery queue 明确占据 critical path、同时无 429/timeout 增加时，才单独评估 recovery concurrency=2。若仍有 validation failure，使用已保存的 code/count 与日志 path 分布做最小 normalization；不得猜测 signalType、伪造 evidence 或弱化 schema。

真实 replay 未达标时保留单次脱敏报告，不自动调参重跑。下一步最小改动应由实际 failure phase 决定：max-output incomplete 检查 compact adherence，validation 检查确定性格式漂移，timeout 检查 provider queue/generation telemetry；不要同时修改 prompt、timeout、concurrency 和 reducer。

# 2026-07-17 - Daily Brief Provider Fallback Stability

## Background

三次 45 分钟真实 Pipeline 的 Daily Brief 均产生 6 个 semantic-guided chunks，但结果在 `4/6 provider success + 2 rule fallback / 118.641s`、`5/6 + 1 fallback / 87.853s` 和 `6/6 + 0 fallback / ~105s` 之间波动。Bounded concurrency=2 已经有效，deterministic merge 仅为毫秒级，不是瓶颈；真正缺口是旧 provider wrapper、checkpoint 与 scheduler 没有保存足够的 response/parse/validation/evidence diagnostics，历史 fallback 只能看到模糊的 `provider_error`。

本地 retained upload `fbf09435-48bf-4f67-aa8c-e5b46a44cd0f` 可恢复出 6 chunks、4 个 provider success、2 个 rule fallback 和约 `118.615s` checkpoint envelope，但无法从旧 artifacts 判断两个 fallback 是 response 前网络/timeout、incomplete、invalid JSON、schema validation 还是 evidence validation。服务器 `5/6 + 1 fallback` 的原始 checkpoint/log artifacts 不在当前工作区，也不能诚实归因。本次没有用猜测修改 prompt、模型或 token budget。

## Design

Daily Brief first pass 继续使用 bounded concurrency=2。每个 provider attempt 只发送一次可审计请求，OpenAI SDK automatic retry 固定为 0；retryable chunk 在所有 first-pass chunks 完成后进入独立 recovery queue，默认 concurrency=1、最多一次 retry、基础 delay=1000ms。成功 chunk 不重复执行，retry 仍失败或错误不可重试时才调用原 rule fallback。

失败分类覆盖 `network_error`、`fetch_timeout`、`provider_5xx`、`rate_limit`、`empty_response`、`incomplete_response`、`max_output_tokens`、`invalid_json`、`validation_failure`、`evidence_validation_failure`、`content_filter`、`deadline` 和 unknown。网络、timeout、5xx、429、empty、incomplete/max-output、invalid JSON 可重试；schema business rejection、Evidence First failure 和 content filter 不盲重试。`Retry-After` 只读取安全 header，并上限 30 秒。

保留现有最终 `BriefItem` schema、deterministic merge、Evidence First 和 3000 output-token budget。历史数据没有证明 max-output 截断，也没有完整 provider response 支撑 compact provider-only schema，因此本次没有删除 provider 字段、提高 token budget或改变最终 item 数量。只有 diagnostics 明确为 incomplete/max-output 时，recovery prompt 要求更短、最多 4 个高价值 items，并记录 `recovery_mode=compact`。

## Architecture Change

Before:

```text
6 Daily Brief chunks
-> bounded concurrency=2
-> provider/SDK wrapper 内部 retry 与有限 diagnostics
-> 单 chunk 最终异常立即 rule fallback
-> deterministic merge
```

After:

```text
6 Daily Brief chunks
-> first pass concurrency=2, one auditable request per attempt
-> safe parse + strict Zod + strict deterministic evidence validation
-> retryable failures collected after first pass
-> recovery queue concurrency=1, max one retry
-> provider_success | provider_retry_success | rule_fallback checkpoint
-> deterministic merge unchanged
```

Checkpoint lifecycle:

```text
completed + matching fingerprints + valid evidence -> hit
fresh processing -> wait and reuse foreign owner output
live owner -> periodic lease heartbeat
crashed owner -> short lease becomes stale -> reclaim only that chunk
corrupt/stale/failed -> recompute only that chunk
```

Development/evaluation replay:

```text
retained TranscriptSegments + SemanticSegments + Daily Brief checkpoints
-> chunk planning + provider/retry/fallback harness + deterministic merge
-> no ASR / Audio Insight / Relationship / Memory / QA
-> no source checkpoint or upload writes
-> isolated non-overwriting report
```

## Technical Implementation

`src/lib/server/extraction/failure-diagnostics.ts` 新增安全 failure classifier、retryability、bounded Retry-After、compact recovery 判断、Zod issue path/code summary 和 provider failure wrapper。Diagnostics 不读取或持久化 transcript、quote、response body、Authorization 或 secret。

`src/lib/server/extraction/openai-provider.ts` 禁用 SDK retry，统一每 attempt 单请求，记录 request start/finish、chunk/attempt/concurrency、segment/input/prompt chars、output budget、timeout、elapsed、HTTP/response/incomplete/parse/validation/evidence 状态、failure phase/reason、retry/fallback reason 和 recovery mode。Zod issues 最多记录 10 个安全 path；checkpoint 只保存 code/count summary，不保存 invalid value 或完整 response。Provider source IDs 必须属于当前 chunk，quote、speaker 和时间范围从真实 TranscriptSegment 确定性回填。

`src/lib/server/extraction/chunk-processing.ts` 增加显式 first-pass/recovery scheduler、budget-aware delay/timeout、三类 result provenance、attempt history、first-pass/recovery/critical-path stats，以及 checkpoint claim-before-provider。缓存和新输出均验证 uploadId、非空且不重复 source IDs、当前 chunk membership、精确 min/max time range 和逐字 excerpt。Fresh foreign owner 会被轮询复用；默认 checkpoint lease 为 `min(60s, total budget / 2)`，live owner 按 lease/3（最长 10s）heartbeat，正常完成前先停止并等待 in-flight heartbeat，crash orphan 可在当前 stage budget 内 stale/reclaim。

`src/lib/server/extraction/replay.ts`、`replay-cli.ts` 和 `scripts/replay-daily-brief.ts` 增加 Daily Brief-only replay。默认 offline 并替换 global fetch；远端必须同时提供 `--remote` 与 `RUN_DAILY_BRIEF_REMOTE_VERIFY=1`。Report 路径必须在 retained root 外并做 lexical + canonical realpath 校验，使用 `wx` temp file + hard link 原子发布且拒绝覆盖；retained source 在运行前后逐文件 SHA-256。Network audit 明确只观察 `global_fetch_only`，要求 dedicated CLI process。

Offline benchmark 将 retry 与 evidence normalization 分开：scheduler before/after 使用相同 normalized items，只改变 `maxRetries=0 -> 1`；每次 mock provider attempt 固定 10ms，并明确不代表 Tokenhub/provider latency。历史 quote mismatch 与 deterministic backfill 单独审计，避免把 evidence 修复混入 retry 性能对比。

配置新增 `DAILY_BRIEF_CHUNK_RECOVERY_CONCURRENCY=1`、`DAILY_BRIEF_CHUNK_MAX_RETRIES=1`、`DAILY_BRIEF_CHUNK_RETRY_DELAY_MS=1000` 和 `DAILY_BRIEF_CHUNK_MAX_OUTPUT_TOKENS=3000`；`EXTRACTION_MAX_RETRIES` 仅作为兼容 alias。`package.json` 新增 `daily-brief:replay`。

## Decision & Trade-offs

本次没有实现 compact provider-only schema或提高 output token。旧 artifacts 没有 response length、finish reason、parse/validation phase，无法证明重复 quote 字段或 3000 token budget 是 fallback 根因；无证据调整会同时改变质量和稳定性两个变量。现有每 chunk 最多 6 items 的 extraction contract 保持不变，未使用最终 `slice(0, N)`。

Validation failure 默认不可重试，因为真实 issue 分布尚不可恢复；未来只有观察到确定性格式漂移后才允许最小 normalization。Evidence source ID、逐字 quote、range 或安全拒绝不会为了提高 success rate 而弱化。

60 秒上限的 heartbeat lease 改善 worker crash orphan recovery，同时避免 live provider/recovery queue 被误判 stale。Analysis checkpoint 的 JSON store 仍没有跨进程 compare-and-swap/fencing；BullMQ stable job ID、默认单 Worker concurrency=1 和 heartbeat 将正常重叠概率降到很低，但极端情况下旧 owner 在 lease 过期并被新 owner reclaim 后恢复，仍存在窄窗口覆盖风险。本次不扩展 Queue/Worker 或通用 checkpoint storage 协议。

Retained 历史 output 有 17 个旧式非逐字 excerpt。Replay 将其明确列在 historical evidence audit，并对 replay fixture 做 deterministic backfill，所以 replay digest 不再与旧 final output 字节相同；这不是 item 删除或质量伪装。Report 不包含 title/body/transcript/quote 原文。

## Validation

本地 retained offline replay：

```text
npm run daily-brief:replay -- --upload-id fbf09435-48bf-4f67-aa8c-e5b46a44cd0f --data-dir .data/evaluation/relationship-validation-diagnostics-real-v1/runtime --report .data/evaluation/daily-brief-fallback-v2/report-v3.json
```

结果：`remoteCalls=0`、`sourceArtifactsUnchanged=true`、6 chunks、30 final items。Historical 为 first-attempt success 4、retry 0、fallback 2、checkpoint envelope `118615ms`。Scheduler mock before/after 为 `4/0/2 -> 4/2/0`（first success/retry/fallback），raw items `31 -> 31`、final items `30 -> 30`、type coverage 均包含 7 个现有 categories、output digest 稳定；fixed-delay mock wall `60ms -> 86ms` 只表示两次 recovery attempt 的额外 harness 成本，不是 provider 性能。

Prompt chars `30990 -> 42000`，因为 after 真实计入两次 recovery request；estimated output tokens 均为 4923。Historical evidence audit 为 invalid source 0、duplicate 0、range mismatch 0、quote mismatch 17；deterministic normalized replay 为 invalid source 0、duplicate 0、range mismatch 0、quote mismatch 0。

Retained 内容窗口审计仍覆盖工作压力、简历承诺、咖啡 preference、博物馆计划/未决问题、线上争执担忧以及暂停/恢复沟通协议；所有 7 个 Brief categories 均保留。该检查证明没有通过删除高价值类型获得 0 fallback，但 offline retained fixture 不是新 provider 质量或 latency 验证。

最终 heartbeat/lease 相关聚焦回归为 `8 files / 143 tests` 全部通过，进程正常退出，无 timer/open-handle 警告。更广的 Daily Brief/Structured JSON/checkpoint/Pipeline/fixture/Memory/QA 聚焦回归在本轮为 `24 files / 276 tests` 全部通过。`npm run lint` 通过，Next route type generation 和 `tsc --noEmit --incremental false` 无错误。

隔离 multi-day fixture replay 通过：Must `14/14`、Should `7/7`、Must Not violations `0`、orphan evidence `0`，digest `ec646e6ea07d3aa4ae4444db1e0bc8c2d94fcdc19a51de585e7597214dda92f1`，结果为 12 memories、42 evidence、9 relations、0 warnings。

完整 `npm test` 收集 `114 files / 865 tests`；`111 files / 859 tests` 通过。剩余 6 个既有 Windows/POSIX path assertions 和 1 个 Playwright spec 被 Vitest 收集的问题与 Daily Brief 修改无关；没有越界修改这些测试或业务模块。`git diff --check` 通过。

没有调用远端 Provider、没有执行真实 Daily Brief-only remote replay、没有运行完整 45 分钟 Pipeline、没有写 Memory、没有覆盖原 upload/checkpoint、没有 deploy、commit 或 push。

## Limitations

历史 fallback 的真实 failure phase 不可恢复：本地两个和服务器一个 fallback 目前只能标为 historical `provider_error/not_recorded`，不能声称是 timeout、invalid JSON、schema、evidence 或 max-output。新 diagnostics 只能从下一次运行开始提供分类。

没有真实 remote replay，因此尚未验证 first-attempt success `>=5/6`、retry/fallback/timeout/incomplete `<=1`、429=0、wall-clock `<=120s` 或理想 `<90s`。Offline mock 的 60/86ms 不代表 Tokenhub/provider latency。

Responses API/SDK 没有暴露可靠 first-byte time 和统一 finish reason 时，日志会诚实记录 unavailable；provider queue 与模型 generation slow 仍不能仅靠当前 elapsed 完全拆分。Network replay gate 只拦截/统计 global fetch，不是进程级 socket sandbox。

Checkpoint heartbeat 的 read/check/write 不是跨进程 CAS。极窄的旧 owner 恢复竞争需要后续通用 AnalysisChunk fencing token或原子条件写协议解决；这超出本次仅 Daily Brief provider fallback 的范围。显式调用方仍可传入不合理的自定义 `staleAfterMs`，生产默认值已保证小于正常 total budget。

Full Vitest 仍有既有跨平台 path 与 Playwright collection 基线失败。Report canonical check 与最终 link 之间仍有低风险 TOCTOU；专用本地 CLI 下可接受，但对抗恶意并发目录替换需要 directory-handle/openat 级方案。

## Next Steps

可以进入一次受控的新 45 分钟真实 Queue Pipeline 验收，但必须保持当前模型、prompt、3000 token budget、first-pass concurrency=2 和 recovery concurrency=1，不自动调参或整条重跑。验收应逐 chunk 记录 first attempt、retry/fallback、failure phase/code、response/incomplete/parse/validation/evidence 状态、checkpoint result source 和 wall-clock。

如果先做更低成本验证，只有同时设置 `--remote` 与 `RUN_DAILY_BRIEF_REMOTE_VERIFY=1` 时执行一次 Daily Brief-only retained replay；不写 Memory、原 upload或原 checkpoints。未达到目标时保留单次报告，不自动调整后重跑。

真实数据若显示 max-output incomplete，再评估 compact provider-only schema或有限 token 调整；若显示重复 validation code/path，再做确定性 normalization；若主要是 provider timeout/queue，则先补 first-byte/provider telemetry。不要同时修改 prompt、schema、timeout、concurrency 和 item contract。

后续单独为通用 AnalysisChunk checkpoint 设计跨进程 fencing/CAS，并补旧 owner 在 reclaim 后恢复不得覆盖新 owner的测试；该工作不应混入本次 Daily Brief验收前的 provider stability patch。

# 2026-07-17 - Long Recording 60m Queue Pipeline Acceptance

## Background

为避免继续用同一条 45 分钟素材验证长录音主链路，本次新增一套内容完全独立的约 1 小时中文双人关系场景基准，并在隔离的本地 Queue 环境中执行一次真实完整 Pipeline。目标是同时覆盖 BullMQ/Worker、12 个 ASR chunks、Transcript Merge、Audio Insight、Daily Brief retry/fallback、Relationship compact input/output、AnalysisChunk checkpoint、Memory/Evidence/Relations、Proactive Insight 和 Evaluation Retention。

本次允许真实调用 speaker-ASR、DeepSeek/Tokenhub/OpenAI-compatible providers，但完整 WAV 只允许上传一次。未修改 ASR、Transcript Merge、任一 Provider、Relationship reducer、Memory admission/importance/relations、Queue/Worker、Redis 配置、QA 或前端，也没有部署、commit、push、reset 或 clean。

## Design

新数据集 `test-data/long-recording-60m-v1/` 使用 `dialogue.json` 作为唯一台词来源，自动导出 `dialogue.txt`。192 个自然话轮由 A/B 严格交替，分布在 12 个五分钟故事窗口；故事覆盖读书会分享焦虑、周二 19:00 排练承诺、稳定饮食/环境偏好、陶艺计划与解决、临时改计划的不适、通知边界协议和自然收尾，不复用简历、咖啡、博物馆或线上争执等旧 45 分钟核心故事。

音频生成只使用本地 Windows OneCore `Microsoft Yaoyao` 与 `Microsoft Kangkang`，通过 ffmpeg 统一为 16kHz、mono、pcm_s16le WAV，并用短自然停顿和语速微调达到 3592 秒。生成器对 dialogue/manifest/hash 做一致性校验；静态 validator 检查时长、codec、采样率、声道、音量、连续静音、每个五分钟窗口语音活动和 12-chunk 规划边界。生成 WAV 和 generation metadata 由 `audio/.gitignore` 排除，不进入 Git。

真实运行使用隔离目录 `.data/evaluation/long-recording-60m-v1/runtime`、独立 Queue name `daily-brief-pipeline-eval-60m`、本地 Redis `127.0.0.1:6380`、Queue execution mode、Worker concurrency 1 和 Evaluation mode。Web/Worker 共享同一个 Cloudflare tunnel URL；validator 使用 `--tunnel none`。运行器在任何上传前执行音频、Redis、端口、tunnel、Web 登录和 Worker ready 预检，并用 run-attempt marker 保证最多一次完整上传。

## Architecture Change

Before:

```text
existing 45m synthetic fixture
-> repeated long-recording validation baseline
-> reports assembled from individual retained runs
```

After:

```text
new 60m dialogue.json
-> local OneCore TTS + deterministic audio assembly
-> static audio gate (3592s / 12 planned chunks)
-> isolated Next.js Upload API
-> BullMQ queue + local Redis
-> independent Worker -> existing processUpload()
-> retained runtime artifacts
-> read-only sanitized acceptance audit bundle
```

业务 Pipeline 架构未改变；本次只增加测试素材、生成/静态验证脚本、隔离运行器和只读审计脚本。

## Technical Implementation

新增 `README.md`、`manifest.json`、`expected-results.json`、`dialogue.json`、自动导出的 `dialogue.txt`、`generate-audio.mjs`、`validate-audio.mjs`、`run-local-queue-evaluation.mjs`、`audit-pipeline.mjs` 以及 `audio/.gitignore`/`.gitkeep`。生成器使用 staging 文件和最后写 metadata 的顺序，记录 manifest/dialogue/transcript/audio SHA-256；validator 拒绝 stale audio、错误声线、错误话轮顺序、过长静音或窗口语音不足。

隔离运行器记录 preflight、单次 upload marker、脱敏 Web/Worker/validator/tunnel logs、run summary 和 BullMQ/Redis snapshot。Job data 和报告未保存 API key、password、token、Authorization、完整 Provider response 或不必要的完整 transcript。当前 Queue 实现未消费 `BULLMQ_PREFIX`，因此隔离实际依赖独立 Queue name；报告明确记录该限制，没有把环境变量误报为已应用。

`audit-pipeline.mjs` 以 readonly/query-only 方式读取 JsonStore、retained artifacts 和 SQLite，生成 `report.md`、`report.json`、`pipeline.log`、Queue/Worker/ASR/Audio Insight/Daily Brief/Relationship/checkpoint/Memory audit 及 45 分钟 historical baseline comparison。报告使用脱敏 identity refs，运行前后对 69 个 source artifacts 做 SHA-256，确认审计未修改 runtime。另保存 `retention-delete-audit.json`，记录真实未确认 DELETE 返回 409 且 upload 仍存在。

## Decision & Trade-offs

目标时长固定为 3592 秒，使默认 300 秒 planner 产生 11 个完整 300 秒 chunk 和 1 个 292 秒 chunk，避免异常短的第 13 个 chunk。为保持每个五分钟窗口都有真实语音，没有用大段静音机械补时，也没有裁断最后一句。

完整音频只上传一次。第一次运行器调用在 run-attempt marker、登录和上传前发现端口 3200 被本工作区遗留 Next.js 占用，确认 upload count 为 0 后只清理该遗留进程；之后唯一一次真实上传完成。Pipeline 运行期间没有调整 timeout、concurrency、模型或 prompt，也没有因失败重新上传。

Evaluation Retention 的真实无确认 DELETE 检查在只读报告已经生成后执行；route 在任何删除逻辑之前返回 `409 evaluation_retention_active`，upload record 继续存在。隔离 Redis 容器在审计完成后停止，volume 保留，未停止或删除其他 Redis/Docker 项目。

质量结论不因 Pipeline ready 而放宽。Relationship 的三个 validation fallback、一个重复 evidence、偏好/承诺 dedup 不足和跨事件合并均作为真实失败保留；没有修改 expected-results 或业务代码来掩盖结果。

## Validation

生成音频为 3592 秒（59:52）、114,944,078 bytes、pcm_s16le、16000Hz、mono，SHA-256 为 `2700327f8f529fc60f3c3b69bde4797a8dedd963852c0da247c880a13c6d3597`。Mean volume -20.5dB、peak -2.7dB、最大连续静音 6.593 秒；12 个五分钟窗口语音活动比例为 0.8045–0.8244。192 个话轮、12 个 section 和 dialogue hash 全部通过静态验证。

运行前 `npm run lint` 通过。与 Queue/Worker、ASR chunks、Transcript Merge、Audio Insight、Daily Brief、Relationship、Analysis checkpoint、Memory/Evidence 和 Evaluation Retention 相关的聚焦测试为 `40 files / 402 tests` 全部通过；额外 route 全量文件仍有 5 个既有 Windows/POSIX path assertions，定向 Queue/Retention API case 为 6 pass、52 skipped。`git diff --check` 通过。

唯一真实运行 IDs：upload `b46541ab-c007-420c-9f6f-b5fd38d664ed`，product job `6a623e5e-1cec-4f30-8782-98f4e13d72e5`，Bull job `pipeline-03f7e6c512c5e631be732920e20cf0f0989ddb514b37286dbe3a897386202bb0`。Product Job 为 ready/100；Bull job 为 completed/100，`attemptsMade=1`，Bull waiting 13ms、active 422470ms，无 whole-job retry、Worker crash 或 failed event。Redis snapshot 为 PONG、AOF yes、appendfsync everysec、noeviction、AOF last-write ok。

Pipeline 总耗时 `422414ms`，runner 端到端 `461979ms`。ASR `87123ms`，12/12 chunks completed、0 retry、307 segments，global IDs unique、timestamps monotonic/in-range、source traceable；merge 输入/输出均 307，warning 1。跨 chunk speaker reconciliation 仍未实现。

Audio Insight 为 12/12 provider success、0 retry/fallback/timeout/invalid JSON/429，93 insights，wall `59855ms`。Daily Brief 规划 8 chunks，concurrency 2/recovery 1，8/8 first-attempt provider success、0 retry/fallback/timeout/incomplete/invalid JSON/validation/evidence failure/429，47 raw items 经 deterministic merge 得到 30 final items，wall `143232ms`，接近但低于本轮 150 秒目标。

Relationship wall 为 `124601ms`；12 chunks 中 9 个 non-fallback completed（8 个非空 provider outputs 与 1 个 empty-safe result），0 retry/timeout/incomplete/invalid JSON/429，3 个 rule fallback。Chunks 6/7/8 均为 parse success、response completed，但每个返回的 5 个 `items[*].confidence` 都触发 `invalid_type`，共 15 个未截断 validation issues；由于该类 validation failure 不盲 retry，直接进入原 rule fallback。Context selector 将 insights `93 -> 52`、insight chars `29628 -> 15777`；45 candidates 经 quality gate 保留 28，聚为 26 clusters，最终 23 cards，reducer 38ms。Relationship evidence 65，invalid source/quote mismatch/safety violation 均为 0。

Analysis checkpoints 共 32：Audio Insight 12 provider success、Daily Brief 8 provider success、Relationship 9 provider success + 3 rule fallback；全部 completed、output present、input/processor fingerprint 有效，0 corrupt/processing/failed。Memory admission 输入 64 candidates，persisted 41、rejected 23，经 merge 后 SQLite 为 30 items：13 commitment、12 event、2 preference、2 question、1 relationship_signal；importance high 11、medium 19、low 0，active 29、resolved 1。Evidence 205，relations 9（follow_up 7、related 1、resolved_by 1），SQLite integrity/FK/cross-user checks 全部通过。Proactive runtime 实际生成 2 条具体且各带 2 个 evidence refs 的 insight。

Evidence First 最终为：`invalidSourceIds=0`、`nonVerbatimQuotes=0`、`duplicateEvidence=1`、`memoriesWithoutEvidence=0`、`orphanEvidence=0`。重复项是同一 long-term relationship signal Memory 对同一 transcript source 写入两条完全相同 quote 的 evidence，因此 Must `evidence_first_zero` 失败，不能声称五项全零。

语义验收为 Must `20/21`、Should `5/10`、Must Not `7/8`。读书会支持、明确排练承诺、稳定偏好、陶艺最终预约、通知协议和安全语言得到识别；失败/不足包括通知窗口的 Relationship card 被 fallback 影响、陶艺 question 未正确与最终 event resolve、偏好 occurrence 未 dedup、同一排练产生多个 Memory、前五分钟保留 2 张 Cards，以及结尾产物把陶艺、排练和通知规则合并为单一 event。未发现人格判断、心理诊断、分手建议或绝对关系裁决。

与不同代码版本的 45 分钟 run 仅作 historical reference：Pipeline 每音频分钟 `8730.87 -> 7055.91ms`（-19.18%），ASR -10.53%，Audio Insight -1.64%，Daily Brief +10.63%，Relationship -44.79%，Proactive -18.97%。Relationship raw wall 也由 168505ms 降到 124601ms，但 fallback rate 由 1/9 上升到 3/12，速度改善不能掩盖稳定性回归。

Evaluation Retention 保留 upload、原始 WAV、transcript、12 AudioChunk records、12 TranscriptChunk records、32 Analysis checkpoints、memory.sqlite/WAL/SHM、evidence、relations 和 evaluation report；deleted marker 不存在。真实未确认 DELETE 返回 409，且 upload 仍存在。审计 bundle 的 raw identities、`.env.local` 敏感值、email、Bearer、quote/transcript patterns 扫描均为 0 命中。

## Limitations

本轮未满足全部停止条件：Evidence First 有 1 条重复 evidence，Relationship fallback 3 超过 warning threshold 1，因此不能判定当前版本已完成稳定性收口，也不能建议长录音离线分析主链路在此版本最终封板。Pipeline ready 只证明调度和容错主链路完成，不等于质量门禁全部通过。

Relationship chunks 6/7/8 的 `confidence` 类型漂移已有安全 code/path diagnostics，但没有保存 invalid value 或完整 provider response，因此只能确定是 `invalid_type`，不能从报告猜测具体返回类型。没有现场修改 schema、normalization、prompt 或 retry，也没有重跑。

12 个 AudioChunk JSON records 均保留，但 planner 生成的 12 个中间 chunk WAV 已按现有生命周期清理；原始 60 分钟 WAV 保留。若“保留 ASR artifacts”要求包含每个分块音频二进制，现有 Evaluation Retention 尚未满足该更强定义。

Audit 的 `proactiveInsights=0` 是对 cache envelope/path 的统计盲点，retained runtime 和 evaluation report 实际均为 2。`queue-audit.events.enqueued=0` 是未纳入 Web enqueue log 的审计假阴性；Bull snapshot、stable job ID 和 Web log 均确认真实 enqueue。Relationship attempt 明细与 reducer candidateCount 的部分字段映射不足，应以 pipeline log 顶层聚合为准。

`BULLMQ_PREFIX` 当前未被 Queue 实现消费；本次隔离由独立 Queue name 保证。Windows 清理阶段需要额外终止一个确认属于本次任务的 Next.js 子进程树，随后 runner 正常退出；3200/6380 无监听。跨 chunk speaker identity 仍未全局对齐，报告不作相关完成声明。

## Next Steps

保持本次 retained runtime、SQLite/WAL/SHM、原始 WAV、日志和报告不变。下一步最小工作应首先复现并修复 Relationship compact candidate `confidence` 的确定性类型漂移，再补针对同一 Memory/source 的 evidence 唯一性或 admission dedup；两项均应先加失败测试，且不要通过弱化 schema/Evidence First 或增加 timeout 解决。

随后单独处理 preference occurrence、rehearsal commitment consolidation、pottery question resolution 和跨事件 merge，并补 audit parser 对 Proactive cache、enqueue event、Relationship attempt/reducer 字段的映射。若 Evaluation Retention 的验收定义要求保留 chunk WAV，再明确扩展生命周期契约；不要把 metadata record 与 binary artifact 混为一谈。

上述问题修复并通过离线/聚焦回归后，才考虑创建新的版本化素材或一次新的受控真实运行。不得对本次 60 分钟 WAV 自动重新上传，也不得用调参后重跑覆盖当前失败证据。

# 2026-07-17 - Relationship normalization + Memory dedup hardening

## Background

60 分钟真实 Queue Pipeline 暴露了三个确定性质量问题：Relationship chunks 6/7/8 的 Provider JSON 已成功解析且 response completed，但 `items[*].confidence` 共出现 15 个 `invalid_type` validation issues，最终导致 3 个 rule fallback；同一 Relationship Memory 对同一 transcript source 写入了两条语义相同的 evidence，使 Evidence First 的 `duplicateEvidence=1`；稳定偏好在首次表达和伴侣后续记住时没有按偏好事实合并，同时宽泛的 semantic candidate 会把多个不同偏好桥接成一个聚合 Memory。

本次只修复确定性 normalization 和 storage/dedup 行为。没有修改 ASR、Transcript Merge、Queue/Worker、Redis、Daily Brief、Relationship prompt/reducer 核心策略、Memory importance 评分、QA、前端或对外 schema；没有调用远端 Provider，也没有重新运行完整 60 分钟 Pipeline。

## Design

Relationship confidence 在 strict Zod validation 前执行 closed-set conservative normalization：仅将忽略大小写且 trim 后严格等于 `high`、`medium`、`low` 的字符串映射为 `0.85`、`0.65`、`0.35`。数字保持原值；`null`、未知字符串和自由文本保持不变并继续由原 schema 拒绝。这样兼容已知 Provider 格式漂移，但不猜测置信度、不绕过 Zod，也不改变 evidence validation。

Evidence 使用最终 storage identity 做 deterministic dedup。唯一键至少包含最终 `memoryId + sourceId + normalized quote`，实现中额外包含 `uploadId` 以保留跨 upload/source-id namespace 的语义；quote 仅执行 NFKC、trim、连续空白和 Unicode 标点规范化，不做改写、embedding 或 semantic similarity。合并层在 importance 计算前去重，repository 写入前再做统一防御，因此不限于 Relationship 来源。

Preference 使用已有提取文本形成内部、非持久化 identity，而不扩展 Memory schema。identity 由稳定的偏好对象和 polarity/value（`prefer` 或 `avoid`）组成；只接受保守的明确偏好表达，拒绝一次性选择、纯元话语和把多个偏好桥接在一起的复合候选。同一用户、同一 preference identity 合并；不同偏好或不同用户保持独立。一次 upload 内的多次观察通过 extractor audit 的 `observationCount` 记录，持久化 `occurrenceCount` 继续表示不同 upload 的出现次数，避免同一录音内重复表达触发 `repeated_occurrence` importance 加成。

## Architecture Change

Before:

```text
Relationship response -> strict schema validation -> confidence string validation failure -> rule fallback

Memory merge -> evidence ID dedup only -> final memory/source/quote duplicates may survive -> SQLite

preference candidates -> broad token overlap merge -> meta statement / multiple preference facets may collapse together
```

After:

```text
Relationship response
-> closed-set confidence normalization
-> unchanged strict Zod validation
-> unchanged evidence validation

all Memory sources
-> final memory identity rewrite
-> deterministic memory/upload/source/quote evidence dedup
-> importance calculation
-> repository defensive dedup
-> SQLite

preference observations
-> conservative internal identity extraction
-> reject meta/one-time/broad bridge candidates
-> merge exact user + preference key + value
-> preserve earliest/latest evidence and same-session observation audit
```

## Technical Implementation

`src/lib/server/relationship-signals/openai-provider.ts` 新增 `normalizeRelationshipConfidenceLabels()` 并接入现有 structured JSON normalization hook；发生转换时只记录 `[relationship-confidence-normalization] field=confidence original_type=string normalized=true count=N`，不记录原字符串、response、transcript 或 quote。`src/lib/server/relationship-signals/chunk-processing.ts` 将 normalization processor fingerprint 从 v1 提升到 v2，确保旧 Relationship checkpoint 不会错误命中新契约。

新增 `src/lib/server/memory/evidence-deduplication.ts`，并在 `memory/deduplication.ts` 与 `memory/repository.ts` 的 merge、incoming、recalculate、rebuild 和最终 write 路径复用。确定性 winner 优先 transcript evidence，再按 `createdAt/id` 排序；repository 聚合记录 `[memory-evidence-dedup] removed=N ...`，不输出 quote。Evaluation audit、memory-quality evaluator、checkpoint verifier 和 60 分钟审计脚本统一使用同一 duplicate identity，避免 runtime 与报告定义漂移。

新增 `src/lib/server/memory/preference-identity.ts`。`memory/admission.ts` 要求 stable preference 同时具备 concrete identity；`memory/extractor.ts` 将直接偏好观察按 identity 原子化，避免宽泛 structured candidate 向单个偏好注入无关 evidence，并在 audit 中记录 identity hash、normalized value 和 observation count；`memory/deduplication.ts` 对相同 identity 合并、对显式 polarity 冲突拒绝合并，并仅在一侧缺少 identity 的 legacy Memory 上保留原 token fallback。Memory 对外类型、SQLite schema 和 importance 算法均未改变。

测试覆盖 exact label normalization、未知/null 拒绝、数字保持、日志脱敏；相同 memory/source/规范化 quote 去重、不同 Memory 或不同 quote 保留、merge/rebuild/write 防御与 removed count；同偏好同用户合并、不同偏好/用户分离、一次性选择/元话语拒绝、同一 upload 不增加 persisted occurrenceCount、evidence 保持可追溯。

## Decision & Trade-offs

没有放宽 `confidence: number` schema，因为真正的问题是少量已知枚举式格式漂移；closed-set adapter 比 coercion 任意字符串更安全。`null` 和 `very high`、`probably`、`sure`、`maybe` 等自由文本仍失败，避免猜测模型含义。

Evidence 唯一性不只放在 Relationship path。最终 repository 防线保证所有 Memory 来源一致，同时 merge 前去重可避免重复 evidence 参与 importance 计算。加入 `uploadId` 是为了不把不同录音中可能复用的 legacy source ID 误判为同一证据；同一 source 的不同逐字片段仍可保留。

Preference 没有新增持久化 category/value 字段，以遵守 schema 边界。代价是 identity 只覆盖可确定性解析的明确表达；无法安全解析的语义改写不会被猜测性合并。60 分钟 retained 数据从 2 条有问题的 Preference（1 条元话语、1 条跨主题聚合）变为 5 条原子偏好事实；数量增加不是 regression，也不是通过减少 Memory 伪造 dedup，而是把香菜、辣度、清淡、安静/不拥挤及具体座位环境等不同 value 正确分开，同时各 identity 内的重复观察合并。

## Validation

先增加失败测试，确认原实现不能接受 `confidence: "high"/"medium"/"low"`、不能阻止 merge 后 evidence semantic duplicate，也不能稳定区分 preference identity；实现后 Relationship/Memory 聚焦测试为 `9 files / 101 tests` 通过，追加回归为 `6 files / 65 tests` 通过。Pipeline、QA、fixture replay、Memory 与 Relationship 的联合聚焦回归为 `26 files / 222 tests` 通过。

`npm run lint` 通过，包括 Next route type generation 和 `tsc --noEmit --incremental false`。完整 `npm test` 收集 115 files / 882 tests，其中 112 files / 876 tests 通过；剩余 6 个失败是既有 Windows/POSIX path assertions，另有 1 个 Playwright spec 被 Vitest 收集的问题，本次未越界修改。`git diff --check` 通过，仅显示工作区既有 LF/CRLF 提示。

对 retained 60 分钟 SQLite 进行只读 helper audit：evidence `205 -> 204`，deterministic removed `1`，原数据库未修改。隔离的 in-memory memory-quality replay 输出 33 memories、162 evidence、16 relations，Evidence First 为 `invalidSourceIds=0`、`nonVerbatimQuotes=0`、`duplicateEvidence=0`、`memoriesWithoutEvidence=0`、`orphanEvidence=0`，且 `networkAttempts=0`。5 条原子 Preference 的持久化 `occurrenceCount` 均为 1；同一事实在 audit 中分别记录 1–3 次同-session observation，没有触发 importance 的重复出现加成。

Relationship offline replay 使用 retained artifacts，结果为 12 chunks、23 cards、0 network calls，source artifacts hash 未变化，Relationship evidence invalid source/quote mismatch/safety violations 均为 0。该 replay 复用 retained checkpoint/fallback output，不能重放未保存的原始 invalid Provider JSON；因此真实基线仍诚实记录为 3 个 validation-failure chunks / 15 个 confidence issues。新增 mock Provider 测试证明受支持的三个 label 归一化后不再产生该 validation failure，但没有将 offline replay 的 0 retry/0 fallback 误报为真实 Provider 改善。

## Limitations

Retained artifacts 没有保存失败 Provider response 的 invalid value，因此不能证明 chunks 6/7/8 当时实际返回的字符串恰好是 `high`、`medium` 或 `low`。若它们是其他自由文本，本次设计会按安全策略继续 validation failure。真正的 fallback before/after 需要未来一次明确授权的 Relationship-only remote replay 或新完整验收；本次没有远端调用，也没有重跑完整音频。

Preference identity 是 deterministic、保守的结构化适配，不是通用中文 NLP。超出闭合表达模式的同义改写可能暂时保持为独立 Memory；这比错误合并不同偏好或猜测 polarity 更安全。`observationCount` 当前只存在于 extractor audit，不是持久化 schema；跨 upload 的长期 occurrence 仍由现有 repository 语义处理。

完整 Vitest 仍保留既有跨平台 path 和 Playwright collection 基线问题。工作区还包含此前 Queue/Worker、Daily Brief、Relationship latency、部署与 60 分钟数据集的连续未提交修改；本次没有 reset、clean、commit、push 或 deploy。

## Next Steps

下一次受控验收可优先执行一次 Relationship-only remote replay，确认真实 Provider 的 confidence label 分布、validation failures、retry/fallback 和 cards coverage；若仍出现未知字符串，只应基于安全 diagnostics 增加确定性兼容，不应放宽 schema 或猜测值。

在下一次完整长录音验收中重新检查 Evidence First 五项、Preference identity/occurrence、importance reason 和 cross-upload merge。若要覆盖更广的偏好同义表达，应优先让既有 extractor 输出可靠的内部 category/value，而不是继续增加领域关键词或 semantic similarity 合并。

# 2026-07-17 - Evaluation-only Provider Raw Response Capture

## Background

60 分钟真实 Pipeline 已能通过脱敏 diagnostics 确认 Relationship chunks 6/7/8 在 JSON parse success 后发生 15 个 `items[*].confidence invalid_type`，但历史 retained artifacts 没有保存失败响应的原始字段值，因此无法判断模型实际输出的是 `high/medium/low`、`null` 还是其他字符串。现有行为是有意的隐私保护：AnalysisChunk checkpoint 只保存 issue code/count 等安全摘要，但这一边界也限制了受控 Evaluation 对真实 schema drift 的取证能力。

本次新增一个默认关闭的 Evaluation-only Provider Raw Response Capture。它只提供诊断旁路，不修改 Provider prompt、最终 Daily Brief/Relationship schema、normalization、validation、retry/fallback、reducer、Memory、QA 或前端逻辑，也不改变 AnalysisChunk processor fingerprint。

## Design

Capture 采用三重门禁：`EVALUATION_MODE=true`、`DEBUG_SAVE_PROVIDER_RESPONSE=true`，并且当前 upload 必须已经显式标记 `evaluationRetention=true`。第三个条件比单纯双环境变量更严格，因为同一 Evaluation-mode 进程仍可能处理未标记的普通用户 upload；未标记 upload 不得因全局 debug 开关而保存原始内容。任一条件不满足时，在任何 `mkdir` 或文件读取之前直接 no-op。

Raw artifact 固定写入当前进程工作区的 `.data/evaluation/provider-raw-responses/`，不读取 `APP_DATA_DIR`，不使用 JsonStore、user collections、AnalysisChunk store 或 production shared data root。upload/provider 目录名经过 safe slug + SHA-256 截断处理，所有 resolved/real paths 都必须保持在 evaluation root 内；文件采用唯一 UUID 名称、同目录临时文件和 atomic rename，目录/文件在支持的平台上请求 `0700/0600` 权限。

仅在 JSON 已成功 parse、conservative normalization 已执行、strict Zod validation 仍失败时保存 exact raw response。JSON parse failure、正常 validation success、evidence validation failure、timeout 或 Provider transport failure均不捕获。Capture 写盘错误被固定脱敏日志吞掉，原始 ZodError 继续按原有 retry/fallback 契约传播。

## Architecture Change

Before:

```text
Provider raw response
-> JSON parse
-> normalization
-> Zod failure
-> safe issue diagnostics
-> rule fallback/checkpoint
-> raw response discarded
```

After:

```text
Provider raw response
-> JSON parse
-> normalization
-> strict Zod failure
-> if evaluation mode + debug flag + retained upload:
     isolated atomic raw artifact
     hash-only capture report
-> unchanged safe diagnostics
-> unchanged retry/fallback/checkpoint
```

Pipeline ready 时会扫描该 upload 已发布的 capture files，将 `fileCount`、每文件相对路径/bytes/SHA-256 和稳定的 `aggregateSha256` 复制到 Evaluation audit report；report 不含 raw response、model output、validation invalid value 或绝对路径。每次 capture 后也会在独立 upload capture 目录原子重建 `report.json`，因此 Worker 在 Pipeline ready 前退出时仍有可恢复的文件清单。

## Technical Implementation

新增 `src/lib/server/evaluation/provider-response-capture.ts` 与对应测试。artifact 包含 version、provider、uploadId、zero-based chunk index 及明确的 `chunkIndexBase=0`、attempt、model、schema name、timestamp、exact `rawResponse`、raw SHA-256、最多 10 条安全 validation issues、code/count summary 和 truncated 标记。report 只包含文件数量与 hash inventory。Relationship first-pass concurrency=2 可能并发失败，因此 writer 对每个 upload 串行化“发布 artifact -> 重扫目录 -> 原子更新 report”，避免 read-modify-write 丢文件。

`src/lib/server/openai/structured-json.ts` 新增独立的 validation-failure raw hook。Raw response 不加入 `StructuredJsonDiagnostics`，所以不会被 attempt record 或 checkpoint metadata 意外序列化。Relationship 与 Daily Brief OpenAI-compatible JSON providers 在 Pipeline 传入 retained-upload capture context 时接入该 hook；正常 Provider 输入、输出及 fallback 逻辑保持不变。

`src/lib/server/pipeline/process-upload.ts` 只对 `isEvaluationRetentionUpload(upload)` 为真的 upload 启用 capture context，并在 ready Evaluation report 前收集 hash inventory。`src/lib/server/evaluation/audit-report.ts` 新增 `artifacts.providerRawResponses`，默认值为 `enabled=false/fileCount=0`。显式确认的 upload DELETE 会同时清理独立 raw capture 目录；未确认的 Evaluation DELETE 仍在任何删除前返回原有 409。

`.env.example` 新增 `DEBUG_SAVE_PROVIDER_RESPONSE=false`，明确原始响应可能包含敏感用户文本。根 `.gitignore` 已忽略整个 `.data`，不需要新增 ignore 规则。

## Decision & Trade-offs

没有把 raw response 加入 checkpoint 或 JsonStore。这样可以保持 checkpoint 可复用、脱敏、低体积，并避免 Evaluation debug artifact 混入 production data lifecycle。Capture root 也刻意不跟随生产 `APP_DATA_DIR=/opt/.../shared/.data`；服务器若使用该能力，raw 文件位于对应 release/process cwd 下的 `.data/evaluation`，需要按 Evaluation artifact 管理，而不是当作用户产品数据。

保存的是 normalize 前的 exact provider response，因此可以分析真实类型漂移；validation issues 仍使用安全 path/code/fixed message，不额外序列化 Zod invalid value。Raw artifact 本身高度敏感，只能在受控 Evaluation 中短期启用。Capture hook 被 await 以确保 terminal report 不漏文件；这只在 schema failure 且三个门禁全部开启时增加一次小文件写入，不影响默认生产路径。

当前 exact raw capture 只覆盖 shared structured-json 的 JSON response mode。Relationship 固定使用 JSON mode，Daily Brief 当前推荐配置也是 JSON mode；SDK structured mode 若在 SDK 内部 validation 前直接抛错，可能无法取得 exact response，不会伪造或用 serialized parsed object 冒充 raw。

## Validation

先增加失败测试，确认原代码没有 raw hook/capture module。实现后，Evaluation capture、hash report、structured JSON、Relationship provider/chunks、Daily Brief provider/chunks、Pipeline retention 的聚焦回归为 `8 files / 142 tests` 全部通过；confirmed Evaluation DELETE 的定向 route 测试为 `1 passed / 57 skipped`。

测试覆盖双开关 truth table、非 `true` 值 fail closed、未标记 upload 禁止捕获、exact raw 保存、chunk/model/timestamp/issues、path traversal containment、12 个并发 capture 不覆盖、无临时半文件、每文件 SHA-256 和 aggregate hash、report 不含 raw/绝对路径、capture write failure 不替换 ZodError、success/parse failure 不捕获、checkpoint 不含 raw sentinel、默认 Pipeline report disabled，以及 confirmed delete 清理。

`npm run lint` 通过，包括 Next route type generation 与 `tsc --noEmit --incremental false`。完整 `npm test` 收集 116 files / 898 tests，其中 113 files / 892 tests 通过；剩余 6 个失败仍是既有 Windows/POSIX path assertions，另有 1 个 Playwright spec 被 Vitest 收集的问题，本次未修改这些无关基线。`git check-ignore -v .data/evaluation/provider-raw-responses/example.json` 命中根 `.gitignore` 的 `.data` 规则。

没有开启两个 debug 环境变量、没有生成工作区真实 raw artifact、没有调用远端 Provider、没有重跑长录音 Pipeline，也没有 deploy、commit 或 push。

## Limitations

Raw capture 会保存模型返回中的用户内容，不能作为常开日志；即使 Evaluation mode 已启用，也必须在需要取证的单次受控运行前显式打开 `DEBUG_SAVE_PROVIDER_RESPONSE=true`，完成审计后关闭。Hash report 证明文件集合和内容完整性，但不提供加密、访问控制服务或自动 TTL；文件系统权限和宿主机访问策略仍由运行环境负责。

当前 capture report 使用进程 cwd 下的 `.data/evaluation`，不会进入 production APP_DATA_DIR。若部署采用不可写 release 目录，debug capture 会失败并保留原 Provider validation 行为，需在未来单独设计明确的、仍与 production data 隔离的 Evaluation artifact mount；本次没有增加任意路径环境变量，以避免把 raw 定向到不受控位置。

完整 Vitest 仍存在既有跨平台 path 与 Playwright collection 基线失败。Capture 没有对旧 retained response 追溯能力；只有开启后发生的新 validation failure 才会产生 raw artifact。

## Next Steps

下一次需要分析真实 schema drift 时，在隔离账号、Evaluation-retained upload、独立本地/服务器 Evaluation 环境中同时设置 `EVALUATION_MODE=true` 与 `DEBUG_SAVE_PROVIDER_RESPONSE=true`，只运行一次受控 Pipeline 或 stage replay。完成后先核对 capture `report.json` 与 Evaluation audit report 的 file count/hash，再离线查看对应 raw artifact；不要把 raw 文件附加到公开 issue、Git、普通日志或长期产品备份。

确认真实 confidence 值分布后，只针对重复出现且语义确定的格式漂移增加 closed-set normalization。若不再需要取证，应关闭 debug flag；显式 confirmed DELETE 会清理该 upload 的 raw capture，其他 retained artifact 仍按现有 Evaluation lifecycle 管理。

# 2026-07-17 - Local Audio Tunnel Worker Supervisor

## Background

本地 Queue 模式只启动 `npm run dev -- -p 3200`、Redis 和普通 `npm run worker` 时，远端 speaker-ASR 仍需要一个能够回源到本地 `/api/internal/audio/...` 的公网 HTTPS 地址。此前 `.env.local` 保存了一次性的 `trycloudflare.com` Quick Tunnel URL；该 Tunnel 停止后域名失效，但已运行 Worker 继续持有旧环境变量，导致两个 ASR chunks 都返回 `speaker_asr_query_failed / 下载文件失败`。每个 chunk 的一次内部 retry 与 BullMQ 的三次 whole-job attempt 都无法修复确定性的失效地址。

目标是提供仅用于本地开发的自动配置与生命周期管理，不修改 ASR、Queue/Worker 核心处理、retry、Pipeline 或服务器生产配置。

## Design

新增前台命令 `npm run worker:local -- --port 3200`，把 Cloudflare Quick Tunnel 和现有 Pipeline Worker 放在同一个 supervisor 生命周期内。Supervisor 先使旧地址失效，再确认本地 Web 可达，启动 `cloudflared`，同时读取 stdout/stderr 取得并校验新的 HTTPS URL，公网 preflight 成功后原子更新 Git 忽略的 `.env.development.local`，最后以子进程环境显式覆盖 `SPEAKER_ASR_AUDIO_BASE_URL` 并启动原 Worker。

生成文件只包含公网 URL 与生成注释，不复制 `SPEAKER_ASR_AUDIO_ACCESS_TOKEN`、API key、密码或其他 `.env.local` 内容。Tunnel 退出时停止 Worker；Worker 退出时停止 Tunnel；正常或异常收尾都把生成 URL 置空，以遮蔽任何旧开发地址并让后续错误 fail closed。

## Architecture Change

Before:

```text
手动 Quick Tunnel
-> 临时 URL 固化在 .env.local
-> 独立 Worker 启动时读取一次
-> Tunnel 退出但 Worker 继续消费
-> remote ASR 无法下载 chunk
```

After:

```text
npm run worker:local
-> invalidate generated local URL
-> verify localhost:3200
-> start cloudflared
-> parse + verify fresh public URL
-> atomic .env.development.local update
-> inject the same URL into existing Worker
-> tunnel/worker coupled shutdown
-> invalidate generated URL
```

## Technical Implementation

新增 `scripts/run-local-worker.ts` 与 `scripts/run-local-worker.test.ts`。脚本复用现有 Cloudflare Quick Tunnel 参数与 Windows `CLOUDFLARED_BIN > C:\\tmp\\cloudflared.exe > PATH` 解析约定，目标固定为 loopback `127.0.0.1:<port>`；支持 `quic`、`http2` 与 `auto` protocol。Tunnel 输出限制在内存最后 20 KB，错误输出经过 token/credential redaction，正常日志只显示 host，不打印内部音频 token。

配置写入使用唯一临时文件与 rename，保留 `.env.development.local` 中无关设置，并保证 `SPEAKER_ASR_AUDIO_BASE_URL` 只出现一次。启动 Worker 时直接调用现有 `src/worker/pipeline-worker.ts`，没有复制 `processUpload()` 或 Queue 消费逻辑。`package.json` 新增 `worker:local`；`.env.example` 与 `docs/validation-tools.md` 记录本地使用方式和 Quick Tunnel 非永久地址限制。

本地忽略文件 `.env.local` 中的过期 Quick Tunnel URL 已移除，动态值改由 `.env.development.local` 管理。该文件命中根 `.gitignore` 的 `.env.*` 规则；PM2/production 的 `NODE_ENV=production` 不加载它。`src/lib/server/env/runtime-env.test.ts` 增加开发文件优先级与 production isolation 回归。

## Decision & Trade-offs

没有把临时 URL 加入生产 `.env.example` 默认值，也没有修改服务器 `APP_DATA_DIR`、PM2 或 Redis。单独生成静态配置不能解决 Worker 已启动后 URL 变化的问题，因此 supervisor 直接注入新 URL并绑定 Tunnel/Worker 生命周期；`.env.development.local` 主要提供标准 Next/Node 本地环境兼容、可见状态与 fail-closed 遮蔽。

Quick Tunnel 仍不保证固定域名或长期 uptime。需要永久地址时仍应使用 Cloudflare named tunnel、固定 ngrok domain 或 FRP，而不是让本地脚本保存一次性地址。Windows 上仅在子进程未在 5 秒内退出时使用 `taskkill /T /F` 作为本地清理兜底；正常路径优先发送终止信号。

## Validation

`npx vitest run scripts/run-local-worker.test.ts src/lib/server/env/runtime-env.test.ts` 通过：2 files / 8 tests。覆盖参数校验、Quick Tunnel URL 提取、单键更新、旧 URL 移除、空值失效、临时文件清理、显式 cloudflared binary 与 loopback target、开发文件遮蔽旧 `.env.local`，以及 production 不加载开发文件。

`npm run worker:local -- --help` 正常输出使用说明。使用未监听的本地端口执行 fail-closed smoke，脚本在启动公网 Tunnel 前失败，输出 `config_invalidated`，并确认生成文件保持空 URL。`npm run lint` 通过；`git diff --check` 通过，仅有工作区既有 LF/CRLF warning。`git check-ignore -v .env.development.local .env.local` 均命中 `.env.*`。

本次没有启动真实公网 Tunnel、没有重新上传音频、没有调用远端 ASR/LLM、没有运行完整 Pipeline，也没有 commit、push 或 deploy。

## Limitations

Supervisor 只管理由自身启动的 Tunnel 与 Worker，无法自动识别用户在其他终端手动启动的普通 Worker；本地使用前必须避免同时运行 `npm run worker` 和 `npm run worker:local`。若操作系统强制终止整个 supervisor，清理回调可能来不及写空配置，但下一次启动会在任何网络操作前先失效旧值。

当前只完成离线与 fail-closed 本地验证，尚未实际打开 Quick Tunnel 验证完整的 `公网 URL -> internal audio route -> remote speaker-ASR` 链路。Quick Tunnel 自身的 DNS、Cloudflare 网络与远端回源可用性仍属于外部依赖。

## Next Steps

本地 Queue 上传时按顺序运行 Redis、`npm run dev -- -p 3200`、`npm run worker:local -- --port 3200`，确认 supervisor 输出 `tunnel_ready` 与 Worker `ready` 后再上传。下一次短音频验证只需确认 ASR 能下载 chunk，不应调整 retry、timeout 或 Queue attempts。

若日常开发需要无人值守或固定公网地址，配置 named tunnel/ngrok/FRP 并把稳定 URL 作为显式本地或部署环境变量；不要把 Quick Tunnel URL重新写回 `.env.local`。

# 2026-07-17 - Local Audio Tunnel Supervisor Post-review Hardening

## Background

对最初的本地 Tunnel supervisor 实现进行并发与故障审查后，发现把动态 URL 写入标准 `.env.development.local` 会产生两个风险：强制终止后残留地址会被普通 Worker 自动加载；正常退出留下的空值又会遮蔽未来用户配置的有效 named tunnel。最初以子进程启动 Worker 的方案在 Windows 上也不能可靠地把 `SIGTERM` 转换成 BullMQ Worker 的优雅 `close()`。

本次在交付前继续硬化这些边界，保留原目标与命令，不修改 Pipeline、ASR、Queue retry 或服务器部署行为。

## Design

最终方案改用 supervisor 专属 `.env.audio-tunnel.local`。该文件仍命中 `.env.*` ignore，但不属于 Next/Worker 自动 env 加载序列；即使进程崩溃后文件残留，普通 `npm run worker` 也不会读取它。Supervisor 每次启动在任何网络调用前删除旧文件，Fresh Tunnel ready 后才原子创建，正常关闭时删除。

Worker 不再作为难以在 Windows 上优雅发送信号的 Node 子进程。Supervisor 在同一进程中直接调用现有 `startPipelineWorker()`，并在 signal、Tunnel exit 或 runtime error 时 `await runtime.close()`；这仍完全复用已有 Worker recovery、消费和 shutdown 实现。Cloudflared 保持为独立子进程。

## Architecture Change

Before review hardening:

```text
.env.development.local auto-loaded by ordinary Worker
supervisor -> Node Worker child process
SIGTERM/tree-kill ambiguity on Windows
```

After review hardening:

```text
exclusive local supervisor lock
-> delete stale dedicated file
-> load normal local env, explicitly discard inherited stale audio URL
-> cancellable web/tunnel readiness
-> atomic .env.audio-tunnel.local
-> startPipelineWorker() in supervisor process
-> runtime.close() before tunnel cleanup
-> remove dedicated file + release lock
```

## Technical Implementation

`scripts/run-local-worker.ts` 新增 `.data/local-worker/worker-local.lock` 的 exclusive create、owner PID 与 stale-lock recovery，防止两个 supervisor 同时覆盖 URL 或并发消费 Queue。SIGINT/SIGTERM 通过 `AbortController` 中断 localhost preflight、Tunnel URL wait 与公网 preflight，不再在用户已要求停止后继续启动 Worker。

脚本在失效旧状态后调用现有 `loadRuntimeEnv()`，因此 `.env.local` 中的 `CLOUDFLARED_BIN` 和 Queue/Provider 配置仍可用；随后显式删除任何 shell/文件继承的旧 `SPEAKER_ASR_AUDIO_BASE_URL`，只接受本次 Tunnel 返回并通过 HTTPS host 校验的新值。启动错误日志增加经过 credential redaction 的有限 message，便于区分 3200 未启动、cloudflared 缺失和 readiness timeout。

本地 `.env.local` 只移除了已失效的 Quick Tunnel URL，token 与其他秘密未移动、未输出。文档增加安全警告：Quick Tunnel 当前转发整个本地 Next.js 端口，而不只是 internal audio route，只应在可信开发机上短时运行。

## Decision & Trade-offs

专属文件不再提供“普通 Worker 自动读取”的便利，换取 hard-crash 后不会静默复用 stale URL。日常本地 Queue ASR 必须使用 `worker:local`；稳定 named tunnel/FRP 场景仍可通过普通显式环境配置与 `npm run worker` 运行。

单实例锁使用 PID 存活检查并在 owner 不存在时回收。极少数 PID 被操作系统快速复用时会保守拒绝启动，需要用户确认不存在 supervisor 后删除 stale lock；这比并发启动两个 Worker 更安全。Cloudflared 在 5 秒内未退出时仍有 Windows `taskkill /T /F` 兜底，但 Pipeline Worker 本身始终优先使用 runtime `close()`。

## Validation

最终聚焦测试为 `2 files / 7 tests` 通过，覆盖 dedicated env、URL allowlist、atomic write、无 credential key、loopback target、显式 cloudflared binary、并发 supervisor 拒绝与 stale lock recovery，以及既有 runtime env 行为。`npm run lint` 再次通过。

`npm run worker:local -- --port 65500` fail-closed smoke 在 localhost 不可达时返回 exit 1，并明确记录 timeout；随后确认 `.env.audio-tunnel.local` 与 lock file 均不存在。`npm run worker:local -- --help` 通过。没有启动真实公网 Tunnel，也没有重新运行远端 Pipeline。

## Limitations

当前没有自动检测同一项目中由用户手动启动、但不受 supervisor lock 管理的普通 `npm run worker`；文档明确禁止两者并行。完整 Tunnel/Worker lifecycle 尚未以真实 Cloudflare 网络执行，本次只验证了纯函数、锁、类型检查、帮助命令和无公网的 fail-closed 路径。

Quick Tunnel 会公开整个 localhost Web 端口，且域名不保证稳定。若需要更窄的暴露面，需要未来增加只代理 internal audio route 的本地反向代理；若需要固定域名，应改用 named tunnel、固定 ngrok 或 FRP。

## Next Steps

用户确认可以短时公开本地开发端口后，运行一次 `npm run worker:local -- --port 3200`，观察 `web_ready -> tunnel_ready -> pipeline-worker ready`，再用短音频验证远端 ASR 回源。验证失败时只记录 Tunnel/ASR错误，不应通过增加 chunk retry 或 Queue attempts 掩盖公网地址问题。

如要进一步消除误并行普通 Worker，可在未来增加本地开发专用的 Queue worker ownership check；该能力不应进入服务器生产 Worker 的默认启动路径。

# 2026-07-17 - Local Worker Shared Lease and Graceful Drain Correction

## Background

交付前的最终 shutdown 审计发现，若 supervisor 先关闭公网 Tunnel、再等待 BullMQ 当前任务完成，正在执行的 speaker-ASR 会立刻失去音频下载地址。这会把一次正常的本地关停变成确定性的 chunk failure，并消耗已有 retry。另需确保普通本地 `npm run worker` 与 `worker:local` 不会同时消费同一 Queue。

## Design

本地 Worker 入口与 Tunnel supervisor 共用一个 development-only lease。关停顺序改为：停止接收新任务、保留本次新鲜 Tunnel 和进程内 URL、等待当前任务 drain、再关闭 Tunnel、删除专用配置并释放 lease。第二次 `Ctrl+C` 保留操作系统的强制退出语义，异常中断的任务继续由现有 BullMQ stalled-job recovery 处理。

## Architecture Change

Before:

```text
shutdown signal
-> close Tunnel + remove URL
-> wait for active Worker job
-> active ASR download can fail
```

After:

```text
shared local Worker lease
-> shutdown signal stops new jobs
-> keep Tunnel available while active job drains
-> close Tunnel
-> remove .env.audio-tunnel.local
-> release lease
```

## Technical Implementation

`src/lib/server/queue/local-worker-lease.ts` 提供普通本地 Worker 与 supervisor 共用的 exclusive lease、owner token/PID/role 记录和原子 stale-owner recovery；`NODE_ENV=production` 默认不启用，因此 PM2 生产 Worker 行为不变。`src/worker/pipeline-worker.ts` 在本地入口生命周期内持有并最终释放 lease。`scripts/run-local-worker.ts` 显式启用 supervisor lease，并调整 finally 顺序，使 `workerRuntime.close()` 在 Tunnel 和 ASR URL 仍可用时完成。

`docs/validation-tools.md` 已同步准确描述首次与第二次 `Ctrl+C` 的行为。硬退出可能来不及执行清理，但普通 Worker 永远不会自动加载 `.env.audio-tunnel.local`，下一次 supervisor 启动也会在网络调用前删除残留文件并恢复无存活 owner 的 stale lease。

## Decision & Trade-offs

没有给 BullMQ runtime 增加新的 force-close API，也没有修改 Queue retry 或 stalled policy。保留 Tunnel 直到当前任务完成会使关停期间公网暴露窗口延续到 drain 结束，但这是保证活跃 ASR 能完成的必要条件；需要立即停止时可再次 `Ctrl+C`，代价是当前任务可能由既有恢复机制接管。

## Validation

聚焦测试、lint、help/fail-closed smoke 与 diff 检查在最终代码上重新执行；真实结果记录在本条任务交付报告中。本次没有启动真实公网 Tunnel、没有调用远端 ASR/LLM，也没有重新上传失败音频。

## Limitations

Cloudflare Quick Tunnel 仍是临时域名，不能替代 named tunnel、固定 ngrok domain 或 FRP。第二次强制退出无法承诺应用层 finally 一定执行；其安全边界依赖专用文件不被普通进程读取、启动时 stale cleanup 和 BullMQ 既有恢复策略。

## Next Steps

本地使用时依次启动 Redis、Next.js 和 `npm run worker:local -- --port 3200`，等待 `web_ready`、`tunnel_ready` 与 Worker `ready` 后再上传。若需要固定且长期的公网音频地址，应另行配置受控的 named tunnel 或 FRP，而不是持久化 Quick Tunnel URL。

# 2026-07-17 - Relationship Lifecycle Resolver

## Background

60 分钟真实 Pipeline 能分别提取陶艺计划、查询承诺、预约完成和沟通规则，但 Relationship Signal 仍是相互独立的事件摘要，无法表达 question → answer、plan → completion、commitment → fulfillment 或 concern → resolution。目标是在不增加 LLM、embedding、不修改 Relationship Card/Memory 对外 schema，也不替换现有 reducer 的前提下增加一个确定性的生命周期层。

## Design

新增内部 lifecycle signal/edge 模型。Resolver 先从已有 Relationship candidates（无 candidate 时回退 cards）构造只在服务端使用的 signal view，再依次检查角色兼容、前后时间方向、事件时间、实体/主题、行动目标、speaker interaction context 和 temporal proximity。合法边仅使用 `answered_by`、`resolved_by`、`fulfilled_by`、`updated_by`；每条边携带原始 signal ID、置信度和双方真实 transcript segment ID。

角色和事件匹配均采用有限、可解释的规则。`报名`/`预约`仅作为同一通用行动族归一化，不包含陶艺、排练等 fixture 故事关键词；等待状态如“尚未打开/未查询”只能成为 update，不能伪装成 answer。不同显式日期、不同 action goal、无共同实体的远距离 pair 会被拒绝。低信息 fallback completion 只有在共享行动、speaker context 且 15 分钟内延续时才可匹配；超过 30 分钟则要求更强的实体和 action 双重锚点。

## Architecture Change

Before:

```text
Relationship chunks
-> candidates
-> existing reducer
-> cards
-> Memory admission
```

After:

```text
Relationship chunks
-> candidates
-> existing reducer (unchanged)
-> cards
-> deterministic lifecycle resolver
-> relationship-lifecycle artifact + Evaluation audit
-> Memory admission consumes lifecycle metadata
```

Memory integration 不创建新 schema relation，也不删除历史 Memory。它把 lifecycle target 的真实 transcript evidence 附加到对应 Relationship Memory；`updated_by` 保持 active，任何可达的 terminal edge 将状态设为 resolved。遍历支持 `updated_by -> fulfilled_by/resolved_by/answered_by` 链，因此链首不会永久保留为重复的未完成状态。

## Technical Implementation

新增 `src/lib/server/relationship-signals/lifecycle/types.ts`、`rules.ts`、`matching.ts`、`resolver.ts` 及 `resolver.test.ts`。`src/lib/server/relationship-signals/chunk-processing.ts` 暴露 reducer 已有的 candidates 与 `candidateIdsByCardId`，没有改变候选质量门或 reducer 策略。

`src/lib/server/pipeline/process-upload.ts` 在 Relationship reducer 后运行 resolver，并写入 `relationship-lifecycle/<uploadId>.json`；Evaluation retention report 通过 `src/lib/server/evaluation/audit-report.ts` 保存结构化 lifecycle audit。上传 DELETE 路由同步删除 lifecycle artifact。`src/lib/server/memory/extractor.ts` 只消费 edge metadata，沿 edge chain 回填真实 segment evidence 和 resolved status，不修改 importance 计算。

新增 `scripts/evaluate-relationship-lifecycle.ts` 和 `npm run relationship:lifecycle:evaluate`，仅从 retained Relationship checkpoints 读取 candidates，离线生成 `.data/evaluation/long-recording-60m-v1/relationship-lifecycle-audit.json`。报告只包含 ID、relation type、confidence、结构化 reason、计数和 hash-free evidence validation，不保存 transcript/quote。

## Decision & Trade-offs

没有把 question/plan/completion 扩展进公开 RelationshipSignalType，也没有把 lifecycle relation type塞入既有 Memory relation schema，避免前端、QA 和长期 Memory API 被内部推断契约污染。Resolver 使用已有 candidate 细节优先于 reducer cards，是为了保留事件顺序；Memory 通过 reducer 的 candidate-to-card mapping 消费边，未选中 card 的 source edge不会凭空创建 Memory。

规则采取保守的一源一最佳 terminal/update 选择，并限制同 relation type 对同一 target 的竞争 source。这样会漏掉缺乏具体实体的真实关系，但优先避免把陶艺、排练和通知规则强行连在一起。Audit 保留每个 pair 的 accepted/rejected 状态与 `different_entity`、`different_goal`、`different_time_window`、`different_signal_type` 等原因，便于离线调整而无需读取对话正文。

## Validation

`npm run lint` 通过。最终聚焦回归为 `14 files / 159 tests` 通过，覆盖 lifecycle、Relationship reducer/chunk processing、Memory extractor/admission/relations/repository/dedup、Evaluation audit、Evidence retrieval、Pipeline 和 QA。上传 DELETE 的 lifecycle cleanup 聚焦测试为 `1 passed / 57 skipped`。

60 分钟 retained upload `b46541ab-c007-420c-9f6f-b5fd38d664ed` 的离线评估读取 12 个 Relationship checkpoints、45 candidates，检查 990 个有向时间 pair，生成 3 条同一陶艺生命周期边：1 `updated_by`、1 `answered_by`、1 `fulfilled_by`；`planCompleted=0`、`concernResolved=0`。139 个具有潜在 lifecycle type 但实体/目标/时间不足的 pair 被身份规则拒绝，最终人工核对未发现跨事件 accepted edge。Evidence audit 为 `invalidSourceIds=0`、`quoteMismatch=0`、`duplicateEvidence=0`、`safetyViolations=0`。没有运行完整 Pipeline、没有远端调用、没有写 Memory 或修改 retained upload。

最终 `npm test` 结果为 `115 files / 912 tests` 通过、`4 files / 7 tests` 失败，另有 1 个 Playwright spec 被 Vitest 错误收集。失败包含 6 个既有 Windows/POSIX 路径断言，以及一次可复现性不稳定的 local settings UI path 断言；同一完整套件的前一次运行该 UI 测试通过。本任务未修改这些路径/前端逻辑，相关聚焦回归全部通过。

## Limitations

当前角色/实体识别是中文确定性 lexical normalizer，不是通用语义解析；省略事件名、跨多日或只用代词指代的生命周期会保守漏连。60 分钟 retained chunks 6/7 来自 rule fallback，具体 plan/concern candidate 信息不足，因此离线数据没有可靠生成 plan completion 或 concern resolution，不能把单元 fixture 覆盖描述为真实 retained 命中。

Lifecycle resolver 当前作用于单次 upload，仍不声称跨 chunk speaker identity 已全局对齐，也不负责跨 upload 的长期生命周期归并。Evaluation audit 中的 lifecycle evidence 只保存 segment IDs；quote 仍由现有 Evidence First 路径从 transcript 确定性回填。

## Next Steps

下一次真实 retained Pipeline 可观察 provider 非 fallback 的 plan/concern candidates 是否形成预期 edge，并比较 Memory 中 active/resolved 状态。若需要跨日 lifecycle，应复用现有 Memory relation time window 与明确实体 metadata 扩展输入，而不是放宽当前同录音的文本阈值或增加 LLM 调用。

# 2026-07-17 - Speaker Identity Resolution Layer

## Background

长录音由 300 秒 AudioChunk 分别执行 speaker-ASR；服务返回的 `speaker_0/speaker_1` 只在当前 chunk 内有意义，同一人的 local label 在相邻 chunk 可能交换。原有 Transcript Merge 会保留这些 local labels，因此 Relationship、Memory 和 QA 无法可靠判断承诺、偏好或回答究竟由谁表达。本次目标是在不改变 `TranscriptSegment.speaker` 原含义、不改变 Relationship Card、Memory 或 QA 对外 schema、也不增加 LLM 调用的前提下，增加独立、确定性且可解释的 Speaker Identity 层。

同时阅读了公司 ASR / Speaker Diarization / Voiceprint 文档。`/api/ai/non-realtime-asr` 和 `/api/ai/non-realtime-speaker-diarization` 的已文档化结果只有 `speaker/text`，没有 speaker embedding、联系人 ID 或 identity confidence；`/api/ai/voiceprint/train` 支持最多两组带毫秒区间的历史/当前音频训练，`/api/ai/voiceprint/save` 支持按 `user_id/record_id/speaker_id` 保存人工确认；文档没有独立 identify endpoint，联系人识别是在后续 ASR/diarization 中隐式应用。因此本次实现 production-safe abstraction、HTTP train/save adapter 和离线 matcher，不猜测未文档化响应字段，也没有调用真实接口。

## Design

`TranscriptSegment.speaker` 永远保留 chunk-local label；可选 `identity` 保存 `globalSpeakerId/displayName/identityType/confidence/source`。Resolver 的证据优先级为 `manual_mapping > voiceprint hint > cross_chunk matcher`。跨 chunk matcher 使用可替换的 `SpeakerIdentityMatcher`，默认门槛 0.8、最佳/次佳 margin 0.08；同一 chunk 内两个 local speakers 不允许占用同一 global identity。没有证据、低于门槛、匹配歧义或发生同 chunk 冲突时，不强行归并，而是生成稳定的 upload/chunk/local hash unknown ID，并将不匹配 identity 的 confidence 固定为 0；原始匹配分只保留在结构化 comparison audit 中。

可信 identity 的展示和结构键分离：Provider/QA evidence 优先显示 `displayName`，没有显示名时使用 `globalSpeakerId`；lifecycle 等结构匹配始终使用稳定 `globalSpeakerId`，低置信时回退 local speaker，避免同名联系人被误认为同一人。Identity 子阶段采用 fail-open 错误边界：repository、matcher 或 resolver 失败时继续合并已经成功的 ASR TranscriptChunks；audit 写入失败也不丢弃已解析 identity，避免把可选增强失败误当 ASR 失败并触发整段远端重转写。

## Architecture Change

Before:

```text
AudioChunk
-> ASR + chunk-local diarization
-> TranscriptChunk(speaker_0/speaker_1)
-> Transcript Merge
-> Relationship / Memory / QA
```

After:

```text
AudioChunk
-> ASR + chunk-local diarization
-> TranscriptChunk(local speaker unchanged)
-> manual mapping / voiceprint hint / SpeakerIdentityMatcher
-> Speaker Identity Resolver + privacy-safe audit
-> Transcript Merge(identity metadata retained)
-> Relationship prompt/card evidence + lifecycle stable key
-> Memory admission / QA evidence
```

## Technical Implementation

`src/lib/domain/types.ts` 增加可选 `TranscriptSpeakerIdentitySchema`；`src/lib/domain/speaker-identity.ts` 集中提供可信门槛、展示 label、稳定 identity key 和 fingerprint。`src/lib/server/speaker-identity/` 新增 `types.ts`、`matching.ts`、`resolver.ts`、`repository.ts`、`voiceprint-client.ts`、`evaluation.ts` 及对应测试：resolver 负责候选构建、证据优先级、阈值/margin、同 chunk 冲突和 immutable enrichment；repository 使用用户作用域 JsonStore 保存 global profiles 与 upload/chunk/local manual mappings，并在读取/删除时隔离其他 upload 的损坏行；HTTP voiceprint adapter 只实现文档明确的 train/save，独立 identify 明确返回 unsupported，测试使用 in-memory provider。

`src/lib/server/transcription/chunks/process-audio.ts` 在成功 ASR chunks 与 Transcript Merge 之间加载 manual mappings、执行 resolver、写入 `speaker-identities/<uploadId>` audit；原 ASR/TranscriptChunk checkpoints 不被覆盖。`src/lib/server/relationship-signals/openai-provider.ts` 让 transcript 与基于 source segment 回填的 Audio Insight 使用一致可信 speaker label；candidate/card evidence 保留真实 segment ID，Relationship lifecycle 使用 global identity key。`src/lib/server/retrieval/ai-qa.ts` 与 `relationship-signal-evidence.ts` 在可信时显示联系人名/全局 ID，低置信继续显示 local label。Relationship processor fingerprint 已包含 identity metadata，身份变化会使对应 Relationship AnalysisChunk 正确 stale。

上传自动清理与显式 DELETE 同步删除 upload-scoped `speaker-identities` audit 和 manual mappings，但保留可跨上传复用的 global speaker profiles。持久 audit 只记录 local speaker、global ID、confidence、source、matched/reason 和结构化 comparison，不保存 displayName、transcript、quote、音频、embedding 或 raw voice data。新增 `scripts/evaluate-speaker-identity.ts` 与 `npm run speaker-identity:evaluate`，只读取显式 retained TranscriptChunks、默认离线、拒绝覆盖 report 或写回 retained runtime。

## Decision & Trade-offs

没有根据相邻 chunk 的 label 名称、说话比例或文本内容猜测身份；这些信号不足以证明同一个人，强行匹配会比保守 unknown 更危险。没有把 global identity 覆盖回 `speaker`，因为会破坏 provider 原始语义、checkpoint 可追溯性和 Evidence First；identity 是附加 metadata。没有保存 matcherFeatures 或 embedding，避免将声纹敏感数据落入普通 JSON audit。

Voiceprint 的 train/save adapter 可直接供未来人工确认流程使用，但真实识别结果仍没有 production 接线：文档没有独立 identify API，也没有说明 ASR 返回的 `speaker` 如何区分联系人 ID、显示名与 chunk-local label。当前 dependency injection 可以接收明确的 voiceprint hints 或 acoustic matcher；在服务端返回契约确定前，不将任意非 `speaker_n` 文本猜成已知联系人。

Memory schema 未增加 speaker-owner 字段。Relationship Memory 可以通过已增强的 Card/evidence speaker metadata消费 identity，QA 可在 raw/evidence context 中显示可信身份；但稳定 preference 归属等需要 Memory 自身新增明确的内部 attribution 契约后才能完全确定，本次没有越过“不修改 Memory schema”的边界。

## Validation

`npm run lint` 通过。最终聚焦回归为 `32 files / 293 tests` 全部通过，覆盖 domain schema/helper、resolver/matcher、manual repository、voiceprint adapter、identity fail-open、audit redaction、ASR chunk processing、Transcript Merge、Relationship provider/context/candidates/reducer/lifecycle、Memory、Evidence、Pipeline 和 QA。删除路由的 speaker artifact cleanup 聚焦用例通过。

最终 `npm test` 为 `120 files / 953 tests` 通过、`4 files / 8 tests` 失败，另有 1 个 Playwright spec 被 Vitest 错误收集。失败中的 6 个是既有 Windows/POSIX path/EPERM 断言；2 个 Daily Brief checkpoint 时序/fixture 用例只在全套件并行时失败，随后单独执行该文件 `13/13` 通过。本次未修改对应路径平台逻辑或 Daily Brief。`git diff --check` 通过（仅 Git 的 LF/CRLF 工作区提示）。

60 分钟 retained upload `b46541ab-c007-420c-9f6f-b5fd38d664ed` 的离线 audit 读取 12 个 TranscriptChunks、307 个 segments、24 个 chunk-local speaker groups。真实 artifacts 不含 voiceprint、embedding 或 identity confidence，因此结果保守为 `matched=0`、`unknown=24`、`conflicts=0`。内存 synthetic label-swap 将 6 个奇数 chunks 的两种 label 交换：22 个后续 groups 匹配到 2 个 seed identities，oracle 为 `24/24`、false merge 0、false split 0、conflict 0；segment ID、text、timestamp 和 local speaker 的前后 SHA-256 全部一致。Evidence/Memory/QA 聚焦回归通过，既有 retained evidence 的 `invalidSourceIds=0`、`quoteMismatch/nonVerbatimQuotes=0`、`orphanEvidence=0` 未因本次 metadata enrichment 改变；没有运行完整 Pipeline、没有调用远端 ASR/voiceprint/LLM、没有写 Memory 或修改原 upload。

## Limitations

当前真实 60 分钟数据只能证明 fail-safe unknown 与集成完整性，不能证明声学 cross-chunk matching 的准确率；synthetic matcher 仅验证 label swap、阈值、冲突和 plumbing，不是生产声纹 benchmark。没有 voiceprint/embedding/manual evidence 时，每个 chunk-local group 会保持独立 unknown，系统不会虚假声称已全局对齐。跨 chunk identity 的第一个 seed 没有外部证据，confidence 保持 0；后续高置信 acoustic match 可以引用该 global ID，但第一个 seed 的下游展示仍保留 local label。

尚无用户确认 speaker mapping 的 API/UI，也没有自动调用 voiceprint train/save。Global profile 会跨 upload 保留，upload DELETE 只删除本次映射；无法判定作用域的 corrupt mapping 会保守保留，等待独立维护工具处理。旧版本已持久化、但没有 identity metadata 的 resumable `segments` 不会自动重做声学 identity matching。Evaluation offline report 当前针对 retained local-only chunks，未来真实 hint/embedding 接入后需要扩展证据可用性探测。

## Next Steps

先与 ASR 服务方确认后续 ASR/diarization 返回的联系人稳定 ID、显示名、identity confidence 或 speaker embedding 契约；确认后实现真正的 `SpeakerIdentityMatcher`/voiceprint hint adapter，并继续沿用当前阈值、margin、同 chunk 冲突和 fail-open 边界。随后增加受用户确认控制的 manual mapping API，把 `voiceprint/save` 与 global profile 绑定，并在隔离账号上执行一次 retained 长录音验证，重点审计真实 label swap、unknown ratio、false merge、Relationship commitment owner、preference attribution 和 QA “谁说的”回答。真实准确率建立前，不应对外宣称跨 chunk speaker identity 已完成。

# 2026-07-20 - Memory Owner Attribution Layer

## Background

长录音已经能够保留 chunk-local speaker label，并通过 Speaker Identity Resolution Layer 可选附加全局身份；但 Memory 仍只保存偏好、承诺、事件和关系观察本身，缺少“属于谁、由谁承诺、谁参与”的内部归属信息。同一对话中两个人对相同主题表达相反偏好时，旧 dedup 可能把它们视为同一用户空间内的同一偏好；长期 QA 也无法区分可靠归属与尚未确认的说话人。本次目标是在不修改公开 Memory、Evidence、Relation、Relationship Card 或 QA schema、不增加 LLM 调用的前提下，增加保守、Evidence First 的 owner attribution。

## Design

新增内部 `MemoryOwnerAttribution`、ownership scope 与 participant metadata。归属只沿 `Memory transcript evidence -> TranscriptSegment.identity -> owner/participant` 产生，可信 identity 阈值为 `0.8`；不根据 `speaker_0/speaker_1`、说话顺序、性别、语气或摘要文本猜测身份。第一人称明确陈述可以把“当前可信 speaker identity”标记为 `explicit_statement`，但最终 confidence 仍受 identity confidence 约束，不虚增到 1.0。第三人称或第二人称陈述在没有目标身份证据时保持 unknown；共享表述只形成 shared scope，不强行指定个人 owner。

Preference 使用 individual owner；commitment 保存 actor，并且仅在同一 evidence context 中存在唯一可信被指向身份时保存 receiver；event 保存 participants 而不强制 owner；relationship memory 使用 shared scope 和 participants。Preference admission 对 pipeline 提供的 attribution 要求可靠 known owner，unknown preference 保留 daily-only。为兼容没有 attribution 参数的既有直接调用，legacy admission 行为不被静默改变。

## Architecture Change

Before:

```text
Memory candidate
-> admission
-> dedup by user + preference identity
-> memory_items / evidence / relations
-> QA
```

After:

```text
Memory candidate + transcript evidence
-> Memory Owner Attribution Resolver
-> conservative owner / actor / receiver / participants metadata
-> admission
-> owner-aware dedup and merge guard
-> unchanged memory_items / evidence / relations
   + internal memory_owner_observations sidecar
-> scoped retrieval metadata
-> unchanged public QA response
```

## Technical Implementation

新增 `src/lib/server/memory/owner-attribution/types.ts`、`resolver.ts`、`storage.ts`、`index.ts` 及测试。`src/lib/server/memory/schema.ts` 将内部 SQLite schema 升级到 v3，并增加带外表 `memory_owner_observations`；`memory_items`、evidence 和 relation 表结构保持不变。`src/lib/server/memory/repository.ts` 在同一事务内写入、按 upload 删除、在 Memory merge 时 rekey 并聚合 owner observations；只有已经通过 Evidence First 且实际持久化的 transcript segment IDs 才能进入 sidecar。

`src/lib/server/memory/extractor.ts` 在 admission 前解析 owner，并让 preference stable ID、候选去重和分组包含 owner identity。Repository merge guard 要求 preference/commitment 的已解析 owner 相容，event/relationship 的 participant set 与 scope 相容；未解析 owner 使用每条 Memory 的隔离键，避免未知的两个人被误合并。`src/lib/server/memory/admission.ts` 只将 owner 可靠的稳定 preference 作为长期 Memory，importance 计算没有修改。

`src/lib/server/pipeline/process-upload.ts` 传递 attribution、记录脱敏统计并将持久化 Memory 的结构化 audit 写入 `memory-owner-audits/<uploadId>.json`；upload DELETE 和 fixture reset 同步清理该 upload 的 audit。`src/lib/server/retrieval/memory-index-evidence.ts` 与 `ai-qa.ts` 只在服务端内部 QA context 中提供 known/shared owner metadata，日期范围检索会同步裁剪范围外 participants/evidence；公开 QA response schema 和 citation 仍然只引用原 transcript evidence。

新增 `scripts/evaluate-memory-owner-attribution.ts` 与 `npm run memory:owner:evaluate`。脚本默认离线、禁止网络、使用内存 SQLite、只读 retained runtime、不修改原 upload/Memory，并只输出 owner 类型、匿名 identity ID、confidence、participant/evidence IDs 与统计，不保存 transcript 或 quote。多日 fixture manifest 增加测试专用 `manualSpeakerIdentities`，fixture builder 将其作为明确的 manual mapping 附加到 segment；day 01/day 05 的咖啡偏好证据改为明确第一人称表达，未修改 expected results。

## Decision & Trade-offs

Owner metadata 使用独立 sidecar，而不是扩展公开 `MemoryItemSchema`，避免前端、QA response、Memory API 和现有迁移契约被内部身份推断污染。`local_speaker` 仅表示 Speaker Identity Layer 已产生稳定的 `unknown_person` global ID，不代表直接信任原始 `speaker_n` label。没有 identity 的明确“我喜欢”仍是 unknown，因为系统只能确认说话行为，不能确认这个 local label 对应哪个长期人物。

显式第一人称不会把 owner confidence 强制写成 1.0：陈述归属明确，但说话人的全局 identity 仍可能只有 0.92 置信度。此选择比覆盖上游身份置信度更保守。当前不会把“她喜欢……”中的“她”通过代词猜成 partner；未来应由人工映射或可验证的实体 identity 补全。未知 owner preference 进入 daily-only 会减少无法可靠归属的长期偏好，但避免错误回答“她喜欢什么”这一更高风险结果。

## Validation

`npm run lint` 通过。Owner、preference dedup、repository/admission、Evidence、Relationship lifecycle、QA、Pipeline 与 fixture reset 的最终聚焦回归为 `16 files / 187 tests` 通过；upload DELETE 的聚焦用例为 `1 passed / 57 skipped`。完整 `npm test` 为 `123 files / 984 tests` 通过；另有 6 个既有 Windows/POSIX path、local settings/EPERM 断言失败，以及 1 个 Playwright spec 被 Vitest 收集的问题，本次没有修改这些平台路径或前端逻辑。

60 分钟 retained upload `b46541ab-c007-420c-9f6f-b5fd38d664ed` 的离线只读评估处理 307 个 segments、69 个候选与 36 个实际持久化 Memory。原 artifacts 的 `segmentsWithIdentity=0`，因此 36 个 persisted owner 全部保持 unknown，13 个 Memory 只识别为 shared scope；没有声称真实 A/B 归属成功。内存 synthetic identity fixture 验证不同 owner 的相反 preference 分离、commitment actor=`person_partner`/receiver=`person_user`、shared event 与 relationship 各有 2 个 participants，网络调用为 0。

同一次离线评估的 Evidence First 指标为 `invalidSourceIds=0`、`nonVerbatimQuotes=0`、`duplicateEvidence=0`、`memoriesWithoutEvidence=0`、`orphanEvidence=0`。隔离多日 fixture replay 为 Must `14/14`、Should `7/7`、Must Not violations `0`，最终 15 Memory、31 evidence、12 relations，`pass=true` 且无 warnings。没有运行完整 60 分钟 Pipeline，也没有调用远端服务或修改 retained runtime。

## Limitations

真实 retained 60 分钟数据没有 voiceprint、manual mapping 或可信 cross-chunk identity，因此本次真实轨只验证了安全的 unknown fallback，不能证明真实双人 owner attribution 准确率。当前中文第一/二/三人称判断是确定性保守规则，不是通用共指消解；“她/他/对方”无法自动绑定 partner。commitment receiver 只在 evidence 中存在唯一可信另一身份且有直接第二人称指向时确定，多人场景会优先 unknown。

Owner metadata 已进入服务端 Memory retrieval prompt，但 deterministic QA fallback 尚未使用 owner filter；当前不能宣称系统已经能可靠回答“她喜欢什么”。外部 Memory/QA schema 没有暴露 owner 查询条件，也尚无用户角色 alias（user/partner）到 global identity 的确认流程。已有本地生成的 memory-multiday WAV 早于 fixture 文本更新；当前离线 replay 不读取这些 WAV，未来若做该 fixture 的远端音频验收应先重新生成音频。

## Next Steps

先完成受用户确认控制的 global identity alias/manual mapping，使 `person_*` 能可靠映射到 user、partner 或联系人；随后在隔离账号上运行带真实 identity metadata 的 retained 长录音，审计 owner known/unknown 比例、不同人物 preference 分离、commitment actor/receiver 与错误归属率。在真实身份准确率稳定后，再为 Voice QA 增加 owner-aware retrieval filter 和不确定性回答；在此之前继续保留 unknown，不根据代词或 local speaker label 给出确定人物结论。

# 2026-07-20 - Companion Response Style Refinement

## Background

AI QA 已具备本地 Evidence citation、Relationship safety、Memory retrieval 与 lifecycle context，但 system prompt 固定要求所有 `memory_answer` 使用“直接回答 / 我留意到的模式 / 可以怎么做”三段式。这会让普通事实查询和复盘问题呈现为分析报告，也会在用户没有请求建议时主动进入行动指导。前端 `.qa-answer-content` 同时使用偏灰褐的 `var(--ink-soft)`，没有满足 AI 回复正文统一纯黑的显示要求。本次只调整 QA 文案风格、最终文本格式和 assistant 正文颜色，不修改 retrieval、citation、Memory/Relationship schema 或业务 extraction。

## Design

新增 deterministic Response Style Layer，将问题保守分类为 `fact`、`relationship_understanding`、`reflection` 或 `advice`。分类结果只生成同一次 Provider 请求中的写作指令：事实查询直接回答；关系理解只描述一次具体行为并保留边界；复盘区分 evidence 与 inference；只有明确询问“怎么办/如何处理/有什么建议”时才允许给建议。没有增加第二次 LLM 调用。

Provider 返回后，统一出口的 normalizer 只删除固定报告标题，并仅把带“可以怎么做/下一步建议”明确标题的未请求建议改为“如果你愿意”等可选择表达；普通事实行即使以“你需要”开头也保持原义。它不会根据正文是否存在 `[E#]` 删除任何段落，因为 citation 也可能只存在于结构化 `citationIds`。处理前后必须保持 inline `[E#]` token 序列完全一致，否则返回原文；`citations`、`citedSegmentIds` 和 Evidence 对象不参与修改。QA 专用 guard 另外拒绝“他一定爱你”“你们关系一定很好”等绝对关系结论，命中后沿用现有 evidence-backed deterministic fallback，而不是把事实语义机械改写成“可能”。

## Architecture Change

Before:

```text
User Query
-> QA Retrieval / Evidence
-> single Provider request with fixed three-part report template
-> safety / citation validation
-> QuestionAnswer
```

After:

```text
User Query
-> unchanged QA Retrieval / Evidence
-> deterministic response-intent instruction
-> same single Provider request
-> unchanged safety / citation validation
-> Response Style Normalizer
-> unchanged QuestionAnswer schema
```

## Technical Implementation

新增 `src/lib/server/retrieval/response-style.ts` 与 `response-style.test.ts`，实现意图分类、意图级 prompt instruction、保守文本 normalizer、citation sequence invariant 和 QA 专用 absolute relationship conclusion guard。`src/lib/server/retrieval/ai-qa.ts` 删除强制三段式要求，增加“先回答问题、未请求不建议、单次行为不代表所有情况”的规则，并在现有 `complete()` 统一出口应用风格层；Provider chat/responses 请求数量保持一次。

`src/app/globals.css` 将 `.qa-answer-content` 的 `color` 从 `var(--ink-soft)` 改为 `#000000`。用户消息 `.msg.u .bub`、citation 区块、换行和 `<pre>` 渲染结构未修改。新增 `src/components/qa-message-color.test.ts` 静态验证颜色规则隔离，并增强 `src/components/qa-panel.test.tsx`，确认 assistant answer 使用专属 class，用户消息和 citation 不继承该 class。

## Decision & Trade-offs

风格优先通过 prompt 约束，post-processing 只做可证明不会改变 evidence 的结构性处理；没有删除任何段落，也不以 inline citation 是否存在判断内容价值。这样可能无法完全消除未请求建议，只能把残留建议降为可选表达，但比对全文做激进 rewrite 更能保护事实、安全边界和 out-of-band citation。绝对关系判断选择拒绝并 fallback，而不是替换副词，因为把“一定”改成“可能”仍可能保留模型没有证据支持的关系结论。

意图分类是轻量确定性规则，不参与 evidence retrieval 或事实判断。短跟进只在有限问法下参考最近一条用户消息，避免把普通“可以”误判为主动建议。前端当前只有浅色 palette，没有独立 dark theme；纯黑正文在当前浅色背景可读，但未来若增加深色主题，需要同时为 assistant answer 提供浅色背景或明确主题覆盖规则。

## Validation

先增加失败测试，确认旧 prompt、旧颜色和缺失 style module 会失败；实现后 `npm run lint` 通过。QA、retrieval、citation 与 frontend 聚焦回归为 `8 files / 109 tests` 全部通过，覆盖提醒问题降低建议侵入、复盘保留不确定性、明确建议柔化、out-of-band citation/safety boundary 不被删除、事实义务不被改成可选建议、单换行旧模板处理、关系绝对结论 fallback、inline citation 序列/metadata 保持、单次 Provider 调用以及 assistant/user/citation 颜色 class 隔离。

最终完整 `npm test` 为 `125 files / 996 tests` 通过、`3 files / 6 tests` 失败，另有 1 个 Playwright spec 被 Vitest 错误收集。6 个失败均为既有 Windows/POSIX 路径或 EPERM 断言；此前一次完整运行曾同时出现 2 个 Daily Brief checkpoint heartbeat/cached-output 时序失败，但最终完整运行中对应文件通过。本次没有修改 settings/path、Daily Brief、checkpoint 或 Playwright 配置，未把平台失败描述为通过。没有调用远端 Provider、运行真实 Pipeline、部署或修改生产数据。

## Limitations

轻量意图分类不能覆盖所有口语、反问或复杂多轮指代；模型如果不用固定标题而以更隐蔽方式给出未请求建议，normalizer 只依赖 prompt 约束，不会冒险删除可能含事实的段落。当前 QA 前端把答案整体放在一个 `<pre>` 中，没有 Markdown parser 或独立 code-block DOM，因此本次只保证文本格式结构不变，不能分别设置普通段落与代码块颜色。

Response Style Layer 不改变 deterministic fallback 的内容生成逻辑；当关系问题不被现有 retrieval/router 识别时，安全拒绝后仍可能返回“证据不足”，而不会为了风格补写新事实。没有做远端模型 A/B 或真实用户可用性测试，当前结论仅来自本地 deterministic/mock 回归。

## Next Steps

在下一次受控本地 QA 验收中收集脱敏的 intent 分布、未请求建议率、fallback 率和用户追问体验，不保存 query/answer 正文。若发现稳定漏判，应只扩展明确的意图表达规则或 prompt 示例，并继续保持 citation invariant。未来引入正式 dark theme 或 Markdown renderer 时，补充真实浏览器 computed-style 与 code-block 视觉回归；在此之前不扩大本层到 retrieval、Memory 或 Relationship extraction。

# 2026-07-20 - Volcengine Realtime Voice Adapter MVP

## Background

现有 Daily Brief 主链路已经能够从长录音生成 Transcript、Relationship、Memory，并通过 QA Retrieval 与 Response Style Layer 返回有证据的文本答案，但没有独立的语音输入/输出边界。第一阶段 Voice Interaction 只需要验证可替换 Provider Adapter、会话生命周期和 Text-to-Voice 输出，不应把豆包作为新的 LLM、把长期 Memory 写入服务端 dialog context，或修改已经稳定的离线 Pipeline。

本次先阅读并视觉核对《豆包语音端到端实时语音大模型 API 接入文档》。文档确认该接口使用 `wss://openspeech.bytedance.com/api/v3/realtime/dialogue`，鉴权位于 WebSocket 握手 Header，业务消息不是普通 JSON WebSocket，而是 4-byte header、event/session ID、payload size 与 payload 组成的二进制帧。客户端文本合成使用 `ChatTTSText(500)` 的 start/content/end 事件流；服务端音频通过 `TTSResponse(352)` 返回，`TTSEnded(359)` 表示本轮结束。服务端默认音频为 OGG/Opus；显式 TTS 配置可请求 PCM。

## Design

新增独立 `VoiceProvider` abstraction，公开 connect、start/finish session、send text/audio、transcript/audio/event callback 与 close。Volcengine Adapter 只处理 Provider 协议与短期 session，不读取或写入 Memory，也不调用现有 QA。未来 OpenAI Realtime 或 Gemini Live 可以在相同接口后实现，不需要把 Provider WebSocket 逻辑散落到 Pipeline。

Text-to-Voice Demo 直接把已经给定的文本通过 `ChatTTSText` 合成语音，不发送 `ChatTextQuery`，因此豆包没有被用作新的回答模型。Demo 显式请求 24 kHz、单声道、`pcm_s16le`，按顺序收集原始 `TTSResponse` bytes，并只添加标准 WAV header 后写入 `.data/voice-demo/output.wav`；没有做重采样、转码或播放。Adapter 仍保留 `provider_default` 输出模式和 `sendAudio`/ASR callback，为后续 Voice QA 预留边界。

## Architecture Change

Before:

```text
Transcript / Memory
-> QA Retrieval
-> Response Style
-> Text Answer
```

After (MVP, isolated demo path):

```text
Text input
-> VoiceProvider
-> Volcengine binary WebSocket
-> StartConnection / StartSession
-> ChatTTSText start + end
-> TTSResponse chunks / TTSEnded
-> FinishSession / close
-> PCM16 WAV file
```

Existing long-recording Pipeline、Memory、Relationship 与 QA 数据流没有变化。下一阶段才会把“Existing QA 的最终文本答案”接到 `sendText`，本次没有接入浏览器 microphone、VAD、wake word、玩偶硬件或声纹。

## Technical Implementation

新增 `src/lib/server/voice/types.ts`、`provider.ts`、`events.ts`、`volcengine-realtime.ts`、`session.ts` 与 `audio.ts`。`events.ts` 实现文档定义的 binary header、big-endian event/session/payload framing、JSON/raw payload、bounded gzip、16 MiB frame 上限、严格 UTF-8/JSON parsing，以及 Connection/Session/Chat/TTS/ASR/Error 事件。未知事件保留 ID 供未来兼容，损坏、截断、超长或错误类型帧 fail closed。

`volcengine-realtime.ts` 使用注入式 WebSocket factory，生产实现通过 `ws` 带四个鉴权 Header 建立连接；测试使用内存 Fake Socket，不联网。Adapter 等待 `ConnectionStarted`、`SessionStarted` 和 `SessionFinished`，并按 session ID 隔离 session-scoped 完成事件；同时处理 `ChatResponse`、`ASRResponse`、`TTSResponse`、`TTSEnded`、Connection/Session failed、DialogCommonError 与 protocol Error。Provider/consumer callback 被隔离，回调异常不会破坏协议状态机；日志和抛出的错误不包含凭据、Provider response 或文本正文。

新增 `scripts/voice-demo.ts` 与 `npm run voice:demo`。命令格式为 `npm run voice:demo -- --text "你好，介绍一下今天的情况"`，可用 `--output <path.wav>` 覆盖默认输出。CLI 使用现有 `loadRuntimeEnv()` 加载本地环境，只打印 connect latency、session ID、TTS latency、音频时长和文件大小，不打印输入文本或凭据。

`.env.example` 增加 `VOLCENGINE_APP_ID`、`VOLCENGINE_ACCESS_KEY`、`VOLCENGINE_APP_KEY`、`VOLCENGINE_RESOURCE_ID`，以及可选 model、speaker、endpoint 和 bounded timeout。缺少任何必需凭据会在创建 socket 前返回只包含变量名的明确错误。`package.json` / `package-lock.json` 将 `ws@^8.21.1` 声明为直接 runtime dependency，并增加 `@types/ws@^8.18.1`；不再依赖 jsdom/OpenAI 间接带入的可变 WebSocket 包。

新增 `events.test.ts`、`provider.test.ts`、`volcengine-realtime.test.ts`、`session.test.ts`、`audio.test.ts` 与 `scripts/voice-demo.test.ts`，覆盖环境 fail-closed、精确鉴权 Header、StartSession JSON、ChatTTSText start/end、ChatResponse/TTSResponse/Error parsing、mock session、PCM/WAV bytes 与离线 CLI 文件输出。

## Decision & Trade-offs

选择直接依赖 `ws`，而不是 Node 全局 WebSocket，因为当前稳定支持范围为 Node 22，豆包握手必须可靠传入四个自定义 Header。没有引入豆包 SDK、音频播放库或通用 CLI framework；手写协议层虽然需要维护事件表，但能按文档显式校验每个 frame，并保持 Provider 可替换性。

服务端默认 OGG/Opus 仍可通过 `provider_default` 使用，但 Demo 固定请求 PCM16 并封装 WAV，避免把裸 PCM 或 OGG bytes 错误命名为 `.wav`。这会增加文件大小，但不需要 ffmpeg 转码，也不会改变音频样本。StartSession 不传 `dialog_id` 或 `dialog_context`，因此不依赖豆包内部对话记忆；长期上下文仍由 Daily Brief 的 Memory/QA 负责。

文档给出的 App Key 虽为固定协议值，本实现仍要求从环境提供，避免把鉴权相关配置硬编码进仓库。没有执行 `npm audit fix` 或升级无关依赖；安装后 npm 仍报告 2 个 moderate advisory，本次没有擅自做破坏性依赖升级。

## Validation

`npm run lint` 通过。Voice 聚焦验证为 `6 files / 42 tests` 全部通过，覆盖 protocol、adapter、session、audio、environment 和 CLI；测试全部使用 Fake/Mock Provider，没有真实网络请求、Provider token 或真实音频上传。`git diff --check` 通过，只有工作区既有 LF/CRLF 提示。

最终完整 `npm test` 为 `131 files / 1038 tests` 通过、`3 files / 6 tests` 失败，另有 1 个 Playwright spec 被 Vitest 错误收集。6 个失败均为既有 Windows/POSIX path 或 EPERM 断言。此前一次完整并行运行另出现 2 个 Daily Brief checkpoint heartbeat/cache 时序失败，随后单文件聚焦复跑为 `1 file / 13 tests` 全部通过，并在最终完整运行中通过。本次没有修改这些路径、Daily Brief、checkpoint 或 Playwright 配置，也没有把完整套件描述为全绿。

没有调用真实 Volcengine API、运行真实 Pipeline、修改生产数据、部署、commit 或 push。本次只验证本地协议实现、状态机、二进制音频完整性与 CLI orchestration。

## Limitations

当前尚未使用真实 Volcengine 凭据验证握手、配额、真实事件附加字段、音色可用性与最终听感，因此只能确认实现与所提供 PDF 契约和离线 frames 一致，不能声称远端端到端已通过。`onTranscript` 目前以纯文本 callback 同时承接 ASR 与 Chat response；未来双向语音交互可能需要增加 role、interim/final 和 question/reply ID metadata，但本次没有扩大公开接口。

MVP 只保存音频，不播放；只对 `pcm_s16le` 做 WAV header 封装，不转换 OGG/Opus。没有 microphone streaming、20 ms packet scheduler、VAD、barge-in/ClientInterrupt、wake word、ESP32、声纹或浏览器 gateway。CLI 输入是独立文本，还没有调用现有 QA Retrieval，也没有把 Memory 塞给豆包。

## Next Steps

先在显式授权、隔离账号和非 CI 环境下运行一次短文本真实 smoke test，核对 `X-Tt-Logid`、Connection/Session 事件、PCM 参数、TTSEnded、文件时长与听感；失败时只记录脱敏 event/code，不保存完整 Provider response。真实契约确认后，将现有 QA + Response Style 产生的最终文本直接交给 `VoiceProvider.sendText`，保持 citation 与 Memory 仍由本地系统负责。

随后再增加 microphone gateway：PCM16 mono 16 kHz 输入、20 ms/640-byte packet scheduler、ASR interim/final metadata、VAD/ClientInterrupt 和扬声器播放。只有这些软件边界稳定后，才进入 wake word、玩偶硬件与可选 speaker identity/voiceprint 集成。

# 2026-07-20 - Voice QA Bridge Layer

## Background

项目已有 Volcengine Realtime Voice Adapter 和 Evidence First QA / Memory Agent，但两者仍是独立路径：Voice MVP 只能把给定文本合成为音频，实时 ASR 结果没有进入现有 QA；QA 的文本答案也不会回送 Voice Provider。本次增加最小桥接层，目标是形成“ASR final transcript → Existing QA → Voice text projection → TTS”的闭环，同时保持长录音 Pipeline、Retrieval、Memory、Relationship 和公开 schema 不变。

## Design

新增独立 `voice-qa` 模块，把 Provider event stream、QA 入口和会话状态组合在一起。桥接层只接受当前 session 的 `ASRResponse`，缓存 partial/未知 finality 文本，并只在明确 final 或 `ASREnded` 时触发一次 QA；Provider 的 `ChatResponse` 不进入 QA，避免把豆包对话模型当作新的回答模型。QA 仍通过现有 `answerQuestionWithAI()` 或 `answerMemoryScopeQuestion()` 完成 current/week/all 检索、Evidence citation、安全校验和 Response Style。

VOICE mode 在同一次现有 QA 请求中加入简短口语约束，完整 `QuestionAnswer` 和 citations 保留在内部响应；送给 TTS 的 deterministic projection 只移除 `[E#]` 与 Markdown 展示标记，不改事实或 evidence。TTS 失败时返回文本，QA 失败时使用固定的非事实性提示，session 不因单轮失败而崩溃。

## Architecture Change

Before:

```text
Realtime Voice Adapter -> standalone text-to-voice demo
Existing QA / Memory -> text answer
```

After:

```text
Volcengine ASRResponse(final)
-> Voice QA Bridge
-> Existing QA Retrieval / Memory / Response Style
-> citation-preserving QuestionAnswer
-> citation-free spoken projection
-> VoiceProvider.sendText()
-> TTSResponse / TTSEnded
-> audio bytes + text fallback
```

现有文本 QA 路径没有变化，也没有增加新的 LLM 调用。

## Technical Implementation

新增 `src/lib/server/voice-qa/types.ts`、`session.ts`、`adapter.ts`、`bridge.ts` 与 `index.ts`。`VoiceQaSession` 实现 `idle → listening → thinking → speaking → idle` 的受控状态转换和 terminal `closed` 状态。`VoiceQaBridge` 使用精确 session ID 过滤 ASR/TTS 事件，忽略 partial 重复触发，按 turn 串行执行 QA，在发送文本前注册 TTS waiter，并在 `close()` 时停止接收新 turn、取消仍在等待的活动 TTS、排空已进入队列的工作后再关闭 Provider。

`adapter.ts` 负责 ASR result finality 解析、查询空白规范化、VOICE/TEXT 投影，以及对现有 current/week/all QA 入口的薄适配。它读取既有 upload artifacts、speaker aliases 和 Memory scope，不复制检索或回答生成逻辑。VOICE mode 的完整答案保留 citations，仅语音文本不朗读 citation。

新增 `scripts/voice-qa-demo.ts` 和 `npm run voice-qa:demo`。CLI 使用文本模拟 final ASR，不要求麦克风；它调用真实现有 QA 和 Voice Provider，并把 PCM TTS 输出封装为 `.data/voice-qa-demo/response.wav`，同时写入不含 query、answer、evidence quote、token 或音频正文的 `session.json`；session metadata 只保留字符数、answer ID、citation segment IDs/count、错误码和音频统计。新增 session、adapter、bridge 和 CLI 的 mock/offline 测试；更新 `docs/architecture/SYSTEM_ARCHITECTURE.md`，明确当前闭环与真实麦克风阶段的边界。

## Decision & Trade-offs

没有修改 `VoiceProvider.onTranscript` 的公开签名，因为该 callback 会混合 ASR 和 Chat 文本并丢失 interim/final 信息；桥接层改为消费结构化 `onEvent`，从 `ASRResponse.results[].is_interim` 和 `ASREnded` 确定 turn 边界。该选择保留 Provider abstraction，但当前依赖 Volcengine event metadata；未来其他 Provider 需要在 adapter 层映射为相同语义。

没有为 VOICE mode发起第二次改写 LLM 请求。口语长度由现有 QA 请求的额外 instruction 控制，citation 去除由确定性投影完成，因此降低延迟和成本，并保留内部 Evidence First 结果；代价是极少数模型生成的长答案只能压平格式，不能在不丢事实的前提下强制摘要。

关闭和 turn 执行采用单进程串行 Promise queue，而没有引入新的队列、数据库或 session schema。当前 Volcengine endpoint 是端到端 dialogue 服务，音频输入后可能自主产生 Chat/TTS；Bridge 会忽略 Provider Chat 文本并只收集自己 speaking turn 的 TTS，但尚未用真实 microphone 流验证服务端自动回复能否被完全抑制。

## Validation

`npm run lint` 通过。Voice QA 聚焦测试为 `4 files / 30 tests` 全部通过；Voice、Voice QA、Retrieval、Citation 与相关前端联合回归为 `18 files / 181 tests` 全部通过。覆盖 final transcript 触发一次 QA、partial 不触发、同一 response 采用最新 final、VOICE 不朗读 citation但保留内部 evidence、current/week/all 复用、session 状态、ASR/QA/TTS 失败降级、错误 session 隔离、活动 TTS 关闭竞态、Mock Provider 和 CLI 文件输出。

完整 `npm test` 中 `135 files / 1068 tests` 通过，`3 files / 6 tests` 失败，另有 1 个 Playwright spec 被 Vitest 错误收集。6 个失败仍为既有 Windows/POSIX 路径断言和本地目录 `EPERM`；本次没有修改 settings/path 或 Playwright 配置，也没有把完整套件描述为全绿。未调用真实 Volcengine API、真实 QA Provider 或长录音 Pipeline，未修改生产数据、部署、commit 或 push。

## Limitations

当前 Demo 以文本模拟 final ASR；还没有浏览器或设备麦克风采集、PCM packet scheduler、真实 VAD turn boundary、扬声器播放、barge-in、流式 interruption 或网络断线恢复。尽管 Bridge 已支持结构化 ASR partial/final 事件，真实 Volcengine 双向音频闭环仍需一次受控 smoke test 才能确认事件顺序、自动 Chat/TTS 行为和音频格式。

VOICE projection 不朗读 inline `[E#]`，但为了 Evidence First，完整 citations 仍随内部 `QuestionAnswer` 保留；当前 CLI 的 `session.json` 刻意不保存 query/answer/evidence，因此不是审计报告。桥接层只解决 interface orchestration，不改变 QA retrieval 质量、Memory owner 可靠性或 speaker identity 能力。

## Next Steps

先在隔离账号和显式授权环境中，用一句短音频做受控 Realtime ASR → QA → TTS smoke test，确认 ASR finality、Provider 自主回复抑制、TTS session correlation 和音频可播放性。随后增加 microphone gateway、20 ms PCM packet scheduler、VAD 与 ClientInterrupt/barge-in，再做浏览器或 M5Stack/ESP32 传输层；wake word、设备播放和硬件接入应继续位于 Voice Interface 层，不进入 Memory Agent 核心。

# 2026-07-20 - Browser Voice QA MVP

## Background

项目已经具备 Volcengine Realtime Voice Adapter 和 Voice QA Bridge，但此前只能用 CLI 文本模拟 final ASR，网页用户无法采集麦克风、提交真实语音或播放 TTS。此次目标是在不改变长录音 Pipeline、Memory、Relationship、Evidence First 或 QA retrieval 核心的前提下，补齐 Browser push-to-talk → Realtime ASR → Existing QA → VOICE response → TTS playback 的接口层闭环。

实现前重新核对了所提供的 Volcengine Realtime API PDF。文档规定输入音频为 16 kHz、mono、PCM16LE；`audio_file` 模式会在文件音频结束后由服务端补静音，推荐按 20 ms / 640 bytes 发送。由于现有 Provider abstraction 没有暴露 `EndASR`，Browser gateway 采用文档明确支持的 `audio_file`，没有修改 Voice Provider 或伪造 push-to-talk 结束事件。

## Design

新增 turn-scoped Browser gateway，而不是让浏览器直接连接 Provider。浏览器只负责显式录音和播放，Provider 凭据、用户身份、Memory store 与 QA 调用全部保留在服务端。后端先鉴权，再把 MediaRecorder 产生的 WebM/Ogg/MP4/WAV 以纯内存方式转换为 Provider 接受的 PCM，复用 `VoiceQaBridge` 和 `createMemoryVoiceQaAnswerer()` 完成一轮问答，最后把 Provider 的 PCM TTS 封装为 WAV 返回。

该设计没有增加 LLM 调用：ASR/TTS 由现有 Volcengine session 完成，回答仍由既有 Memory-aware QA 与 Response Style 生成。VOICE projection 不把 `[E#]` citation 送入 TTS，但完整 `QuestionAnswer`、citation 和 segment ID 仍保留在服务端响应 trace 中。

## Architecture Change

Before:

```text
Text-simulated ASR
-> Voice QA Bridge
-> Existing QA
-> TTS file demo
```

After:

```text
Browser MediaRecorder (explicit push-to-talk)
-> authenticated POST /api/voice/qa
-> bounded in-memory FFmpeg conversion
-> PCM16LE 16 kHz mono, audio_file packets
-> existing Voice QA Bridge
-> existing Memory-aware QA / Response Style (VOICE)
-> PCM TTS 24 kHz mono
-> WAV response
-> Browser audio player
```

Long Recording Pipeline、ASR chunk processing、Audio Insight、Daily Brief、Relationship、Lifecycle、Memory schema、Owner Attribution、Retrieval 核心和 Evidence First 数据流均未改变。

## Technical Implementation

新增 `src/lib/server/voice/browser-audio.ts`，对浏览器音频执行 MIME allowlist、20 MiB 输入上限、75 秒 PCM 上限和 60 秒 FFmpeg deadline；转码通过 stdin/stdout 完成，不创建临时录音文件，也不保存 stderr 正文。输出会再次校验 PCM16 对齐、采样率/声道契约，并按 640 bytes、20 ms 的节奏送入 Bridge。

新增 `src/lib/server/voice-qa/browser-session.ts` 和 `src/app/api/voice/qa/route.ts`。API 使用现有认证上下文决定 `userId`，不接受客户端 owner 覆盖；严格校验 multipart `audio`、scope、uploadId/referenceDate 和大小，使用 Node runtime、`no-store`，并在 abort、timeout、Provider 错误和成功路径都启动 Bridge/WebSocket cleanup。正常完成走 graceful close；deadline 或客户端取消走 non-draining `abort()`，立即关闭本地 session、取消监听并后台启动 Provider close，不等待可能仍在运行的 QA turn。成功结果返回 transcript、VOICE text、WAV Base64 和不朗读的 citation trace；TTS 失败时保留文字答案。

审查发现 Provider 事件顺序还需要额外加固，因此同步调整现有 `VoiceQaBridge` 编排而未改 Provider 或 QA：`ASRResponse` 的 final 只缓存，并防止后续 partial 覆盖；收到 `ASREnded` 后才触发一次 QA。TTS 侧读取文档定义的扁平 `TTSSentenceStart.tts_type`，只接收 `chat_tts_text`，忽略自主 `default` 音频和结束事件；当 `question_id / reply_id` 存在时进行保守关联。该修改不改变 public schema、retrieval 或回答事实。

新增 `/voice` 页面与 `src/components/voice/` 组件。MediaRecorder 按浏览器支持情况选择 WebM/Opus、Ogg/Opus、MP4 或默认格式；用户手动开始和结束，60 秒自动停止。页面显示 `idle / listening / thinking / speaking`，播放 WAV Blob URL；自动播放被策略阻止时保留原生 controls 供手动播放。卸载时停止 media tracks、abort HTTP 请求、暂停播放器并释放 Blob URL。React StrictMode effect replay 也有专门 mounted-guard 回归，避免开发模式第二次 setup 后按钮失效。

更新 `docs/architecture/SYSTEM_ARCHITECTURE.md`，把 Browser Voice QA 明确标成 Interface 层和 MVP，不把它描述为新的 Memory/Agent brain。

## Decision & Trade-offs

第一版采用录完整文件后上传，而不是 AudioWorklet/WebSocket 双向流。它实现简单、浏览器兼容面更大，且能复用现有 HTTP authentication；代价是必须等待录音上传、完整转码、QA 和 TTS，不能边说边转写或中途打断。响应暂用 Base64 WAV，避免增加二进制流 session registry，但会增加约三分之一传输体积。

转码使用项目已有 FFmpeg runtime，而不是在浏览器实现 PCM DSP。这样能可靠处理常见 MediaRecorder 容器并保持 Provider adapter 不变；代价是部署 Web 进程必须可执行 FFmpeg。每个 HTTP 请求创建独立 Provider session，避免跨请求内存状态和凭据暴露，但没有跨 turn Realtime connection reuse。

Volcengine endpoint 本质上是端到端 dialogue 服务。Bridge 会忽略 Provider Chat 文本，并通过 `tts_type` 隔离自主 `default` 与现有 QA 发起的 `chat_tts_text`；这是按文档契约做的确定性过滤，但尚未用真实远端音频确认服务端在所有交错情况下都提供完整且严格串行的 start/audio/end 事件。因此当前实现只能称为接口层闭环完成和 mock/offline 验证通过，不能称为真实远端端到端验收通过。

## Validation

`npm run lint` 通过。Browser 页面和组件聚焦回归为 `6 files / 22 tests` 通过；Voice、Voice QA、API、Browser、Retrieval、QA 与 citation 联合回归最终为 `25 files / 243 tests` 通过。测试覆盖鉴权、输入边界、内存转码、PCM packet pacing、ASR final 等待 `ASREnded`、final 不被后续 partial 覆盖、default/chat TTS 交错过滤、Bridge 硬取消、VOICE citation 投影、按钮状态、权限拒绝、开始/停止录音、自动停止、React StrictMode、播放、autoplay blocked 和 cleanup。

使用本机 FFmpeg 对 48 kHz stereo WAV 做了纯内存 smoke conversion，得到 16 kHz mono PCM16LE：1 秒、32,000 bytes、50 个 20 ms packet。没有调用真实 Volcengine、真实 QA Provider 或长录音 Pipeline。

最终完整 `npm test` 为 `144 files / 1136 tests` 通过、`2 files / 6 tests` 失败，另有 1 个 Playwright spec 被 Vitest 错误收集。6 个失败均为既有 Windows/POSIX path 断言或本地 `open-data-folder` 的 `EPERM`。此前一次完整运行曾同时出现任务范围外的 Daily Brief checkpoint heartbeat/cached-output 时序失败和多日 fixture 30 秒超时；fixture 单文件、cached-evidence case 随后通过，最终完整运行中这些套件也通过。本任务没有修改 Daily Brief、settings/path、fixture replay 或 Playwright 配置，也没有把完整套件描述为全绿。

## Limitations

没有执行真实 Volcengine 浏览器语音 smoke test，因此尚未确认真实 ASR final event timing、`audio_file` 自动结束行为、Provider 自主 Chat/TTS 抑制和最终 WAV 听感。浏览器 MVP 依赖已登录的服务端账号及其 Memory store；浏览器 local-only cache 不会自动成为服务端 QA 数据源。

当前为一问一答、完整文件上传：没有 VAD、wake word、always listening、streaming transcript、barge-in、streaming interruption、断线续传、ESP32/M5Stack 或玩偶硬件。前端 AbortController 能终止 HTTP 等待并让 Bridge 立即脱离；现有 QA 核心没有 AbortSignal，因此已进入的 QA Provider 请求仍会在后台自然结束，不能保证硬取消。分块 multipart 请求仍由 Next.js 先解析为 FormData，再做 File 大小校验；`Content-Length` 只能作为机会性的提前拒绝，不能强制存在，真正的 pre-parse hard cap 需要反向代理 request-body limit 或 bounded streaming multipart parser。TTS Base64 响应也尚无独立大小上限，因此它不是面向不可信公网的大文件流式网关。

## Next Steps

先在隔离测试账号和显式授权下执行一次短句远端 Browser smoke test，验证真实 ASR finality、服务端 `audio_file` 结束、Provider 自主 response 是否与 QA TTS 混流，以及浏览器可播放性。通过后再考虑服务端流式上传/转码、connection reuse、VAD、ClientInterrupt/barge-in 和网络恢复；最后才进入 wake word 与 ESP32/M5Stack。所有后续能力继续保持 `Voice Layer = Interface`、`Memory Agent = Brain`。

# 2026-07-21 - Embedded Browser Voice QA Workspace

## Background

Browser Voice QA MVP 原先通过独立 `/voice` 页面提供 push-to-talk。实际问答界面在宽屏右侧已有可用空白，单独页面会割裂文字问答与语音问答的 current/week/all 上下文，也要求用户离开现有 Memory QA 工作区。本次目标是只调整 Browser Voice QA 的页面集成与响应式布局，不改变 Voice Provider、Voice QA Bridge、QA retrieval、Memory、Evidence First 或长录音 Pipeline。

## Design

新增 page-level `QaVoiceWorkspace`，让现有 `QaPanel` 与 Browser Voice QA 成为同一工作区内的兄弟节点。1800px 及以上宽屏保留原 QA 最大宽度，并在右侧增加最多 320px 的 sticky 语音卡；较窄窗口改为单列，语音卡位于文字问答上方，避免压缩问答线程和 composer。

语音组件只在 `activeView === "qa"` 时挂载。现有 ready 页面会把 Brief、Timeline、QA 三个 section 同时保留在 DOM 中并用 CSS 隐藏非当前视图，如果语音组件也永久挂载，切页后录音或请求可能在不可见区域继续。本次通过条件挂载确保切离 QA 时执行已有 recorder dispose、HTTP abort 和播放器 cleanup；scope、upload、reference date 或可用性变化也通过稳定 session key 强制清理旧 turn。

## Architecture Change

Before:

```text
Text QA workspace

separate /voice page
-> Browser recorder
-> Voice QA API / Bridge
```

After:

```text
QA workspace
├── existing text QaPanel
└── embedded Browser Voice QA sidebar
    -> Browser recorder
    -> existing Voice QA API / Bridge
    -> existing Memory-aware QA
    -> TTS playback
```

独立 `/voice` 页面和重复的页面级认证 UI 已移除；`POST /api/voice/qa`、Provider session、QA/Memory 数据流和 citation trace 保持不变。

## Technical Implementation

新增 `src/components/qa-voice-workspace.tsx` 与对应测试，统一 current、week、all 三种问答范围的布局和参数传递。current 只传真实 upload ID；week 传 `referenceDate`；all 不传 upload/date。多录音日的 `day_*` 聚合 ID 不是服务端 upload store key，因此该 current 视图明确禁用语音按钮；浏览器 local-first/BYOK 数据同样不会伪装成服务端 Voice QA 可访问的数据，而是显示不可用原因。

更新 `src/components/voice/browser-voice-qa.tsx`，把独立大页标题改为工作区侧栏的 `h2`，增加安全的 disabled reason，压缩标题、控制区、按钮和最近一轮对话布局。更新 `src/app/page.tsx` 的 current/week/all 三条 QA 渲染分支，并在 `src/app/globals.css` 增加宽屏两列、sticky sidebar、窄屏单列和有限高度对话滚动。删除 `src/app/voice/page.tsx` 与其页面测试；更新 `docs/architecture/SYSTEM_ARCHITECTURE.md`，不再把 `/voice` 描述成用户入口。

## Decision & Trade-offs

右侧语音卡继续显示自己最近一次 transcript/answer，没有把语音 turn 注入中央 `QaPanel` 的 React state。这样不需要新增受控 conversation contract，也不会改 QA 历史写入逻辑；代价是当前语音问答结果在右侧展示，中央文字线程不会即时追加同一轮 UI。

两列布局只在有足够空间时开启，优先保证原文字 QA 宽度。local-first 和聚合 current 采用显式禁用而不是静默改用 all scope，因为查询范围改变会让用户误以为回答仍只基于当前录音。独立路由直接移除，没有保留无上下文的重定向页面。

## Validation

`npm run lint` 通过，包括 Next route type regeneration 和 `tsc --noEmit`。组件与首页聚焦回归为 `3 files / 57 tests` 全部通过；Voice UI、Voice QA API/Bridge、Realtime Voice、response style、AI QA 与首页联合回归为 `20 files / 222 tests` 全部通过。新增覆盖 active QA 挂载、离开 QA 卸载、current/week/all metadata、week-only reference date、unsupported context 禁用和禁用状态不启动麦克风。

完整 `npm test` 为 `144 files / 1140 tests` 通过，`3 files / 6 tests` 失败。6 个失败仍是既有 Windows/POSIX 路径断言和本地目录 `EPERM`；另有 Playwright spec 被 Vitest 错误收集。本次没有修改 settings/path、open-data-folder 或 Vitest/Playwright 配置，也没有把完整测试描述为全绿。没有调用真实 Volcengine、QA Provider 或长录音 Pipeline。

## Limitations

本次完成的是页面集成和离线回归，没有执行已登录浏览器的真实远端麦克风 smoke test，因此真实 ASR final timing、Provider 自主 TTS 隔离和最终播放体验仍沿用 Browser Voice QA MVP 的既有限制。1800px 以下采用单列布局，不会在空间不足时强行保留右侧栏。语音 turn 与中央文字线程尚未共享前端实时 state。

## Next Steps

在本地已登录账号上执行一次短句 push-to-talk smoke test，核对宽屏右侧位置、current/week/all 范围、切页 cleanup、麦克风权限和 WAV 播放。若后续需要统一会话视觉，再为 Browser Voice QA 增加明确的 `onCompleted`/history reload contract，把成功语音 turn 安全同步到中央线程；不要通过复制 QA 请求或绕过现有 history store 实现。

# 2026-07-21 - Voice QA Latency Tracing

## Background

Browser Voice QA 已经能够完成录音、Volcengine Realtime ASR、现有 Memory-aware QA、Response Style、TTS 和浏览器播放，但此前只有 UI state 与临时的 `VoiceQaSession` history，没有贯穿浏览器和服务端的持久化时延记录。出现慢响应、ASR 无 final、QA 长尾、TTS 失败或浏览器未播放时，无法用同一个 session 还原阶段边界。本次只增加 Voice QA 可观测性，不修改长录音 Pipeline、Memory、Relationship、Retrieval 或 Provider 契约。

## Design

新增独立的逻辑 `VoiceSessionTrace` UUID，并把 Volcengine provider session ID 作为可选关联字段，避免把 Provider 生命周期误当成完整浏览器交互生命周期。Trace 记录 `session_created`、PCM 转发的 `speech_started/speech_ended`、ASR partial/final、QA start/complete、TTS start、浏览器真实 playback start 和 session complete；所有持久化时间均使用服务端时钟，浏览器只上报事件，不提交可伪造的时间戳。

延迟定义为：ASR=`asr_final_received - speech_ended`，QA=`qa_completed - qa_started`，TTS=`audio_play_started - tts_started`，total response=`audio_play_started - speech_ended`。缺失、无法解析或逆序的 pair 返回 `null`，不会填 0、取绝对值或推测。TTS 指标是从请求合成到浏览器开始播放 telemetry 到达服务端的端到端 time-to-audio，不冒充纯 Provider 合成耗时。

## Architecture Change

Before:

```text
Browser recording
-> Voice QA API / Bridge
-> ASR -> QA -> TTS
-> Browser playback

temporary state only
```

After:

```text
Browser recording
-> authenticated Voice QA API
-> VoiceSessionTrace (user JsonStore)
-> PCM stream boundaries
-> Bridge ASR / QA / TTS trace events
-> Browser onPlay / onEnded
-> authenticated trace telemetry
-> terminal VOICE_TRACE log
```

原 Voice Provider、Voice QA Bridge 状态机、QA answerer、citation、Memory 和前端播放数据流保持不变；Trace 是旁路 best-effort observability。

## Technical Implementation

新增 `src/lib/server/voice-qa/trace.ts`，定义严格 Zod model、first-write-wins 事件、状态与受控 failure code、四项 latency 计算、脱敏 `VOICE_TRACE` 日志和可注入 clock/writer 的 `VoiceSessionTracer`。Trace 不保存 transcript、回答、citation、音频、Provider raw response 或凭据。持久化失败只输出 error name 和 Trace UUID，不让可观测性中断问答。

新增 `src/lib/server/voice-qa/trace-repository.ts`，复用认证用户的 `JsonStore`，保存到 `<APP_DATA_DIR>/users/<userId>/voice-session-traces/<traceId>.json`。JsonStore 继续负责临时文件加 rename 的原子替换；Repository 使用进程级 Trace UUID 队列包住完整 read-modify-write，以覆盖认证层每个请求创建新 JsonStore wrapper 的情况。

更新 `VoiceQaBridge`：首次有效 partial、接受 final、QA 调用前后和 TTS 开始均写 trace；ASR/QA/TTS failure 只写受控结构，不写错误正文。更新 browser session runner，在 PCM 向 Provider 转发前后记录 speech 边界，并关联 Provider session。更新 `POST /api/voice/qa`，为合法请求创建 Trace、返回 `traceId`，并在文字 fallback 或请求失败时落 terminal 状态。

新增认证的 `POST /api/voice/trace`，浏览器只能补充 `audio_play_started` 与 `session_completed`；服务端接收时间作为 timestamp。更新 `BrowserVoiceQa`，把 `HTMLAudioElement.onPlay/onEnded/onError` 和页面卸载转换为串行、keepalive、失败不影响 UI 的 telemetry。新增 `docs/voice-observability.md`，记录事件口径、公式、存储、日志和排障流程。

## Decision & Trade-offs

没有新增数据库或遥测平台，因为当前 JsonStore 已提供用户隔离与原子文件替换，单次 Trace 只有少量结构字段。代价是 Trace 文件数量会持续增长，且进程内队列不能提供 PM2 cluster 或多 Web 实例的跨进程一致性。

当前 Browser MVP 是整段录音上传后再按 20ms 转发 PCM，所以 `speech_started/speech_ended` 表示服务端 Provider 音频流边界，不是麦克风声学 onset/end；这使 ASR、TTS 和 total 计算保持同一服务端时钟，但不包含录音、上传、转换和 Provider session 建立时间。真实播放只能由浏览器确认，因此正常带音频的 Trace 不会在 API 返回时提前 complete；若 telemetry 永远丢失，Trace 会保持 `in_progress`，不会伪造播放成功。

## Validation

`npm run lint` 通过，包括 Next route type generation 和 `tsc --noEmit --incremental false`。Trace model、Bridge、browser session、两个 Voice API 和 Browser component 聚焦回归为 `6 files / 66 tests` 通过；Voice、Voice QA、Browser Voice API/UI 与 Retrieval 联合回归为 `24 files / 217 tests` 全部通过。新增覆盖正常全事件 latency、缺失/逆序 timestamp、跨 JsonStore wrapper 的并发 update、结构化日志脱敏、TTS failure、partial-only 不触发 QA/TTS、播放成功、播放失败和 trace telemetry validation。

完整 `npm test` 实际结果为 `145 files / 1146 tests` 通过，`4 files / 8 tests` 失败。失败包括既有 Windows/POSIX 路径断言、本地 `open-data-folder` 的 `EPERM`、Playwright spec 被 Vitest 收集，以及完整并发运行时两个 Daily Brief checkpoint 测试的临时目录/heartbeat 时序干扰；Daily Brief 该文件随后单独运行 `1 file / 13 tests` 全部通过。本次 Voice Trace 相关测试没有失败，也没有修改上述失败模块。没有调用真实 Volcengine、真实 QA Provider 或长录音 Pipeline。

## Limitations

当前没有 Trace TTL、过期扫描、聚合 dashboard 或跨进程锁。浏览器 telemetry 是 best effort；页面或网络在收到 `traceId` 前中断时，服务端只能保留已观察到的阶段，正常音频 response 后若 playback telemetry 丢失会留下 `in_progress`。`audio_play_started` 使用 telemetry 到达服务端的时间，包含少量网络时延；当前无法拆出纯 Provider TTS generation、HTTP transfer、浏览器 decode 和 autoplay 各自耗时。

Trace 只覆盖 Browser Voice QA 单轮，不追踪长录音 Pipeline，也没有把录音文件上传和 FFmpeg conversion 纳入 total response latency。持久化失败不会阻断用户请求，因此极端磁盘错误时日志可能存在而 JSON Trace 缺失。

## Next Steps

先在隔离账号执行一次短句 Browser Voice QA smoke test，确认真实 ASR partial/final、TTS playback telemetry 和 `VOICE_TRACE` 数值口径。生产部署前增加按隐私策略配置的 TTL/prune；如果 Web 扩展为多实例，再使用共享存储上的乐观版本或跨进程锁。后续若改成真正浏览器流式音频，应新增浏览器 monotonic timing correlation，区分麦克风 speech end、上传、Provider first token/first audio 和播放起始，而不是复用当前 batch PCM 边界。

# 2026-07-21 - Voice Trace Reliability Hardening

## Background

Voice QA latency tracing 的最终只读审查发现三类会误导生产排障的问题：整轮 deadline 覆盖 ASR、QA 和 TTS，但原实现把所有 timeout 都标成 `asr_final_missing`；浏览器 telemetry 短暂失败后没有恢复机会；终态 Trace 仍可能被迟到事件改写。此次只收紧 observability 的错误分类、投递可靠性和状态机，不改变 Voice Provider、QA、Memory、Retrieval 或播放流程。

## Design

整轮 timeout 先读取当前 Trace snapshot：只有没有 `asr_final_received` 才记录 ASR final 缺失；QA 已开始但未完成时记录 `qa_timeout`；TTS 已开始时记录 `tts_timeout`。所有分类同时保留 session 级 `response_timeout`。Trace 采用 terminal-immutable 规则，进入 `completed`、`completed_with_errors`、`failed`、`aborted` 或 `incomplete` 后不再接受新事件或 failure。

浏览器继续串行发送 `audio_play_started` 和 `session_completed`，但对网络异常、408、429 与 5xx 增加最多 3 次的指数退避重试。4xx 确定性拒绝不重试，telemetry 最终失败仍不影响用户看到文字或播放音频。

## Architecture Change

Before:

```text
whole-session timeout -> always asr_final_missing
browser telemetry -> one attempt
terminal trace -> late events could still mutate persisted metrics
```

After:

```text
whole-session timeout
-> inspect observed phase
-> ASR missing | QA timeout | TTS timeout

browser telemetry
-> serialized bounded retry
-> authenticated transition validation

terminal trace
-> immutable persisted snapshot and stable VOICE_TRACE log
```

## Technical Implementation

更新 `src/lib/server/voice-qa/trace.ts`，新增 `qa_timeout` / `tts_timeout` failure code，并让 terminal model 更新成为幂等 no-op。更新 `src/app/api/voice/qa/route.ts`，按实际已观测事件分类整轮 deadline。更新 `src/app/api/voice/trace/route.ts`，拒绝 TTS 未开始时的播放事件、播放开始前的成功 completion，以及终态后的非幂等播放更新；重复 completion 返回幂等成功。

更新 `src/components/voice/browser-voice-qa.tsx`，使用稳定的默认 fetcher，并增加三次有界 telemetry retry。对应测试覆盖阶段 timeout、终态后乱序事件、提前 completion、重复 completion、默认 fetcher 稳定性和瞬时 503 后恢复。`docs/voice-observability.md` 同步记录状态机、重试和失败分类。

## Decision & Trade-offs

没有新增 stale trace 后台扫描器或数据库，因为本任务复用当前 JsonStore 和单 Web 进程部署假设。终态不可变优先保证日志与文件一致；代价是客户端在错误顺序先提交 completion 后不能再补写播放时间。浏览器 retry 有严格次数和状态码边界，不会成为无限重试，也不会阻断 Voice QA 主流程。

## Validation

`npm run lint` 通过。Voice Trace model、Bridge、browser session、两个 API route 与 Browser component 聚焦回归为 `6 files / 74 tests` 全部通过。`git diff --check` 通过。

完整 `npm test` 已实际执行但退出码为 1。本次 Voice Trace 用例没有失败；失败仍集中在 Windows/POSIX 路径断言、`open-data-folder` 的本地权限、Playwright spec 被 Vitest 收集，以及任务范围外的 Daily Brief checkpoint heartbeat / cached-output 时序用例。Daily Brief 单文件复跑为 `11/13` 通过，两个既有时序用例仍失败，因此没有把完整套件描述为全绿，也没有修改无关模块。

## Limitations

`totalResponseLatencyMs` 仍是当前 batch Voice QA 的服务端 operational tail latency，不是从浏览器真实麦克风停止到扬声器播放的完整用户感知延迟；录音、上传、转码和 Provider 建连不在该指标内。Trace 仍没有 TTL、stale-to-incomplete reconciliation 或跨进程 read-modify-write 锁；页面崩溃或持续断网时，即使三次 telemetry 重试也可能留下 `in_progress`。

## Next Steps

在隔离测试账号进行一次短句真实 Browser Voice QA smoke test，对齐 Volcengine ASR final、TTS 和浏览器 playback 的实际时间线。生产扩展到多 Web 实例前补充 Trace retention、stale reconciliation 与共享存储并发控制；升级为真正流式麦克风后，再引入浏览器 monotonic timing correlation，形成完整用户端到端指标。

# 2026-07-21 - Voice Session, Spoken Response and Recovery Hardening

## Background

Browser Voice QA 已能完成录音、Realtime ASR、Memory-aware QA 和 TTS，但每次 push-to-talk 原先仍像独立请求：上一轮短期上下文不会跨 HTTP 请求保存，较长文本回答不适合直接朗读，ASR/QA/TTS 超时或 WebSocket 中断也缺少统一恢复契约。本次在 Voice interface 层补齐短期会话、VOICE-only 响应投影、离线端到端 smoke、结构化 debug 与有界失败恢复，不修改 Memory admission、Relationship resolver 或 QA retrieval 算法。

## Design

使用现有用户级 `JsonStore` 保存有 TTL 的 `VoiceSession`，把应用逻辑会话 ID 与 Volcengine Provider session ID 分开。浏览器后续请求携带 `conversationSessionId`，服务端原子 claim 一个 `CREATED/IDLE` session 后，把受限的 `conversationContext` 注入现有 `VoiceQARequest`。同一逻辑会话不能同时执行两个 turn；busy 响应不会让浏览器丢弃仍有效的会话 ID。

新增 deterministic `VoiceResponseOptimizer`，仅在 `responseMode=VOICE` 时清理 Markdown、列表格式和口头 citation，并把朗读内容控制在最多 80 words；原始 `QuestionAnswer`、evidence 与 citations 保持不变。压缩会为后置的不确定性或安全边界句预留预算，避免长首句让回答失去“不能证明/不代表”之类限制。Follow-up question 保持显式 opt-in，不自动扩大建议侵入。

失败恢复由 `VoiceErrorHandler` 统一输出 `VOICE_ASR_TIMEOUT`、`VOICE_QA_TIMEOUT`、`VOICE_TTS_FAILED`、`VOICE_CONNECTION_LOST`。ASR 30 秒、QA 60 秒、TTS 60 秒均为有界阶段；WebSocket 每次恢复调用只重建一个 socket/session，Bridge 最多按配置做有界尝试。ASR 恢复重放当前 turn 的 PCM，TTS 恢复重发已经优化的文本；恢复失败时返回文字或安全提示，不关闭应用逻辑会话。

## Architecture Change

Before:

```text
Browser push-to-talk request
-> turn-scoped Voice Provider session
-> ASR final
-> QA
-> direct text-to-TTS
-> failure may end the turn without reusable context
```

After:

```text
Browser push-to-talk
-> persisted logical VoiceSession + atomic turn claim
-> turn-scoped/reconnectable Voice Provider session
-> ASR final
-> existing QA with bounded short-term conversation context
-> VoiceResponseOptimizer (VOICE only)
-> TTS
-> bounded error recovery / text fallback
-> append completed context and trusted retrieved Memory IDs
```

`VoiceSessionTrace` 继续旁路记录 ASR、QA、TTS 与 playback 时间，不承担会话上下文或恢复状态。

## Technical Implementation

新增 `src/lib/server/voice-qa/session-manager.ts` 及测试，定义 `CREATED -> LISTENING -> PROCESSING -> RESPONDING -> IDLE -> CLOSED` 生命周期、默认 30 分钟 TTL、受限 transcript/context/Memory ID、用户所有权、过期清理和进程内串行 read-modify-write。`claimTurn()` 在同一个临界区检查期望状态，防止两个请求同时占用同一 session。`POST /api/voice/qa`、`browser-session.ts`、`VoiceQaBridge` 与 `BrowserVoiceQa` 已接入 logical session、上下文持久化、生命周期 callback 与真实 retrieval Memory ID observer；普通 TEXT QA 与 retrieval 排序未变化。

新增 `src/lib/server/voice-qa/response-optimizer.ts` 及测试，VOICE 路径生成 `spoken_text`、结构化 `omitted_details` 和可选 follow-up，同时保留内部 evidence/citations。新增 `src/lib/server/voice-qa/error-handler.ts`、`src/lib/server/voice/debug.ts` 及测试；`VOICE_DEBUG=true` 只记录 WebSocket event shape、ASR result count、QA timing、TTS timing/bytes，不记录 transcript、回答、Provider payload、音频或凭据。

更新 `src/lib/server/voice/volcengine-realtime.ts` 和 `src/lib/server/voice-qa/bridge.ts`：Provider 保存最近一次有效 session config，重连后使用新的 Provider session ID 接受 ASR/TTS 事件，应用 session ID 保持稳定；当前 PCM 或 TTS 文本只重放一次。连接恢复失败不再误报为普通 ASR failure；TTS 连接失败会同时保留 connection 与 TTS 两层错误码。无效 PCM 包装同样返回 `VOICE_TTS_FAILED`。

新增 `tests/e2e/test_voice_pipeline.py` 与 `tests/e2e/voice_pipeline_smoke.ts`。Python runner 强制 `VOICE_TEST_MODE=true`，TypeScript harness 使用 mock transport 和真实 Bridge/SessionManager，覆盖 session 创建、ASR partial 不触发 QA、final 触发 QA/TTS，以及 TTS 失败文字 fallback。新增/更新 `docs/voice-session.md`、`docs/voice-response-style.md`、`docs/voice-smoke-test.md`、`docs/voice-recovery.md`，并在 `.env.example`/`package.json` 增加 `VOICE_PROVIDER`、`VOICE_TEST_MODE`、`VOICE_DEBUG` 与 `voice:smoke`。

## Decision & Trade-offs

短期会话复用 JsonStore，没有增加数据库或把临时对话写入长期 Memory；代价是进程内锁不能解决多 Web 实例的同 session 并发。会话 context、transcript 和 Memory IDs 都有硬上限，防止无限增长；浏览器刷新后当前版本不会从 sessionStorage 恢复 logical session ID。

VOICE 响应优化是 deterministic 投影，不新增 LLM，也不改变 TEXT 输出。短答不会为了达到 30 words 机械补齐；长答可能省略次要细节，但必须保留直接回答和可识别的不确定性边界。QA timeout 在底层客户端没有 cancellation hook 时不能停止已经发出的 Provider 操作，但晚到结果不会被朗读。

重连只处理当前 turn，默认一次，不做无限循环或离线音频队列。`VOICE_DEBUG` 默认关闭；smoke 永远使用 mock transport，即使配置 `VOICE_PROVIDER=volcengine` 也不会调用真实 API。

## Validation

`npm run lint` 通过。Voice Provider、Trace、SessionManager、ResponseOptimizer、ErrorHandler、Bridge、Browser session、两个 Voice API、Browser component 与 Memory-scope observer 的最终聚焦回归为 `14 files / 139 tests` 全部通过。`VOICE_TEST_MODE=true VOICE_PROVIDER=volcengine npm run voice:smoke` 为 `4/4` 通过，未调用远端服务。

完整 `npm test` 已执行，结果为 `149/153 files`、`1199/1206 tests` 通过，退出码 1。7 个失败分别来自既有 Windows/POSIX 路径断言及本地目录权限、一个页面测试的绝对路径断言，以及 Playwright spec 被 Vitest 收集；本次 Voice 聚焦测试无失败。没有运行真实 Volcengine、真实 QA Provider 或长录音 Pipeline，也没有提交、推送或部署。

## Limitations

VoiceSession 的 read-modify-write queue 仅在单 Node.js 进程内有效；PM2 cluster 或多 Web 实例需要共享 CAS/lease。过期清理目前在 Voice API 请求时机会式扫描，损坏记录会保留供诊断而不会自动删除。浏览器仅在组件挂载期间保留 logical session ID，刷新页面会开始新会话。

当前 Browser MVP 仍是录完整段后上传，不是实时 microphone streaming；没有 VAD、wake word 或 interruption。ASR 重连只重放当前内存中的 turn，QA timeout 不保证取消底层工作。离线 smoke 验证了应用契约和状态机，但没有证明真实 Volcengine 网络延迟、鉴权、麦克风格式或浏览器自动播放行为。

## Next Steps

先在隔离账号执行一次短句真实 Browser Voice QA smoke，核对 Volcengine partial/final、重连后的 Provider session ID、TTS playback 与 `VOICE_TRACE`。生产扩展到多 Web 实例前，为 VoiceSession 增加共享存储 CAS/lease、TTL maintenance 和 stale-session reconciliation；之后再评估页面刷新恢复、真正流式音频、VAD、打断与硬件入口。

# 2026-07-21 - Next.js Voice WebSocket Runtime Compatibility

## Background

真实 Volcengine 对比验证发现，同一套鉴权、Provider 协议和 `StartSession` payload 在独立 `tsx` 进程中可以成功，但经 Next.js API route 执行时会在收到 `ConnectionStarted` 后由 `StartSession` 抛出无细节 `TypeError`。本次只修复 Next.js 服务端对 `ws` 的依赖处理，并增加不包含 payload 值的发送边界诊断；没有修改 Voice 协议、Session Manager、Response Optimizer、Memory 或 QA retrieval。

## Design

将 `ws` 与现有原生/运行时敏感依赖一起配置为 Next.js server external package，让 API route 在 Node runtime 直接加载已安装的 `ws` 包，而不是让 Next 编译器将其 ESM wrapper 和内部实现打入 route bundle。`StartSession` 诊断保持 `VOICE_DEBUG=true` opt-in，只记录消息类型、顶层 payload key 名、编码帧字节数和发送成功布尔值。

## Architecture Change

Before:

```text
Next.js API route
-> bundled ws wrapper/runtime interop
-> ConnectionStarted
-> StartSession TypeError
```

After:

```text
Next.js API route
-> external Node runtime ws package
-> ConnectionStarted
-> StartSession frame encoded/sent
-> SessionStarted
```

Provider 事件编号、二进制帧编码、`StartSession` schema、timeout 和 retry contract 均未改变。

## Technical Implementation

更新 `next.config.mjs`，将 `ws` 加入 `serverExternalPackages`；更新 `next.config.test.mjs`，防止后续配置回归。更新 `src/lib/server/voice/volcengine-realtime.ts`，在 `StartSession` payload 构造、帧编码和 WebSocket send settle 三个边界增加安全结构化日志，并让内部 `sendAndWait` 接收一个仅报告 send 成败的可选 observer。更新 `src/lib/server/voice/volcengine-realtime.test.ts`，覆盖成功发送、发送失败、字段白名单和敏感值不泄露。

生产构建产物的 `/api/voice/qa` route 已验证使用 `import("ws")` 外部引用，未包含 `node_modules/ws/wrapper.mjs` 的内联实现。真实 smoke 使用本地合成短句、隔离测试账号和生产构建后的 Next server；没有记录凭据、transcript、回答正文、音频内容或完整 Provider response。

## Decision & Trade-offs

没有改用全局 `WebSocket`、没有复制 `ws`、也没有改变 Provider wire protocol，因为独立 `tsx` 已证明现有协议与鉴权有效。外部化会要求部署产物保留可解析的 `ws` runtime dependency；Next output file tracing 已包含 `ws` package files。诊断默认关闭，开启后仍不记录 payload 值，因此可确认发送边界但不能直接重建请求内容。

## Validation

`npm run lint` 通过。Voice Provider、Voice QA、API route、trace、浏览器组件和 Next config 聚焦回归为 `23 files / 196 tests` 全部通过。`npm run build` 使用 Next.js `15.5.19` 成功完成，`/api/voice/qa` 保持 Node dynamic route。

一次真实 Next.js smoke 中，`StartSession` payload keys 为 `dialog,tts`，编码帧为 `195` bytes，WebSocket send 成功，并收到真实 `SessionStarted`。随后收到 ASR partial/final、`ASREnded`、TTS audio（合计 `105606` bytes）、`TTSEnded` 和 `SessionFinished`，原有 `TypeError` 未复现。该隔离账号的 QA 阶段返回 `qa_failed`，TTS 生成了安全 fallback；HTTP smoke client 未在测试上限内完成收尾，因此本次只能声明 Provider/StartSession/ASR/TTS 远端链路成功，不能声明 Browser playback 或完整 HTTP E2E 全绿。没有自动发起第二次远端请求。

## Limitations

原始 `TypeError` 日志没有 stack，根因定位依赖独立 `tsx` 与 Next bundle 的 A/B 行为以及外部化后的真实成功结果；可以确认问题位于 Next 对 `ws` 的 bundle/runtime interop 边界，但没有更细的第三方内部调用栈。真实 smoke 暴露的 QA failure 和 HTTP client 收尾问题与 `StartSession` 修复相互独立，本次按任务边界未修改 QA retrieval、Voice Session Manager 或 Response Optimizer。真实浏览器麦克风和播放仍需单独人工验收。

## Next Steps

在隔离账号补齐可查询 Memory 后，从浏览器页面执行一次短句 push-to-talk 验收，确认 HTTP 200、fallback/QA 正常回答与实际 playback telemetry。若 HTTP 收尾仍挂起，使用现有 Voice trace 和 SessionFinished 后的 server span 单独定位 route teardown；不要回退 `ws` externalization，也不要通过修改 Provider schema规避。

# 2026-07-21 - Browser Voice PCM Stream Diagnostics

## Background

真实 Browser Voice QA 验收已能完成 WebSocket、`StartSession` 和 `SessionStarted`，但一次浏览器录音在 Provider session 建立后没有返回任何 ASR event，随后依次触发 30 秒 ASR fallback 和 60 秒 TTS fallback。现有结构化日志可以证明 Provider session 已建立，却不能区分浏览器录音接近静音、PCM 是否完整转发，或 Provider 收到音频后未返回识别事件。

本次只补充临时、安全的 Browser PCM/stream 诊断，不修改 ASR/TTS 协议、timeout、fallback、Voice QA Bridge、Voice Session Manager、Memory、QA retrieval 或 Response Optimizer，也不因静音判断拒绝或改变请求。

## Design

仅在 `VOICE_DEBUG=true` 时对已经存在于内存中的 PCM 做一次线性聚合扫描，计算时长、字节数、packet 数、peak/RMS dBFS、非静音 sample 比例和启发式 `likely_silent`。所有 PCM packet 经现有 `sendAudio` await 成功后只输出一条 `browser_pcm_stream_completed` 日志；关闭 debug 时不扫描、不输出。

非静音 sample 阈值为 PCM16 full scale 的 1%，约为 `-40 dBFS`。`likely_silent` 只在 RMS 不高于 `-50 dBFS` 或非静音比例低于 1% 时标记；该字段仅用于排障提示，不参与控制流。零振幅 dBFS 使用有限的 `-120` floor，避免 JSON 出现非有限数值。

## Architecture Change

Before:

```text
browser recording -> FFmpeg PCM -> paced sendAudio packets -> wait for ASR
debug: no aggregate PCM or completed-stream evidence
```

After:

```text
browser recording -> FFmpeg PCM
-> VOICE_DEBUG-only aggregate signal summary
-> unchanged paced sendAudio packets
-> one completed-stream metadata log
-> unchanged wait for ASR
```

## Technical Implementation

更新 `src/lib/server/voice/browser-audio.ts`，新增 `summarizeBrowserVoicePcm()`。函数先复用既有 PCM 长度、对齐和 75 秒上限校验，再只返回 `durationMs`、`pcmBytes`、`packetCount`、`peakDbfs`、`rmsDbfs`、`nonSilentRatio` 与 `likelySilent`；不返回或保存 sample、audio buffer、文件名或内容。

更新 `src/lib/server/voice-qa/browser-session.ts`，在 debug 开启时计算 summary，并仅在 `streamBrowserPcmToVoiceBridge()` 成功返回后输出一次 `VOICE_DEBUG`。日志字段为 `duration_ms`、`pcm_bytes`、`packet_count`、`peak_dbfs`、`rms_dbfs`、`non_silent_ratio` 和 `likely_silent`。实际 stream 返回的 bytes、packet 和 duration 用于发送完成字段，因此日志能证明本地 WebSocket send callback 已逐包成功。

更新 `src/lib/server/voice/browser-audio.test.ts` 与 `src/lib/server/voice-qa/browser-session.test.ts`，覆盖确定性 dBFS/ratio、digital silence、字段白名单、debug gate、单次日志，以及录音输入、transcript 和 answer 不出现在日志中。

## Decision & Trade-offs

聚合扫描只在显式 debug 模式执行，避免正常请求增加对最长 75 秒 PCM 的额外 CPU 遍历。日志放在完整 stream 之后，因此存在该事件可以证明本地所有 packet 的 `ws.send` callback 成功，但不能证明 Provider 已完成解码、声学识别或 ASR finalization。

`likely_silent` 是保守启发式而不是声学质量判定；设备增益、DC offset、环境噪声和很轻的说话声都可能影响数值。本次没有增加静音拦截、自动 retry、音量归一化或协议事件，以免诊断修改产品行为。

## Validation

运行 `npm exec -- vitest run src/lib/server/voice/browser-audio.test.ts src/lib/server/voice-qa/browser-session.test.ts`，结果为 `2 files / 27 tests` 全部通过。

运行 `npm run lint`，Next route type generation 与 `tsc --noEmit --incremental false` 均通过。

本次没有调用真实 Volcengine、真实 QA Provider 或浏览器麦克风，没有运行 production build，也没有修改或写入真实音频、transcript、Memory 或用户数据。

## Limitations

如果 conversion 或 streaming 中途失败，不会输出 completed 事件；当前也不记录部分发送 packet 数。`ws.send` callback 成功只代表本地传输层接收该写入，不是 Provider ASR acknowledgment。聚合声级不能判断浏览器选择了哪个麦克风、语音内容是否可懂或 Provider 为什么没有返回 event。

## Next Steps

在隔离账号用同一短句重新执行一次 Browser smoke，对齐 `browser_pcm_stream_completed` 的声级/packet summary、Provider `ASRResponse`/`ASREnded` 和 30 秒 fallback。若 summary 显示明显信号且完整发送但仍无任何 Provider event，应把后续排查聚焦于 Provider audio ingestion/finalization；若 `likely_silent=true`，先检查浏览器输入设备和麦克风电平。诊断完成后再决定移除临时事件或保留为默认关闭的受控运维指标。

# 2026-07-21 - Browser Voice ASR Timeout Protocol Recovery

## Background

真实 Browser Voice QA 日志显示 `StartSession` 已成功，但一次约 7.9 秒浏览器录音没有收到任何 `ASRInfo`、`ASRResponse` 或 `ASREnded`。现有恢复流程等待 30 秒后触发 ASR timeout，却继续在同一个未结束的 audio session 发送 `ChatTTSText`，随后又等待 60 秒 TTS timeout，最终 `POST /api/voice/qa` 在约 102 秒后才返回 text-only `completed_with_errors`。

提供的 Volcengine Realtime 文档明确要求，音频 query 的 `ChatTTSText` 必须在收到 `ASREnded` 后发送。本次修复该确定性协议顺序问题，并增加安全发送诊断；不修改 Memory、QA retrieval、Voice Session Manager、Response Optimizer、Provider payload schema、ASR/TTS timeout 或最终 API schema。

## Design

ASR timeout 本身意味着当前 turn 没有观察到 `ASREnded`，因此该分支不再尝试 TTS，而是立即返回现有安全文字提示和 `VOICE_ASR_TIMEOUT`。Provider session 仍由正常 close 流程执行 `FinishSession`，不在 timeout 分支中先 finish 再 start text session，因为卡住的 session 可能让 `finishSession()` 再等待一个 Provider event，并引入额外延迟、状态竞争和第二个 Provider session identity。

正常识别路径不变：只有收到 `ASREnded` 后才进入 QA，并继续通过 `ChatTTSText` 合成回答。实际收到 `ASREnded` 但没有可用 transcript 的既有 fallback 仍可合成语音，因为该分支满足协议边界。

## Architecture Change

Before:

```text
audio stream completed
-> no ASREnded for 30s
-> ASR timeout fallback
-> ChatTTSText on the still-open audio turn
-> no TTS events for 60s
-> text-only response after about 102s
```

After:

```text
audio stream completed
-> no ASREnded for 30s
-> ASR timeout fallback (text only)
-> no ChatTTSText and no TTS wait
-> close provider session normally
-> completed_with_errors response
```

## Technical Implementation

更新 `src/lib/server/voice-qa/bridge.ts`，让 `handleAsrTimeout()` 以 `synthesize=false` 调用现有 fallback，并输出仅含 `asr_ended_received=false`、`tts_attempted=false` 的 `asr_timeout_fallback` debug event。迟到的 `ASREnded` 继续由既有 `asrTurnHadFinal` guard 忽略，不会触发 QA、TTS 或第二个 response。

更新 `src/lib/server/voice-qa/bridge.test.ts`，验证 timeout 后没有 audio、没有 `sendText`、没有 `tts_started`，状态仍按 `idle -> listening -> thinking -> speaking -> idle` 恢复，并覆盖迟到 `ASREnded`。更新 `src/app/api/voice/qa/route.test.ts`，验证 HTTP 200 text-only contract、`VOICE_ASR_TIMEOUT`、无 `audioBase64/audioMimeType`，且 trace 不包含 `tts_started`。

更新 `src/lib/server/voice/volcengine-realtime.ts` 与测试，在既有两帧 `ChatTTSText` 发送边界增加 opt-in 结构化日志：只记录 message type、frame role、start/end flag、encoded frame size 和 send success；不记录 text、session ID、Provider payload、音频、凭据或 error message。Browser PCM 聚合与完整 stream 诊断由同日 `Browser Voice PCM Stream Diagnostics` 条目记录。

## Decision & Trade-offs

ASR timeout 时牺牲语音错误提示，换取严格协议顺序和确定性的快速降级；页面仍显示“没听清楚，可以再说一遍吗？”，长期 Memory 与逻辑 VoiceSession 均不受影响。没有在当前 Bridge 内组合 `finishSession()` 与 `startSession({ inputMode: "text" })`，因为前者依赖已经异常的 Provider turn 正常返回 `SessionFinished`，失败后 adapter 仍处于 session state，容易把一次可控超时扩成更长的恢复链。

PCM `likely_silent` 仍只是诊断，不会自动拒绝录音；这是为了避免把低音量但有效的用户语音误判为静音。`ws.send` callback 成功也只证明本地传输层接受写入，不代表 Provider 已完成 ASR ingestion。

## Validation

`npm run lint` 通过。Next config、Voice Provider、Browser audio、Voice QA Bridge、Browser session、Voice API/trace route 和前端 Voice 组件聚焦回归为 `23 files / 204 tests` 全部通过。`npm run build` 使用 Next.js `15.5.19` 成功完成，`/api/voice/qa` 保持 dynamic server route。

完整 `npm test` 实际执行结果为 `148/152 files`、`1204/1212 tests` 通过，退出码 1。8 个失败来自既有 Windows/POSIX 路径断言与本地目录权限、两个 Daily Brief checkpoint 时序/缓存用例，以及 Playwright spec 被 Vitest 收集；本次 Voice 聚焦测试没有失败。没有调用真实 Volcengine、真实 QA Provider或浏览器麦克风，也没有运行长录音 Pipeline。

## Limitations

本次消除了 ASR timeout 后确定性的额外 TTS 等待，但没有解释为什么该浏览器录音没有产生任何 ASR event。下一次本地验证需要使用新增的 PCM/stream summary 区分静音或低电平输入与 Provider ingestion/finalization 问题。Timeout 分支当前只有文字提示；若产品要求错误提示也必须发声，需要新增一个原子化、可超时的独立 text TTS session abstraction，而不是复用未收到 `ASREnded` 的 audio session。

## Next Steps

重启本地 Web 后执行一次短句浏览器 smoke，检查 `browser_pcm_stream_completed` 的 `likely_silent`、RMS、packet/byte 数，以及是否出现 `ASRResponse`/`ASREnded`。若 PCM 有明显语音且全部 packet 发送完成但仍没有 ASR event，下一步只调查 Volcengine audio ingestion/input mode；若 `likely_silent=true`，先修复浏览器麦克风设备或录音增益。正常 ASR 后再验证 QA 与 ChatTTSText/TTS，避免把两个阶段混在一次超时中。

# 2026-07-21 - Browser Voice Push-to-Talk ASR Finalization

## Background

一次真实 Browser Voice QA 请求成功建立 WebSocket 和 Volcengine session，并发送了 5.22 秒、167040 bytes、261 个 20ms PCM 包，但 Provider 没有返回 `ASRInfo`、`ASRResponse` 或 `ASREnded`。安全 PCM 诊断确认录音不是静音：peak `-0.1 dBFS`、RMS `-23.3 dBFS`、non-silent ratio `0.2235`。原实现把浏览器“点击开始/点击结束”录音作为 `audio_file` 输入，完全依赖 Provider 自动补静音并隐式结束 ASR。

## Design

按提供的 Volcengine Realtime 文档把 Browser turn 对齐为真正的 push-to-talk 协议：StartSession 使用 `input_mod=push_to_talk`；所有 PCM `TaskRequest (200)` 成功发送后，客户端发送一次 session-scoped `EndASR (400)` JSON 事件；Bridge 继续只在收到 `ASREnded (459)` 后接受 final transcript 并进入 QA。没有增加尾部静音、猜测 ASR 配置或修改 QA/TTS 内容。

## Architecture Change

Before:

```text
Browser recording
-> PCM16LE TaskRequest x N (audio_file)
-> wait for implicit Provider finalization
-> ASR timeout when no 450/451/459 arrives
```

After:

```text
Browser recording
-> PCM16LE TaskRequest x N (push_to_talk)
-> EndASR (400) exactly once
-> ASRInfo / ASRResponse / ASREnded
-> existing QA -> Response Style -> ChatTTSText/TTS
```

## Technical Implementation

- `src/lib/server/voice/events.ts` 新增 `EndASR=400` 客户端事件，并保持 Full Client Request、JSON、session ID 与空对象 payload 契约。
- `src/lib/server/voice/types.ts` 为 `VoiceProvider` 增加 `finishAudioInput()`，将“结束本轮音频输入”与 `finishSession()` 分离。
- `src/lib/server/voice/volcengine-realtime.ts` 实现 push-to-talk 专用 EndASR 发送，拒绝非 PTT、重复结束以及结束后继续发送音频；日志只包含 message type、frame size 和 send success。
- `src/lib/server/voice-qa/bridge.ts` 提供幂等 turn finalization。若 EndASR 发送时连接丢失，沿用现有单次恢复路径，先重放已缓存 PCM，再发送 EndASR。
- `src/lib/server/voice-qa/browser-session.ts` 将 Browser session 改为 `push_to_talk`，并确保只有全部 PCM 包成功发送后才调用 `finishAudioInput()`。
- 同步更新 Voice mocks、offline smoke harness 与 `docs/architecture/SYSTEM_ARCHITECTURE.md`。

## Decision & Trade-offs

`audio_file` 按文档本应由服务端自动补静音，但该真实环境没有产生可观察的 ASR 边界；Browser UI 本身就是明确的按键收音交互，因此 `push_to_talk + EndASR` 比追加人工静音更符合协议、也更容易审计。`ws.send` callback 仍只能证明本地 socket 接受写入，不能作为 Provider ingestion ACK。此次没有修改 TaskRequest binary header 或添加未经真实证据支持的 `asr.extra`。

## Validation

- `npm run lint`：通过。
- Voice focused regression：`22 files / 208 tests` 全部通过，覆盖 EndASR 精确帧、PTT 会话、重复结束、发送后禁音频、stream failure 不发送 EndASR、连接恢复后 PCM replay + EndASR，以及既有 Voice QA/trace/UI 回归。
- `npm run build`：通过，Next.js `15.5.19` production build 成功，`/api/voice/qa` 保持 dynamic Node route。
- `npm test`：实际结果为 `150/153 files`、`1215/1221 tests` 通过，退出码 1；6 个失败均为既有 Windows/POSIX 路径断言、本地目录权限和 Playwright spec 被 Vitest 收集，Voice focused tests 无失败。
- `git diff --check` 在最终文档更新后单独执行。
- 本次修改后尚未调用真实 Volcengine，也未重新运行 Browser remote smoke。

## Limitations

真实根因能确定到 `TaskRequest -> Provider ASR finalization` 边界，但无法仅凭客户端日志证明 Provider 为什么没有完成 `audio_file` 自动收尾。PTT 修复仍需一次用户侧短句复测确认 400 后出现 450/451/459。若 EndASR send 成功后仍完全没有 ASR 事件，需要记录握手 `X-Tt-Logid` 并与 Provider 支持侧核查，而不是继续盲改 schema。当前仍是录完整段后由服务端按实时节奏转发，不是浏览器直接流式上传，也没有 VAD 或打断能力。

## Next Steps

重启本地 Web，录制一句“总结一下今天的事”，确认日志依次出现 `end_asr_frame_encoded`、`end_asr_send_settled(send_success=true)`、`audio_input_finished`、`ASRResponse (451)` 与 `ASREnded (459)`。随后验证 QA、ChatTTSText、TTSResponse 和浏览器播放；若失败，只保留该次脱敏日志继续定位，不重复修改 Memory、QA 或长录音 Pipeline。

# 2026-07-21 - Browser Voice QA Retained Context Continuity

## Background

真实 Browser Voice QA 复测已经成功完成 Volcengine WebSocket、push-to-talk `EndASR`、ASR final 和 TTS 播放，但 QA 在 6ms 内失败。Trace `c4430290-8c87-4484-9b94-18ff1f34f998` 指向 upload `7ab7700f-3a8c-46c6-bc87-a175bf7326a3`；该 upload 在 voice session 创建后约 2 秒被前端 ready 后自动清理，并在 QA 开始前约 9.65 秒留下 delete tombstone。普通文字 QA 继续可用，因为它提交浏览器 localStorage 中的 retained Day context；Browser Voice QA 只提交 uploadId 并从服务端读取已经删除的临时数据，形成确定性的数据生命周期断裂。

## Design

保持现有“ready 结果写入浏览器后清理服务端临时 upload”的生产行为，不延长原始音频或临时 artifacts 的服务端保留时间。Browser Voice QA 改为复用文字 Context QA 的数据边界：页面仅提交回答所需的 transcript segments、Audio Insights、semantic segments、Brief items 和 Relationship cards；服务端先执行大小限制和现有 domain Zod schema 校验，再把可信 context 交给既有 `answerQuestionWithAI` 与 VOICE Response Style。

旧调用兼容路径保留：没有 browser context 时，current scope 仍按 uploadId 从 authenticated user store 读取 ready upload；week/all 仍可使用原 memory-scope answerer。Context-backed 回答不向已删除 upload 写入 orphan `answers`，短期 Voice conversation session、citation trace 和 TTS 投影保持不变。

## Architecture Change

Before:

```text
ready server payload
-> browser localStorage cache
-> automatic DELETE server upload + segments + memory
-> Voice QA sends only uploadId
-> upload_not_found -> qa_failed -> spoken fallback
```

After:

```text
ready server payload
-> browser localStorage cache
-> automatic DELETE server temporary data (unchanged)
-> Voice QA sends audio + bounded evidence context
-> strict context validation
-> existing QA retrieval/answer generation + VOICE style
-> existing Volcengine TTS
```

## Technical Implementation

- 新增 `src/lib/domain/voice-qa-context.ts`，定义内部 `VoiceQaContext` 契约、4 MiB UTF-8 上限、结构化数组数量上限和“至少包含一类可回答数据”的约束。
- `src/app/page.tsx`、`src/components/qa-voice-workspace.tsx` 与 `src/components/voice/browser-voice-qa.tsx` 将页面已经持有的 current/week/all QA context 通过 multipart `context` 字段传递；不包含原始长录音、job、Provider response、token 或用户凭据。
- `src/app/api/voice/qa/route.ts` 在创建 Provider session 前拒绝重复字段、非法 JSON、schema 不匹配、current upload/context ID 不一致和超限 context，并把 multipart 总上限扩展为 audio + 4 MiB context + bounded overhead。
- `src/lib/server/voice-qa/browser-session.ts` 只负责把已验证 context 传入既有 answerer。
- `src/lib/server/voice-qa/adapter.ts` 在 context 存在时调用同一 `answerQuestionWithAI`、VOICE style instruction 和 citation contract；不存在时保留原 store-backed 行为。
- 增加 API、browser component、browser session 和 adapter 回归，覆盖已清理 server upload + retained browser context 仍可回答，以及无 context 旧行为不变。

## Decision & Trade-offs

没有通过关闭自动 DELETE 修复，因为那会改变当前本地优先/在线临时处理的数据保留策略，并长期保留原始音频和派生数据。传递 bounded context 与现有文字 QA 路径一致，能使用已经完成并保存在页面的数据，也避免要求用户重新运行 45 分钟 Pipeline。代价是每次语音提问会额外上传一份有限的结构化 QA context；使用 4 MiB 硬上限和 Zod 校验控制资源与信任边界。

Context path 不伪造或重写 evidence/source IDs，不修改 Memory、Relationship、QA retrieval、Response Style 或公开 response schema。Context-backed answer 不写入已不存在的 upload collection，避免 orphan answer；逻辑会话仍保存受限的 transcript/response conversation state。

## Validation

- `npm run lint`：通过，包含 Next route type generation 与 TypeScript no-emit 检查。
- Voice focused regression：`23 files / 217 tests` 全部通过。
- 页面回归：`src/app/page.test.tsx`，`1 file / 43 tests` 通过。
- 最小修复聚焦回归：`5 files / 67 tests` 通过，包含 route/context/adapter/browser session/UI 边界。
- `npm run build`：通过，Next.js `15.5.19` production build 成功，`/api/voice/qa` 保持 dynamic Node route。
- 本次代码修改后尚未重新调用真实 Volcengine 或 QA Provider；真实日志仅用于根因定位，不能描述为修复后的 E2E 验证。

## Limitations

本次不会恢复已经由 DELETE 清掉的服务端 upload、checkpoints、SQLite Memory 或 evaluation report；它使用浏览器已经保留的 QA context 继续回答。如果浏览器 localStorage 也被清空、页面没有可用 context，旧的 store-backed 路径仍要求服务端存在对应 ready upload。4 MiB 上限覆盖当前 45 分钟 retained payload，但更长或异常膨胀的上下文会在打开 Voice Provider 前被拒绝。

Context-backed week/all 回答使用浏览器聚合并裁剪后的 evidence context；它不会凭空恢复已删除的 SQLite Memory metadata。当前仍是录完整段后提交的 push-to-talk，不支持 VAD、打断或浏览器到 Provider 的直接流式转发。

## Next Steps

保持当前页面和 localStorage，不重新上传 45 分钟音频；重启 Next.js dev server 后再次提问“总结一下今天的事情”。预期 `qa_completed success=true` 且 QA elapsed 不再是 6ms 的本地查空路径，然后继续出现 `tts_started`、`TTSResponse`、`TTSEnded` 和浏览器播放。若仍失败，应记录新 trace ID；重点检查 API 是否收到合法 context，而不是再次修改 Volcengine ASR/TTS 协议。

# 2026-07-21 - Voice QA ASR Timeout Phase Boundary

## Background

Browser retained context 修复后的真实请求 `f98c70f5-0f0e-404e-9a35-89f8f824fb33` 已经完成 ASR final（473ms）、Memory-aware QA（42126ms）和应用 TTS（3293ms，1201352 bytes），但 HTTP 最终在约 72 秒后返回 504，页面显示通用失败提示。Trace 被记录为 `status=incomplete`，`tts_latency_ms` 与 total latency 为空，尽管日志明确存在 `qa_completed success=true` 和 `tts_completed`。

## Design

保留现有 timeout 数值与分层：ASR finalization 仍为 30 秒，QA 与 TTS 各自保持 Bridge 内的有界 timeout，整个 Browser Voice turn 仍由 240 秒 session deadline 兜底。修复只调整阶段所有权：30 秒计时器到期后，若 Bridge 返回 ASR fallback，则结束本轮；若 Bridge 返回 null，表示 ASR 已 final、session 已进入 QA/TTS 或正在关闭，ASR timeout 不得再把完整 response 判为失败。

## Architecture Change

Before:

```text
ASR final in 473ms
-> QA starts
-> 30s ASR timer races the final ASR+QA+TTS response
-> QA still running, handleAsrTimeout returns null
-> browser session rejects response_timeout
-> graceful close waits for successful QA/TTS
-> HTTP 504 after successful work
```

After:

```text
ASR final in 473ms
-> QA starts
-> 30s ASR timer observes handleAsrTimeout=null
-> ASR timer relinquishes ownership
-> QA/TTS continue under their own and global deadlines
-> final VoiceQAResponse returns normally
```

## Technical Implementation

更新 `src/lib/server/voice-qa/browser-session.ts` 的 `waitForResponseWithAsrTimeout()`：有明确 fallback 时仍立即 resolve；null 不再构造 `BrowserVoiceQaSessionError(response_timeout)`，而是让已经存在的 main response promise 继续等待。该 promise 仍监听 global deadline 的 AbortSignal，因此不会产生无界等待。

更新 `src/lib/server/voice-qa/browser-session.test.ts`，增加“ASR 已完成但 QA 超过 ASR timeout”的 fake-timer 回归：1 秒 ASR timeout 时 handler 返回 null，真实 response 在 1.5 秒到达，最终必须成功且不得 hard abort。既有“没有 ASR final 时返回 bounded fallback”和“global deadline hard abort”测试继续通过。

## Decision & Trade-offs

没有把 ASR timeout 从 30 秒简单调大，因为真实 ASR 仅用 473ms，问题是计时器覆盖了错误阶段。也没有修改 QA model、QA 60 秒 timeout、TTS timeout、Volcengine payload、Memory retrieval 或 Browser UI。null 的语义由现有 Bridge 明确定义：closing、`asrTurnHadFinal=true` 或 state 已离开 listening 都返回 null；这些状态均不应由 ASR timeout 制造第二个失败。

Provider 在 QA 执行期间仍产生一轮自身 ChatResponse/TTS 事件；当前 Bridge 在没有 active application TTS waiter 时不会把它作为最终回答。本次 504 的直接根因是 timeout race，未在缺少独立协议证据时修改 Provider dialog 配置。

## Validation

- 关键 timeout/Bridge/API 回归：`3 files / 73 tests` 全部通过。
- 完整 Voice focused regression：`23 files / 218 tests` 全部通过。
- `npm run lint`：通过，包含 Next route type generation 和 TypeScript no-emit 检查。
- `npm run build`：通过，Next.js `15.5.19` production build 成功。
- 本次修改后尚未重新调用真实 Volcengine 或 QA Provider；真实请求只用于证明修复前的阶段时间线，不能描述为修复后的 E2E 成功。

## Limitations

QA 本次真实耗时约 42 秒，虽然低于 Bridge 的 QA timeout，但对语音交互仍然偏慢；本修复保证正确性，不优化 QA latency。Provider 的自动 ChatResponse/TTS 会增加日志噪声和潜在资源消耗，后续需要基于正式协议确认是否可关闭，而不能猜测字段。已失败 trace 不会被回写为 completed；只有新请求会产生正确的 latency trace。

## Next Steps

保持现有 45 分钟浏览器缓存，重启或刷新 Next.js 页面后再次提问同一句话。预期 `ASREnded` 后 QA 即使超过 30 秒也不会触发 HTTP 504；最终应看到 `qa_completed success=true`、应用 `tts_completed`、`POST /api/voice/qa 200` 以及 completed trace。下一阶段可单独测量 QA 42 秒延迟组成，并调查如何禁用 Provider 自带对话响应，但不应把这两项混入本次 timeout correctness 修复。

# 2026-07-21 - QA Latency Observability and Experimental Voice Answer Strategy

## Background

A retained real Browser Voice trace showed approximately 473 ms for ASR, 42,126 ms for QA, and 3,293 ms for TTS. The existing aggregate QA timing could not distinguish Memory retrieval, Relationship context construction, deterministic ranking, prompt construction, Provider generation, validation, and Voice response optimization. This task also needed an isolated Direct Context comparison path without replacing the production evidence-aware Agent QA path.

## Design

The production `agent` mode remains the default and keeps the existing retrieval, prompt, citation, owner-attribution, Relationship, scope, and fallback behavior. Content-free diagnostics are collected around the existing stages and attached to the existing Voice Session trace. An internal `VoiceAnswerStrategy` abstraction selects either the unchanged Agent prompt or an experimental compact Direct Context prompt through the server-only `VOICE_ANSWER_MODE` flag.

Both strategies reuse the same deterministic evidence retrieval and the same post-generation citation, ownership, Relationship-safety, and scope validators. Direct mode does not write or alter Memory items, evidence, or relations. Unknown configuration fails closed instead of silently switching modes.

## Architecture Change

Before:

```text
Voice QA Bridge
-> one opaque answerQuestionWithAI duration
-> response optimizer
-> TTS
```

After:

```text
Voice QA Bridge
-> VoiceAnswerStrategy (agent by default; direct only by flag)
-> trusted Memory/context loading
-> Relationship evidence construction
-> deterministic evidence dedup/ranking
-> prompt construction
-> one QA Provider generation
-> citation/scope/safety validation
-> response optimization
-> content-free benchmark + Voice trace breakdown
-> TTS
```

## Technical Implementation

- Added `src/lib/server/retrieval/qa-observability.ts` for strict nullable stage diagnostics and observer isolation.
- Instrumented `src/lib/server/retrieval/ai-qa.ts` with Relationship context, reranking, prompt, generation, validation, total, prompt-size, response-size, evidence-count, and Provider-call measurements.
- Added a conservative Direct Context system prompt while preserving the same structured answer contract and deterministic validation. Direct mode rejects `assistant_meta` routing for recording/Memory questions.
- Updated `src/lib/server/retrieval/memory-scope-qa.ts` so week/all shadow comparison reuses the exact ranked evidence from the real QA call. A compatibility fallback remains only for injected answerers that do not implement the observer hook.
- Added `src/lib/server/voice-qa/answer-strategy.ts` with `AgentQAAnswerStrategy` and `DirectContextAnswerStrategy`; non-enumerable internal diagnostics hooks are preserved across the strategy wrapper.
- Added `src/lib/server/voice-qa/qa-benchmark.ts` and extended `src/lib/server/voice-qa/trace.ts` with nullable QA stage data. Unknown timeout-stage values remain `null`, not invented zeroes.
- Updated the Voice QA adapter and bridge to collect diagnostics, time response optimization, correlate benchmark rows with the per-request trace ID, and log timeout/failure turns without user content.
- Added `VOICE_ANSWER_MODE=agent` to `.env.example` and added `docs/qa-latency-analysis.md` plus `docs/voice-answer-strategy.md`.

## Decision & Trade-offs

Offline retained-artifact measurement showed Relationship context construction at about 0.018 ms and evidence construction/dedup/ranking at about 6.4 ms, while the matching successful Provider request took about 42,101 ms. The actual bottleneck is therefore non-streaming LLM generation, not local retrieval. No model, timeout, concurrency, evidence limit, SDK retry policy, production Agent prompt, citation rule, owner rule, or Relationship rule was weakened.

The only production-path computation reduction is removal of a duplicate week/all deterministic evidence pass; this saves milliseconds and must not be described as solving the observed 42-second current-scope request. Direct mode reduces the measured system prompt from 1,726 to 605 characters with the fixed instruction `Keep the answer concise.`. Holding the previously measured 9,637-character user/evidence packet constant gives an estimated total reduction from 11,363 to 10,242 characters. This is an offline character comparison, not a real latency result.

## Validation

- `npm run lint`: passed, including Next.js route type generation and TypeScript no-emit checking.
- Focused QA/Voice regression: `10 passed / 1 skipped files`, `114 passed / 62 skipped tests` under the selected QA/Voice filter; no focused failure.
- Focused week/all route compatibility: `3 passed / 55 skipped tests`; legacy API call shape and shadow observation remained compatible.
- `npm run build`: passed with Next.js 15.5.19; production compilation, type validation, static generation, and build trace collection completed.
- `npm test`: exited 1 with 7 existing environment/collection failures: 6 Windows/POSIX path assertions (5 API route assertions and 1 provider-config assertion) and 1 Playwright spec collected by Vitest with zero tests. The QA/Voice changes had no failure in this run.
- No remote QA Provider, Volcengine service, or long-recording Pipeline was called. There is no real post-change Agent/Direct latency benchmark.

## Limitations

The Provider response remains non-streaming, so first-token latency and SDK-internal retry-attempt timing are unavailable. Provider settings/model resolution is visible only as the small unallocated difference inside total QA time, not as a separate stage. The motivating production trace predates the detailed breakdown. Direct mode is experimental and should not be promoted without a controlled same-context remote A/B comparison.

The new trace breakdown is optional so existing stored version-1 Voice traces remain readable. A rollback to older code may ignore or reject records containing the new optional nested field, so deployments should retain the normal forward-compatible application upgrade order.

## Next Steps

Restart the web process after choosing a server-side answer mode, keep `VOICE_ANSWER_MODE=agent` for production, and collect a new content-free Agent trace to confirm the measured stage distribution. Run a controlled Direct comparison only with the same user, scope, question, retained context, model, and Provider. If generation still dominates, investigate Provider/model streaming or a separately approved model choice rather than weakening evidence or Relationship grounding.

# 2026-07-21 - Temporary Direct Voice QA Comparison Panel

## Background

The QA page already exposed the production Agent voice path on the right, but the experimental Direct Context answer strategy was only selectable through server configuration. A temporary side-by-side entry was needed so the same retained recording scope could be tested from the page without changing the production default or restarting the server between comparisons.

## Design

The QA workspace now presents three roles on wide screens: an explicitly labelled Direct experiment on the left, the existing text QA conversation in the center, and the existing Agent voice path on the right. Each voice card sends an explicit per-request `answerMode`, and each card owns an independent browser conversation session so Direct and Agent history cannot leak into each other.

The production card is pinned to `agent`; the temporary comparison card is pinned to `direct`. Missing API input still defaults to `agent` for backward compatibility, while duplicate, empty, mixed-case, or unknown values fail closed with HTTP 400.

## Architecture Change

Before:

```text
Text QA | Agent Voice QA
         (server-wide answer mode)
```

After:

```text
Direct Voice QA (temporary) | Text QA | Agent Voice QA (production)
             per-request mode -> Browser Voice API -> existing strategy adapter
```

## Technical Implementation

- Updated `src/components/qa-voice-workspace.tsx` to render complementary Direct and Agent sidebars around the unchanged text QA content.
- Updated `src/components/voice/browser-voice-qa.tsx` with an explicit `answerMode` prop, Direct-only experiment labelling, mode-specific copy, and request serialization.
- Updated `src/app/api/voice/qa/route.ts` to strictly parse `agent|direct`, preserve the Agent default, and reject ambiguous inputs.
- Updated `src/lib/server/voice-qa/browser-session.ts` to pass the selected request mode into the existing Memory Voice QA answer adapter without changing the bridge, retrieval, Memory, or Provider implementations.
- Updated `src/app/globals.css` with a wide-screen `Direct / main / Agent` grid, responsive single-column fallback, and a visually distinct Direct experiment badge.
- Added or extended component, page, API-route, and browser-session tests for placement, lifecycle, mode propagation, strict validation, and Agent compatibility.

## Decision & Trade-offs

The comparison uses a per-request field instead of mutating `VOICE_ANSWER_MODE`, so two cards can coexist safely and the right production path cannot accidentally inherit the experiment. The two paths deliberately require separate recordings; one microphone capture is not fanned out to two Provider calls. This avoids hidden duplicate remote work and keeps session traces independently attributable, but users must ask the same wording twice for a manual A/B comparison.

The three-column layout is enabled only at the existing wide-screen breakpoint. Narrower viewports stack both voice cards before the main conversation to preserve a usable text column.

## Validation

- Failure-first targeted tests initially reported 12 expected failures before the implementation.
- Final Voice UI/API/strategy regression: `7 files / 127 tests` passed.
- `npm run lint`: passed, including Next route generation and TypeScript no-emit checking.
- `npm run build`: passed with Next.js 15.5.19; production compilation, type validation, static generation, and build trace collection completed. An earlier 180-second command limit expired after successful compilation while Next was still checking types; the complete rerun finished successfully in 219.1 seconds.
- `git diff --check`: passed.
- No microphone capture, QA Provider, Volcengine API, or long-recording Pipeline was invoked.

## Limitations

The in-app browser refused local `localhost:3200` navigation with a client policy block, so this change has automated layout/behavior coverage but no claimed post-change browser screenshot verification. The Direct panel is intentionally temporary and is currently visible whenever the QA workspace is active. Direct and Agent latency remains dependent on real Provider execution and was not benchmarked in this task.

## Next Steps

Refresh the local QA page at a wide viewport, ask the same short question once through the left Direct card and once through the right Agent card, then compare the content-free `VOICE_QA_BENCHMARK` rows by `answer_mode`, generation latency, total latency, and response length. Remove or feature-gate the temporary Direct panel after the controlled comparison is complete.

# 2026-07-22 - Long Recording Answer Strategy A/B Benchmark and Live Monitoring

## Background

The experimental Direct Context voice answer path needed a controlled comparison against the production Agent QA path on the existing synthetic `long-recording-60m-v1` retained artifacts. Manual browser comparisons were not sufficient because they did not freeze context, balance execution order, repeat questions, or preserve per-call evidence and latency metadata. Early remote attempts also showed that Windows terminal output could remain buffered for several minutes, making it impossible to distinguish a slow Provider call from a stalled benchmark.

## Design

The benchmark freezes one retained current-upload context and changes only `VoiceAnswerStrategy`. It runs a seeded, counterbalanced, serialized schedule for three rounds so both Agent and Direct answer every question and alternate first/second position. Each pair must have identical context, Memory-context, and retrieved-evidence digests. Manual quality fields remain empty until a reviewer scores the answers; the tool does not declare a winner automatically.

Live monitoring uses two independent artifacts derived from the final report path: an append-only `*.progress.jsonl` event stream and an atomically replaced, compact `*.partial.json` status snapshot. The status CLI reports completed/total calls, per-mode counts, failed and fallback counts, median-based ETA, current in-flight call elapsed time, and staleness. Monitoring files exclude question text, answer text, cited segment IDs, evidence text, and credentials. Remote execution remains protected by both `--remote` and `RUN_ANSWER_STRATEGY_AB_REMOTE_VERIFY=1`; the library layer also refuses offline execution without an injected mock delegate.

## Architecture Change

Before:

```text
Manual Agent/Direct browser questions
-> terminal-buffered logs
-> no frozen pair integrity
-> no durable partial status
```

After:

```text
34-question synthetic benchmark
-> seeded three-round counterbalanced schedule
-> shared retained context and deterministic evidence retrieval
-> Agent or Direct strategy only
-> citation validation and Voice response optimizer
-> append-only progress events + compact atomic status snapshot
-> final JSON report + Markdown summary
```

## Technical Implementation

- Added `benchmark/answer-strategy/long-recording-60m.json` with 34 evidence-grounded questions: 5 fact, 8 relationship, 8 lifecycle, 5 preference, 4 ambiguous-context, and 4 companion questions.
- Added `src/lib/server/evaluation/answer-strategy-ab.ts` for dataset validation, deterministic scheduling, retained-context loading, execution, evidence/context digest checks, aggregation, reports, progress events, compact monitoring snapshots, output containment, and offline fail-closed behavior.
- Added `src/lib/server/evaluation/answer-strategy-ab-cli.ts` and `scripts/benchmark-answer-strategies.ts` for plan-only defaults and explicitly authorized real runs.
- Added `src/lib/server/evaluation/answer-strategy-ab-status.ts` and `scripts/answer-strategy-benchmark-status.ts` for one-shot and `--watch` monitoring. Failed runs are terminal, completed/failed status does not accumulate meaningless staleness, and an active call exposes only non-content identifiers and elapsed time.
- Added focused evaluation tests for loading, category balance, randomized order, identical evidence, report isolation, remote authorization, offline network blocking, output path validation, atomic replacement, monitoring redaction, terminal status, ETA, and in-flight timing.
- Added npm scripts `answer-strategy:benchmark` and `answer-strategy:benchmark:status`. Added local progress/partial patterns to `.gitignore`; the final synthetic benchmark report remains available for review.
- Generated `reports/long-recording-60m-answer-strategy-ab.json` and `docs/answer-strategy-ab-results.md`. The retained upload and Memory stores were not modified.

## Decision & Trade-offs

Execution is serialized to avoid concurrency and rate-limit effects becoming a second experimental variable. This increases wall-clock time but makes Agent/Direct pairs easier to compare. The ETA uses the median completed-call duration, while the mean is still shown; this keeps one Provider long tail from making the live ETA unusable without deleting the outlier from the final statistics.

The final report retains answer text because the source dialogue is synthetic and blind manual scoring requires it. The live partial snapshot deliberately does not retain answer or evidence content and shrank from approximately 953 KB to 108 KB for the completed 204-call run. Current-scope provided-context QA uses no SQLite long-term Memory context, so this benchmark compares current-upload evidence paths only and cannot be generalized to week/all Memory QA.

## Validation

- One preliminary real Provider smoke question completed in 7,982 ms with 16 retrieved evidence items, 8 citations, and no fallback.
- The controlled remote benchmark completed all `204/204` calls: 34 questions × 2 strategies × 3 rounds. Agent and Direct each completed 102 calls; failed executions were 0; pair integrity was `102/102`; evidence digest mismatches and missing digests were 0.
- Agent: mean 9,412 ms, median 8,219 ms, P95 15,720 ms, and 0 fallbacks.
- Direct: mean 12,327 ms, median 8,332 ms, P95 16,702 ms, and 2 fallbacks. Both fallbacks were `q022` Direct responses classified as `unsupported_answer` in rounds 1 and 3.
- One Direct lifecycle call (`r02-q017-direct`) took 321,617 ms and completed without fallback. It is retained as a real Provider long tail and dominates the Direct mean; excluding it only for diagnostic comparison gives a Direct mean of approximately 9,265 ms, but the official report does not remove it.
- Execution order was counterbalanced but not perfectly globally even: Agent ran first 49 times and Direct 53 times. All 102 pairs remained adjacent and complete.
- `npm run lint`: passed after monitoring hardening.
- Focused A/B, Answer Strategy, QA benchmark, retrieval, Direct Context, Memory-scope QA, and citation regression: `9 files / 79 tests` passed.
- `npm run build`: passed with Next.js 15.5.19 in 198.1 seconds, including compilation, type validation, static generation, and build trace collection.
- No long-recording Pipeline, ASR, Memory write, Redis, Worker, or additional remote benchmark rerun occurred after monitoring hardening.

## Limitations

Manual quality scores remain `0/204`; latency alone is not a quality decision and no strategy winner is declared. A spot-check found that both strategies missed the later resolution for `q017` and `q018`, indicating a shared retrieval/context coverage issue rather than an Answer Strategy difference. Direct `q022` fell back in two of three rounds and needs review.

The OpenAI-compatible client currently permits a 600,000 ms request timeout and two SDK retries. The observed 321.6-second call demonstrates that future runs can still have long in-flight periods even though the monitor now makes them visible. Abrupt OS-level termination cannot guarantee an asynchronous final progress write, but completed run events remain durable in the append-only log. The generated current-scope comparison has an empty long-term Memory context and does not validate week/all behavior.

## Next Steps

Blind-score factual correctness, evidence grounding, relationship understanding, and companion quality for all pairs before selecting a strategy. Investigate the shared `q017`/`q018` retrieval coverage gap separately without changing the A/B prompt variable. For future benchmarks, use `npm run answer-strategy:benchmark:status` or its `--watch` form, choose a new report path instead of overwriting prior evidence, and consider a separately approved benchmark-specific request deadline if multi-minute Provider tails make repeated evaluation impractical.

# 2026-07-22 - Lifecycle-aware QA Retrieval and Grounded Unsupported Answers

## Background

The completed `long-recording-60m-v1` Agent-versus-Direct benchmark showed that `q017` and `q018` failed in both modes because the shared Top-16 Evidence packet favored early pending pottery states and omitted or buried later completion/decision evidence. `q022` had sufficient send-plan evidence, but Direct mode twice returned structured `unsupported`; the old fallback then matched unrelated `open_question` Brief items through the generic word “问题”. The goal was to fix retrieval selection and unsupported handling without changing the Provider, Answer Strategy interface, Voice pipeline, Memory schema, lifecycle resolver, Evidence count, or citation requirements.

## Design

The retrieval layer now classifies explicit later/final/completed/confirmed questions as `lifecycle_resolution`. Only that intent receives topic-gated state and recency ranking. Topic overlap uses the existing deterministic text-feature tokenizer, filters generic lifecycle words, and requires at least two shared tokens before state/time boosts apply. This prevents an unrelated later event from winning through a single word such as “讨论”.

Grounded unsupported handling is limited to lifecycle completion questions. It examines the complete topic-relevant candidate set for terminal evidence, but cites only Evidence already selected into the prompt. When only plans or commitments exist, it states that boundary and does not infer completion. It no longer launches the broad deterministic category fallback for this case.

## Architecture Change

Before:

```text
Question
-> generic priority + whole-string Chinese matching
-> early-first Top 16
-> Agent / Direct
-> unsupported
-> broad category fallback
```

After:

```text
Question
-> deterministic query-intent analysis
-> general ranking OR topic-gated lifecycle state/recency ranking
-> pending + resolved chain representatives inside the unchanged Top 16
-> Agent / Direct
-> grounded lifecycle unsupported boundary with trusted citations
```

## Technical Implementation

- Added `src/lib/server/retrieval/lifecycle-retrieval.ts` with lifecycle intent recognition, deterministic query-topic tokens, conservative terminal/pending state classification, and completion-action labels.
- Updated `src/lib/server/retrieval/ai-qa.ts` with lifecycle-only topic scoring, `+14` terminal-state weight, `-4` pending-state weight, normalized `0..8` recency weight, small Brief/raw specificity weights, later-first lifecycle tie-breaking, and pending/resolved chain representatives. `MAX_EVIDENCE_ITEMS` remains 16.
- Added a full-candidate lifecycle context sidecar for safe negative-evidence checks without adding retrieval metadata to public Evidence items or benchmark digests.
- Added a grounded unsupported answer builder that uses `buildAnswerFromAI`, deduplicates overlapping source segments, preserves citations, and refuses to infer completion from plans.
- Added `src/lib/server/retrieval/lifecycle-retrieval.test.ts` with `q017`, `q018`, and `q022` regression fixtures derived from the synthetic 60-minute dialogue, plus unrelated-event and general-order guards.
- Added `docs/lifecycle-retrieval-improvement.md` with the root cause, ranking contract, unsupported flow, retained-artifact results, trade-offs, and limitations.

## Decision & Trade-offs

The implementation does not use embeddings, another LLM call, or a larger Evidence packet. Lexical state markers are intentionally conservative and only affect questions with explicit lifecycle direction plus sufficient topic overlap. This makes the behavior explainable and bounded, but uncommon paraphrases may remain unrecognized. General QA retains its previous scoring and earlier-first tie break.

The unsupported answer says that the current records do not contain completion evidence; it does not claim the action never happened. If a topic-matched terminal state exists, a negative answer is prohibited. This is safer than trusting a Provider `unsupported` route or re-running a generic deterministic search.

## Validation

- Failure-first regression: the initial new suite produced the expected `14/14` failures before implementation (missing intent export, final Evidence absent from Top 16, and unrelated unsupported fallback).
- Final focused QA regression: `6 files / 77 tests` passed, covering lifecycle retrieval, Agent QA, Direct Context QA, deterministic QA, Memory-scope QA, Relationship Evidence, citations, and both Answer modes.
- `npm run lint`: passed, including Next route generation and TypeScript no-emit validation.
- Offline retained-artifact check, without Provider calls: `q017` now ranks a completion Audio Insight first; `q018` ranks `brief_21` (two people, no friends) first and provisional `brief_11` second; `q022` ranks the two send commitments first and second. Evidence count remains 16.
- Full `npm test`: `156` files and `1,280` tests passed; `5` files / `9` tests failed, plus the existing Playwright collection problem. Failures were outside this change: Windows/POSIX path assertions and folder permissions, one UI alias-cache assertion, and Daily Brief checkpoint timing/corrupt-fixture tests. All focused retrieval/QA tests passed in the same workspace.
- No complete A/B benchmark, long-recording Pipeline, remote Provider call, Memory write, deployment, commit, or push was performed.

## Limitations

Lifecycle intent and state matching remain deterministic and lexical. Very short follow-up questions that omit the event topic do not yet carry a topic from conversation history. Broad Semantic Evidence may still contain more text than the prompt excerpt limit, although focused Brief/raw/Audio Evidence now receives lifecycle-specific selection. The retained check validates ranking and fallback behavior, not real-Provider answer consistency or latency.

## Next Steps

Run a small, explicitly approved q017/q018/q022 Provider-only verification before any full benchmark rerun. If short follow-ups remain weak, add conservative conversation-topic carry-over without changing Evidence limits. Keep manual quality scoring separate from latency measurements and retain the prior A/B report as the before baseline.

# 2026-07-22 - Lifecycle Completion Intent Hardening

## Background

The post-fix Agent-versus-Direct benchmark left one shared failure: `q034` ("她答应的事情都做完了吗？") was classified as a general query. It therefore skipped lifecycle state retrieval and, when the Provider returned `unsupported`, fell through to a generic commitment inventory instead of distinguishing promises from completion evidence. This task was limited to lifecycle intent and grounded unsupported handling; it did not change the Answer Strategy, Voice pipeline, Memory schema, Evidence limit, or the main retrieval score formula.

## Design

Completion-confirmation wording is now recognized explicitly, including `做完了吗`, `完成了吗`, `有没有完成`, `有没有做到`, `兑现了吗`, `履行了吗`, `实现了吗`, `后来做到没有`, and `最终有没有完成`. Questions that combine a commitment expression with aggregate wording such as `都/全部/所有/事情/事项` receive an internal aggregate-completion marker.

For aggregate completion questions, lifecycle matching is limited to explicit commitment/future-action evidence and explicit fulfillment/action-completion evidence. This avoids treating every generic `resolved` item as a fulfilled promise. The deterministic unsupported answer separates `已承诺`, `已完成证据`, and `当前状态`, and reports partial completion when selected Evidence contains both completed and still-pending items.

## Architecture Change

Before:

```text
“答应的事情都做完了吗”
-> general intent
-> generic Evidence order
-> Provider unsupported
-> generic commitment list
```

After:

```text
completion-confirmation wording
-> lifecycle_resolution + preferLatestState
-> aggregate commitment/fulfillment matching inside the existing Top 16
-> Agent or Direct Provider
-> grounded three-state unsupported answer
   (completed / pending / partial or unknown)
```

## Technical Implementation

- Updated `src/lib/server/retrieval/lifecycle-retrieval.ts` with completion-confirmation patterns, the aggregate commitment-completion flag, bounded commitment/fulfillment matchers, and bare `未完成/未确认` pending-state handling.
- Updated `src/lib/server/retrieval/ai-qa.ts` so lifecycle unsupported handling considers only Evidence already selected into Top 16, prefers structured Brief Evidence for deterministic citations, and emits separate completed, pending, partial, or unknown status text.
- Updated `src/lib/server/retrieval/lifecycle-retrieval.test.ts` with all requested intent phrases and Agent/Direct regressions for no completion evidence, complete evidence, and partial completion. Fixtures deliberately use `答应` in the question and `承诺` in Evidence to cover the real synonym boundary.

## Decision & Trade-offs

`MAX_EVIDENCE_ITEMS`, the core scoring formula, ranking weights, Provider prompts, public schemas, and Answer Strategy interfaces remain unchanged. Aggregate matching is conservative: a pending item needs an explicit promise/future-action marker, while a completed item needs an explicit performed-action marker. This may miss indirect fulfillment language, but it avoids converting ordinary decisions or future states into proof that a promise was fulfilled.

The fallback does not assert that every promise was completed merely because one completed item exists. It also does not claim an action never happened when completion Evidence is absent; the state remains unknown. Structured Brief Evidence is preferred over broad Semantic or acoustic context for the deterministic fallback, while citations still reference only the unchanged retrieved Evidence packet.

## Validation

- Failure-first targeted run exposed the expected intent and generic-fallback failures before implementation.
- Final focused regression: `5 files / 80 tests` passed, covering lifecycle retrieval, Agent QA, Direct Context QA, Memory-scope QA, and the Answer Strategy benchmark harness.
- Lifecycle-focused suite: `1 file / 33 tests` passed.
- `npm run lint`: passed (`next typegen` and TypeScript no-emit validation).
- `npm run build`: passed; Next.js production compilation, type validation,
  static generation, and build trace collection completed successfully.
- `git diff --check`: passed; only existing Windows LF-to-CRLF notices were printed.
- Read-only retained `long-recording-60m-v1` verification: q034 is now `lifecycle_resolution`, `preferLatestState=true`, and aggregate completion is enabled. Top 16 contains both completed and pending evidence; `brief_23` (submitted, paid, and booking completed) and `brief_30` (remaining explicit arrangements) are present. Every selected source ID exists in the 307 retained TranscriptSegments.
- No full benchmark, remote Provider call, Pipeline run, Memory write, commit, push, or deployment was performed.

## Limitations

The intent and action-state matchers are deterministic lexical rules. Indirect completion phrasing without a supported action marker may remain unknown. Aggregate completion currently provides a conservative evidence-level summary; it does not construct a one-to-one fulfillment edge for every promise or infer that `她` maps to a named identity when owner identity is uncertain.

## Next Steps

Keep q034 in the next scheduled benchmark and manually verify that both modes answer the aggregate completion question rather than listing commitments. If future examples require exact per-promise accounting, consume existing lifecycle-edge metadata in a separate scoped change instead of broadening lexical completion patterns or the Evidence packet.

# 2026-07-22 - Streaming LLM Phase 1

## Background

Voice QA currently waits for a complete QA Provider response before validation and TTS. Real traces can measure total QA generation time but cannot observe time-to-first-token or sentence formation. This task adds only the first streaming layer around QA generation. It does not alter Memory, Retrieval, Lifecycle, Answer Strategy, TTS, browser playback, or the existing production voice path.

## Design

The installed OpenAI SDK supports streaming for both configured QA wire formats: Chat Completions deltas and Responses `response.output_text.delta` events. A new opt-in async generator emits `stream_started`, unsafe token deltas, validated sentence events, and a final completion event. The existing `answerQuestionWithAI()` remains unchanged as the default API and is invoked as the bounded fallback when a stream is unsupported, empty, incomplete, or fails.

Because the Provider output is structured JSON and citation IDs usually arrive after answer text, raw deltas are quarantined. Token events expose content only as `quarantinedText`, are explicitly marked unsafe for speech and persistence, and are not connected to TTS or the browser. Sentence events are derived only from the final `QuestionAnswer` after the existing JSON parse, Evidence allowlist, citation mapping, lifecycle unsupported handling, Relationship/Memory scope checks, and companion response normalization. They are still marked unsafe for direct speech because the unchanged Voice Response Optimizer has not yet removed citations or compacted spoken text.

## Architecture Change

Before:

```text
QA Provider
-> complete JSON response
-> parse + citation/safety validation
-> QuestionAnswer
```

After (opt-in Phase 1 only):

```text
QA Provider stream
-> quarantined raw delta events (unsafe for speech/persistence)
-> explicit Provider terminal marker
-> complete JSON buffer
-> unchanged parse + citation/safety validation
-> QA-validated sentence events (Response Optimizer still required for speech)
-> final QuestionAnswer

stream unavailable/empty/error
-> existing answerQuestionWithAI()
```

## Technical Implementation

- Added `src/lib/server/retrieval/qa-provider.ts` to share non-streaming and streaming Chat/Responses Provider requests, require explicit `finish_reason=stop` / `response.completed` terminal events, consume Responses done-only text safely, and classify unsupported, incomplete, and failed streams without logging response content.
- Added `src/lib/server/retrieval/qa-streaming.ts` with the event contract, enumerated content-free trace schema/recorder, Provider-versus-operation timing separation, observer isolation, and deterministic validated-answer sentence splitting.
- Updated `src/lib/server/retrieval/ai-qa.ts` with `answerQuestionStream()`, a common final validation function shared with `answerQuestionWithAI()`, the raw-delta quarantine, non-stream fallback, and QA execution diagnostics for successful streams.
- Added `src/lib/server/retrieval/ai-qa-streaming.test.ts` and `src/lib/server/retrieval/qa-streaming.test.ts` for Chat and Responses delta ordering, first-token timing, empty streams, partial Provider failures, fallback, trace privacy, and validated sentence release.
- Added `docs/qa-streaming-phase-1.md` with the event lifecycle, safety boundary, trace contract, usage, and limitations.

## Decision & Trade-offs

Phase 1 does not send raw tokens or partial sentences to TTS. This deliberately gives up immediate time-to-audio improvement because a partial structured response cannot satisfy Evidence First, citation validity, Relationship safety, or Memory scope constraints. The benefit is accurate TTFT observability and a safe interface that cannot silently bypass final validation.

Streaming is opt-in and the production Answer Strategy remains Promise-based. The SDK supports the required APIs, but the currently configured Tokenhub/OpenAI-compatible gateway has not been remotely smoke-tested for SSE compatibility. If streaming fails, one existing non-streaming request is used as fallback; Provider SDK retry behavior remains governed by the existing client configuration.

## Validation

- New streaming suites: `2 files / 12 tests` passed, including clean-EOF rejection, Responses done-only compatibility, explicit incomplete status, validation fallback classification, and raw-delta quarantine assertions.
- Focused QA regression: `7 files / 93 tests` passed, covering streaming, QA observability, Agent QA, Direct Context QA, lifecycle retrieval, Memory-scope QA, citations, and deterministic fallback behavior.
- `npm run lint`: passed (`next typegen` and TypeScript no-emit validation).
- No remote Provider request, TTS request, browser integration, long-recording Pipeline, deployment, commit, or push was performed.

## Limitations

The real Tokenhub Responses streaming contract is not yet verified. `first_sentence_completed` now measures the first sentence event released after full QA validation; it does not claim that an earlier raw punctuation boundary was safe. Therefore production voice first-audio latency is unchanged. The async generator applies consumer backpressure, so `totalStreamMs` is observed iterator duration rather than pure network time, and `providerCallCount` counts logical SDK calls rather than hidden SDK HTTP retries. The interface also does not yet abort the underlying Provider stream when a future caller times out or starts a newer turn.

## Next Steps

Run one controlled, non-sensitive QA Provider streaming smoke test before enabling the opt-in interface outside tests. Then add turn-generation cancellation and a sentence-level Evidence/safety commit protocol. Only after those controls exist should a separate task integrate validated sentence delivery with TTS and a streaming browser transport.

# 2026-07-22 - Sentence-level Streaming Commit

## Background

Streaming LLM Phase 1 exposed raw Provider deltas and a final validated `QuestionAnswer`, but it could not associate individual sentences with trusted Evidence. A punctuation-complete fragment could still be part of incomplete JSON, cite an invalid Evidence ID, lose a later uncertainty boundary, or be replaced by the existing deterministic fallback. This task adds a deterministic sentence commit layer without changing Memory, Retrieval, Lifecycle, the Provider request/response contract, TTS, or browser playback.

## Design

The new `SentenceCommitManager` uses a conservative two-phase protocol. During streaming it parses only the partial JSON `answer` string and records quarantined sentence candidates. Candidates are always unvalidated and unsafe for speech. After an explicit Provider terminal event, `answerQuestionStream()` still performs the complete existing QA validation. Only then does the manager align each final sentence's inline `[E#]` citations with the immutable Evidence allowlist, final citation metadata, and trusted source segment IDs.

Sentence commits are atomic at answer level. If any sentence lacks sentence-local support, contains malformed or conflicting citations, or cannot be aligned exactly, all sentence commits are withheld. This prevents a supported positive claim from being released while a later uncited uncertainty or relationship-boundary sentence is silently dropped. The final `QuestionAnswer` remains available through the unchanged final event.

## Architecture Change

Before:

```text
Provider token stream
-> quarantined token events
-> complete response validation
-> generic sentence split
-> final QuestionAnswer
```

After:

```text
Provider token stream
-> SentenceCommitManager candidate buffer
-> JSON-string-aware boundary detection
-> provisional candidates (validated=false, safeForSpeech=false)
-> explicit Provider completion
-> unchanged full QA / Evidence / scope / lifecycle / style validation
-> sentence-local citation and source-ID alignment
-> atomic grounding commits or whole-answer withholding
-> final QuestionAnswer
```

## Technical Implementation

- Added `src/lib/server/retrieval/qa-sentence-commit.ts` with incremental answer-string extraction, deterministic sentence boundaries, citation suffix handling across token chunks, strict citation parsing, immutable Evidence mapping, full metadata/source-set equality checks, duplicate-ID rejection, answer-level atomic commit, cancellation, and idempotent finalization.
- Updated `src/lib/server/retrieval/ai-qa.ts` so every Provider delta enters the manager only as a provisional candidate. Stream failures cancel that generation before the existing non-stream fallback starts. Final sentence events are emitted only from grounding-committed results.
- Updated `src/lib/server/retrieval/qa-streaming.ts` so sentence events include `sentence`, `citationIds`, and trusted `supportIds`, plus separate `groundingValidated` and `safeForSpeech` flags. Raw tokens and sentence commits remain forbidden from persistence.
- Added `src/lib/server/retrieval/qa-sentence-commit.test.ts` and expanded `src/lib/server/retrieval/ai-qa-streaming.test.ts` with sentence-boundary, citation-alignment, malformed citation, duplicate metadata, whole-answer safety, partial-stream failure, and forbidden relationship-output regressions.
- Added `docs/qa-sentence-streaming-commit.md` and linked it from `docs/qa-streaming-phase-1.md`.

## Decision & Trade-offs

`groundingValidated` is deliberately separate from `safeForSpeech`. Even a fully grounded sentence remains `safeForSpeech=false` because the unchanged Voice Response Optimizer has not yet produced the final spoken projection. This avoids creating an API contract that a future consumer could route directly to TTS while still containing presentation or length issues.

Response-level citations are not guessed onto individual sentences. The manager requires strict inline citation locality and exact agreement between the inline citation union, final citation metadata, current Evidence support IDs, and `citedSegmentIds`. This reduces sentence-commit coverage for Provider or deterministic answers that only carry global citations, but preserves Evidence First and prevents incorrect sentence-level attribution.

The manager does not release a grounded subset of a partially committable answer. The loss in coverage is intentional: sentence dependencies and safety caveats are not represented in the unchanged Provider contract, so selective release could change the meaning of the validated answer.

## Validation

- Failure-first checks confirmed the missing module initially failed import, then exposed `9` expected failures for malformed citations, extra global support, duplicate IDs, source-ID normalization, and selective release before the safety hardening was implemented.
- Sentence/stream focused regression: `3 files / 39 tests` passed.
- Broader QA regression: `9 files / 127 tests` passed, covering Agent QA, Direct Context QA, lifecycle retrieval, Memory-scope QA, Relationship Evidence, stream tracing, Provider fallback, and sentence commits.
- `npm run lint`: passed (`next typegen` and TypeScript no-emit validation).
- No remote Provider request, TTS request, browser integration, long-recording Pipeline, Memory write, deployment, commit, or push was performed.

## Limitations

The current Provider contract still returns one complete structured JSON object. Candidate boundaries can be observed early, but full citation, relationship, lifecycle, scope, and response-style validation still requires the complete response. Consequently this change does not reduce production first-audio latency.

Answers with only response-level `citationIds` and no sentence-local `[E#]` produce zero sentence commits; the final validated answer still returns normally. Turn-generation fencing, AbortSignal propagation, and stale-turn cancellation are not yet part of `answerQuestionStream()`. Sentence events are not connected to the Voice Response Optimizer, TTS, browser transport, or persistence.

## Next Steps

Add explicit turn/generation cancellation before any live voice integration. If real early audio is required, define a separately scoped Provider-compatible sentence framing contract that carries independently complete grounding metadata, then run each committed sentence through the existing Voice Response Optimizer before creating a true `safeForSpeech` event. Preserve the complete-answer fallback for answers that cannot be committed sentence by sentence.

# 2026-07-22 - Streaming Voice Closure

## Background

Streaming LLM Phase 1 and `SentenceCommitManager` established a safe sentence-level grounding boundary, but Voice QA still waited for the complete TTS audio buffer, wrapped it as WAV, returned it from `/api/voice/qa`, and only then started browser playback. This task connects validated sentence commits to bounded TTS chunks and browser playback without changing Memory, Retrieval, lifecycle resolution, Evidence generation, the Agent/Direct strategy interface, or the `VoiceProvider` contract.

## Design

The integration is opt-in at the HTTP boundary. Existing callers without `Accept: application/x-ndjson` retain the full JSON/WAV response. The browser prepares Web Audio during the user's push-to-talk gesture and opts in only when that preparation succeeds. The server exposes audio chunks only after the complete QA answer has passed the existing validator, every committed sentence has sentence-local support, and an atomic streaming voice preflight has preserved uncertainty, lifecycle state, and ownership language.

TTS uses the existing Provider session and `sendText()` method one safe sentence at a time. The adapter waits for each sentence's matching `TTSEnded` event before sending the next sentence. Server and browser queues are bounded; cancellation propagates through the browser request, session deadline, Bridge, TTS iterator, and Web Audio queue.

## Architecture Change

Before:

```text
ASR final
-> complete QA validation
-> full Voice Response Optimizer
-> full TTS collection
-> WAV Base64 response
-> Browser audio element playback
```

After:

```text
ASR final
-> existing QA streaming adapter
-> complete Evidence/citation/safety validation
-> atomic SentenceCommitManager output
-> Streaming Voice Optimizer
-> ordered sentence-level TTS chunks
-> backpressured NDJSON transport
-> Browser Web Audio queue

unsafe / unsupported / validation fallback / no sentence commit
-> existing full QA + full TTS + WAV path
```

## Technical Implementation

- Added `src/lib/server/voice-qa/streaming-response-optimizer.ts` with deterministic citation/presentation removal, support allowlist validation, protected semantic anchors, and whole-turn atomic preflight.
- Added `src/lib/server/voice/streaming-tts.ts` with sequential sentence turns, Provider event/session filtering, global chunk ordering, bounded buffering, timeouts, failure classification, cancellation, and listener cleanup. The `VoiceProvider` interface was not changed.
- Updated `src/lib/server/voice-qa/adapter.ts`, `types.ts`, `bridge.ts`, and `browser-session.ts` so only a clean `provider_stream` final result can release committed sentences; all raw deltas remain quarantined. The Bridge flushes the first-audio trace prerequisite before exposing the first chunk, preventing playback telemetry from racing persistence.
- Added `src/lib/voice-browser-stream.ts` and `src/lib/client/voice-ndjson-stream.ts` for a bounded, validated NDJSON contract. Protocol failure cancels the underlying reader.
- Updated `src/app/api/voice/qa/route.ts` with an opt-in `TransformStream` transport. Writer readiness is awaited for transport backpressure; ordered PCM chunks, fallback WAV, answer metadata, and terminal status are emitted without logging response content.
- Added `src/lib/client/voice-audio-queue.ts` for ordered PCM16LE Web Audio scheduling, initial buffering, underflow recovery, bounded enqueue backpressure, duplicate/empty chunk handling, reconnect pause/resume primitives, cancellation, and deterministic missing-sequence failure.
- Updated `src/components/voice/browser-voice-qa.tsx` and `src/app/globals.css` to prepare the queue in a user gesture, stream and play chunks, preserve the legacy player fallback, report playback telemetry, and expose explicit answer cancellation.
- Extended `src/lib/server/voice-qa/trace.ts` and `src/app/api/voice/trace/route.ts` with first committed/safe sentence, stream start, first chunk, playback, and stream completion events plus content-free latency fields.
- Added/expanded tests for optimizer safety, TTS ordering/failure/cancellation, browser queue ordering/underflow/reconnect/cancellation, NDJSON parsing, Bridge fallback boundaries, route backpressure/abort behavior, trace transitions, and browser legacy compatibility.
- Added `docs/voice-streaming-closure.md` and updated `docs/voice-observability.md`, `docs/qa-streaming-phase-1.md`, `docs/qa-sentence-streaming-commit.md`, and `docs/architecture/SYSTEM_ARCHITECTURE.md`.

## Decision & Trade-offs

No raw token or provisional sentence is spoken. The whole committed turn is preflighted before the first speech event, so one invalid later sentence cannot produce a partial spoken prefix followed by a semantically different fallback. This retains Evidence First at the cost of keeping complete QA generation and validation on the critical path.

If streaming TTS fails before any audio chunk is exposed, the Bridge may use the existing full-text TTS fallback. After any chunk has been exposed, it does not replay the answer from the beginning; the text remains available and the turn is reported with a TTS/playback error. NDJSON was selected as a small request-scoped transport that preserves the existing authenticated POST and avoids introducing another WebSocket protocol. It uses Base64 framing overhead, but keeps binary/provider details out of the public Voice Provider contract.

## Validation

- `npm run lint`: passed (`next typegen` and TypeScript no-emit validation).
- Voice-focused regression: `28 files / 297 tests` passed.
- Bridge + route regression: `2 files / 75 tests` passed.
- Browser queue/parser/component regression: `3 files / 35 tests` passed.
- Browser session regression: `1 file / 15 tests` passed.
- `npm run build`: passed with Next.js `15.5.19`; production compile, type validation, `18/18` static pages, and build trace collection completed. The first attempt reached build-trace collection but exceeded a 240-second command limit; the cached second attempt completed in 272.9 seconds.
- `git diff --check`: passed; Git reported only existing LF-to-CRLF conversion warnings.
- Full `npm test`: `164` files passed and `4` files failed; `1399/1407` tests passed. The failures were outside this Voice task: Windows `/tmp` and `/var` path expectations in settings/routes tests, a Playwright spec collected by Vitest, and two Daily Brief checkpoint timing/fixture failures under full parallel load. A focused rerun passed all `13` Daily Brief chunk-processing tests; the server-path expectation remains reproducibly POSIX-specific on Windows.
- No real Provider request, long-recording Pipeline, Memory write, deployment, commit, or push was performed.

## Limitations

The Provider still returns one structured QA answer, so sentence commits are released only after complete LLM generation and full citation/safety validation. This phase is expected to reduce the full-TTS tail, not the dominant QA generation latency; no real before/after latency measurement was made.

The new TTS flow is verified with mocks but has not been exercised against a real Volcengine multi-sentence session. Request-scoped NDJSON is cancelled on disconnect and has no server replay buffer, so it cannot resume a broken HTTP stream. The queue exposes pause/resume primitives, but automatic transport reconnect is not implemented. `playback_started` is measured when Web Audio is scheduled and telemetry reaches the server, not at the physical speaker. There is still no VAD, wake word, barge-in, or device transport.

## Next Steps

Run one controlled short real-provider smoke test to verify multi-sentence `ChatTTSText` ordering, `question_id/reply_id` behavior, time-to-first PCM, cancellation, and partial-failure handling. Then compare `speechToFirstAudioPlayMs` with the retained full-WAV baseline. Any future overlap between LLM generation and TTS requires an independently final Provider-compatible sentence framing contract; raw token punctuation must not be treated as sufficient grounding.

# 2026-07-22 - Real Streaming Voice E2E Validation

## Background

The Streaming Voice Closure had only mock coverage for sentence-level TTS, browser audio queuing, cancellation, and failure recovery. This task validates the unchanged Browser -> Volcengine ASR -> streaming QA -> sentence commit -> Volcengine TTS -> browser playback path against real Provider credentials and isolated retained Memory data. It also compares the observable TTS tail with the existing full JSON/WAV path without changing Memory, Retrieval, lifecycle resolution, answer strategies, or the Provider contract.

## Design

The evaluation uses short local synthetic microphone WAV inputs and a dedicated evaluation account against an isolated copy of retained runtime data. A development-only Playwright harness was added with explicit `RUN_STREAMING_VOICE_REMOTE_VERIFY=1` and `EVALUATION_MODE=true` gates. It records only timestamps, counts, hashes, booleans, and trace IDs; transcript text, answer text, Evidence content, audio bytes, and credentials are excluded from its report model.

Real Provider disruption was limited to one user cancellation. TTS failure before the first chunk, abnormal WebSocket disconnect, and truly empty streams remain deterministic mock tests because intentionally breaking credentials or network state would not isolate the intended failure boundary safely.

## Architecture Change

Production architecture is unchanged.

```text
Synthetic browser microphone input
-> existing Browser Voice QA component
-> real Volcengine ASR
-> existing streaming QA and sentence commit
-> existing streaming TTS adapter
-> existing browser AudioQueue
-> evaluation-only sanitized report
```

## Technical Implementation

- Added `scripts/validate-streaming-voice-e2e.ts`, an evaluation-only harness for single-sentence, multi-sentence, uncertainty, legacy JSON/WAV comparison, and cancellation scenarios.
- Added `scripts/validate-streaming-voice-e2e.test.ts` for fail-closed remote gates, report containment/non-overwrite, content-free summaries, chunk-order detection, and safe QA stream-log parsing.
- Added the `voice:streaming:e2e` npm script.
- Saved the actual sanitized audit to `.data/evaluation/streaming-voice-real-v1/run-20260722-173105/report.json` and `report.md`; the ignored runtime directory also retains the generated synthetic inputs and isolated trace artifacts.

## Decision & Trade-offs

The result is reported as partial success. A real single-sentence turn produced one safe sentence, 31 ordered PCM chunks, and browser playback. Multi-sentence and uncertainty turns produced non-empty QA token streams but zero committed sentences, so the unchanged fail-closed path used full legacy TTS. This confirms safe recovery but does not count as successful multi-sentence streaming.

The legacy comparison does not use its persisted 24,705 ms value as first-play latency because the manual probe submitted `audio_play_started` after playback ended. Only the comparable TTS-tail estimate is reported: 2,091 ms for streaming versus approximately 3,144 ms for legacy, a 1,053 ms reduction in this single sample. QA latency differed between requests, so no end-to-end winner is claimed.

## Validation

- Real single-sentence Provider path: HTTP completed, one grounded/safe sentence, 31 ordered audio chunks, citation markers absent from speech, and browser `playback_started` observed.
- Single-sentence trace latency: ASR 909 ms, QA 11,726 ms, speech end to first safe sentence 12,719 ms, TTS start to first chunk 786 ms, and speech end to playback 14,827 ms.
- Real multi-sentence path: 206 QA token chunks, zero sentence commits, safe legacy TTS fallback, terminal status completed.
- Real uncertainty path: 85 QA token chunks, zero sentence commits, uncertainty wording preserved through safe legacy TTS fallback, terminal status completed.
- Real cancellation: terminal status `aborted`, failure `session/request_aborted`, no whole-request retry.
- Focused validation: `13` files and `198` tests passed, covering the E2E harness, QA streaming, sentence commit, streaming optimizer/TTS, Bridge/API, browser parser/queue/component, and Voice trace.
- `npm run lint`: passed.
- The self-contained harness could not finish its terminal-trace assertion because concurrent browser/server trace writes exposed a lost-update race. No additional production fix was made in this validation-only task.

## Limitations

Multi-sentence and uncertainty answers have not yet completed the sentence-level streaming TTS path. `first_token_received` is available only as a relative content-free QA metric and is not persisted as an absolute Voice trace timestamp. Concurrent `playback_started` and `stream_completed` persistence can overwrite one another, reject the later `session_completed` update with 409, and leave a successful stream trace in `in_progress`.

Pre-first-chunk TTS failure, abnormal WebSocket disconnect, and true empty-stream recovery are mock-validated only. The latency comparison has one sample per path and is not statistically representative. The evaluation harness self-start/terminal run therefore remains blocked until trace writes are conflict-safe; this task intentionally does not repair that production observability issue.

## Next Steps

First fix the Voice trace lost-update behavior with conflict-safe event merging and add a persisted absolute first-token timestamp. Then diagnose why real multi-sentence and uncertainty structured answers produce zero sentence commits while preserving the current atomic Evidence First boundary. After those two issues are resolved, rerun the same gated harness for at least three repetitions per path before drawing latency conclusions.

# 2026-07-23 - Voice Trace Persistence Concurrency Hardening

## Background

The real Streaming Voice smoke test exposed a lost-update race in Voice trace persistence. Browser telemetry could persist `playback_started`, after which the server-side tracer wrote an older full snapshot containing `stream_completed`. That blind replacement removed the browser timestamp and caused the subsequent `session_completed` transition to return 409 even though playback had succeeded.

## Design

Voice traces continue to use the existing per-user JSON store and single-process runtime. All full-snapshot writes and delta updates now share one process-wide session queue. A delayed snapshot is merged into the latest persisted trace with first-write-wins timestamps instead of replacing the file. Existing terminal traces are immutable, failures are unioned deterministically, and derived latency fields are recalculated from the merged event set.

API transition validation was moved into the same serialized read-modify-write operation as persistence. This removes the previous read-before-lock gap while preserving the existing validation rules and idempotent `session_completed` behavior.

## Architecture Change

Before:

```text
server tracer snapshot -> blind JSON write
browser event -> serialized read/update/write
                    ^ independent paths could overwrite each other
```

After:

```text
server tracer snapshot --+
                         +-> per-session queue -> read -> safe merge/update -> atomic JSON write
browser event -----------+
```

## Technical Implementation

- Added `mergeVoiceSessionTrace` in `src/lib/server/voice-qa/trace.ts` with persisted-first timestamp union, failure deduplication, terminal immutability, non-regressing `updatedAt`, and latency recomputation.
- Updated `src/lib/server/voice-qa/trace-repository.ts` so `write()` and `update()` share the same session queue. A private unlocked persistence method prevents recursive locking and deadlock.
- Added an in-lock validation callback to repository updates and moved browser trace transition validation into it in `src/app/api/voice/trace/route.ts`.
- Extended `src/lib/server/voice-qa/trace.test.ts` and `src/app/api/voice/trace/route.test.ts` with stale snapshot, concurrent writer, terminal protection, concurrent playback/completion, and completion idempotency coverage.

## Decision & Trade-offs

Persisted values win when the same event is received more than once. This prevents a delayed in-memory snapshot from changing an already observed timestamp. Missing events may still be appended while a trace is in progress. Once a terminal state is persisted, the complete trace remains immutable so late telemetry cannot make stored data disagree with the emitted terminal log.

The session queue is intentionally process-local. This matches the current single-process JSON-store requirement without introducing a database or distributed lock. It does not provide cross-process mutual exclusion if multiple web processes write the same trace directory.

## Validation

- Failure-first verification reproduced all three persistence defects before implementation: stale playback loss, concurrent full-snapshot loss, and terminal rollback.
- `npx vitest run src/lib/server/voice-qa/trace.test.ts src/app/api/voice/trace/route.test.ts`: passed, `2` files and `18` tests.
- `npm run lint`: passed (`next typegen` and TypeScript no-emit validation).
- No real Provider request, Pipeline run, deployment, commit, or push was performed.

## Limitations

Concurrency safety is limited to one Node.js process. A future multi-instance Next.js deployment sharing the same JSON directory would require a cross-process lock or transactional store. Event timestamps remain first-observation timestamps; this change does not attempt to reorder clocks or infer missing client telemetry.

## Next Steps

Rerun the controlled Streaming Voice smoke harness to confirm that `playback_started`, `stream_completed`, and `session_completed` coexist in one terminal trace. If production later uses multiple web instances, replace the process-local queue with a storage-level compare-and-swap or transactional persistence mechanism.

# 2026-07-23 - Sentence Commit Soft Boundary Hardening

## Background

A controlled real-Provider Streaming Voice run completed transport, structured-response validation, and citation validation, but a multi-sentence answer produced zero committed speech units and used the existing full-text TTS fallback. The retained structure showed that `SentenceCommitManager` treated the Chinese semicolon in `A；B。[E1]` as a hard sentence boundary. This created an unsupported `A；` unit even though the citation was attached to the complete compound sentence, and the existing whole-response safety rule correctly withheld every unit.

## Design

Sentence boundaries are now classified as hard or soft. `。`, `！`, `？`, their ASCII equivalents, valid sentence-final periods, and line breaks are hard boundaries. `；`, `;`, `，`, and `,` are soft boundaries: they remain inside the current sentence while more text follows, but an immediately attached valid citation can explicitly close the soft unit. A soft boundary never inherits support from response-level metadata or a later hard sentence.

The final commit result is also reduced to content-free diagnostics: total sentence units, committed units, missing sentence support, citation metadata mismatch, and units withheld because the response was not fully committable. These counters are attached to the QA streaming trace and logged without sentence text, citation IDs, support IDs, or Provider output.

## Architecture Change

Before:

```text
A；B。[E1]
-> hard split at ；
-> A； has no sentence-local citation
-> whole response withheld
-> legacy full-text TTS fallback
```

After:

```text
A；B。[E1]
-> keep the soft clause boundary inside one unit
-> validate [E1] against the unchanged allowlist and support metadata
-> one grounded sentence commit

any unsupported hard sentence or invalid citation
-> unchanged whole-response withholding
-> legacy full-text TTS fallback
```

## Technical Implementation

- Updated `src/lib/server/retrieval/qa-sentence-commit.ts` with explicit hard/soft boundary classification, newline hard boundaries, citation-closed soft units, and a deterministic content-free commit summary.
- Updated `src/lib/server/retrieval/qa-streaming.ts` with an optional backward-compatible `sentenceCommit` trace section and the requested snake-case structured log counters.
- Updated `src/lib/server/retrieval/ai-qa.ts` to attach diagnostics only after full answer validation and final sentence commit evaluation.
- Extended `src/lib/server/retrieval/qa-sentence-commit.test.ts`, `qa-streaming.test.ts`, and `ai-qa-streaming.test.ts` with semicolon, hard-boundary, uncertainty, invalid-citation, trace privacy, and end-to-end streaming commit coverage.

## Decision & Trade-offs

Evidence First was not relaxed. Citation allowlisting, exact support-ID validation, uncertainty wording, whole-response atomic commit, and the existing Voice legacy fallback remain unchanged. A semicolon followed directly by a valid local citation can still delimit an independently grounded unit; a semicolon followed by more text waits for the next hard boundary.

This preserves valid compound sentences but keeps citation granularity at the full compound-sentence level. The resolver does not infer whether a final citation supports only one side of a semicolon; that remains the responsibility of the unchanged Provider answer contract and evidence validator. Unknown brackets, invalid citations, and independent uncited hard sentences continue to fail closed.

## Validation

- Failure-first focused run: `2` files, `6` expected failures and `32` passing tests before implementation.
- Sentence boundary and trace unit regression after implementation: `2` files / `38` tests passed.
- Sentence Commit plus QA streaming integration: `3` files / `50` tests passed.
- Voice regression covering the adapter, Bridge, streaming optimizer, streaming TTS, browser audio queue, and NDJSON parser: `6` files / `93` tests passed.
- `npm run lint`: passed (`next typegen` and TypeScript no-emit validation).
- No full benchmark, real Provider request, long-recording Pipeline, Memory write, deployment, commit, or push was performed.

## Limitations

An independent uncertainty sentence without its own inline citation still produces `missing_sentence_support` and withholds the complete streaming response by design. The new counters identify that failure but do not repair or reinterpret it. Raw Provider deltas are still not retained, and this task did not rerun the real multi-sentence Provider smoke test.

## Next Steps

Use the new `QA_STREAM_TRACE` counters in the next controlled real-Provider smoke test to confirm that the retained multi-sentence shape changes from multiple units with `missing_sentence_support` to grounded compound-sentence commits. Keep the legacy full-text path as the fallback for any response that is not fully committable.

# 2026-07-23 - Streaming Regression Outcomes and Abort State Synchronization

## Background

The real Streaming Voice regression correctly streamed ordinary and lifecycle answers while deliberately withholding an unsupported uncertainty answer and using the safe full-text fallback. The evaluation harness still failed the complete run because it required every scenario to emit streaming audio. The same run also exposed a persistence split: browser cancellation made the Voice Trace terminal with `aborted/client_closed`, while the corresponding application VoiceSession remained `LISTENING`.

## Design

The harness now evaluates each scenario against an explicit expected outcome: `streaming_success`, `safe_fallback`, or `aborted`. Streaming-only assertions apply only to scenarios expected to stream; the uncertainty scenario must instead prove a reasoned, citation-preserving fallback with legacy playback.

VoiceSession cancellation uses a turn-scoped trace binding. Each active application session stores the current trace ID, and a cancellation releases the session to `IDLE` only when that trace still owns the turn. This makes duplicate abort delivery idempotent and prevents a delayed abort from an older trace from releasing a newer active turn.

## Architecture Change

Before:

```text
safe uncertainty fallback
-> zero streaming chunks
-> global streaming assertion fails

browser client_closed
-> Trace = aborted
-> VoiceSession may remain LISTENING
```

After:

```text
scenario + expected outcome
-> outcome-specific transport and playback validation

VoiceSession(activeTraceId) <-> Voice Trace(applicationSessionId)
-> matching abort releases turn to IDLE
-> mismatched stale abort is a no-op
```

## Technical Implementation

- Updated `scripts/validate-streaming-voice-e2e.ts` with expected/observed outcome classification, report version 2 outcome records, streaming-only assertions, safe-fallback playback validation, and cancellation session-state verification.
- Updated `src/lib/server/voice-qa/trace.ts` with an optional internal application VoiceSession association.
- Updated `src/lib/server/voice-qa/session-manager.ts` with active trace attachment, matching turn release, trace-scoped lifecycle transitions, and automatic trace clearing on `IDLE` or `CLOSED`.
- Updated `src/app/api/voice/qa/route.ts` to bind each Voice QA request to its trace and release an aborted request to `IDLE`.
- Updated `src/app/api/voice/trace/route.ts` so browser `client_closed` telemetry synchronizes the matching VoiceSession, including idempotent retries.
- Added regression coverage in the streaming E2E harness, VoiceSession manager, Voice QA route, and Voice Trace route tests.

## Decision & Trade-offs

`safe_fallback` is not a blanket allowance for fallback. It requires a completed answer, zero partially spoken streaming chunks, a recorded fallback reason, fallback audio playback, and the existing independent citation and uncertainty checks. `completed_with_errors` is not treated as a safe success.

An aborted VoiceSession returns to `IDLE` rather than `CLOSED`, preserving the short-term conversation for the next push-to-talk turn. The active trace comparison is the concurrency boundary: duplicate events can repair the same turn, while a stale trace cannot reset a newer turn or reactivate an already released turn through a late lifecycle callback.

## Validation

- Focused harness, VoiceSession, Voice Trace, Voice QA route, and browser Voice tests: `6` files / `97` tests passed.
- `npm run lint`: passed (`next typegen` and TypeScript no-emit validation).
- The full `npm test` command exceeded the `120` second execution limit and surfaced pre-existing failures in settings path tests, upload/settings routes, Daily Brief checkpoint tests, and Playwright test collection; none were in the modified Voice files.
- No real Provider request, Pipeline run, deployment, commit, or push was performed for this fix.

## Limitations

The cancellation synchronization relies on the single-process JsonStore serialization already used by VoiceSession. It does not add a cross-process lock for a future multi-instance web deployment. Existing historical traces without `applicationSessionId` remain readable but cannot retroactively synchronize their old VoiceSession.

## Next Steps

Run the next controlled real Streaming Voice regression and confirm the report records `streaming_success`, `streaming_success`, `safe_fallback`, and `aborted`, with the cancellation VoiceSession persisted as `IDLE`.

# 2026-07-23 - QA Provider Model Benchmark

## Background

The production QA path uses GPT-5.5, but there was no controlled way to compare
its latency and grounded lifecycle behavior with DS v4. A valid comparison
needed to hold the retained recording, question, Evidence, Agent prompt, and
final validation constant rather than comparing unrelated Provider demos.

## Design

A focused benchmark reuses the retained `long-recording-60m-v1` context and
five questions: q017, q018, q022, q034, and an ordinary same-day summary. The
schedule is seeded and counterbalanced across three rounds. Every run fixes
`answerMode=agent` and uses the production streaming QA path so TTFT is measured
without bypassing citation, lifecycle, unsupported, or response validation.

GPT and DS execute in short-lived child processes. Benchmark-only environment
mapping selects each runtime inside that child; `.env.local`, saved provider
settings, and the production default model are not written.

## Architecture Change

Before:

```text
retained QA context
-> one configured production QA model
-> no paired TTFT/quality comparison
```

After:

```text
same retained context + same question + same Agent prompt + same validation
-> seeded serialized pair
   -> GPT-5.5 streaming QA
   -> DS v4 streaming QA
-> Evidence/prompt integrity check
-> latency + citation + lifecycle + unsupported report
```

## Technical Implementation

- Added `benchmark/qa-provider-model/long-recording-60m.json` with the four
  focused regression questions and one normal summary question.
- Added
  `src/lib/server/evaluation/qa-provider-model-benchmark.ts` for scheduling,
  Evidence digest integrity, TTFT/generation/total aggregation, deterministic
  quality checks, progress writing, and report rendering.
- Added `scripts/benchmark-qa-provider-models.ts` and the
  `qa-provider:model-benchmark` npm script. Remote calls require both
  `--remote` and `RUN_QA_PROVIDER_MODEL_REMOTE_VERIFY=1`.
- Added `src/lib/server/evaluation/qa-provider-model-benchmark.test.ts` and
  `docs/qa-provider-model-benchmark.md`.
- Real reports were retained under
  `.data/evaluation/qa-provider-model-benchmark-v1/run-20260723-1213/`.

## Decision & Trade-offs

The benchmark uses `answerQuestionStream()` to obtain real TTFT while retaining
the same final QA validator. Raw token deltas remain quarantined. Final answer
text is retained only in the ignored evaluation report because the source is a
synthetic dataset and manual review is required.

GPT-5.5 used the configured OpenAI-compatible Responses route, while DS v4 used
the configured DeepSeek Chat Completions route. This avoids changing the
production provider abstraction, but means the result measures model plus
endpoint/wire behavior rather than model weights alone. No production default
was changed.

## Validation

- Focused benchmark/lifecycle/streaming tests: `3` files / `53` tests passed
  after expanding the deterministic rubric for concise negative answers and
  future-arrangement wording.
- `npm run lint`: passed (`next typegen` and TypeScript no-emit validation).
- `git diff --check`: passed; Git only reported the existing Windows
  LF-to-CRLF conversion warnings.
- Full `npm test`: `166` files / `1,437` tests passed, but the command was not
  green (`4` files, `8` tests, and one Playwright collection error failed).
  The failures were outside the new benchmark: Windows-vs-POSIX path
  expectations in provider/settings and upload route tests, an existing
  checkpoint heartbeat race/temporary rename failure, and Playwright being
  collected by Vitest.
- Real benchmark: `30/30` calls completed; `15/15` pairs had matching Evidence
  digests and prompt sizes; final citation validity was `15/15` for each model;
  no fallback occurred.
- GPT-5.5: median TTFT `5,060 ms`, median generation `8,193 ms`, median total
  `8,220 ms`, P95 total `11,691 ms`; q017/q018/q022/q034 all `3/3`.
- DS v4: median TTFT `5,089 ms`, median generation `5,780 ms`, median total
  `5,830 ms`, P95 total `22,299 ms`; q017/q018/q022 were `3/3`, q034 was `1/3`.
- The initial report rubric produced false negatives for valid q022/q034
  phrasings. The rubric was corrected and the existing captured answers were
  re-scored; no remote call was repeated.

## Limitations

The five-question synthetic set is intentionally narrow and cannot select a
global winner. DS v4 showed a lower median but a much longer tail and confused
confirmed future arrangements with completed commitments in two q034 runs.
Provider load, endpoint differences, and SDK retries remain part of the
measurement. Week/all Memory scopes were not tested.

## Next Steps

Keep GPT-5.5 as the unchanged production default. If DS v4 remains a candidate,
expand the lifecycle set and run both models through the same gateway/wire API
where available, then add human blind review before considering any model
selection change.

# 2026-07-23 - DS v4 Lifecycle Prompt Adaptation Validation

## Background

The GPT-5.5 versus DS v4 Provider benchmark found that DS v4 passed q034 only
`1/3` times while GPT-5.5 passed `3/3`. The follow-up needed to distinguish a
prompt-adaptation problem from a broader lifecycle reasoning limitation without
changing the production model, Retrieval, Agent QA, or validation path.

## Design

The retained `long-recording-60m-v1` q034 question was executed six times
against `deepseek-v4-flash`. Three requests used the current resolved Agent
prompt. Three used the same prompt plus five explicit rules distinguishing a
commitment, schedule, or confirmed arrangement from actual completion. Calls
were serialized and interleaved as current/enhanced, enhanced/current,
current/enhanced.

The benchmark freezes the resolved base prompt and rejects the experiment if
the retained context changes, Evidence digests differ, or the new Evidence
digest no longer matches the prior model benchmark.

## Architecture Change

Before:

```text
q034 + fixed retained context
-> current DS Agent prompt
-> observed lifecycle instability
```

After:

```text
q034 + fixed retained context + unchanged Retrieval/validation
-> current DS prompt (3 calls)
-> current DS prompt + lifecycle rules (3 calls)
-> Evidence integrity gate
-> automated rubric + manual semantic review
```

This is an evaluation-only branch. The production QA data flow is unchanged.

## Technical Implementation

- Extended
  `src/lib/server/evaluation/qa-provider-model-benchmark.ts` with an
  evaluation-only system-prompt suffix and helpers for freezing the existing
  resolved prompt and Evidence digest.
- Added
  `src/lib/server/evaluation/ds-lifecycle-prompt-experiment.ts` for the fixed
  schedule, integrity checks, result aggregation, and report rendering.
- Added `scripts/evaluate-ds-lifecycle-prompt.ts` and the
  `qa-provider:ds-lifecycle-prompt` npm command. Real calls require both
  `--remote` and `RUN_DS_LIFECYCLE_PROMPT_REMOTE_VERIFY=1`.
- Added
  `src/lib/server/evaluation/ds-lifecycle-prompt-experiment.test.ts`.
- Added `docs/ds-v4-lifecycle-prompt-validation.md`.
- Retained the real report under
  `.data/evaluation/ds-v4-q034-prompt-adaptation-v1/run-20260723-1410/`.

## Decision & Trade-offs

The enhanced rules are appended through the existing internal
`qaPromptInstruction` input instead of changing the Agent prompt builder or
Provider contract. The current resolved prompt is preserved, so the only
intended model-input change is the system-prompt suffix.

The original q034 deterministic rubric was not changed. Manual review is
reported separately because the real answers exposed both false positives and
false negatives in its phrase matching. This preserves the requested validation
control while avoiding a misleading model conclusion.

## Validation

- Focused experiment and model benchmark tests: `2` files / `12` tests passed.
- `npm run lint`: passed (`next typegen` and TypeScript no-emit validation).
- Plan-only execution confirmed six interleaved requests and zero remote calls.
- Real execution completed `6/6` DS requests with one unchanged context digest,
  one unchanged Evidence digest, `6/6` valid citations, and zero fallback.
- The Evidence digest matched the previous q034 DS benchmark:
  `5f353545dd5dc7ac2a5a63a92810aa799bd46f2e59c764e1e9f210a178ef7af8`.
- Unchanged automated rubric: current `2/3`, enhanced `1/3`.
- Targeted manual rule compliance (“planned/confirmed is not completed”):
  current `0/3`, enhanced `3/3`.
- Fully clean latest-state lifecycle answers: current `0/3`, enhanced `1/3`.
- Mean total latency was `8,804 ms` for current and `10,625 ms` for enhanced;
  the three-sample result is descriptive only.
- No production default, `.env.local`, Memory, Retrieval, Agent QA, or Provider
  configuration was changed.

## Limitations

Three samples per prompt are not statistically conclusive. The enhanced prompt
fixed the narrow commitment-versus-fulfillment wording, but two responses still
retained the early “pottery lookup incomplete” state after later Evidence
showed the reservation was submitted, paid, and confirmed. The current q034
rubric also cannot detect all contradictory state claims and rejects some valid
uncertainty phrasings.

## Next Steps

Keep DS v4 experimental and keep the production default unchanged. Before any
model promotion, pre-register a contradiction-aware lifecycle evaluation that
checks every claimed event state, then run a larger blinded set covering
pending-to-resolved transitions and aggregate commitments.

# 2026-07-23 - Compact Evidence View Shadow Mode

## Background

Real GPT-5.5 context measurements showed that Evidence occupied roughly
`70%–80%` of the QA prompt, with Audio Insight metadata as the largest source.
The first implementation step needed to measure a deterministic compact view
without changing the production Provider request, Evidence selection, citation
mapping, lifecycle reasoning, or support IDs.

## Design

The shadow layer receives the already ranked canonical Evidence packet and
creates a one-to-one prompt projection. Version 1 only projects `audio` and
`audio_emotion` items. It copies the existing interaction label, summary, and
evidence fields while omitting pace, volume, pause, detailed acoustic features,
and repeated metadata. It does not call an LLM, rewrite text, add facts, merge
items, reorder `E#` labels, or generate source IDs.

Any Audio item with an ambiguous layout or user correction remains unchanged.
For lifecycle queries, the projected item must preserve both the existing
lifecycle state and topic overlap. A failed invariant falls back to the
canonical item. Shadow failures and logger failures are isolated from QA.

## Architecture Change

Before:

```text
Canonical Top-16 Evidence
-> original Evidence prompt
-> QA Provider
```

After:

```text
Canonical Top-16 Evidence
|-> deterministic Compact Evidence View
|   -> invariant audit + content-free shadow metrics
|
`-> original Evidence prompt
    -> QA Provider
```

The compact branch is observational only. Both synchronous and streaming QA
continue to send the original canonical Evidence prompt.

## Technical Implementation

- Added `src/lib/server/retrieval/evidence-compression/types.ts` for the
  canonical projection input, `CompactEvidenceView`, lifecycle audit, and
  aggregate shadow result.
- Added `src/lib/server/retrieval/evidence-compression/projection.ts` for
  deterministic Audio field extraction, exact prompt-size accounting, stable
  citation/source mapping, and lifecycle fail-closed behavior.
- Added `src/lib/server/retrieval/evidence-compression/shadow.ts` for
  content-free `EVIDENCE_COMPRESSION_SHADOW` metrics and fail-open logging.
- Added
  `src/lib/server/retrieval/evidence-compression/projection.test.ts`.
- Updated `src/lib/server/retrieval/ai-qa.ts` to observe the same canonical
  Evidence used by synchronous and streaming QA.
- Updated `src/lib/server/retrieval/ai-qa.test.ts` to prove that the Provider
  still receives low-level original Audio metadata while the shadow view reports
  a smaller projection.

## Decision & Trade-offs

The projection is intentionally extractive and deterministic. This produces
less compression than an abstractive model, but adds no Provider call and keeps
the facts auditable. `E#`, canonical Evidence IDs, timestamps, and
`sourceSegmentIds` remain a one-to-one server-side mapping. The compact view is
never used to construct citations, sentence support IDs, Memory, or persisted
QA output.

User-corrected Audio items are not compressed in this version because dropping
a correction would be more dangerous than losing a small amount of compression.
Non-Audio Evidence remains byte-for-byte unchanged.

## Validation

- `npm run lint`: passed.
- Focused QA, streaming, lifecycle, sentence-commit, and projection tests:
  `5` files / `121` tests passed.
- Offline retained `long-recording-60m-v1` evaluation used the same source and
  canonical Evidence digests as the real Provider benchmark and made no remote
  API calls.
- q017: `16` Evidence items, including `9` Audio items; Evidence characters
  changed from `9,050` to `4,972` in shadow (`45.06%` reduction). The estimated
  whole request would change from `11,078` to `7,000` characters (`36.81%`) if
  the compact view were enabled.
- q034: `16` Evidence items, including `4` Audio items; Evidence characters
  changed from `5,447` to `3,280` in shadow (`39.78%` reduction). The estimated
  whole request would change from `7,467` to `5,300` characters (`29.02%`) if
  enabled.
- Both retained questions preserved citation order, canonical Evidence digest,
  source IDs, and lifecycle state. All Audio items projected without fallback.
- The full `npm test` run was not green: `167/172` files and `1450/1459` tests
  passed. The `9` failures were outside this change and included Windows path
  expectations, a Playwright spec collected by Vitest, checkpoint timing/state,
  a fixture timeout, and a SQLite cleanup lock.

## Limitations

This is a shadow measurement, not a Provider latency benchmark. No compact view
has been sent to GPT-5.5, so answer quality, TTFT, and generation latency gains
remain unverified. The projection parser currently relies on the established
Audio Evidence labels. User-corrected or structurally ambiguous items fall back
to original text. State/topic equality reduces lifecycle risk but is not a full
semantic-entailment proof.

## Next Steps

Run a counterbalanced, evaluation-only A/B using the same questions, canonical
Evidence digests, model, validation, and citations. Require no lifecycle,
unsupported, owner-attribution, citation, or fallback regression before
considering a guarded Provider-facing compact mode.

# 2026-07-23 - Compact Evidence A/B Benchmark

## Background

The Compact Evidence shadow run reduced retained q017 Evidence by about `45%`
and q034 Evidence by about `40%`, but had not tested real Provider latency or
answer quality. This task compared canonical and compact Evidence prompts on
the retained `long-recording-60m-v1` data while keeping the model, Provider,
system prompt, question, retrieval result, Agent QA strategy, final validation,
and canonical citation/source mapping unchanged.

## Design

The benchmark uses seven fixed questions: q017, q018, and q034 for lifecycle
reasoning; q025 and q026 for stable food/environment preferences; q022 for
grounded unsupported handling; and q012 for the shared communication rule.
Each question runs three serialized rounds. Question order is deterministically
shuffled and the Original/Compact execution direction alternates by round.

The runner is plan-only by default. Real calls require both `--remote` and
`RUN_COMPACT_EVIDENCE_AB_REMOTE_VERIFY=1`. It writes an append-only progress
log and atomic partial report after every request. The Provider-facing
evaluation seam defaults to canonical Evidence; production callers do not set
it. Compact failure is recorded directly and is never hidden by a canonical
rerun.

## Architecture Change

Before:

```text
Canonical Evidence
-> production QA prompt
-> Provider
```

After:

```text
Canonical Evidence + unchanged validation allowlist
|
+-> Original benchmark arm -> canonical Evidence prompt -> Provider
|
`-> Compact benchmark arm  -> compact Evidence prompt   -> Provider
                              |
                              `-> canonical citation/source validation
```

Production QA continues to use the canonical branch. The added switch is
evaluation-only and does not change Memory, Retrieval, lifecycle resolution, or
the default model.

## Technical Implementation

- Added `benchmark/evidence-compression/long-recording-60m.json`.
- Added `src/lib/server/evaluation/compact-evidence-ab.ts` and its tests for
  scheduling, pair integrity, quality checks, streaming outcome, progress,
  report rendering, and offline report rescoring.
- Added `scripts/benchmark-compact-evidence.ts` and the
  `compact-evidence:benchmark` npm command.
- Updated `src/lib/server/retrieval/ai-qa.ts` with an optional evaluation
  Evidence view. Final answer validation and citation mapping still consume
  canonical Evidence.
- Updated `src/lib/server/retrieval/ai-qa-streaming.test.ts` to verify that only
  the Evidence block changes and neither benchmark arm emits the shadow logger.
- Extended the aggregate lifecycle evaluator with the real q034 grounded
  phrases "no evidence shows everything was done" and "cannot count as
  completed". This corrected a scorer false-negative without changing QA
  prompts or production validation.
- Added safe union-based pair counting, trace-first fallback attribution, a
  shared schedule digest, conservative gray criteria, shared-quality-failure
  reporting, and a no-network `--rescore-existing` mode.
- Generated `docs/compact-evidence-ab-results.md`. The retained raw report is
  under `.data/evaluation/compact-evidence-ab-v1/`.

## Decision & Trade-offs

The compact arm changes only Provider input serialization. Canonical Evidence
remains the authority for citations, support IDs, lifecycle state, and
SentenceCommit. This preserves Evidence First at the cost of retaining the
canonical packet in server memory.

Tokens are estimated as `ceil(characters / 2)` because the Provider did not
return input-token usage. Three rounds reduce variance but create a per-question
`2:1` execution-direction split, so order and round effects remain partly
confounded. The original arm emitted one content-free shadow log during the
captured run; that local instrumentation asymmetry was removed afterward and is
disclosed rather than hidden.

The first automatic report marked one q034 Compact answer as a lifecycle
regression. Manual review showed that answer and an Original answer used two
unrecognized but correct uncertainty phrasings. The scorer was fixed and the
same 42 saved answers were rescored offline with zero new Provider calls.

## Validation

- Real GPT-5.5/OpenAI-compatible execution: `42/42` completed, `21/21` pair
  integrity, zero whole-answer Provider/validation fallback, and zero compact
  projection fallback.
- Mean Provider input: Original `8,526` characters / estimated `4,263` tokens;
  Compact `6,158` characters / estimated `3,079` tokens (`27.77%` reduction).
- Mean TTFT: Original `6,824 ms`; Compact `7,030 ms`.
- Mean generation: Original `9,620 ms`; Compact `9,646 ms`.
- Mean total: Original `9,654 ms`; Compact `9,679 ms`.
- Paired total delta (`Compact - Original`): mean `+25 ms`, median `+186 ms`,
  approximate 95% CI `[-870, +920] ms`, exact sign-flip `p=0.9550`.
- Citation and canonical source-ID validity: `42/42`.
- Lifecycle: Original `9/9`, Compact `9/9`.
- Grounded unsupported: Original `3/3`, Compact `3/3`.
- Verified Compact-specific deterministic quality regressions: `0`.
- Streaming success: Original `9/21`, Compact `13/21`; one q026 pair moved in
  the opposite direction.
- q025, q026, and q012 failed in both views because shared retrieval/coverage
  omitted the required stable preference or full three-state rule Evidence.
- `npm run lint`: passed.
- Focused evaluation, streaming, projection, lifecycle-retrieval, and
  SentenceCommit tests: `6` files / `104` tests passed.
- Plan-only and final report schedule digests both resolve to
  `352047f6edd54d5c3fc761e09cc22cad85896b7064e8a05e9093ef4ed0454a95`.

## Limitations

The benchmark did not establish an overall latency improvement: mean TTFT,
generation, and total latency were each slightly slower and their paired
intervals crossed zero. The lifecycle subset showed a directional total-latency
improvement of about `9.8%`, but the sample is too small to treat as causal.

The retained current-scope run used zero long-term Memory-context entries.
Owner-boundary validation was therefore limited to rejecting invented
local-speaker-to-global-identity mappings. Preference and relationship quality
checks are deterministic fixture-specific coverage rules, not an LLM judge.
q025/q026/q012 remain shared Retrieval/coverage limitations rather than
Compact-specific regressions.

## Next Steps

Do not enable Compact Evidence in production gray yet. First fix and verify the
shared preference and communication-rule retrieval coverage. If another A/B is
run, use an even number of counterbalanced rounds, keep both arms free of
shadow logging, and pre-register a larger lifecycle subset to test the
directional latency signal without changing the production default.

# 2026-07-23 - Sentence Commit v2 and Text QA Streaming

## Background

The first streaming implementation exposed Provider token deltas but waited for
the complete structured answer before validating and committing sentences. As a
result, Voice TTS and the ordinary text QA UI could not use the first grounded
sentence while the Provider was still generating later content.

This change adds sentence-level early commit without weakening Evidence First.
It also brings validated sentence streaming to the ordinary QA panel while
keeping the existing complete-answer path as the fallback and final authority.

## Design

`SentenceCommitManager` now incrementally inspects the partial structured
response, detects complete answer sentences, extracts their citation IDs, and
maps those IDs back to the canonical Evidence allowlist. A provisional sentence
is released only when its citations, canonical source mapping, lifecycle state,
owner boundary, and production response policy all pass deterministic checks.

Raw Provider tokens remain quarantined. They are never sent to TTS or rendered
in the browser. Unsupported and assistant-metadata responses remain final-only
because their safety depends on complete response metadata.

Text QA and Voice QA consume the same grounded sentence events. Text transport
uses a strict NDJSON protocol; Voice passes the same events through the existing
voice response optimizer and streaming TTS queue.

## Architecture Change

Before:

```text
Provider token stream
  -> complete JSON
  -> whole-answer validation
  -> SentenceCommit v1
  -> Voice TTS
```

After:

```text
Provider token stream
  -> partial JSON answer buffer
  -> sentence boundary + citation extraction
  -> canonical Evidence / policy validation
  -> grounded sentence event
  -> Text UI append or Voice optimizer / streaming TTS

complete JSON
  -> whole-answer validation
  -> final answer replacement / persistence
  -> legacy full-answer fallback when required
```

## Technical Implementation

- Extended `src/lib/server/retrieval/qa-sentence-commit.ts` with provisional
  sentence validation, incremental draining, canonical cited segment IDs, and
  safety-boundary withholding.
- Extended `src/lib/server/retrieval/ai-qa.ts` to release grounded sentences
  during Provider generation while retaining the complete-answer validator,
  persistence behavior, and `answerQuestionWithAI()` fallback.
- Extended `src/lib/server/retrieval/qa-streaming.ts` with
  `first_sentence_candidate` and `first_sentence_validated` trace timestamps and
  latency fields.
- Added `src/lib/qa-browser-stream.ts` and
  `src/lib/client/qa-ndjson-stream.ts` for the strict server/browser NDJSON
  protocol and parser.
- Added `src/lib/server/retrieval/text-qa-stream.ts` and streaming response
  branches in the current-upload and context QA routes.
- Updated `src/components/qa-panel.tsx` and `src/app/page.tsx` so server-backed
  text QA appends validated sentences, handles abort/error state, and replaces
  provisional UI content atomically with the final validated answer.
- Updated `src/lib/server/voice-qa/adapter.ts` and
  `src/lib/server/voice-qa/bridge.ts` so the Voice path consumes early grounded
  sentences and starts streaming TTS before the complete QA result when safe.
- Added or extended focused tests for incremental sentence safety, lifecycle and
  owner boundaries, protocol ordering, UI append/final replacement, Voice early
  audio, cancellation, and fallback.
- Updated `docs/qa-sentence-streaming-commit.md` and marked the Phase 1 streaming
  document as historical.

## Decision & Trade-offs

Chinese and English hard sentence terminators are eligible for early commit.
The Chinese semicolon remains citation-aware rather than an unconditional hard
boundary so `A；B。[E1]` is validated as one supported unit, preserving the
previous real-provider regression fix.

An early sentence cannot be revoked after it has been spoken. Therefore the
provisional validator is intentionally stricter than display-only token
streaming: any citation mismatch, lifecycle promotion, owner promotion, weak
Evidence overlap, or response-mode uncertainty keeps the sentence quarantined
until final validation.

The final answer remains authoritative for persistence and UI history. This
avoids storing a partial response if a later sentence fails. Browser local-first
QA retains the existing non-streaming path because it does not use the server
streaming endpoint.

## Validation

- `npm run lint`: passed.
- Focused aggregate regression: `13` files / `260` tests passed.
- This includes Sentence Commit v2, QA streaming, browser NDJSON protocol,
  text-stream orchestration, QA panel, page integration, Voice QA bridge,
  streaming TTS, response optimization, and trace coverage.
- `npm run build`: passed; Next.js production compilation, type checking, page
  generation, and build trace collection completed successfully.
- `git diff --check`: passed.
- Full `npm test`: `1,481/1,490` tests passed. Nine unrelated full-suite
  failures remain: Windows-vs-POSIX path assertions, Playwright collection by
  Vitest, a fixture replay timeout/SQLite cleanup lock, and existing
  checkpoint lease/cache timing assumptions. No failing assertion was in the
  Sentence Commit, text streaming, Voice streaming, citation, or UI paths.
- No real Provider latency run was performed for this implementation. The
  change establishes the early-release architecture and trace points, but does
  not claim a measured production latency reduction.

## Limitations

Incremental parsing currently depends on the answer field and inline citation
IDs appearing early enough in the structured stream. `unsupported` and
assistant-metadata modes intentionally wait for final validation.

The first text-render trace is a content-free browser event; it is not yet
persisted as a server trace. Local-first browser QA remains full-response only.
Whole-answer validation can still reject a later sentence after earlier safe
sentences have been shown or spoken; the invalid suffix is withheld and is not
persisted, but an already emitted safe prefix cannot be withdrawn.

The existing unrelated full-suite environment failures were recorded but not
changed as part of this scoped task.

## Next Steps

Run a controlled real Provider comparison to measure question-to-first-visible
sentence and speech-end-to-first-audio latency against the complete-answer
fallback. Add server correlation for `first_text_render` if cross-process trace
persistence is required, and separately repair the pre-existing Windows/full
suite test isolation issues without changing the QA streaming safety boundary.

# 2026-07-24 - Voiceprint Adapter Integration

## Background

The Speaker Identity layer already separated chunk-local speaker labels from
optional global identity metadata, but its Voiceprint HTTP client was only an
isolated skeleton. There was no authenticated train/save workflow, no durable
operation status, and no safe path from an explicit contact confirmation to the
existing manual mapping consumed by the resolver.

The provider document defines `voiceprint/train` and `voiceprint/save` as
status-only APIs. It does not define a standalone identify endpoint or return
voice embeddings, identity confidence, or a voiceprint ID.

## Design

The implementation keeps Voiceprint as an adapter and explicit-confirmation
layer. Training is scoped to the authenticated user. Contact binding requires a
selected upload, TranscriptChunk, local speaker label, and contact name.

Provider success is recorded before a local operation is reported as complete,
but a contact profile and mapping are never created when the Provider rejects
the request. Operation records contain only status, request ID, counts, bounded
error categories, and non-sensitive result metadata. Audio URLs, time ranges,
audio bytes, embeddings, response bodies, and raw voiceprint material are not
persisted.

## Architecture Change

Before:

```text
Voiceprint HTTP skeleton
  -> no authenticated workflow
  -> no operation record
  -> injected resolver hints only
```

After:

```text
Authenticated user action
  -> Voiceprint Adapter (train/save)
  -> bounded operation metadata
  -> known-user profile or confirmed contact profile + manual mapping
  -> existing Speaker Identity Resolver
  -> optional TranscriptSegment identity metadata
```

No mapping evidence still resolves to `unknown_person`. Training success alone
does not assign `speaker_0`, `speaker_1`, gender, order, or speaking style to the
current user.

## Technical Implementation

- Hardened `src/lib/server/speaker-identity/voiceprint-client.ts` with bounded
  timeouts, safe network/HTTP error categories, retryability metadata, and a
  configuration factory that uses `VOICEPRINT_BASE_URL` or the existing
  `SPEAKER_ASR_BASE_URL`.
- Added
  `src/lib/server/speaker-identity/voiceprint-operation-repository.ts` using the
  existing user-scoped JsonStore style.
- Added `src/lib/server/speaker-identity/voiceprint-service.ts` for first or
  incremental user training, idempotent contact save, the ten-contact boundary,
  and Provider-success-before-mapping ordering.
- Added authenticated Node routes:
  `/api/speaker-identity/voiceprint/train` and
  `/api/speaker-identity/voiceprint/save`. The save route validates that the
  selected local speaker exists in the selected retained TranscriptChunk.
- Added exact provider-label projection from saved `voiceprintSpeakerId` values
  into resolver hints. Ambiguous duplicate labels fail closed, and generic
  `speaker_N` labels never become contact names.
- Extended internal identity metadata with `known_user` while preserving the
  local `speaker` field. Existing `known_contact` and conservative
  `unknown_person` behavior remain intact.
- Added `VOICEPRINT_BASE_URL` and `VOICEPRINT_TIMEOUT_MS` documentation to
  `.env.example`; no credential or undocumented authentication header was
  introduced.
- Added adapter, repository, service, route, resolver, domain schema, and Memory
  owner boundary tests.

## Decision & Trade-offs

The formal train example uses `audio: [{url, rule}]` even though one prose line
calls the input `audio_urls`; the adapter follows the formal JSON contract.
Training accepts one current recording or current plus one historical recording.

The save operation remains a `manual_mapping` for the selected recording
because the identity was confirmed by the user. For later recordings, an ASR
speaker label is accepted as Voiceprint evidence only when it exactly matches
one unique `voiceprintSpeakerId` saved in the authenticated user's profile
store. The fixed `0.9` confidence is a local trust-policy value for that exact
identifier match, not a claimed Provider confidence score.

Successful user training creates a `known_user` profile but does not attach it
to any TranscriptSegment without explicit identity evidence. This preserves the
Memory Owner Attribution boundary while allowing future provider-confirmed hints
to represent the current user correctly.

## Validation

- `npm run lint`: passed.
- Voiceprint/Speaker/transcription/domain/owner focused run: `9` files / `70`
  tests passed.
- Lifecycle, Memory, QA, Sentence Commit, streaming TTS, and Voice QA regression:
  `10` files / `201` tests passed.
- Full `npm test`: `176` files passed and `3` failed; `1,500/1,506` tests passed.
  The six failures are pre-existing Windows-vs-POSIX path assertions and
  Playwright collection by Vitest. No Voiceprint, Speaker Identity, Memory
  Owner, Lifecycle, QA, or Voice streaming test failed.
- No real Voiceprint API call was performed. Provider behavior was validated
  with injected mock HTTP responses only.

## Limitations

The documented provider returns only `code/message`; it does not return a
voiceprint ID, match confidence, or standalone identify result. Cross-recording
identity currently relies on an exact match between a later ASR speaker label
and a uniquely saved Provider speaker identifier. If the real ASR service
returns a different opaque ID or only `speaker_N`, the resolver remains unknown.

A contact save persists the current chunk mapping and is consumed the next time
the identity resolver runs. It does not rewrite an already completed transcript,
Memory, Relationship, or QA result. JSON persistence cannot provide a
cross-Provider/local-store transaction; a Provider success followed by local
persistence failure is recorded as a bounded persistence failure when possible.

## Next Steps

Run a controlled synthetic-audio contract verification against the real
Voiceprint service before enabling the routes in a user-facing UI. Confirm what
speaker identifier and confidence, if any, later ASR/diarization responses
return after `save`, then add an explicit response-to-VoiceprintHint adapter
without inferring identity from local speaker numbers.

# 2026-07-24 - Voiceprint Adapter Workflow Hardening

## Background

The first Voiceprint adapter pass implemented the documented `train` and `save`
calls, but review found four deterministic workflow risks: the public train
route accepted arbitrary URLs, contact save used the TranscriptChunk ID instead
of the AudioChunk `record_id` originally submitted to ASR, request reuse was not
bound to the same input, and Provider success could be followed by a local
write failure with no safe local-resume state.

This hardening remains limited to Voiceprint and Speaker Identity integration.
It does not change Memory schemas, Relationship Lifecycle, Sentence Commit,
Voice streaming, QA, or the long-recording Provider protocol.

## Design

The authenticated API now accepts user-owned upload references rather than
caller-provided audio URLs. It resolves each reference from the current user's
JsonStore and constructs the existing protected internal-audio URL on the
server. A client idempotency key is required and is transformed into a stable,
user-scoped Provider `req_id`.

Each operation is fingerprinted with a SHA-256 digest of its normalized input.
The workflow records `pending`, then `provider_succeeded`, and only then
`succeeded`. A retry after Provider success resumes profile/mapping persistence
without repeating the remote mutation. Same-process duplicate calls are
serialized, while changed input under the same request ID is rejected.

## Architecture Change

Before:

```text
Caller URL / optional request ID
  -> Provider train/save
  -> local profile + mapping
  -> succeeded or generic failure
```

After:

```text
Authenticated owned upload + required client request ID
  -> trusted internal audio URL + user-scoped Provider req_id
  -> pending operation with input digest
  -> Provider train/save
  -> provider_succeeded recovery marker
  -> profile/manual mapping
  -> succeeded
  -> existing resolver consumes exact, unambiguous Provider labels
```

## Technical Implementation

- Added `voiceprint-api-support.ts` for stable user-scoped Provider request IDs
  and server-owned training audio URL construction.
- Changed the train route input to `{uploadId, rule}` and rejected arbitrary
  caller URLs, missing uploads, unsafe store keys, excessive ranges, and ranges
  outside a known upload duration.
- Corrected contact `record_id` to `TranscriptChunk.audioChunkId`, matching the
  identifier submitted during Speaker ASR. The documented user-edited contact
  name remains the Provider `speaker_id`.
- Added bounded integer validation for at most two training recordings and at
  most 100 time ranges per recording.
- Added operation input digests, monotonic terminal-state protection,
  process-local read/write serialization, same-request workflow serialization,
  and resumable `provider_succeeded` persistence.
- Operation records continue to exclude audio URLs, time ranges, audio bytes,
  transcripts, embeddings, and Provider response bodies.

## Decision & Trade-offs

Requiring a client request ID makes caller retries deterministic. The Provider
receives a stable hash scoped to the authenticated user, so two accounts using
the same client value do not collide and neither raw identifier is exposed in
the Provider request ID.

Training still uses the project's existing internal-audio bearer URL because
that is the currently deployed ASR delivery mechanism. Replacing it with a
per-resource expiring signature would require a separate cross-cutting change
to the internal audio gateway and Speaker ASR URL builder.

The `provider_succeeded` state prevents a known successful remote call from
being repeated solely because a profile or mapping write failed. It cannot make
the remote HTTP mutation and JsonStore write atomic, and the in-memory locks do
not provide multi-process compare-and-swap.

## Validation

- `npm run lint`: passed; Next route type generation and TypeScript validation
  completed without errors.
- Voiceprint adapter, API support, operation repository, workflow, and route
  tests: `5` files / `31` tests passed.
- Speaker Identity, transcript integration, Memory Owner, Lifecycle Retrieval,
  Sentence Commit, streaming TTS, and Voice QA regression: `14` files / `206`
  tests passed.
- The offline evaluator CLI was not run against retained data because it
  requires explicit `--data-dir`, `--upload-id`, and non-runtime `--report`
  arguments. An argument-less invocation failed closed before reading or
  writing artifacts.
- No real Voiceprint API call was made; all Provider tests used controlled mock
  responses.

## Limitations

The Provider document does not establish whether `req_id` deduplicates an
ambiguous timeout after remote success. A network timeout is therefore recorded
as retryable, but an explicit retry could repeat a remote operation if the
Provider does not enforce idempotency.

JsonStore and the workflow locks guarantee the tested single-process behavior,
not cross-process atomicity. A process crash while an operation is `pending`
requires manual reconciliation; no stale-operation lease or Provider status API
is documented.

The internal audio gateway uses an account-wide static query token inherited
from the existing Speaker ASR integration. It is not logged or persisted by the
Voiceprint layer, but a future security task should replace it with an
HTTPS-only, expiring signature scoped to user, upload, purpose, and expiry.

Train/save return only `code/message`. Exact later-ASR-label matching and its
fixed local trust-policy confidence remain an integration assumption until a
controlled synthetic-audio Provider test confirms the returned speaker label.

## Next Steps

Run a controlled real-API contract test with synthetic voices. Confirm Provider
idempotency, post-save ASR labels, cross-recording stability, and whether any
confidence or opaque identity ID is returned. Before multi-process deployment,
add durable create-if-absent/CAS or a lease/reconciliation mechanism for
`pending` operations and replace the shared audio token with a scoped expiring
signature.

# 2026-07-24 - Cross-recording Voiceprint Continuity Integration Test

## Background

The speaker identity components had separate tests for contact saving, exact
voiceprint-label hints, and conservative ambiguity handling, but no integration
test joined those seams across two recordings.

## Design

Add an isolated Vitest integration test that uses a shared real `JsonStore`,
`JsonSpeakerIdentityRepository`, `JsonVoiceprintOperationRepository`,
`VoiceprintService`, and the real identity resolver. Recording B's local speaker
label represents the documented provider diarization seam; it does not simulate
or claim acoustic recognition.

## Architecture Change

Before: component tests independently covered manual save, hint loading, and
resolution. After: one test verifies the persisted profile created from
recording A is consumed as exact provider-label evidence for recording B, while
a second test verifies duplicate provider labels fail closed.

## Technical Implementation

Added
`src/lib/server/speaker-identity/voiceprint-continuity.integration.test.ts`.
The positive case saves recording A's `speaker_1` as `contact_alice`, supplies
`Alice` as recording B's provider diarization label, loads hints through the
real repository, and asserts a `known_contact` identity sourced from
`voiceprint`. The ambiguity case stores two legacy profiles with the same
provider label and asserts no hint and an `unknown_person` result.

## Decision & Trade-offs

The test stays offline and deterministic by using `InMemoryVoiceprintProvider`.
It validates the application integration contract but cannot validate a real
provider's acoustic matching or cross-recording label stability.

## Validation

`npx vitest run src/lib/server/speaker-identity/voiceprint-continuity.integration.test.ts`
passed 2/2 tests. A full TypeScript check was also attempted; after correcting
the new test's resolver input field, it remained blocked by pre-existing
`VoiceIdentityProfile.userId` incompatibilities in
`src/lib/server/speaker-identity/voiceprint-service.ts`.

## Limitations

No live Provider API, real audio, or actual diarization model is exercised. The
duplicate-label scenario represents legacy/corrupt persisted profiles because
normal service validation is expected to prevent creating that ambiguity.

## Next Steps

Run a controlled provider-backed two-recording evaluation with synthetic voices
and retain the provider response/audit artifacts without storing raw voice
material in identity metadata.

Validation follow-up: a later full TypeScript run, after concurrent workspace
changes, reported additional production-file errors in
`src/lib/server/speaker-identity/voiceprint-client.ts` involving the required
`attemptCount` result field and retry helper arguments. The integration test
itself remained 2/2 passing and no TypeScript diagnostic referenced the new test
file.

# 2026-07-24 - Voiceprint Provider Readiness Hardening

## Background

The first Voiceprint adapter phase covered the documented train/save payloads
with mocked Provider responses, but real-Provider readiness still needed a
bounded retry contract, full response deadlines, explicit profile lifecycle
metadata, conservative ambiguous-hint handling, and a cross-recording
integration seam.

## Design

Keep Voiceprint as an adapter around the existing Speaker Identity Resolver.
Mutating Provider attempts reuse one stable `req_id`, retry at most once, and
retry only transport/HTTP failures classified as transient. Persist only
bounded identity references and operation metadata. Treat missing, conflicting,
or ambiguous identity hints as unknown instead of choosing a likely person.

## Architecture Change

Before:

```text
train/save -> one HTTP attempt -> operation result
ASR label -> best direct hint -> identity
```

After:

```text
train/save
-> bounded response deadline and size
-> at most one retry with the same req_id
-> pending -> provider_succeeded -> succeeded | failed
-> active VoiceIdentityProfile reference

ASR diarization label
-> exact unique active profile hint
-> ambiguity checks
-> known_user | known_contact | unknown_person
-> read-only VoiceIdentityHint adapter
```

## Technical Implementation

- `voiceprint-client.ts` now validates and bounds the entire response read,
  classifies timeout/network/HTTP/Provider/malformed failures, caps response
  size, honors a bounded `Retry-After`, retries transient failures once, and
  records `attemptCount`.
- `voiceprint-operation-repository.ts` stores safe
  `providerAttemptCount` metadata while preserving the existing monotonic
  four-state operation workflow.
- `repository.ts` stores user-scoped `status`, `contactName`, and bounded
  Provider reference metadata. Disabled profiles do not create hints; legacy
  provider labels remain readable.
- `voiceprint-service.ts` persists complete known-user/contact profiles and
  upgrades previously completed local profiles without repeating a successful
  Provider operation.
- `types.ts` adds `VoiceIdentityProfile`, provider-reference/status types, and a
  read-only `VoiceIdentityHint` boundary. `identity-hint.ts` projects resolved
  identity metadata without changing Memory.
- `resolver.ts` requires an explicit known identity type on Voiceprint hints and
  fails closed when one local speaker has conflicting identities or two local
  speakers receive the same identity in one chunk.
- `voiceprint-continuity.integration.test.ts` joins recording A manual save to
  recording B's exact Provider label through the real JsonStore repository and
  resolver. It also covers duplicate-label ambiguity.
- `.env.example` documents the retry, delay, response-size, and timeout limits.
- `docs/voiceprint-provider-smoke-test.md` records the controlled synthetic
  two-recording real-Provider validation procedure.

## Decision & Trade-offs

The adapter retries only network errors, timeouts, HTTP 408/429, and 5xx. It
does not retry malformed 2xx responses, unknown Provider codes, or validation
failures. Every attempt reuses the same `req_id`; this prevents duplicate local
profiles and is the intended Provider idempotency key, but the supplied
documentation does not prove remote side-effect deduplication after an
ambiguous timeout.

Profile metadata intentionally retains only the account user ID, optional
contact name, status, Provider label/reference, operation type, and last request
ID. It does not store recordings, embeddings, acoustic features, transcripts,
or Provider-private voiceprint material.

The cross-recording test simulates the documented seam where later diarization
returns the saved label. It validates application wiring, not acoustic
recognition accuracy.

## Validation

- Speaker Identity, Voiceprint, ASR integration, domain identity, and Memory
  Owner boundary tests: `12` files / `93` tests passed.
- Authenticated Voiceprint API route tests: `1` file / `7` tests passed.
- Combined focused result: `13` files / `100` tests passed.
- `npm run lint`: passed, including Next route type generation and TypeScript.
- No real Provider request, production Pipeline run, Memory rewrite, commit,
  push, or deployment was performed.

## Limitations

- Real train/save response fields and cross-recording diarization labels remain
  unverified against the company service.
- Provider `req_id` remote deduplication semantics are undocumented; retrying an
  ambiguous timeout is still a Provider-side risk even though local state is
  idempotent.
- Workflow and JsonStore locks are process-local. Multi-process atomic
  create-if-absent/CAS and stale-pending reconciliation remain future work.
- Automatic matching currently requires the later ASR label to equal one
  unique active Provider label. No undocumented confidence or identity ID is
  inferred.
- Existing Memory items are not rewritten; the new hint is an adapter boundary
  for future owner attribution only.

## Next Steps

Run the documented controlled smoke test with two synthetic voices. Confirm
actual `code/message` behavior, request-ID deduplication, the saved speaker label
returned by a later diarization request, cross-recording consistency, and
whether the Provider exposes a stable opaque identity or confidence field.
Only then decide whether the exact-label hint adapter needs a contract-specific
extension.

Validation addendum: `git diff --check` passed. Git reported only existing
Windows LF-to-CRLF conversion warnings and no whitespace errors.

Final validation addendum: after adding the conflicting-identity-type
fail-closed regression, the combined focused suite passed `13` files / `101`
tests. `npm run lint` was rerun and passed.

# 2026-07-24 - Voiceprint Readiness Recovery Boundaries

## Background

A final readiness review found two integration gaps that component tests did
not expose. Standard ready uploads no longer retain their source audio, so a
train request could generate an internal URL that later returned 404.
Separately, a transient failure while saving the intermediate
`provider_succeeded` operation could leave an otherwise successful mutation
stuck at `pending`.

## Design

Do not change production audio retention or retain new Voiceprint audio.
Instead, verify that every user-owned training upload still has a readable file
before calling the Provider and return a specific conflict when it does not.
For operation recovery, continue local profile/mapping persistence after a
transient intermediate-checkpoint failure and treat the complete profile plus
manual mapping as a durable, request-bound Provider-success receipt.

## Architecture Change

Before:

```text
upload metadata -> generated audio URL -> Provider may receive a 404 URL
Provider success -> provider_succeeded write failure -> pending forever
```

After:

```text
owned upload -> safe path + retained file check -> Provider
missing cleaned audio -> voiceprint_training_audio_unavailable

Provider success
-> best-effort provider_succeeded checkpoint
-> request-bound profile/mapping receipt
-> succeeded
-> pending recovery without repeating Provider mutation
```

## Technical Implementation

- `voiceprint/train/route.ts` validates that each selected upload has a file
  under the authenticated user's upload root and that it still exists.
- Voiceprint route tests now cover two retained owned uploads and the standard
  cleaned-history rejection path.
- `voiceprint-service.ts` no longer abandons a successful Provider response
  solely because the intermediate operation checkpoint write failed. It
  continues bounded local persistence and can reconcile a matching `pending`
  operation from a complete profile/mapping whose Provider reference carries
  the same request ID.
- Service tests cover transient train checkpoint recovery and save recovery
  from a durable pending receipt without a second Provider call.
- The controlled smoke-test runbook now requires evaluation-retained synthetic
  uploads and documents the explicit unavailable-audio error.

## Decision & Trade-offs

The production Pipeline continues deleting ordinary source audio after success;
Voiceprint does not silently expand retention or create a second raw-audio
store. Historical incremental training is therefore supported only while both
selected upload files are explicitly retained and readable.

The profile/mapping receipt closes recoverable local-write and process-restart
gaps after that receipt exists. A crash immediately after remote success and
before any successful durable local write remains fundamentally ambiguous
without a Provider status endpoint or documented remote idempotency guarantee.

## Validation

- Combined Voiceprint, Speaker Identity, ASR integration, domain identity,
  Memory Owner boundary, and authenticated route suite: `13` files / `105`
  tests passed.
- `npm run lint`: passed, including Next route type generation and TypeScript.
- No real Provider call, production audio retention change, Memory mutation,
  commit, push, or deployment was performed.

## Limitations

- Ordinary ready uploads cannot be used later for Voiceprint training because
  their audio is intentionally deleted. Controlled real validation must use
  evaluation-retained synthetic uploads.
- Provider `req_id` deduplication and later diarization label behavior are still
  unverified.
- The remaining pre-receipt crash window and multi-process operation races need
  durable CAS/lease support or a Provider operation-status API.

## Next Steps

Execute the documented two-recording synthetic smoke test once credentials and
an HTTPS audio delivery URL are available. Verify audio fetchability before the
mutation, capture only safe response schema/status metadata, repeat the same
request ID to test remote idempotency, and then observe whether recording B
returns the saved contact label.

Final recovery validation addendum: a symmetric cross-request pending-train
recovery test was added. The final focused result is `13` files / `106` tests
passed, and the final `npm run lint` rerun passed.

# 2026-07-24 - Voiceprint Provider Controlled Smoke Test

## Background

The Voiceprint adapter, operation state machine, identity repository, and
Speaker Identity Resolver had only mock and offline coverage. This task added a
privacy-safe real-Provider smoke harness and attempted the documented
ASR/diarization -> train -> manual save -> later identity resolution flow with
Microsoft synthetic voices. The operator explicitly authorized requests to the
company development endpoint and temporary `*.trycloudflare.com` URLs, while
accepting that a successful synthetic voiceprint mutation might not be
remotely removable.

## Design

The evaluation is double-gated by `--remote` and
`RUN_VOICEPRINT_REMOTE_VERIFY=1`. It creates short 16 kHz mono PCM WAV samples
for two recurring synthetic speakers plus one unknown speaker, exposes them
through randomized paths on an ephemeral local server and quick tunnel, and
persists only redacted status/schema metadata. Real train/save retries are
forced to zero so an ambiguous network result cannot repeat a remote mutation.
Local fault injection separately verifies bounded retry and operation status
behavior without contacting the Provider.

Any terminal real-stage failure stops all later real stages. Raw Provider
responses, transcript text, audio URLs, audio files, embeddings, acoustic
features, credentials, and voiceprint-private data are excluded from reports.

## Architecture Change

Before:

```text
Voiceprint components -> mock/offline tests only
```

After:

```text
synthetic WAVs
-> ephemeral HTTPS delivery
-> ASR + diarization gate
-> voiceprint/train (at most one request)
-> manual voiceprint/save (at most one request)
-> later ASR label
-> JsonSpeakerIdentityRepository
-> Speaker Identity Resolver
-> redacted evaluation report
```

The production Pipeline, Memory, QA, Relationship, and Streaming Voice paths
were not changed.

## Technical Implementation

- `scripts/validate-voiceprint-provider-smoke.ts` generates the controlled
  Yaoyao/Kangkang/Huihui samples, starts a Range-capable temporary audio
  server, manages a quick tunnel, executes gated real stages, exercises local
  failure boundaries, writes unique reports, and removes all temporary audio.
- Quick-tunnel protocol was changed from HTTP/2 to QUIC after a safe diagnostic
  showed repeated Cloudflare edge TLS EOF errors on HTTP/2 and a successful
  QUIC registration.
- The local quick-tunnel preflight is diagnostic rather than authoritative
  because the current host times out when hairpin-accessing its own temporary
  domain. The remote ASR fetch remains the required gate before train/save.
- ASR completion now requires `speaker_result` whenever diarization is
  requested; a completed transcript alone no longer ends the polling loop.
- Tunnel cleanup now waits for a forced child termination and verifies process
  liveness before reporting success.
- `package.json` adds the `voiceprint:provider:smoke` command.
- The retained redacted result is under
  `.data/evaluation/voiceprint-provider-smoke-v1/run-2026-07-24-043232054/`.

## Decision & Trade-offs

The final controlled attempt stopped after recording A returned without
speaker labels. The harness did not proceed to train or save, so this run
created no remote synthetic voiceprint state. A later code review found that
the harness had treated a completed ASR transcript as completion before
diarization output was present. The completion predicate was fixed for future
validation, but the remote flow was not automatically uploaded again; the
current report therefore remains an incomplete real-Provider result rather
than an inferred success.

The local preflight relaxation does not bypass the remote safety boundary:
failure of the company ASR to fetch and diarize the randomized URL still stops
all state-changing Voiceprint operations.

## Validation

- Real attempt report:
  `run-2026-07-24-043232054/report.json`, SHA-256
  `e35bb17f44a13d5731bca58eb3061f70c8e24184ad509ee96dc416fc5937680d`.
- Recording A ASR/diarization: failed after `20019 ms` with
  `asr_missing_speaker_labels`.
- Real `voiceprint/train`: skipped; Provider call count `0`.
- Real `voiceprint/save`: skipped; Provider call count `0`.
- Later known-contact and unknown-speaker resolution: not run.
- Ambiguous identity fixture: passed fail-closed as `unknown_person`.
- Local failure injection passed: timeout retried once (`2` attempts), network
  error retried once (`2` attempts), malformed response was not retried
  (`1` attempt).
- Cleanup passed in the final attempt: temporary audio removed, local server
  stopped, tunnel stopped, and no residual cloudflared process remained.
- Voiceprint/Speaker Identity focused suite: `6` files / `62` tests passed.
- `npm run lint`: passed, including route type generation and TypeScript.
- No production Pipeline run, Memory mutation, commit, push, or deployment was
  performed.

## Limitations

- Real train/save response contracts, latency, and remote idempotency remain
  unverified because the diarization gate did not produce `speaker_result`.
- Known-contact resolution after save and a real unknown-speaker result remain
  unverified.
- The supplied API exposes no cleanup endpoint and no documented operation
  status endpoint.
- The host cannot locally hairpin to its own quick-tunnel URL even though the
  QUIC tunnel registers successfully.
- The corrected speaker-result polling behavior has local type/lint coverage
  but has not yet been rerun against the real Provider.

## Next Steps

Run one explicitly authorized follow-up with the corrected diarization polling
predicate. If `speaker_result` still does not arrive, retain the safe response
field/status sequence and verify whether the standalone diarization endpoint
must be used after ASR. Only after that gate succeeds should train/save and the
second-recording known/unknown identity cases be exercised.

# 2026-07-24 - Voiceprint Speaker Label Acquisition Diagnostic

## Background

The first controlled Voiceprint smoke stopped because combined non-realtime
ASR returned transcript data without usable `speaker_result`. Voiceprint train
and save were correctly skipped. Before any state-changing Voiceprint request
could be allowed, the evaluation harness needed to distinguish delayed
combined diarization, unsupported request parameters, insufficient audio, and
failure of the documented standalone diarization endpoint.

## Design

The smoke harness now has a hard `--diarization-only` mode. In this mode it
does not construct the real Voiceprint Provider or service, and train/save are
always reported as skipped with Provider call counts of zero.

Combined ASR uses the documented numeric `speaker` field and polls beyond
`asr_result` until `speaker_result` is non-empty. Once ASR sentences are ready,
a bounded 30-second speaker grace period applies. If combined diarization still
has no labels, the harness conservatively projects only the returned
`text + timestamp(s)` into the standalone diarization request and waits for
non-empty `data.result` or an explicit timeout.

Raw responses, transcript text, request/user IDs, audio URLs, and Provider
messages are not persisted. Diagnostics retain only request-field summaries,
HTTP/Provider codes, response field names/counts, label counts, source, and
latency.

## Architecture Change

Before:

```text
combined ASR
-> asr_result observed
-> speaker_result missing
-> smoke failure
```

After:

```text
70s synthetic two-speaker audio
-> combined ASR (speaker=2)
-> poll code=2
-> require non-empty speaker_result
   | success -> local labels ready
   | bounded absence
   v
standalone diarization
-> normalized timestamps
-> require non-empty data.result
-> diagnostic report

train/save: hard-disabled
```

## Technical Implementation

- `scripts/validate-voiceprint-provider-smoke.ts` now supports
  `--diarization-only`, uses a minimum 60-second two-speaker diagnostic sample,
  waits for actual speaker output, includes a standalone fallback, records
  bounded structural diagnostics, and exposes `nextVoiceprintTestReady`.
- The final recording A fixture has 12 alternating synthetic utterances and an
  actual duration of `70004 ms`.
- `src/lib/server/evaluation/voiceprint-diarization.ts` safely parses combined
  `data.speaker_result` and standalone `data.result`, validates ASR text/time
  inputs, maps `timestamp` or `timestamps` to the standalone contract, and
  emits response-shape summaries without content.
- `src/lib/server/evaluation/voiceprint-diarization.test.ts` covers label
  parsing, timestamp projection, missing/invalid inputs, empty results, and
  redacted shape summaries.
- `package.json` adds `voiceprint:diarization:smoke`.
- `docs/voiceprint-provider-smoke-test.md` documents the prerequisite
  diagnostic and its mutation boundary.

## Decision & Trade-offs

The supplied document is internally inconsistent: its parameter table uses
numeric `speaker`, while a later curl example uses
`speaker_diarization: true`. A real compatibility probe sending both
`speaker:2` and the boolean field returned Provider `code=1` after `3358 ms`.
The working request therefore uses only `speaker:2`; `-1` is not used because
the same document defines it as disabling speaker separation.

A `44920 ms` sample produced completed ASR sentences but an empty combined
`speaker_result`. After the new grace period, standalone diarization was
attempted and ended in Provider `code=1`, matching an older controlled
evaluation of that endpoint. A longer sample was selected based on the
existing successful approximately 61-second baseline. The final 70-second
sample returned combined speaker results, so standalone fallback was not
needed in the successful run.

The 60-second fixture floor is an evaluation reliability measure, not a claim
that the Provider formally requires 60 seconds.

## Validation

- Final real diagnostic:
  `.data/evaluation/voiceprint-provider-smoke-v1/run-2026-07-24-045632186/`.
- Combined ASR/diarization: success in `10343 ms`, with `4` query polls.
- Response structure: `6` ASR sentences, `4` speaker-result spans, `2` unique
  local labels.
- Speaker result source: `combined_asr`.
- ASR-ready latency: `10342 ms`; measured additional speaker wait: `1 ms`.
- Synthetic A/B mapping: established; `nextVoiceprintTestReady=true`.
- Voiceprint train Provider calls: `0`.
- Voiceprint save Provider calls: `0`.
- Final report SHA-256:
  `f6a6e2ad335a962f024a22ea4fb7440eaa71e2e12f7a2da1c1e2f7baf2edb80d`.
- Parameter compatibility failure report:
  `run-2026-07-24-045004444` (`asr_provider_code_1`).
- Short-sample/standalone failure report:
  `run-2026-07-24-045243050`
  (`standalone_diarization_provider_code_1`).
- Diarization/Voiceprint focused suite: `3` files / `37` tests passed.
- `npm run lint`: passed, including Next route type generation and TypeScript.
- Temporary audio, local server, and quick tunnel were removed/stopped; no
  residual cloudflared process remained.

## Limitations

- Standalone diarization remains unavailable for this controlled input and
  ends in Provider `code=1`; its raw error message was intentionally not
  retained.
- The successful result contains chunk-local `speaker_1/speaker_2` labels only.
  It exposes no confidence, embedding, voiceprint ID, or stable global
  identity.
- The observed duration sensitivity needs more controlled samples before it can
  be treated as a Provider characteristic.
- The host still cannot hairpin-access its own quick-tunnel URL, so remote ASR
  fetch remains the authoritative reachability check.
- The production Speaker ASR adapter has a separate early-completion boundary,
  but it was intentionally not modified in this harness-only task.

## Next Steps

The next Voiceprint smoke may start from the validated 70-second recording A
and its two local labels. Train/save must remain a separately authorized run.
That run should first verify the currently configured Voiceprint endpoint
availability, then perform at most one train and one manual save, and finally
test a second recording for known-contact, unknown, and ambiguous fail-closed
behavior.

# 2026-07-24 - Voiceprint Cross-record Smoke Attempt

## Background

After a successful speaker-label prerequisite diagnostic, a separately
authorized real-Provider smoke attempted to validate the complete synthetic
flow: recording A diarization, Voiceprint train, manual contact save,
recording B diarization, and conservative Speaker Identity resolution.

## Design

The existing evaluation-only full smoke was used with synthetic OneCore voices,
an ephemeral HTTPS quick tunnel, an isolated temporary JSON store, and
`VOICEPRINT_MAX_RETRIES=0`. Real train and save requests were each bounded to
one Provider call. Any failure before or during a state-changing operation
stopped all later remote stages.

Cross-record success was defined conservatively: recording B had to return the
saved alias `Alice` for the expected synthetic voice, and the repository and
resolver then had to produce a unique `known_contact` result. Fresh local
speaker labels, missing matches, and conflicts were not eligible for inferred
identity.

## Architecture Change

No production architecture changed. The attempted evaluation path was:

```text
synthetic recording A
-> combined ASR + diarization
-> train (maximum one Provider call)
-> manual save as Alice (maximum one Provider call)
-> different synthetic recording B
-> Provider label observation
-> Voice Identity Resolver
```

The run stopped at recording A diarization, before the first Voiceprint
mutation.

## Technical Implementation

No business or Provider adapter code was modified. The generated report is:

```text
.data/evaluation/voiceprint-provider-smoke-v1/run-2026-07-24-054612838/
```

It contains `report.json` and `report.md`. The report stores status, bounded
structural response diagnostics, latency, hashes, and cleanup state only. It
does not store audio, transcript text, audio URLs, embeddings, voice features,
raw Provider responses, credentials, or raw request/user identifiers.

## Decision & Trade-offs

The same 70-second fixture had previously produced two combined-ASR speaker
labels in about 10.3 seconds. In this full run, ASR text completed but
`speaker_result` remained empty throughout the 30-second grace period. The
documented standalone diarization fallback returned Provider `code=1`.

Because no Voiceprint mutation had yet occurred, train and save were both
skipped with Provider call count zero. The run was not automatically repeated:
this preserves the one-shot audit boundary and avoids hiding an intermittent
diarization failure behind retries.

## Validation

- Recording A duration: `70004 ms`; two synthetic voices; 12 utterances.
- Combined ASR stage: `42107 ms`, 17 polls, HTTP 200.
- ASR response: 6 sentences; combined speaker-result count remained zero.
- Terminal combined-ASR reason: `speaker_grace_timeout`.
- Standalone diarization: Provider `code=1`.
- Recording A total diagnostic latency: `55039 ms`.
- Voiceprint train Provider calls: `0`.
- Voiceprint save Provider calls: `0`.
- Recording B and unknown-speaker remote checks: skipped.
- Local ambiguous-match fixture: passed fail-closed as `unknown_person`.
- Local timeout/network/malformed-response failure boundaries: passed.
- Focused Voiceprint/Speaker Identity suite: `7` files / `70` tests passed.
- `npm run lint`: passed, including Next route type generation and TypeScript.
- Report JSON SHA-256:
  `5aac2eff2255d79cc2cb2b20eadc6069f1d7bf488c2492d9d3924176d129613a`.
- Temporary audio was removed; local server and quick tunnel were stopped; no
  residual cloudflared process remained.

## Limitations

- The requested train, save, and cross-record identity stages were not reached.
- Combined diarization is intermittent for the same synthetic 70-second input.
- The standalone diarization endpoint still returns only Provider `code=1` for
  this fallback request; the raw message is intentionally not retained.
- The real Provider exposes no standalone identify API, stable identity ID, or
  confidence. Cross-record identity can only be observed through later
  ASR/diarization labels.
- No conclusion can yet be drawn about train/save availability, alias
  persistence, acoustic identity accuracy, or readiness for Shadow Owner
  Attribution.

## Next Steps

Review the Provider-side reason for the empty combined `speaker_result` and
standalone `code=1`, ideally using the retained request ID available only in
Provider-side logs. After the diarization service is stable, perform a new
explicitly authorized one-shot full smoke. Only a real recording B alias match
and conservative `known_contact` resolution should permit Shadow Owner
Attribution evaluation.

# 2026-07-24 - Speaker Diarization Stability Benchmark

## Background

The real Voiceprint cross-record smoke remained blocked before train/save
because the same controlled two-speaker input could sometimes return
`speaker_1/speaker_2` and sometimes complete ASR with an empty
`speaker_result`. A matrix benchmark was required to separate duration effects,
the numeric `speaker` parameter, Provider randomness, and standalone
diarization behavior without creating any Voiceprint state.

## Design

An evaluation-only benchmark generates one 90-second alternating Yaoyao /
Kangkang PCM master and five nested prefixes of 30, 45, 60, 70, and 90
seconds. Each duration is submitted three times with `speaker=2` and three
times with `speaker=0`, for 30 serial combined-ASR requests.

Success requires completed ASR plus exactly two unique speaker labels.
Non-empty one/many-speaker results are recorded as count mismatches. When ASR
is ready but combined `speaker_result` stays empty for the bounded grace
period, standalone diarization is attempted and reported separately; it never
rewrites the combined result.

The runner has an endpoint allowlist containing only combined ASR and
standalone diarization submit/query paths. It does not import or construct the
Voiceprint Provider, service, repository, or resolver.

## Architecture Change

No production data flow changed. The new evaluation path is:

```text
90s synthetic A/B master
-> 30/45/60/70/90s nested PCM fixtures
-> serial matrix:
   duration x speaker(2|0) x 3 repetitions
-> combined ASR result
-> optional standalone diagnostic
-> append-only progress + aggregate report

voiceprint/train: unreachable
voiceprint/save: unreachable
```

## Technical Implementation

- `scripts/benchmark-speaker-diarization-stability.ts` implements synthetic
  audio generation, exact format/duration validation, an ephemeral HTTPS
  delivery tunnel, an ASR/diarization-only path allowlist, serial trials,
  append-only progress, atomic partial snapshots, bounded polling, standalone
  diagnostics, report generation, and cleanup.
- `src/lib/server/evaluation/speaker-diarization-stability.ts` defines the
  30-case matrix, safe failure categories, latency aggregation, parameter and
  duration groupings, and a candidate stable-duration calculation.
- `src/lib/server/evaluation/speaker-diarization-stability.test.ts` covers
  matrix completeness/order, invalid repetition counts, failure
  classification, fallback aggregation, and empty candidate behavior.
- `package.json` adds `speaker-diarization:benchmark`.
- Reports are stored beneath
  `.data/evaluation/speaker-diarization-stability-v1/`.

## Decision & Trade-offs

Trials run serially so benchmark concurrency does not become an extra
variable. Each trial uses a unique Provider task and an opaque URL route, while
all six trials for a duration use identical audio bytes. Parameter order
alternates between repetitions to reduce order bias.

The primary success metric is exactly two unique labels, not merely
`code=0`, completed ASR, or a non-empty speaker-result array. This is stricter
but matches the downstream two-person requirement.

The matrix found a `45s` candidate minimum for `speaker=2` within this run, but
three repetitions per cell are insufficient for a production guarantee.
Earlier real runs also observed both success and failure with a 70-second
fixture, so duration cannot be treated as the only stability variable.

The initial cleanup snapshot marked tunnel stop as false because the child exit
code had not settled. A post-run process audit found zero cloudflared
processes. The runner now waits and checks process existence before recording
the cleanup result; the retained report includes the post-run audit explicitly.

## Validation

- Real report:
  `.data/evaluation/speaker-diarization-stability-v1/run-2026-07-24-060539149/`.
- Planned/completed combined trials: `30/30`.
- Audio: exact `30000`, `45000`, `60000`, `70000`, and `90000 ms`;
  `pcm_s16le`, 16 kHz, mono.
- ASR text success: `30/30`.
- Combined exact-two-speaker success: `23/30`.
- `speaker=2`: `12/15` (`80.0%`), median `19115 ms`, P95 `65795 ms`.
- `speaker=0`: `11/15` (`73.3%`), median `26172 ms`, P95 `147851 ms`.
- 30 seconds: `0/3` for both parameters.
- 45 seconds: `3/3` for `speaker=2`; `2/3` for `speaker=0`.
- 60, 70, and 90 seconds: `3/3` for each parameter.
- Empty combined speaker result: `3`.
- Unexpected unique-speaker count: `4`.
- Standalone attempts/recoveries: `3/0`; all three attempts returned Provider
  `code=1`.
- Voiceprint Provider constructed: false.
- Voiceprint train/save calls: `0/0`.
- Focused benchmark/diarization suite: `2` files / `13` tests passed before the
  run.
- `npm run lint`: passed before the run.
- Temporary audio removed and local server stopped. Post-run process audit
  confirmed zero cloudflared processes.
- Final report JSON SHA-256:
  `3c6411551db2d743f604b9b8e49c7a8f47371632b49a1255b9367d34549fdd84`.

## Limitations

- Three repetitions per duration/parameter cell provide exploratory evidence,
  not a formal reliability estimate.
- The synthetic content uses equal five-second alternating slots and does not
  represent overlapping speech, noisy rooms, or real-user voices.
- Standalone diarization remained unusable for all eligible trials and exposed
  only undocumented Provider `code=1`.
- Provider latency was non-monotonic. One 60-second `speaker=0` trial took
  `147851 ms`, while longer fixtures were often faster.
- The benchmark waits for actual speaker output; the production Speaker ASR
  adapter has a separate earlier completion boundary and was intentionally not
  modified.
- No Voiceprint train, save, cross-record identity, or Owner Attribution
  behavior was validated.

## Next Steps

For the next controlled Voiceprint smoke, prefer `speaker=2` and a fixture of
at least 60 seconds, but keep actual `speaker_result` with exactly two labels as
the mandatory gate. Do not rely on duration alone. Before creating a production
hard rule, repeat the benchmark with more trials and Provider-side diagnostics
for empty results and standalone `code=1`. Shadow Owner Attribution should
remain blocked until train/save and recording-B alias recognition succeed.

# 2026-07-24 - Voiceprint Cross-record Strict Smoke

## Background

The Speaker Diarization Stability Benchmark showed that `speaker=2` with
60-second-or-longer two-person audio was the best tested prerequisite for a
real Voiceprint cross-record check. The previous full smoke harness still
allowed standalone diarization fallback, used a sub-60-second Recording B, and
did not strictly prove that a later `known_contact` came from a Provider alias
rather than local manual mapping.

This task tightened the evaluation-only gate and performed one real remote
attempt without modifying Memory, Owner Attribution, Relationship Lifecycle,
QA, Streaming Voice, or production Pipeline behavior.

## Design

Recording A and B reuse two different five-minute windows from the existing,
privacy-safe `long-recording-60m-v1` synthetic WAV. Both recordings use
combined ASR with `speaker=2`. A mutation is permitted only when the response
contains exactly two unique labels and every label has non-empty text.
Recording A additionally requires the literal local label `speaker_1`.

The Provider document defines `voiceprint/train` as current-user training and
does not accept a local speaker label. To test the user-requested selected
speaker ranges without creating a local `known_user`/`known_contact` conflict,
the `speaker_1` ranges are trained in an isolated synthetic training-user
scope. Recording A save and Recording B identification share a separate
contact-user scope. The save sends the documented user-edited alias `Alice`.

Cross-record success remains fail-closed. Recording B must directly return
`Alice` for the same controlled synthetic voice, the repository must produce
exactly one Voiceprint hint, the Resolver assignment must be
`known_contact`/`voiceprint_match`, and the other B speaker must remain
`unknown_person`. Recording A manual mappings are never supplied to the B
Resolver.

## Architecture Change

Before:

```text
combined ASR
-> optional standalone fallback
-> labels >= 1 / loose post-check
-> train/save
-> Recording B (<60s allowed)
```

After:

```text
retained synthetic Recording A (300s)
-> combined ASR, speaker=2
-> exact-two + per-speaker-text + speaker_1 gate
-> one train request (retry=0)
-> one save request only after train success
-> retained synthetic Recording B (300s)
-> same strict combined gate
-> Provider alias exact match
-> Voice Identity Resolver
-> known_contact(Alice) + unknown_person, or fail closed
```

## Technical Implementation

- `src/lib/server/evaluation/voiceprint-diarization.ts` adds a structural,
  transcript-free combined diarization quality gate.
- `src/lib/server/evaluation/voiceprint-diarization.test.ts` covers exact
  speaker count, required-label, and per-speaker text-presence behavior.
- `scripts/validate-voiceprint-provider-smoke.ts` now:
  - uses two validated five-minute windows from
    `test-data/long-recording-60m-v1/audio/long-recording-60m-v1.wav`;
  - derives utterance ranges from deterministic long pause boundaries without
    persisting transcript or timing rules in the report;
  - disables standalone diarization fallback for the cross-record run;
  - selects literal `speaker_1`;
  - limits real train/save to one Provider call each with retry disabled;
  - validates both the Alice assignment and the unknown speaker inside
    Recording B;
  - records safe Provider code/status fields, gate counts, local Resolver
    confidence, and cleanup state.
- The retained report is:
  `.data/evaluation/voiceprint-provider-smoke-v1/run-2026-07-24-073202767/`.

## Decision & Trade-offs

The first local launch failed before any remote request because Windows
OneCore TTS returned an internal speech error. Its report recorded zero
Voiceprint mutation calls and successful cleanup. Rather than restarting
system services or introducing another remote TTS dependency, the final
attempt reused the existing validated synthetic dataset.

The train scope is deliberately separate from the contact scope. This means
the train endpoint availability check is not claimed as the cause of later
contact recognition; the save operation is the documented mechanism that
should affect later diarization. The two recordings still share one contact
scope, which is the required boundary for cross-record alias observation.

The smoke stopped after `voiceprint/train` failed. It did not send save, submit
Recording B, adjust configuration, or rerun the remote flow.

## Validation

- Focused Voiceprint, repository, Resolver, and diarization suite:
  `5` files / `66` tests passed.
- `npm run lint`: passed.
- `git diff --check`: passed before the real run.
- Recording A duration: `300000 ms`.
- Recording A ASR + diarization: success in `62515 ms`.
- Recording A source: `combined_asr`.
- Recording A gate: passed with exactly `2` labels and text for both.
- Selected local label: `speaker_1`.
- `voiceprint/train`: one Provider call, retry count `0`, failed as
  `http_error` in `383 ms`.
- Train local transitions: `pending -> failed`.
- The retained run did not capture the HTTP status or Provider code for this
  failure; neither is inferred. The harness now retains the safe HTTP status
  on future failures.
- `voiceprint/save`: skipped, Provider calls `0`.
- Recording B and cross-record Resolver: skipped.
- Total Voiceprint mutation Provider calls: `1`.
- Temporary audio removed: true.
- Local audio server stopped: true.
- Quick tunnel stopped: true.
- Post-run process audit: zero cloudflared processes.
- The report contains no tunnel URL, raw request/user/record ID, transcript,
  audio, Authorization value, embedding, or voice feature.
- `report.json` SHA-256:
  `e3c1735e707e01be2e672e1466d7e1b65abb3a3eb4c6f52adca1eee663e22138`.

## Limitations

- Cross-record identity recognition was not completed because train failed
  before save.
- The current run proves strict diarization gating and fail-closed mutation
  sequencing, not Voiceprint contact continuity.
- The exact train HTTP status was not retained by this run. Only the safe
  `http_error` category, one attempt, zero retries, and latency are known.
- No Provider cleanup endpoint is documented. Although train returned an HTTP
  error, remote partial state cannot be disproved.
- The Provider exposes no documented acoustic match confidence or standalone
  identify endpoint. Resolver confidence remains a local exact-alias value.
- Synthetic clean audio does not measure real-user or noisy-room accuracy.

## Next Steps

Obtain the Provider-side route/status diagnosis for
`/api/ai/voiceprint/train` before another mutation-bearing run. Do not call
save independently or reinterpret local labels as global identity. After the
train route is confirmed, run one separately authorized cross-record smoke
with the same strict gates; only a direct Recording B `Alice` alias plus an
unknown second speaker should unblock Shadow Owner Attribution.

# 2026-07-24 - Remove Direct Voice Comparison Panel

## Background

The QA workspace temporarily exposed both the experimental Direct voice panel
on the left and the formal Agent voice entry on the right. The comparison UI
is no longer needed on the user-facing page, and its desktop grid column left
the main QA area unnecessarily constrained.

## Design

Remove only the mounted Direct comparison panel and its layout slot. Keep the
formal Agent voice entry, its current/week/all scope handling, recording
context, disabled-state messaging, and production Voice QA flow unchanged.
The underlying Direct answer strategy and reusable voice component capability
remain available for non-production experiments.

## Architecture Change

Before:

```text
Direct comparison voice panel | Text QA | Formal Agent voice panel
```

After:

```text
Text QA | Formal Agent voice panel
```

On narrower screens the formal voice panel remains stacked with the text QA
content; on wide screens the workspace now uses a two-column `main agent`
layout without an empty left column.

## Technical Implementation

- `src/components/qa-voice-workspace.tsx` no longer mounts the Direct
  `BrowserVoiceQa` sidebar and continues to mount the Agent sidebar.
- `src/app/globals.css` removes the Direct grid area and changes the wide
  workspace from three columns to two.
- `src/components/qa-voice-workspace.test.tsx` now verifies that only the
  formal Agent entry is rendered across active, week, and all scopes.
- `src/app/page.test.tsx` verifies that opening QA exposes the formal voice
  entry while the Direct comparison panel remains absent.

## Decision & Trade-offs

The Direct strategy, API behavior, and component-level experimental support
were not deleted because this change concerns the visible comparison window,
not the answer-strategy implementation. Browser evaluation tooling that
explicitly searches for the removed Direct sidebar must use a non-page
experimental entry instead; the default Agent validation path is unchanged.

## Validation

- `npx vitest run src/components/qa-voice-workspace.test.tsx src/app/page.test.tsx src/components/voice/browser-voice-qa.test.tsx`:
  `3` files / `67` tests passed.
- `npm run lint`: passed, including Next.js route type generation and
  TypeScript validation.
- No live Provider call or Pipeline run was performed.

## Limitations

- This change was validated through component/page tests rather than a live
  browser screenshot.
- The old streaming E2E harness still has an explicit Direct-page selector;
  that optional mode no longer represents a visible production-page entry.

## Next Steps

Use the right-side formal Agent panel for browser Voice QA. If Direct UI
comparison is needed again, expose it through a dedicated evaluation-only
surface rather than the production QA workspace.

# 2026-07-24 - Unified Text and Voice QA Composer

## Background

The production Voice QA entry still occupied a separate right-side card even
though text QA and Voice QA ultimately use the same memory-aware QA core. This
split made the page feel like two unrelated conversations and left unused
workspace around the central thread. The requested interaction is one
conversation surface with a microphone button immediately before the send
button.

## Design

Keep the existing transport and safety boundaries, but unify presentation and
recent conversation context:

- text questions continue through the existing text QA routes;
- voice questions continue through `/api/voice/qa`, Volcengine ASR, the
  production Agent strategy, the VOICE response optimizer, and TTS;
- both input modes append completed turns to the same central conversation;
- the latest bounded conversation context is sent explicitly with Voice QA;
- spoken text remains citation-free, while canonical citation metadata is
  retained for the central evidence UI;
- recording, text submission, and voice processing are mutually excluded to
  avoid overlapping turns.

No retrieval, memory, evidence, answer-strategy, or Provider behavior was
replaced.

## Architecture Change

Before:

```text
Central Text QA Composer       Separate right Voice QA card
        |                                  |
    Text QA route                       /api/voice/qa
        |                                  |
 Separate UI history              Separate UI conversation
```

After:

```text
Central QA conversation
        |
 Text input + Mic button + Send
        |                 |
 Text QA route       /api/voice/qa
        |                 |
        +---- shared recent turns ----+
                       |
            central answer + citations
                       |
       voice-only spoken projection -> TTS
```

## Technical Implementation

- `src/components/qa-voice-workspace.tsx`
  - replaces the mounted right-side voice card with a scoped context provider;
  - keeps current/week/all scope, upload, reference date, and availability
    data available to the central composer.
- `src/components/qa-panel.tsx`
  - mounts the compact production microphone immediately before the send
    button;
  - appends completed voice questions and answers to the central thread;
  - shares the same bounded recent conversation across text and voice turns;
  - prevents concurrent text submission while voice is listening, thinking,
    or speaking.
- `src/components/voice/browser-voice-qa.tsx` and
  `src/components/voice/voice-qa-button.tsx`
  - add a compact composer variant, completion callback, state/error
    forwarding, and cancellation from the same microphone control;
  - preserve the existing card variant for non-production test surfaces.
- `src/lib/voice-browser-stream.ts`
  - validates the Voice QA answer metadata needed by the central citation
    renderer instead of treating citation objects as unknown values.
- `src/app/api/voice/qa/route.ts`
  - accepts an optional, strictly bounded and validated conversation payload;
  - explicit browser conversation context overrides stale managed-session
    context, while an absent field preserves the existing fallback behavior.
- `src/app/globals.css`
  - changes the production QA workspace to one centered content column;
  - styles the compact microphone control at the requested composer position.
- `scripts/validate-streaming-voice-e2e.ts`
  - follows the production composer control instead of removed sidebar
    selectors; the removed Direct page mode now fails explicitly.
- Tests updated in:
  - `src/components/qa-panel.test.tsx`;
  - `src/components/qa-voice-workspace.test.tsx`;
  - `src/components/voice/browser-voice-qa.test.tsx`;
  - `src/app/page.test.tsx`;
  - `src/app/api/voice/qa/route.test.ts`;
  - `src/lib/server/voice-qa/browser-session.test.ts`;
  - `scripts/validate-streaming-voice-e2e.test.ts`.

## Decision & Trade-offs

The voice response shown in the central thread is the concise VOICE projection
that is also spoken. Citation objects remain attached and renderable, but
citation markers and evidence text are not sent to TTS. This keeps screen and
spoken wording aligned without weakening Evidence First. Conversation input is
bounded to the existing eight-message window and per-message size limits;
unbounded browser history is not accepted by the server.

The standalone card component was retained for test/evaluation reuse, but it
is no longer mounted by the production QA workspace. The experimental Direct
answer strategy remains available below the UI layer and was not deleted.

## Validation

- Focused regression:
  `8` test files / `177` tests passed, covering page placement, shared
  conversation submission, completion callbacks, API validation, session
  behavior, stream schemas, and the updated E2E harness.
- `npm run lint`: passed (`next typegen` and TypeScript `--noEmit`).
- `npm run build`: passed; Next.js production build completed successfully.
- Local Playwright visual check at `2000x1100`:
  - microphone precedes send: true;
  - vertical center difference: `0 px`;
  - visible `.voice-qa-card` count: `0`;
  - visible `.qa-voice-sidebar` count: `0`.
- Screenshot:
  `output/playwright/qa-composer-voice-button.png`.
- No microphone recording, remote Voice Provider call, or Pipeline run was
  performed during this UI validation.

## Limitations

- The visual account had no ready current-day recording, so both composer
  actions were correctly disabled; placement and removal were verified, but
  this pass did not exercise a real audio turn.
- The production page exposes only Agent voice mode. Direct remains an
  evaluation strategy without a production-page control.
- Text and voice share bounded recent conversation in the browser session;
  this change does not introduce cross-device conversation synchronization.

## Next Steps

Run one normal browser Voice QA turn against a ready retained upload when a
real interaction check is desired. Verify that the recognized question,
concise spoken answer, and citation disclosure appear in the same central
thread, while the audio playback omits citation IDs.

# 2026-07-24 - Release Hygiene and Cross-platform Test Gate

## Background

The pre-push audit found that local browser screenshots and real Provider
benchmark outputs were visible to `git add .`, `UPDATE_HISTORY.md` was still
tracked despite being listed in `.gitignore`, Vitest collected Playwright e2e
specs, and several tests assumed POSIX paths while running on Windows. The
release candidate therefore needed an explicit file boundary and a green,
cross-platform unit-test gate.

## Design

Treat source, reproducible fixtures, tests, configuration templates, and
curated documentation as release material. Treat runtime data, Provider
reports, screenshots, credentials, audio, databases, and local collaboration
history as local-only. Preserve the local history file while removing it from
the Git index. Keep Vitest's default exclusions and add only the Playwright
`e2e/` boundary. Make test expectations use native `node:path` operations
without changing production storage behavior.

## Architecture Change

Runtime architecture is unchanged.

Before:

```text
git add .
  -> source + local screenshots + Provider reports + tracked local history

vitest
  -> unit tests + Playwright e2e specs

path tests
  -> POSIX-only expected paths
```

After:

```text
release inventory
  -> curated source / tests / fixtures / docs
  -> local artifacts excluded

vitest
  -> unit/integration tests only

path tests
  -> native Windows/POSIX expectations
```

## Technical Implementation

- `.gitignore`
  - excludes `output/`, `reports/`, Playwright output, Provider raw response
    directories, additional database/audio formats, local certificate files,
    and existing runtime/build state;
  - keeps `.env.example` as the only environment template eligible for Git.
- `UPDATE_HISTORY.md`
  - remains on disk and is updated locally;
  - was removed from the Git index with `git rm --cached`, so later release
    commits record its removal but do not upload subsequent local contents.
- `docs/release/RELEASE_FILE_INVENTORY.md`
  - documents release include/exclude groups and precise staging checks;
  - explicitly excludes the browser screenshot and long-recording A/B report.
- `docs/architecture/SYSTEM_ARCHITECTURE.md`
  - references the curated architecture PNG so it is not an orphaned release
    asset.
- `vitest.config.ts`
  - preserves `configDefaults.exclude` and adds `e2e/**`.
- `src/app/api/routes.test.ts`
  - uses `tmpdir()` and `join()` for upload, settings, and open-folder paths.
- `src/lib/server/settings/provider-config.test.ts`
  - uses `resolve()` for server storage expectations.
- `src/app/page.test.tsx`
  - waits for the asynchronous browser-cache write before asserting saved
    speaker aliases, removing a full-suite-only race.

## Decision & Trade-offs

All final benchmark JSON is ignored under `reports/`, even when produced from
controlled data. Curated conclusions remain in `docs/`; publishing a raw
report requires an explicit, separately reviewed move into a documentation
asset path. `UPDATE_HISTORY.md` stays available to local agents but is no
longer a release artifact. This intentionally aligns with the upstream
deletion, at the cost of the history not being available to repository
consumers.

The architecture PNG remains in release because it is a deliberate project
artifact and is now referenced from the architecture document. Audio files
remain excluded even when generated from synthetic voices.

## Validation

- Vitest e2e exclusion:
  - Playwright spec is no longer collected by Vitest;
  - a control unit test remains discoverable and passes.
- Windows path tests:
  - `2` files / `65` tests passed.
- Page cache race regression:
  - `1` file / `43` tests passed.
- Full suite:
  - `183` files / `1572` tests passed.
- `npm run lint`:
  - Next.js route type generation and TypeScript validation passed.
- The screenshot and A/B JSON remain present locally and are confirmed
  ignored.
- No commit, push, deploy, reset, clean, or remote Provider call was
  performed.

## Limitations

- The local branch still trails the last known `origin/master` tracking ref by
  three commits; no fetch was performed in this task.
- `core.autocrlf=true` remains active without a repository `.gitattributes`,
  so Git continues to emit LF-to-CRLF warnings.
- The release candidate still spans many historical feature areas and
  requires deliberate staging review before commit.

## Next Steps

Fetch the current remote state, confirm the local-history deletion resolution,
create or use a release/topic branch, and stage only the groups listed in the
release inventory. Re-run `git diff --cached --check`, inspect the cached file
list, and push without force only after the upstream state is integrated.

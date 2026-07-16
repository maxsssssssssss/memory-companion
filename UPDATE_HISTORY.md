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

# Work Review V2 Wave 1 — Core Contract Handoff

> 状态：Core contract implemented；不代表 Work Review V2 完成、可发布或已接入真实 GPT/Worker/UI。

## 冻结的运行边界

- 数据库：继续使用 `work-review.sqlite`；Project 与 Weekly 共同占用唯一 V5 migration。
- Source Snapshot：只读取 Work-owned confirmed Findings、Meeting metadata、Work Todo/event ledger、Project links，以及 Finding 直接引用的 Canonical Evidence。
- 禁止来源：pending/ignored Candidate 正文、整份 Transcript、Follow-up、Daily Reflection、Date Companion、Memory、Person、generic Retrieval、旧 QA answer。
- Freshness：`sourceSnapshotDigest` 覆盖全部 eligible revision identities，包括被容量裁掉的来源；`inputPackDigest` 另含账号、周、时区、scope、容量与本次有界输入。
- Empty scope：当当前 scope 没有任何 eligible Evidence 时，service 返回 `weekly_insufficient_sources`，且不会创建 generation run。
- Publication fence：Generation/QA run 会冻结实际 bounded Provider input pack；publish 同时核对冻结的 `inputPackDigest`/allowlist、caller 提交的原始 Provider snapshot，以及同一 SQLite `IMMEDIATE` 写事务内重建的 live snapshot。caller 快照不是最终信任边界，capacity/config drift 或来源变化都不能扩大可引用集合；新增或变更来源会使晚到 publish 被拒绝并持久化为 superseded/stale。
- 历史版本：System Version、System Item 与逐 Item source edges 分层保存；regenerate 只替换 clean 或已完全失效的旧 GPT projection，保留用户改文、隐藏或重排过的旧 projection，并继续绑定其原 System Version/citation map。只有显式 reset 会丢弃这些旧版 overlay，并把当前版本恢复为 System Item 的正文、核验状态与排序；user note 始终保留。
- 删除：被引用来源删除或越出 scope 时，只失效命中的 source edge；只要 GPT item/assistant answer 仍有至少一个有效来源，就保留正文与其余引用并递增对应 CAS version。有效来源归零后才整条 invalidated/隐藏/擦除，immutable system text 也只在归零时执行单向 privacy erasure。user note 不受来源失效影响，但随 Weekly Review 删除。
- 恢复：`claimGenerationRun` / `claimQaRun` 可用 CAS 接管 queued 或 lease 已过期的 run；旧 worker 在 lease 过期后不能 publish 或 mark failed。

## 下游公开合同

### Text QA owner

只允许消费：

- `buildWorkWeeklySourceSnapshot(...)`
- `WorkWeeklySourceSnapshot.allowlistedSourceRefs`
- `WorkWeeklyRepository.publishSystemVersion(...)`
- `WorkWeeklyRepository.publishQaAnswer(...)`

生成前必须使用当前 snapshot；publish 时继续提交本次使用的 snapshot。Repository 会在同一写事务内再读 live snapshot 并校验 digest/allowlist。不得写 schema、绕过 allowlist、保存完整 Prompt/Provider response，或把历史 assistant message 当 Evidence。

### Runtime owner

只允许消费：

- `listRecoverableGenerationRuns / claimGenerationRun / renewGenerationLease`
- `markGenerationVerifying / publishSystemVersion / markGenerationFailed`
- `listRecoverableQaRuns / claimQaRun / renewQaLease`
- `publishQaAnswer / markQaRunFailed`

`claim*` 同时承担首次 claim 与 expired-lease recovery；`mark*Failed` 只接受仍有效的 lease。Runtime 不得复用 Meeting `wr_processing_attempts`，不得另建 queue receipt/lease 状态。本 Wave 未接 BullMQ、Worker 或 PM2。

### UI owner

只允许消费 `WorkReviewV2CoreApi`；不得直读环境变量、SQLite、Source Pack，或在客户端推导 stale、account/product scope、Evidence allowlist。Feature capability 由 `/api/work-reviews/config` 返回。

## 单一 owner 文件

以下文件在 Text QA、Runtime、UI 并行开发期间只能由 Core owner 修改：

- `src/lib/server/work-review/schema.ts`
- `src/lib/domain/work-project.ts`
- `src/lib/domain/work-weekly.ts`
- `src/lib/server/work-review/project-repository.ts`
- `src/lib/server/work-review/weekly-source-builder.ts`
- `src/lib/server/work-review/weekly-repository.ts`
- `src/lib/server/work-review/weekly-invalidation.ts`
- `src/lib/server/work-review/runtime-config.ts`
- `src/lib/server/work-review/route-utils.ts`
- `src/lib/client/work-review-api.ts`

## 独立开发区

- Text QA：未来 Work-only synthesizer/verifier/provider adapter 与聚焦测试。
- Runtime：未来 Work-only queue registration/worker orchestration/recovery wiring 与聚焦测试。
- UI：未来 `/work-review/projects`、`/work-review/weekly` 组件、路由与 Playwright；只调用客户端合同。

## 禁止触碰

本轮及后续 V2 owner 不得为 Weekly 功能修改 Daily Reflection、Date Companion、Memory Admission、Person、generic Retrieval 或其数据库；不得把 Work Evidence 放入这些产品的默认查询空间。

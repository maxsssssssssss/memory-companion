# 约会陪伴首页 AI 内容提炼

## 问题与结果

首页此前将最后一条 `mentioned` 正文用作人物近况，并可能把同一条正文用作见面前准备。上游语义摘要的兜底又可能只是拼接口语，导致两块出现同样的零碎长文。

现在首页使用 Date Companion 自己的 TokenHub `deepseek-v4-pro` 一次生成两组派生内容：

- `about`：明确近况、明确表达的偏好或有依据的共同经历，0–2 条。
- `beforeMeeting`：具体可选的跟进话题或尚未完成的既有承诺，0–2 条。

每条都有独立的 canonical Evidence 引用和记录日期，可以展开原话并回到原记录。两组都可以为空；旧复盘正文、旧观察和 Provider 失败后的通用提示不再作为首页两块的填充。

这次不改复盘候选生成器、准备页全部分类、人物身份或长期 Memory 的写入规则。生成结果只属于展示缓存，不能成为 Evidence、Person 事实或新 Memory。

## 接入与调用

- Date Companion 默认采用自己的 TokenHub Provider，模型固定 `deepseek-v4-pro`、`reasoning.effort=none`。
- 使用现有服务端 `OPENAI_API_KEY`，并要求 `OPENAI_BASE_URL` 绑定 `tokenhub.vision-intelligence.tech` 的根路径或 `/v1`。实际请求固定 HTTPS `/v1/responses`。已有 `OPENAI_AUTH_HEADER_MODE=raw` 配置仍按原语义支持。
- 不读取 Work Review profile、其他产品模型配置或通用 proactive Provider 开关。不新增 production dependency、全局 feature flag 或第二套生成缓存。
- 请求上限 30 秒，低于既有 45 秒缓存 lease；没有自动重试、重定向或模型切换。必须收到完整 Responses 完成事件并通过 JSON/契约校验。
- 日志和客户端错误只使用静态错误码，不包含凭据、Provider 错误正文或用户转写。
- 当前相处的观察仍沿用原提示词和来源归因校验，通过同一产品的 TokenHub Pro 调用；首页关系范围使用新的选材输出。

## 内容与来源边界

AI 负责语义判断：玩笑不等于偏好，提到食物不等于餐厅计划，旧事件不等于即将发生的安排。输入提供原话、人物主体、来源类型、发生日期、上海当前日期和承诺状态。确认材料变化后按缓存指纹生成，首页读取和展示结果。

服务端校验准确的引用并集、各条主体、重复内容和承诺状态。`open_promise` 必须引用现有且仍 open 的承诺；done 不得重新包装成待跟进事项。用户复盘转述会附明确归因，不作为 Ta 的直接原话。客户端再次核对原话、摘要哈希、日期、时间、说话人与主体，并在来源变化时撤下旧结果。

Home 会单独补入已通过现有 canonical Person/Evidence 准入验证的 Self 承诺。它们仍属于 Self，不进入 Love 的人物问答来源目录；只有 Self 承诺、没有 Ta 近况时也允许展示准备事项。

“问问 Ta”继续提供动态建议：从 `about` 派生最多两个可编辑的查记录问题，再独立使用 Person QA 的来源目录核对。准备事项及 Self 承诺不用于扩大问答来源，也不会作为人物事实传入旧观察组件。

## 缓存、删除与迁移

复用 `dc_proactive_value_cache` 的 claim、lease、账号隔离和完成状态。指纹纳入内容契约版本、Provider/模型、人物映射、原话摘要、上海日期和承诺状态/版本/正文/来源。客户端跨日或回到前台发现日期改变后刷新，先撤下前一日结果。

生成结束后重新读取准入上下文；若来源删除、excluded、主体变 unknown、关系归档、承诺完成或其他指纹变化，返回 unavailable 并清除该账号的旧生成缓存，晚到响应不能恢复内容。

V12 迁移只扩大既有缓存的 Provider 枚举以容纳 `tokenhub`，保留旧缓存、唯一约束、claim/lease、attempt count 和外键删除级联。不改变历史 migration，不对服务器执行迁移。

真正的空选择以 ready 缓存；请求失败以空结果和 fallback 缓存。相同指纹不自动重放失败请求；来源、承诺或日期变化后才产生新的生成任务。

## 当前能力上限与验证口径

沿用最多 24 条 canonical Evidence 的上下文预算；在该预算内优先保留 open 承诺来源。匹配的承诺状态最多 100 条，每块输出最多 2 条。这不是完整历史阅读器。若实际验收持续发现重要内容落在 24 条范围外，或 30 秒请求上限频繁触发，应先记录漏选与超时比例，再调整当前预算或选材策略；本次不预建分层生成管线。

本地单元、SQLite 集成、schema migration、mock Provider 和浏览器 fixture 分别记录验证结果。真实 TokenHub 聊天样本质量与目标环境验证需要另行执行；不得把 mock 返回的好文案当成模型已达到质量要求。

## 2026-09-08 本地验证

以下用例有交叠，数量不累加为独立验收总数。

| 检查 | 结果 |
| --- | --- |
| TokenHub adapter 与旧 Date Companion Provider contract | 2 文件，60 项通过，exit 0 |
| 内容校验、生成缓存、上下文与 Person 来源目录 | 4 文件，52 项通过，exit 0 |
| Schema V12、Memory Bridge、preflight、repository 与首页准入 | 5 文件，80 项通过，exit 0；包含真实本地 Memory Bridge 准入链，Provider 使用 mock |
| 首页组件、客户端和 shell | 3 文件，64 项通过，exit 0；末尾 QA 建议修复后再测受影响的客户端与 shell，2 文件 53 项通过，exit 0 |
| 桌面与手机浏览器 fixture | 2/2 通过，exit 0；1920×1080 与 390×844，覆盖来源跳转、空结果、失败和无横向溢出 |
| 隔离目录生产构建 | `next build` exit 0；编译、类型检查与 43/43 静态页面生成通过，网络 guard 启用；不是发布包或服务器验证 |
| 最终类型与差异检查 | `npm run lint`（typegen + TypeScript）exit 0；`git diff --check` exit 0，只有 LF/CRLF 提示 |
| 全仓测试一次 | 468 文件中 464 通过、4 失败；4519 项中 4511 通过、8 失败，exit 1 |
| 全仓失败的最小复验 | 5 项 Date Companion schema 版本同步问题已修复并通过上述 80 项复验；余下 3 项 Work Review weekly 失败独立复现，未改动该模块 |
| 真实 TokenHub 请求与内容质量、服务器/生产验证 | 初次实施验收时 NOT RUN；后续真实简测见下节。服务器与生产验证仍 NOT RUN |

聚焦命令：

```powershell
npx vitest run src/lib/server/date-companion/tokenhub-content-provider.test.ts src/lib/server/proactive-insights/date-companion-deepseek-provider.test.ts
npm test -- src/lib/server/date-companion/home-content.test.ts src/lib/server/date-companion/proactive-value.test.ts src/lib/server/date-companion/proactive-value-context.test.ts src/lib/server/date-companion/person-source-catalog.test.ts
npm test -- src/lib/server/date-companion/schema.test.ts src/lib/server/date-companion/memory-bridge.test.ts src/lib/server/date-companion/memory-bridge-preflight.test.ts src/lib/server/date-companion/repository.test.ts src/lib/server/date-companion/home-content-acceptance.test.ts
npm test -- src/lib/client/date-companion-proactive-value.test.tsx src/components/date-companion/companion-home.test.tsx src/components/date-companion/date-companion-shell.test.tsx
npm test -- src/lib/client/date-companion-proactive-value.test.tsx src/components/date-companion/date-companion-shell.test.tsx
npm test -- --maxWorkers=4
npm test -- src/lib/server/date-companion/home-content.test.ts src/lib/server/date-companion/home-content-acceptance.test.ts src/lib/server/work-review/weekly-source-builder.test.ts
npm run lint
git diff --check
```

浏览器命令：

```powershell
$env:DATE_COMPANION_E2E_ARTIFACT_DIR = 'C:/Codex/daily-brief-source-20260708-122232/output/playwright/date-companion-home-content'
node scripts/run-date-companion-fixture-e2e.mjs date-companion-home-content-fixture.spec.ts
```

该目录保留 ready、来源、empty 与 failure 在两个尺寸下的共 8 张截图。截图文案来自 mock，并非真实模型回答。构建与 Browser 完成后，末尾 QA 建议补丁以对应聚焦测试和最终类型检查验收，未重复构建或 Browser。生成器改写的 `next-env.d.ts` 已由默认 typegen 恢复，无遗留 diff；原有其他产品和 `tsconfig.json` 的未提交内容保留。

上述包含 `weekly-source-builder.test.ts` 的最小复验命令为 38 通过、3 失败：两份首页测试共 31 项通过；周报测试 7 通过、3 失败。周报失败分别为损坏 digest/payload 的测试写入被既有不可变 trigger 拒绝，以及 missing 场景未按断言抛错。这些文件在开始时已属于其他工作的未提交内容，未将其改动或失败归属于本次修复，也没有将全仓结果标为通过。

开发时首次 Vitest 因沙箱 `spawn EPERM` 未启动，通过正常权限审查重跑同一命令；不是测试断言失败。首次浏览器运行遇到 fixture 未覆盖参与者音频请求，网络 guard 拒绝该请求；补入明确的 404 mock 后，同两项通过。早期类型检查发现 union 访问、SDK 的 `none` 类型和测试主体类型错误，均已修正。

生产构建使用 `.data/date-companion-home-build/next-tsconfig.json`（extends 根 `tsconfig.json`，baseUrl 与 `@/*` 指向项目根），并设置 `DAILY_BRIEF_E2E_DIST_DIR=.data/date-companion-home-build/next-dist`、`DAILY_BRIEF_E2E_TSCONFIG=.data/date-companion-home-build/next-tsconfig.json`、`APP_DATA_DIR=.data/date-companion-home-build/runtime`、`APP_STORAGE_MODE=local`、`PIPELINE_EXECUTION_MODE=inline`、`NEXT_TELEMETRY_DISABLED=1`、`NODE_OPTIONS=--require=./scripts/date-companion-e2e-network-guard.cjs`，清空进程中的 `OPENAI_API_KEY` 与 `DEEPSEEK_API_KEY` 后执行 `node node_modules/next/dist/bin/next build`。构建产物保留在隔离目录，未替换正在使用的 `.next`，未执行发布用 postbuild。

## 2026-09-08 真实 Provider 简测：内容质量未通过

用户要求简单测试后，以完全虚构的两个上下文调用当前 TokenHub Pro adapter，2/2 请求完成、零重试，分别 3156 ms 与 5328 ms，产品结构和引用校验通过。普通段子仍被包装成共同片段；有效样例的偏好和 open/done 承诺处理正确，但面试同时出现在近况和跟进建议中，且建议在参考日尚未到周五时直接跟进结果，没有明确“面试后”的条件。语义评价为 FAIL 与 PARTIAL，不能称内容质量通过。

命令 `node --import tsx .data/date-companion-home-smoke-20260908/run-once.mjs`，exit 1；完整输入和实际回答保留于 `.data/date-companion-home-smoke-20260908/report.json`，可读报告为同目录 `report.md`。脚本有单次锁、最多两个请求；没有修改产品提示词或自动重跑。原拟截图文本的外发被自动审批拒绝，改为不含私人聊天的虚构样例后正常审批通过；截图没有发出。本次是真实 Provider + fixture 上下文，未覆盖真实数据库准入或生产首页。

## 2026-09-08 模拟小样本：7 PASS、1 PARTIAL

用户另要求用模拟小样本测试，新增 8 段完全虚构、调用前确定预期的短上下文，覆盖段子、随口提及、明确偏好、未来/已完成事件、Self承诺open/done、双方偏好归属和复盘转述/猜测。当前 Pro 各调用一次，8/8完成、零重试，总25.7秒、平均3.2秒；结构检查8/8通过，逐条独立语义复核7 PASS、1 PARTIAL。

剩余 C06 选对未完成还伞承诺并排除已发完照片，但正文写成“可以问问下次见面时是否方便带上借的雨伞”，没有清楚提醒用户自己归还，行动主体含糊。C05的通过通知、C08的复盘归因还有冗余措辞，事实与来源正确。这组没有修改提示词或源码，不能把新样例通过当成上一轮错例已经修复。

命令 `node --import tsx .data/date-companion-home-smallset-20260908/run-once.mjs`，exit 0（仅调用与结构预期）；同目录 `cases.json` 保留冻结预期、`report.json` 保留实际回答、`assessment.json` 保留语义判定、`report.md` 为可读报告。真实Provider加边界清楚的虚构上下文，不是整体准确率、真实数据库或生产验收。

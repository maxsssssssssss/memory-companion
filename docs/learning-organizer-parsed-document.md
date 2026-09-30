# 学习整理 ParsedDocument 应用侧最小契约

2026-09-20 草案同步。本文件与 `src/lib/domain/learning-parsed-document.ts` 是应用侧统一落地点。此次用于最小接入，不冻结完整数据库、HTTP API、OCR 服务协议或生成放行政策。

## 本地收到的交付与当前范围

已读取用户附件《ParsedDocument 输出契约与 OCR 质量规则报告》。其中报告 server 离线复用 18 页、241 块、16 项契约检查通过，没有新增 OCR 调用；这些是 server 报告内容，不是应用侧联调结果。

草案同步时只有 `Pasted text.txt`，当时真实 JSON 联调 BLOCKED。随后用户交付 `C:\Codex\learning-parsed-handoff\20260920-115054`，该缺口已解除：本地重新核对 SHA256SUMS 自身及 164 个列入文件，165/165 一致。未访问任何服务器。

最新完成的是 **真实 OCR 输出文件的离线联调**：同一批 5 原件、18 物理页、241 块的 automatic、with_text_layer_signals、with_prior_visual_review 三份快照各自存为新版本，保存、重开读回、来源和范围检查通过。不能把三个快照计为 54 个不同样本页，也不是实时 HTTP、完整上传、OCR 质量或学习生成验收。

## 与 server 草案的对齐和差异

| 项目 | core 当前落点及差异 |
| --- | --- |
| 协议标识 | 新输入使用 `contract_version = learning-parsed-document/2`，是应用侧版本标识，不冒充 server 已采用的 wire 版本 |
| document 身份 | 输入 `document_id` 是本地一次解析尝试的 ID；`material_id` 才是本地材料 ID。server 草案“基于原文件的 document_id”放入 `parser_run.upstream_document_id`，不会替代本地归属校验 |
| 账号、哈希、版本 | 账号来自 `LearningRepository` 的认证上下文，不接受 payload 指定账号；payload ID、材料、原件 SHA-256、解析版本逐项与本地记录匹配。原件版本目前仍为 1，换解析结果用新文档 ID/递增版本 |
| 页码 | 标准结果只接受 `physical_page`，1 起点；不接受示例中的 `page_number` 别名。`printed_label` 独立可空。Paddle 的 `page_index` 是 0 起点，由调用方提供明确映射，不能直接 +1；旧结果不知道的 index 保留 null |
| 页面/渲染尺寸 | `size` 由 core 从已保存原件复制，不能由服务改写。width/height 是原件入库时 PDF.js scale=1 的可见视口尺寸；view 是 PDF 用户空间裁剪框，配合 rotation/userUnit。`render.width_px/height_px` 独立记录实际渲染像素，不当成 PDF 点 |
| 坐标 | 每个区域显式带 bbox、unit、origin、frame。当前 Paddle 最小边界接受 `normalized` 或 `render_pixel`，均是已裁剪/旋转的可见原页、左上原点；PDF 点坐标直接输入会拒绝。像素转换需已记录渲染尺寸、匹配本地裁剪/旋转和纵横比。原 bbox/单位保留，来源读取额外给出 normalized_bbox，绝不把归一化值当 PDF 点 |
| 合并来源 | `source_member_ids` 清单与 `source_regions[]` 必须完整对应。每个框保留物理页、原坐标、单位、parser run/index/block/result 引用；不会用第一个框代替全部成员，也允许同一个成员有多个框 |
| 内容/角色/顺序 | `content.raw/normalized/format/cleaning` 分开。当前有限清洗只允许不变或 CRLF/CR→LF；不修公式、猜词或补代码。保留 parser_type、role、reading_order.block_ids 与顺序来源；脚注/编号保留，不建立未经核实的关联 |
| parser 信息 | 稳定 name/version 仍属于本地解析记录；运行信息单独放 `parser_run`，含 run_id、upstream_document_id、model、config_summary。摘要必须由接入方脱敏，不能塞凭据或整份 Provider 响应 |
| 质量与生成 | unverified/verified/warning/blocked 四态；只记录、检查绑定和必要条件，不采用“普通正文自动可靠”或“只有人工核验后才可生成”的完整政策 |

`paddle-parsed-adapter.ts` 的 `adaptPaddleDraftDocument` 现适配实际交付的 `parsed-document-draft/0.1`。入参是单份快照对象及本地建立的材料/尝试/页映射/证据字节集合；不会自行打开路径或请求 URL。快照、原始 Paddle JSON、单页输入、选页 PDF 和复核 ledger 按 SHA-256 绑定。记录已知信号，不重新运行公式、表格、代码缺行等规则。

应用侧仍采用 `learning-parsed-document/2`，没有迁移数据库或冻结 HTTP API。只有有界的可选来源元数据、`page_number/chart` 角色、问题原始详情和 `prior_findings` 进入既有结果 JSON。业务不依赖 Paddle 网络实现。

## 质量记录怎样生效

- `automatic_signals` 只接收 automatic_rule；`text_layer_signals` 只接收 text_layer_comparison。人工、视觉与历史视觉记录单独在 `reviews` 中，保留方法、证据引用、审核者、时间、范围和结论。已知样本人工结论不会进入“自动检出”桶。
- 本次交付的负向视觉标注没有完整核验人/时间/范围证明，不补造 `reviews`。块级负向记录放 `prior_findings`，页级遗漏保留为有明确 origin/scope 的 page issues；保留 ledger、原始结果和快照引用及完整 `details_json`。它们不能产生 verified。草案中 `optional_pdf_text_layer_code_comparison` 虽标为 automatic_rule，应用侧按实际方法分入 text_layer_comparison，同时保留原始标记。
- 写入保留接入方原始状态声明，读出 `quality.reported_status`；`quality.status` 是 core 对当前记录算出的有效状态。结构合法、来源可达、非空或无告警最多保持 unverified，不自动生成 verified。
- 每条复核必须有 evidence_ref、方法、范围和内容/来源指纹，并绑定本地 document/material、原件哈希、解析版本、物理页与目标 block（页面顺序核验用空 block_id）。内容指纹覆盖 raw/normalized/格式/type/role；来源指纹覆盖全部成员框、页面与渲染几何、页映射和顺序。
- 只有当前绑定匹配且 scope 包含 content 的正向记录能令块成为 verified；只核实 source_mapping 不代表内容正确，只核实页面 reading_order 不升级页面所有块。有效范围在 verified_scopes 明示。
- 内容、坐标、来源几何、顺序或对应版本改变，旧记录保留供追溯，但列入 invalid_review_ids，不再生效。重复 review ID 拒绝，避免当前/失效记录混淆。
- 本次新增的单页输入/选页来源元数据也纳入来源指纹；没有这些可选字段的旧结果保留原哈希计算形式，不因本轮扩展自动失效。
- core 本身验证记录字段和对应关系，不证明人工结论真伪或 OCR 语义正确。实际交付适配器另外检查证据字节/hash及原始 JSON 指针；既有视觉记录只证明包内记录存在且对应当前原始输出，不表示本轮重新进行了语义核验。当前真实样本没有正向 verified；其失效行为仍由明确合成测试验证。

不建设复核 UI、平台或强制全人工流程。unverified 正文可以存储、查看并出现在范围检查中，是否可用于某种生成仍未决定。

## 执行、覆盖、内容条件分别看

创建尝试时将本地 `requestedPages` 保存为不可改写的请求范围（未提供时为原 PDF 全部物理页）。结果必须为每个请求页记录 succeeded 或 failed，并与 coverage 三份清单完全一致。没有请求的页不冒充成功页；缺少结果的请求页必须明确登记失败，不能静默删掉。

Document 的 completed 只代表结果提交完成。`coverage.whole_document_processed` 仅当全部原文档物理页均 succeeded 才为 true；它仍不保证没有漏块、读序错误或正文变义。整次执行失败时保留请求范围和固定 failureCode，没有页级证据就不编造逐页成功/失败；原 PDF 继续可查看。

原 `parsedLearningContent` 的自动筛选接口已由 `inspectParsedScope` 替代（此前只有本地测试调用，无已上线消费者）。新方法：

- 返回所选范围的块、全部来源、覆盖情况、失败页、未解析页，以及按物理页/块 ID 保存的问题。
- 页面遗漏不会被块的 verified/unverified 掩盖；阅读顺序的当前复核问题也会显示。
- 合并来源成员的问题会影响合并内容；同页无关块的问题不会机械扩大成整个学习页失败。
- 保留 warning/blocked 数据和原因，不悄悄排除后宣称范围完整。
- 只报告 selected_pages_succeeded、has_warning、has_blocked 等必要条件；content_completeness 始终是 not_established，没有 allowedToGenerate 或可靠率。

## 保存、兼容和删除

沿用账号目录的 `learning-organizer.sqlite`、版本行、immediate transaction、幂等与删除墓碑。schema 3 只在既有解析表上增加请求页清单列，没有新增平台或生成成果表。

旧 schema 0/1/2 可事务升级。旧 core v1 结果 JSON 和结果哈希不重写，读取时提供保守兼容视图，标记 legacy/1；旧的 verified 若没有证据会变为有效 unverified，旧 warning/blocked 保留；未知 role、render 和 parser 页索引不补造。旧终态不能用新协议覆盖，继续解析应新建版本。旧代码不能直接降级打开 schema 3。

删除单份材料与所有解析正文、几何、复核、运行信息、请求页缓存同事务清除；只留无正文的失效回执。来源返回 source_deleted，后续范围消费或晚到保存拒绝；整页删除清除所有已有归属对象。没有提前建框架/题组/答题历史。保存、删除或升级失败按事务回滚，原件不会因解析失败消失。

仍无 ParsedDocument HTTP 接收端点、队列/lease、自动重试、正式页面假结果或后台工具调用。材料不进入通用 uploads/Memory/Person/检索。现有 PDF/TXT 上传、原页、段落来源与选择保持原职责。

临时资源边界沿用：结果 8 MiB、每块 65,536 字符、每页 1,000 块、每次 20,000 块、最多 200 页；新成员框每块最多 64 条，问题/复核每组最多 100 条，用于限制同步处理的展开数量。超限明确失败，不截断。只有实际授权样本触及上限或实测同步处理成本不适合时，再调整；不预建替代平台。

## 上一轮草案同步验证（历史）

完整命令、最终数量与证据见对话报告及 `output/learning-parsed-draft-sync-20260920/`。本轮只使用合成 JSON、合成 PDF 与隔离账号/数据库。

```powershell
node node_modules/vitest/vitest.mjs run src/lib/server/learning/parsed-document.test.ts src/lib/server/learning/repository.test.ts src/lib/server/learning/pdf-repository.test.ts src/app/api/learning/learning-routes.test.ts src/app/api/learning/pdf-routes.test.ts src/components/learning/learning.test.tsx --exclude 'output/**' --reporter=verbose --reporter=json --outputFile.json=output/learning-parsed-draft-sync-20260920/tests-final.json
node node_modules/typescript/bin/tsc --noEmit --incremental false --project output/playwright/learning-stage1-focused-check-1789872819470-23120/tsconfig.json
node scripts/validate-learning-stage1.mjs check
git diff --check
```

| 验收 | 实际结果 |
| --- | --- |
| 上述聚焦测试 | PASS，退出 0；实际 6 文件、79/79。当前 ParsedDocument 测试 42 例，PDF/TXT repository/API/UI 相邻回归 37 例。证据 `tests-final.json` |
| 聚焦类型检查 | PASS，退出 0；复用已有当前源码范围配置，包含新增 core/adapter、domain 与测试 |
| 当前 src 整体类型检查 | Next typegen PASS；tsc 退出 2（包装脚本 1），仍只有 `src/app/api/daily-reflections/routes.test.ts:1448` 的 detail、`:1474` 的 deleted 两处 TS18048，未过滤新错误。日志在 `output/playwright/learning-stage1-check-1789874850747-27312/` |
| diff/保留检查 | PASS；8 个计划内文件改变或新增，基线另 89 个文件内容哈希不变；未 stage，HEAD 未改变 |

Browser、production build、全仓 Vitest、真实 OCR/ASR/Provider、服务器和生产验证均 NOT RUN。当前未改界面、Next route/config、依赖或打包配置，验收集中在契约、存储、安全和 PDF/TXT 相邻回归。真实 server JSON 读回联调 BLOCKED（缺少本地 JSON）。

上轮 69/69 和 PDF 阶段的 Browser/build 是历史证据，不能代替此次验收。此次早期失败包括 Windows spawn EPERM、一处 TypeScript 返回字面量推断错误，以及升级 schema 断言时误改了两处材料数量断言；按证据修复后复验，不降低测试条件。

## 2026-09-20 真实文件离线联调

`paddle-handoff.integration.test.ts` 只有显式提供 `LEARNING_PARSED_HANDOFF` 才读取指定交付包。测试在 `output/learning-parsed-real-handoff-20260920/isolated-*` 建立新账号/SQLite，原件身份与全页几何来自真实原 PDF，绝不使用原有用户目录或评测库。数据库内测试材料/解析正文最终清除，包本身只读保留。

| 原件 | 总页数 / 本次物理页 | 实际导入方式 |
| --- | --- | --- |
| ZH 动手学深度学习 | 813 / 66–71 | 31.16 MiB 且超过 200 页，产品 inspector 仍拒绝 pdf_too_large；仅测试内部 SQL 导入原始 BLOB/完整元数据 |
| SL Berkeley Statistics | 53 / 17–20 | 本地正式 inspector + repository |
| DC BERTology | 25 / 2–5 | inspector 仍拒绝 pdf_incomplete；PDF.js 报 `Name token is longer than allowed by the spec: 139`。仅测试元数据读取后入 repository，不算产品上传通过 |
| CA Calculus | 706 / 4–6 | inspector 仍拒绝 pdf_page_limit；仅测试内部 SQL 导入 |
| SC 手写扫描页 | 1 / 1 | 本地正式 inspector + repository；显示/来源定位不等于识别质量通过 |

所有 5 份都保存为独立真实材料 ID；服务 document ID 在 upstream_document_id，本地解析尝试用独立 UUID，每份三阶段分别为版本 1/2/3。4 份只处理选页，whole_document_processed=false；SC 全一页为 true 也不证明内容完整。

原始 raw/normalized 内容逐块一致，4 个脚注、3 个公式编号、角色、阅读顺序和全部 241 个区域保留。server 非 UUID 块 ID 留在 provenance，本地 UUID 按解析尝试命名空间稳定生成。保留像素 bbox，读取时按实际 render 尺寸计算 normalized_bbox；单页索引 0、选页 PDF 页和原件物理页分别存储。

| 快照 | unverified | warning | blocked | verified | 自动 / 文字层 / 既有视觉问题 |
| --- | ---: | ---: | ---: | ---: | --- |
| automatic | 172 | 69 | 0 | 0 | 69 / 0 / 0 |
| with_text_layer_signals | 172 | 69 | 0 | 0 | 69 / 2 / 0 |
| with_prior_visual_review | 167 | 65 | 9 | 0 | 69 / 2 / 21 |

这是保留既有质量结论，未重新评判。文档/页汇总声明保留供审计，不转成整个学习页不可用。inspectParsedScope 保留页面缺失、未选/未解析页与块问题；ZH-70 的无块遗漏仍阻断该范围，ZH-68 不被其连带阻断。

来源检查另用 `validate-learning-parsed-geometry.py`，把 SQLite 读回的 241 个框画到实际原件物理页。18 页均渲染，并与既有单页输入、连续选页 PDF 同参数比对：16/18 页逐像素相同。DC-02/DC-03 各在 2,005,644 像素中有 5/2 个不同像素，最大通道差 15/11；**严格像素相等断言退出 1，保留该失败，不调整阈值冒充全等**。已人工查看 DC-02、DC-03、ZH-67、SL-18、CA-05、SC-01 的原件/读回框/交付渲染/原叠图，未见错页或整体坐标偏移；这只核对定位，不核验 OCR 语义。最终通过的读回来源几何与渲染所用几何 241/241 相同。

```powershell
$env:LEARNING_PARSED_HANDOFF = 'C:\Codex\learning-parsed-handoff\20260920-115054'
node node_modules/vitest/vitest.mjs run src/lib/server/learning/paddle-handoff.integration.test.ts src/lib/server/learning/parsed-document.test.ts src/lib/server/learning/repository.test.ts src/lib/server/learning/pdf-repository.test.ts src/lib/server/learning/pdf-inspect.test.ts src/app/api/learning/learning-routes.test.ts src/app/api/learning/pdf-routes.test.ts src/components/learning/learning.test.tsx --exclude 'output/**' --reporter=verbose --reporter=json --outputFile.json=output/learning-parsed-real-handoff-20260920/tests-final.json
node node_modules/vitest/vitest.mjs run src/lib/server/learning/paddle-handoff.integration.test.ts src/lib/server/learning/parsed-document.test.ts --exclude 'output/**' --reporter=verbose --reporter=json --outputFile.json=output/learning-parsed-real-handoff-20260920/tests-binding-final.json
node node_modules/typescript/bin/tsc --noEmit --incremental false --project output/playwright/learning-stage1-focused-check-1789872819470-23120/tsconfig.json
node scripts/validate-learning-stage1.mjs check
# Python uses bundled Pillow and local Poppler; no installation or network.
python scripts/validate-learning-parsed-geometry.py --handoff C:\Codex\learning-parsed-handoff\20260920-115054 --sources output/learning-parsed-real-handoff-20260920/roundtrip-sources.json --output output/learning-parsed-real-handoff-20260920/geometry
```

Vitest **8 文件、95/95 PASS，退出 0**（真实交付 suite 8，合成 core 44，其余 PDF/TXT/接口/UI 相邻 43）。最后补齐输入/选页元数据进入来源指纹后，定向复验 **2 文件、53/53 PASS，退出 0**（真实 suite 8、合成 core 45）；未重复全组，不能把两次数量相加成独立样本。最终聚焦 tsc PASS；当前全部 src 的 typegen PASS、tsc 退出 2（包装脚本 1），仅原有 Daily Reflection `routes.test.ts:1448/1474` 两处 TS18048，未过滤新增错误。早期 Vitest 启动 EPERM；首轮 DC 校验失败导致 setup 失败；一次大 Buffer 结构比较阻塞后主动中断并改用完整字节 SHA-256；读回 723 次来源校验耗时约 10 秒，先触发默认 5 秒用例超时，按实际工作量设置该例 30 秒后通过。没有放宽产品校验、质量门槛或断言内容。

真实多区域合并、旋转/非零裁剪、失败页响应和正向 verified 证据：本交付未覆盖。当前 adapter 对无旋转/裁剪变换依据的输入明确拒绝；对未交付的失败页形状不猜测，core 本身的失败页/多区域测试仍是合成证据。只有出现实际新形状/变换交付后再扩展这个小型 adapter。详情 JSON 每项最多 16 KiB，仍受总结果 8 MiB 限制；超限拒绝不截断。

未新增依赖/migration/平台。实时 HTTP、完整浏览器上传、真实 OCR/ASR/Provider、生产、框架/Quiz、production build、全仓 Vitest 均 NOT RUN；没有 Next route/config/UI/bundling 改动，本轮不触发 build。没有连接服务器，没有重新运行包内映射规则或质量评判脚本。

## 2026-09-22：完整 PDF 服务的学习侧接入

应用侧继续使用 `learning-parsed-document/2`；新增 `adaptPaddleServiceResponse` 对接实际 `ocr-pdf-trial-0.1`，旧离线草案适配器不改含义。服务 ID 仅作关联，本地账号、材料原件 SHA、解析尝试版本、原始物理页仍由 repository 核对。保存 raw service checkpoint，保留 parser/model/profile、原始文字、所有 source_regions、实际渲染尺寸与来源几何；不把 publishable 当 verified。

学习 SQLite 从 schema 7 加法迁移到 8，只增加学习材料的选页/排除区域范围和逐页请求 checkpoint；不改变旧材料与成果。每页一次请求，收到的完整响应先持久化，再适配；成功页可被明确的新恢复版本复用，失败页才重新处理。网络未知或中断在 submitted 状态时不自动重提，同页新提交也被阻止。交付服务状态查询不返回完整正文，未知结果恢复仍需要核对原请求和取得结果，不能假装可以自动恢复。解析失败保留 PDF 原页。

`LEARNING_PDF_SERVICE_URL` 只接受 `http://127.0.0.1:<port>`；`LEARNING_PDF_SERVICE_TOKEN` 仅通过服务端进程配置注入。`LEARNING_PDF_KNOWN_FINDINGS_FILE` 是本试验的必要配置，绑定原件 SHA、物理页、服务版本及模型的已知负面证据，不能生成 verified。它是明确的已有复核记录，不是新自动识别能力。当前路径用于获准的单用户受控试验，不宣称生产多租户。

学习使用 PDF 前明确保存物理页、排除块、未核实确认及告警选择。blocked 和页面遗漏不能放行；空图片等必须明确排除，范围说明保留排除页/区域，不宣称整章或全文覆盖。普通未核实文字可经用户选择用于学习，不要求所有内容逐块人工核验。标题与所有引用仍带不可变解析版本、物理页、block 及来源指纹；历史引用按旧版本回看，后续新生成不得悄悄改用另一版。

原页区域按每页实际渲染尺寸归一化，再按当前显示尺度叠加；目前只接受交付已建立的零旋转、原点为零裁剪几何，不猜未知变换。删除材料清除本地原件、范围、解析结果与 raw checkpoint，保留历史学习成果并使来源失效；晚到响应无法重建记录。完成 HTTP 响应后调用该请求的 `/results/{id}` 清理远端结果，不调用会停止整个实例的取消接口；清理失败保留 checkpoint 状态。交付服务本身不保证生产稳定或 OCR 语义正确。

本轮验证证据和独立调用账本位于 `output/learning-real-pdf-20260922/`。真实调用与人工内容审阅结论以该目录实际结果及对话交付为准；本文的实现说明本身不是实时联调通过证据。

### 本轮实际验收结论（2026-09-22）

本地学习实现、隔离数据回放与浏览器流程通过；**实时 PDF 学习整体验收 BLOCKED**。本轮两次获准服务启动均达到 ready，但本地 runner 的转发就绪时序、manifest CRLF/LF 哈希前置检查分别阻止了实际请求。两处已修复并保留失败证据；没有第三次启动。两次 stop 均 cleanup_verified=true。OCR POST/处理页/区域请求、真实 DS、ASR 均为0；不能将交付文件回放说成实时成功。

- 聚焦与相邻：22文件269/269；最后解析服务边界追加测试12/12，均退出0，不累计为独立用例数量。
- 完整当前src TypeScript（含测试）退出0，历史两处错误未复现；最终build退出0。
- 原有框架/追问/笔记14项、Quiz10项模拟浏览器回归通过。PDF浏览器8项通过，但采用交付HTTP JSON回放和3次明确模型mock，实际原件上传/登录/SQLite/来源/删除使用真实本地代码。
- SL物理17页与DC物理2页离线共23块、23区域保存读回；人工检查原页叠图。DC已知belied→believed页面问题阻止学习使用，来源定位正确不代表OCR正确。真实多区域合并与旋转/非零裁剪未验证。
- schema迁移、账号隔离、范围/版本绑定、删除和晚到由实际本地测试覆盖；生产和完整实时生成未验收。完成实时目标需要额外一次服务启动授权，不能仅凭剩余OCR/DS请求额度再启动。

## 2026-09-22 追加一次启动授权后的实时学习验收

本次实际请求已经执行，不能与上节的“零请求、离线通过”混为一轮。独立证据在 `output/learning-realtime-pdf-20260922/`：71/71 handoff 文件、两个固定原件及落盘 manifest 字节检查通过；本地账号/数据库/浏览器上传和适配12例先完成，再启动唯一的 session-9。

- 实时 `/parse-pdf` 2次，HTTP200，原物理17/索引16/选择索引0与物理2/索引1/选择索引0；两页9+14块、全部23区域保存读回。服务器自然产生21次区域识别，零重试。两份均仅处理选定1页，不声称完整文档覆盖。
- 普通页7个主内容块经原页对照用于本次学习，页脚与空图片明确排除；全部仍为unverified。BERTology当前实际输出仍有belied→believed，既有页面blocked保留，真实范围保存请求被拒绝；不是新自动检测能力。
- DS3次：框架发布1章3节点；初次Quiz因evidence中段落7未进入该题sources被拒绝；只补通用“全部evidence.source并集及逐选项依据”约束并通过3文件33例后，第三次定向请求发布3题。两次Quiz材料/设置完全一致，失败与前后Prompt/响应保留，未放松发布检查。usage总9536 tokens，无缺失记录，无第四次调用。
- 真实框架7处与Quiz5处来源通过API逐项读回，解析版本/块hash/文字/物理页12/12匹配，原页区域人工查看。框架保留相关信息限定；Quiz质量仍PARTIAL：第二题的归属关系缺显式标题段引用，第三题逐选项evidenceIndexes未完整对应其使用的段落7，且三题答案均A；不能以发布或引用可达代替内容充分性。
- 浏览器完成真实上传/解析进度/风险查看/框架/Quiz；本地测试脚本发生换行比对、CDP请求登录态与重复弹窗处理问题，均保留失败。已从同一隔离SQLite重新登录，恢复原选择/提示/提交，完成三题逐题反馈、刷新/重登、原页区域回看与UI删除；恢复阶段禁用全部外部调用，没有重生成或换成mock。
- 删除后原件BLOB和解析正文清空，来源缓存与范围记录为0，1章、已完成题组及作答保留，来源410/按钮不可用，新生成拒绝；已失败题组也保留。实际测验模式NOT RUN：当前每组一个作答，不另生成一组消耗预算。
- session-9 stop确认cleanup_verified=true，所属进程/GPU/监听均0；SSH转发已结束。公司ASR保持独立BLOCKED，没有请求或部署。

本次是受控两页的实时工程闭环；OCR整体、复杂PDF、任意旋转/裁剪、多区域合并语义和Quiz内容全面正确均未获得验收，更不是首版或生产READY。最终类型/构建与退出证据以本轮对话报告及目录中最终记录为准。

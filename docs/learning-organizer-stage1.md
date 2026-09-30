# 学习整理：阶段 1 文本材料闭环

后续状态（2026-09-21）：当前能力见 [学习框架及 DS/ASR/PDF 接入](learning-organizer-text-framework.md)，账号库升至 schema 5。DS Pro 与公司 ASR 学习专属路径已本地实现和模拟验证，BERTology 已通过本地原件校验及浏览器上传/查看；真实 DS/ASR 尚未调用。下面“未接入框架/录音、只有合成解析”等是当时阶段记录，不能替代当前代码与本轮报告。PDF 解析服务、追问和 Quiz 仍未接入。

本文前半保留阶段 1 的实现与当时验证记录；当前新增的 PDF 原件保存和原页查看见文末“本地 PDF 扩展”。历史的“PDF 未执行”不代表本地 PDF 扩展未实现，PDF 原页可看也不代表 OCR 已接入。

2026-09-20 后续本地后端已增加 [ParsedDocument 消费边界](learning-organizer-parsed-document.md)：账号库 schema 2 可以接收标准化解析结果，支持多版本、质量筛选、物理页/区域来源和删除失效。本文下方 schema 1、没有解析副本的描述是 PDF 阶段历史；真实 OCR、解析服务接入和学习生成功能仍未实现。

同日草案同步进一步升至 schema 3：分开记录请求/成功/失败页，支持多来源区域和四态质量；verified 必须匹配当前核验记录。原自动质量筛选改为必要条件检查，尚不决定完整生成政策。实际 server 映射 JSON 尚未交付到本地，当前只有合成契约验收；详情以链接中的当前契约为准。

本轮实现不等于学习整理首版完成。首版目标仍包括常见教学 PDF、上传已有录音、可编辑章节框架与总览、持久知识点追问、单选 Quiz 与作答记录；本轮没有模型配置、Provider 链路或模拟生成结果。

## 当前可用

- 首页第四入口“学习整理 · 试用中”，复用登录、账号邀请范围、产品切换和账号菜单。
- 创建、列出、重新打开自己的学习页；粘贴文本或批量导入 UTF-8 TXT，先加入待保存批次，再统一保存，之后可追加。
- 查看连续原文或按空行划分的段落，段内换行保留。原文位置可放在学习页 URL 中，刷新或重新登录后重新校验访问权限。
- 勾选多份材料并显式保存本次范围。保存成功后可刷新恢复；未保存草稿只在当前页面，离开或刷新会清空，界面明确提示。
- 删除材料或整个学习页，删除前说明当前实际范围及已确认的未来成果保留规则。
- 单份最多 1 MiB、每批最多 4 MiB / 16 份，属于文本读取和事务的请求保护，不是学习页内容上限，也不是 Work 的主列表限制。需要更大材料时先记录实际大小与阻塞，再调整有证据的请求边界；本轮不预建分布式存储。

## 保存、来源与隔离

`requireAuthContext` 提供登录账号及账号数据目录。`LearningRepository` 在该目录下使用独立的 `learning-organizer.sqlite`，复用已安装的 better-sqlite3；只持久化学习页、原始文本材料及选中状态两个当前所需表。共享 JsonStore 的逐文件写入不足以保证跨进程的批量保存与删除事务，因此本阶段没有把来源、索引和状态拆成多份 JSON authority。

粘贴文本保存其 UTF-8 字节，TXT 保存上传字节（包括 BOM 和换行）。严格 UTF-8 解码；空白、非文本控制字符、超限及非 TXT 文件拒绝，整批均不保存。段落及偏移在读取原件时由普通代码计算，没有独立解析缓存或来源索引副本。原文以 React 文本呈现，文件中的代码、指令和 URL 不会执行。

学习路由只使用学习 repository，不调用 `/api/uploads`、ASR、模型、分析、队列、Memory、Person 或通用检索。API 每次检查账号、学习页及材料归属，响应 `private, no-store`。不接受客户端提供账号目录或存储路径。

客户端为一次创建/保存生成稳定标识；同标识同内容可安全重试，同标识异内容拒绝。批量保存使用 immediate transaction，任一项失败全部回滚。追加只添加新材料，不重写原文或已保存范围。范围更新校验页面修订号，失效保存不覆盖并发操作。

删除材料在同一事务中清空正文、标题、文件名及内容指纹，取消选择；只保留拒绝迟到提交所需的删除标识。删除学习页清除材料行，保留不含正文的页面删除标识，阻止旧创建、追加或范围请求恢复内容。SQLite 启用 secure_delete、DELETE journal 与 FULL 同步，避免持久 WAL 中留存来源副本；这不是对文件系统备份或介质取证擦除的承诺。

## 已确认、留待相应阶段实现的保留规则

1. 原始音频保留至用户主动删除材料或整个学习页，不因 ASR、框架或 Quiz 完成而清理。临时文件分开管理，清理不得破坏原件与必要恢复能力。首版不提供回听。
2. 删除单份材料清除原件、解析内容及生成来源缓存；默认保留框架、总览、个人笔记、知识点对话、题组与历史作答。受影响引用显示“来源已删除”，不得通过旧缓存回看或用于新生成。历史成果不自动成为新出题依据。
3. 删除整个学习页清除全部归属材料及成果；晚到任务不得恢复或发布结果。当前阶段没有这些后续成果或后台任务，不能据本阶段验收声称它们已被验证。

单份材料删除提示固定为：

> 将删除这份材料及其解析内容，但保留已有知识框架、题组和学习记录。相关原文将无法回看，已有成果中可能仍包含材料摘录。

## 后续阶段 0 样本清单（本轮未执行）

| 材料类型 | 最小代表性内容 | 验证用途 | 发送 Provider 的授权范围 |
| --- | --- | --- | --- |
| 教学 PDF | 几十页中文/英文混排课件；双栏、表格、图表、公式、代码各有样例；另有扫描页 | 阅读顺序、术语、公式/图表含义、原页定位与缺失提示；能否先使用不依赖缺失内容的部分 | 先授权具体文件/页做本地解析；视觉/OCR 调用另确认具体页、Provider、允许发出的文字/图像及预算 |
| 已有录音 | 获授权的一节课；先选含专有名词、英文术语、数字与否定词的小片段，并有人工对照 | ASR 关键语义、分段来源、整节课持续处理；原音与临时文件分离 | 明确上传音频/片段、允许远程下载方式、服务商与时长/金额上限；不能从本轮本地授权推导 |
| 多材料组合 | 同一主题的课件、录音和笔记；重复、互补、明确矛盾与跨章节关系各一例 | 章节归属、新材料独立追加、总览更新与用户编辑保护 | 人工先列允许联合处理的材料；文本模型和图像模型的材料范围分别确认 |
| 出题依据 | 可独立回答的单章内容、需联合章节的内容、依据不足/有争议内容 | 人工抽检单选唯一答案、错误选项解释、充分来源；不足时少出题 | 在模型与预算明确后才能试跑，含失败重试总上限；本轮不选择型号、不调用、不自动二次模型审核 |

所有样本应为自行编写、公开且允许该用途或有明确授权的材料；本轮不搜寻或读取私有材料。样本清单不代表已经支持所有教学 PDF。发现缺失关键图表、公式、扫描内容时标记缺口，不补猜。

## 验证入口与证据边界

当前源码聚焦测试需排除 `output/**` 中历史快照的同名文件；不改共享 Vitest 配置。本轮新增测试全部使用系统临时目录和标记为合成的材料。

```powershell
node node_modules/vitest/vitest.mjs run src/lib/server/learning/repository.test.ts src/app/api/learning/learning-routes.test.ts src/components/learning/learning.test.tsx src/components/product-system/product-system.test.tsx src/components/date-companion/companion-modules.test.tsx src/lib/server/auth/session.test.ts src/app/api/auth/routes.test.ts --exclude 'output/**' --reporter=verbose
node scripts/validate-learning-stage1.mjs check
node scripts/validate-learning-stage1.mjs focused-check
node scripts/validate-learning-stage1.mjs build
node scripts/validate-learning-stage1.mjs browser
```

验证脚本直接检查当前源码，每次在 `output/playwright/learning-stage1-*` 新建独立目录；不会复制仓库。`check` 检查整个当前 src，`focused-check` 检查本轮学习模块、共享入口及其依赖。临时 tsconfig 防止共享 `**/*.ts` 扫到历史代码；不改现有 dirty tsconfig。使用环境白名单、跳过本地 .env、沿用并加强既有测试网络 guard，应用数据目录不指向原有用户或评测数据。Next 生成的共享 `next-env.d.ts` 在运行后仅恢复本脚本产生的路径变动。

Browser 通过真实本地认证/API/SQLite 保存合成数据，仅对一次 503 做明确失败注入。聚焦测试、类型检查、build、本地 Browser、真实 Provider、生产验证各是独立证据；实际结果以本轮报告为准。PDF、ASR、模型语义、历史回放及生产验证本轮均为 NOT RUN。

## 阶段 1 文本闭环的历史结果（2026-09-18）

| 验证 | 实际结果 |
| --- | --- |
| 当前 src 聚焦 Vitest | 7 文件、53 用例 PASS，退出码 0；覆盖账号/产品来源隔离、批量回滚、幂等、两连接追加/选择冲突、删除期间迟到请求、原文字节、UTF-8 校验和 UI 恢复 |
| 本轮聚焦类型检查 | PASS；包含 Next 类型生成、本轮组件/API/repository/测试及依赖。最终代码又用同一隔离配置执行 `tsc --noEmit --incremental false --project output/playwright/learning-stage1-focused-check-1789714572828-168248/tsconfig.json`，退出码 0 |
| 当前 src 整体类型检查 | FAIL：未修改的 `src/app/api/daily-reflections/routes.test.ts:1448`、`:1474` 两个 TS18048。没有为本轮顺手修复 |
| 本地 production build | PASS，退出码 0；编译约 6.8 分钟，44/44 静态页步骤完成，167 个 trace manifest 清理后禁止目录引用为 0。Next 的类型门禁过滤测试文件诊断，不能代替上一行整体 tsc |
| 本地 Browser | 10/10 PASS，退出码 0；真实本地认证及 SQLite，合成文本/TXT，明确注入一次 503。保存、刷新、退出再登录、重开、追加、来源段落、跨账号/共享来源拒绝、删除、手机无溢出和零外网/模型路由请求均已检查 |
| 真实 Provider / ASR、PDF、历史回放、生产环境 | NOT RUN |

Browser 证据：`output/playwright/learning-stage1-browser-1789715018742-168192/result.json`，同目录保留桌面、手机与第四入口截图。Build 证据：`output/playwright/learning-stage1-build-1789715086677-169396/`。

过程中如实保留的问题：最初 Vitest 遭遇 Windows spawn EPERM，随后在允许子进程的本地环境运行；默认过滤误纳入 output 历史快照的 44 文件/319 用例结果不用于本轮精确验收。默认 lint 扫描历史输出耗尽 4 GiB 堆内存，之后改用独立的当前源码范围。隔离验证脚本曾因测试 setup 类型缺失和 Next 路径别名失败，均已修正。浏览器发现 Next 内部 localhost 与实际 Host 差异导致同源误拒，已修复并添加回归；以上通过数只计最终对应运行。

## 阶段 1 文本闭环的文件边界

共享修改只有 `PRODUCT.md`、`DESIGN.md`，以及 `src/components/product-system/` 中的 `product-catalog.ts`、`global-product-entry.tsx`、`product-switcher.tsx`、`product-system.module.css`、`product-system.test.tsx`。未修改 Work 业务、模型、ASR、Analysis Core、共享认证、JsonStore 或已有 dirty 配置。

新增文件：

- `src/app/learning/layout.tsx`、`page.tsx`、`[pageId]/page.tsx`。
- `src/components/learning/learning-shell.tsx`、`learning-pages.tsx`、`learning-material-input.tsx`、`learning-workspace.tsx`、`learning.module.css`、`learning.test.tsx`。
- `src/lib/domain/learning.ts`、`src/lib/client/learning-api.ts`。
- `src/lib/server/learning/repository.ts`、`repository.test.ts`。
- `src/app/api/learning/route-utils.ts`、`learning-routes.test.ts`、`pages/route.ts`、`pages/[pageId]/route.ts`、`pages/[pageId]/materials/route.ts`、`pages/[pageId]/materials/[materialId]/route.ts`。
- `scripts/validate-learning-stage1.mjs`、`scripts/learning-stage1-validation-guard.cjs` 和本文档。

另按项目规则只在本地 `UPDATE_HISTORY.md` 追加变更记录，不加入 Git。本轮没有新增依赖、分支、worktree、提交、推送或部署。

## 本地 PDF 扩展（2026-09-18）

本地 PDF 阶段已实现：同一个学习页内批量保存 PDF 与文本/TXT、继续追加、重新登录后重开、显示文件名与物理页数、勾选保存材料范围、原页缩放/翻页/物理页跳转及可返回的页定位链接、删除材料或学习页。扫描样式 PDF 可作为原页显示，不是扫描件识别。框架、总览、追问、Quiz、音频以及 PDF 内容解析仍是首版目标，均未在此阶段接入。

### 原件、迁移和来源

- 继续使用账号目录内的 `learning-organizer.sqlite`。PDF 原始字节与材料记录同一个 immediate transaction 提交，没有原件目录、临时上传文件或第二套索引；保存失败整批回滚，无法产生记录成功但原件丢失的状态。同名文件使用各自材料 ID，不覆盖。文件内容与 SHA-256、不可改写的原件版本 1、物理页尺寸/裁剪框/旋转/userUnit 一起保留。
- 新版 schema `user_version=1` 只为现有材料表增加 PDF kind 与 `pdf_metadata`。首次打开旧数据库时，在单一事务中重建原有 CHECK 约束；保留学习页、材料 ID、原文字节、指纹、时间、已选范围、修订号和删除标识。没有需要用户手动运行的 migration 命令。迁移仅对访问的本地账号库生效，本轮测试没有打开真实用户库。
- `pdf-inspect.ts/inspectLearningPdf` 使用固定程序的短期 Node worker 校验文件签名、结尾、PDF 结构、加密状态、页数、页尺寸及页面绘制内容流。它不抽取或保存文字，不调用 OCR。PDF.js 的内容流错误有时会先返回空绘制列表，因此使用其警告路径，并对解析警告保守拒绝；不能把丢失内容当成验证通过。普通 PDF 因字体等兼容警告被拒绝的可能性仍存在，应由具体授权样本推动改进，不能静默放松门槛。
- 物理页从 1 起，与印刷页码独立。`learning-pdf-viewer.tsx` 使用真实 PDF 字节渲染 canvas；缩放只影响显示，没有把预览尺寸写为 OCR 图片尺寸。后续接 OCR 时，区域坐标仍需使用实际 OCR 图像尺寸、原页裁剪框、旋转和缩放进行转换。

### 依赖与资源边界

新增且精确锁定 `pdfjs-dist@6.3.289`，Apache-2.0；它的可选 Node canvas 包 `@napi-rs/canvas@1.0.9`（MIT）随 lockfile 锁定。依据 [PDF.js 官方入门](https://mozilla.github.io/pdf.js/getting_started/)、[API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) 及安装包许可证核对。现有依赖没有升级。Node 要求同步为 `>=22.13.0`，本机验证为 Node 24.18.0；浏览器验证为本地 Chromium，其他浏览器没有据此宣称通过。

项目此前没有 PDF 校验/渲染库；浏览器内嵌原生 PDF 查看器不足以统一页定位、删除失效与脚本行为，所以新增普通 PDF 依赖。客户端只在打开原页时加载 PDF.js；同版本 worker、字体和图像 codec 由学习专属的鉴权白名单资源路由提供，不依赖 CDN。资源路由不接受原件路径，拒绝路径穿越和 PDF 脚本执行组件。`next.config.mjs` 仅新增 PDF 的服务端外部依赖与这些运行资源的构建追踪。

临时保护：PDF 单份 20 MiB/200 页，每批 5 份且总计 50 MiB；文本原有 1 MiB/份、4 MiB/16 份保持独立。进程内最多两个保存请求，PDF 按份依次检查，每份 20 秒与 256 MiB JS 堆限制、单张图像 1600 万像素，浏览器只渲染当前一页且 canvas 上限 800 万像素。这些用于约束请求字节副本、SQLite 同步事务、图像解码和页面绘制资源，不是课程内容上限，也不是对总进程 RSS 的硬上限承诺。界面显示文件/批次限制，超时、超大图像和不支持的内容明确失败；用户有合法材料受到阻挡时，记录大小、页数、耗时和原因，再决定是否提升限额，当前不预建对象存储或通用任务平台。

### 状态、删除与缓存

原件保存成功显示“原件已保存”；当前页实际绘制成功才显示“原页可查看”；PDF 内容始终标记“尚未解析”。PDF 的文本来源接口返回 `pdf_not_parsed`，不把它作为空文本交给未来生成。没有生成按钮、空 Provider 请求或假结果。400/413/422 的明确失败可移除问题文件再保存；无法确认结果时保留同一次材料 ID 重试，真实浏览器已模拟服务端保存成功而响应丢失的情况。

`.../materials/[materialId]/pdf` 的 GET、HEAD、单段 Range 都先检查登录、账号和材料所属学习页；返回 private/no-store，不生成 public 原件、无鉴权 URL 或长期 Blob URL。原件直接访问使用 attachment 与 sandbox 响应头，应用渲染原页及静态批注外观，没有 PDF JavaScript、链接跳转、表单或附件交互。合成批注的实际红色像素与脚本未执行均有浏览器断言。

删除会在事务中清除原件、PDF 元信息与来源指纹，保留无正文的删除标识来拒绝旧提交；整页删除清除其材料行并保留页删除标识。当前没有持久化解析副本、预览图或 OCR 缓存。浏览器关闭/隐藏/离开时销毁 PDF 读取任务；重新打开、返回或翻页缩放前重新鉴权，通过跨标签页删除通知清空已开预览。不会用应用持久缓存重新打开已删原件。这不承诺撤回用户自行下载到应用之外的副本或擦除文件系统备份。

### 本地验证入口

复用阶段 1 隔离检查器，新增 `pdf-browser` 模式与独立 PDF 场景脚本。所有 PDF 由 `scripts/fixtures/learning-pdf.mjs` 明确合成，账号与数据库在各次输出目录/系统临时目录中隔离。Next 子进程不加载项目真实 .env，外网被阻断；测试结束停止本轮启动的 Next 和 Chromium。输出仅为必要测试证据，没有另建交付报告文件。

```powershell
node node_modules/vitest/vitest.mjs run src/lib/server/learning/pdf-inspect.test.ts src/lib/server/learning/pdf-repository.test.ts src/app/api/learning/pdf-routes.test.ts src/lib/server/learning/repository.test.ts src/app/api/learning/learning-routes.test.ts src/components/learning/learning.test.tsx src/components/product-system/product-system.test.tsx src/lib/server/auth/session.test.ts src/app/api/auth/routes.test.ts next.config.test.mjs --exclude 'output/**' --reporter=verbose --reporter=json --outputFile.json=output/playwright/learning-pdf-tests-final-20260918.json
node scripts/validate-learning-stage1.mjs focused-check
node scripts/validate-learning-stage1.mjs check
node scripts/validate-learning-stage1.mjs pdf-browser
node scripts/validate-learning-stage1.mjs build
```

以后接 OCR 还需要：明确 Provider 与材料发送权限/预算；对原件哈希和物理页建立解析任务输入；保留实际渲染图尺寸并映射来源；持久化解析内容与真实失败状态；提交前重新核对删除标识和版本；删除时清理新增解析副本及生成来源缓存。本阶段没有冻结这些响应字段或实现空调用链，没有访问或等待服务器上的 PDF 质量验证任务。

### PDF 阶段实际验收结果

| 检查 | 本地结果 |
| --- | --- |
| 上述聚焦 Vitest 命令 | 退出码 0，实际 10 文件、74/74 用例通过；包含 Next 配置、既有认证/四入口/文本、真实 PDF 校验、迁移、两连接并发、事务回滚、删除、GET/HEAD/Range 归属与请求资源限制 |
| 学习模块类型检查 | 退出码 0。最终命令 `node node_modules/typescript/bin/tsc --noEmit --incremental false --project output/playwright/learning-stage1-focused-check-1789729398826-186052/tsconfig.json` |
| `node scripts/validate-learning-stage1.mjs check` | 当前 src 全量 tsc 退出码 2（包装脚本退出 1）；仍只有 `src/app/api/daily-reflections/routes.test.ts:1448` 的 detail 和 `:1474` 的 deleted 可能 undefined，两个 TS18048。本轮未改这些文件，没有过滤新增错误 |
| `node scripts/validate-learning-stage1.mjs build` | 退出码 0；最终编译约 7.0 分钟，44/44 静态生成步骤，169 个 trace manifest 清理后 forbiddenAfter=0；两条 PDF 路由的解析器、worker、字体/字形表、图像解码器、ICC 和本地 canvas 依赖都在清单内，缺失文件 0。build 不替代上一行完整 tsc |
| `node scripts/validate-learning-stage1.mjs pdf-browser` | 退出码 0，12/12 场景通过；真实本地登录、API、SQLite 与 PDF canvas，合成材料。检查实际批注像素、扫描样式原页、旋转/裁剪/缩放、刷新与页链接、混合与追加、同名保留、成功响应丢失后幂等重试、重新登录、来源隔离、跨标签页删除失效。零外网/OCR/ASR/模型路由请求，零 pageerror；桌面和手机截图已查看 |
| 真实教学样本、OCR/ASR/Provider、服务器、历史回放、生产环境 | NOT RUN；没有相应调用或访问 |

最终证据：`output/playwright/learning-pdf-tests-final-20260918.json`；`output/playwright/learning-stage1-pdf-browser-1789731716961-185652/`；`output/playwright/learning-stage1-build-1789731185921-178224/`；整体类型检查在 `output/playwright/learning-stage1-check-1789730408587-182504/`。测试进程已结束，证据保留在 output；不是正式用户内容或生成结果。

验收中修正的问题：Webpack 曾将 worker 的包解析改写为 bundle ID，导致本地服务器无法加载解析器，已改为 Node 原生解析；PDF.js 空绘制列表可能掩盖超限图像的验证已补上警告拒绝；PDF.js 6 销毁 API 和 fixture 类型声明已按实际版本修正。浏览器验证曾暴露重绘就绪与缩放控件标签问题，现已修复；截图额外等待缩放后绘制完成，避免把过渡状态当成原页证据。初次 Windows 子进程 EPERM 属于启动权限失败，授权环境下执行的最终结果如上。

PDF 阶段共涉及 27 份代码/测试/实现文档文件（清单见 `output/playwright/learning-pdf-baseline-20260918/pdf-owned-files.json`），另只追加本地忽略的 `UPDATE_HISTORY.md`。共享文件仅 `package.json`、`package-lock.json`、`next.config.mjs`、`PRODUCT.md` 与 `src/components/product-system/product-catalog.ts` 的必要修改；已有其余 67 份基线文件哈希一致。没有改动 Work 规则、模型、ASR、Analysis Core 或旧的 TypeScript/Vitest 配置；没有分支、worktree、提交、推送或部署。

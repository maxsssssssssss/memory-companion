# Daily Brief「约会陪伴」新 UI 接手指南

## 当前正式入口

正常登录后从产品选择页进入「约会陪伴」，默认打开书页首页 `/date-companion/a`。准备、单次复盘、人物都使用同一套正式书页。四页顶部的「问问 Ta」用于当前已核实的关系，复盘内的「问问这次相处」用于本场。生产源码已删除旧版页面和版式切换。

| 用途 | 路径 |
| --- | --- |
| 登录及首页 | `/date-companion` 登录，`/date-companion/a` 或 `/date-companion/a/home` 打开首页 |
| 准备手帐 | `/date-companion/a/prepare`，`preparation` 打开已有讨论，`draft=new` 打开未发送的新讨论 |
| 已保存的准备卡 | `/date-companion/a/prepare?section=records`，旧 `view=records` 仍可用 |
| 复盘 | `/date-companion/a/recap?recording=<上传ID>` 打开新录音或同关系已保存的复盘，`interaction=<复盘ID>` 直接打开已保存的会面，`segment` 定位原句 |
| 人物和经历 | `/date-companion/a/people`，`/date-companion/a/people/<人物ID>` 及历史别名 `/date-companion/a/person`，原 `section`、筛选和返回参数仍生效 |

旧地址中的 `view=book`、`view=classic` 或 `from=book-home` 不再选择版式。业务 ID、来源定位、允许的返回位置仍按原来的范围与身份校验。常规本机启动和生产构建见 [README](../README.md)，离线准备回归用 `npm run test:prepare-book`。

生产手帐组件在 `src/components/date-companion/prepare-notebook/`，人物剪贴册和问答共用的纸面样式及素材在 `src/components/date-companion/person-scrapbook/`。复盘扉页使用「植物与书脊」，公开植物和纸面素材由 `public/` 提供。独立样稿、旧试接启动器及对应验收文件留在原开发机。

## 发布分支与复验

正式替换提交面向 GitHub 预览分支 `preview/date-return-round-one`。生产部署仍按独立的服务器流程执行。

- 准备手帐定向回归用 `npm run test:prepare-book`。
- 正常登录、上传、复盘保存和历史重开的隔离夹具用 `node scripts/run-date-companion-fixture-e2e.mjs`。追加 `date-companion-toy-sync-fixture.spec.ts` 可复验玩偶替身在上传回执丢失后的恢复。
- 类型检查和生产构建用 `npm run lint` 与 `npm run build`。供应商与隔离数据边界见[验证工具](validation-tools.md)。

本机生产切换构建的浏览器回归为 44/44，最终构建定向复跑为 8/8。玩偶回执恢复夹具通过 13 个检查点。手机模拟曾出现复盘从全文返回后编辑框偶发未返焦，后续复跑通过，失败现场保留在原开发机。准备手帐 R19–R22 已独立复验。真实 ASR 混声与模型质量以既有抽样为准。Safari、真机、软键盘、读屏及实体玩偶未复验。首页继续使用已保存的代表性摘录，整场概括需求暂缓。

## 2026-11-26　约会长期资料撤回与旧库升级

PR #3 修复旧版授权撤回对独立人物依据的误删。Date Companion v13、Memory v14 分别显式升至 v15，已经升到 v15 的库直接适用修后代码。复验从旧版正式准入和 Worker 开始，包含纯授权、独立朋友关系、同一条证据边的双重支持、旧未完成回执与已有 v15 数据。开发修复完成，待独立复验。[复跑命令与数据边界](deployment/companion-withdrawal-verification.md) · [维护窗口与恢复条件](deployment/date-companion-memory-bridge.md)

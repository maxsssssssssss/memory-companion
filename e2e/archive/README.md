# 历史浏览器基线

`date-companion-stage2-fixture.ts` 保留原 Stage 2 联合浏览器断言，依赖当时的登录选择页、复盘交互和长期资料历史口径。复跑需要对应历史工作树和独立夹具。当前运行器会提示该套件的历史状态，Playwright 常规发现也不会运行这份存档。

当前默认书页用 [date-companion-fixture.spec.ts](../date-companion-fixture.spec.ts) 验证正式登录、上传、来源、问答及账号隔离。人物、回收授权及受控整理用 [date-companion-memory-ui-fixture.spec.ts](../date-companion-memory-ui-fixture.spec.ts) 和 Date Companion 的服务、路由及 Memory Bridge 套件核验。历史复盘可重新阅读仅保存本次的会面，长期检索仍只用获准来源。

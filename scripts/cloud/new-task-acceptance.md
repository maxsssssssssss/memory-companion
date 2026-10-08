# Daily Brief：实际新任务恢复验收 prompt

复制下方指令到用户实际新建的Cloud任务；发送前将`__EXPECTED_DEV_CLOUD_SHA__`替换为Environment所选的最终提交SHA。此文件是可版本化验收指令，不是运行日志或既有PASS证据。

---

你在一个用户实际新建的Codex Cloud任务中验收Daily Brief开发环境。期望仓库为`maxsssssssssss/memory-companion`的`dev/cloud`，期望提交为`__EXPECTED_DEV_CLOUD_SHA__`。先检查实际branch、HEAD与Git状态，不因目录名、默认分支或旧报告就假定版本正确。版本偏离时报告具体差异，保留本任务已有改动，不自动reset或切换基线。 若平台按固定SHA检出detached HEAD，记录该状态与dev/cloud目标提交关系，SHA匹配不单独判FAIL。

本轮目标是验证实际恢复后的主要开发能力，完成必要的最小Cloud适配；不重新审计产品架构，不访问真实业务Provider、生产、用户数据、私有服务或公网隧道。遵守AGENTS.md和docs/codex-cloud.md，直接使用当前隔离checkout，不新建常规worktree。允许修复明确的环境/测试工具问题并定向复测；不削弱业务能力或断言，不跳过测试制造全绿，不自动提交/推送、合并、部署或修改已发布Environment。

请连续完成以下验证，记录真实命令、发现/通过/失败/跳过、退出码和耗时。不要只改文档或停在计划。

## 1. 实际代码、工具和配置恢复

记录branch、SHA、Git状态、锁文件哈希、CPU/内存约束；检查Node/npm、项目venv Python/pypdf、SQLite原生模块、Redis、应用实际使用的FFmpeg/FFprobe、系统Chromium与Playwright版本。通过cloudEnvironment选择的PATH查询工具，不依赖准备阶段的手工activate脚本或PATH残留。Node最低22.13.0；pypdf满足requirements。核对安装包与锁文件，不搬运Windows二进制。

检查没有服务由准备阶段提供：3000/6380应空闲，preview/test/Redis应用目录应为空或可证明属于本任务。保留未知进程和数据；只检查配置名称/存在性，不打印秘密或读取业务记录。Cloud入口必须拒绝runtime .env，过滤业务凭据/代理/外部Redis，避免真实Provider fallback。Environment可见性以现有Only me/锁定确认和可访问设置为准。

平台发布版本或内部snapshot ID能查询就记录，不能查询如实标记。用户实际创建的新任务中可用工具/依赖、正确目标代码与独立冷启动是开发恢复的有效证据；不要求获取不可用内部ID。若观察到共享实例或复用数据则明确范围，不能把同会话进程重启声称为另一实例恢复。

快照依赖有效时直接复用；缺工具或锁文件/ABI变化时执行唯一`npm run cloud:setup`并复查。本版安装器限定已验证的Debian13/x86_64；缺系统Chromium、make/g++或Python venv/ensurepip时，需要root或非交互sudo，否则明确报告平台前提失败。当前快照已提供，正常复用不需要sudo；Redis可由官方签名apt包在工具目录提取重建。该入口复用系统Chromium，不下载Playwright浏览器、不创建.env/业务数据、不关闭TLS或扩大业务域名。若必须调整Environment，提供版本化改动和重新保存/发布步骤，不声称已对所有未来任务生效。

## 2. 必要检查与定向测试

先停止本任务占用.next的开发服务，再实际执行：

```sh
npm run cloud:check
npm run cloud:test -- src/components/product-system/product-system.test.tsx src/components/product-system/product-popover.test.tsx src/lib/server/daily-reflection/runtime-config.test.ts src/lib/server/work-review/runtime-config.test.ts src/components/learning/learning-preparation.test.tsx src/lib/server/learning/repository.test.ts
npm run cloud:build
```

先确认上述目标文件存在，零测试不能作为通过证据。各运行入口先做原生工具preflight；`cloud:check`当前包含9项Cloud契约与类型检查，不重复tsc；build保留trace清理。内存密集命令顺序执行，不与预览并行。当前验收默认不重复全量；只有新改动风险或新失败确有必要时才扩大范围，并说明原因。

按`docs/validation-tools.md`需要时执行独立Node/Python合成runner，通过cloudEnvironment生成的进程环境隔离，避免普通worker/queue默认配置偏移。不要运行任何历史real-service/隧道入口。

既有历史事实必须保留：520c4f8基线一次全量发现540文件（536过、2失败、2跳过），6167用例（6157过、1失败、9跳过），历史PDF suite collection failure另有23声明病例未执行。Learning异步callback后来保持原断言修复，定向14/14；不能把历史全量结果改成当前全绿。OCR Python原始36方法中19依赖缺失历史runtime-copy源码，25错误记录包含subtests；17独立合成方法可验证。合成PDF可验证当前adapter/native/storage，但不替代原始历史包的bytes/hash/manifest/provenance或patch anchors，不复制真实用户PDF、不创建C:/假目录。

## 3. 真正的Web/Worker/Redis与数据隔离

实际通过`npm run cloud:dev`启动。保留拥有的supervisor PID，确认Redis PONG、Web未登录/api/auth/me为401、Worker/queue健康及Web/Worker共享存储marker匹配。健康/烟测脚本须使用相同`cloudEnvironment(repo, process.env, true)`，具体调用见docs/codex-cloud.md。默认preview-data为server/queue，并发1、Redis6380及Web3000。

用两个仅本任务创建的合成账号验Learning空页创建/读取；另一账号同ID404、未登录401、列表不泄露。不存真实正文或Provider密钥。浏览首页与/date-companion/a、/reflection、/work-review、/learning，显式使用系统Chromium，阻止非loopback请求、等待客户端就绪，记录HTTP状态/pageerror/外部请求尝试。路由浏览不等于完整ASR/AI/OCR E2E。

必要时运行现有queue-worker-smoke.ts：检查本轮独立合成报告全部断言为true、remoteProviderCalls=0，并记录精确断言数。验证cloud:dev重复启动因端口占用拒绝，且不终止原服务；不能接管未知Redis。

进行三个明确阶段：

1. 空应用数据冷启动，创建本任务合成账号/空学习页及Redis合成sentinel后停止。
2. 保留本任务数据再次启动，确认AOF sentinel、账号/session、SQLite学习页持久化；删除该页后同账号GET应410/page_deleted，列表不含页。
3. 停止全部自有服务，核实合成数据归属后清理本任务preview-data/Redis数据；再次启动，旧session应401、sentinel不存在、新合成账号可建立；最后停止并清理自己的合成数据。

每次向真正的node scripts/cloud/run.mjs dev supervisor发送SIGTERM并确认自有子进程退出和3000/6380释放，不能仅关闭终端。若平台不暴露npm父子PID，允许在记录该限制后直接拥有同一`node scripts/cloud/run.mjs dev`入口完成生命周期检查，并说明与实际npm启动的关系。不要broad pkill、删除未知资料或启动公网隧道。

## 4. 交接结论

给出简短按风险排序的A/B/C/D对照：A有意差异，B能力可用但有限制，C需适配，D阻塞主要开发。明确哪些Cloud已实测可接替、哪些保留Windows/专用环境、哪些仅为历史包缺失或真实Provider未授权。

依据本次实际结果判PASS/CONDITIONAL PASS/FAIL。实际新任务的工具依赖恢复、正确代码、数据隔离、类型检查/目标测试/构建和服务冷启动/停止/重建通过，可作为主要开发可用证据；不可用平台内部snapshot ID不单独构成FAIL。真实Provider NOT RUN也不单独构成普通代码开发FAIL。保留真正失败、未执行项、历史全量失败和平台限制，不宣称全面替代、全量零失败、模型质量或生产验收。

报告当前Git改动、哪些修复仅在本任务、是否需要Environment重新保存/发布，以及开发成果保存下一步。按AGENTS追加本地UPDATE_HISTORY；不要在没有本次授权时自动提交/推送、Publish、合并main/master或部署。

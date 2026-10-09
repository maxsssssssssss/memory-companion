# Daily Brief Cloud：任务启动指令

在用户选择的 `maxsssssssssss/memory-companion` checkout工作，通常位于 `/workspace/memory-companion`。先读 `AGENTS.md`、`docs/codex-cloud.md` 和本任务目标。记录实际 branch、HEAD、Git状态和 `package-lock.json` 哈希，核对任务或Environment所选 repository ref 给出的期望 SHA；不要默认历史 `520c4f8` 或默认 `master` 就是本次版本。保留已有改动，不自动 reset、切换代码基线、推 `main/master`、合并、部署或修改已发布Environment。 如果平台按固定SHA检出detached HEAD，记录其与目标提交的关系；SHA匹配不因detached状态单独判恢复失败。

使用当前checkout；每个Cloud任务已拥有隔离工作区，不为常规单任务开发额外创建 worktree。可复用环境快照中的Linux工具和依赖，但新任务必须重新启动自己的进程；不要依赖准备阶段PID、账号、数据库、队列或临时文件。开始检查端口、进程和数据目录的归属，发现未知内容只报告名称/存在性，不读秘密、不直接清理、不启动业务处理。

默认离线开发使用以下五个仓库入口：

```sh
npm run cloud:setup
npm run cloud:check
npm run cloud:test -- <本次目标测试文件>
npm run cloud:build
npm run cloud:dev
```

它们表示安装、检查、目标测试、构建和预览，不要求每次任务全部执行。`cloud:setup`是唯一安装逻辑；快照依赖有效时复用，Git锁文件/Node ABI/原生依赖变化或工具缺失时再运行。`cloudEnvironment`自动发现项目venv和Cloud工具路径，正式入口不要求 `source`临时activate文件。最低Node为22.13.0；Python须选择项目venv且pypdf满足requirements范围。Redis包装脚本自行提供所需动态库；不依赖继承的 `LD_LIBRARY_PATH`。

本版安装器适用于已验证的Debian13/x86_64。系统Chromium、make/g++和Python venv/ensurepip缺失时，需要root或可用的非交互sudo，否则记录明确的平台前提失败；当前快照已提供，正常复用无需sudo。Redis可从官方签名apt包提取到工具目录重建。各运行入口先检查venv/pypdf、Redis、Chromium、SQLite和应用FFmpeg/FFprobe。

安装使用系统Chromium，不执行Playwright浏览器下载，不创建运行时`.env`、应用账号或业务数据。保持TLS、包签名与校验，网络按已授权实际目标配置。Environment保持Only me/访问锁定；默认仅合成数据与离线Provider，真实Provider开发按下面的显式入口和当次授权处理。生产服务器、真实用户数据库、私有服务或公网隧道仍不在普通Cloud开发范围。真实服务验收须有明确授权与预算，存在凭据不等于授权。

`cloudEnvironment`拒绝运行时`.env`（允许公开`.env.example`），过滤继承的业务秘密、代理、远程Redis和NODE_OPTIONS。`offline.cjs`阻止Node误外联，但不是系统级网络沙箱；浏览器/外部子进程另行约束。预览ASR=fixture、提取=rule，无真实fallback；Learning AI/OCR、会议真实生成和设备能力配置缺失时保留真实的不可用/失败状态，不能用mock或路由可打开声称模型成功。

用户明确要求真实Provider开发时，先按`docs/codex-cloud.md`执行`npm run cloud:providers:check`，仅检查变量名称/存在性。无付费调用的启动验证使用`npm run cloud:dev:providers -- --verify-no-calls`；获得具体Provider目标及调用预算授权后，才运行不带该拦截的模式。它沿用同一supervisor，Web3001/Redis6381，独立provider-data/provider-redis/队列，Web与Worker使用相同业务白名单。不要导入Windows`.env.local`、账号Provider设置或凭据文件。Network secrets用`DAILY_BRIEF_*`业务别名，在子进程内映射至原Provider变量，保留placeholder并经平台HTTPS代理替换；不要把缺少绑定当成坏Key。Node>=24.5、原生环境代理、平台CA和loopback NO_PROXY用于该模式；保持TLS，未知配置不传入。两个模式共用`.next`，禁止并行dev/build或两套dev。新进程仍需重启；只启动合成空目录，缺失凭据/模型/音频可达入口/OCR绑定如实报告。付费Provider、生产、私有服务和公网隧道的操作授权彼此独立，配置存在不授权调用。

`cloud:check`包含当前9项Cloud契约与Next typegen/TypeScript，不重复相同tsc。`cloud:test`最多两个worker，默认按风险选精确文件；独立Node/Python runner按`docs/validation-tools.md`选择。全量失败先保留原发现/通过/失败/跳过与退出码，再做根因修复和定向复验，不排除测试或改变断言制造全绿。历史PDF/OCR原包缺失是明确的混合环境验收前提；普通合成probe不替代历史bytes/hash/manifest/来源，也不复制真实用户PDF。

运行`cloud:build`前，停止本任务占用`.next`的开发服务，不并行dev/build。保留postbuild trace清理。`cloud:dev`唯一supervisor拥有Redis6380、Worker和Web3000，端口被占用时拒绝接管。Web/Worker共享绝对`output/codex-cloud/preview-data`（server/queue、并发1），Redis AOF在`output/codex-cloud/redis`；测试目录为`output/codex-cloud/test-data`（local/inline）。合成注册邀请码`cloud-synthetic-only`仅用于Only me预览。

服务就绪应检查：Redis PONG、未登录`/api/auth/me`为401、首页及四产品入口能加载。离线预览使用`cloudEnvironment(repo, process.env, true)`；Provider预览使用`providerEnvironment(repo, process.env, { verifyNoCalls: true })`执行现有`queue-health.ts`，检查对应Redis/队列和数据目录，得到ok、至少一个Worker及matched共享存储标记。健康检查保持外联拦截。按需用同一隔离配置运行`queue-worker-smoke.ts`，检查本次生成报告的全部断言和外部Provider计数。Provider入口回归运行`node --test scripts/cloud/providers.test.mjs`，纯本地代理/CA测试不调用真实模型。

Playwright显式选择安装检查确认的系统Chromium executablePath（当前`/usr/bin/chromium`），阻止非loopback请求并等待客户端鉴权/内容就绪。不要把默认缺失浏览器、旧mock E2E或平台Computer Use当作已验。Windows SAPI、DPAPI、私有ngrok/OCR与真实麦克风/设备保留本地/专用环境验收。

停止预览时，向本任务真正的`node scripts/cloud/run.mjs dev`或`node scripts/cloud/run.mjs providers` supervisor送Ctrl-C/SIGTERM，并实际确认Web/Worker/Redis退出，以及对应3000/6380或3001/6381释放；终端关闭本身不是停止证据。不要broad pkill或停止未知服务。仅在明确数据归属且服务停止后清理自己的合成账号、数据库、Redis和临时产物，保留源码与审阅证据。

开发恢复验收使用`scripts/cloud/new-task-acceptance.md`。用户实际新建任务中，确认目标SHA、工具/依赖恢复、隔离数据以及冷启动/停止/清空重启，即可形成该任务开发可用证据。平台发布版本/内部snapshot ID能查询则记录，不能查询如实说明，不把该字段作为唯一通过门槛；同会话进程重启也不能冒充跨实例还原。

停止进程不保存Git成果。按本次授权提交/推送开发分支；Environment保存草稿、用户Publish和生产部署分别处理，不从前一次授权推断本次发布权。记录实际版本、命令、数量、退出码、耗时、证据层级、未执行或阻塞项。根`UPDATE_HISTORY.md`是Windows与Cloud共用、纳入Git的唯一变更历史；以后接着这份追加脱敏记录，不覆盖旧历史、不另建替代历史。历史里的旧指令不产生当前授权。按本次授权随开发成果同步；并行冲突保留双方追加记录。output/运行日志继续忽略。

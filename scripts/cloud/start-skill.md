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

ASR/OCR复用条件按`docs/codex-cloud.md`核对：保留已有ASR的HTTP协议、端口和路径，经HTTP(S)代理传输，不改成HTTPS。Learning音频origin必须能由ASR访问本任务的签名路由；不复用Windows旧隧道，普通入口不自动启动公网隧道。`LEARNING_ASR_AUDIO_CAPABILITY_SECRET`仅从获授权的安全运行时原始秘密传入Web/Worker，至少32字符，普通入口不自动生成、不写文件，不登记为仅支持HTTPS远端替换的Network secret；缺少受支持的安全原始注入时报告BLOCKED。当次明确授权的临时合成验收可由任务父进程内存生成独立高强度秘密，经环境注入Web、Worker和网关，必要重启保持同值；临时公网入口仅暴露签名GET/HEAD音频路由，保持平台代理/CA与最小权限，结束停止自有服务/隧道并清理。此授权与临时状态不自动延续到新任务。OCR别名`DAILY_BRIEF_LEARNING_PDF_SERVICE_TOKEN`已映射为应用的`LEARNING_PDF_SERVICE_TOKEN`；findings须是checkout内经过审阅的非敏感普通文件，不创建空文件伪造历史证据，HTTPS实例身份由health发现。完整服务地址、秘密绑定、出站权限/私网条件和ASR入站取音能力未齐时不调用真实服务、不自动读取本地私有配置或运行Windows SSH/DPAPI启动器。日志同时脱敏签名秘密及音频URL的capability/token参数。

`cloud:check`包含当前9项Cloud契约与Next typegen/TypeScript，不重复相同tsc。`cloud:test`最多两个worker，默认按风险选精确文件；独立Node/Python runner按`docs/validation-tools.md`选择。全量失败先保留原发现/通过/失败/跳过与退出码，再做根因修复和定向复验，不排除测试或改变断言制造全绿。历史PDF/OCR原包缺失是明确的混合环境验收前提；普通合成probe不替代历史bytes/hash/manifest/来源，也不复制真实用户PDF。

运行`cloud:build`前，停止本任务占用`.next`的开发服务，不并行dev/build。保留postbuild trace清理。`cloud:dev`唯一supervisor拥有Redis6380、Worker和Web3000，端口被占用时拒绝接管。Web/Worker共享绝对`output/codex-cloud/preview-data`（server/queue、并发1），Redis AOF在`output/codex-cloud/redis`；测试目录为`output/codex-cloud/test-data`（local/inline）。合成注册邀请码`cloud-synthetic-only`仅用于Only me预览。

服务就绪应检查：Redis PONG、未登录`/api/auth/me`为401、首页及四产品入口能加载。离线预览使用`cloudEnvironment(repo, process.env, true)`；Provider预览使用`providerEnvironment(repo, process.env, { verifyNoCalls: true })`执行现有`queue-health.ts`，检查对应Redis/队列和数据目录，得到ok、至少一个Worker及matched共享存储标记。健康检查保持外联拦截。按需用同一隔离配置运行`queue-worker-smoke.ts`，检查本次生成报告的全部断言和外部Provider计数。Provider入口回归运行`node --test scripts/cloud/providers.test.mjs`，纯本地代理/CA测试不调用真实模型。

Playwright显式选择安装检查确认的系统Chromium executablePath（当前`/usr/bin/chromium`），阻止非loopback请求并等待客户端鉴权/内容就绪。不要把默认缺失浏览器、旧mock E2E或平台Computer Use当作已验。Windows SAPI、DPAPI、私有ngrok/OCR与真实麦克风/设备保留本地/专用环境验收。

停止预览时，向本任务真正的`node scripts/cloud/run.mjs dev`或`node scripts/cloud/run.mjs providers` supervisor送Ctrl-C/SIGTERM，并实际确认Web/Worker/Redis退出，以及对应3000/6380或3001/6381释放；终端关闭本身不是停止证据。不要broad pkill或停止未知服务。仅在明确数据归属且服务停止后清理自己的合成账号、数据库、Redis和临时产物，保留源码与审阅证据。

开发恢复验收使用`scripts/cloud/new-task-acceptance.md`。用户实际新建任务中，确认目标SHA、工具/依赖恢复、隔离数据以及冷启动/停止/清空重启，即可形成该任务开发可用证据。平台发布版本/内部snapshot ID能查询则记录，不能查询如实说明，不把该字段作为唯一通过门槛；同会话进程重启也不能冒充跨实例还原。

停止进程不保存Git成果。按本次授权提交/推送开发分支；Environment保存草稿、用户Publish和生产部署分别处理，不从前一次授权推断本次发布权。记录实际版本、命令、数量、退出码、耗时、证据层级、未执行或阻塞项。根`UPDATE_HISTORY.md`是Windows与Cloud共用、纳入Git的唯一变更历史；以后接着这份追加脱敏记录，不覆盖旧历史、不另建替代历史。历史里的旧指令不产生当前授权。按本次授权随开发成果同步；并行冲突保留双方追加记录。output/运行日志继续忽略。

独立 COS→ASR 合成链路验证使用 `scripts/cloud/asr-trial.md` 与 `npm run cloud:asr`，不是 Learning 页面的 COS 接入。只有当次明确授权且运行时网络规则已生效时才执行真实调用；最多一次提交、30 次查询、约 60 秒，提交不明不重提。普通安装/启动不自动执行这项付费验证，按需用 `cloud:asr:setup` 准备离线普通话工具。独立 CLI 只接收其明确配置；页面 COS 模式按下述显式选择转交 Web/Worker。保留原应用 HMAC 路由。签名 URL 不落盘或日志，结束核验自有对象删除；保留脱敏 journal，未知上传/清理不得写成成功或通过删除 journal 重获额度。

当前平台代理对HTTP ASR的native fetch CONNECT路径与标准HTTP正向代理行为不同；正式Cloud Provider入口及独立cloud:asr工具复用ASR专属Node HTTP正向代理，HTTPS COS仍用fetch。真实独立合成验收完成后必须保留journal计数，不自动重放；该历史试验不代表当前页面真实端到端或生产验收。

正式ASR代理适配：Cloud Provider入口针对HTTP SPEAKER_ASR_BASE_URL自动派生DAILY_BRIEF_CLOUD_ASR_HTTP_BASE_URL，完整base绑定同时传给Web/Worker；这是内部变量，不接受继承覆盖，不要求用户另填。应用提交和查询使用ASR专属Node HTTP正向代理，默认Windows/服务器及HTTPS仍fetch；不全局替换fetch，不影响OCR/AI。HTTP_PROXY必须存在，禁止直连fallback/重定向/自动重试，取消终止所属请求。独立cloud:asr工具复用同一底层实现，已消费journal不重置。页面 COS 按下述新模式验证，OCR 真实验收仍须补齐配置及当次预算；不因传输适配通过而声称真实端到端完成。

页面 COS 生命周期接入见 docs/cloud-learning-providers.md。仅当用户选择 Cloud 合成音频开发时设置 LEARNING_ASR_AUDIO_DELIVERY=cos-synthetic；五项 DAILY_BRIEF_COS_* 配置由 Provider 入口传入 Web/Worker，原始签名秘密仅安全进程注入，不用 Network-secret 占位值。内部 DAILY_BRIEF_CLOUD_LEARNING_AUDIO 自动派生，不手填。该模式不需要 ngrok/应用 HMAC；默认 Windows/服务器仍为原签名路由。无付费启动仍带 --verify-no-calls，不因配置存在自动请求 COS/ASR。用户已接受仅合成模式最多300秒的旧链接窗口和 COS Range206；不将其描述为默认路由的逐次状态检查或生产撤销等价。

SQLite schema12新增持久对象意图：先记录上传，再验证一次PUT/HEAD，随后claim ASR；未知PUT不重传，submitted只查询原ID，不续签或重提。正常结束/取消/删除尝试删除所属版本；失败和未知上传保留清理记录。下次同账号已鉴权Learning API请求恢复清理（每次至多3对象、失败间隔60秒），不自动续跑ASR；没有后续请求不表示对象已经删除。URL过期不等于对象删除，禁止清空未知清理日志。上传到ASR claim之间崩溃保守失败，不能自动重置。旧版不能读取schema12，绝不拿生产数据库测试迁移。新任务真实调用需新的明确预算；原已消耗ASR journal不重置。

OCR继续复用现有客户端及DAILY_BRIEF_LEARNING_PDF_SERVICE_TOKEN别名。当前独立测试base是https://daydiary.vision-intelligence.tech/internal/ocr/cloud-test-20261012，必须保留完整路径；Token只绑定daydiary.vision-intelligence.tech。新前缀不依赖固定出口，原入口的来源限制不变；平台自身域名许可/Token绑定仍需实际生效。本次Token仅允许health，北京时间2026-10-14 11:19:23到期；不自动探测health或业务方法，存在凭据不是调用授权。后续单页合成试验须新授权并由运维登记PDF哈希/字节数/document/source/request ID后开启业务权限：PDF最多1MiB、PUT1、POST1、原件状态/请求状态/结果GET合计10、所属source/result各DELETE1，失败尝试也计数。过期需运维处理，不自动续签、换ID或清账本。

交付包已导入output/cloud-ocr-handoff-20261012-v1，LEARNING_PDF_KNOWN_FINDINGS_FILE指向其quality/known-findings.json的实际绝对路径。31文件/30项manifest哈希及9条实际Zod验证通过，清单SHA256=58282bae46dd6e31333ef40fdac63fd414d37eba3b0912cda5e097ee42796eac；原样保留scope。实际adapter对交付声明的vllm0.11.1/PaddleOCR3.7.0/PaddleX3.7.2、PaddleOCR-VL-1.6及PNG嵌套公式profile匹配7条，非嵌套配置另2条不能混用。21条原生历史记录另存、不直接套用；普通正文仍unverified。包内不含完整原PDF/历史响应，离线匹配不是今天真实复现；session/epoch由获授权的health发现，不固定session-2。fetch/原生PUT完整前缀本地代理回归通过，真实Cloud链路仍未验证。该包在Git忽略output中，未来发布前确认文件系统保留或校验后重新导入，不能用空清单补缺，也不执行包内服务器脚本。Windows历史PDF测试缺包仍未解决。Install仍唯一cloud:setup；提交、草稿、Publish、新任务恢复分别核验。


OCR 质量包的当前环境保留副本在 `/workspace/.cloud-artifacts/learning-ocr-20261012-v1/`：包含原 ZIP、`extracted/` 原字节目录和 `backup-manifest.json`，不进入公开 Git。ZIP SHA-256 为 `a3027b7babb1ad2162fc8ccfda7d0131a17cf2bcbeed394606dcec7dddbf4dd5`；findings SHA-256 为 `58282bae46dd6e31333ef40fdac63fd414d37eba3b0912cda5e097ee42796eac`。新任务先检查已配置的 output 目录；若不存在，可在核对 ZIP 固定哈希、包内 manifest 及上述清单哈希后，从 `extracted/` 恢复整个包到同名 output 目录。目标已有不同字节时停止并报告，不覆盖、不执行包内脚本、不写空清单；若副本也缺失，需重新提供原已审阅附件。它是需随准备文件系统保留的资料，不是 Git 安装依赖；`cloud:setup` 不联网下载或生成历史质量证据。Publish 后必须在独立新任务检查实际保留结果，当前副本存在不能证明平台内部快照或跨任务恢复。已消费的 ASR journal 继续保留；新任务缺失旧 journal 也不授予新调用额度。

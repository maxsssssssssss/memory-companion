# Cloud Learning：COS 音频与 OCR 验收

仅限独立 Cloud 任务的合成材料。普通 Windows/服务器仍用应用 HMAC 下载路由；不改变共享 ASR 协议或 Learning 的 Web/Next after() 执行归属，不迁移到 BullMQ Worker。

## 页面 COS 模式

在平台普通环境变量中设置 `LEARNING_ASR_AUDIO_DELIVERY=cos-synthetic`，显式 Provider 入口会将五项已有 COS 配置转交 Web/Worker：

- `DAILY_BRIEF_COS_BUCKET`、`DAILY_BRIEF_COS_REGION`、`DAILY_BRIEF_COS_PREFIX`（固定 `cloud-asr/`）。
- `DAILY_BRIEF_COS_SECRET_ID`、`DAILY_BRIEF_COS_SECRET_KEY`：安全值界面注入原始进程秘密，本地计算签名，不使用代理占位秘密，不写文件/日志/Git。
- `SPEAKER_ASR_BASE_URL`：保留获准地址的 HTTP、端口及路径。不得将 COS 域名填入 `LEARNING_ASR_AUDIO_BASE_URL`。

内部 `DAILY_BRIEF_CLOUD_LEARNING_AUDIO` 由 Cloud 入口派生，不能继承覆盖。未选择 COS 时不传 COS 凭据；离线入口继续过滤全部业务参数。该模式不需要 `LEARNING_ASR_AUDIO_CAPABILITY_SECRET` 或公网音频网关；原应用模式仍需要。

```sh
LEARNING_ASR_AUDIO_DELIVERY=cos-synthetic npm run cloud:providers:check
LEARNING_ASR_AUDIO_DELIVERY=cos-synthetic npm run cloud:dev:providers -- --verify-no-calls
```

第二条只验证配置/启动，真实请求被阻止；获得当次明确 Provider 预算后才移除 `--verify-no-calls`。安装不新增依赖，继续 `npm run cloud:setup`。COS IAM 必须仅允许已批准测试桶 `cloud-asr/*` 的 Put/Get/Head/Delete；不需要 List 或桶管理权限。

### 实际生命周期与限制

1. Learning SQLite 保存原件及规范化分片。新增 schema 12 对象记录只含归属、哈希、随机对象键、上传/清理状态和版本，不保存秘密或签名 URL。
2. 先落盘 PUT 意图，再发送一次私有对象 PUT；Content-MD5、SHA256/归属元数据、HEAD 长度和版本回执匹配后才持久化 ASR 提交意图。没有 PUT 回执不代表 ASR 已提交，也不自动重传。
3. ASR 使用原请求 ID 和短期 GET URL；只有未提交分片上传对象。已 submitted 的恢复只查询原 ID，不刷新 URL、不重新上传、不重提 ASR。完成后发布原有 Learning 时间戳转写，原件仍在 SQLite。
4. 正常结束、失败、取消或删除都会记录清理意图并尝试 DELETE + HEAD404。对象版本在收到回执后绑定到 URL/删除操作。删除失败保留记录；PUT 结果不明时，即使 DELETE/HEAD404，也维持 `unknown`，不能证明不会晚到。
5. 重启后，下次该账号通过鉴权的 Learning API 请求处理遗留清理，包括已删除页面。每次最多三个对象，每条失败至少间隔60秒；不会自动续跑 ASR。不依赖全局 Worker、定时任务或准备会话进程。
6. 在上传与 ASR claim 之间崩溃、或上传结果不明时，后续同一材料分片保守失败为 `audio_cos_upload_unresolved`；不允许盲目重置记录重传。需要明确处理原清理记录，必要时在新授权下重新上传为新材料。这是合成开发模式的能力限制。

**用户已接受仅合成模式的撤销差异**：每个已发出的 URL 总有效期最多300秒，取消/删除时立即尝试清理；网络失败时 URL 可继续使用至到期，已开始的下载无法收回。COS Range 可返回206，原路由的416和逐次任务状态校验不变。URL 到期只撤销下载凭证，不删除对象；未知 PUT 可能留下私有对象，必须保留清理记录，不能删除本地任务数据来假装清理成功。若不能接受此差异，使用默认应用签名路由，不启用 COS。真实数据、生产同等撤销语义、桶级生命周期清理均未授权或验证。

schema 11→12 仅新增对象日志；既有原件、PDF、框架等数据不变。旧代码拒绝 schema12，不能将升级后的数据库直接交回旧版；本次只升级合成临时库，不触碰生产库。

## OCR 配置与真实验收前提

继续使用现有 PDF 客户端，不另写 OCR 协议。所需配置：

| 配置 | 要求 |
|---|---|
| `LEARNING_PDF_SERVICE_URL` | `https://daydiary.vision-intelligence.tech/internal/ocr/cloud-test-20261012`，保留全部路径组件 |
| `DAILY_BRIEF_LEARNING_PDF_SERVICE_TOKEN` | 平台 Network secret，只绑定实际 OCR HTTPS 主机；已有映射到应用 `LEARNING_PDF_SERVICE_TOKEN` |
| `LEARNING_PDF_KNOWN_FINDINGS_FILE` | `/workspace/memory-companion/output/cloud-ocr-handoff-20261012-v1/quality/known-findings.json`；新 checkout 路径变化时据实调整，先检查原文件哈希，不生成空数组代替 |

epoch/instance 由 health 实际发现，不要求手填。源码已有互斥连接配置规则；Cloud 不继承 Windows config/token 文件。health 必须验证服务、资源策略、实例及 `pdf_source_transport v1`，不能只看 HTTP200。

到网关的出站规则与网关允许 Cloud 来源是两层条件。`fetch` 的 health/parse/query/delete 与 Node 原生 HTTPS 的原件 PUT 必须分别通过平台代理及 CA；本地模拟代理通过不证明真实 Token 替换、来源放行或上传成功。

**当前真实验收为 BLOCKED**：真实质量包已导入且当前 schema/adapter 离线验证通过；新地址及清单路径仅对齐草稿，运行时尚无 OCR 域名许可与 Token 绑定。服务器交付 Token 目前仅允许 health，北京时间 2026-10-14 11:19:23 到期；允许的方法不是本任务真实调用授权，本轮连 health 也不执行。上传、解析、状态/结果及清理均未开放。未来试验须另行授权、登记单页合成 PDF 的哈希/字节数和 document/source/request ID，再由运维启用业务方法，不能直接打开页面上传去试。

未来网关硬上限：PDF 1 MiB/1页、PUT 1次、parse POST 1次、原件状态/请求状态/结果 GET 合计10次、所属原件和结果各DELETE 1次。失败或明确拒绝同样消耗相应额度。health 上游总上限100次（包含运维已用次数），每Token每秒最多转发一次，不是Cloud剩余额度。未知结果只查询原ID，重启不清账本；到期/撤销不证明远端取消或缓存已删。完整页面音频/AI验收另需预算，不复用旧额度。

### OCR 网络交接（2026-10-12，未连接服务器）

Server deploy 的 `session-2` ready、应用服务器 HTTPS health 成功及缺鉴权 401 均为用户提供的服务器侧记录。本任务没有独立验证，也不固定 epoch/instance。模型恢复不等于 PDF 内容正确；服务器交接本轮新增解析页和区域识别均为 0。

本次附件交付独立目标 `https://daydiary.vision-intelligence.tech:443/internal/ocr/cloud-test-20261012`，原 `/internal/ocr` 的来源限制和凭据不变。新前缀由独立、到期的 Bearer capability 准入，不依赖固定 Cloud 出口 IP；它识别Token持有者，不独立识别Codex平台。服务器外部HTTPS/鉴权成功属于附件证据，Cloud真实fetch及原生PUT仍NOT RUN。不得再用固定出口缺失描述本入口的服务器侧阻断，也不将内部代理或一次性IP当白名单。

| 相对完整 base 的路径 | 方法 | 应用传输及有界要求 |
|---|---|---|
| `/health` | GET | fetch；5 秒；检查 ready、服务/资源策略、epoch/instance、source transport v1 |
| `/pdf-sources/{source_id}` | PUT | Node 原生 HTTPS；原始 PDF 二进制、准确 Content-Length；服务声明超时且不超过 600 秒 |
| `/pdf-sources/{source_id}` | GET / DELETE | fetch；原 ID 状态/所属缓存清理；核对完整绑定回执，404 不冒充删除成功 |
| `/parse-pdf` | POST | fetch；单物理页、已有 source ID、`png_nested_formulas`；4 分钟；不跟随重定向 |
| `/requests/{request_id}`、`/requests/{request_id}/result` | GET | fetch；每次 10 秒；只查原 ID，核对文档/原件哈希/页/实例 |
| `/results/{request_id}` | DELETE | fetch；5 秒；只清理所属结果 |

所有路径保留 `/internal/ocr/cloud-test-20261012` 完整前缀及 Bearer 头。PUT 还须保留 `X-OCR-Document-ID`、`X-OCR-SHA256`、`X-OCR-Service-Epoch`、`X-OCR-Instance`，不能改写请求体、截断超时或重定向到另一主机。平台只需获准目标的 HTTPS 出站；不增加 SSH/VPN、ASR、对象存储或其他域名来绕过限制。目前表中仅health在Token服务权限内，其余待运维按新授权开启。

平台域名许可不等于这些路径/方法已经获得服务权限；后者须由网关和受限 Token 落实。拟议真实 smoke 应在传输发送前累计所有尝试，达到 PUT 1 / parse POST 1 / 状态 GET 10 即停止。现有客户端对明确 `accepted:false` 的资源等待有受控再次请求契约，与未知结果不得重提不同；一次 POST 的试验额度也包括这些未接单尝试，不能仅统计成功解析页或直接依赖页面默认循环。本轮没有新增或执行真实 smoke runner。

现有 `providerEnvironment()` 为 Web/Worker 构造同一白名单和 `NODE_OPTIONS=--use-env-proxy --use-system-ca`，保留平台 `HTTP_PROXY`/`HTTPS_PROXY` 与 `NODE_EXTRA_CA_CERTS`。Provider 模式要求 Node >=24.5；离线最低版本和 Windows/服务器默认启动不变。原生 HTTPS PUT 复用 Node 环境代理，无需另写代理 agent、全局替换 fetch 或关闭证书验证。受控 OCR 主机不得被 `NO_PROXY` 排除。已有本地代理测试分别验证八项方法/路径、Token placeholder 和 PUT 字节/绑定头均贯通，缺 CA 时 fetch 和 PUT 都拒绝；这不证明平台代理实际替换 Token 或真实网关来源已放行。

受限 Token 由服务维护方供应给用户，再由用户配置 Network secret `DAILY_BRIEF_LEARNING_PDF_SERVICE_TOKEN`，只绑定最终获准主机；不要交付 Token 正文、通用生产 key 或 SSH key。维护方还应给出非敏感权限范围、有效期、缓存保留/删除规则、上传和解析超时、服务能力及实际 parser 身份。配置存在不产生真实调用授权。

### 质量清单的交付与匹配

现有严格 schema 保留 `originalSha256`、`physicalPage`、`serviceVersion`、`model`、`code`、`message`、`evidenceRef`、`severity`，最多 500 条/256 KiB。读取前检查普通文件及大小，错误只返回 `pdf_parser_findings_invalid`。本轮增加可选字段 `parserScope`：

```text
parserScope.backend   = 审阅确认的 parser.backend
parserScope.paddleocr = 审阅确认的 parser.paddleocr
parserScope.paddlex   = 审阅确认的 parser.paddlex
parserScope.profile  = 审阅确认的完整 parser.profile JSON 对象
```

有 scope 的条目须同时匹配原件/页/服务/模型及完整 scope；JSON 对象键顺序不影响匹配。旧清单无 scope 时仍按原四项匹配，以保留既有本地/服务器兼容行为，**不能用这种兼容性证明跨后端适用**。Cloud 新交付清单应包含经审阅的 scope；不要把旧无 scope 清单直接配置到新后端。未知、缺证据或不同后端条目保留在交接记录中，不改写为当前问题已经复现。

交付包 `cloud-ocr-handoff-20261012-v1.zip` 已原字节导入上述output目录，31文件中30项manifest哈希全部核对一致，清单SHA-256为 `58282bae46dd6e31333ef40fdac63fd414d37eba3b0912cda5e097ee42796eac`。9条全部通过当前实际Zod schema；证据JSON指针及原件哈希/页/模型/scope绑定一致。对声明的 `model=PaddleOCR-VL-1.6`、`backend=vllm0.11.1`、`paddleocr=3.7.0`、`paddlex=3.7.2`、`profile={"encoding":"PNG","retain_nested_formulas":true}`，实际adapter匹配7条（2 warning/5 blocked），排除另2条；非嵌套profile只匹配另2条。没有改scope，也没有把不匹配条目删除。

21条原生Paddle记录另存 `quality/evidence/historical-native-findings.json`，全部标记不可直接用于应用scope，其中6条缺历史精确区域。包内关联/裁剪图片哈希可核对，但不含5份完整原PDF、完整历史artifact和完整vLLM响应，不能独立重算那些原件哈希或宣称今天重新复现。health示例没有完整backend/package/model，7条是对交付声明配置的离线匹配，未来真实响应仍须逐项匹配。`artifact_sha256`不能代替原PDF哈希，区域证据不伪造block ID。

包内服务器脚本仅作为资料保存，未执行；交接文件里的运维操作不授予Cloud权限。包位于Git忽略的output目录，本轮不自动纳入公开仓库。未来Publish前必须确保该原字节包随环境文件系统保留，或从经校验的交付包重新导入；不能只保存一个不存在的路径，也不能宣称Git提交已携带这些资料。Install仍只运行cloud:setup，不在安装时调用OCR或自动下载历史原件。

空数组只表示零条记录；普通正文仍 `unverified`，不会自动变成 `verified`。新增 `pdf-parser-synthetic.test.ts` 的响应明确标为合成协议数据，只验证转换/持久化/匹配，不是 OCR 生成结果、21 条历史记录或历史 PDF 替代材料。

历史 `pdf-parser-service.test.ts` 直接依赖 Windows 交接包的 `source.pdf`/`response.json`，本 Cloud 缺失；普通合成回归不能替代其证据。不得下载真实用户材料、伪造路径或删断言制造全绿。

定向检查包括 `audio-cos.test.ts`、`audio-cos-routes.test.ts`、原音频/HMAC测试、迁移/准备流程、PDF source/config/progress/HTTP测试和 `node --test scripts/cloud/providers.test.mjs`。实际命令与本次结果见共用 `UPDATE_HISTORY.md`；构建前停止占用 `.next` 的所属开发服务。


OCR 质量包的当前环境保留副本在 `/workspace/.cloud-artifacts/learning-ocr-20261012-v1/`：包含原 ZIP、`extracted/` 原字节目录和 `backup-manifest.json`，不进入公开 Git。ZIP SHA-256 为 `a3027b7babb1ad2162fc8ccfda7d0131a17cf2bcbeed394606dcec7dddbf4dd5`；findings SHA-256 为 `58282bae46dd6e31333ef40fdac63fd414d37eba3b0912cda5e097ee42796eac`。新任务先检查已配置的 output 目录；若不存在，可在核对 ZIP 固定哈希、包内 manifest 及上述清单哈希后，从 `extracted/` 恢复整个包到同名 output 目录。目标已有不同字节时停止并报告，不覆盖、不执行包内脚本、不写空清单；若副本也缺失，需重新提供原已审阅附件。它是需随准备文件系统保留的资料，不是 Git 安装依赖；`cloud:setup` 不联网下载或生成历史质量证据。Publish 后必须在独立新任务检查实际保留结果，当前副本存在不能证明平台内部快照或跨任务恢复。已消费的 ASR journal 继续保留；新任务缺失旧 journal 也不授予新调用额度。

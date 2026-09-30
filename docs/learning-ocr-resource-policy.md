# 学习 PDF：资源等待与持续试用运行策略

本文件记录 2026-09-29 的本地实现。**服务端补丁尚未部署，候选 GPU 阈值未实机验证。**
旧 handoff、实验目录、账本和已有材料不变。不能把本地测试通过写成远端已经生效。

## 已实现的本地行为

- 逐页保存和来源绑定仍是原 ParsedDocument 路径。
- 只有服务明确返回与请求/材料/hash/页匹配的 `accepted:false,status:not_accepted` 才可等待后提交。
- `busy/resource_wait` 不代表处理失败，不扣 OCR 页/区域额度；最多等待 10 分钟后保留进度。等待期间只 GET 轻量 health，不反复上传整份 PDF。
- 明确的 `budget_exhausted/session_expired` 分别提示运行预算用完、解析会话结束；不伪装为资源等待，不自动重传。断网不能推断到期。
- 已提交但响应丢失，只在明确继续时查询原 request ID；必须匹配提交前持久保存的 service epoch 和 instance。
- 普通 503、404、断网、结果缺失或实例变化不能变成“没执行”，不换 ID 自动重跑。
- 主流程“继续处理”复用完成页，只处理原范围内未完成部分；刷新、重登和关闭浮窗只读。
- 执行租约及事务 claim 防止重复点击、进程恢复、删除后的迟到结果覆盖现状。
- 原文/质量状态不变；资源等待不会把 unverified 变 verified，也不会排除缺页后声称全文完成。

## 待部署的独立服务补丁

离线生成：

```powershell
python scripts/learning-local/build-ocr-resource-patch.py --handoff C:/Codex/learning-ocr-handoff/20260921-171314 --output output/learning-ocr-always-on-20260929/patch
```

必须使用不存在的新输出目录。构建先核对原 handoff 71 个真实字节哈希，再对明确锚点生成补丁；不修改 handoff。
四个文件：`common.py`、`trial_session.py`、`pdf_service.py`、新增 `resource_policy.py`。

候选配置：

| 项目 | 候选值/行为 |
| --- | --- |
| 启动空闲显存 | 16 GiB；在启动模型前检查 |
| 暂停接纳下一请求 | 空闲低于 2 GiB；已接纳页按原超时完成 |
| 恢复接单 | 至少 3 GiB 连续新鲜采样 10 秒；不根据旧样本恢复 |
| 紧急低显存 | 低于 1 GiB 连续新鲜采样 10 秒，停止本实例 |
| OCR 自身显存 | 16 GiB；初次越界停止接新请求，持续 10 秒再停止本实例 |
| 页/区域/启动账本 | 持续累计；新手动试用配置不设历史 30/500/1 总额截断；可审阅配置支持正整数总额或 null；有限额度仍受校验 |
| 常驻运行期限 | `session_seconds: null`，不因 1 小时或 8 小时到期停止；明确停止或真实故障保护仍有效 |
| 有限会话兼容 | 只有显式正整数期限才进入到期排空，最长 30 分钟；常驻配置不进入期限分支 |

这些值是待验证候选，不是硬件规格。完整 PDF 交付记录峰值约 13.43 GiB；12.15 GiB 属于 VLM-only。
模型/分辨率/显存预分配参数不变；单 GPU UUID、全局锁、单请求并发、每次 30 页和每页 60 区域上限保留。
自身显存计费按 PID+创建时间核实；清理只针对本实例，不能停止 Embedding/Ollama。
内存只保留有限采样窗口，完整日志和单调峰值保留；不要把资源 health 当作完整模型正确性验证。

未接纳响应包含请求身份、`service_epoch/instance`、原件 hash、页范围、原因和稍后检查间隔。
重复 request ID 优先返回既有已接纳状态，不能因 epoch 参数不符而反称“未接纳”。
新请求带 expected_service_epoch/expected_instance；实例换代后在接纳前拒绝。
新增同实例 `GET /requests/{id}/result` 读取已完成的真实响应；404 不证明从未执行。

## 部署及启动边界

`install-ocr-resource-patch.py` 仅供**另行明确授权之后**在既有测试主机执行：
验证本地审阅的 patch-manifest SHA、原 runtime 和依赖/模型 integrity；只创建
`/data/lyc/paddleocr-vllm-trial-20260921-111817/core-learning-runtime-...` 新目录。
旧账本字节必须不变，不复制旧密钥，不调用 freeze_integrity 掩盖不明变更，不自动启动。

部署成功后，才建立本地选择文件（不含密钥）：

```json
{
  "version": "learning-ocr-resource-v1",
  "remote": "/data/lyc/paddleocr-vllm-trial-20260921-111817/core-learning-runtime-20260929-v1",
  "policyManifest": "../patch/patch-manifest.json",
  "policyManifestSha256": "<实际已审阅文件SHA256>",
  "integrityRevision": "<安装回执返回的revision>"
}
```

`LEARNING_LOCAL_OCR_RUNTIME_CONFIG` 指向这个文件后，原启动器的 `start --ocr` 才选新服务。
未提供该配置继续按旧有界试验检查，**不会偷偷创建新批次或清零旧额度**。
启动器从实际鉴权 health 获取 epoch/instance 并仅注入应用进程，禁止复用历史 ready 记录。
当前应用账号目录选择规则不变；配置、启动和新用户操作是不同授权，启动不会提交已有材料。

## 验证分层

本地 Python：候选水位/恢复、防旧样本、准入无副作用、实例变更、账本超过旧额度、PID清理、排空。
本地 Node/Vitest：启动选择完整性、账号与页绑定、等待续页、同 ID 恢复、删除/并发、旧文本/PDF兼容。
浏览器：合成 PDF＋明确本机模拟服务，材料进度与主继续，刷新不重复请求。
远端阈值、真实 OCR、共享 GPU 资源波动：部署前均为 **NOT RUN/BLOCKED**，不得以本地模拟替代。


当前可审阅补丁为 `output/learning-ocr-always-on-20260929/patch/patch-manifest.json`，
SHA-256：`846a430e4866e3dc7e1297e1c947e8a1749ca99c3183d8adad659f592e48b30f`。
用户已明确要求 always on，本包取代旧 8 小时候选配置。旧 patch-final/patch-final-v2 只保留开发证据，不安装多个版本。

## 常驻与可用性的边界

取消计时关机之外，本地启动器需要复用同一已审阅 runtime 的健康实例；已就绪的常驻 OCR 不随 Next/ngrok/本机 SSH 转发退出而停止。新实例在就绪前失败仍只清理本次创建的实例。
显式 `stop --ocr` 才停止保存身份所对应的 OCR，须核对 runtime、PID、出生时间、instance 与 epoch；普通本地 `stop` 只断开本机连接。不能停止其他任务或后来换代的实例。

这是独立驻留进程及客户端复连，不等于已部署开机自启、故障自动重启或高可用系统。未设置无人值守的循环 GPU 重启；真正 OOM、进程失活及保护停服仍需安全处理。服务器常驻部署尚未执行，主机重启后的自动启动与长期稳定性尚未验证。

## 线上应用服务器 → OCR 服务器

线上路径是：浏览器 → 学习应用服务器（登录、材料归属、SQLite和逐页检查点）→ 已授权的 OCR HTTPS 服务。Windows 启动器、ngrok 和本机 SSH 转发只用于开发，不属于线上 OCR 依赖。ngrok 是既有本地 ASR 取音验证工具，与线上 OCR 无关。

应用侧 `LEARNING_PDF_SERVICE_URL` 支持管理员服务端配置的 HTTPS origin，`LEARNING_PDF_SERVICE_TOKEN` 仅在服务端；不接受用户请求里的服务地址。拒绝 URL 内用户名/密码、额外路径、query、fragment，保留正常 TLS 验证和 `redirect:error`，不跟随跳转向其他主机发送材料/密钥。本机127.0.0.1 HTTP仅兼容既有开发转发，不默认放行其他明文网络地址。公司内网若只能HTTP，应先确认部署与网络隔离条件，本轮未擅自放宽。

HTTPS新任务以小体积、5秒上限的已鉴权 `/health` 获取当前instance/epoch，并验证实际协议版本；在上传前将身份写入已有checkpoint，再带 expected_service_epoch/expected_instance。新任务不会永久依赖应用启动时的旧epoch。成功response也必须匹配保存的身份才能发布/删除远端缓存。health失败没有解析POST，保留pending检查点便于明确继续。

已经submitted/unknown的旧请求不改绑新实例。OCR重启后，即使新任务可调用，也不能将旧404解释为未执行；现交付服务jobs索引仍在内存，本轮未扩建跨实例请求恢复数据库。旧未知结果继续保持明确待核对状态，不暗中重跑PDF。

线上待核对/部署（本轮未执行）：

- 明确应用服务器和OCR服务器，以及批准使用的固定HTTPS地址、证书/私有CA、网络访问控制和服务端密钥来源。
- OCR侧按常驻服务独立托管，应用侧不具备启动/停止GPU进程的职责；开机自动启动、受控故障恢复、日志轮转和维护停止需要在获准环境实际配置/验证。
- 网关完整转发原有parse/health/request/result/delete契约，保留Bearer鉴权、不缓存用户PDF或结果、不开放任意文件路径。反代请求体/超时需覆盖当前实际PDF和逐页处理限制。
- 确认应用是可保持任务存活的Node服务、账号数据持久化、删除/晚到保护及重启后的原请求处理；不能将本地mock当成服务器间网络或长期可用验证。

本地已支持这条服务调用路径，不表示已有线上地址、证书、防火墙或常驻服务部署。

## 2026-09-30 实际部署交接与应用配置适配

上述“远端尚未部署”是此前阶段记录。Server deploy 已交付 `core-learning-runtime-20260930-v1` 常驻服务，以及应用服务器来源受限的 `https://daydiary.vision-intelligence.tech/internal/ocr/` 网关。core 本轮从应用服务器的已交付 health 工具确认 ready/允许接单；未重启 OCR，也未以健康检查代替 PDF 业务验收。

应用现在接受安全路径前缀，尾斜线规范化后，health、parse、requests/status/result 和 DELETE results 全部在相同前缀下。拒绝原始路径中的点段、编码路径、反斜线、重复斜线、query/fragment、URL 内凭据，保留 TLS、Bearer、禁止跳转及实例绑定。不能仅使用 URL.origin，否则会丢失 `/internal/ocr`。

运行配置可选择以下一种方式：

```text
LEARNING_PDF_SERVICE_CONFIG_FILE=/etc/daily-brief-ocr/client.json
LEARNING_PDF_KNOWN_FINDINGS_FILE=<应用进程可读的已知质量问题文件>
```

CONFIG_FILE 使用已交付的 base_url、authentication=Bearer、token_file、tls_verify=true、automatic_request_retries=0、instance_binding_required=true；不把密钥复制进 JSON。配置文件必须为绝对路径，最多 16 KiB，密钥文件最多 4 KiB；读取失败仅返回脱敏配置错误。每次操作重新读取密钥，单次任务保持其配置与实例绑定。应用进程须有受控读取权限，不放宽现有 0700/0600 保护。

另一种方式是显式 URL 加 TOKEN_FILE（或已有安全环境 TOKEN）。两种连接配置不得混用，TOKEN 与 TOKEN_FILE 也不得同时指定，避免旧主机地址与新主机密钥错配。管理员应选择一种方式，而非把所有示例变量全部设置。

实际部署差异：本轮发现线上 Daily Brief 进程运行 `/opt/daily-brief/releases/daily-brief-6e34c91`，该版本没有学习页面源码及构建产物，也没有当前 PDF 依赖。不能只填环境变量便声称接入完成；需要独立验收应用或正式审核后的应用版本部署。当前工作区包含其他任务 dirty 改动，不整体覆盖现有线上发布。非应用来源受网关限制，本机浏览器不应直连 OCR 或通过取消来源限制“解决”连接。

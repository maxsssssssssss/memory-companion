# Learning Agent 验收证据记录

用户已确认下载下述上一份返修证据。该临时 ZIP 已从当前分支文件树移除，此目录保留原交付身份与校验信息，不包含新的产品改动。

- 复验业务代码 SHA：`392fb07edd2f31d8299e50cefd34717df22c858c`
- 原 B1–B3 返修证据 ZIP：`learning-agent-v1-1-repair3-392fb07.zip`（2,452,452 bytes）
- 原交付提交：`addc23de0876bc79a522a37cd68f44ceb3377369`，历史仍可追溯。
- ZIP SHA-256：`a99528cb27a07f7cb7465cf9a7b06b9fd736b4f68b9605928701517ed2efa87b`
- 内含 50 项证据及哈希清单，与原交付 ZIP 字节一致；完整命令、失败留存、原证据回放结果及浏览器截图见包内报告。
- [Windows 集中接回步骤](../agent-completion-v1-1-repair3.md)

Cloud 真实 Provider 请求为 0；Windows 新代码真实验收 PENDING。账本沿用 54/67、余 13，不重新 seed、不改预算或原任务状态。合成材料与模拟学生不证明教学效果；来源与语义判断限制保持。

本次移除只清理临时下载文件、更新说明及历史记录，不重写 Git 历史。Windows 保留已下载的证据，仍可固定上述业务代码 SHA 复验。

## 2026-10-21：自然语言入口与 Quiz 可靠交付证据记录

按用户要求，临时 ZIP 已从当前分支文件树移除。本地原始证据保留，以下记录用于核对此前交付身份。

- 原 ZIP：`learning-agent-natural-quiz-c79fbf2.zip`
- 原临时上传提交：`3d354c5c54d14218978764c4847bada0906968eb`
- 对应业务代码：`c79fbf241d5367de191ccd6a92e66fe1636cabf8`
- 分支：`feat/learning-agent-natural-language-quiz`
- 文件大小：19,183,933 bytes（约 19 MB）
- SHA-256：`f45cdfb124998049cc5efeb36e777df69a96ee9803e29fd3211cce0dad83fac8`
- 202 个条目，其中 201 个证据文件及一份 `MANIFEST.json`；清单、长度与 SHA-256 逐项核对。
- 包含报告、完整验证矩阵、命令与日志、公开合成业务投影、浏览器截图及中间失败记录；不包含数据库二进制、账号密码清单、私有配置或依赖目录。
- [实现说明与 Windows 接回步骤](../learning-agent-natural-language-quiz.md)

本次仅移除临时下载文件并更新说明，不改产品代码；验收业务 SHA 仍为上面的 `c79fbf2`。Cloud 离线多轮闭环通过，真实 DS 验收仍为 PENDING，真实 Provider 请求 0。Windows 原始数据与账本不改动，不集成、不部署。

本次使用普通提交移除文件，不重写 Git 历史；此前上传提交仍可追溯。


## 2026-10-21：G1—G5 集中返修证据下载

按用户要求上传以下同一份可移植证据包，便于从 GitHub 下载；不改动产品代码。

- [下载 ZIP](learning-agent-natural-quiz-repair-d84eaa9.zip?raw=true)（30,636,711 bytes，约 30.6 MB）
- 对应验收代码 SHA：`d84eaa97173f9fba88c596c94c04e167603589b2`
- SHA-256：`4dc5c0d7c3c3b966d828da649a9b2f2d034cba960f76d7d90a936f6de15abe0c`
- ZIP 共 160 文件；159 个 manifest 条目全部核对大小与哈希，ZIP 完整性检查通过。
- 包含原 Windows 公开证据包、Cloud 报告、完整验证矩阵、命令/日志、公开合成业务投影、截图及中间失败记录。不含本地业务数据库、账号凭据、会话或运行配置。
- [实现与 Windows 定向复验说明](../learning-agent-natural-quiz-repair.md)

该上传提交只用于交付证据，Windows 业务验收仍固定上面的 d84eaa9 完整 SHA。Cloud 离线通过不等于真实 DS 通过；真实验收 PENDING。原账本、Guard、unknown 和成绩不改动，不集成、不部署。


## 2026-10-21：N1/N2 校验器返修证据下载

按用户要求上传已经交付的原证据 ZIP，便于从 GitHub 下载；本次只增加下载文件和说明，业务代码保持不变。

- [下载 ZIP](learning-agent-natural-quiz-repair2-c6dd171.zip?raw=true)（18,113,869 bytes，约 18.1 MB）
- 对应业务代码 SHA：`c6dd17158df3d6ac57e90c23554089d0eecfac94`
- SHA-256：`afb0f4bc9319617bba28836aa2c91c49b0b51fb66a3763d7e026154fb1ea9659`
- ZIP 共 126 文件；125 个 manifest 条目均核对长度和 SHA-256，ZIP CRC 通过。解压后运行 `node verify-evidence.mjs` 可再次校验包完整性；该校验不代表产品或真实 DS 验收。
- 包含原 Windows 脱敏证据、Cloud 7 题逐项正式回放结果、两轮离线业务/UI 截图、实际命令与完整失败记录；不含业务数据库二进制、登录会话、密钥或私有配置。
- [实现与 Windows 接回说明](../learning-agent-quiz-validator-repair.md)

Windows 业务验收仍固定上面的 c6dd171 完整 SHA；本次上传不会产生新的产品版本。Cloud 真实 Provider 请求 0，Windows 真实验收 PENDING。原数据、成绩、账本与 Guard 不改动，不集成、不部署。

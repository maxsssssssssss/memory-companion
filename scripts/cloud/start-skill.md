# Daily Brief Cloud 开发启动指令

仓库：`maxsssssssssss/memory-companion`。初始开发基线为 `dev/cloud-code`；后续使用 Windows 中枢已同步的最新集成基线及本次功能/修复分支，不硬编码旧 SHA。

先核对实际目录、分支、完整 HEAD、Git 状态和任务目标，读取 `AGENTS.md`、`docs/codex-cloud.md`。保留已有修改，不自动 reset、切分支或另建 worktree。

Cloud 负责代码开发、离线自动验证和获授权的开发分支推送；Windows 负责真实 Provider/设备验收、`main` 合并推送及获授权的服务器部署。默认只用合成数据和离线 Provider，不导入真实 `.env`、秘密、用户数据库或会话，不访问真实 Provider、生产或私有服务，不建立公网隧道。配置存在不产生调用授权。

使用正式入口 `cloud:setup/check/test/build/dev`。工具和依赖可复用，进程必须重新启动；依赖缺失或锁文件改变才重新 setup。项目 Python venv 由入口注入 PATH，无需激活；保留系统 Chromium，不重复下载浏览器。开发预览仅绑定 loopback，构建前先停占用 `.next` 的服务，结束时停止本任务所属进程。

首次基本恢复按 `scripts/cloud/new-task-acceptance.md`；后续按改动风险定向验证，不重复环境审计或默认跑全量历史 PDF 验收。保留四产品与来源/隔离/删除契约；Windows fixture、真实语音/设备及 Provider 限制如实记录，不伪造通过。

完成后在共用 `UPDATE_HISTORY.md` 追加中文记录。按本次授权提交/推送开发分支，交付完整 SHA、变更、实际测试结果及 Windows 待验事项；不修改 `main/master`、合并、部署或 Publish。平台秘密和网络配置的移除须在有权限的环境配置入口完成，不能由代码变更假定已生效。

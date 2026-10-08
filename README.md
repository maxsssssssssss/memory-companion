# Daily Brief / Memory Companion

一个面向长期陪伴场景的语音理解与 Memory Agent 系统。项目将长录音分片转写为可追溯 transcript，在其上构建 Daily Brief、Relationship Signal、生命周期关系、长期 Memory、QA 与 Proactive Insight，并通过 BullMQ / Redis Worker 支持持久调度和恢复。

## 文档入口

- 产品与界面任务：按需阅读 [PRODUCT.md](PRODUCT.md) 和 [DESIGN.md](DESIGN.md)，再追踪受影响入口的当前代码与 contract；无需通读所有历史文档。
- [系统架构说明](docs/architecture/SYSTEM_ARCHITECTURE.md)：面向技术评审、导师沟通和工程交接的完整架构、数据流、验证现状、限制与 Voice Agent 路线。
- [长录音 ASR 分片](docs/architecture/long-recording-asr-chunks.md)：AudioChunk、TranscriptChunk、ASR checkpoint 与 Transcript Merge。
- [统一 Chunk 模型](docs/architecture/unified-chunk-model.md)：AudioChunk、TranscriptChunk、AnalysisChunk 的领域约束。
- [服务器部署](docs/deployment/server-deployment.md)：仅在用户明确授权的服务器任务中使用，涵盖 Redis、PM2、端口和共享 `APP_DATA_DIR`。
- [验证工具](docs/validation-tools.md)：按任务选择现有命令，区分 fixture、Browser mock、真实 Provider 和环境验证及其副作用。
- [早期项目交接](docs/project-handoff.md)、[Work Review Wave 1 交接](docs/work-review-v2-core-contract-handoff.md) 和 `docs/superpowers/plans/`：历史背景与设计依据，不是当前待办或自动授权；使用前核对当前实现。

本分支共享根目录 `AGENTS.md` 执行规则。Cloud 开发请按 [Codex Cloud 启动说明](docs/codex-cloud.md) 使用独立数据和无凭据配置。修改后仍须在当前工作区 `UPDATE_HISTORY.md` 末尾追加中文记录；该历史、`.agents/` 与 `.codex/` 继续忽略，不复制个人 Skills/hooks。

## 常用命令

```powershell
npm run lint
npm test
```

`lint` 已包含 Next.js typegen 和 TypeScript 检查。小步修改优先运行相关测试；全量测试、build 与 E2E 按任务风险和根规则选择。Worker、Queue、Pipeline 命令的连接目标和写入范围见[验证工具](docs/validation-tools.md)，不属于默认的离线检查。

运行前，请根据 `.env.example` 核对 Provider、存储和 Queue 的配置名称及目标环境，不输出秘密。服务器及远程 Provider 操作需要用户的明确授权。不要提交 `.env.local`、音频、SQLite 或 `.data/evaluation/` 运行产物。

# Daily Brief / Memory Companion

一个面向长期陪伴场景的语音理解与 Memory Agent 系统。项目将长录音分片转写为可追溯 transcript，在其上构建 Daily Brief、Relationship Signal、生命周期关系、长期 Memory、QA 与 Proactive Insight，并通过 BullMQ / Redis Worker 支持持久调度和恢复。

## 文档入口

- [系统架构说明](docs/architecture/SYSTEM_ARCHITECTURE.md)：面向技术评审、导师沟通和工程交接的完整架构、数据流、验证现状、限制与 Voice Agent 路线。
- [长录音 ASR 分片](docs/architecture/long-recording-asr-chunks.md)：AudioChunk、TranscriptChunk、ASR checkpoint 与 Transcript Merge。
- [统一 Chunk 模型](docs/architecture/unified-chunk-model.md)：AudioChunk、TranscriptChunk、AnalysisChunk 的领域约束。
- [服务器部署](docs/deployment/server-deployment.md)：Redis、PM2、端口和共享 `APP_DATA_DIR`。
- [验证工具](docs/validation-tools.md)：fixture、Pipeline、Queue Worker 和本地音频 tunnel 验证。

## 常用命令

```powershell
npm run lint
npm test
npm run worker
npm run queue:health
```

本地或服务器运行前，请根据 `.env.example` 配置 Provider、存储和 Queue 环境。不要提交 `.env.local`、音频、SQLite 或 `.data/evaluation/` 运行产物。

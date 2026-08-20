# Date Companion–Memory Bridge 部署与迁移门禁

本文只覆盖 Memory–Date Companion Bridge 的 schema 预迁移和 Worker 启动门禁，不替代完整服务器部署指南。Bridge consumer 默认关闭；未完成备份、预迁移和健康验收前，不得开启。

## 两种命令

```bash
npm run memory-bridge:preflight
npm run memory-bridge:migrate
```

`memory-bridge:preflight` 是默认、严格只读的检查：

- 不创建目录或 SQLite；
- 不执行 migration；
- 精确要求 Date Companion migration 序列为 `1..6`、Memory 为 `1..9`；
- 对两库分别执行 `foreign_key_check` 和完整 `integrity_check`；
- 只输出结构状态、计数和稳定错误码，不输出数据路径、用户正文或 SQLite 原始错误。

`memory-bridge:migrate` 显式传入 `--migrate`，先确认两份数据库都已存在且旧 migration 序列是受支持的连续前缀，再依次执行现有 Date Companion、Memory schema migration，最后重新以只读方式完成同一检查。缺少任一数据库时，它会在迁移任何一库之前拒绝操作，不会创建空库。

## 配置门禁

两个命令都从与 Web/Worker 相同的运行环境读取：

```env
NODE_ENV=production
APP_DATA_DIR=/持久化绝对路径
APP_STORAGE_MODE=server
```

生产环境中的 `APP_DATA_DIR` 还必须位于当前 release/cwd 之外；release 内的 `.data` 即使写成绝对路径也会被拒绝。不要把 `.env.local` 内容复制到日志或部署记录。

项目 Redis 必须使用生产环境已经确认的 `REDIS_URL`。当前服务器部署使用项目自有的 `6381`；绝不能连接或修改环境中已有的 `6379`。Bridge preflight 本身不连接 Redis。

Worker consumer 的默认值与安全范围为：

- `DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED=false`，只接受 `true/false`；
- poll `5000ms`，范围 `1000..300000ms`；batch `10`，范围 `1..100`；
- lease `300000ms`，范围 `30000..3600000ms`；
- retry base `5000ms`，范围 `1000..300000ms`，retry max `300000ms`，范围 `1000..3600000ms` 且不得小于 base；
- shutdown drain `30000ms`，范围 `1000..120000ms`；
- oldest-pending 告警 `900000ms`，范围 `60000..604800000ms`；
- retryable-failed 门槛 `10`，范围 `1..100000`。

任一配置非法时 Worker 启动失败，不会静默换成危险值。flag 为 `false` 时不会打开 Bridge 数据库、claim outbox 或启动额外轮询。

## 为什么必须预迁移

Date Companion v6 会在同一 SQLite transaction 中增加 Bridge/outbox/retention 表，并为已有 Evidence 回填 provenance digest。如果同一来源出现冲突正文，migration 会回滚并返回稳定冲突码。Memory v9 增加 provenance、Person link 和幂等 receipt 表。

两份 SQLite 不能组成一个跨库 transaction。因此必须让 consumer 保持关闭，在生产数据副本上先演练，再于维护窗口单进程迁移；不能让 Web 和 Worker 首次并发触发自动 migration。

## 上线前演练

本次属于“数据或 Queue 变更发布”。在隔离环境中：

1. 复制完整 `APP_DATA_DIR`，包括两个 SQLite 主文件、`-wal`、`-shm`、JsonStore、音频、索引和 queue-runtime 文件。
2. 使用独立的非生产 Redis/Queue 配置；不得让演练 Worker 连接生产 Queue。
3. 保持 `DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED=false`。
4. 在数据副本运行 `npm run memory-bridge:preflight`，记录迁移前 schema 和 integrity 状态。
5. 运行 `npm run memory-bridge:migrate`。
6. 再运行 `npm run memory-bridge:preflight`，必须得到 v6/v9、两库 FK=ok、integrity=ok。
7. 在副本上演练启动唯一 Worker、健康检查、代码回滚和完整数据恢复。

测试成功只能证明副本演练通过，不能描述为生产迁移完成。

## 生产维护窗口顺序

1. 确认目标 commit、lock hash、新 release 构建及聚焦测试均已通过。
2. 保持 Bridge consumer flag 关闭。
3. 停止 Web，阻止新上传。
4. 让唯一 Worker 完成 active Pipeline job；确认 Queue active=0 后 graceful stop Worker。
5. 备份完整 `APP_DATA_DIR`，包括 SQLite `-wal/-shm` 和所有 JsonStore/索引文件。
6. 备份同一时间点的项目 Redis AOF/RDB/卷，并记录旧 release、环境摘要和恢复命令。
7. 验证备份可列出、大小合理，并在备份副本运行 SQLite 检查。
8. 在新 release、同一生产环境中运行 `npm run memory-bridge:migrate`。
9. 紧接着运行 `npm run memory-bridge:preflight`；任一错误均为 No-Go，不能启动 consumer。
10. 只有在本次发布已获准启用 consumer 时，才把
    `DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED` 从 `false` 改为 `true`；随后启动恰好一个 Worker。
11. 运行 `npm run queue:health`，确认 Redis PONG、Worker=1、Web/Worker storage marker matched、近期 Pipeline failed 未增加，并确认 Bridge consumer/health 状态符合 feature flag。
12. Worker 健康后再启动 Web，并再次执行 queue health 和站点验收。

注意：现有 queue storage probe 在 marker 缺失时会进行受控写入，而且 matched 依赖运行中的 Worker Redis summary。因此 storage marker 不能在“Web/Worker 都停止”的离线 migration 阶段证明；它必须在唯一 Worker 启动后验证。

## 结果判定

preflight 的核心结构为：

- `ok`、`mode`、`checkedAt`；
- `storage.directoryVisible`；
- `dateCompanion`、`memory`：可见性、预期版本、完整版本序列、schema/FK/integrity 状态及错误计数；
- `migration`：仅 migrate 模式出现，每库为 `not_started/completed/failed`；
- `errorCodes`：稳定、无正文的错误码。

以下任一情况均为 No-Go：

- APP_DATA_DIR 不是持久绝对路径、不是 server mode 或位于 release 内；
- 任一数据库缺失、不可读或 migration 序列不精确；
- 任一 FK/integrity 检查失败；
- migrate 未显示两库 completed；
- consumer enabled 但唯一 Worker 未运行；
- queue health 的 storage marker 不匹配或 Pipeline failed 增长。

## 回滚

v6/v9 只增加列、表、索引和 outbox/receipt；普通代码回滚默认保留这些 additive 结构，不删表、不清空 outbox，也不手工撤销有效 lease。

如果新版本已经处理真实 Bridge 数据、出现数据损坏，或旧代码不能读取新状态，则必须：

```text
停 Web/Worker
→ 恢复同一时间点的完整 APP_DATA_DIR
→ 恢复同一时间点的项目 Redis 快照
→ 启动项目 Redis
→ 启动恰好一个旧 Worker
→ queue health
→ 启动旧 Web
```

不能只回滚代码，也不能混用新数据和旧 Redis 快照。未经单独授权，不在回滚中删除 v6/v9 表或 Bridge outbox。

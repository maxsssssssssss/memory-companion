# 约会陪伴撤回修复与独立复验

开发基线为草稿 PR #3 的 `28fcc8afc46f19b33d5d85325607fa327d6e42f0`，旧版准入使用 `2b0a3d5685e3febc4b3b26025e3bfc5ad68eb634`。以下结果均来自隔离合成数据。开发修复完成，待独立复验。

## 原问题与数据归属

旧 Worker 和 Person 准入会复用同一条规范录音段证据。Memory v15 在旧桥接行上增加的两个来源标记默认都是 0，不能凭这两个值断定证据专属于约会授权。修前的撤回先判定整条人物证据是否无主，漏查朋友关系的证据边，删除证据主行时外键级联删去该边。SQLite 完整性仍正常，业务回执也能返回 completed。

修复按账号、关系、相处场次与授权回执定位约会投影。处理人物关系时，先核对独立准入审计及其他授权，再解除本次支持的对应边，最后检查规范证据还由哪些来源支撑。Person 和约会 Worker 可以生成同一个关系边 ID。针对历史同边，独立 Person 准入留下的 relationship_candidate 审计明确关联账号、关系及证据，能证明该边有独立来源。

| 隔离输入 | 修前 | 修后应核对的库内结果 |
| --- | --- | --- |
| 已确认朋友关系与约会授权使用同一段 | 回执 completed，朋友依据和边均 1→0 | 朋友依据和边均 1→1，原 ID 和原文保留，约会来源链接 1→0 |
| Person 已独立确认的关系与约会共用同一条边 | 回执 completed，同一条边被级联删除 | 原有 Person 准入审计和边保留，约会主体归属与投影清除 |
| 只有本次约会授权 | 撤回清除依据 | 规范证据、约会证据边和长期投影均 1→0，本场复盘与人物映射保留 |
| 两份授权在 Memory 中支持同一依据和边 | 附加仓储对照 | 规范证据与边均为 1→1→0。第二份投影在 Memory 仓储构造，Date 正式业务对同账号上传有唯一性约束 |

共享原文仍可读时，还要核对关于谁的事实。某项事实若只由此次撤去的约会主体归属支持，其证据边与依赖该归属的状态转移随之撤去。其他来源继续支持的事实或约定沿用其剩余依据。Worker 修补历史投影时先完成重建，再判断哪些旧来源确实失去支持。通用 Memory 作为独立原文时核对账号、上传、段落、来源类型、原句及发布资格。

## 独立复跑

在含上述两个历史提交的干净检出安装锁文件对应依赖，使用项目支持的 Node.js、Git 和 tar。运行第一个命令会在本机新建合成库。每次运行使用独立目录，保留第一次失败。归属建议由本地替身提供，准入、复盘授权、Worker、撤回事务和两库读回均使用各版本实际实现。

```sh
node scripts/companion-pr3-recheck/run.cjs
npm test -- --maxWorkers=2 src/lib/server/date-companion/memory-bridge.test.ts src/lib/server/date-companion/memory-bridge-preflight.test.ts src/lib/server/date-companion/schema.test.ts src/lib/server/date-companion/segment-review.test.ts src/lib/server/date-companion/person-source-catalog.test.ts src/lib/server/memory/db.test.ts src/lib/server/person/person-relationship-qa.test.ts src/lib/server/date-companion/preparation-sources.test.ts src/lib/server/date-companion/proactive-value.test.ts
npm run lint
npm run build
```

脚本将同一对旧库复制为三份，分别交给审查时的版本、直接升级的修复版，以及已由审查版升至 v15 的修复版。逐行结果在 `output/companion-pr3-withdrawal-fix/repro/run-*/`。先看 `summary.json`，再对照 `shared-reviewed.json`、`shared-direct.json`、`shared-from-v15.json` 与相应的 `grant-only` 和 `same-edge` 文件。每份记录含实际撤回回执、按预览版本重放的回执、原映射和来源读回。`pending-receipt.json` 单列旧版未完成回执及旧版反向预检。

共用资料中断后重试见 `cleanup-retry.json`。首个回执为 `retryable_failed`，此时旧授权的使用资格已停止；关库重开后用同一预览重试，原回执完成，独立证据仍在。晚到 Worker、在途撤回、旧回答与新授权版本分别由上述 bridge 和 person-source-catalog 测试覆盖。

开发侧原专项九文件 144/144，其中 7 项为新增回归；相邻九文件 71/71。相邻选择如下。

```sh
npm test -- --maxWorkers=2 src/lib/server/person/admission-repository.test.ts src/lib/server/date-companion/memory-bridge-lease.test.ts src/lib/server/memory/daily-reflection-proposal-admission.test.ts src/lib/server/daily-reflection/memory-admission.test.ts src/app/api/date-companion/memory-bridge-routes.test.ts 'src/app/api/people/[personId]/qa/route.test.ts' src/components/date-companion/companion-qa-paper.test.tsx src/lib/server/person/temporal-facts.test.ts src/lib/server/person/commitments.test.ts
```

## 迁移与发布边界

- 目标仍为 Date Companion v15、Memory v15。旧 Date v13 和 Memory v14 在维护窗口显式升级一次。已处于 v15 的库直接使用修后清理逻辑，无新增迁移或历史回填。
- 仅凭人物、上传、文案相同，无法还原缺失的独立准入历史。旧版已经级联删除的证据及边，须从受控备份和准入记录另行核实。此修复只保护仍存在的资料。
- 旧版未完成撤回回执继续原样保留。新版无法从旧回执续办，须停写、排空在途 Worker 后再次检查回执和逐项状态，有未完成项就暂停升级。
- 上线前仍需最终签署版本在目标 Linux 构建，并在同一冻结点的完整数据备份副本和独立 Redis 上完成升级及恢复演练。恢复写入后应保全增量；回切旧 Worker 需要兼容的旧库和配对队列。[迁移门禁与恢复步骤](date-companion-memory-bridge.md)

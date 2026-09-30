# 学习生成模式对照：继续体验

本次使用同一 `TokenHub Responses / deepseek-v4-pro`，在合成课程的一致性副本中完成 11 次真实请求。旧课程与旧结果保留。**没有找到可据以改用 high 的可靠质量收益**；本地学习默认仍是 `reasoning.effort=none`，未改 Work 或用户默认预算。

## 启动与停止

工作目录：`C:\Codex\daily-brief-source-20260708-122232`。

```powershell
node scripts/learning-mode-comparison/runtime.mjs start --production
```

出现 `Mode comparison runtime READY` 后，在另一终端打开保存的隔离账号：

```powershell
node scripts/learning-mode-comparison/open.mjs
```

登录仍经过真实本地认证；凭据从当前 Windows 用户非仓库 DPAPI 配置在内存中读取。本次数据在 `output/learning-mode-comparison-20260923/data/`。不重跑 `prepare.mjs`。

```powershell
node scripts/learning-mode-comparison/runtime.mjs status
node scripts/learning-mode-comparison/runtime.mjs stop
```

只监听 `127.0.0.1:37921`，最长三小时，不注册常驻服务。关闭体验浏览器。默认保存数据模式禁止 Provider 调用，不启动 OCR、ASR、SSH 或 ngrok。真实对照已结束，不使用 `--live` 重发旧清单；安全配置仍需保留，不复制进仓库或文档。

## 新结果与范围

| 学习页 | 新结果 | 继续使用方式与限制 |
| --- | --- | --- |
| 合成课程 · 纸上展览工坊，`d8c00258-1169-4388-8761-d37db0c6a82a` | `多源材料联合判断：分区、时间与团体通行`，题组 `aef5ec69-ff11-468f-ac91-14c954397cfc` | 保留未完成练习，作答 `cb120bb9-34a2-45ed-8dba-7cefbed5e3da`；第 1 题理由有已知事实错误，仅用于操作体验与问题回看。 |
| 同上 | 笔记任务题组 `7f33e70a-7c83-460c-9a29-30bd0b4a9cfa` | 2 题真实使用显式选入的笔记；继承笔记中有问题的类比，不代表内容已核验。 |
| 同上 | 总览 `4c230031-6675-4bfd-9c35-b99efb7b2f0e` | 原始 3 条关系，发布 1 条，拒绝 2 条；本次 Window 目标关系未发布。历史旧总览仍留存。 |
| 合成对照 · 色卡借阅角，`7e7fb2a9-4b1c-44f0-ac09-70d6544d7fd9` | `色卡借阅角规则题组`，题组 `c3e8c326-e1bf-4aa8-9848-cdb0e0777636` | 3 题测验已最终交卷，作答 `13719b69-b987-4254-abf3-832d3dabb217`；可查看统一反馈与来源。没有增加重做原题入口。 |

主课程入口：`http://127.0.0.1:37921/learning/d8c00258-1169-4388-8761-d37db0c6a82a`。

新短材料入口：`http://127.0.0.1:37921/learning/7e7fb2a9-4b1c-44f0-ac09-70d6544d7fd9`。在已登录浏览器中打开，或从学习页列表进入。

high 最终一次返回了 `effort=high` 和 13,304 个推理 tokens，但达到 16,000 总输出上限后 JSON 在第 3 题中途结束；服务虽报 completed，本地没有发布坏题，也没有将推理当作学习内容。

## 当前限制与证据

- none 的复杂课程题仍有错误选项理由、漏引条件段、ASR 歧义标签不足；不能当成可靠教学答案。短文本中的共同障碍与不确定先后判断较好，但未覆盖全部标准。
- 新短材料的一个案例省略了前文“交回比对单”前提；材料保持冻结，审阅将此列为样本自身的限制，不全归因于模型。
- 新增学习专属可选 `LEARNING_AI_REQUEST_TIMEOUT_MS`，默认仍 120,000 ms，允许 1,000–600,000 ms，发布截止相应增加 30 秒余量。该配置只处理等待与发布一致性，不能保证网络长连接、完整输出或内容质量。隔离复验曾用 600,000 ms；默认启动不改变用户环境。
- 实验用原生 HTTP 读取只在对照脚本中启用，用于排查约 311 秒断开；未替换产品默认传输。传输变动使后续耗时不能单纯归因于 reasoning。
- 5 次收到用量，共 63,931 tokens；另外 6 次用量未知，不能视为零，也不能据此算总费用。

证据目录：`output/learning-mode-comparison-20260923/`。

- `plan.json`、各请求及配对哈希：材料、Prompt、设置冻结；配对请求除 reasoning 外相同。
- `ledger.json`：全部 11 次请求、失败、参数、用量与耗时。
- `review-only/final-review.json`：逐题、逐选项和总览审阅；由 Codex 完成，不是专家 verified。
- `test-complete-D3-result.json`、`practice-open-A2-result.json`、`screenshots/`：真实生成结果的作答、刷新、重登与来源回看。
- `data-audit-*.json`：原库与 55 条历史对象保全；不覆盖旧分数或解释。
- `*-exit.json`：回归、类型检查、构建、脚本和清理的实际退出状态；启动失败记录也保留。

复用的 PDF/录音识别来自历史真实结果，本轮没有 OCR/ASR、服务器或生产验证。此入口用于非生产继续体验，不是学习整理首版或生产 READY 声明。

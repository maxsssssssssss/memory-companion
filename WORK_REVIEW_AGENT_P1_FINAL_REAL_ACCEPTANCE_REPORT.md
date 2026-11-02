# Work Review Agent P1：最终 M3 有界真实验收

日期：2026-10-29（Asia/Shanghai）。**总体结论：PARTIAL。本次真实 M3 的比较、5 项确认保存、待办更新和重开闭环通过；两类错误建议的真实拦截未触发，仍有未闭环提示覆盖缺口。**

本轮只验收，未修改产品代码、Prompt、模型路由或原数据，未重新构建、提交、推送、合并或部署。没有重跑 M2、重试 #287 或创建第二个新 M3 任务。

## 1. 实际代码、构建与数据起点

- 工作区：`C:\Users\50245\.codex\worktrees\work-review-agent-p1\daily-brief-source-20260708-122232`。
- 分支：`codex/work-review-agent-p1`；HEAD：`0653b3f18d56c121935f50502a0dedef06ba5bcd`，加既有未提交 P1/SSE/最终一致性与状态修复。
- 实际运行已有 production build：Next 15.5.19，**BUILD_ID `V96M1PjYFTLmra2SZiYKc`**，原构建退出码 0。核对最终修复清单的源码摘要，以及产物中的反证阻止、实际内容更新检查、关联待办状态、SSE 分项限制和保存后文案；全部包含。运行前后相关构建产物摘要不变。
- 从上一轮真实验收使用的 **M3 应用前合成库** `output/work-agent-p1-real-20261028/data` 字节复制数据库与 WAL 到本轮隔离目录。含已完成的 M2、原 3 条 Todo 和旧 #287 unknown；不包含上一轮之后已批准的 M3 写入。这是已有快照副本，没有撤销、删除或改写上轮结果。三场会议、14 条确认 Findings 与直接原文不变。
- 正式页面登录既有合成账号，从 M3 会议详情点击项目历史对比。任务创建、选择、批准均经过真实页面及正式 API，没有 HTTP 模拟、模型响应注入或直接 SQL 制造业务结果。
- 唯一新任务：`d9855d5c-67c6-4ced-83c0-958834aeea74`。输入原句：**“今天这场会和之前有什么变化？帮我整理已经确定的后续工作。”**

证据：[启动快照](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-final-real-20261029/baseline.json)、[实际产物核验](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-final-real-20261029/compiled-verification.json)。

## 2. 请求、预算、Token 与 unknown

现场原账本确为 **290/293**。启动前用户追加“额外授权100次”；授权累计上限可到 393，但现有 Guard 代码上限为 319，因此本轮启动参数取 **319**，未修改 Guard 源码。单个产品任务仍受 16 calls、16 steps、600000ms 等既有预算限制。最终仅使用原余额内的 **3 次**，没有消耗额外请求额度或为补齐结果重新提问。

正式配置：TokenHub / `deepseek-v4-pro`，reasoning=none，max output=6000，timeout=90000ms，maxRetries=0；配置解析与实际客户端端点核验通过，路由未改变。

| 原账本编号 | 用途 / requestId | 网络 / 产品 | 输入 Tokens | 输出 Tokens |
| --- | --- | --- | ---: | ---: |
| 291 | 决策：`2805bbc6-3a31-48ce-bc43-8af2e1e6fe99` | completed / succeeded | 1,102 | 12 |
| 292 | 决策：`cde6213c-0c0a-4fac-9454-140c70621c07` | completed / succeeded | 5,785 | 34 |
| 293 | 比较：`0f199681-6f5a-41b7-a3e2-f5abe635d8e4` | completed / succeeded | 6,149 | 1,242 |
| 合计 | **新增 3，累计 293** | 新增 unknown=0，失败=0 | **13,036** | **1,288** |

总计 **14,324 Tokens**；Provider 完成响应、原网络账本、产品 `agent_calls` 的 requestId 和 usage 逐条一致。3 次 SSE 均收到 completion，JSON 解析与 schema 校验成功。比较响应 1,249 个事件、累计 184,469 字节；它未超过旧 200,000 字节，因此本轮不单独证明旧阈值边界，但确实通过当前修复后的正式解析路径。

旧 290 行账本完全一致。#287 产品记录仍为 unknown、usage 仍为 NULL，网络已知用量仍原样保留；旧网络 #101 unknown 的 NULL usage 也没有按零改写。历史 unknown 不包含在本轮成功请求 Token 合计中。

证据：[逐请求与业务对账](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-final-real-20261029/closeout-corrected.json)、[SSE 阶段日志](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-final-real-20261029/app.log)。

## 3. 模型结果及人工语义核对

实际读取 3/3 场会议、14/14 条已确认结果、3/3 条项目 Todo 状态及 2 个已有议题的关系。页面明确说明不含 Todo 备注、pending/ignored 候选和会议全部讨论。

| 模型判断 / 操作 | 原文与实际字段核对 | 结果 |
| --- | --- | --- |
| M3 的 B 正式替代 A | M1 正式 A、M2 暂停 A 且未批准 B、M3 因配额不足正式 B；关系指向 M1 A 与 M3 B，没有把 M2 候选当作正式决定 | 正确 |
| 更新原部署 Todo | 原文“原部署任务调整为B配置，10月30日完成，不再新建”；label 为调整 B，实际 title=`调整为B配置部署`、owner=林晨、due=2026-10-30，前后一致 | 正确、可确认 |
| 完成回滚测试 | M3 原文明确“回滚和重复写入测试已全部完成” | 正确、可确认 |
| 关闭回滚问题 | M3 另有“确认回滚问题已解决”，以独立 resolves 操作保存 | 正确、可确认 |
| 新增同步延迟监控 | 明确承诺“我来新增”，林晨、10月29日，来源 M3 | 正确、可确认 |
| 日志期限、供应商回复 | 模型保持 unresolved，没有完成供应商或关闭日志的操作 | 正确 |
| 客户约束清单 | 仅标为缺少后续记录 / 待核实，不推断现实未做 | 正确 |

在正式页面打开 **14 次原文对话框**（比较条目、全部操作依据及 M2 暂停依据），均可显示对应会议、时间段和直接原文，无失效引用、错误项目或错误对象。时间线保留 A 的 M1 依据、M2 暂停事件，再追加 M3 替代事件。

三种情况必须分开：

| 情况 | 本轮实际发生 |
| --- | --- |
| 模型本身没有生成错误建议 | **是**：没有“供应商完成”，部署实际内容也正确反映 B |
| 模型生成错误，被系统阻止 | **未发生 / 未验证**：5 项都是正确且 confirmable，没有 blocked 或 needs_review 项 |
| 错误建议进入可批准列表 | **未观察到**；不能据此证明所有错误都能被拦截 |

因此两类负向拦截不能写成“真实 PASS”。没有人为篡改模型结果、补造错误操作或额外调用模型刷出错误样本。本轮也没有需要人工拒绝的错误操作。

证据：[页面逐条原文核对](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-final-real-20261029/ui-source-review.log)、[固定预览截图](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/playwright/work-agent-p1-final-real-preview.png)。

## 4. 实际保存、待办与恢复

逐项勾选 5 个正确操作，先核对再最终确认。**选择完成、尚未批准时，Todo、Todo 历史与业务关系均未改变**。批准后任务 ended，成果 applied，保存回执为 5 项、未采用 0 项。

- 部署仍是原 ID `wrt_eb0bff65-2f2b-4e95-a4a7-c9131b512109`，实际内容 `调整为B配置部署`，日期 2026-10-30，版本 0→1；没有重复部署 Todo。备注原本为 NULL，仍为 NULL；M1 原始来源保留，未将旧会议改成 B。
- 原回滚测试 Todo 状态 completed，版本 0→1。正式待办“全部”未列出它，“已完成”可以找到；项目简要脉络显示“工作记录 / 关联待办已完成”，未闭环列表不再误报该测试。
- 原独立回滚问题有新 confirmed resolves，状态 resolved；它与测试 Todo 的完成是两条实际写入。
- 仅新增 1 条监控 Todo，ID `wrt_d02e0bed-a788-4ec5-8fec-b05ad906733c`，来源直接关联 M3 监控 Finding。
- 供应商 waiting_for_other Todo 保持 open、version=0，正文和日期未变，正式等待他人页和未闭环列表仍显示它。
- 实际新增 **3 条 Todo 历史**：todo.updated、todo.completed、todo.created_from_finding；新增 **2 条关系**：supersedes、resolves。批准记录、预览选项、Todo 状态与 applied 回执一致。
- 相同原始批准 body（同事件 ID、任务版本、fingerprint）通过正式 PATCH 再提交 **2 次，均 202**；10 个任务/业务表快照完全不变，没有新增操作、Todo 或 Provider 请求。
- 刷新后再关闭原标签页、打开新标签页回到项目，5 项成果、时间线、当前 Todo 和回执一致；重开页面无控制台错误。没有恢复旧 unknown。

证据：[批准前快照](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-final-real-20261029/inspect-before-approval.json)、[重复批准](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-final-real-20261029/repeat-approval.json)、[重开截图](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/playwright/work-agent-p1-final-real-reopened.png)。

## 5. 未完成项与最终判定

1. **负向拦截真实覆盖不足**：本次真实模型没有生成前述两类错误，无法声称实际拦截成功；拒绝/blocked 项零写入路径也未在本次真实流程触发。前轮离线结果不能替代此项。
2. **日志期限提示缺口**：保存的比较始终明确写着“日志期限仍未解决”，原 Finding 未改变，也没有关闭它。但模型没有生成该问题的 records/持续关系，项目 `openLoops` 只列供应商、监控和部署，**独立未闭环提示区没有日志期限**。这属于本轮真实观察到的覆盖缺口，不是问题已解决。
3. **独立问题关联已完成 Todo 的组合未覆盖**：当前测试 tracks 锚点是工作承诺；独立回滚问题有明确解决依据。此实例不能证明“关联 Todo 已完成、独立问题仍开放”的页面组合。没有为补验修改历史关系或直接造数据。

本次正常 M3 用户闭环与“已完成测试被误报”修复的真实使用结果通过；按完整验收目标仍为 **PARTIAL**。没有出现需要立即中断的 unknown、错误业务写入或 SSE/产品状态不一致。本轮停止，不自动扩大测试、修代码或进入 P2。

## 6. 工作区、历史证据及清理

- 启动时的 **1,849 个既有文件**摘要全部不变；既有 dirty P1/SSE/最终修复及 UPDATE_HISTORY 未改。本轮只新增本报告和隔离验收输出。
- **1,651 个历史证据文件**摘要全部不变；原合成数据库及上一轮已保存 M3 结果未改。隔离副本中的旧任务、旧调用逐行不变，会议、候选、Finding、原文依据及项目关联表未改。
- 所有写入来自正式 API/业务流程。没有直接 SQL 修改产品结果或账本历史；Guard 仅向原账本追加 #291–293。
- 自有 Next、启动器及 Playwright 浏览器均已停止；端口 **37952 无监听**。办公库、Checkpoint 库、隔离认证库及原账本 SQLite integrity_check 全部 ok。
- 最终核对命令 `node output/work-agent-p1-final-real-20261029/closeout.mjs closeout-corrected` 退出 0，`git diff --check` 退出 0。本轮没有运行离线测试或重复构建作为真实通过证据。
- 辅助失败保留：最初访问 `/login` 为 404，随后从正式登录入口进入；Playwright 独立 request 上下文读取项目为 401，摘要脚本因此退出 1，改用已登录页面同源 GET 后为 200。辅助 closeout 首次误用 Todo 事件的 `id` 字段，漏计新增历史；已按实际 `event_id` 输出独立 corrected 证据，原日志不覆盖。均没有新增模型请求或修改业务状态。Windows 主动停止自有服务的进程退出码为 1，清理结果另行核对通过。

最终证据：[修正后的审计](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-final-real-20261029/closeout-corrected.json)、[进程与端口](C:/Users/50245/.codex/worktrees/work-review-agent-p1/daily-brief-source-20260708-122232/output/work-agent-p1-final-real-20261029/process-closeout.json)。

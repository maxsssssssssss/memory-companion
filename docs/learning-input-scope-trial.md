# 学习输入与范围验证：继续体验

本轮保留 DS V4 Pro / none 与请求级短引用，仅整理 Quiz 模型输入并补充已有范围预览。没有迁移数据库、改模型、改预算或重跑 OCR/ASR。

## 本地启动

在项目根目录执行：

```powershell
node scripts/learning-input-scope/runtime.mjs start
```

当前使用源码开发模式，包含 2026-09-24 的 PDF 字体兼容修复。此前保留的 `--production` 构建尚未包含这次局部修复；本次没有重跑 production build，重新构建前请使用上述命令。账号、课程和历史仍使用同一隔离数据目录。

出现 READY 后，另一终端打开真实已保存结果：

```powershell
node scripts/learning-input-scope/open.mjs A2
node scripts/learning-input-scope/open.mjs B1
```

- A2：展签印制课 v2 的新三题测验，已实际交卷。该次短样本的答案与逐选项理由审阅未发现严重错误，不等于此模型或课程全面合格。
- B1：纸上展览工坊新四题练习，保留未完成进度。仅供操作体验：第一题漏写同一讲解者前提，第四题有近义重复干扰项，未覆盖全部目标。
- `open.mjs course`：原课程与全部历史成果，旧问题题不改写。
- C1「三色签记录法与展签案例」是真实失败证据：3题均因位置依赖被拒绝，0题不能开始作答。C2虽发布，但没有完成笔记目标，不作为可靠新题推荐。

登录读取当前 Windows 用户既有 DPAPI 隔离账号配置，凭据仅在内存使用。数据保留在 `output/learning-input-scope-20260924/data`；原上一轮数据库没有改变。不要重新执行 prepare 或 plan。默认保存结果模式拒绝 Provider，不使用 `--live` 或 run.mjs 重发已结束的真实验证。

```powershell
node scripts/learning-input-scope/runtime.mjs status
node scripts/learning-input-scope/runtime.mjs stop
```

仅监听 `127.0.0.1:37941`，不启动 OCR、ASR、ngrok、SSH，不注册常驻服务。关闭体验浏览器后停止应用。保留数据和安全配置。

## 本轮证据及边界

- 真实请求8/12：7组Quiz + 1次为新笔记建立节点的框架。全部DS none；24题原始输出，21题发布，笔记组三题被拒绝。无需用满预算。
- 同正文整理：普通输入tokens2933→2869（-2.18%）；复杂13256→8948（-32.50%）。复杂延迟40.0→43.1秒，没有证明提速或语义质量稳定改善。
- 完整相关范围：整个课程五材料→首批三材料，全部首批正文、例外、冲突原样保留，只排除Window追加内容；8059输入tokens。局部目标仍有覆盖/措辞不足，不声称整套课程通过。
- 固定实验目标通过已有生成service测试注入点放入taskContext；这不是新增产品目标输入框。UI实际勾选/保存范围；生产同源service执行生成和发布，浏览器使用真实结果。无法把本轮解释成产品已支持目标驱动出题。
- 主报告在本轮对话；`output/learning-input-scope-20260924/ledger.json`、`source-roundtrip.json`、`history-preservation.json`、`review-only/manual-review.json`分别保存调用、来源、历史与逐题审阅证据。
- 原文、字段映射、后端几何和版本完整不等于语义正确；没有写入verified。只有操作体验及逐题人工对照的研发使用依据，不足以开放无需对照的限定课程学习试用。

# 学习短引用与模型对照：继续体验

本轮实现 Quiz 请求级短引用，并完成 14/16 次授权内真实请求：4 次长/短引用对照、6 次 DS 与候选对照、2 次输出格式检查、2 次独立 v2 样本复测。保留 DS V4 Pro / none 默认，不采用候选作为新的默认模型。没有新增 Provider、依赖、数据库迁移或 UI。

## 启动保存结果

在 `C:\Codex\daily-brief-source-20260708-122232` 执行：

```powershell
node scripts/learning-compact-generation/runtime.mjs start --production
```

出现 `Compact generation runtime READY` 后，另一终端执行：

```powershell
node scripts/learning-compact-generation/open.mjs
```

登录使用既有当前 Windows 用户 DPAPI 配置，在内存读取隔离账号凭据。无需在终端输入或输出明文。数据目录为 `output/learning-compact-generation-20260923/data/`，保留原课程一致性副本和本轮全部新题。**不要重新执行 prepare 脚本。**

```powershell
node scripts/learning-compact-generation/runtime.mjs status
node scripts/learning-compact-generation/runtime.mjs stop
```

只监听 `127.0.0.1:37931`，最多三小时，不注册常驻服务。默认保存数据模式阻止所有 Provider 调用，不启动 OCR、ASR、SSH 或 ngrok。关闭体验浏览器。真实对照已经结束，不使用 `--live`、`run.mjs` 或格式检查脚本重发请求；这些脚本还有单次许可与已执行标签拒绝保护。没有永久取音链接。

## 推荐打开的新结果

| 学习页 | 结果 | 使用范围 |
| --- | --- | --- |
| 纸上展览工坊，`d8c00258-1169-4388-8761-d37db0c6a82a` | R3 `观察窗口与团体通行规则综合练习`；题组 `89d87f5d-a94e-4aa1-b2e6-638c293c2f9d` | 四题真实 DS 结果，保留未完成练习；已答第一题，后三题可续做。该组主要结论本轮审阅较好，但未覆盖全部课程或所有共同障碍。 |
| 展签印制课 v2，`ca4f3ba1-2423-49b3-a449-0eb5d134a103` | V2 `展签印制规则单选题`；题组 `fd793843-5656-46d6-9b38-b2ab2fbe55d6` | 三题真实候选 gpt-5.5 结果；测验已交卷，可查看统一反馈。刻意一次提示、一次跳过、一次答错，成绩 1/3，不是课程掌握率。 |
| 同一 v2 页 | V1 `展签印制规则综合辨析`；题组 `8a429261-b73d-41ce-a20b-2504b46649c5` | 三题真实 DS 对照；其中未申请/未执行的阶段推断仍有措辞限制，不称全组无误。 |

未完成练习地址（先按上述方法登录）：

`http://127.0.0.1:37931/learning/d8c00258-1169-4388-8761-d37db0c6a82a?view=quiz&attempt=d1916fe0-df39-46ad-ab28-916bed5a65fb&question=1`

已交卷新测验：

`http://127.0.0.1:37931/learning/ca4f3ba1-2423-49b3-a449-0eb5d134a103?view=quiz&attempt=89ad7576-4935-42bd-b8d2-3d16e429105b`

旧题组未修改。M1 存在正确答案 ID 与理由矛盾，R2 有单位/模态歧义，M3/M6 有范围或对象问题，仍保留作历史证据，不能把这些组当作可靠教材。

## 实现与证据边界

- `quiz-compact.ts` 只在当前请求内把稳定 `ref_<hash>` 对应到 `r1/r2`，以账号、学习页、请求、过期时间和完整输入绑定一次性映射。回传后精确还原，再由原 repository 检查材料/笔记版本、删除和来源并集；不迁移历史对象。
- 除机械引用格式外，长/短配对使用相同教学 Prompt、材料、题量、难度、模式、预算与传输。调用前归一化哈希检查阻止配对额外变更。未删正文、逐项理由、风险或来源几何信息。
- 普通文本输入 tokens 从 3081 到 2911（-5.52%）；复杂课程从 17650 到 13208（-25.17%）。输出和耗时也下降，但包含随机内容与缓存差异，不能完全归因于别名。
- 候选为当前项目已有 TokenHub Responses `gpt-5.5`，实际调用四次；别名背后的固定版本及 TokenHub 实际计费均未知。没有使用其他服务密钥或官方直连。所有请求均为 none；候选返回 none 仍报告少量 reasoning tokens，未保存推理正文。
- 官方 Responses 文档支持 `text.format` JSON Schema；当前 TokenHub 的实际 strict 测试接受请求却违反 enum 与 additionalProperties。`json_object` 返回合法 JSON也不能证明该参数强制生效，因此产品继续本地结构校验，没有启用该通道的 schema 保证。
- 笔记任务中候选引用了所选笔记，但答案仍可只靠课程材料；DS 没有使用笔记依据。两者都未达到“必须依赖笔记独有信息”的冻结要求。
- N v1 原文时点自身有歧义，保留原样。N2/v2 是明确另存的材料修订，仅 V1/V2 互为相同输入对照，不能把旧新差异全归因为模型或短引用。
- 模型可能在自由说明中暴露 r8/r101 等别名，结构映射不会猜测改写这类正文；真实语义与文案仍需审阅。

证据根目录：`output/learning-compact-generation-20260923/`。

- `plan.json`、`recheck-plan.json`、`pair-*.json`：调用前冻结及配对一致性。
- `ds-request-*.json`、`ds-response-*.json`、`ledger.json`：14 次真实请求，最终回答/用量/状态，不保存私有推理。
- `review-only/final-review.json`：每一道原始题和发布题的审阅；Codex 阅读，不是用户或专家 verified。
- `comparison-summary.json`：量化结果；请求38题、原始37题、发布35题，12组均发布非空结果，10组达到所请求题量。发布不等于内容正确。
- `data-audit.json`：原课程数据库字节哈希未变，副本中86条旧对象未变。
- 浏览器：`practice-open-R3-result.json`、`test-complete-V2-result.json`、`restart-readback.json` 及 `screenshots/`。实际多题测验中途刷新、最终交卷、重登、正常停止重启、文本/PDF来源均已执行，零附带模型调用。
- 最终聚焦8文件155/155、完整 TypeScript、production build 都退出0。初次测试152/153，测试数据共享数组导致1个失败，修正测试输入独立性并补测试后通过；失败记录保留。
- `cleanup.json`：两个本轮应用生命周期退出0、停止码0，37931无监听，无本轮残余Node进程。CIM受限读取失败与后续获准只读核对分开保留。

建议采用 DS none + 短引用，暂不换默认模型。复杂课程仍存在引用不足、ASR歧义标签遗漏、近义干扰项、答案与解析矛盾风险。后续优先显式选择完整相关材料范围进行针对性比较，不静默截断，也不继续叠加泛泛Prompt禁令。OCR/ASR历史结果只是复用，本轮不构成它们的新增验收，更不是生产READY。

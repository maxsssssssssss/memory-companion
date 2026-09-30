# 三输入课程收尾：继续体验

本轮是现有合成课程的隔离复验，**内容质量仍为 PARTIAL**。可体验保存、关系、追问、来源、练习和续做，不应把题目与解释当成已经核验的教学答案。没有重新制作材料或调用 OCR/ASR。

## 数据与入口

- 工作目录：`C:\Codex\daily-brief-source-20260708-122232`
- 本轮持久数据及证据：`output/learning-multisource-closure-20260923/`
- 学习页：`合成课程 · 纸上展览工坊`
- 页面 ID：`d8c00258-1169-4388-8761-d37db0c6a82a`
- 原课程仍在 `output/learning-synthetic-course-20260923/`，原数据库字节哈希及 39 条历史对象均另行核对；本轮通过 SQLite 在线备份获得一致性副本，不覆盖原课程。
- 同一隔离账号保存在本轮数据目录。登录信息沿用当前 Windows 用户的非仓库 DPAPI 配置，由打开脚本在内存中读取，不在本文件记录明文。

## 启动、打开、停止

在项目目录启动已有最终构建，仅监听本机，默认只使用保存数据：

```powershell
node scripts/learning-multisource-closure/runtime.mjs start --production
```

出现 `Closure runtime READY` 后，在另一个终端打开并自动登录：

```powershell
node scripts/learning-multisource-closure/open.mjs
```

入口为 `http://127.0.0.1:37920/learning/d8c00258-1169-4388-8761-d37db0c6a82a`。直接打开此 URL 仍须登录；`open.mjs` 不绕过认证。

```powershell
node scripts/learning-multisource-closure/runtime.mjs status
node scripts/learning-multisource-closure/runtime.mjs stop
```

停止后关闭体验浏览器。启动脚本只清理自己启动的 Next 进程树；最长运行三小时，不注册常驻服务。不会启动 OCR、ASR、ngrok 或 SSH。默认未开启学习生成，不消费新 DS 额度。`--live` 仅供有明确新授权和手动调用清单的有界验收；本轮调用清单已结束，不要用它重复旧请求。

若没有最终构建，先运行 `node scripts/learning-multisource-closure/verify.mjs build`。不要重跑 `prepare.mjs` 覆盖课程；该脚本也会拒绝已有基线。

## 本次新增内容

- 第一份关系总览：3/5 条发布，2 条同批关系拒绝；包含 Window 与旧团体完成前提/容量联系。
- 后续小批框架：只用已保存的追加 PDF/TXT 新增 3 章、8 个节点；没有重写旧 11 章。自动关系总览 2/4 条发布，另外 2 条仍是同批关系，UI 显示拒绝原因及不完整范围。
- 新知识点对话保留“16组”不确定性，解释完成前提与空位不足可并存，补充例子明确为假设。旧对话因原有用户编辑而不可续聊的状态没有被迁移。
- 新练习题组 `c1bdfd26-569b-4612-b4b1-1b2997ed59f4`：**联合推理：观察窗口、团体通行与录音案例**，实际 3 题；已完成练习，包含提示、跳过及来源回看。
- 新测验题组 `a99d7ecf-0adb-4b9c-98bb-2f04f98f5a91`：**纸上展览工坊·前提与容量判断**，4 题。题组与历史中选择“续做 / 查看记录”。具体保留进度见 `resume-quiz-test-r3.json`；不要创建“重做原题”入口或重新洗牌。

## 已知内容问题

这些问题没有通过改写已保存成果被隐藏：

- 新练习第 1 题将“未超过容量”说成“并非已满”；正好两组是满额，理由不严谨。
- Quiz 对 ASR 歧义词没有稳定标“转写待确认”；新测验第 2 题改用新组名却没有明确标为假设新案例。
- 个别逐选项理由仍缺条件段引用、增加“先完成”或推测主张者的想法。结构合法不证明这些解释正确。
- 新框架的容量案例仍出现“两格合计达到容量”，应逐格判断。最新总览把听音敏感组与等待组概括在一起，且有 5 分钟/移动规则漏引具体段落。
- 显式纳入的个人笔记中保留原有有问题的教学类比；新题未实际引用该笔记，不能宣称笔记贡献验收通过。

完整逐项审阅在 `output/learning-multisource-closure-20260923/review-only/content-review.json`。该目录是验收资料，应用和模型输入均禁止读取，不是学习材料。未给任何内容自动写入 verified。已知有问题的旧题和本轮失败结果保持原样。

## 证据入口

- `ledger.json`：本轮独立 DS 请求、用量、耗时；历史 OCR/ASR 明确标为复用。
- `data-audit-before-restart.json`、`data-audit-final.json`：原库哈希、旧对象逐行保全。
- `final-source-reads.json`：新总览和追问的 17 个鉴权来源读回。
- `screenshots/`：真实保存结果、拒绝说明、PDF 区域、转写位置、练习/测验及重启续做。
- `*-exit.json` 和 `final-cleanup.json`：实际退出码及本轮监听清理。历史失败保留，不用后续通过覆盖失败证据。

这些是合成课程上复用真实解析/转写、调用真实 DS 的非生产证据；不代表所有课程、OCR/ASR 质量或学习整理完整首版已验收。

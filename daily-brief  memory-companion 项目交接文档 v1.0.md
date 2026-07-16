# Memory Companion / Daily Brief Project Handoff v1.0

## 1. 项目简介

项目定位：

**长时录音分析 + AI 陪伴 Agent**

目标：

将用户日常录音转换为：

* 可理解的生活记录；
* 可追溯的结构化记忆；
* 主动洞察；
* 基于历史记忆的问答。

核心方向：

> Evidence-backed Personal AI Agent

特点：

* 所有 AI 结论必须基于真实 evidence；
* Memory 必须可回溯 transcript；
* Agent 不做关系裁决，只提供温和观察。

---

# 2. 当前整体架构

```text
Audio Recording
        |
        v
ASR + Speaker Diarization
        |
        v
Audio Insights
        |
        v
Semantic Timeline
        |
        v
Daily Brief Extraction
        |
        v
Relationship Signal Cards
        |
        v
Memory Index
        |
        v
Memory Relevance Gate
        |
        v
Proactive Insight Agent
        |
        v
QA Agent
```

---

# 3. 已完成核心能力

## 3.1 Audio Pipeline

已实现：

### ASR

支持：

* transcript segments
* speaker diarization

---

### Audio Insight

当前：

DeepSeek V4 Flash

架构：

```text
ASR segments
        |
        v
DeepSeek Audio Insight
        |
        v
Rule fallback
```

配置：

```env
AUDIO_INSIGHT_PROVIDER=deepseek
AUDIO_INSIGHT_FALLBACK_PROVIDER=rule
DEEPSEEK_AUDIO_INSIGHT_MODEL=deepseek-v4-flash
```

优化：

* 独立 timeout；
* 无多轮 retry；
* schema validation；
* failure fallback。

---

## 3.2 Relationship Signal Cards

用途：

分析互动质量。

支持：

* active listening
* emotional support
* boundary respect
* clear commitment
* evasive answer
* invalidating

特点：

* evidence-based；
* transcript 可回溯；
* 不做人品判断；
* 不提供分手建议。

---

# 4. Memory Index 架构

## 4.1 存储

SQLite：

```text
.data/memory.sqlite
```

核心表：

```text
memory_items

memory_evidence

memory_relations
```

---

## 4.2 Memory 类型

当前：

```text
event

commitment

question

relationship_signal

preference

summary
```

---

## 4.3 Memory 能力

### Importance Scoring

考虑：

* memory type
* future action
* date
* recurrence
* evidence数量

---

### Deduplication

支持：

* 相似 memory 合并；
* occurrence tracking；
* evidence 保留。

---

### Memory Relations

支持：

* related
* repeated
* resolved_by
* contradicted_by
* follow_up

---

# 5. Memory Retrieval

当前支持：

## Current

当前录音：

不读取历史 memory。

---

## Week

最近一周：

读取：

* 最近 memory；
* active commitment；
* question；
* preference。

---

## All

全部历史：

严格：

* 高 importance；
* 多日期；
* 高价值 memory。

---

# 6. Memory Relevance Gate

目的：

解决：

> 重要 memory 不一定适合当前场景。

架构：

```text
Memory Index

↓

Importance Filter

↓

Candidate Memory

↓

DeepSeek Relevance Judge

↓

Relevant Memory

↓

Proactive Agent
```

输出：

```json
{
memoryId,
shouldUse,
relevanceScore,
usefulnessScore,
reason
}
```

限制：

* 最多候选20；
* 最终最多5条；
* 不修改 Memory 本身。

---

# 7. Proactive Insight Agent

当前版本：

Memory-aware Proactive Agent v2。

输入：

* current evidence；
* relevant memory；
* memory relations。

输出：

类型：

```text
reminder

reflection

follow_up

pattern_observation
```

---

安全限制：

禁止：

* 人格判断；
* 心理诊断；
* 分手建议；
* 绝对关系结论。

Validator：

检查：

* evidence；
* memoryRefs；
* pattern 多日期要求。

---

# 8. QA Agent

当前：

Tokenhub OpenAI-compatible

模型：

```text
gpt-5.5
```

职责：

复杂问答推理。

结构：

```text
Question

↓

Evidence Retrieval

↓

Memory Context

↓

LLM

↓

Citation Validation
```

最终引用：

必须回到：

* transcript；
* brief；
* relationship evidence。

---

# 9. 当前线上部署状态

服务器：

```text
Ubuntu
Node.js 22.21.0
PM2
Next.js 15.5.19
```

线上目录：

```text
/opt/daily-brief/

├── app
│   旧版本

├── app_backup_202607130729
│   回滚备份

└── releases/

    └── daily-brief-v1
        当前 Git 部署版本
```

启动方式：

```bash
pm2 start npm \
--name daily-brief \
--cwd /opt/daily-brief/releases/daily-brief-v1 \
-- start -- -p 3200
```

访问：

```text
https://daydiary.vision-intelligence.tech/
```

---

# 10. Git 部署流程

当前：

GitHub Private Repository。

以后：

本地：

```bash
git add .
git commit -m "message"
git push
```

服务器：

```bash
git pull

npm ci

npm run build

pm2 restart daily-brief
```

---

# 11. 最近一次线上 Pipeline 验证

测试成功。

结果：

```text
segments=20

speakers=2

audio_insights=7

semantic_segments=13

brief_items=6

relationship_signals=1

proactive_insights=2

status=ready
```

完整链路：

```text
Upload
 ↓
ASR
 ↓
DeepSeek Audio Insight
 ↓
Extraction
 ↓
Relationship Signal
 ↓
Memory Index
 ↓
Proactive Insight
 ↓
Ready
```

总耗时：

约 136 秒。

---

# 12. 当前问题

## 12.1 历史数据迁移未完成

需要：

确认生产数据目录。

执行：

```bash
npm run memory:migrate

npm run memory:upgrade
```

目标：

将旧 JSON 历史上传：

迁移进入 SQLite Memory。

---

## 12.2 Relationship Signal Schema 稳定性

线上发现：

部分模型输出：

```text
interactionEvidence string
```

但是 schema 要求：

```text
interactionEvidence array
```

当前：

fallback 可保证 pipeline。

后续：

优化：

* prompt；
* normalize；
* schema repair。

---

## 12.3 Speaker ASR Timeout

存在：

```text
speaker-asr query timeout
```

当前：

fallback OpenAI。

后续：

优化：

* timeout；
* retry；
* gateway。

---

## 12.4 Memory Evaluation

当前缺少：

真实长期多日数据。

需要验证：

* memory recall；
* dedup quality；
* relation accuracy；
* relevance precision。

---

# 13. 下一阶段计划

## 短期

1. 完成线上历史数据迁移。
2. 修复 Relationship Signal schema 稳定性。
3. 完成线上 demo 验收。

---

## 中期

Memory Quality：

* 多日数据测试；
* relevance gate 评估；
* relation lifecycle。

Agent：

* 提升 proactive insight 质量；
* 降低抽象表达；
* 增强陪伴感。

---

## 长期方向

可能探索：

* Graph Memory；
* Temporal Knowledge Graph；
* 更复杂 Personal Agent。

暂不考虑：

* 替换现有 Memory Index；
* 引入大型 Memory Framework。

---

# 14. 当前设计原则

## Evidence First

任何结论：

必须：

```text
AI Output

↓

Evidence

↓

Transcript
```

---

## Memory != Fact

Memory 是：

历史观察。

不是：

绝对事实。

---

## Agent 不裁决

系统提供：

* 提醒；
* 回顾；
* 发现。

不提供：

* 判断；
* 建议分手；
* 人格分析。

---

# End

Current Status:

**Production-ready prototype**

已具备：

* Audio Intelligence
* Structured Memory
* Memory Retrieval
* Proactive Agent
* QA Agent
* Online Deployment

下一阶段重点：

**真实数据验证与 Agent 质量提升。**

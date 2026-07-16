# Development History Tracking

## Requirement

每次完成代码修改、架构调整、性能优化、bug 修复或新增功能后，必须更新根目录：

`UPDATE_HISTORY.md`

## Purpose

`UPDATE_HISTORY.md` 用于记录项目长期演进过程，包括：

- 为什么需要这个修改；
- 设计思路；
- 架构变化；
- 核心技术实现；
- 技术决策和 trade-off；
- 测试验证；
- 当前限制；
- 后续计划。

## Rules

1. 只允许 append，不覆盖历史记录。

2. 每次记录必须包含：

```markdown
# YYYY-MM-DD - Feature / Task Name

## Background
修改背景和目标。

## Design
采用方案、原因以及替代方案。

## Architecture Change
Before / After 数据流或架构变化。

## Technical Implementation
关键文件、模块、数据结构、算法。

## Decision & Trade-offs
重要技术选择及原因。

## Validation
测试命令、结果、性能变化。

## Limitations
当前未解决问题。

## Next Steps
下一阶段计划。
```

3. 必须记录真实状态。

禁止：

- 夸大完成程度；
- 将本地测试描述为生产验证；
- 隐藏 fallback；
- 隐藏已知限制。

4. 必须引用真实修改内容。

包括：

- 实际修改文件；
- 实际测试结果；
- 实际配置。

5. 以下修改不需要记录：

- 单纯格式调整；
- typo 修复；
- 无逻辑变化的 rename。

## Project Specific Focus

### Long Recording Pipeline

包括：

- AudioChunk；
- TranscriptChunk；
- AnalysisChunk；
- ASR；
- Transcript Merge；
- checkpoint；
- Queue / Worker。

### Memory System

包括：

- Evidence First；
- Memory admission；
- deduplication；
- importance；
- relations；
- relevance。

### Agent System

包括：

- QA；
- Proactive Insight；
- Persona；
- Voice interaction。

### Infrastructure

包括：

- Redis；
- Queue；
- Worker；
- PM2；
- Deployment。

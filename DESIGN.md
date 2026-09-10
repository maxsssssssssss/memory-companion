# Daily Brief Canonical Design System

本文件是新增 UI 的唯一视觉基线。现有强页面按阶段迁移，不要求一次性重写。

## 视觉原则

1. 内容优先，控件退后。
2. 阅读优先，编辑按需。
3. Card 是用户拥有的思想资产；Memory 是可信、可追溯的长期状态。
4. 页面保持温暖、克制和明确，不使用霓虹 AI 风、重型 Dashboard 或多层白卡嵌套。

## Canonical tokens

全局 token 定义在 `src/app/design-system.css`，前缀为 `--db-*`：

- 中性暖色页面、暖白 surface、低饱和 inset。
- 深墨绿作为主操作与焦点色；暖红只用于危险状态。
- 系统无衬线字体承担导航、正文与控件；宋体/Georgia 仅用于少量内容型标题。
- 间距使用 4px 基线的有限阶梯；圆角分为 control、card、surface、overlay 四级。
- 阴影只用于 overlay、浮动层和交互抬升，不作为普通内容卡的默认边界。
- 所有交互目标至少 44px；focus ring 不能只依赖颜色变化。

## 工作复盘配色（2026-09-08 用户确认）

工作复盘使用 Fluent 蓝 `#0F6CBD` 为主色，配合冷白与浅灰，保持清晰、利落的现代办公风格。配色只在 `work-review.module.css` 的 `.app` 外壳覆盖既有 `--db-*` token，共享组件在该外壳内继承；全局与其他产品维持原有配色。

- 页面 `#F5F7FA`、内容面 `#FFFFFF`、次级面 `#F0F3F7`、来源 inset `#EDF1F5`。
- 主操作/链接/焦点 `#0F6CBD`、hover `#115EA3`、浅蓝选中态 `#EBF3FC`。
- 正文 `#1F2937`、次要文字 `#586779`、辅助文字/placeholder `#626F7F`。
- 分隔线 `#D8E0E8`、强调边界 `#AAB8C7`；完成状态保留绿色，警告与危险色保留既有语义。
- 保留现有布局、字体、间距、圆角、交互及产品/Evidence 合同；蓝色主要承担操作与选中提示。

## Surface hierarchy

全局产品入口（2026-09-09）：页面使用纸白 `#FFFEFA`，桌面以约会、日常、工作顺序排列三列等规格入口，小屏单列。入口主题对应当前产品实现：约会玫瑰棕 `#5A4240`、日常墨绿 `#315945`、工作 Fluent 蓝 `#0F6CBD`；标题、标记、操作、hover/focus 使用所属主题，浅色底面辅助区分。开放状态继续服从服务端能力；未开放入口保持相同尺寸但不可点击。日常此前 A/B 生图仅为预览，没有替换其实际主题。

仅使用三层常驻 surface：

1. Page background
2. Primary surface
3. Inset evidence/supporting area

Dialog、Popover 与浮动面板属于临时 overlay，不算第四层常驻内容盒。

## Shared primitives

新增或迁移的 UI 优先复用 `src/components/product-system`：

- `ProductSwitcher`：两套产品 Shell 的轻量产品切换。
- `ProductDialog`：统一焦点管理、Escape、背景滚动锁定与恢复。
- `ProductTabs`：键盘可操作的受控 tabs。
- `ProductEvidence`：来源与原话的 inset 表达。
- `ProductState`：loading、empty、error 和普通状态。

旧组件暂时可以保留自己的样式，但不得继续复制新的 token 或 primitive。

## Motion

- 高频产品切换不使用位移动画。
- 只在状态理解明显受益时使用 120–240ms 的淡入或轻微尺寸变化。
- 遵守 `prefers-reduced-motion`；不使用弹跳、旋转或持续脉冲作为装饰。

## Responsive and accessibility

- 桌面与移动共享对象语义，不通过隐藏关键状态制造不同产品。
- 小屏不横向溢出；固定导航与 sticky action 必须预留 safe area。
- 原生语义优先；Dialog、Tabs、Status、Error 具备明确的 role、label 与键盘路径。
- 正文和次要文字保持可读对比，disabled 不能与可点击主按钮混淆。

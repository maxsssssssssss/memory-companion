export type QaPromptPresetId = "work" | "date" | "negotiation" | "learning" | "casual" | "custom";

export type QaPromptPreset = {
  id: QaPromptPresetId;
  label: string;
  description: string;
  prompt: string;
};

export const DEFAULT_QA_PROMPT_PRESET_ID: QaPromptPresetId = "work";
export const MAX_CUSTOM_QA_PROMPT_LENGTH = 4000;

export const QA_PROMPT_PRESETS: QaPromptPreset[] = [
  {
    id: "work",
    label: "工作复盘",
    description: "决策、任务、风险",
    prompt:
      "场景默认是工作复盘。优先关注决策、承诺、待办、风险、分歧、负责人、时间点和下一步，但不要把生活闲聊强行解释成工作事项。"
  },
  {
    id: "date",
    label: "约会陪伴",
    description: "互动、感受、关系线索",
    prompt:
      "场景可能是约会或亲密关系沟通。优先关注双方表达、互动节奏、边界、期待、没说清的地方和让人舒服或不舒服的细节；避免操控性建议，不做人格或心理诊断。"
  },
  {
    id: "negotiation",
    label: "商务谈判",
    description: "诉求、筹码、风险",
    prompt:
      "场景可能是商务谈判。优先识别各方诉求、筹码、让步、底线、分歧、风险、未确认条件和下一轮动作；回答要客观、克制、便于复盘。"
  },
  {
    id: "learning",
    label: "听课学习",
    description: "知识点、例子、复习",
    prompt:
      "场景可能是听课、讲座、播客或自学。优先整理核心概念、概念之间的关系、例子、疑问、可复习的问题和容易混淆的点；不要编造讲者没有讲过的内容。"
  },
  {
    id: "casual",
    label: "日常闲聊",
    description: "生活细节、轻松记录",
    prompt:
      "场景可能是路边闲聊、生活记录或随口想法。优先捕捉真实发生的事、值得回味的细节、临时灵感和情绪色彩；语气可以轻松，但不要强行整理成任务清单。"
  },
  {
    id: "custom",
    label: "自定义",
    description: "使用你写的提示词",
    prompt: ""
  }
];

export function normalizeQaPromptPresetId(value: unknown): QaPromptPresetId | undefined {
  return QA_PROMPT_PRESETS.some((preset) => preset.id === value) ? (value as QaPromptPresetId) : undefined;
}

export function normalizeCustomQaPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_CUSTOM_QA_PROMPT_LENGTH) : undefined;
}

export function resolveQaPromptInstruction(input?: {
  promptPresetId?: unknown;
  qaPromptPresetId?: unknown;
  customPrompt?: unknown;
  customQaPrompt?: unknown;
}) {
  const presetId =
    normalizeQaPromptPresetId(input?.qaPromptPresetId ?? input?.promptPresetId) ?? DEFAULT_QA_PROMPT_PRESET_ID;
  const customPrompt = normalizeCustomQaPrompt(input?.customQaPrompt ?? input?.customPrompt);

  if (presetId === "custom" && customPrompt) {
    return customPrompt;
  }

  const selectedPreset = QA_PROMPT_PRESETS.find((preset) => preset.id === presetId);
  const defaultPreset = QA_PROMPT_PRESETS.find((preset) => preset.id === DEFAULT_QA_PROMPT_PRESET_ID);

  return selectedPreset?.prompt || defaultPreset?.prompt || "";
}

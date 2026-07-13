import type { SceneLabel, TranscriptSegment, ValueLabel } from "@/lib/domain/types";

const sceneRules: Array<[SceneLabel, RegExp]> = [
  ["customer_call", /客户|报价|试点/],
  ["product_discussion", /产品|MVP|证据链|长期记忆/],
  ["team_management", /团队|人员|组织|分歧/],
  ["investor_call", /投资人|融资|估值/],
  ["self_reflection", /想法|反思|战略假设/],
  ["private_content", /家庭|私人|健康/]
];

const valueRules: Array<[ValueLabel, RegExp]> = [
  ["commitment", /答应|承诺|会在|明天|下周/],
  ["task", /待办|跟进|需要做|发过去/],
  ["decision", /决定|定了|先做|不做/],
  ["idea", /想法|灵感|假设/],
  ["risk", /风险|阻塞|不会信|失败/],
  ["open_question", /问题|还没想清楚|待验证/],
  ["notable_quote", /原话|值得保留/]
];

export function classifySegment(segment: TranscriptSegment): TranscriptSegment {
  const sceneLabels = sceneRules
    .filter(([, rule]) => rule.test(segment.text))
    .map(([label]) => label);

  const valueLabels = valueRules
    .filter(([, rule]) => rule.test(segment.text))
    .map(([label]) => label);

  return {
    ...segment,
    sceneLabels: sceneLabels.length > 0 ? sceneLabels : ["unknown"],
    valueLabels
  };
}

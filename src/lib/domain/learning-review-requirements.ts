/** Bounded negative checks for already-observed workflow-only requirements.
 * A non-match is NOT a semantic verification of a learning objective. In
 * particular this does not invent, delete or repair frozen requirements. */
const compact = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "").replace(/[。.!！]$/u, "");
const workflowOnly = [
  /^(?:根据|结合|依据)(?:前序|前面|此前|已有|实际|当前)(?:的)?(?:作答|答题)(?:表现|结果)[,，]?(?:检查|判断|确认)(?:该|这个|此|当前)?(?:小点|目标|知识点|要求|内容)?是否(?:已经|已)?(?:充分验证|得到充分验证|检查充分|得到充分检查)$/u,
  /^先完成[一二三四五六七八九十两\d]+道(?:了解性|诊断性|诊断|检查)?(?:题目|题|练习)[,，]?再针对(?:实际|当前|发现的|暴露的)(?:困难|问题|薄弱点)(?:继续|进一步)?(?:检查|复查|练习)$/u,
];

export function isUnobservableLearningRequirement(description: string): boolean {
  return workflowOnly.some(pattern => pattern.test(compact(description)));
}

export function findUnobservableLearningRequirements(plan: {
  objectives: ReadonlyArray<{ id: string; requirements: ReadonlyArray<{ role: string; description: string }> }>;
}) {
  return plan.objectives.flatMap(objective => objective.requirements.flatMap((requirement, requirementIndex) =>
    isUnobservableLearningRequirement(requirement.description) ? [{
      objectiveId: objective.id, requirementIndex, role: requirement.role, code: "procedure_not_learning_requirement" as const,
    }] : []));
}

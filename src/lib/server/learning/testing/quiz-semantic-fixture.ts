/** Explicit controlled judgments for business tests, NOT a semantic verifier.
 * Callers choose a known fixture answer; no generator answer is read here. */
export function offlineQuizSemanticResponse(input: unknown, correctId = "A") {
  const wire = input as { candidates: Array<{ candidateId: string; options: Array<{ id: string }>; sources: Array<{ referenceId: string }> }> };
  return { items: wire.candidates.map(candidate => ({ candidateId: candidate.candidateId,
    options: candidate.options.map(option => ({ optionId: option.id,
      verdict: option.id === correctId ? "holds" : "does_not_hold",
      reason: "[离线受控审题] 这是事先核实的合成题判断，不代表真实模型审题质量。",
      evidenceIds: candidate.sources.map(source => source.referenceId) })) })) };
}

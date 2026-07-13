import type { AtmosphereLabel, AudioInsight, EmotionEvidence } from "@/lib/domain/types";

type EvidenceSource = "user_correction" | "acoustic" | "fusion";

function addUnique(labels: AtmosphereLabel[], label: AtmosphereLabel) {
  if (!labels.includes(label)) {
    labels.push(label);
  }
}

function evidenceId(insight: AudioInsight, source: EvidenceSource, index: number) {
  return `emotion_evidence_${insight.id}_${source}_${index + 1}`;
}

function sourceTimeRangeFor(insight: AudioInsight) {
  return {
    startSeconds: insight.sourceTimeRange.startSeconds,
    endSeconds: insight.sourceTimeRange.endSeconds
  };
}

function sourceSegmentIdsFor(insight: AudioInsight) {
  return [...insight.sourceSegmentIds];
}

function normalizedUserCorrectionLabel(text: string): AtmosphereLabel | undefined {
  if (/认真|严肃|专注/.test(text)) return "serious";
  if (/紧张|压力|焦虑|僵/.test(text)) return "tense";
  if (/轻松|舒服|放松/.test(text)) return "warm";
  if (/暧昧|玩笑|有趣|开心/.test(text)) return "playful";
  if (/敷衍|回避|绕开/.test(text)) return "avoidant";

  return undefined;
}

function relatedSuppressedLabels(label: AtmosphereLabel): AtmosphereLabel[] {
  if (label === "tense") {
    return ["tense", "conflicted"];
  }

  return [label];
}

function userCorrectionLabelsForInsight(insight: AudioInsight) {
  const preferred: AtmosphereLabel[] = [];
  const suppressed: AtmosphereLabel[] = [];

  for (const correction of insight.userCorrections ?? []) {
    for (const labelCorrection of correction.labelCorrections) {
      const fromLabel = normalizedUserCorrectionLabel(labelCorrection.from);
      const toLabel = normalizedUserCorrectionLabel(labelCorrection.to);

      if (fromLabel) {
        for (const label of relatedSuppressedLabels(fromLabel)) {
          addUnique(suppressed, label);
        }
      }

      if (toLabel) {
        addUnique(preferred, toLabel);
      }
    }
  }

  return { preferred, suppressed };
}

function userCorrectionEvidenceForInsight(insight: AudioInsight): EmotionEvidence[] {
  return (insight.userCorrections ?? []).flatMap((correction, correctionIndex) =>
    correction.labelCorrections.flatMap((labelCorrection, labelCorrectionIndex) => {
      const normalizedLabel = normalizedUserCorrectionLabel(labelCorrection.to);

      if (!normalizedLabel) {
        return [];
      }

      return [
        {
          id: evidenceId(insight, "user_correction", correctionIndex * 100 + labelCorrectionIndex),
          kind: "atmosphere",
          label: labelCorrection.to,
          normalizedLabel,
          source: "user_correction",
          confidence: 0.95,
          detail: correction.note ?? `用户将「${labelCorrection.from}」纠正为「${labelCorrection.to}」。`,
          sourceSegmentIds: sourceSegmentIdsFor(insight),
          sourceTimeRange: sourceTimeRangeFor(insight),
          features: [{ name: "user_correction", label: `${labelCorrection.from} -> ${labelCorrection.to}` }],
          correctedByUser: true
        }
      ];
    })
  );
}

function acousticEvidenceForInsight(insight: AudioInsight): EmotionEvidence[] {
  const explanations = insight.voice.explanations ?? [];

  if (explanations.length === 0) {
    return [];
  }

  const normalizedLabel: AtmosphereLabel = insight.voice.overlap || insight.voice.pause === "many" ? "tense" : "focused";
  const confidence = Math.min(0.9, Math.max(insight.voice.confidence, ...explanations.map((item) => item.confidence)));

  return [
    {
      id: evidenceId(insight, "acoustic", 0),
      kind: "atmosphere",
      label: "声学线索",
      normalizedLabel,
      source: "acoustic",
      confidence,
      detail: explanations.map((item) => `${item.label}：${item.detail}`).join(" "),
      sourceSegmentIds: sourceSegmentIdsFor(insight),
      sourceTimeRange: sourceTimeRangeFor(insight),
      features: explanations.map((item) => ({ name: item.kind, label: item.label }))
    }
  ];
}

function fusionFeaturesForInsight(insight: AudioInsight) {
  return [
    ...insight.toneLabels.map((label) => ({ name: "tone", label })),
    ...insight.emotionLabels.map((label) => ({ name: "emotion", label })),
    ...insight.interactionLabels.map((label) => ({ name: "interaction", label }))
  ].filter((feature) => feature.label !== "unknown" && feature.label !== "neutral");
}

function fusionEvidenceForInsight(insight: AudioInsight, atmosphereLabels: AtmosphereLabel[]): EmotionEvidence[] {
  return atmosphereLabels
    .filter((label) => label !== "unknown")
    .map((label, index) => ({
      id: evidenceId(insight, "fusion", index),
      kind: "atmosphere",
      label,
      normalizedLabel: label,
      source: "fusion",
      confidence: Math.min(0.9, Math.max(0.55, insight.confidence)),
      detail: `结合了语气、情绪线索、互动标签，判断当前氛围更接近「${label}」。`,
      sourceSegmentIds: sourceSegmentIdsFor(insight),
      sourceTimeRange: sourceTimeRangeFor(insight),
      features: fusionFeaturesForInsight(insight)
    }));
}

function evidenceKey(evidence: EmotionEvidence) {
  return [
    evidence.source,
    evidence.kind,
    evidence.normalizedLabel,
    evidence.sourceSegmentIds.join("|"),
    evidence.sourceTimeRange.startSeconds,
    evidence.sourceTimeRange.endSeconds,
    evidence.detail
  ].join("/");
}

function uniqueEvidence(evidenceItems: EmotionEvidence[]) {
  const seen = new Set<string>();
  const items: EmotionEvidence[] = [];

  for (const evidence of evidenceItems) {
    const key = evidenceKey(evidence);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    items.push(evidence);
  }

  return items;
}

export function atmosphereLabelsForInsight(insight: AudioInsight): AtmosphereLabel[] {
  const labels: AtmosphereLabel[] = [];
  const corrections = userCorrectionLabelsForInsight(insight);

  if (insight.toneLabels.includes("serious") || insight.toneLabels.includes("explaining")) {
    addUnique(labels, "serious");
  }

  if (
    insight.toneLabels.includes("playful") ||
    insight.emotionLabels.includes("happy") ||
    insight.emotionLabels.includes("relaxed")
  ) {
    addUnique(labels, "playful");
  }

  if (
    insight.emotionLabels.includes("anxious") ||
    insight.emotionLabels.includes("tense") ||
    insight.emotionLabels.includes("dissatisfied")
  ) {
    addUnique(labels, "tense");
  }

  if (insight.interactionLabels.includes("tension") || insight.interactionLabels.includes("disagreement")) {
    addUnique(labels, "conflicted");
  }

  if (insight.interactionLabels.includes("rapport") || insight.interactionLabels.includes("agreement")) {
    addUnique(labels, "collaborative");
  }

  if (insight.voice.pause === "many") {
    addUnique(labels, "uncertain");
  }

  if (insight.voice.overlap) {
    addUnique(labels, "tense");
  }

  for (const label of corrections.preferred) {
    addUnique(labels, label);
  }

  const filteredLabels = labels.filter((label) => !corrections.suppressed.includes(label));

  return filteredLabels.length > 0 ? filteredLabels : ["unknown"];
}

export function applyEmotionEvidenceToAudioInsights(insights: AudioInsight[]): AudioInsight[] {
  return insights.map((insight) => {
    const atmosphereLabels = atmosphereLabelsForInsight(insight);
    const corrections = userCorrectionLabelsForInsight(insight);
    const emotionEvidence = uniqueEvidence([
      ...userCorrectionEvidenceForInsight(insight),
      ...(insight.emotionEvidence ?? []),
      ...acousticEvidenceForInsight(insight),
      ...fusionEvidenceForInsight(insight, atmosphereLabels)
    ]).filter((evidence) => evidence.source === "user_correction" || !corrections.suppressed.includes(evidence.normalizedLabel as AtmosphereLabel));

    return {
      ...insight,
      atmosphereLabels,
      emotionEvidence
    };
  });
}

import { z } from "zod";

export const SceneLabelSchema = z.enum([
  "investor_call",
  "product_discussion",
  "customer_call",
  "team_management",
  "self_reflection",
  "low_value_chatter",
  "private_content",
  "unknown"
]);

export const ValueLabelSchema = z.enum([
  "commitment",
  "task",
  "decision",
  "idea",
  "risk",
  "open_question",
  "notable_quote"
]);

export const BriefCategorySchema = ValueLabelSchema;
export const PrioritySchema = z.enum(["high", "medium", "low"]);
export const ItemStatusSchema = z.enum(["candidate", "confirmed", "dismissed"]);
export const JobStatusSchema = z.enum(["uploaded", "waiting", "processing", "transcribing", "extracting", "ready", "failed"]);
export const PipelineExecutionModeSchema = z.enum(["inline", "queue"]);
export const SpeakerRoleSchema = z.enum(["self", "other", "customer", "teammate", "teacher", "unknown"]);
export const VoicePaceSchema = z.enum(["slow", "normal", "fast", "unknown"]);
export const VoiceVolumeSchema = z.enum(["low", "normal", "high", "unknown"]);
export const VoicePauseSchema = z.enum(["few", "normal", "many", "unknown"]);
export const VoiceExplanationSchema = z.object({
  kind: z.enum(["volume", "pause", "overlap"]),
  label: z.string().min(1),
  detail: z.string().min(1),
  confidence: z.number().min(0).max(1)
});
export const ToneLabelSchema = z.enum([
  "firm",
  "hesitant",
  "explaining",
  "questioning",
  "pushing_back",
  "comforting",
  "excited",
  "perfunctory",
  "playful",
  "serious",
  "unknown"
]);
export const EmotionLabelSchema = z.enum([
  "relaxed",
  "happy",
  "interested",
  "neutral",
  "tense",
  "anxious",
  "confused",
  "dissatisfied",
  "tired",
  "unknown"
]);
export const InteractionLabelSchema = z.enum([
  "agreement",
  "disagreement",
  "follow_up_question",
  "interruption",
  "silence",
  "topic_shift",
  "tension",
  "rapport",
  "flirtation_or_testing",
  "decision_moment",
  "unknown"
]);
export const AtmosphereLabelSchema = z.enum([
  "focused",
  "serious",
  "tense",
  "warm",
  "playful",
  "awkward",
  "rushed",
  "uncertain",
  "collaborative",
  "conflicted",
  "avoidant",
  "unknown"
]);
export const EmotionEvidenceKindSchema = z.enum(["tone", "emotion", "interaction", "atmosphere"]);
export const EmotionEvidenceSourceSchema = z.enum(["transcript", "acoustic", "llm", "user_correction", "fusion"]);
export const EmotionEvidenceFeatureSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1).optional(),
  unit: z.string().min(1).optional()
});
export const AudioInsightUserCorrectionSchema = z.object({
  labelCorrections: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1)
    })
  ),
  note: z.string().min(1).optional(),
  updatedAt: z.string().datetime().optional()
});

export const TimeRangeSchema = z
  .object({
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive()
  })
  .refine((range) => range.endSeconds > range.startSeconds, {
    message: "endSeconds must be greater than startSeconds"
  });

export const EmotionEvidenceSchema = z.object({
  id: z.string().min(1),
  kind: EmotionEvidenceKindSchema,
  label: z.string().min(1),
  normalizedLabel: AtmosphereLabelSchema.or(ToneLabelSchema).or(EmotionLabelSchema).or(InteractionLabelSchema),
  source: EmotionEvidenceSourceSchema,
  confidence: z.number().min(0).max(1),
  detail: z.string().min(1),
  sourceSegmentIds: z.array(z.string().min(1)).min(1),
  sourceTimeRange: TimeRangeSchema,
  features: z.array(EmotionEvidenceFeatureSchema).default([]),
  correctedByUser: z.boolean().optional()
});

export const TranscriptSegmentSchema = z
  .object({
    id: z.string().min(1),
    uploadId: z.string().min(1),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    speaker: z.string().optional(),
    text: z.string().min(1),
    confidence: z.number().min(0).max(1),
    sceneLabels: z.array(SceneLabelSchema),
    valueLabels: z.array(ValueLabelSchema)
  })
  .refine((segment) => segment.endSeconds > segment.startSeconds, {
    message: "segment endSeconds must be greater than startSeconds"
  });

export const SemanticSegmentSchema = z
  .object({
    id: z.string().min(1),
    uploadId: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    tags: z.array(z.string().min(1)),
    sceneLabels: z.array(SceneLabelSchema),
    valueLabels: z.array(ValueLabelSchema),
    confidence: z.number().min(0).max(1),
    sourceSegmentIds: z.array(z.string().min(1)).min(1),
    sourceTimeRange: TimeRangeSchema,
    transcriptExcerpt: z.string().min(1)
  })
  .refine((segment) => segment.endSeconds > segment.startSeconds, {
    message: "semantic segment endSeconds must be greater than startSeconds"
  })
  .refine((segment) => segment.sourceTimeRange.endSeconds > segment.sourceTimeRange.startSeconds, {
    message: "semantic segment source range must be valid"
  });

export const AudioInsightSchema = z
  .object({
    id: z.string().min(1),
    uploadId: z.string().min(1),
    sourceSegmentIds: z.array(z.string().min(1)).min(1),
    sourceTimeRange: TimeRangeSchema,
    speaker: z.object({
      id: z.string().min(1),
      displayName: z.string().min(1).optional(),
      role: SpeakerRoleSchema,
      confidence: z.number().min(0).max(1)
    }),
    voice: z.object({
      pace: VoicePaceSchema,
      volume: VoiceVolumeSchema,
      pause: VoicePauseSchema,
      overlap: z.boolean(),
      confidence: z.number().min(0).max(1),
      explanations: z.array(VoiceExplanationSchema).optional()
    }),
    toneLabels: z.array(ToneLabelSchema).min(1),
    emotionLabels: z.array(EmotionLabelSchema).min(1),
    interactionLabels: z.array(InteractionLabelSchema).min(1),
    atmosphereLabels: z.array(AtmosphereLabelSchema).optional(),
    emotionEvidence: z.array(EmotionEvidenceSchema).optional(),
    userCorrections: z.array(AudioInsightUserCorrectionSchema).optional(),
    summary: z.string().min(1),
    evidence: z.string().min(1),
    confidence: z.number().min(0).max(1)
  })
  .refine((insight) => insight.sourceTimeRange.endSeconds > insight.sourceTimeRange.startSeconds, {
    message: "audio insight source range must be valid"
  });

export const BriefItemSchema = z
  .object({
    id: z.string().min(1),
    uploadId: z.string().min(1),
    category: BriefCategorySchema,
    title: z.string().min(1),
    body: z.string().min(1),
    priority: PrioritySchema,
    confidence: z.number().min(0).max(1),
    status: ItemStatusSchema,
    sourceSegmentIds: z.array(z.string().min(1)).min(1),
    sourceTimeRange: TimeRangeSchema,
    transcriptExcerpt: z.string().min(1),
    people: z.array(z.string()).default([]),
    topics: z.array(z.string()).default([])
  })
  .refine((item) => item.sourceTimeRange.endSeconds > item.sourceTimeRange.startSeconds, {
    message: "brief item source range must be valid"
  });

export const RelationshipSignalTypeSchema = z.enum([
  "active_listening",
  "emotional_support",
  "boundary_respect",
  "clear_commitment",
  "evasive_answer",
  "invalidating_or_belittling"
]);
export const RelationshipSignalCategorySchema = z.enum(["positive", "risk", "uncertain"]);
export const RelationshipSignalSeveritySchema = z.enum(["low", "medium", "high"]);
export const RelationshipSignalEvidenceSegmentSchema = z
  .object({
    segmentId: z.string().min(1),
    speaker: z.string().min(1).optional(),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    text: z.string().min(1)
  })
  .refine((segment) => segment.endSeconds > segment.startSeconds, {
    message: "relationship signal evidence endSeconds must be greater than startSeconds"
  });
export const RelationshipSignalAcousticEvidenceSchema = z.object({
  audioInsightId: z.string().min(1),
  detail: z.string().min(1),
  confidence: z.number().min(0).max(1)
});
export const RelationshipSignalInteractionEvidenceSchema = z.object({
  sourceId: z.string().min(1),
  detail: z.string().min(1),
  confidence: z.number().min(0).max(1)
});
export const RelationshipSignalCardSchema = z
  .object({
    id: z.string().min(1),
    uploadId: z.string().min(1),
    date: z.string().min(1),
    signalType: RelationshipSignalTypeSchema,
    signalCategory: RelationshipSignalCategorySchema,
    severity: RelationshipSignalSeveritySchema,
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1),
    explanation: z.string().min(1),
    involvedSpeakers: z.array(z.string().min(1)).min(1),
    timeRange: TimeRangeSchema,
    evidenceSegments: z.array(RelationshipSignalEvidenceSegmentSchema).min(1),
    counterEvidence: z.array(z.string().min(1)).optional(),
    acousticEvidence: z.array(RelationshipSignalAcousticEvidenceSchema).optional(),
    textEvidence: z.array(z.string().min(1)).min(1),
    interactionEvidence: z.array(RelationshipSignalInteractionEvidenceSchema).optional(),
    suggestedReflection: z.string().min(1),
    caution: z.string().min(1).optional(),
    createdAt: z.string().datetime()
  })
  .refine((card) => card.timeRange.endSeconds > card.timeRange.startSeconds, {
    message: "relationship signal time range must be valid"
  })
  .refine((card) => card.signalCategory === "positive" || Boolean(card.caution?.trim()), {
    message: "risk and uncertain relationship signals require caution"
  });

export const MemoryCandidateSchema = BriefItemSchema.and(
  z.object({
    memoryType: z.enum(["profile", "project", "person", "task", "idea"]),
    promotedAt: z.string().datetime().optional()
  })
);

export const AudioUploadSchema = z.object({
  id: z.string().min(1),
  originalName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  recordingDate: z.string().min(1),
  createdAt: z.string().datetime().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  status: JobStatusSchema
});

export const ProcessingJobSchema = z.object({
  id: z.string().min(1),
  uploadId: z.string().min(1),
  status: JobStatusSchema,
  progress: z.number().min(0).max(100),
  executionMode: PipelineExecutionModeSchema.optional(),
  queueJobId: z.string().min(1).optional(),
  queuedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  workerStartedAt: z.string().datetime().optional(),
  queueAttempt: z.number().int().nonnegative().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional()
});

export const QuestionAnswerSchema = z.object({
  id: z.string().min(1),
  uploadId: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  citedSegmentIds: z.array(z.string().min(1)),
  citations: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        startSeconds: z.number().nonnegative(),
        endSeconds: z.number().positive(),
        excerpt: z.string().min(1),
        sourceSegmentIds: z.array(z.string().min(1)).min(1)
      })
    )
    .optional(),
  createdAt: z.string().datetime()
});

export const SpeakerAliasMapSchema = z.record(z.string().min(1), z.string().min(1));
export const SpeakerAliasesByUploadIdSchema = z.record(z.string().min(1), SpeakerAliasMapSchema);

export type SceneLabel = z.infer<typeof SceneLabelSchema>;
export type ValueLabel = z.infer<typeof ValueLabelSchema>;
export type BriefCategory = z.infer<typeof BriefCategorySchema>;
export type BriefItem = z.infer<typeof BriefItemSchema>;
export type RelationshipSignalType = z.infer<typeof RelationshipSignalTypeSchema>;
export type RelationshipSignalCategory = z.infer<typeof RelationshipSignalCategorySchema>;
export type RelationshipSignalSeverity = z.infer<typeof RelationshipSignalSeveritySchema>;
export type RelationshipSignalEvidenceSegment = z.infer<typeof RelationshipSignalEvidenceSegmentSchema>;
export type RelationshipSignalCard = z.infer<typeof RelationshipSignalCardSchema>;
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;
export type SemanticSegment = z.infer<typeof SemanticSegmentSchema>;
export type SpeakerRole = z.infer<typeof SpeakerRoleSchema>;
export type VoicePace = z.infer<typeof VoicePaceSchema>;
export type VoiceVolume = z.infer<typeof VoiceVolumeSchema>;
export type VoicePause = z.infer<typeof VoicePauseSchema>;
export type VoiceExplanation = z.infer<typeof VoiceExplanationSchema>;
export type ToneLabel = z.infer<typeof ToneLabelSchema>;
export type EmotionLabel = z.infer<typeof EmotionLabelSchema>;
export type InteractionLabel = z.infer<typeof InteractionLabelSchema>;
export type AtmosphereLabel = z.infer<typeof AtmosphereLabelSchema>;
export type EmotionEvidence = z.infer<typeof EmotionEvidenceSchema>;
export type EmotionEvidenceSource = z.infer<typeof EmotionEvidenceSourceSchema>;
export type EmotionEvidenceKind = z.infer<typeof EmotionEvidenceKindSchema>;
export type AudioInsightUserCorrection = z.infer<typeof AudioInsightUserCorrectionSchema>;
export type AudioInsight = z.infer<typeof AudioInsightSchema>;
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
export type AudioUpload = z.infer<typeof AudioUploadSchema>;
export type ProcessingJob = z.infer<typeof ProcessingJobSchema>;
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
export type SpeakerAliasMap = z.infer<typeof SpeakerAliasMapSchema>;
export type SpeakerAliasesByUploadId = z.infer<typeof SpeakerAliasesByUploadIdSchema>;

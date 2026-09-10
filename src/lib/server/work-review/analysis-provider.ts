import {
  APIConnectionError,
  APIConnectionTimeoutError,
  InternalServerError,
  RateLimitError
} from "openai/error";
import { ZodError, z } from "zod";

import {
  WorkCanonicalSegmentsSchema,
  WorkEvidenceTimestampQualitySchema,
  WorkExtractorResponseSchema,
  WorkMeetingActionBasisSchema,
  WorkMeetingCandidateStructuredDataSchema,
  WorkMeetingDecisionFinalitySchema,
  WorkReviewIdSchema,
  WorkReviewIsoDateTimeSchema,
  WorkVerifierClaimDraftSchema,
  WorkVerifierResponseSchema,
  type WorkAtomicClaim,
  type WorkExtractorCandidateDraft,
  type WorkExtractorResponse,
  type WorkMaterializedEvidence,
  type WorkMeetingCandidateStructuredData,
  type WorkVerifierClaimDraft,
  type WorkVerifierResponse
} from "@/lib/domain/work-review";
import { createOpenAIClient } from "@/lib/server/openai/client";
import {
  parseStructuredJsonResponse,
  StructuredJsonResponseError,
  type StructuredJsonDiagnostics,
  type StructuredJsonResponseText
} from "@/lib/server/openai/structured-json";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";
import {
  assertWorkReviewAnalysisProfileSupported,
  resolveWorkReviewAnalysisRuntimeConfig,
  resolveWorkReviewExtractorProfile,
  resolveWorkReviewVerifierProfile,
  WorkReviewRuntimeConfigError,
  type WorkReviewAnalysisProviderProfile,
  type WorkReviewAnalysisRuntimeConfig
} from "./runtime-config";
import {
  WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES,
  WORK_MEETING_CANONICAL_WORDING_UNCLEAR,
  WORK_MEETING_SEMANTIC_SAFETY_RULES
} from "./publication-policy";
import type { WorkMeetingTranscriptWindow } from "./windowing";
import { observeWorkProviderHttp, type WorkProviderHttpDiagnostics } from "./provider-http-observer";
import { createWorkReviewDeepSeekClient } from "./deepseek-client";
import { createWorkReviewTokenHubClient } from "./tokenhub-client";
import { createWorkAnalysisEvaluationFailureSink, type WorkAnalysisFailureSink } from "./evaluation-failure-capture";
import { validateWorkDuplicateCoverageOutput, type WorkDuplicateCoverageRequest, type WorkDuplicateCoverageEvaluation } from "./duplicate-coverage";

type WorkReviewRuntimeEnv = Readonly<Record<string, string | undefined>>;

export type WorkExtractorSchemaRepair = {
  validationIssues: Array<{ path: string; code: string }>;
  validationIssuesTruncated: boolean;
};

export type WorkMeetingExtractorInput = {
  accountId: string;
  meetingId: string;
  publicationId: string;
  canonicalDigest: string;
  window: WorkMeetingTranscriptWindow;
  schemaRepair?: WorkExtractorSchemaRepair;
  onItemDiscarded?: (discard: WorkExtractorItemDiscard) => void;
  signal?: AbortSignal;
};

export type WorkExtractorItemDiscardReason =
  | "schema_invalid"
  | "evidence_not_allowed"
  | "evidence_closure_invalid"
  | "duplicate_item"
  | "relationship_invalid";

/**
 * Safe per-item diagnostics. This deliberately contains no Candidate text,
 * Evidence ID, actor, date, or other Provider-returned value.
 */
export type WorkExtractorItemDiscard = {
  /** One-based position in the Provider response. */
  itemIndex: number;
  reason: WorkExtractorItemDiscardReason;
  issues: Array<{ path: string; code: string }>;
  issuesTruncated: boolean;
};

export type WorkMeetingVerifierInput = {
  accountId: string;
  meetingId: string;
  publicationId: string;
  canonicalDigest: string;
  segments: unknown[];
  claims: WorkAtomicClaim[];
  duplicateCoverage?: WorkDuplicateCoverageRequest[];
  timestampQualityBySegmentId?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
};

export type MaterializedWorkExtractorCandidate = Omit<
  WorkExtractorCandidateDraft,
  "structuredData" | "evidenceIds"
> & {
  structuredData: WorkMeetingCandidateStructuredData;
  evidenceRefs: WorkMaterializedEvidence[];
};

export interface WorkMeetingExtractor {
  readonly profile: WorkReviewAnalysisProviderProfile;
  extract(input: WorkMeetingExtractorInput): Promise<WorkExtractorCandidateDraft[]>;
}

export interface WorkMeetingVerifier {
  readonly profile: WorkReviewAnalysisProviderProfile;
  verify(input: WorkMeetingVerifierInput): Promise<WorkMeetingVerifierResult>;
}
export type WorkMeetingVerifierResult = { items: WorkVerifierClaimDraft[]; coverage: WorkDuplicateCoverageEvaluation[] };

export type WorkStructuredJsonRequest = (input: {
  stage: "extractor" | "verifier" | "deduplicator";
  profile: WorkReviewAnalysisProviderProfile;
  name: string;
  schema: z.ZodTypeAny;
  requestInput: Parameters<typeof parseStructuredJsonResponse>[0]["requestInput"];
  jsonInstruction: string;
  normalize?: (value: unknown) => unknown;
  signal?: AbortSignal;
}) => Promise<unknown>;

export class WorkMeetingAnalysisProviderError extends Error {
  constructor(
    public readonly code:
      | "work_extractor_output_invalid"
      | "work_verifier_output_invalid"
      | "work_deduplicator_output_invalid"
      | "work_evidence_not_allowed"
      | "work_evidence_closure_invalid"
      | "work_analysis_provider_timeout"
      | "work_analysis_provider_cancelled"
      | "work_analysis_provider_incomplete"
      | "work_analysis_provider_invalid_json"
      | "work_analysis_provider_rate_limited"
      | "work_analysis_provider_request_rejected"
      | "work_analysis_provider_transient_unavailable"
      | "work_analysis_provider_unavailable"
      | "work_analysis_fixture_provider_forbidden",
    message: string,
    options?: ErrorOptions,
    public readonly safeDiagnostics?: WorkAnalysisProviderSafeDiagnostics
  ) {
    super(message, options);
    this.name = "WorkMeetingAnalysisProviderError";
  }
}

const WORK_EXTRACTOR_EVIDENCE_SEGMENT_IDS_WIRE_SCHEMA = z.array(WorkReviewIdSchema).min(1).max(20);
export const WORK_EXTRACTOR_MAX_WIRE_ITEMS = 20;
/** Extraction capacity is independent of the final review display limit. */
export const WORK_EXTRACTOR_MAX_ITEMS_PER_WINDOW = WORK_EXTRACTOR_MAX_WIRE_ITEMS;

const WorkExtractorPlanChangeStageWireSchema = z.object({
  content: z.string().trim().min(1).max(1_000),
  status: z.enum(["proposed", "revised", "current", "withdrawn", "unclear"]),
  evidenceSegmentIds: WORK_EXTRACTOR_EVIDENCE_SEGMENT_IDS_WIRE_SCHEMA
}).strict();

const WorkExtractorDecisionFinalityWireSchema = z.object({
  value: WorkMeetingDecisionFinalitySchema,
  text: z.string().trim().min(1).max(1_000),
  evidenceSegmentIds: WORK_EXTRACTOR_EVIDENCE_SEGMENT_IDS_WIRE_SCHEMA
}).strict();

const WorkExtractorActorWireSchema = z.object({
  label: z.string().trim().min(1).max(512),
  role: z.enum(["speaker", "owner"]),
  text: z.string().trim().min(1).max(1_000),
  evidenceSegmentIds: WORK_EXTRACTOR_EVIDENCE_SEGMENT_IDS_WIRE_SCHEMA
}).strict();

const WorkExtractorDeadlineWireSchema = z.object({
  dueAt: WorkReviewIsoDateTimeSchema.optional(),
  originalDueExpression: z.string().trim().min(1).max(256).optional(),
  text: z.string().trim().min(1).max(1_000),
  evidenceSegmentIds: WORK_EXTRACTOR_EVIDENCE_SEGMENT_IDS_WIRE_SCHEMA
}).strict().superRefine((deadline, context) => {
  if (deadline.dueAt === undefined && deadline.originalDueExpression === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dueAt"],
      message: "Deadline requires dueAt or originalDueExpression"
    });
  }
});

const WorkExtractorAcceptedCommitmentWireSchema = z.object({
  text: z.string().trim().min(1).max(1_000),
  evidenceSegmentIds: WORK_EXTRACTOR_EVIDENCE_SEGMENT_IDS_WIRE_SCHEMA
}).strict();

const WORK_EXTRACTOR_CANDIDATE_WIRE_COMMON = {
  coreText: z.string().trim().min(1).max(1_000),
  evidenceSegmentIds: WORK_EXTRACTOR_EVIDENCE_SEGMENT_IDS_WIRE_SCHEMA,
  causality: z.literal(true).optional(),
  actor: WorkExtractorActorWireSchema.optional(),
  deadline: WorkExtractorDeadlineWireSchema.optional()
} as const;

const WORK_EXTRACTOR_MAIN_CLAIM_TYPE_BY_KIND = {
  discussion_topic: "topic",
  proposal: "proposal",
  decision: "decision_existence",
  commitment: "commitment_existence",
  open_question: "open_question",
  plan_change: "plan_change",
  action_item: "action_item"
} as const;

const WorkExtractorCandidateWireSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("discussion_topic"),
    ...WORK_EXTRACTOR_CANDIDATE_WIRE_COMMON
  }).strict(),
  z.object({
    kind: z.literal("proposal"),
    ...WORK_EXTRACTOR_CANDIDATE_WIRE_COMMON
  }).strict(),
  z.object({
    kind: z.literal("decision"),
    ...WORK_EXTRACTOR_CANDIDATE_WIRE_COMMON,
    decisionFinality: WorkExtractorDecisionFinalityWireSchema
  }).strict(),
  z.object({
    kind: z.literal("commitment"),
    ...WORK_EXTRACTOR_CANDIDATE_WIRE_COMMON
  }).strict(),
  z.object({
    kind: z.literal("open_question"),
    ...WORK_EXTRACTOR_CANDIDATE_WIRE_COMMON
  }).strict(),
  z.object({
    kind: z.literal("plan_change"),
    ...WORK_EXTRACTOR_CANDIDATE_WIRE_COMMON,
    planStages: z.array(WorkExtractorPlanChangeStageWireSchema).min(2).max(8)
  }).strict(),
  z.object({
    kind: z.literal("action_item"),
    ...WORK_EXTRACTOR_CANDIDATE_WIRE_COMMON,
    actionBasis: WorkMeetingActionBasisSchema,
    acceptedCommitment: WorkExtractorAcceptedCommitmentWireSchema.optional(),
    // One-based response-local item position. This is a relationship pointer,
    // not a canonical Candidate ID and never escapes server canonicalization.
    relatedCommitmentItem: z.number().int().min(1).max(WORK_EXTRACTOR_MAX_WIRE_ITEMS).optional()
  }).strict()
]).superRefine((candidate, context) => {
  const evidenceLists: Array<{ path: (string | number)[]; ids: string[] }> = [{
    path: ["evidenceSegmentIds"],
    ids: candidate.evidenceSegmentIds
  }];
  if (candidate.actor) evidenceLists.push({
    path: ["actor", "evidenceSegmentIds"],
    ids: candidate.actor.evidenceSegmentIds
  });
  if (candidate.deadline) evidenceLists.push({
    path: ["deadline", "evidenceSegmentIds"],
    ids: candidate.deadline.evidenceSegmentIds
  });
  if (candidate.kind === "decision") evidenceLists.push({
    path: ["decisionFinality", "evidenceSegmentIds"],
    ids: candidate.decisionFinality.evidenceSegmentIds
  });
  if (candidate.kind === "action_item" && candidate.acceptedCommitment) evidenceLists.push({
    path: ["acceptedCommitment", "evidenceSegmentIds"],
    ids: candidate.acceptedCommitment.evidenceSegmentIds
  });
  if (candidate.kind === "plan_change") candidate.planStages.forEach((stage, stageIndex) => {
    evidenceLists.push({
      path: ["planStages", stageIndex, "evidenceSegmentIds"],
      ids: stage.evidenceSegmentIds
    });
  });
  for (const evidence of evidenceLists) {
    if (new Set(evidence.ids).size !== evidence.ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: evidence.path,
        message: "Evidence Segment IDs must be unique"
      });
    }
  }
  if (candidate.actor?.role === "owner"
    && candidate.kind !== "commitment"
    && candidate.kind !== "action_item") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actor", "role"],
      message: "Owner attribution is allowed only for Commitment or Action Item"
    });
  }
  if (candidate.kind === "action_item") {
    const hasAcceptedCommitment = candidate.acceptedCommitment !== undefined;
    if (candidate.actionBasis === "explicit_commitment" && !hasAcceptedCommitment) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptedCommitment"],
        message: "Explicit-commitment Action Item requires acceptedCommitment"
      });
    } else if (candidate.actionBasis !== "explicit_commitment" && hasAcceptedCommitment) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptedCommitment"],
        message: "Non-commitment Action Item cannot contain acceptedCommitment"
      });
    }
    if (candidate.relatedCommitmentItem !== undefined
      && candidate.actionBasis !== "explicit_commitment") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relatedCommitmentItem"],
        message: "Only an explicit-commitment Action Item may reference a Commitment"
      });
    }
  }
  if (candidate.kind === "plan_change") {
    const stageSignatures = candidate.planStages.map((stage) => [
      stage.status,
      stage.content.trim().replace(/\s+/gu, " ").toLocaleLowerCase()
    ].join("\u0000"));
    if (new Set(stageSignatures).size !== stageSignatures.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["planStages"],
        message: "Plan Stages require distinct status/content semantics"
      });
    }
  }
});

/**
 * Provider-facing shape. It is intentionally narrower than the canonical
 * domain contract so a single transcript window cannot request an unbounded
 * response. Canonical Evidence closure is still validated after parsing.
 */
export const WorkExtractorWireResponseSchema = z.object({
  items: z.array(WorkExtractorCandidateWireSchema).max(WORK_EXTRACTOR_MAX_WIRE_ITEMS)
}).strict().superRefine((response, context) => {
  const exactCandidateSignatures = response.items.map((item) => JSON.stringify(item));
  if (new Set(exactCandidateSignatures).size !== exactCandidateSignatures.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: "Compact response cannot repeat an identical Candidate"
    });
  }
});

/**
 * Request-boundary envelope. The root shape and response capacity remain
 * fail-closed, while Candidate schema and Evidence validation happen item by
 * item after the JSON document has been parsed.
 */
export const WorkExtractorWireEnvelopeSchema = z.object({
  items: z.array(z.unknown()).max(WORK_EXTRACTOR_MAX_WIRE_ITEMS)
}).strict();

export const WorkVerifierWireResponseSchema = z.object({
  items: z.array(WorkVerifierClaimDraftSchema).max(24)
}).strict();

/**
 * Keeps the Verifier transport envelope bounded while allowing one malformed
 * evaluation to be treated as a missing result for its Claim. Claim identity
 * and Evidence closure are still checked fail-closed after item parsing.
 */
export const WorkVerifierWireEnvelopeSchema = z.object({
  items: z.array(z.unknown()).max(24),
  // Optional advice must not poison independently valid Claim evaluations.
  coverage: z.unknown().optional()
}).strict();

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function withMissingValue(
  record: Record<string, unknown>,
  key: string,
  fallback: null | unknown[]
) {
  return record[key] === undefined ? fallback : record[key];
}

const WORK_CANDIDATE_KIND_VALUES = new Set([
  "discussion_topic", "proposal", "decision", "commitment",
  "open_question", "plan_change", "action_item"
]);
const WORK_CANDIDATE_KIND_ALIASES: Readonly<Record<string, string>> = {
  topic: "discussion_topic",
  question: "open_question",
  action: "action_item"
};
const WORK_DECISION_FINALITY_VALUES = new Set(["final", "tentative", "unclear"]);
const WORK_ACTOR_ROLE_VALUES = new Set(["speaker", "owner"]);
const WORK_ACTION_BASIS_VALUES = new Set([
  "explicit_commitment", "assignment_without_acceptance", "suggested_action", "unowned_follow_up"
]);
const WORK_PLAN_STAGE_STATUS_VALUES = new Set([
  "proposed", "revised", "current", "withdrawn", "unclear"
]);
const WORK_SUPPORT_VERDICT_VALUES = new Set([
  "entailed", "partially_entailed", "unsupported", "contradicted", "unverifiable"
]);

function normalizeKnownWireEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  aliases: Readonly<Record<string, string>> = {}
) {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (allowed.has(normalized)) return normalized;
  return aliases[normalized] ?? value;
}

/**
 * Repairs mechanical enum casing/aliases and treats null optional date values
 * as absent. Required facts remain required; no Evidence, outcome, actor,
 * non-null date, commitment link, or causality classification is inferred.
 */
export function normalizeWorkExtractorWireResponse(value: unknown): unknown {
  const root = recordValue(value);
  if (!root) return value;
  const rawItems = root.items;
  if (!Array.isArray(rawItems)) return { ...root, items: rawItems };
  return {
    ...root,
    items: rawItems.map((rawItem) => {
      const item = recordValue(rawItem);
      if (!item) return rawItem;
      const rawStages = item.planStages;
      const rawDecisionFinality = recordValue(item.decisionFinality);
      const rawActor = recordValue(item.actor);
      const rawDeadline = recordValue(item.deadline);
      const deadline = rawDeadline ? { ...rawDeadline } : null;
      if (deadline?.dueAt === null) delete deadline.dueAt;
      if (deadline?.originalDueExpression === null) delete deadline.originalDueExpression;
      const kind = normalizeKnownWireEnum(
        item.kind,
        WORK_CANDIDATE_KIND_VALUES,
        WORK_CANDIDATE_KIND_ALIASES
      );
      return {
        ...item,
        kind,
        ...(deadline ? { deadline } : {}),
        ...(rawDecisionFinality ? {
          decisionFinality: {
            ...rawDecisionFinality,
            value: normalizeKnownWireEnum(
              rawDecisionFinality.value,
              WORK_DECISION_FINALITY_VALUES
            )
          }
        } : {}),
        ...(rawActor ? {
          actor: {
            ...rawActor,
            role: normalizeKnownWireEnum(rawActor.role, WORK_ACTOR_ROLE_VALUES)
          }
        } : {}),
        ...(item.actionBasis === undefined ? {} : {
          actionBasis: normalizeKnownWireEnum(item.actionBasis, WORK_ACTION_BASIS_VALUES)
        }),
        ...(Array.isArray(rawStages) ? {
          planStages: rawStages.map((rawStage) => {
            const stage = recordValue(rawStage);
            return stage
              ? {
                  ...stage,
                  status: normalizeKnownWireEnum(
                    stage.status,
                    WORK_PLAN_STAGE_STATUS_VALUES
                  )
                }
              : rawStage;
            })
        } : {})
      };
    })
  };
}

export function normalizeWorkVerifierWireResponse(value: unknown): unknown {
  const root = recordValue(value);
  if (!root) return value;
  const rawItems = root.items;
  return {
    ...root,
    items: Array.isArray(rawItems)
      ? rawItems.map((rawItem) => {
          const item = recordValue(rawItem);
          return item
            ? {
                ...item,
                supportVerdict: normalizeKnownWireEnum(
                  item.supportVerdict,
                  WORK_SUPPORT_VERDICT_VALUES
                ),
                issueCodes: withMissingValue(item, "issueCodes", []),
                supportedEvidenceIds: withMissingValue(item, "supportedEvidenceIds", [])
              }
            : rawItem;
        })
      : rawItems
  };
}

/**
 * Expands the compact Provider wire into the unchanged canonical domain
 * contract. IDs, Candidate Evidence, empty/default structured fields, display
 * copy, and duplicated semanticValue objects are derived deterministically.
 * No fact is inferred from Claim prose.
 */
type IndexedWorkExtractorWireItem = {
  item: z.infer<typeof WorkExtractorCandidateWireSchema>;
  sourceIndex: number;
};

function coreTextWithoutActorLabel(text: string, actorLabel?: string) {
  // These are explicit tokens supplied by the Extractor, not inferred people.
  return (actorLabel ? text.split(actorLabel).join("有人") : text)
    .replace(/\bspeaker[ _-]*\d+\b/giu, "有人")
    .replace(/^有人\s+/u, "有人");
}

function canonicalizeParsedWorkExtractorItems(
  indexedItems: IndexedWorkExtractorWireItem[]
): WorkExtractorResponse {
  return {
    items: indexedItems.map(({ item, sourceIndex }) => {
      const claims: WorkExtractorCandidateDraft["claims"] = [{
        clientClaimKey: `wire_claim_${sourceIndex + 1}_main`,
        claimType: WORK_EXTRACTOR_MAIN_CLAIM_TYPE_BY_KIND[item.kind],
        semanticRiskFlags: item.causality === true ? ["causality"] : [],
        semanticValue: null,
        // Identity stays in its separately reviewable Claim. This removes only
        // explicit labels, before verification; it never infers an owner.
        text: coreTextWithoutActorLabel(item.coreText, item.actor?.label),
        evidenceIds: item.evidenceSegmentIds
      }];
      if (item.kind === "decision") claims.push({
        clientClaimKey: `wire_claim_${sourceIndex + 1}_decision_finality`,
        claimType: "decision_finality",
        semanticRiskFlags: [],
        semanticValue: {
          kind: "decision_finality",
          value: item.decisionFinality.value
        },
        text: item.decisionFinality.text,
        evidenceIds: item.decisionFinality.evidenceSegmentIds
      });
      if (item.actor) claims.push({
        clientClaimKey: `wire_claim_${sourceIndex + 1}_${item.actor.role}`,
        claimType: item.actor.role === "speaker" ? "speaker_attribution" : "commitment_owner",
        semanticRiskFlags: [],
        semanticValue: item.actor.role === "speaker"
          ? { kind: "speaker_attribution", value: item.actor.label }
          : { kind: "commitment_owner", value: item.actor.label },
        text: item.actor.text,
        evidenceIds: item.actor.evidenceSegmentIds
      });
      if (item.deadline) claims.push({
        clientClaimKey: `wire_claim_${sourceIndex + 1}_deadline`,
        claimType: "deadline",
        semanticRiskFlags: [],
        semanticValue: {
          kind: "deadline",
          dueAt: item.deadline.dueAt ?? null,
          originalDueExpression: item.deadline.originalDueExpression ?? null
        },
        text: item.deadline.text,
        evidenceIds: item.deadline.evidenceSegmentIds
      });
      if (item.kind === "action_item" && item.acceptedCommitment) claims.push({
        clientClaimKey: `wire_claim_${sourceIndex + 1}_accepted_commitment`,
        claimType: "commitment_existence",
        semanticRiskFlags: [],
        semanticValue: null,
        text: coreTextWithoutActorLabel(item.acceptedCommitment.text, item.actor?.label),
        evidenceIds: item.acceptedCommitment.evidenceSegmentIds
      });
      const claimTexts = [...new Set(claims.map((claim) => claim.text.trim()))];
      const planStages = item.kind === "plan_change" ? item.planStages.map((stage, stageIndex) => ({
        clientStageKey: `wire_stage_${sourceIndex + 1}_${stageIndex + 1}`,
        content: stage.content,
        status: stage.status,
        // Stage speaker attribution is not represented by an exact atomic
        // Claim in the canonical contract, so compact wire cannot publish it.
        rawSpeakerLabel: null,
        evidenceIds: stage.evidenceSegmentIds
      })) : [];
      return {
        clientCandidateKey: `wire_candidate_${sourceIndex + 1}`,
        kind: item.kind,
        title: claimTexts[0]!,
        body: claimTexts.join("；"),
        evidenceIds: [...new Set([
          ...claims.flatMap((claim) => claim.evidenceIds),
          ...planStages.flatMap((stage) => stage.evidenceIds)
        ])],
        structuredData: {
          decisionFinality: item.kind === "decision" ? item.decisionFinality.value : null,
          rawActorLabel: item.actor?.role === "speaker" ? item.actor.label : null,
          candidateOwner: item.actor?.role === "owner" ? item.actor.label : null,
          dueAt: item.deadline?.dueAt ?? null,
          originalDueExpression: item.deadline?.originalDueExpression ?? null,
          actionBasis: item.kind === "commitment"
            ? "explicit_commitment"
            : item.kind === "action_item"
              ? item.actionBasis
              : null,
          relatedCommitmentCandidateId: item.kind === "action_item"
            && item.relatedCommitmentItem !== undefined
            ? `wire_candidate_${item.relatedCommitmentItem}`
            : null,
          planStages
        },
        claims
      };
    })
  };
}

export function canonicalizeWorkExtractorClientKeys(value: unknown): WorkExtractorResponse {
  const parsed = WorkExtractorWireResponseSchema.parse(
    normalizeWorkExtractorWireResponse(value)
  );
  parsed.items.forEach((item, index) => {
    if (item.kind !== "action_item" || item.relatedCommitmentItem === undefined) return;
    const target = parsed.items[item.relatedCommitmentItem - 1];
    if (!target || target.kind !== "commitment") {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_closure_invalid",
        `Extractor Action Item ${index + 1} referenced a non-Commitment local item`
      );
    }
  });
  return canonicalizeParsedWorkExtractorItems(
    parsed.items.map((item, sourceIndex) => ({ item, sourceIndex }))
  );
}

export const WORK_MEETING_EXTRACTOR_JSON_INSTRUCTION =
  `输出严格的 compact {items:[...]} JSON，items 最多 ${WORK_EXTRACTOR_MAX_ITEMS_PER_WINDOW} 项；没有显著会议结果时输出 {items:[]}。` +
  "每个 item 必须包含 kind、简短 coreText、evidenceSegmentIds；不得输出 claims、claimType、任何 candidate/claim/stage id 或 key、title、body、structuredData、null 字段或空数组。" +
  "kind 只能是 discussion_topic、proposal、decision、commitment、open_question、plan_change、action_item 之一。" +
  "所有 kind 的公共字段只有 kind、coreText、evidenceSegmentIds，以及有明确依据时可选的 causality、actor、deadline；未列出的字段一律禁止。" +
  "discussion_topic、proposal、commitment、open_question 只允许公共字段；commitment 不得输出 actionBasis、acceptedCommitment 或 relatedCommitmentItem。" +
  "decision 的专属字段只有 decisionFinality；plan_change 的专属字段只有 planStages；action_item 的专属字段只有 actionBasis、acceptedCommitment、relatedCommitmentItem，不得跨 kind 搬用。" +
  "服务端按 kind 将 coreText 确定性展开为主 Claim；不要自行输出主 Claim 类型或排序。" +
  "仅当 coreText 明确断言因果关系时输出 causality:true；否则省略 causality，时间先后不是因果。" +
  "decision 必须输出 decisionFinality={value,text,evidenceSegmentIds}，value 只能是 final、tentative、unclear。" +
  "若明确说话人归属或负责人，最多输出一个 actor={label,role,text,evidenceSegmentIds}；role 只能是 speaker 或 owner，owner 只用于 commitment/action_item，不得把被点名者推断为 owner。" +
  "若有截止时间，输出 deadline={dueAt?,originalDueExpression?,text,evidenceSegmentIds}，dueAt 或 originalDueExpression 至少一项。" +
  "deadline 的 text、evidenceSegmentIds 必填；originalDueExpression 保留输入中的时间表达，不得把自然语言日期放入 dueAt。" +
  "仅当输入明确给出完整年月日、时刻和时区，足以确定唯一时刻时才输出 dueAt，并转为以 Z 结尾的 ISO 8601 UTC 字符串（YYYY-MM-DDTHH:mm:ssZ）。" +
  "缺少任一年月日、时刻或时区信息时，只输出 originalDueExpression 连同 text、evidenceSegmentIds，省略 dueAt；不得猜年份、补零点、假定时区或用系统当前日期补全。" +
  "没有明确时间表达时省略整个 deadline，不能只输出 text、evidenceSegmentIds，也不能用 null 或空字符串代替缺失日期。" +
  "action_item 必须输出 actionBasis=explicit_commitment|assignment_without_acceptance|suggested_action|unowned_follow_up；" +
  "explicit_commitment 时必须输出 acceptedCommitment={text,evidenceSegmentIds}，其他 actionBasis 禁止输出 acceptedCommitment。" +
  "plan_change 必须输出至少 2 个 planStages；每项只包含 content、status、evidenceSegmentIds，不输出说话人归属。" +
  "不同 plan stage 的 status/content 组合必须不同；如果同一个输入 segment 同时明确表达旧方案和新方案，两个 stage 可以引用同一个 Evidence ID。" +
  "plan stage status 只能是 proposed、revised、current、withdrawn、unclear。" +
  "只有 action_item 且 actionBasis=explicit_commitment 时可以输出 acceptedCommitment；此时若必须关联本响应中的 commitment 才输出 relatedCommitmentItem，值为目标 item 的 1-based 位置。" +
  "evidenceSegmentIds 和 planStages 必须输出数组；所有 Evidence ID 只能使用输入窗口中的 segment id，不能返回来源原文。" +
  "每个 Evidence ID 都是不可改写的 opaque 字符串，必须逐字复制输入行方括号内的完整 segment id（不含方括号），保留全部前缀、分隔符和后缀；禁止简写、截断、重编号、按位置生成 ID 或使用其他窗口的 ID。" +
  "actor、deadline、decisionFinality、acceptedCommitment、planStages 内的每个 evidenceSegmentIds 必须是该 item 顶层 evidenceSegmentIds 的非空子集，各数组内不得重复 ID。";

export const WORK_MEETING_VERIFIER_JSON_INSTRUCTION =
  "输出严格的 {items:[...]} JSON。每个输入 claim 必须恰好返回一项，包含 claimId、supportVerdict、" +
  "issueCodes、supportedEvidenceIds；issueCodes 和 supportedEvidenceIds 必须始终输出数组，没有内容时输出 []。" +
  "supportVerdict 只能是 entailed、partially_entailed、unsupported、" +
  "contradicted、unverifiable；supportedEvidenceIds 只能来自该 claim 的 Evidence allowlist。" +
  "unsupported、contradicted、unverifiable 的 supportedEvidenceIds 输出 []；不要把反驳该 Claim 的证据填进支持证据字段。";
const DUPLICATE_COVERAGE_INSTRUCTION =
  "若输入包含duplicateCoverage，额外输出coverage数组，每条{relationId,verdict,supportedEvidenceIds}。" +
  "verdict只能是complete、partial、uncertain。逐字复制relationId；supportedEvidenceIds仅选该关系original与coveredBy的Evidence。";

// Both stages use the meeting's accepted outcome as the review unit. Editorial
// granularity alone must not turn supported facts into a semantic violation.
const WORK_MEETING_REVIEW_UNIT_RULES = [
  "以会议实际共同决定或明确接受的结果作为一个审核事项。同一结果可以包含多个步骤、组成部分、验收测试、日期和触发/退出条件；不要求一个事项只有一个动作或一句话。",
  "核对同一事项的接受、范围和条件：明确认领加上后续同一事项的细节可以共同支持承诺。临时、限次数或附条件的明确接受仍是承诺，不能仅因不是长期或无条件接受就视为 tentative。不得删掉重要限制使承诺扩大。",
  "共同采纳的方案范围或指标组合可以是一项决定；为同一交付物提供实现、测试和说明可以是一项承诺。语句有列举、多个日期或可拆成更细任务，不等于混合了不成立的事实。",
  "同一交付物的收集输入、核对确认、移除不满足范围/质量要求的部分，是一个交付的阶段与验收条件；每个阶段引用自己的依据即可共同成立。重复出现同一认领及不同阶段日期不构成共同承担，不得仅因此判 independent_items_conflated。不同交付物仍分别审核。",
  "例如：明确接受完成权限接口及隔离测试，涉及敏感内容则取消，是一个带验收要求和退出条件的承诺；应急方案包含停用开关、恢复说明及触发时保留排查日志，也可以作为一个事项。",
  "独立事项应分别表达，尤其是不同人的认领；但只有合并造成未经支持的共同承担、错误决定状态或扩大接受范围时，才构成 independent_items_conflated。甲接受培训、乙接受名单，不能合并成甲接受培训和名单。",
  "同一事项的步骤与不同业务结果要区分：培训材料与参与范围是不同结果，不能仅因连续出现两个‘我认领’就用‘同时认领’连写成共享主体；ASR可能把换人发言合在同一Segment。没有明确同一承担者的证据时，应分别保留核心认领。",
  "同一 Segment 可能跨发言或话题，speaker 标签不等于真实身份。前一个事项的否定或拒绝不能覆盖后一个事项的明确接受；也不能把后一个事项的认领倒推给前一个未认领事项。"
] as const;

const EXTRACTOR_SYSTEM_PROMPT = [
  "你是 Work Meeting Extractor。只从当前 canonical Transcript 窗口提取讨论、建议、决定、承诺、未解决问题、方案变化与行动事项候选。",
  "所有输出都只是待用户审核的候选，不是公司正式记录、Todo、长期 Memory 或绩效判断。",
  "一个 Candidate 表示一个可独立审核的会议结果，而不是一句话：同一事项在当前窗口内合并；coreText 只表达该事项本身。",
  ...WORK_MEETING_REVIEW_UNIT_RULES,
  "同一事项的核心、交付日期和限制条件尽量合为一项，完整引用相关 Evidence；不要把验收测试、退出条件或仅补充日期的后续话语另造为新承诺。",
  "触发条件、否定、例外、适用范围、待完成/已完成状态都属于coreText的核心含义，不能只放在可选actor/deadline/finality里，也不能在压缩中删除或改变。条件成立才操作，不得简写为无条件执行；阶段承诺不能写成已经完成。",
  "Canonical是唯一原文。疑似转写错字若影响条件、状态、否定或范围，不能按常识恢复成一个确定词语；即使猜法通顺也不可以。保留原文疑似片段并在coreText就近写明‘原文“…”含糊，待确认’，其余有依据的事项照常提取，保留完整条件句及其他限制。不能只在文末加待确认却把猜出的含义写成事实，不改Canonical。",
  "coreText 使用中性事项文案，不写 speaker_N、具体承担者姓名或第一人称；认领是否存在与承担者身份是两件事。需要身份时只放 actor 字段，不能在 coreText 偷带归属。",
  "方案编号或名称出现ASR同音、前后不一致时，不要猜测或纠正名称。若具体采纳范围明确，coreText 直接写已采纳的具体范围并引用明确决定的段落；不能因为名称不清就漏掉决定，也不要把猜出的方案名写成事实。",
  "已认领者的泛称同样属于归属：coreText 也不要写‘由主持方/运营侧/技术负责人/我/我们负责’。例如‘由我临时整理两次汇总’只提取‘临时整理两次汇总’，不能猜成主持方负责。‘需要找到政策负责人’这类未来事项要求可以保留，因为它没有断言谁已经认领。",
  "普通 discussion_topic、proposal、open_question 默认只输出 kind、coreText、evidenceSegmentIds；只有确实出现的高风险说话人归属或截止时间才增加 actor/deadline。",
  "后续 Decision 已吸收的普通 Proposal 不重复输出；后续已经解决的问题不输出 open_question；寒暄、背景复述、状态播报不生成 Candidate。",
  "按显著性选择结果，不按录音长度机械截断；明确的 Decision、Commitment、Action Item、归属、截止日期、Plan Change 或因果断言不得因数量控制而丢失。",
  "完成整窗阅读后逐项核对覆盖：明确决定、独立认领、仍未解决的问题及各自条件。不要用会末多人/多事项总括代替已经出现的独立结果，也不要重复输出总括。输出上限是传输保护，不是必须凑满或压缩成少数项的目标。",
  "Evidence 要覆盖完整语义：认领可能在前一段，交付物、日期、次数限制或放弃条件可能在后续段；请一起引用。存在明确接受时保留 commitment，即使身份不明；不要仅因漏读前一句就降为 unowned_follow_up。",
  "每项 coreText、actor、deadline、decisionFinality、acceptedCommitment 和 plan stage 都必须逐字复制输入中的完整 segment id；ID 是 opaque 字符串，不能缩写、重编号或自行生成；不得生成来源原文、不得猜测真实身份。",
  "仅有相对日期或年月日、时刻、时区信息不完整时，deadline 只保留 originalDueExpression、text、evidenceSegmentIds，不输出 dueAt；不得填入输入没有支持的年份或时刻。",
  "中文日期中的‘日’和‘号’都有效，例如‘9月11日’、‘9月11号’、‘九月十一号中午前’；originalDueExpression 原样保留该事项Evidence中的表达，包括前后、时段等限制。只说月日不能补年份，提到日期本身也不等于约定了截止时间。",
  "Decision 必须区分 final、tentative、unclear；Commitment 必须存在明确接受或承诺表达；Assignment without acceptance 不是 Commitment。",
  "Action Item 必须标明 explicit_commitment、assignment_without_acceptance、suggested_action 或 unowned_follow_up。",
  "Open Question 必须考虑后续是否已经回答；Plan Change 必须保留旧方案、中间修订和当前方案，不能只保留最后一句。",
  "coreText 明确断言因果关系时必须输出 causality=true，单纯时间先后不得标记。",
  "Decision finality、speaker attribution、commitment owner 与 deadline 必须使用对应命名字段输出 exact value；服务端只做确定性展开，不会从 prose 猜值。",
  `强制语义边界：${WORK_MEETING_SEMANTIC_SAFETY_RULES.join("; ")}。`
].join("\n");

const VERIFIER_SYSTEM_PROMPT = [
  "输入带evidenceFields时，evidenceById的每个值按evidenceFields列顺序排列，所有原文、时间和发言标签完整保留。coverageSubjects按引用共享候选正文；duplicateCoverage.original和coveredBy只引用该表的明确成员。textFromClaimId引用items中该Claim的原始text，facts中的{claimId}复用该Claim的claimType/text/evidenceIds；这些仅是无损存储引用，不扩大任何Evidence allowlist或覆盖关系。",
  "duplicateCoverage是少量拟删除关系的独立覆盖问题：原项original的全部实质含义是否被明确列出的coveredBy集合共同完整保留。先看原项，再逐一对照指定覆盖项，最后核对各自Evidence。items为真不等于覆盖关系成立。",
  "complete要求动作、每个阶段、日期、条件、否定、例外、范围限制、主语和状态全部保留，允许等价改写，不要求逐字相同。任一独有细节未覆盖则partial，无法判断或Evidence不足则uncertain；两者均保留原项。",
  "只能使用这条关系列出的覆盖项；同批其他Candidate、Transcript其他位置还能找到、主题相似，都不能补救覆盖缺口。多项可以联合覆盖，但必须逐项实际核对，不能因关系结构合法就判complete。完整支持的Evidence须涵盖原项及每个明确列出的覆盖项，不改写Canonical或候选。",
  "你是独立的 Work Meeting Claim Verifier。只能使用输入claim或duplicateCoverage关系各自的canonical Evidence allowlist。你的任务是识别实质事实错误，不是要求审核文案达到理想的拆分粒度。",
  "先逐分句核对操作/交付、触发条件、否定、例外、适用范围和待完成/已完成状态，再判断决定或接受是否存在。它们全是核心语义；确认有人认领不等于该Claim的条件和状态都正确。",
  "遇到含糊或疑似错字的Canonical，不得把它自动读成你认为的正确词再放行Claim。将含糊条件改成确定的新触发词、把待处理改成已完成、删掉条件或反转否定，均用core_meaning_changed并返回unsupported/contradicted；常识上的合理性不是Evidence。",
  `若Claim准确保留含糊原文片段、就近明确待确认，并完整保留其他已支持的操作和条件，可返回entailed及${WORK_MEETING_CANONICAL_WORDING_UNCLEAR}，后端进入现有待确认展示。这个代码只用于已保留歧义的谨慎表述；不能拯救已猜词/漏条件/错误归属的Claim，更不能因原文一处含糊就删除整项有依据的交付。`,
  "优先防止错归属：逐个分句核对主语。原文‘甲认领A，乙认领B，我认领C’不能支持‘甲认领A、B、C’，即使这些事情都确实被某个人接受。Claim中在一个姓名后连续列举多项认领而没有重新指明主体，会暗示该姓名承担后续所有事项；必须有该姓名逐项接受的证据，否则 independent_items_conflated。ASR疑似把人名识别成普通词或漏掉换人信息时，不能自行将后续认领延续到前一个姓名。",
  "不要读取或信任 Generator narrative，不得改写 Claim，不得通过多次改写制造通过。",
  "semanticValue 非空时，它是独立的精确值契约，必须与该 Claim text 一起得到 Evidence 支持；不能用语义相近放行错误的人名、日期或finality。semanticValue=null 的核心事项按实质范围核验，不能要求它另行证明未断言的可选属性。",
  "逐项判断 Evidence 是否支持 Claim；原文只出现人名、日期、任务或时间顺序都不足以证明负责人、截止日期、承诺或因果。",
  ...WORK_MEETING_REVIEW_UNIT_RULES,
  "decision_existence 按该Claim的Evidence时间顺序区分早期提议、后续明确采纳和再后来的撤回或替换。先推荐、后明确决定采用同一范围，支持决定存在；不能只看到早期提议就使用 proposal_promoted_to_decision 或 earlier_plan_promoted_to_final。支持证据必须包含实际采纳的段落，不能只返回较早的推荐。",
  "earlier_plan_promoted_to_final 用于把已被后续撤回或替换的旧范围写成当前决定；它不适用于仅仅曾被讨论过、随后明确采纳的同一范围。只有提议、仍待批准、沉默或无异议时不能认定已采纳；明确撤回、实质范围不同或遗漏关键条件仍须拒绝。决定存在与是否永久最终是不同Claim。",
  "ASR可能使方案标签出现同音或字形差异。具体范围与明确采纳行为一致、标签差异不指向另一个实际方案时，不得仅因标签字面差异否定核心决定；不要自行校正名称或真实身份。若不同方案的实质范围有冲突，或只有一个含糊标签而没有范围依据，不能靠猜测返回 entailed。",
  "只要整项实质断言都被该 Claim 的 Evidence 支持，允许合理概括、同义表达及同一结果的多个组成部分，返回 entailed、issueCodes=[]。仅仅觉得可以拆得更细，不能返回 unsupported、partially_entailed 或 independent_items_conflated。",
  "commitment_existence 判断是否有人明确接受该范围，不要求先确定真人身份；Claim 未断言承担者姓名时，speaker 不明或切换本身不能否定核心认领。确有不同事项或不同接受范围时仍须分别核对，不能凭相邻拼接承诺。",
  "若Claim写了‘主持方/运营侧/技术负责人’等已认领者角色，也必须有该Claim自己的Evidence明确支持；第一人称、speaker标签或发言位置不能支持这种角色归属。若两个独立业务结果以‘同时认领’连写而暗示共享主体，必须有同一承担者的明确证据，否则使用 independent_items_conflated。这与一个交付物内的步骤、测试和条件不同。",
  "action_item 不要求已经有人接受。原文明确保留的未认领会后事项、请求跟进的任务，可以支持未宣称认领的 action_item；只有把点名或请求升级为已接受承诺时才使用 assignment_promoted_to_commitment。纯背景提到一个任务仍不足以成立行动项。",
  "重要条件、次数限制、否定和例外属于实质语义。若 Claim 省略它们导致扩大承诺、把建议写成决定或把未决写成已定，必须拒绝；不要用宽松概括放行这些改变。",
  "每个输入 claimId 恰好返回一次，逐字复制完整 ID，不得用 Candidate ID、序号或另一个 Claim ID 替代。多个 Claim 引用相同 Evidence 也必须分别核验。每条 supportedEvidenceIds 只能选该 Claim 自己的 evidenceIds，entailed/partially_entailed 必须包含实际支持的非空 Evidence。",
  "question_resolution 是服务端提出的待核验假设，不是已知结论。只有 Evidence 中较晚的明确决定完整回答同一问题且所给后续证据没有重新打开问题时才 entailed；相关提议、不同事项的决定、部分回答都不算解决。supportedEvidenceIds 必须同时包含原问题和后续解决证据。",
  "unsupported、contradicted、unverifiable 必须如实返回；不得因看起来合理而升级为 entailed。",
  `若违反语义边界，issueCodes 必须使用这些稳定代码之一：${WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES.join(", ")}。`,
  `强制语义边界：${WORK_MEETING_SEMANTIC_SAFETY_RULES.join("; ")}。`
].join("\n");

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(
    () => {
      timedOut = true;
      controller.abort(new Error("work_analysis_provider_timeout"));
    },
    timeoutMs
  );
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    }
  };
}

export type WorkAnalysisProviderSafeDiagnostics = {
  http?: WorkProviderHttpDiagnostics;
  responseStatus?: string;
  incompleteReason?: string;
  responseTextLength: number;
  parseResult: StructuredJsonDiagnostics["parseResult"];
  validationResult: StructuredJsonDiagnostics["validationResult"];
  responseCompleteDurationMs?: number;
  firstEventMs?: number;
  firstTextDeltaMs?: number;
  reasoningTokens?: number;
  reasoningEffort?: string;
  providerErrorCode?: string;
  parseDurationMs?: number;
  validationDurationMs?: number;
  totalDurationMs?: number;
  validationIssueCount?: number;
  validationIssues?: Array<{ path: string; code: string }>;
  validationIssuesTruncated?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

const SAFE_RESPONSE_STATUSES = new Set([
  "completed", "incomplete", "failed", "cancelled", "queued", "in_progress"
]);
const SAFE_INCOMPLETE_REASONS = new Set(["max_output_tokens", "content_filter"]);
const SAFE_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const SAFE_PROVIDER_ERROR_CODES = new Set(["server_error", "rate_limit_exceeded", "invalid_prompt", "other"]);

function safeNonNegativeInteger(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.round(value));
}

function safeDiagnosticLabel(value: string | undefined, allowed: Set<string>) {
  if (value === undefined) return undefined;
  return allowed.has(value) ? value : "other";
}

function safeValidationPath(value: string) {
  return value.replace(/[^A-Za-z0-9_.\[\]-]/gu, "_").slice(0, 240) || "$";
}

function safeValidationCode(value: string) {
  return /^[a-z_]{1,64}$/u.test(value) ? value : "schema_validation_error";
}

const WORK_EXTRACTOR_REPAIR_PATH = /^(?:\$|items(?:\[\d+\])?(?:\.(?:kind|coreText|evidenceSegmentIds|causality|decisionFinality|value|text|actor|label|role|deadline|dueAt|originalDueExpression|acceptedCommitment|planStages|content|status|actionBasis|relatedCommitmentItem)(?:\[\d+\])?)*)$/u;
const WORK_EXTRACTOR_REPAIR_CODES = new Set([
  "missing_field", "invalid_enum_value", "invalid_type", "too_small", "too_big",
  "invalid_string", "unrecognized_keys", "invalid_union", "invalid_union_discriminator",
  "invalid_literal", "not_multiple_of", "not_finite", "custom", "schema_validation_error"
]);

function safeWorkExtractorRepairPath(value: string) {
  const path = safeValidationPath(value);
  return WORK_EXTRACTOR_REPAIR_PATH.test(path) ? path : "other";
}

function safeWorkExtractorRepairCode(value: string) {
  const code = safeValidationCode(value);
  return WORK_EXTRACTOR_REPAIR_CODES.has(code) ? code : "schema_validation_error";
}

export function safeWorkAnalysisProviderDiagnostics(
  diagnostics: StructuredJsonDiagnostics | undefined
): WorkAnalysisProviderSafeDiagnostics {
  return {
    ...(diagnostics?.responseStatus === undefined ? {} : {
      responseStatus: safeDiagnosticLabel(diagnostics.responseStatus, SAFE_RESPONSE_STATUSES)
    }),
    ...(diagnostics?.incompleteReason === undefined ? {} : {
      incompleteReason: safeDiagnosticLabel(diagnostics.incompleteReason, SAFE_INCOMPLETE_REASONS)
    }),
    responseTextLength: safeNonNegativeInteger(diagnostics?.responseTextLength) ?? 0,
    parseResult: diagnostics?.parseResult ?? "not_started",
    validationResult: diagnostics?.validationResult ?? "not_started",
    ...(safeNonNegativeInteger(diagnostics?.responseCompleteDurationMs) === undefined ? {} : {
      responseCompleteDurationMs: safeNonNegativeInteger(diagnostics?.responseCompleteDurationMs)
    }),
    ...(safeNonNegativeInteger(diagnostics?.firstEventMs) === undefined ? {} : {
      firstEventMs: safeNonNegativeInteger(diagnostics?.firstEventMs)
    }),
    ...(safeNonNegativeInteger(diagnostics?.firstTextDeltaMs) === undefined ? {} : {
      firstTextDeltaMs: safeNonNegativeInteger(diagnostics?.firstTextDeltaMs)
    }),
    ...(safeNonNegativeInteger(diagnostics?.reasoningTokens) === undefined ? {} : {
      reasoningTokens: safeNonNegativeInteger(diagnostics?.reasoningTokens)
    }),
    ...(diagnostics?.reasoningEffort === undefined ? {} : {
      reasoningEffort: safeDiagnosticLabel(diagnostics.reasoningEffort, SAFE_REASONING_EFFORTS)
    }),
    ...(diagnostics?.providerErrorCode === undefined ? {} : {
      providerErrorCode: safeDiagnosticLabel(diagnostics.providerErrorCode, SAFE_PROVIDER_ERROR_CODES)
    }),
    ...(safeNonNegativeInteger(diagnostics?.parseDurationMs) === undefined ? {} : {
      parseDurationMs: safeNonNegativeInteger(diagnostics?.parseDurationMs)
    }),
    ...(safeNonNegativeInteger(diagnostics?.validationDurationMs) === undefined ? {} : {
      validationDurationMs: safeNonNegativeInteger(diagnostics?.validationDurationMs)
    }),
    ...(safeNonNegativeInteger(diagnostics?.totalDurationMs) === undefined ? {} : {
      totalDurationMs: safeNonNegativeInteger(diagnostics?.totalDurationMs)
    }),
    ...(safeNonNegativeInteger(diagnostics?.validationIssueCount) === undefined ? {} : {
      validationIssueCount: safeNonNegativeInteger(diagnostics?.validationIssueCount)
    }),
    ...(diagnostics?.validationIssues ? {
      validationIssues: diagnostics.validationIssues.slice(0, 10).map((issue) => ({
        path: safeValidationPath(issue.path),
        code: safeValidationCode(issue.code)
      }))
    } : {}),
    ...(diagnostics?.validationIssuesTruncated === undefined ? {} : {
      validationIssuesTruncated: diagnostics.validationIssuesTruncated
    }),
    ...(safeNonNegativeInteger(diagnostics?.inputTokens) === undefined ? {} : {
      inputTokens: safeNonNegativeInteger(diagnostics?.inputTokens)
    }),
    ...(safeNonNegativeInteger(diagnostics?.outputTokens) === undefined ? {} : {
      outputTokens: safeNonNegativeInteger(diagnostics?.outputTokens)
    }),
    ...(safeNonNegativeInteger(diagnostics?.totalTokens) === undefined ? {} : {
      totalTokens: safeNonNegativeInteger(diagnostics?.totalTokens)
    })
  };
}

export function buildWorkExtractorSchemaRepairInstruction(
  repair: WorkExtractorSchemaRepair
) {
  const issues = repair.validationIssues.slice(0, 10).map((issue) => ({
    path: safeWorkExtractorRepairPath(issue.path),
    code: safeWorkExtractorRepairCode(issue.code)
  }));
  const fixedRules = new Set<string>();
  for (const issue of issues) {
    if (/^items\[\d+\]\.(?:coreText|evidenceSegmentIds)$/u.test(issue.path)
      && issue.code === "missing_field") {
      fixedRules.add("每个 item 都必须输出 coreText 和非空 evidenceSegmentIds；无法形成合法主结果的 item 必须整个省略。");
    }
    if (/^items\[\d+\]\.decisionFinality(?:\.|$)/u.test(issue.path)) {
      fixedRules.add(
        "decision item 必须输出完整 decisionFinality={value,text,evidenceSegmentIds}，value 只能是 final、tentative、unclear。"
      );
    }
    if (/^items\[\d+\]\.actor(?:\.|$)/u.test(issue.path)) {
      fixedRules.add(
        "actor 只允许 label、role、text、evidenceSegmentIds；role=owner 只用于 commitment/action_item，且不得从被点名或被提到推断 owner。"
      );
    }
    if (/^items\[\d+\]\.acceptedCommitment(?:\.|$)/u.test(issue.path)
      || /^items\[\d+\]\.actionBasis$/u.test(issue.path)) {
      fixedRules.add("actionBasis=explicit_commitment 必须且只能同时输出 acceptedCommitment={text,evidenceSegmentIds}；其他 actionBasis 禁止输出 acceptedCommitment。");
    }
    if (/^items\[\d+\]\.planStages$/u.test(issue.path) && issue.code === "custom") {
      fixedRules.add(
        "planStages 必须包含至少两个不同的 status/content 语义阶段；同一 canonical Segment 若同时明确表达旧方案与新方案，可以被多个阶段共同引用。"
      );
    }
    if (issue.code === "unrecognized_keys") {
      fixedRules.add("删除 schema 未声明的字段，不得保留解释、辅助字段或旧版字段。");
    }
  }
  return [
    "SCHEMA_REPAIR：上一轮响应已被完整丢弃；不要输出补丁，必须为同一 Transcript 窗口重新生成完整 {items:[...]} JSON。",
    ...(issues.length > 0
      ? [
          "必须修正以下仅含脱敏字段路径与稳定错误类别的问题：",
          ...issues.map((issue) => `path=${issue.path} code=${issue.code}`)
        ]
      : ["上一轮未通过机械 schema 校验；重新逐项核对所有必填字段、枚举、数组和 kind/命名字段合同。"]),
    ...(repair.validationIssuesTruncated === true
      ? ["还有其他未展示的问题；必须重新核对整个响应。"]
      : []),
    ...fixedRules,
    "不得猜测或补造事实；修复后的完整响应仍会重新执行全部 schema、Evidence allowlist 与 closure 校验。"
  ].join("\n");
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function errorName(error: unknown) {
  if (error instanceof Error) return error.name;
  if (!error || typeof error !== "object" || !("name" in error)) return "UnknownError";
  return typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "UnknownError";
}

export function isWorkAnalysisProviderTransientError(error: unknown) {
  return error instanceof WorkMeetingAnalysisProviderError && [
    "work_analysis_provider_rate_limited",
    "work_analysis_provider_transient_unavailable"
  ].includes(error.code);
}

export function classifyWorkAnalysisProviderError(input: {
  stage: "extractor" | "verifier" | "deduplicator";
  error: unknown;
  timedOut?: boolean;
  diagnostics?: StructuredJsonDiagnostics;
}) {
  if (input.error instanceof WorkMeetingAnalysisProviderError) return input.error;
  const outputInvalidCode = input.stage === "extractor"
    ? "work_extractor_output_invalid" as const
    : input.stage === "deduplicator"
      ? "work_deduplicator_output_invalid" as const
      : "work_verifier_output_invalid" as const;
  const wrap = (
    code: ConstructorParameters<typeof WorkMeetingAnalysisProviderError>[0],
    message: string
  ) => new WorkMeetingAnalysisProviderError(
    code,
    message,
    { cause: input.error },
    safeWorkAnalysisProviderDiagnostics(input.diagnostics)
  );
  const status = errorStatus(input.error);
  const name = errorName(input.error);

  if (input.timedOut || input.error instanceof APIConnectionTimeoutError || status === 408 || [
    "AbortError", "APIConnectionTimeoutError", "APIUserAbortError", "TimeoutError"
  ].includes(name)) {
    return wrap("work_analysis_provider_timeout", "Work Meeting analysis provider timed out");
  }
  if (input.error instanceof StructuredJsonResponseError) {
    // A completed HTTP stream can still explicitly report a transient upstream
    // failure. Route only these exact codes to the existing bounded recovery;
    // missing completion and unknown failures remain non-retryable.
    if (input.error.code === "incomplete_response" && input.diagnostics?.providerErrorCode === "server_error") {
      return wrap("work_analysis_provider_transient_unavailable", "Work Meeting analysis provider is temporarily unavailable");
    }
    if (input.error.code === "incomplete_response" && input.diagnostics?.providerErrorCode === "rate_limit_exceeded") {
      return wrap("work_analysis_provider_rate_limited", "Work Meeting analysis provider rate limit was reached");
    }
    if (input.error.code === "incomplete_json" || input.error.code === "incomplete_response") {
      return wrap("work_analysis_provider_incomplete", "Work Meeting analysis provider returned an incomplete response");
    }
    return wrap("work_analysis_provider_invalid_json", "Work Meeting analysis provider returned invalid JSON");
  }
  if (input.diagnostics?.incompleteReason || input.diagnostics?.responseStatus === "incomplete") {
    return wrap("work_analysis_provider_incomplete", "Work Meeting analysis provider returned an incomplete response");
  }
  if (input.error instanceof ZodError || input.diagnostics?.validationResult === "failed") {
    return wrap(outputInvalidCode, "Work Meeting analysis provider returned an invalid schema");
  }
  if (input.diagnostics?.parseResult === "failed" || input.error instanceof SyntaxError) {
    return wrap("work_analysis_provider_invalid_json", "Work Meeting analysis provider returned invalid JSON");
  }
  if (input.error instanceof RateLimitError || status === 429) {
    return wrap("work_analysis_provider_rate_limited", "Work Meeting analysis provider rate limit was reached");
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return wrap("work_analysis_provider_request_rejected", "Work Meeting analysis provider rejected the request");
  }
  if (
    input.error instanceof InternalServerError
    || (status !== undefined && status >= 500)
    || input.error instanceof APIConnectionError
    || name === "APIConnectionError"
  ) {
    return wrap(
      "work_analysis_provider_transient_unavailable",
      "Work Meeting analysis provider is temporarily unavailable"
    );
  }
  return wrap("work_analysis_provider_unavailable", "Work Meeting analysis provider is unavailable");
}

type WorkStructuredJsonParser = (
  input: Parameters<typeof parseStructuredJsonResponse>[0]
) => Promise<unknown>;

export function createWorkStructuredJsonRequest(dependencies: {
  getRuntimeConfig?: typeof getOpenAIClientRuntimeConfig;
  createClient?: typeof createOpenAIClient;
  createDeepSeekClient?: typeof createWorkReviewDeepSeekClient;
  createTokenHubClient?: typeof createWorkReviewTokenHubClient;
  parseResponse?: WorkStructuredJsonParser;
  now?: () => number;
  captureFailure?: WorkAnalysisFailureSink;
  log?: (event: "request_started" | "request_finished", fields: Record<string, unknown>) => void;
} = {}): WorkStructuredJsonRequest {
  const getRuntimeConfig = dependencies.getRuntimeConfig ?? getOpenAIClientRuntimeConfig;
  const createClient = dependencies.createClient ?? createOpenAIClient;
  const createDeepSeekClient = dependencies.createDeepSeekClient ?? createWorkReviewDeepSeekClient;
  const createTokenHubClient = dependencies.createTokenHubClient ?? createWorkReviewTokenHubClient;
  const parseResponse = dependencies.parseResponse ?? parseStructuredJsonResponse;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? ((event, fields) => {
    console.info(`[work-review-provider] ${event} ${JSON.stringify(fields)}`);
  });

  return async (input) => {
    if (input.profile.provider === "fixture") {
      throw new WorkMeetingAnalysisProviderError(
        "work_analysis_fixture_provider_forbidden",
        "Production structured adapters cannot execute fixture analysis"
      );
    }
    assertWorkReviewAnalysisProfileSupported(input.profile);
    let captureFailure = dependencies.captureFailure;
    let captureSetupFailed = false;
    if (!captureFailure) {
      try { captureFailure = await createWorkAnalysisEvaluationFailureSink(); }
      catch { captureSetupFailed = true; }
    }
    let responseText: StructuredJsonResponseText | null = null;
    // Dedicated credentials are chosen before consulting saved OpenAI routing.
    // This is an explicit profile, never a fallback after a failed request.
    const client = input.profile.provider === "deepseek-structured-json"
      ? createDeepSeekClient({ profile: input.profile })
      : input.profile.provider === "tokenhub-structured-json"
        ? createTokenHubClient({ profile: input.profile })
      : createClient({
        ...await getRuntimeConfig(),
        timeoutMs: input.profile.timeoutMs,
        maxRetries: 0
      });
    const request = createTimeoutSignal(input.signal, input.profile.timeoutMs);
    const startedAt = now();
    const http = observeWorkProviderHttp({ client, startedAt, now });
    const requestTraceId = http.snapshot().requestTraceId;
    let diagnostics: StructuredJsonDiagnostics | undefined;
    let inputCharacters = 0;
    try {
      inputCharacters = JSON.stringify(input.requestInput).length;
    } catch {
      inputCharacters = 0;
    }
    log("request_started", {
      requestTraceId,
      stage: input.stage,
      profileId: input.profile.profileId,
      schemaName: input.name,
      inputCharacters,
      maxOutputTokens: input.profile.maxOutputTokens,
      timeoutMs: input.profile.timeoutMs
    });
    try {
      const reasoning = input.profile.reasoningEffort === "provider_default"
        ? {}
        : {
          // The installed SDK predates the adopted DeepSeek/TokenHub `none`.
          // The provider-specific validator above restricts this wire extension.
          reasoning: { effort: input.profile.reasoningEffort } as NonNullable<
            Parameters<typeof parseStructuredJsonResponse>[0]["reasoning"]
          >
        };
      const result = await parseResponse({
        client: http.client,
        model: input.profile.model,
        name: input.name,
        schema: input.schema,
        mode: "json",
        // Keep the same generation contract; require a completed Responses
        // event before the existing JSON, Item and Evidence validation.
        stream: true,
        requestInput: input.requestInput,
        jsonInstruction: input.jsonInstruction,
        maxOutputTokens: input.profile.maxOutputTokens,
        ...reasoning,
        requestOptions: {
          signal: request.signal,
          timeout: input.profile.timeoutMs,
          maxRetries: 0
        },
        ...(input.normalize ? { normalize: input.normalize } : {}),
        onDiagnostics(value) {
          diagnostics = value;
        },
        ...(captureFailure ? { onResponseText(value: StructuredJsonResponseText) { responseText = value; } } : {})
      });
      log("request_finished", {
        requestTraceId,
        stage: input.stage,
        profileId: input.profile.profileId,
        schemaName: input.name,
        state: "completed",
        elapsedMs: Math.max(0, now() - startedAt),
        diagnostics: { ...safeWorkAnalysisProviderDiagnostics(diagnostics), http: http.snapshot() }
      });
      return result;
    } catch (error) {
      const cancelled = input.signal?.aborted && !request.timedOut();
      const parentTimeout = cancelled && (errorName(input.signal?.reason) === "TimeoutError"
        || (input.signal?.reason as { code?: unknown } | undefined)?.code === "work_analysis_deadline_exceeded");
      const classified = cancelled && !parentTimeout
        ? new WorkMeetingAnalysisProviderError("work_analysis_provider_cancelled", "Work Meeting analysis request was cancelled")
        : classifyWorkAnalysisProviderError({
        stage: input.stage,
        error,
        timedOut: request.timedOut() || parentTimeout,
        diagnostics
      });
      if (classified.safeDiagnostics) classified.safeDiagnostics.http = http.snapshot(true);
      let failureCaptureState = captureSetupFailed ? "setup_failed" : "disabled";
      if (captureFailure) {
        try {
          await captureFailure({
            requestTraceId, stage: input.stage, model: input.profile.model, schemaName: input.name,
            errorCode: classified.code, elapsedMs: Math.max(0, now() - startedAt),
            diagnostics: { ...safeWorkAnalysisProviderDiagnostics(diagnostics), http: http.snapshot(true) },
            requestInput: input.requestInput, jsonInstruction: input.jsonInstruction, response: responseText
          });
          failureCaptureState = "saved";
        } catch { failureCaptureState = "write_failed"; }
      }
      log("request_finished", {
        requestTraceId,
        stage: input.stage,
        profileId: input.profile.profileId,
        schemaName: input.name,
        state: cancelled ? "cancelled" : "failed",
        elapsedMs: Math.max(0, now() - startedAt),
        errorCode: classified.code,
        failureCaptureState,
        diagnostics: { ...safeWorkAnalysisProviderDiagnostics(diagnostics), http: http.snapshot(true) }
      });
      // Preserve cancellation/lease semantics after collecting safe diagnostics.
      throw cancelled ? error : classified;
    } finally {
      request.cleanup();
    }
  };
}

const productionStructuredJsonRequest = createWorkStructuredJsonRequest();

function canonicalSegments(segments: unknown[]) {
  return [...WorkCanonicalSegmentsSchema.parse(segments)].sort((left, right) =>
    left.startSeconds - right.startSeconds
    || left.endSeconds - right.endSeconds
    || left.id.localeCompare(right.id)
  );
}

function transcriptWindowPrompt(window: WorkMeetingTranscriptWindow) {
  return window.segments.map((segment) => {
    const speaker = segment.speaker?.trim() || "unknown";
    return `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s speaker=${speaker}: ${segment.text}`;
  }).join("\n");
}

export function materializeWorkEvidence(input: {
  publicationId: string;
  segments: unknown[];
  evidenceIds: string[];
  timestampQualityBySegmentId?: Readonly<Record<string, unknown>>;
}): WorkMaterializedEvidence[] {
  const segmentById = new Map(canonicalSegments(input.segments).map((segment) => [segment.id, segment]));
  const uniqueIds = [...new Set(input.evidenceIds)];
  if (uniqueIds.length !== input.evidenceIds.length) {
    throw new WorkMeetingAnalysisProviderError(
      "work_evidence_closure_invalid",
      "Evidence allowlist contains duplicate segment IDs"
    );
  }
  return uniqueIds.map((segmentId) => {
    const segment = segmentById.get(segmentId);
    if (!segment) {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_not_allowed",
        "Evidence ID is not present in the canonical publication"
      );
    }
    return {
      publicationId: input.publicationId,
      segmentId,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      rawSpeakerLabel: segment.speaker?.trim() || null,
      timestampQuality: WorkEvidenceTimestampQualitySchema.parse(
        input.timestampQualityBySegmentId?.[segmentId] ?? "unknown"
      ),
      // Evidence text always comes from the canonical Segment, never the model.
      text: segment.text
    };
  });
}

function validateWorkExtractorCandidateLocal(input: {
  candidate: unknown;
  allowedEvidence: ReadonlySet<string>;
}): WorkExtractorCandidateDraft {
  const parsed = WorkExtractorResponseSchema.safeParse({ items: [input.candidate] });
  if (!parsed.success) {
    throw new WorkMeetingAnalysisProviderError(
      "work_extractor_output_invalid",
      "Work Meeting Extractor returned an invalid Candidate schema",
      { cause: parsed.error }
    );
  }
  const candidate = parsed.data.items[0]!;
  const candidateEvidence = new Set(candidate.evidenceIds);
  if (candidateEvidence.size !== candidate.evidenceIds.length
    || candidate.evidenceIds.some((id) => !input.allowedEvidence.has(id))) {
    throw new WorkMeetingAnalysisProviderError(
      "work_evidence_not_allowed",
      "Extractor Candidate referenced Evidence outside the canonical window"
    );
  }
  const localClaimKeys = new Set<string>();
  for (const claim of candidate.claims) {
    if (localClaimKeys.has(claim.clientClaimKey)) {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_closure_invalid",
        "Extractor Claim keys must be unique within a Candidate"
      );
    }
    localClaimKeys.add(claim.clientClaimKey);
    if (new Set(claim.evidenceIds).size !== claim.evidenceIds.length
      || claim.evidenceIds.some((id) => !candidateEvidence.has(id))) {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_closure_invalid",
        "Atomic Claim Evidence must be a subset of Candidate Evidence"
      );
    }
    const semanticValueMatchesStructuredData = claim.semanticValue === undefined
      || claim.semanticValue === null
      || (claim.semanticValue.kind === "decision_finality"
        && claim.semanticValue.value === candidate.structuredData.decisionFinality)
      || (claim.semanticValue.kind === "speaker_attribution"
        && claim.semanticValue.value === candidate.structuredData.rawActorLabel)
      || (claim.semanticValue.kind === "commitment_owner"
        && claim.semanticValue.value === candidate.structuredData.candidateOwner)
      || (claim.semanticValue.kind === "deadline"
        && claim.semanticValue.dueAt === candidate.structuredData.dueAt
        && claim.semanticValue.originalDueExpression
          === candidate.structuredData.originalDueExpression);
    if (!semanticValueMatchesStructuredData) {
      throw new WorkMeetingAnalysisProviderError(
        "work_extractor_output_invalid",
        "Extractor semanticValue must exactly match Candidate structuredData"
      );
    }
  }
  for (const stage of candidate.structuredData.planStages) {
    if (new Set(stage.evidenceIds).size !== stage.evidenceIds.length
      || stage.evidenceIds.some((id) => !candidateEvidence.has(id))) {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_closure_invalid",
        "Plan Change stage Evidence must be a subset of Candidate Evidence"
      );
    }
  }
  return candidate;
}

export function validateWorkExtractorOutput(input: {
  response: unknown;
  allowedSegments: unknown[];
}): WorkExtractorResponse {
  const parsed = WorkExtractorResponseSchema.safeParse(input.response);
  if (!parsed.success) {
    throw new WorkMeetingAnalysisProviderError(
      "work_extractor_output_invalid",
      "Work Meeting Extractor returned an invalid schema",
      { cause: parsed.error }
    );
  }
  const allowedEvidence = new Set(canonicalSegments(input.allowedSegments).map((segment) => segment.id));
  const candidateKeys = new Set<string>();
  const claimKeys = new Set<string>();
  const validatedItems = parsed.data.items.map((candidate) => {
    if (candidateKeys.has(candidate.clientCandidateKey)) {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_closure_invalid",
        "Extractor Candidate keys must be unique"
      );
    }
    candidateKeys.add(candidate.clientCandidateKey);
    const validated = validateWorkExtractorCandidateLocal({ candidate, allowedEvidence });
    for (const claim of validated.claims) {
      if (claimKeys.has(claim.clientClaimKey)) {
        throw new WorkMeetingAnalysisProviderError(
          "work_evidence_closure_invalid",
          "Extractor Claim keys must be unique"
        );
      }
      claimKeys.add(claim.clientClaimKey);
    }
    return validated;
  });
  for (const candidate of validatedItems) {
    const relatedId = candidate.structuredData.relatedCommitmentCandidateId;
    if (relatedId !== null && !validatedItems.some((item) =>
      item.clientCandidateKey === relatedId && item.kind === "commitment"
    )) {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_closure_invalid",
        "Action Item related commitment must refer to a generated Commitment Candidate"
      );
    }
  }
  return { items: validatedItems };
}

function safeWorkExtractorItemIssues(
  error: ZodError,
  itemIndex: number
): Pick<WorkExtractorItemDiscard, "issues" | "issuesTruncated"> {
  return {
    issues: error.issues.slice(0, 10).map((issue) => ({
      path: safeValidationPath([
        `items[${itemIndex}]`,
        ...issue.path.map((part) => typeof part === "number" ? `[${part}]` : String(part))
      ].join(".").replace(/\.\[/gu, "[")),
      code: safeValidationCode(issue.code)
    })),
    issuesTruncated: error.issues.length > 10
  };
}

function discardReasonFromProviderError(
  error: WorkMeetingAnalysisProviderError
): WorkExtractorItemDiscardReason {
  if (error.code === "work_evidence_not_allowed") return "evidence_not_allowed";
  if (error.code === "work_evidence_closure_invalid") return "evidence_closure_invalid";
  return "schema_invalid";
}

/**
 * Keeps the parsed JSON envelope strict while validating and canonicalizing
 * each Candidate independently. Invalid items never escape this boundary and
 * never force valid siblings to be regenerated.
 */
export function validateWorkExtractorWireItems(input: {
  response: unknown;
  allowedSegments: unknown[];
  onItemDiscarded?: (discard: WorkExtractorItemDiscard) => void;
}): WorkExtractorResponse {
  const envelope = WorkExtractorWireEnvelopeSchema.safeParse(
    normalizeWorkExtractorWireResponse(input.response)
  );
  if (!envelope.success) {
    throw new WorkMeetingAnalysisProviderError(
      "work_extractor_output_invalid",
      "Work Meeting Extractor returned an invalid response envelope",
      { cause: envelope.error }
    );
  }
  const allowedEvidence = new Set(canonicalSegments(input.allowedSegments).map((segment) => segment.id));
  const discarded = new Set<number>();
  const reportDiscard = (
    sourceIndex: number,
    reason: WorkExtractorItemDiscardReason,
    issues: WorkExtractorItemDiscard["issues"] = [],
    issuesTruncated = false
  ) => {
    if (discarded.has(sourceIndex)) return;
    discarded.add(sourceIndex);
    input.onItemDiscarded?.({
      itemIndex: sourceIndex + 1,
      reason,
      issues,
      issuesTruncated
    });
  };

  const normalizedRoot = normalizeWorkExtractorWireResponse(envelope.data) as { items: unknown[] };
  const schemaValidItems: IndexedWorkExtractorWireItem[] = [];
  const exactSignatures = new Set<string>();
  normalizedRoot.items.forEach((rawItem, sourceIndex) => {
    const parsed = WorkExtractorCandidateWireSchema.safeParse(rawItem);
    if (!parsed.success) {
      const safeIssues = safeWorkExtractorItemIssues(parsed.error, sourceIndex);
      reportDiscard(
        sourceIndex,
        "schema_invalid",
        safeIssues.issues,
        safeIssues.issuesTruncated
      );
      return;
    }
    const signature = JSON.stringify(parsed.data);
    if (exactSignatures.has(signature)) {
      reportDiscard(sourceIndex, "duplicate_item", [{
        path: `items[${sourceIndex}]`,
        code: "duplicate_item"
      }]);
      return;
    }
    exactSignatures.add(signature);
    schemaValidItems.push({ item: parsed.data, sourceIndex });
  });

  const schemaValidByIndex = new Map(schemaValidItems.map((entry) => [entry.sourceIndex, entry]));
  const relationshipValidItems = schemaValidItems.filter(({ item, sourceIndex }) => {
    if (item.kind !== "action_item" || item.relatedCommitmentItem === undefined) return true;
    const target = schemaValidByIndex.get(item.relatedCommitmentItem - 1);
    if (target?.item.kind === "commitment") return true;
    reportDiscard(sourceIndex, "relationship_invalid", [{
      path: `items[${sourceIndex}].relatedCommitmentItem`,
      code: "invalid_relationship"
    }]);
    return false;
  });

  const canonicalItems = canonicalizeParsedWorkExtractorItems(relationshipValidItems).items;
  const localValidItems = canonicalItems.filter((candidate, index) => {
    const sourceIndex = relationshipValidItems[index]!.sourceIndex;
    try {
      validateWorkExtractorCandidateLocal({ candidate, allowedEvidence });
      return true;
    } catch (error) {
      if (!(error instanceof WorkMeetingAnalysisProviderError)) throw error;
      const cause = error.cause;
      const safeIssues = cause instanceof ZodError
        ? safeWorkExtractorItemIssues(cause, sourceIndex)
        : null;
      reportDiscard(
        sourceIndex,
        discardReasonFromProviderError(error),
        safeIssues?.issues ?? [{ path: `items[${sourceIndex}]`, code: error.code }],
        safeIssues?.issuesTruncated ?? false
      );
      return false;
    }
  });

  const localValidById = new Map(localValidItems.map((candidate) => [
    candidate.clientCandidateKey,
    candidate
  ]));
  return {
    items: localValidItems.filter((candidate) => {
      const relatedId = candidate.structuredData.relatedCommitmentCandidateId;
      if (relatedId === null || localValidById.get(relatedId)?.kind === "commitment") return true;
      const match = /^wire_candidate_(\d+)$/u.exec(candidate.clientCandidateKey);
      const sourceIndex = match ? Number(match[1]) - 1 : 0;
      reportDiscard(sourceIndex, "relationship_invalid", [{
        path: `items[${sourceIndex}].relatedCommitmentItem`,
        code: "invalid_relationship"
      }]);
      return false;
    })
  };
}

export function materializeWorkExtractorCandidate(input: {
  publicationId: string;
  segments: unknown[];
  candidate: WorkExtractorCandidateDraft;
  timestampQualityBySegmentId?: Readonly<Record<string, unknown>>;
}): MaterializedWorkExtractorCandidate {
  const evidenceRefs = materializeWorkEvidence({
    publicationId: input.publicationId,
    segments: input.segments,
    evidenceIds: input.candidate.evidenceIds,
    timestampQualityBySegmentId: input.timestampQualityBySegmentId
  });
  const structuredData = WorkMeetingCandidateStructuredDataSchema.parse({
    ...input.candidate.structuredData,
    planStages: input.candidate.structuredData.planStages.map((stage) => ({
      id: stage.clientStageKey,
      content: stage.content,
      status: stage.status,
      rawSpeakerLabel: stage.rawSpeakerLabel,
      evidenceRefs: materializeWorkEvidence({
        publicationId: input.publicationId,
        segments: input.segments,
        evidenceIds: stage.evidenceIds,
        timestampQualityBySegmentId: input.timestampQualityBySegmentId
      }).map(({ text: _text, ...reference }) => reference)
    }))
  });
  const { evidenceIds: _evidenceIds, ...candidateWithoutEvidenceIds } = input.candidate;
  return {
    ...candidateWithoutEvidenceIds,
    structuredData,
    evidenceRefs
  };
}

export function validateWorkVerifierOutput(input: {
  response: unknown;
  claims: WorkAtomicClaim[];
  allowedSegments: unknown[];
}): WorkVerifierResponse {
  const parsed = WorkVerifierResponseSchema.safeParse(input.response);
  if (!parsed.success) {
    throw new WorkMeetingAnalysisProviderError(
      "work_verifier_output_invalid",
      "Work Meeting Verifier returned an invalid schema",
      { cause: parsed.error }
    );
  }
  return validateWorkVerifierSemanticClosure({
    items: parsed.data.items,
    claims: input.claims,
    allowedSegments: input.allowedSegments
  });
}

function validateWorkVerifierSemanticClosure(input: {
  items: WorkVerifierClaimDraft[];
  claims: WorkAtomicClaim[];
  allowedSegments: unknown[];
  requireComplete?: boolean;
}): WorkVerifierResponse {
  const claimById = new Map(input.claims.map((claim) => [claim.id, claim]));
  if (claimById.size !== input.claims.length) {
    throw new WorkMeetingAnalysisProviderError(
      "work_evidence_closure_invalid",
      "Verifier input Claim IDs must be unique"
    );
  }
  const allowedEvidence = new Set(canonicalSegments(input.allowedSegments).map((segment) => segment.id));
  const responseIds = input.items.map((item) => item.claimId);
  if (new Set(responseIds).size !== responseIds.length
    || responseIds.some((id) => !claimById.has(id))
    || (input.requireComplete !== false && responseIds.length !== claimById.size)) {
    throw new WorkMeetingAnalysisProviderError(
      "work_evidence_closure_invalid",
      "Verifier response must contain exactly one evaluation for every input Claim"
    );
  }
  const allowedIssueCodes = new Set<string>([...WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES, WORK_MEETING_CANONICAL_WORDING_UNCLEAR]);
  for (const evaluation of input.items) {
    const claim = claimById.get(evaluation.claimId)!;
    const claimEvidence = new Set(claim.evidenceIds);
    if (evaluation.issueCodes.some((code) => !allowedIssueCodes.has(code))) {
      throw new WorkMeetingAnalysisProviderError(
        "work_verifier_output_invalid",
        "Verifier issue codes must use the stable semantic safety allowlist"
      );
    }
    if (new Set(evaluation.supportedEvidenceIds).size !== evaluation.supportedEvidenceIds.length
      || evaluation.supportedEvidenceIds.some((id) =>
        !allowedEvidence.has(id) || !claimEvidence.has(id)
      )) {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_not_allowed",
        "Verifier supported Evidence must be a subset of the Claim allowlist"
      );
    }
    if ((evaluation.supportVerdict === "entailed"
      || evaluation.supportVerdict === "partially_entailed")
      && evaluation.supportedEvidenceIds.length === 0) {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_closure_invalid",
        "Supported verifier verdicts require canonical Evidence"
      );
    }
  }
  return { items: input.items };
}

/**
 * Accepts a bounded, parseable Verifier envelope and validates each expected
 * Claim independently. A malformed or omitted evaluation becomes a local
 * missing result. A rejected verdict carrying invalid Evidence is also omitted:
 * it cannot authorize publication, and its invalid references must not persist.
 * Unknown/duplicate Claim IDs and Evidence violations in affirmative verdicts
 * remain batch-fatal.
 */
export function validatePartialWorkVerifierOutput(input: {
  response: unknown;
  claims: WorkAtomicClaim[];
  allowedSegments: unknown[];
}): WorkVerifierResponse {
  const envelope = WorkVerifierWireEnvelopeSchema.safeParse(input.response);
  if (!envelope.success) {
    throw new WorkMeetingAnalysisProviderError(
      "work_verifier_output_invalid",
      "Work Meeting Verifier returned an invalid envelope",
      { cause: envelope.error }
    );
  }
  const claimIds = new Set(input.claims.map((claim) => claim.id));
  if (claimIds.size !== input.claims.length) {
    throw new WorkMeetingAnalysisProviderError(
      "work_evidence_closure_invalid",
      "Verifier input Claim IDs must be unique"
    );
  }
  const rawClaimIds = envelope.data.items.flatMap((item) => {
    const record = recordValue(item);
    return typeof record?.claimId === "string" ? [record.claimId] : [];
  });
  if (new Set(rawClaimIds).size !== rawClaimIds.length
    || rawClaimIds.some((claimId) => !claimIds.has(claimId))) {
    throw new WorkMeetingAnalysisProviderError(
      "work_evidence_closure_invalid",
      "Verifier response contains an unknown or duplicate Claim ID"
    );
  }
  const claimById = new Map(input.claims.map((claim) => [claim.id, claim]));
  const allowedEvidence = new Set(canonicalSegments(input.allowedSegments).map((segment) => segment.id));
  let discardedRejections = 0;
  const items = envelope.data.items.flatMap((item) => {
    const parsed = WorkVerifierClaimDraftSchema.safeParse(item);
    if (!parsed.success) return [];
    const evaluation = parsed.data;
    if (["unsupported", "contradicted", "unverifiable"].includes(evaluation.supportVerdict)) {
      const claim = claimById.get(evaluation.claimId)!;
      const invalidEvidence = new Set(evaluation.supportedEvidenceIds).size !== evaluation.supportedEvidenceIds.length
        || evaluation.supportedEvidenceIds.some((id) => !allowedEvidence.has(id) || !claim.evidenceIds.includes(id));
      if (invalidEvidence) {
        discardedRejections += 1;
        return [];
      }
    }
    return [evaluation];
  });
  if (discardedRejections > 0) console.warn(
    `[work-review-provider] verifier_evaluations_discarded count=${discardedRejections} reason=rejected_verdict_invalid_evidence`
  );
  return validateWorkVerifierSemanticClosure({
    items,
    claims: input.claims,
    allowedSegments: input.allowedSegments,
    requireComplete: false
  });
}

/**
 * Validates results assembled from multiple already-bounded Provider calls.
 * The item limit is derived from the exact expected Claim set rather than the
 * single-response transport cap, while every item still uses the same strict
 * canonical schema and semantic Evidence checks.
 */
export function validateAggregatedWorkVerifierOutput(input: {
  response: unknown;
  claims: WorkAtomicClaim[];
  allowedSegments: unknown[];
  requireComplete?: boolean;
}): WorkVerifierResponse {
  const aggregateSchema = z.object({
    items: z.array(WorkVerifierClaimDraftSchema).max(input.claims.length)
  }).strict();
  const parsed = aggregateSchema.safeParse(input.response);
  if (!parsed.success) {
    throw new WorkMeetingAnalysisProviderError(
      "work_verifier_output_invalid",
      "Aggregated Work Meeting Verifier results returned an invalid schema",
      { cause: parsed.error }
    );
  }
  const validated = validateWorkVerifierSemanticClosure({
    items: parsed.data.items,
    claims: input.claims,
    allowedSegments: input.allowedSegments,
    requireComplete: input.requireComplete
  });
  const evaluationByClaimId = new Map(validated.items.map((item) => [item.claimId, item]));
  return {
    items: input.claims.flatMap((claim) => {
      const evaluation = evaluationByClaimId.get(claim.id);
      return evaluation ? [evaluation] : [];
    })
  };
}

export function buildWorkMeetingVerifierProviderPayload(input: WorkMeetingVerifierInput) {
  const canonicalSegments = WorkCanonicalSegmentsSchema.parse(input.segments);
  const canonicalOrder = new Map(canonicalSegments.map((segment, index) => [segment.id, index]));
  const evidenceIds = [...new Set([...input.claims.flatMap((claim) => claim.evidenceIds),
    ...(input.duplicateCoverage ?? []).flatMap(r => [r.original, ...r.coveredBy].flatMap(c => c.evidenceIds))])]
    .sort((left, right) =>
      (canonicalOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (canonicalOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right)
    );
  const compactCoverage = Boolean(input.duplicateCoverage?.length);
  const evidenceFields = ["startSeconds", "endSeconds", "rawSpeakerLabel", "timestampQuality", "text"] as const;
  const evidenceById = Object.fromEntries(materializeWorkEvidence({
    publicationId: input.publicationId,
    segments: canonicalSegments,
    evidenceIds,
    timestampQualityBySegmentId: input.timestampQualityBySegmentId
  }).map(({ publicationId: _publicationId, segmentId, ...evidence }) =>
    [segmentId, compactCoverage ? evidenceFields.map(field => evidence[field]) : evidence]));
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
  const coverageSubject = (s: WorkDuplicateCoverageRequest["original"]) => {
    const bodyClaim = input.claims.find(c => c.candidateId === s.id && c.text === s.body);
    return {
    kind: s.kind, ...(bodyClaim ? { textFromClaimId: bodyClaim.id } : { text: s.body }), evidenceIds: s.evidenceIds,
    ...(s.body.includes(s.title) ? {} : { title: s.title }),
    // A single core identical to the body needs no second copy. Distinct
    // attributes retain their own text/Evidence binding, including dates.
    ...(s.facts.length === 1 && s.facts[0].text === s.body
      && sameIds(s.facts[0].evidenceIds, s.evidenceIds) ? {} : { facts: s.facts.map(f => {
        const claim = input.claims.find(c => c.candidateId === s.id && c.claimType === f.type
          && c.text === f.text && sameIds(c.evidenceIds, f.evidenceIds));
        return claim ? { claimId: claim.id } : f;
      }) }),
    ...(s.stages.length ? { stages: s.stages } : {}),
    ...Object.fromEntries((["candidateOwner", "dueAt", "originalDueExpression", "decisionFinality", "actionBasis"] as const)
      .flatMap(key => s[key] === null ? [] : [[key, s[key]]]))
    };
  };
  const subjects = new Map<string, WorkDuplicateCoverageRequest["original"]>();
  for (const relation of input.duplicateCoverage ?? []) for (const subject of [relation.original, ...relation.coveredBy]) {
    const existing = subjects.get(subject.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(subject)) throw new Error("work_duplicate_coverage_input_invalid");
    subjects.set(subject.id, subject);
  }
  const subjectRefs = new Map([...subjects.keys()].map((id, i) => [id, `C${i + 1}`]));
  return {
    ...(compactCoverage ? { evidenceFields } : {}),
    evidenceById,
    items: input.claims.map((claim) => ({
      claimId: claim.id,
      claimType: claim.claimType,
      semanticRiskFlags: claim.semanticRiskFlags ?? [],
      semanticValue: claim.semanticValue ?? null,
      text: claim.text,
      evidenceIds: claim.evidenceIds
    })),
    ...(compactCoverage ? {
      coverageSubjects: Object.fromEntries([...subjects].map(([id, s]) => [subjectRefs.get(id)!, coverageSubject(s)])),
      duplicateCoverage: input.duplicateCoverage!.map(r => ({
        relationId: r.relationId, original: subjectRefs.get(r.original.id)!, coveredBy: r.coveredBy.map(s => subjectRefs.get(s.id)!)
      }))
    } : {})
  };
}

export function validateWorkMeetingVerifierResult(input: {
  response: unknown; claims: WorkAtomicClaim[]; allowedSegments: unknown[];
  duplicateCoverage?: WorkDuplicateCoverageRequest[];
}): WorkMeetingVerifierResult {
  const result = validatePartialWorkVerifierOutput(input);
  return { items: result.items,
    coverage: validateWorkDuplicateCoverageOutput(recordValue(input.response)?.coverage, input.duplicateCoverage ?? []) };
}

export function createStructuredWorkMeetingExtractor(input: {
  profile: WorkReviewAnalysisProviderProfile;
  requestStructuredJson?: WorkStructuredJsonRequest;
}): WorkMeetingExtractor {
  if (input.profile.provider === "fixture") {
    throw new WorkReviewRuntimeConfigError(
      "work_review_analysis_fixture_not_explicitly_enabled",
      "Use an injected deterministic fixture provider instead of the production adapter"
    );
  }
  const requestStructuredJson = input.requestStructuredJson ?? productionStructuredJsonRequest;
  return {
    profile: input.profile,
    async extract(request) {
      const jsonInstruction = request.schemaRepair
        ? `${WORK_MEETING_EXTRACTOR_JSON_INSTRUCTION}\n${buildWorkExtractorSchemaRepairInstruction(request.schemaRepair)}`
        : WORK_MEETING_EXTRACTOR_JSON_INSTRUCTION;
      const response = await requestStructuredJson({
        stage: "extractor",
        profile: input.profile,
        name: input.profile.schemaVersion,
        schema: WorkExtractorWireEnvelopeSchema,
        requestInput: [
          { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `window=${request.window.index + 1}/${request.window.count}`,
              transcriptWindowPrompt(request.window)
            ].join("\n")
          }
        ],
        jsonInstruction,
        normalize: normalizeWorkExtractorWireResponse,
        signal: request.signal
      });
      return validateWorkExtractorWireItems({
        response,
        allowedSegments: request.window.segments,
        onItemDiscarded: request.onItemDiscarded
      }).items;
    }
  };
}

export function createStructuredWorkMeetingVerifier(input: {
  profile: WorkReviewAnalysisProviderProfile;
  requestStructuredJson?: WorkStructuredJsonRequest;
}): WorkMeetingVerifier {
  if (input.profile.provider === "fixture") {
    throw new WorkReviewRuntimeConfigError(
      "work_review_analysis_fixture_not_explicitly_enabled",
      "Use an injected deterministic fixture provider instead of the production adapter"
    );
  }
  const requestStructuredJson = input.requestStructuredJson ?? productionStructuredJsonRequest;
  return {
    profile: input.profile,
    async verify(request) {
      const payload = buildWorkMeetingVerifierProviderPayload(request);
      const response = await requestStructuredJson({
        stage: "verifier",
        profile: input.profile,
        name: input.profile.schemaVersion,
        schema: WorkVerifierWireEnvelopeSchema,
        requestInput: [
          { role: "system", content: VERIFIER_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify(payload)
          }
        ],
        jsonInstruction: request.duplicateCoverage?.length
          ? WORK_MEETING_VERIFIER_JSON_INSTRUCTION.replace("{items:[...]}", "{items:[...],coverage:[...]}") + DUPLICATE_COVERAGE_INSTRUCTION
          : WORK_MEETING_VERIFIER_JSON_INSTRUCTION,
        normalize: normalizeWorkVerifierWireResponse,
        signal: request.signal
      });
      return validateWorkMeetingVerifierResult({
        response,
        claims: request.claims,
        allowedSegments: request.segments,
        duplicateCoverage: request.duplicateCoverage
      });
    }
  };
}

function createDeterministicFixtureWorkMeetingExtractor(
  profile: WorkReviewAnalysisProviderProfile
): WorkMeetingExtractor {
  return {
    profile,
    async extract(request) {
      return validateWorkExtractorOutput({
        response: { items: [] },
        allowedSegments: request.window.segments
      }).items;
    }
  };
}

function createDeterministicFixtureWorkMeetingVerifier(
  profile: WorkReviewAnalysisProviderProfile
): WorkMeetingVerifier {
  return {
    profile,
    async verify(request) {
      return validateWorkMeetingVerifierResult({
        response: {
          items: request.claims.map((claim) => ({
            claimId: claim.id,
            supportVerdict: "unverifiable" as const,
            // A deterministic fixture cannot diagnose a specific semantic violation.
            issueCodes: [],
            supportedEvidenceIds: []
          }))
        },
        claims: request.claims,
        allowedSegments: request.segments,
        duplicateCoverage: request.duplicateCoverage
      });
    }
  };
}

function configuredExtractorForProfile(input: {
  profile: WorkReviewAnalysisProviderProfile;
  requestStructuredJson?: WorkStructuredJsonRequest;
}) {
  return input.profile.provider === "fixture"
    ? createDeterministicFixtureWorkMeetingExtractor(input.profile)
    : createStructuredWorkMeetingExtractor(input);
}

function configuredVerifierForProfile(input: {
  profile: WorkReviewAnalysisProviderProfile;
  requestStructuredJson?: WorkStructuredJsonRequest;
}) {
  return input.profile.provider === "fixture"
    ? createDeterministicFixtureWorkMeetingVerifier(input.profile)
    : createStructuredWorkMeetingVerifier(input);
}

export function createConfiguredWorkMeetingAnalysisProviders(input: {
  env?: WorkReviewRuntimeEnv;
  requestStructuredJson?: WorkStructuredJsonRequest;
} = {}) {
  const config = resolveWorkReviewAnalysisRuntimeConfig(input.env);
  return {
    extractor: configuredExtractorForProfile({
      profile: config.extractor,
      requestStructuredJson: input.requestStructuredJson
    }),
    verifier: configuredVerifierForProfile({
      profile: config.verifier,
      requestStructuredJson: input.requestStructuredJson
    })
  };
}

export function createConfiguredWorkMeetingExtractor(input: {
  env?: WorkReviewRuntimeEnv;
  requestStructuredJson?: WorkStructuredJsonRequest;
} = {}) {
  return configuredExtractorForProfile({
    profile: resolveWorkReviewExtractorProfile(input.env),
    requestStructuredJson: input.requestStructuredJson
  });
}

export function createConfiguredWorkMeetingVerifier(input: {
  env?: WorkReviewRuntimeEnv;
  requestStructuredJson?: WorkStructuredJsonRequest;
} = {}) {
  return configuredVerifierForProfile({
    profile: resolveWorkReviewVerifierProfile(input.env),
    requestStructuredJson: input.requestStructuredJson
  });
}

export function createProductionWorkMeetingAnalysisProviders(input: {
  config?: WorkReviewAnalysisRuntimeConfig;
  requestStructuredJson?: WorkStructuredJsonRequest;
} = {}) {
  const config = input.config ?? resolveWorkReviewAnalysisRuntimeConfig();
  return {
    extractor: createStructuredWorkMeetingExtractor({
      profile: config.extractor,
      requestStructuredJson: input.requestStructuredJson
    }),
    verifier: createStructuredWorkMeetingVerifier({
      profile: config.verifier,
      requestStructuredJson: input.requestStructuredJson
    })
  };
}

export function createProductionWorkMeetingExtractor(input: {
  profile?: WorkReviewAnalysisProviderProfile;
  requestStructuredJson?: WorkStructuredJsonRequest;
} = {}) {
  return createStructuredWorkMeetingExtractor({
    profile: input.profile ?? resolveWorkReviewExtractorProfile(),
    requestStructuredJson: input.requestStructuredJson
  });
}

export function createProductionWorkMeetingVerifier(input: {
  profile?: WorkReviewAnalysisProviderProfile;
  requestStructuredJson?: WorkStructuredJsonRequest;
} = {}) {
  return createStructuredWorkMeetingVerifier({
    profile: input.profile ?? resolveWorkReviewVerifierProfile(),
    requestStructuredJson: input.requestStructuredJson
  });
}

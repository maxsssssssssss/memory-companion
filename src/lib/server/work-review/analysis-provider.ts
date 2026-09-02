import { z } from "zod";

import {
  WorkCanonicalSegmentsSchema,
  WorkEvidenceTimestampQualitySchema,
  WorkExtractorResponseSchema,
  WorkMeetingCandidateStructuredDataSchema,
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
import { parseStructuredJsonResponse } from "@/lib/server/openai/structured-json";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";
import {
  resolveWorkReviewAnalysisRuntimeConfig,
  resolveWorkReviewExtractorProfile,
  resolveWorkReviewVerifierProfile,
  WorkReviewRuntimeConfigError,
  type WorkReviewAnalysisProviderProfile,
  type WorkReviewAnalysisRuntimeConfig
} from "./runtime-config";
import {
  WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES,
  WORK_MEETING_SEMANTIC_SAFETY_RULES
} from "./publication-policy";
import type { WorkMeetingTranscriptWindow } from "./windowing";

type WorkReviewRuntimeEnv = Readonly<Record<string, string | undefined>>;

export type WorkMeetingExtractorInput = {
  accountId: string;
  meetingId: string;
  publicationId: string;
  canonicalDigest: string;
  window: WorkMeetingTranscriptWindow;
  signal?: AbortSignal;
};

export type WorkMeetingVerifierInput = {
  accountId: string;
  meetingId: string;
  publicationId: string;
  canonicalDigest: string;
  segments: unknown[];
  claims: WorkAtomicClaim[];
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
  verify(input: WorkMeetingVerifierInput): Promise<WorkVerifierClaimDraft[]>;
}

export type WorkStructuredJsonRequest = (input: {
  profile: WorkReviewAnalysisProviderProfile;
  name: string;
  schema: z.ZodTypeAny;
  requestInput: Parameters<typeof parseStructuredJsonResponse>[0]["requestInput"];
  jsonInstruction: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

export class WorkMeetingAnalysisProviderError extends Error {
  constructor(
    public readonly code:
      | "work_extractor_output_invalid"
      | "work_verifier_output_invalid"
      | "work_evidence_not_allowed"
      | "work_evidence_closure_invalid"
      | "work_analysis_fixture_provider_forbidden",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WorkMeetingAnalysisProviderError";
  }
}

export const WORK_MEETING_EXTRACTOR_JSON_INSTRUCTION =
  "输出严格的 {items:[...]} JSON。每个 item 必须包含 clientCandidateKey、kind、title、body、" +
  "structuredData、evidenceIds、claims；每个 claim 必须包含 clientClaimKey、claimType、text、evidenceIds。" +
  "evidenceIds 只能使用输入窗口中的 segment id。planStages 只能使用 clientStageKey、content、status、" +
  "rawSpeakerLabel、evidenceIds，不能返回来源原文。";

export const WORK_MEETING_VERIFIER_JSON_INSTRUCTION =
  "输出严格的 {items:[...]} JSON。每个输入 claim 必须恰好返回一项，包含 claimId、supportVerdict、" +
  "issueCodes、supportedEvidenceIds。supportVerdict 只能是 entailed、partially_entailed、unsupported、" +
  "contradicted、unverifiable；supportedEvidenceIds 只能来自该 claim 的 Evidence allowlist。";

const EXTRACTOR_SYSTEM_PROMPT = [
  "你是 Work Meeting Extractor。只从当前 canonical Transcript 窗口提取讨论、建议、决定、承诺、未解决问题、方案变化与行动事项候选。",
  "所有输出都只是待用户审核的候选，不是公司正式记录、Todo、长期 Memory 或绩效判断。",
  "每项和每个原子 Claim 都必须引用输入中的 segment id；不得生成来源原文、不得猜测真实身份。",
  "Decision 必须区分 final、tentative、unclear；Commitment 必须存在明确接受或承诺表达；Assignment without acceptance 不是 Commitment。",
  "Action Item 必须标明 explicit_commitment、assignment_without_acceptance、suggested_action 或 unowned_follow_up。",
  "Open Question 必须考虑后续是否已经回答；Plan Change 必须保留旧方案、中间修订和当前方案，不能只保留最后一句。",
  `强制语义边界：${WORK_MEETING_SEMANTIC_SAFETY_RULES.join("; ")}。`
].join("\n");

const VERIFIER_SYSTEM_PROMPT = [
  "你是独立的 Work Meeting Atomic Claim Verifier。你只能核验输入 claim 与该 claim 的 canonical Evidence allowlist。",
  "不要读取或信任 Generator narrative，不得改写 Claim，不得通过多次改写制造通过。",
  "逐项判断 Evidence 是否支持 Claim；原文只出现人名、日期、任务或时间顺序都不足以证明负责人、截止日期、承诺或因果。",
  "unsupported、contradicted、unverifiable 必须如实返回；不得因看起来合理而升级为 entailed。",
  `若违反语义边界，issueCodes 必须使用这些稳定代码之一：${WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES.join(", ")}。`,
  `强制语义边界：${WORK_MEETING_SEMANTIC_SAFETY_RULES.join("; ")}。`
].join("\n");

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("work_analysis_provider_timeout")),
    timeoutMs
  );
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    }
  };
}

const productionStructuredJsonRequest: WorkStructuredJsonRequest = async (input) => {
  if (input.profile.provider === "fixture") {
    throw new WorkMeetingAnalysisProviderError(
      "work_analysis_fixture_provider_forbidden",
      "Production structured adapters cannot execute fixture analysis"
    );
  }
  const runtimeConfig = await getOpenAIClientRuntimeConfig();
  const client = createOpenAIClient({
    ...runtimeConfig,
    timeoutMs: input.profile.timeoutMs
  });
  const request = createTimeoutSignal(input.signal, input.profile.timeoutMs);
  try {
    return await parseStructuredJsonResponse({
      client,
      model: input.profile.model,
      name: input.name,
      schema: input.schema,
      mode: "json",
      requestInput: input.requestInput,
      jsonInstruction: input.jsonInstruction,
      maxOutputTokens: input.profile.maxOutputTokens,
      reasoning: input.profile.reasoningEffort === "provider_default"
        ? undefined
        : { effort: input.profile.reasoningEffort },
      requestOptions: { signal: request.signal }
    });
  } finally {
    request.cleanup();
  }
};

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
  for (const candidate of parsed.data.items) {
    if (candidateKeys.has(candidate.clientCandidateKey)) {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_closure_invalid",
        "Extractor candidate keys must be unique"
      );
    }
    candidateKeys.add(candidate.clientCandidateKey);
    const candidateEvidence = new Set(candidate.evidenceIds);
    if (candidateEvidence.size !== candidate.evidenceIds.length
      || candidate.evidenceIds.some((id) => !allowedEvidence.has(id))) {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_not_allowed",
        "Extractor candidate referenced Evidence outside the canonical window"
      );
    }
    for (const claim of candidate.claims) {
      if (claimKeys.has(claim.clientClaimKey)) {
        throw new WorkMeetingAnalysisProviderError(
          "work_evidence_closure_invalid",
          "Extractor claim keys must be unique"
        );
      }
      claimKeys.add(claim.clientClaimKey);
      if (new Set(claim.evidenceIds).size !== claim.evidenceIds.length
        || claim.evidenceIds.some((id) => !candidateEvidence.has(id))) {
        throw new WorkMeetingAnalysisProviderError(
          "work_evidence_closure_invalid",
          "Atomic Claim Evidence must be a subset of Candidate Evidence"
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
  }
  for (const candidate of parsed.data.items) {
    const relatedId = candidate.structuredData.relatedCommitmentCandidateId;
    if (relatedId !== null && !parsed.data.items.some((item) =>
      item.clientCandidateKey === relatedId && item.kind === "commitment"
    )) {
      throw new WorkMeetingAnalysisProviderError(
        "work_evidence_closure_invalid",
        "Action Item related commitment must refer to a generated Commitment candidate"
      );
    }
  }
  return parsed.data;
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
  const claimById = new Map(input.claims.map((claim) => [claim.id, claim]));
  const allowedEvidence = new Set(canonicalSegments(input.allowedSegments).map((segment) => segment.id));
  const responseIds = parsed.data.items.map((item) => item.claimId);
  if (new Set(responseIds).size !== responseIds.length
    || responseIds.length !== claimById.size
    || responseIds.some((id) => !claimById.has(id))) {
    throw new WorkMeetingAnalysisProviderError(
      "work_evidence_closure_invalid",
      "Verifier response must contain exactly one evaluation for every input Claim"
    );
  }
  const allowedIssueCodes = new Set<string>(WORK_MEETING_SEMANTIC_SAFETY_ISSUE_CODES);
  for (const evaluation of parsed.data.items) {
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
  return parsed.data;
}

function verifierPayload(input: WorkMeetingVerifierInput) {
  return input.claims.map((claim) => ({
    claimId: claim.id,
    claimType: claim.claimType,
    text: claim.text,
    evidence: materializeWorkEvidence({
      publicationId: input.publicationId,
      segments: input.segments,
      evidenceIds: claim.evidenceIds,
      timestampQualityBySegmentId: input.timestampQualityBySegmentId
    })
  }));
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
      const response = await requestStructuredJson({
        profile: input.profile,
        name: input.profile.schemaVersion,
        schema: WorkExtractorResponseSchema,
        requestInput: [
          { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `meetingId=${request.meetingId}`,
              `publicationId=${request.publicationId}`,
              `canonicalDigest=${request.canonicalDigest}`,
              `window=${request.window.index + 1}/${request.window.count}`,
              transcriptWindowPrompt(request.window)
            ].join("\n")
          }
        ],
        jsonInstruction: WORK_MEETING_EXTRACTOR_JSON_INSTRUCTION,
        signal: request.signal
      });
      return validateWorkExtractorOutput({
        response,
        allowedSegments: request.window.segments
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
      const payload = verifierPayload(request);
      const response = await requestStructuredJson({
        profile: input.profile,
        name: input.profile.schemaVersion,
        schema: WorkVerifierResponseSchema,
        requestInput: [
          { role: "system", content: VERIFIER_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              meetingId: request.meetingId,
              publicationId: request.publicationId,
              canonicalDigest: request.canonicalDigest,
              items: payload
            })
          }
        ],
        jsonInstruction: WORK_MEETING_VERIFIER_JSON_INSTRUCTION,
        signal: request.signal
      });
      return validateWorkVerifierOutput({
        response,
        claims: request.claims,
        allowedSegments: request.segments
      }).items;
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
      return validateWorkVerifierOutput({
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
        allowedSegments: request.segments
      }).items;
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

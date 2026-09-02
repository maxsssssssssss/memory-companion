import { describe, expect, it, vi } from "vitest";

import {
  WorkAtomicClaimSchema,
  type WorkExtractorCandidateDraft
} from "@/lib/domain/work-review";
import {
  createStructuredWorkMeetingExtractor,
  createStructuredWorkMeetingVerifier,
  createConfiguredWorkMeetingAnalysisProviders,
  materializeWorkEvidence,
  materializeWorkExtractorCandidate,
  validateWorkExtractorOutput,
  validateWorkVerifierOutput,
  WorkMeetingAnalysisProviderError,
  type WorkStructuredJsonRequest
} from "./analysis-provider";
import { buildWorkMeetingTranscriptWindows } from "./windowing";
import { WORK_MEETING_SEMANTIC_SAFETY_RULES } from "./publication-policy";
import {
  WorkReviewRuntimeConfigError,
  type WorkReviewAnalysisProviderProfile
} from "./runtime-config";

function segment(id: string, startSeconds = 0, text = `canonical ${id}`) {
  return {
    id,
    uploadId: "upload_1",
    startSeconds,
    endSeconds: startSeconds + 1,
    speaker: "Speaker 1",
    text,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

const segments = [
  segment("segment_1", 0, "可以考虑下周一上线。"),
  segment("segment_2", 1, "最终就按下周一上线。")
];

const profile: WorkReviewAnalysisProviderProfile = {
  profileId: "work-meeting-extractor",
  provider: "openai-compatible-structured-json",
  model: "test-model",
  reasoningEffort: "minimal",
  timeoutMs: 2_000,
  maxOutputTokens: 2_000,
  promptVersion: "work_meeting_extractor_v1",
  schemaVersion: "work_meeting_candidates_v1"
};

function extractorCandidate(): WorkExtractorCandidateDraft {
  return {
    clientCandidateKey: "candidate_1",
    kind: "decision",
    title: "下周一上线",
    body: "会议中出现了明确决定表达。",
    structuredData: {
      decisionFinality: "final",
      rawActorLabel: "Speaker 1",
      candidateOwner: null,
      dueAt: null,
      originalDueExpression: null,
      actionBasis: null,
      relatedCommitmentCandidateId: null,
      planStages: []
    },
    evidenceIds: ["segment_2"],
    claims: [{
      clientClaimKey: "claim_1",
      claimType: "decision_existence",
      text: "会议作出了下周一上线的决定",
      evidenceIds: ["segment_2"]
    }, {
      clientClaimKey: "claim_2",
      claimType: "decision_finality",
      text: "该决定是最终决定",
      evidenceIds: ["segment_2"]
    }]
  };
}

describe("Work Meeting analysis providers", () => {
  it("rejects generator Evidence outside the canonical window", () => {
    const candidate = extractorCandidate();
    expect(() => validateWorkExtractorOutput({
      allowedSegments: segments,
      response: {
        items: [{ ...candidate, evidenceIds: ["other_meeting_segment"] }]
      }
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_evidence_not_allowed"
    }));
  });

  it("rejects model-supplied source text instead of treating it as canonical Evidence", () => {
    const candidate = extractorCandidate();
    expect(() => validateWorkExtractorOutput({
      allowedSegments: segments,
      response: {
        items: [{ ...candidate, sourceQuote: "invented quote" }]
      }
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_extractor_output_invalid"
    }));
  });

  it("materializes source text, timestamps, and speaker only from canonical Segments", () => {
    expect(materializeWorkEvidence({
      publicationId: "publication_1",
      segments,
      evidenceIds: ["segment_2"],
      timestampQualityBySegmentId: { segment_2: "provider_exact" }
    })).toEqual([{
      publicationId: "publication_1",
      segmentId: "segment_2",
      startSeconds: 1,
      endSeconds: 2,
      rawSpeakerLabel: "Speaker 1",
      timestampQuality: "provider_exact",
      text: "最终就按下周一上线。"
    }]);
    const materialized = materializeWorkExtractorCandidate({
      publicationId: "publication_1",
      segments,
      candidate: extractorCandidate()
    });
    expect(materialized.evidenceRefs[0].text).toBe(segments[1].text);
    expect(materialized).not.toHaveProperty("evidenceIds");
  });

  it("runs the extractor with a bounded canonical window and strict schema", async () => {
    const requestStructuredJson = vi.fn(async () => ({ items: [extractorCandidate()] }));
    const extractor = createStructuredWorkMeetingExtractor({
      profile,
      requestStructuredJson
    });
    const window = buildWorkMeetingTranscriptWindows(segments)[0];
    await expect(extractor.extract({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      window
    })).resolves.toEqual([extractorCandidate()]);
    expect(requestStructuredJson).toHaveBeenCalledWith(expect.objectContaining({
      profile,
      name: "work_meeting_candidates_v1",
      jsonInstruction: expect.stringContaining("evidenceIds 只能使用输入窗口")
    }));
    for (const rule of WORK_MEETING_SEMANTIC_SAFETY_RULES) {
      expect(requestStructuredJson).toHaveBeenCalledWith(expect.objectContaining({
        requestInput: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining(rule) })
        ])
      }));
    }
  });

  it("requires exact verifier Claim closure and canonical supported Evidence", () => {
    const claims = [WorkAtomicClaimSchema.parse({
      id: "claim_1",
      candidateId: "candidate_1",
      claimType: "decision_existence",
      text: "会议作出了决定",
      evidenceIds: ["segment_2"],
      createdAt: null
    })];
    expect(() => validateWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: { items: [] }
    })).toThrow("exactly one evaluation");
    expect(() => validateWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: {
        items: [{
          claimId: "claim_1",
          supportVerdict: "entailed",
          issueCodes: [],
          supportedEvidenceIds: ["segment_1"]
        }]
      }
    })).toThrow("subset of the Claim allowlist");
    expect(() => validateWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: {
        items: [{
          claimId: "claim_1",
          supportVerdict: "unverifiable",
          issueCodes: ["fixture_result_unverifiable"],
          supportedEvidenceIds: []
        }]
      }
    })).toThrowError(expect.objectContaining<Partial<WorkMeetingAnalysisProviderError>>({
      code: "work_verifier_output_invalid"
    }));
    expect(validateWorkVerifierOutput({
      claims,
      allowedSegments: segments,
      response: {
        items: [{
          claimId: "claim_1",
          supportVerdict: "unsupported",
          issueCodes: ["proposal_promoted_to_decision"],
          supportedEvidenceIds: []
        }]
      }
    }).items[0]?.issueCodes).toEqual(["proposal_promoted_to_decision"]);
  });

  it("runs explicitly enabled non-production fixture profiles through configured factories offline", async () => {
    const requestStructuredJson = vi.fn(async () => {
      throw new Error("fixture analysis must not reach a provider request");
    });
    const providers = createConfiguredWorkMeetingAnalysisProviders({
      env: {
        NODE_ENV: "test",
        WORK_REVIEW_EXTRACTOR_PROVIDER: "fixture",
        WORK_REVIEW_VERIFIER_PROVIDER: "fixture",
        WORK_REVIEW_FIXTURE_ANALYSIS_ENABLED: "true"
      },
      requestStructuredJson
    });
    const window = buildWorkMeetingTranscriptWindows(segments)[0];
    const claim = WorkAtomicClaimSchema.parse({
      id: "claim_1",
      candidateId: "candidate_1",
      claimType: "decision_existence",
      text: "会议作出了下周一上线的决定",
      evidenceIds: ["segment_2"],
      createdAt: null
    });

    await expect(providers.extractor.extract({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      window
    })).resolves.toEqual([]);
    await expect(providers.verifier.verify({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      segments,
      claims: [claim]
    })).resolves.toEqual([{
      claimId: "claim_1",
      supportVerdict: "unverifiable",
      issueCodes: [],
      supportedEvidenceIds: []
    }]);
    expect(requestStructuredJson).not.toHaveBeenCalled();
  });

  it("keeps configured fixture factories closed in production or without explicit enablement", () => {
    expect(() => createConfiguredWorkMeetingAnalysisProviders({
      env: {
        NODE_ENV: "production",
        WORK_REVIEW_EXTRACTOR_PROVIDER: "fixture",
        WORK_REVIEW_VERIFIER_PROVIDER: "fixture",
        WORK_REVIEW_FIXTURE_ANALYSIS_ENABLED: "true"
      }
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_analysis_fixture_forbidden_in_production"
    }));
    expect(() => createConfiguredWorkMeetingAnalysisProviders({
      env: {
        NODE_ENV: "test",
        WORK_REVIEW_EXTRACTOR_PROVIDER: "fixture",
        WORK_REVIEW_VERIFIER_PROVIDER: "fixture"
      }
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_analysis_fixture_not_explicitly_enabled"
    }));
  });

  it("keeps structured adapters closed to fixture profiles", () => {
    const fixtureProfile: WorkReviewAnalysisProviderProfile = {
      ...profile,
      provider: "fixture",
      model: "work-review-deterministic-fixture-v1"
    };
    expect(() => createStructuredWorkMeetingExtractor({ profile: fixtureProfile }))
      .toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
        code: "work_review_analysis_fixture_not_explicitly_enabled"
      }));
    expect(() => createStructuredWorkMeetingVerifier({ profile: fixtureProfile }))
      .toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
        code: "work_review_analysis_fixture_not_explicitly_enabled"
      }));
  });

  it("gives the verifier only atomic claims plus server-materialized Evidence", async () => {
    const verifierProfile = { ...profile, profileId: "work-meeting-verifier" };
    const claim = WorkAtomicClaimSchema.parse({
      id: "claim_1",
      candidateId: "candidate_1",
      claimType: "decision_existence",
      text: "会议作出了下周一上线的决定",
      evidenceIds: ["segment_2"],
      createdAt: null
    });
    let capturedRequest: Parameters<WorkStructuredJsonRequest>[0] | undefined;
    const requestStructuredJson: WorkStructuredJsonRequest = vi.fn(async (request) => {
      capturedRequest = request;
      return {
      items: [{
        claimId: "claim_1",
        supportVerdict: "entailed",
        issueCodes: [],
        supportedEvidenceIds: ["segment_2"]
      }]
      };
    });
    const verifier = createStructuredWorkMeetingVerifier({
      profile: verifierProfile,
      requestStructuredJson
    });
    await expect(verifier.verify({
      accountId: "account_1",
      meetingId: "meeting_1",
      publicationId: "publication_1",
      canonicalDigest: "a".repeat(64),
      segments,
      claims: [claim]
    })).resolves.toEqual([{
      claimId: "claim_1",
      supportVerdict: "entailed",
      issueCodes: [],
      supportedEvidenceIds: ["segment_2"]
    }]);
    expect(capturedRequest).toBeDefined();
    const requestInput = capturedRequest!.requestInput;
    expect(Array.isArray(requestInput)).toBe(true);
    const userMessage = (requestInput as Array<{ content?: string }>)[1]!;
    expect(userMessage.content).toContain("最终就按下周一上线。");
    expect(userMessage.content).not.toContain("会议中出现了明确决定表达");
  });
});

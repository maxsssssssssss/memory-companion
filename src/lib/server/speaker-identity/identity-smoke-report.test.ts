import { describe, expect, it } from "vitest";

import { buildIdentitySmokeReport } from "./identity-smoke-report";

const providerCapabilities = {
  identityEvidence: "speaker_result_label",
  acousticSimilarityScore: "not_provided",
  acousticConfidence: "not_provided",
  independentVoiceprintId: "not_provided",
  thresholdBasedIdentityConfidence: "not_supported"
};

describe("identity smoke report", () => {
  it("passes a verified Provider-label user without inventing an ID or score", () => {
    const [knownUser] = buildIdentitySmokeReport({
      remote: {
        train: {
          status: "success",
          voiceprintId: "must_not_be_reported",
          providerScore: 0.94
        }
      },
      cases: {
        knownUser: {
          status: "success",
          resolvedIdentity: "user_A",
          finalIdentityType: "known_user",
          providerLabelObserved: true,
          source: "provider_speaker_result",
          matched: true
        }
      }
    });

    expect(knownUser).toEqual({
      case: "known_user_enroll_verify",
      provider: "company_voiceprint",
      voiceprint_id: null,
      score: null,
      identity_evidence_source: "provider_speaker_result",
      provider_capabilities: providerCapabilities,
      resolved_identity: "user_A",
      result: "PASS"
    });
  });

  it("reports contact and unknown outcomes as Provider speaker-result labels", () => {
    const [, contact, unknown] = buildIdentitySmokeReport({
      remote: {
        save: { status: "success" }
      },
      cases: {
        unknownVoice: {
          status: "success",
          finalIdentityType: "unknown_person"
        }
      }
    });

    expect(contact).toMatchObject({
      case: "known_contact_save",
      voiceprint_id: null,
      score: null,
      identity_evidence_source: "provider_speaker_result",
      provider_capabilities: providerCapabilities,
      resolved_identity: "known_contact",
      result: "PASS"
    });
    expect(unknown).toMatchObject({
      case: "unknown_person_verify",
      voiceprint_id: null,
      score: null,
      identity_evidence_source: "provider_speaker_result",
      provider_capabilities: providerCapabilities,
      resolved_identity: "unknown_person",
      result: "PASS"
    });
  });

  it("does not treat local resolver state as Provider-label verification", () => {
    const [knownUser] = buildIdentitySmokeReport({
      remote: {
        train: { status: "success" }
      },
      cases: {
        knownUser: {
          status: "success",
          resolvedIdentity: "user_A",
          resolverConfidence: 0.99,
          source: "cross_chunk_matching",
          matched: true
        }
      }
    });

    expect(knownUser).toMatchObject({
      voiceprint_id: null,
      score: null,
      resolved_identity: "user_A",
      result: "FAIL"
    });
  });
});

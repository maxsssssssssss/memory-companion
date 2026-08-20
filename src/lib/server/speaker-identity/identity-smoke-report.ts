export type IdentitySmokeReportRecord = {
  case: string;
  provider: "company_voiceprint";
  /**
   * Null means the Provider contract did not expose an opaque voiceprint ID.
   * A user ID, alias, local profile ID, or speaker_<n> label must not be
   * substituted here.
   */
  voiceprint_id: string | null;
  /**
   * Provider acoustic confidence only. Local resolver confidence must not be
   * reported as though it came from the Provider.
   */
  score: number | null;
  identity_evidence_source: "provider_speaker_result" | null;
  provider_capabilities: {
    identityEvidence: "speaker_result_label";
    acousticSimilarityScore: "not_provided";
    acousticConfidence: "not_provided";
    independentVoiceprintId: "not_provided";
    thresholdBasedIdentityConfidence: "not_supported";
  };
  resolved_identity: string;
  result: "PASS" | "FAIL";
};

type SmokeStep = {
  status?: unknown;
  resolvedIdentity?: unknown;
  finalIdentityType?: unknown;
  providerLabelObserved?: unknown;
  source?: unknown;
  matched?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function step(value: unknown): SmokeStep {
  return record(value);
}

function resolvedIdentity(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Projects the detailed redacted smoke artifact into the compact acceptance
 * format. The 8790 Provider exposes labels only, so opaque IDs and acoustic
 * scores always remain null rather than being filled from aliases, local IDs,
 * resolver policy, or matcher output.
 */
export function buildIdentitySmokeReport(
  detailedReport: Record<string, unknown>
): IdentitySmokeReportRecord[] {
  const remote = record(detailedReport.remote);
  const cases = record(detailedReport.cases);
  const train = step(remote.train);
  const save = step(remote.save);
  const knownUser = step(cases.knownUser);
  const unknownVoice = step(cases.unknownVoice);
  const knownUserResolvedIdentity = resolvedIdentity(
    knownUser.resolvedIdentity,
    "unknown_person"
  );
  const knownUserVerified =
    train.status === "success" &&
    knownUser.status === "success" &&
    knownUser.providerLabelObserved === true &&
    knownUser.finalIdentityType === "known_user" &&
    knownUser.source === "provider_speaker_result" &&
    knownUser.matched === true &&
    knownUserResolvedIdentity !== "unknown_person";

  return [
    {
      case: "known_user_enroll_verify",
      provider: "company_voiceprint",
      voiceprint_id: null,
      score: null,
      identity_evidence_source: "provider_speaker_result",
      provider_capabilities: providerCapabilities(),
      resolved_identity: knownUserResolvedIdentity,
      result: knownUserVerified ? "PASS" : "FAIL"
    },
    {
      case: "known_contact_save",
      provider: "company_voiceprint",
      voiceprint_id: null,
      score: null,
      identity_evidence_source:
        save.status === "success" ? "provider_speaker_result" : null,
      provider_capabilities: providerCapabilities(),
      resolved_identity:
        save.status === "success" ? "known_contact" : "unknown_person",
      result: save.status === "success" ? "PASS" : "FAIL"
    },
    {
      case: "unknown_person_verify",
      provider: "company_voiceprint",
      voiceprint_id: null,
      score: null,
      identity_evidence_source:
        unknownVoice.status === "success" ? "provider_speaker_result" : null,
      provider_capabilities: providerCapabilities(),
      resolved_identity: resolvedIdentity(
        unknownVoice.finalIdentityType ?? unknownVoice.resolvedIdentity,
        "unknown_person"
      ),
      result:
        unknownVoice.status === "success" &&
        (unknownVoice.finalIdentityType === "unknown_person" ||
          unknownVoice.resolvedIdentity === "unknown_person")
          ? "PASS"
          : "FAIL"
    }
  ];
}

function providerCapabilities(): IdentitySmokeReportRecord["provider_capabilities"] {
  return {
    identityEvidence: "speaker_result_label",
    acousticSimilarityScore: "not_provided",
    acousticConfidence: "not_provided",
    independentVoiceprintId: "not_provided",
    thresholdBasedIdentityConfidence: "not_supported"
  };
}

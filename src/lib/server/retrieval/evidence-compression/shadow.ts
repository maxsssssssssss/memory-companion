import type { QaQueryIntentAnalysis } from "../lifecycle-retrieval";
import { projectCompactEvidence } from "./projection";
import type {
  CanonicalEvidenceProjectionItem,
  CompactEvidenceProjection
} from "./types";

export type EvidenceCompressionShadowLogger = Pick<Console, "info" | "warn">;

function errorName(error: unknown) {
  return error instanceof Error && error.name.trim()
    ? error.name.trim()
    : "unknown";
}

/**
 * Computes and logs content-free shadow metrics. Any projection or logger
 * failure is isolated from the production QA request.
 */
export function observeCompactEvidenceShadow(
  input: {
    attempt: "sync" | "stream";
    evidence: readonly CanonicalEvidenceProjectionItem[];
    queryIntent: QaQueryIntentAnalysis;
  },
  logger: EvidenceCompressionShadowLogger = console
): CompactEvidenceProjection | null {
  try {
    const projection = projectCompactEvidence(input);
    if (projection.audioItems === 0) {
      return projection;
    }

    logger.info(
      `EVIDENCE_COMPRESSION_SHADOW: ${JSON.stringify({
        attempt: input.attempt,
        intent: projection.queryIntent.intent,
        evidence_count: projection.views.length,
        audio_items: projection.audioItems,
        projected_audio_items: projection.projectedAudioItems,
        fallback_items: projection.fallbackItems,
        original_chars: projection.originalChars,
        compact_chars: projection.compactChars,
        reduction_ratio: projection.reductionRatio,
        citation_mapping_unchanged: projection.citationMappingUnchanged,
        source_ids_unchanged: projection.sourceIdsUnchanged,
        lifecycle_state_unchanged: projection.lifecycleStateUnchanged,
        provider_payload: projection.providerPayload
      })}`
    );
    return projection;
  } catch (error) {
    try {
      logger.warn(
        `[qa-evidence-shadow] projection_failed error_name=${errorName(error)}`
      );
    } catch {
      // Shadow diagnostics must never affect the production QA request.
    }
    return null;
  }
}

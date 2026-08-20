import { describe, expect, it } from "vitest";
import {
  HYBRID_PHASE31_SHADOW_V1,
  PHASE_3_1_RANKING_VERSION
} from "./shadow-baseline";

describe("Phase 3.1 frozen shadow baseline", () => {
  it("keeps the accepted development result descriptive and shadow-only", () => {
    expect(HYBRID_PHASE31_SHADOW_V1).toMatchObject({
      name: "hybrid_phase31_shadow_v1",
      shadowOnly: true,
      productionRetrievalChanged: false,
      dataUsage: "development_regression_only",
      evaluableCaseCount: 52,
      canonicalEvidenceUniqueCount: 2_393,
      embedding: {
        objectType: "evidence",
        modelVersion: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
        dimension: 1_024,
        partitionRecordCount: 2_393
      },
      ranking: {
        version: PHASE_3_1_RANKING_VERSION,
        experiment: "phase3_1_minimal",
        outputLimit: 16
      }
    });
  });

  it("freezes every ranking guard used by phase3_1_minimal", () => {
    expect(HYBRID_PHASE31_SHADOW_V1.ranking.guards).toEqual([
      "topic_consistent_final_top5",
      "lifecycle_chain_top16",
      "relevant_relationship_hybrid_top30",
      "relevant_hybrid_top5",
      "relevant_hybrid_top16"
    ]);
  });
});

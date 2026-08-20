import type {
  EvidenceRankingExperiment
} from "./evidence-ranking";
import type { HybridFusionStrategy } from "./types";

/**
 * Immutable experiment identity for the best Phase 2/3 shadow run measured on
 * 2026-07-29. This is metadata only: it does not enable Hybrid Retrieval in QA.
 */
export const HYBRID_OPTIMIZED_RANKING_V1 = {
  name: "hybrid_optimized_ranking_v1",
  shadowOnly: true,
  productionRetrievalChanged: false,
  headCommit: "84336531233b99a0891d2821c7dee6b773506b98",
  scopedSourceHash:
    "45101455d7a5f17dfe01d45827f6ec70e107f19ea0ae97872054c010114ceec2",
  fixtureHash:
    "dae4d9452d93eec42bdbd52d20aa350010c16ba342ab65b1aff930eb3f437478",
  canonicalUniverseHash:
    "f3d683559a0c791adc52ee548c21e55394b4d3a6e9f6fbdaae250d73c7809c11",
  evaluableCaseCount: 52,
  canonicalEvidenceUniqueCount: 2_393,
  embedding: {
    modelName: "Qwen/Qwen3-Embedding-0.6B",
    modelVersion: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
    dimension: 1_024,
    sidecarSha256:
      "24492a0d8ac2de8de2208a06ce7880ff2645e55a21ce56cf65a319bf267a3dfb",
    sidecarRecordCount: 2_393
  },
  queryParser: {
    version: "hybrid_query_parser_v1",
    conversationRelationshipIntentInheritance: true
  },
  fusion: {
    strategy: "uniform_rrf" as HybridFusionStrategy,
    candidateLimit: 50,
    evaluationLimit: 30
  },
  ranking: {
    experiment: "per_category_weights" as EvidenceRankingExperiment,
    outputLimit: 16,
    explainableFeatureBreakdown: true
  },
  metrics: {
    recallAt5: 0.651,
    recallAt10: 0.747,
    recallAt16: 0.795,
    recallAt30: 0.892,
    mrr: 0.588,
    ndcgAt10: 0.571,
    recoveredCompleteMisses: 12,
    canonicalCandidateValidity: 1
  }
} as const;

export const PHASE_3_1_RANKING_VERSION = "hybrid_optimized_ranking_phase3_1_v1";

/**
 * Frozen development/regression identity for the accepted Phase 3.1 shadow
 * candidate. The 52 cases below are no longer eligible for weight selection.
 * This object is descriptive metadata and does not enable Hybrid Retrieval.
 */
export const HYBRID_PHASE31_SHADOW_V1 = {
  name: "hybrid_phase31_shadow_v1",
  shadowOnly: true,
  productionRetrievalChanged: false,
  dataUsage: "development_regression_only",
  headCommit: "84336531233b99a0891d2821c7dee6b773506b98",
  scopedSourceHash:
    "278148d8f7a2f02d600a803502e1e5fc4b65fccdbcf11881f5e2e3aca6f3b9fb",
  fixtureHash:
    "dae4d9452d93eec42bdbd52d20aa350010c16ba342ab65b1aff930eb3f437478",
  canonicalUniverseHash:
    "f3d683559a0c791adc52ee548c21e55394b4d3a6e9f6fbdaae250d73c7809c11",
  evaluableCaseCount: 52,
  canonicalEvidenceUniqueCount: 2_393,
  embedding: {
    objectType: "evidence",
    modelName: "Qwen/Qwen3-Embedding-0.6B",
    modelVersion: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
    dimension: 1_024,
    partitionRecordCount: 2_393
  },
  queryParser: {
    version: "hybrid_query_parser_v1",
    conversationRelationshipIntentInheritance: true
  },
  fusion: {
    strategy: "uniform_rrf" as HybridFusionStrategy,
    candidateLimit: 50,
    evaluationLimit: 30
  },
  ranking: {
    version: PHASE_3_1_RANKING_VERSION,
    experiment: "phase3_1_minimal" as EvidenceRankingExperiment,
    outputLimit: 16,
    explainableFeatureBreakdown: true,
    categoryWeights: {
      relationship: {
        semantic: 0.16,
        lexical: 0.12,
        temporal: 0.04,
        entity: 0.26,
        lifecycle: 0.02,
        importance: 0.02,
        relationship: 0.37,
        preference: 0.01
      },
      temporal: {
        semantic: 0.24,
        lexical: 0.15,
        temporal: 0.36,
        entity: 0.04,
        lifecycle: 0.15,
        importance: 0.03,
        relationship: 0.02,
        preference: 0.01
      },
      lifecycleOrDecision: {
        semantic: 0.26,
        lexical: 0.16,
        temporal: 0.14,
        entity: 0.05,
        lifecycle: 0.31,
        importance: 0.04,
        relationship: 0.02,
        preference: 0.02
      },
      preference: {
        semantic: 0.28,
        lexical: 0.18,
        temporal: 0.1,
        entity: 0.04,
        lifecycle: 0.03,
        importance: 0.03,
        relationship: 0.02,
        preference: 0.32
      },
      default: {
        semantic: 0.48,
        lexical: 0.34,
        temporal: 0.04,
        entity: 0.06,
        lifecycle: 0.02,
        importance: 0.04,
        relationship: 0.01,
        preference: 0.01
      }
    },
    calibration: {
      calibratedSemanticExceptRelationshipAndTemporal: true,
      calibratedLexicalExceptRelationshipAndTemporal: true,
      importanceCap: 0.35,
      importanceRelevanceGateExceptRelationship: true,
      lifecycleTopicGate: true
    },
    guards: [
      "topic_consistent_final_top5",
      "lifecycle_chain_top16",
      "relevant_relationship_hybrid_top30",
      "relevant_hybrid_top5",
      "relevant_hybrid_top16"
    ],
    protection: {
      relationshipAndTemporalCurrentTop16: true,
      preferenceAndGeneralHybridTop30: true,
      lifecycleChainReservation: true,
      finalStateTop5: true
    }
  },
  metrics: {
    recallAt5: 0.651,
    recallAt10: 0.783,
    recallAt16: 0.843,
    recallAt30: 0.904,
    mrr: 0.592,
    ndcgAt10: 0.58,
    recoveredCompleteMisses: 12,
    canonicalCandidateValidity: 1
  }
} as const;

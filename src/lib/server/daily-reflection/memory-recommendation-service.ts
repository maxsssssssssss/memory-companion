import { createHash } from "node:crypto";

import {
  DailyReflectionMemoryRecommendationResponseSchema,
  type DailyReflectionMemoryProposal,
  type DailyReflectionMemoryRecommendation
} from "@/lib/domain/daily-reflection-memory-proposal";
import type { DailyReflectionWorkingCard } from
  "@/lib/domain/daily-reflection-working-card";
import { roundedScore } from "@/lib/server/text-features";

import { getDailyReflectionDatabase } from "./db";
import {
  createDailyReflectionRepository,
  DailyReflectionNotFoundError,
  type DailyReflectionRepository
} from "./repository";
import { isDailyReflectionTombstone } from "./state-machine";

export const DAILY_REFLECTION_MEMORY_RECOMMENDATION_POLICY_VERSION =
  "daily_reflection_memory_recommendation_v1" as const;
export const DAILY_REFLECTION_MEMORY_RECOMMENDATION_LIMIT = 5 as const;

type RecommendationRepository = Pick<
  DailyReflectionRepository,
  | "getReflection"
  | "getProcessingPlan"
  | "readWorkingCardWithEvidence"
  | "listReflectionCards"
  | "listWorkingCards"
>;

export type DailyReflectionMemoryRecommendationServiceDependencies = {
  repository: RecommendationRepository;
};

type EligibleRecommendation = Omit<DailyReflectionMemoryRecommendation, "rank" | "reasons"> & {
  cardVersion: number;
  evidenceIds: string[];
  sourceRank: number;
  baseReasons: string[];
  contentKey: string;
};

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedContentKey(card: DailyReflectionWorkingCard) {
  const normalized = `${card.title}\n${card.content}`
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 8_000);
  return normalized || card.id;
}

function memoryTypeForCard(
  kind: DailyReflectionWorkingCard["cardKind"]
): DailyReflectionMemoryProposal["memoryType"] {
  switch (kind) {
    case "idea":
    case "insight":
      return "summary";
    case "question":
      return "question";
    case "decision":
      return "decision";
    case "event":
      return "event";
    case "action":
      return "commitment";
  }
}

const KIND_BONUS: Record<DailyReflectionWorkingCard["cardKind"], number> = {
  decision: 0.05,
  action: 0.04,
  question: 0.03,
  insight: 0.02,
  event: 0.01,
  idea: 0
};

function recommendationScore(input: {
  card: DailyReflectionWorkingCard;
  durability: number;
}) {
  return roundedScore(Math.min(1,
    input.card.importance * 0.45
    + input.durability * 0.3
    + input.card.novelty * 0.2
    + KIND_BONUS[input.card.cardKind]
  ));
}

function compareEligible(left: EligibleRecommendation, right: EligibleRecommendation) {
  return right.score - left.score
    || left.sourceRank - right.sourceRank
    || left.cardId.localeCompare(right.cardId);
}

function listAllReflectionWorkingCards(
  repository: RecommendationRepository,
  accountId: string,
  reflectionId: string
) {
  const cards: DailyReflectionWorkingCard[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const page = repository.listWorkingCards({
      accountId,
      reflectionId,
      sort: "created_asc",
      limit: 100,
      offset
    });
    total = page.total;
    cards.push(...page.cards);
    if (page.cards.length === 0) break;
    offset += page.cards.length;
  }
  return cards;
}

export function createDailyReflectionMemoryRecommendationService(
  dependencies: DailyReflectionMemoryRecommendationServiceDependencies
) {
  function recommend(input: { accountId: string; reflectionId: string }) {
    const reflection = dependencies.repository.getReflection(
      input.accountId,
      input.reflectionId
    );
    if (isDailyReflectionTombstone(reflection.status)) {
      throw new DailyReflectionNotFoundError();
    }
    const plan = dependencies.repository.getProcessingPlan(
      input.accountId,
      input.reflectionId
    );
    if (
      !plan
      || plan.uploadId !== reflection.uploadId
      || (
        plan.sourceOrigin !== "user_reflection"
        && plan.sourceOrigin !== "direct_conversation"
      )
    ) {
      return DailyReflectionMemoryRecommendationResponseSchema.parse({
        reflectionId: input.reflectionId,
        policyVersion: DAILY_REFLECTION_MEMORY_RECOMMENDATION_POLICY_VERSION,
        recommendationFingerprint: digest({
          version: DAILY_REFLECTION_MEMORY_RECOMMENDATION_POLICY_VERSION,
          accountId: input.accountId,
          reflectionId: input.reflectionId,
          eligible: []
        }),
        maxRecommendations: DAILY_REFLECTION_MEMORY_RECOMMENDATION_LIMIT,
        eligibleCount: 0,
        recommendations: []
      });
    }

    const reflectionCards = new Map(
      dependencies.repository.listReflectionCards(input.accountId, input.reflectionId)
        .map((card) => [card.id, card])
    );
    const eligible: EligibleRecommendation[] = [];
    for (const listedCard of listAllReflectionWorkingCards(
      dependencies.repository,
      input.accountId,
      input.reflectionId
    )) {
      const workingStatusEligible = listedCard.status === "saved"
        || (
          reflection.status === "review_pending"
          && (
            listedCard.status === "generated"
            || listedCard.status === "review_pending"
          )
        );
      if (
        !workingStatusEligible
        || listedCard.sourceReflectionIds.length !== 1
        || listedCard.sourceReflectionIds[0] !== input.reflectionId
        || listedCard.sourceUnavailable
        || listedCard.memoryLifecycleStatus !== "not_admitted"
      ) {
        continue;
      }
      const sourceCard = reflectionCards.get(listedCard.id);
      if (
        !sourceCard
        || sourceCard.reviewStatus === "excluded"
        || sourceCard.evidenceIds.length === 0
        || JSON.stringify(sourceCard.evidenceIds) !== JSON.stringify(listedCard.evidenceIds)
        || (listedCard.cardKind === "action" && !sourceCard.actionClaimed)
      ) {
        continue;
      }
      const resolved = dependencies.repository.readWorkingCardWithEvidence(
        input.accountId,
        listedCard.id
      );
      if (
        resolved.card.sourceUnavailable
        || resolved.card.status !== listedCard.status
        || resolved.evidence.length !== listedCard.evidenceIds.length
      ) {
        continue;
      }
      const score = recommendationScore({
        card: listedCard,
        durability: sourceCard.durability
      });
      eligible.push({
        cardId: listedCard.id,
        memoryType: memoryTypeForCard(listedCard.cardKind),
        score,
        clusterId: sourceCard.clusterId,
        sourceOrigin: plan.sourceOrigin,
        defaultSelected: false,
        cardVersion: listedCard.version,
        evidenceIds: [...listedCard.evidenceIds],
        sourceRank: sourceCard.rank,
        contentKey: normalizedContentKey(listedCard),
        baseReasons: [
          "canonical_evidence_valid",
          listedCard.status === "saved"
            ? "saved_working_card"
            : "generated_reflection_card",
          ...(listedCard.importance >= 0.7 ? ["recommendation_high_importance"] : []),
          ...(sourceCard.durability >= 0.7 ? ["recommendation_durable"] : []),
          ...(listedCard.novelty >= 0.7 ? ["recommendation_novel"] : [])
        ]
      });
    }

    const ordered = [...eligible].sort(compareEligible);
    const seenContent = new Set<string>();
    const unique = ordered.filter((item) => {
      if (seenContent.has(item.contentKey)) return false;
      seenContent.add(item.contentKey);
      return true;
    });
    const seenClusters = new Set<string>();
    const clusterCoverage = unique.filter((item) => {
      if (seenClusters.has(item.clusterId)) return false;
      seenClusters.add(item.clusterId);
      return true;
    }).sort(compareEligible);
    const selected = clusterCoverage.slice(0, DAILY_REFLECTION_MEMORY_RECOMMENDATION_LIMIT);
    if (selected.length < DAILY_REFLECTION_MEMORY_RECOMMENDATION_LIMIT) {
      const selectedIds = new Set(selected.map((item) => item.cardId));
      selected.push(...unique
        .filter((item) => !selectedIds.has(item.cardId))
        .slice(0, DAILY_REFLECTION_MEMORY_RECOMMENDATION_LIMIT - selected.length));
    }
    const coverageIds = new Set(clusterCoverage.map((item) => item.cardId));
    const recommendations = selected.map((item, index) => ({
      cardId: item.cardId,
      memoryType: item.memoryType,
      rank: index + 1,
      score: item.score,
      clusterId: item.clusterId,
      sourceOrigin: item.sourceOrigin,
      reasons: [
        ...item.baseReasons,
        coverageIds.has(item.cardId) ? "recommendation_cluster_coverage" : "recommendation_score_fill"
      ],
      defaultSelected: false as const
    }));
    return DailyReflectionMemoryRecommendationResponseSchema.parse({
      reflectionId: input.reflectionId,
      policyVersion: DAILY_REFLECTION_MEMORY_RECOMMENDATION_POLICY_VERSION,
      recommendationFingerprint: digest({
        version: DAILY_REFLECTION_MEMORY_RECOMMENDATION_POLICY_VERSION,
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        eligible: unique.map((item) => ({
          cardId: item.cardId,
          cardVersion: item.cardVersion,
          evidenceIds: item.evidenceIds,
          clusterId: item.clusterId,
          score: item.score,
          sourceOrigin: item.sourceOrigin
        }))
      }),
      maxRecommendations: DAILY_REFLECTION_MEMORY_RECOMMENDATION_LIMIT,
      eligibleCount: unique.length,
      recommendations
    });
  }

  return { recommend };
}

export function getDailyReflectionMemoryRecommendationService() {
  return createDailyReflectionMemoryRecommendationService({
    repository: createDailyReflectionRepository(getDailyReflectionDatabase())
  });
}

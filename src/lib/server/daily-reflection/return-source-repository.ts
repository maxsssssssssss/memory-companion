import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import type {
  DailyReflectionReturnEvidence
} from "@/lib/domain/daily-reflection-return";
import type {
  DailyReflectionMemoryProposal
} from "@/lib/domain/daily-reflection-memory-proposal";
import type { ReflectionCard } from "@/lib/domain/daily-reflection";
import type {
  DailyReflectionWorkingCardKind
} from "@/lib/domain/daily-reflection-working-card";
import { workingCardKindForReflectionCard } from
  "@/lib/domain/daily-reflection-working-card";
import { getDailyReflectionDatabase } from "@/lib/server/daily-reflection/db";
import {
  createDailyReflectionMemoryProposalRepository
} from "@/lib/server/daily-reflection/memory-proposal-repository";
import {
  createDailyReflectionRepository,
  type DailyReflectionRepository
} from "@/lib/server/daily-reflection/repository";
import { getMemoryDatabase } from "@/lib/server/memory/db";

type AuthorityRow = {
  publication_id: string;
  reflection_id: string;
  proposal_id: string;
  card_id: string;
  upload_id: string;
  recording_date: string;
  effective_source_origin: "user_reflection" | "direct_conversation";
  current_memory_id: string;
  memory_type: "event" | "commitment" | "question" | "relationship_signal" | "preference" | "summary";
  memory_title: string;
  memory_summary: string;
  importance_score: number;
  source_segment_id: string;
  quote: string;
  content_digest: string;
};

type RelationRow = {
  source_memory_id: string;
  target_memory_id: string;
  relation_type: "related" | "repeated" | "resolved_by" | "contradicted_by" | "follow_up";
  confidence: number;
};

export type DailyReflectionAdmittedReturnSource = {
  memoryId: string;
  cardId: string;
  reflectionId: string;
  recordingDate: string;
  memoryType: DailyReflectionMemoryProposal["memoryType"] | "question";
  cardKind: DailyReflectionWorkingCardKind;
  actionClaimed: boolean;
  subjectPersonId: string | null;
  epistemicStatus: DailyReflectionMemoryProposal["epistemicStatus"];
  epistemicCaution: DailyReflectionMemoryProposal["epistemicCaution"];
  riskFlags: ReflectionCard["riskFlags"];
  title: string;
  content: string;
  importance: number;
  evidence: DailyReflectionReturnEvidence[];
};

export type DailyReflectionGroundedCardSource = {
  cardId: string;
  reflectionIds: string[];
  recordingDates: string[];
  cardKind: DailyReflectionWorkingCardKind;
  epistemicStatuses: DailyReflectionMemoryProposal["epistemicStatus"][];
  riskFlags: ReflectionCard["riskFlags"];
  title: string;
  content: string;
  importance: number;
  relatedCardIds: string[];
  tags: string[];
  evidence: DailyReflectionReturnEvidence[];
};

export type DailyReflectionEmergingCardSource =
  DailyReflectionGroundedCardSource & { cardKind: "idea" | "insight" };

export type DailyReflectionReturnRelation = {
  sourceMemoryId: string;
  targetMemoryId: string;
  relationType: RelationRow["relation_type"];
  confidence: number;
};

export type DailyReflectionReturnSourceSnapshot = {
  admitted: DailyReflectionAdmittedReturnSource[];
  workingCards: DailyReflectionGroundedCardSource[];
  emergingCards: DailyReflectionEmergingCardSource[];
  relations: DailyReflectionReturnRelation[];
};

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactSet(left: string[], right: string[]) {
  return left.length === right.length
    && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function proposalMemoryType(
  proposal: DailyReflectionMemoryProposal | null,
  row: AuthorityRow
): DailyReflectionAdmittedReturnSource["memoryType"] | null {
  if (proposal) return proposal.memoryType;
  if (row.memory_type === "question") return "question";
  if (row.memory_type === "commitment") return "commitment";
  if (row.memory_type === "preference") return "preference";
  if (row.memory_type === "event") return "event";
  // Stage 6 legacy summaries did not freeze a type-safe decision Proposal.
  // Do not infer a decision merely from a non-empty Memory title.
  if (row.memory_type === "summary") return null;
  return null;
}

export class DailyReflectionReturnSourceRepository {
  private readonly sourceRepository: DailyReflectionRepository;
  private readonly proposalRepository: ReturnType<
    typeof createDailyReflectionMemoryProposalRepository
  >;

  constructor(
    private readonly memoryDatabase: Database.Database,
    private readonly dailyReflectionDatabase: Database.Database,
    dependencies: { sourceRepository?: DailyReflectionRepository } = {}
  ) {
    this.sourceRepository = dependencies.sourceRepository
      ?? createDailyReflectionRepository(dailyReflectionDatabase);
    this.proposalRepository = createDailyReflectionMemoryProposalRepository(
      dailyReflectionDatabase,
      { sourceRepository: this.sourceRepository }
    );
  }

  private authorityRows(accountId: string) {
    return this.memoryDatabase.prepare(`
      SELECT publication.id AS publication_id,
             publication.reflection_id,
             current.confirmation_id AS proposal_id,
             current.candidate_id AS card_id,
             publication.upload_id,
             publication.recording_date,
             publication.effective_source_origin,
             current.current_memory_id,
             memory.type AS memory_type,
             memory.title AS memory_title,
             memory.summary AS memory_summary,
             memory.importance_score,
             provenance.source_segment_id,
             evidence.quote,
             provenance.content_digest
      FROM memory_daily_reflection_publications publication
      INNER JOIN memory_daily_reflection_candidate_receipts receipt
        ON receipt.user_id = publication.user_id
        AND receipt.publication_id = publication.id
        AND receipt.status = 'admitted'
      INNER JOIN memory_daily_reflection_candidate_current_memories current
        ON current.user_id = receipt.user_id
        AND current.publication_id = receipt.publication_id
        AND current.candidate_id = receipt.candidate_id
        AND current.reflection_id = publication.reflection_id
        AND current.confirmation_id = publication.confirmation_id
        AND current.status = 'active'
      INNER JOIN memory_daily_reflection_candidate_payloads payload
        ON payload.user_id = current.user_id
        AND payload.publication_id = current.publication_id
        AND payload.reflection_id = publication.reflection_id
        AND payload.confirmation_id = current.confirmation_id
        AND payload.candidate_id = current.candidate_id
      INNER JOIN memory_items memory
        ON memory.user_id = current.user_id
        AND memory.id = current.current_memory_id
        AND memory.status = 'active'
      INNER JOIN memory_daily_reflection_evidence_provenance provenance
        ON provenance.user_id = current.user_id
        AND provenance.publication_id = current.publication_id
        AND provenance.candidate_id = current.candidate_id
        AND provenance.reflection_id = publication.reflection_id
        AND provenance.confirmation_id = current.confirmation_id
        AND provenance.upload_id = publication.upload_id
        AND provenance.source_origin = publication.effective_source_origin
      INNER JOIN memory_evidence evidence
        ON evidence.id = provenance.memory_evidence_id
        AND evidence.memory_id = current.current_memory_id
        AND evidence.upload_id = publication.upload_id
        AND evidence.source_id = provenance.source_segment_id
      LEFT JOIN memory_daily_reflection_candidate_revocations revocation
        ON revocation.user_id = current.user_id
        AND revocation.publication_id = current.publication_id
        AND revocation.candidate_id = current.candidate_id
      WHERE publication.user_id = ?
        AND publication.status = 'published'
        AND publication.recording_date IS NOT NULL
        AND publication.effective_source_origin IN (
          'user_reflection', 'direct_conversation'
        )
        AND revocation.id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM memory_upload_tombstones tombstone
          WHERE tombstone.user_id = publication.user_id
            AND tombstone.upload_id = publication.upload_id
        )
      ORDER BY publication.recording_date DESC, current.candidate_id,
               provenance.source_segment_id
    `).all(accountId) as AuthorityRow[];
  }

  private proposalRevoked(accountId: string, proposalId: string) {
    return Boolean(this.dailyReflectionDatabase.prepare(`
      SELECT 1 FROM dr_memory_proposal_events
      WHERE account_id = ? AND proposal_id = ? AND event_type = 'revoked'
    `).get(accountId, proposalId));
  }

  private legacyCardConfirmed(
    accountId: string,
    reflectionId: string,
    cardId: string
  ) {
    try {
      const confirmation = this.sourceRepository.getConfirmation(
        accountId,
        reflectionId
      );
      return Boolean(confirmation?.candidateSnapshots.some((snapshot) => (
        snapshot.candidateId === cardId && snapshot.status === "kept"
      )));
    } catch {
      return false;
    }
  }

  private resolveAdmittedGroup(accountId: string, rows: AuthorityRow[]) {
    const first = rows[0];
    if (!first) return null;
    try {
      const { card, evidence } = this.sourceRepository.getWorkingCardWithEvidence(
        accountId,
        first.card_id
      );
      const reflectionInput = this.sourceRepository.getReflectionV2Input(
        accountId,
        first.reflection_id
      );
      const plan = this.sourceRepository.getProcessingPlan(
        accountId,
        first.reflection_id
      );
      if (
        card.sourceUnavailable
        || !["saved", "archived"].includes(card.status)
        || card.memoryLifecycleStatus !== "active"
        || !card.sourceReflectionIds.includes(first.reflection_id)
        || evidence.length === 0
        || !reflectionInput
        || reflectionInput.recordingDate !== first.recording_date
        || !plan
        || plan.uploadId !== first.upload_id
        || plan.sourceOrigin !== first.effective_source_origin
        || rows.some((row) => (
          row.current_memory_id !== first.current_memory_id
          || row.reflection_id !== first.reflection_id
          || row.upload_id !== first.upload_id
          || row.recording_date !== first.recording_date
          || row.effective_source_origin !== first.effective_source_origin
        ))
      ) {
        return null;
      }
      const proposal = this.proposalRepository.getByCard(accountId, card.id);
      if (proposal) {
        if (
          proposal.id !== first.proposal_id
          || proposal.status !== "admitted"
          || proposal.memoryId !== first.current_memory_id
          || proposal.cardId !== card.id
          || proposal.reflectionId !== first.reflection_id
          || proposal.recordingDate !== first.recording_date
          || !exactSet(proposal.evidenceIds, card.evidenceIds)
          || this.proposalRevoked(accountId, proposal.id)
        ) {
          return null;
        }
      }
      const rowBySegment = new Map(rows.map((row) => [row.source_segment_id, row]));
      if (
        rowBySegment.size !== rows.length
        || !exactSet(card.evidenceIds, [...rowBySegment.keys()])
      ) {
        return null;
      }
      const returnEvidence = evidence.map((item) => {
        const row = rowBySegment.get(item.sourceSegmentId);
        if (
          !row
          || item.uploadId !== first.upload_id
          || item.effectiveOrigin !== first.effective_source_origin
          || row.quote !== item.text.slice(0, 4_000)
          || row.content_digest !== digest({
            version: 1,
            accountId,
            reflectionId: first.reflection_id,
            uploadId: first.upload_id,
            sourceSegmentId: item.sourceSegmentId,
            quote: row.quote,
            sourceOrigin: first.effective_source_origin
          })
        ) {
          throw new Error("daily_reflection_return_provenance_invalid");
        }
        return {
          reflectionId: first.reflection_id,
          cardId: card.id,
          recordingDate: first.recording_date,
          sourceOrigin: first.effective_source_origin,
          sourceSegmentId: item.sourceSegmentId,
          startSeconds: item.startSeconds,
          endSeconds: item.endSeconds,
          snippet: item.text.trim().slice(0, 320)
        } satisfies DailyReflectionReturnEvidence;
      });
      const reflectionCard = this.sourceRepository
        .listReflectionCards(accountId, first.reflection_id)
        .find((item) => item.id === card.id);
      if (
        !proposal
        && (
          reflectionCard?.reviewStatus !== "kept"
          || !this.legacyCardConfirmed(
            accountId,
            first.reflection_id,
            card.id
          )
        )
      ) {
        return null;
      }
      const epistemicStatus = proposal?.epistemicStatus
        ?? reflectionCard?.epistemicStatus;
      const memoryType = proposalMemoryType(proposal, first);
      if (!epistemicStatus || !memoryType) return null;
      return {
        memoryId: first.current_memory_id,
        cardId: card.id,
        reflectionId: first.reflection_id,
        recordingDate: first.recording_date,
        memoryType,
        cardKind: proposal?.cardKind
          ?? workingCardKindForReflectionCard(reflectionCard!.cardKind),
        actionClaimed: proposal?.actionClaimed
          ?? Boolean(reflectionCard?.cardKind === "user_action"
            && reflectionCard.actionClaimed),
        subjectPersonId: proposal?.subjectPersonId ?? null,
        epistemicStatus,
        epistemicCaution: proposal?.epistemicCaution ?? null,
        riskFlags: [...(proposal?.riskFlags ?? reflectionCard!.riskFlags)].sort(),
        title: proposal?.title
          ?? (reflectionCard!.userTitle ?? reflectionCard!.proposedTitle),
        content: proposal?.content
          ?? (reflectionCard!.userText ?? reflectionCard!.proposedText),
        importance: first.importance_score,
        evidence: returnEvidence
      } satisfies DailyReflectionAdmittedReturnSource;
    } catch {
      return null;
    }
  }

  private admitted(accountId: string, rows: AuthorityRow[]) {
    const grouped = new Map<string, AuthorityRow[]>();
    for (const row of rows) {
      const key = `${row.publication_id}\u0000${row.card_id}`;
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return [...grouped.values()]
      .map((rows) => this.resolveAdmittedGroup(accountId, rows))
      .filter((source): source is DailyReflectionAdmittedReturnSource => Boolean(source));
  }

  private dailyReflectionAuthorityToken(accountId: string, rows: AuthorityRow[]) {
    try {
      const sources = [...new Map(rows.map((row) => [
        `${row.reflection_id}\u0000${row.card_id}`,
        { reflectionId: row.reflection_id, cardId: row.card_id }
      ])).values()].sort((left, right) => (
        left.reflectionId.localeCompare(right.reflectionId)
        || left.cardId.localeCompare(right.cardId)
      ));
      return digest(sources.map((source) => {
        const card = this.sourceRepository.getWorkingCard(accountId, source.cardId);
        const proposal = this.proposalRepository.getByCard(accountId, source.cardId);
        const reflectionCard = this.sourceRepository
          .listReflectionCards(accountId, source.reflectionId)
          .find((item) => item.id === source.cardId);
        const confirmation = this.sourceRepository.getConfirmation(
          accountId,
          source.reflectionId
        );
        const confirmationCard = confirmation?.candidateSnapshots.find(
          (item) => item.candidateId === source.cardId
        );
        return {
          source,
          card: {
            status: card.status,
            sourceUnavailable: card.sourceUnavailable,
            memoryLifecycleStatus: card.memoryLifecycleStatus,
            memoryLifecycleVersion: card.memoryLifecycleVersion,
            version: card.version,
            sourceReflectionIds: card.sourceReflectionIds,
            evidenceIds: card.evidenceIds
          },
          proposal: proposal ? {
            id: proposal.id,
            reflectionId: proposal.reflectionId,
            status: proposal.status,
            version: proposal.version,
            memoryId: proposal.memoryId,
            evidenceIds: proposal.evidenceIds,
            revoked: this.proposalRevoked(accountId, proposal.id)
          } : null,
          reflectionCard: reflectionCard ? {
            reviewStatus: reflectionCard.reviewStatus,
            version: reflectionCard.version,
            actionClaimed: reflectionCard.actionClaimed,
            epistemicStatus: reflectionCard.epistemicStatus,
            evidenceIds: reflectionCard.evidenceIds
          } : null,
          confirmation: confirmation ? {
            id: confirmation.id,
            fingerprint: confirmation.fingerprint,
            status: confirmationCard?.status ?? null,
            sourceSegmentIds: confirmationCard?.sourceSegmentIds ?? []
          } : null
        };
      }));
    } catch {
      return null;
    }
  }

  private groundedCards(accountId: string, startDate: string, endDate: string) {
    const cards = [] as ReturnType<DailyReflectionRepository["listWorkingCards"]>["cards"];
    let offset = 0;
    let total = 0;
    do {
      const page = this.sourceRepository.listWorkingCards({
        accountId,
        status: "saved",
        sort: "created_asc",
        limit: 100,
        offset
      });
      total = page.total;
      if (total > 1_000 || page.offset !== offset || page.cards.length > page.limit) {
        return [];
      }
      cards.push(...page.cards);
      offset += page.cards.length;
      if (page.cards.length === 0 && offset < total) return [];
    } while (offset < total);
    if (cards.length !== total || new Set(cards.map((card) => card.id)).size !== total) {
      return [];
    }
    return cards.flatMap((summary): DailyReflectionGroundedCardSource[] => {
      try {
        const detail = this.sourceRepository.getWorkingCardWithEvidence(
          accountId,
          summary.id
        );
        if (
          detail.card.id !== summary.id
          || detail.card.accountId !== accountId
          || detail.card.cardKind !== summary.cardKind
          || detail.card.status !== "saved"
          || detail.card.sourceUnavailable
          || detail.evidence.length === 0
          || detail.card.memoryLifecycleStatus === "revocation_requested"
          || detail.card.memoryLifecycleStatus === "revoked"
        ) {
          return [];
        }
        const sourceByUpload = new Map<string, {
          reflectionId: string;
          recordingDate: string;
          sourceOrigin: "user_reflection" | "direct_conversation";
          epistemicStatus: DailyReflectionMemoryProposal["epistemicStatus"];
          riskFlags: ReflectionCard["riskFlags"];
        }>();
        for (const reflectionId of detail.card.sourceReflectionIds) {
          const input = this.sourceRepository.getReflectionV2Input(accountId, reflectionId);
          const plan = this.sourceRepository.getProcessingPlan(accountId, reflectionId);
          const card = this.sourceRepository.listReflectionCards(accountId, reflectionId)
            .find((item) => item.id === detail.card.id);
          if (
            !input
            || !plan
            || !card
            || input.recordingDate < startDate
            || input.recordingDate > endDate
            || (plan.sourceOrigin !== "user_reflection"
              && plan.sourceOrigin !== "direct_conversation")
          ) {
            return [];
          }
          sourceByUpload.set(plan.uploadId, {
            reflectionId,
            recordingDate: input.recordingDate,
            sourceOrigin: plan.sourceOrigin,
            epistemicStatus: card.epistemicStatus,
            riskFlags: card.riskFlags
          });
        }
        const evidence = detail.evidence.map((item) => {
          const source = sourceByUpload.get(item.uploadId);
          if (!source || source.sourceOrigin !== item.effectiveOrigin) {
            throw new Error("daily_reflection_return_card_source_invalid");
          }
          return {
            reflectionId: source.reflectionId,
            cardId: detail.card.id,
            recordingDate: source.recordingDate,
            sourceOrigin: source.sourceOrigin,
            sourceSegmentId: item.sourceSegmentId,
            startSeconds: item.startSeconds,
            endSeconds: item.endSeconds,
            snippet: item.text.trim().slice(0, 320)
          } satisfies DailyReflectionReturnEvidence;
        });
        if (!exactSet(detail.card.evidenceIds, evidence.map((item) => item.sourceSegmentId))) {
          return [];
        }
        const epistemicStatuses = [...new Set(
          [...sourceByUpload.values()].map((item) => item.epistemicStatus)
        )].sort();
        const riskFlags = [...new Set(
          [...sourceByUpload.values()].flatMap((item) => item.riskFlags)
        )].sort();
        if (epistemicStatuses.some(
          (status) => status === "ai_inference" || status === "unknown"
        )) {
          return [];
        }
        return [{
          cardId: detail.card.id,
          reflectionIds: [...new Set(evidence.map((item) => item.reflectionId))].sort(),
          recordingDates: [...new Set(evidence.map((item) => item.recordingDate))].sort(),
          cardKind: summary.cardKind,
          epistemicStatuses,
          riskFlags,
          title: detail.card.title,
          content: detail.card.content,
          importance: detail.card.importance,
          relatedCardIds: [...detail.card.relatedCardIds].sort(),
          tags: [...detail.card.tags].sort(),
          evidence
        }];
      } catch {
        return [];
      }
    });
  }

  private relationRows(accountId: string) {
    return this.memoryDatabase.prepare(`
      SELECT relation.source_memory_id, relation.target_memory_id,
             relation.relation_type, relation.confidence
      FROM memory_relations relation
      INNER JOIN memory_items source ON source.id = relation.source_memory_id
      INNER JOIN memory_items target ON target.id = relation.target_memory_id
      WHERE source.user_id = ? AND target.user_id = ?
      ORDER BY relation.created_at, relation.id
    `).all(accountId, accountId) as RelationRow[];
  }

  snapshot(accountId: string, startDate: string, endDate: string) {
    const before = this.authorityRows(accountId);
    const dailyReflectionBefore = this.dailyReflectionAuthorityToken(accountId, before);
    const admittedProjection = this.admitted(accountId, before);
    const workingCardsBefore = this.groundedCards(accountId, startDate, endDate);
    const activeProjectionMemoryIds = new Set(
      admittedProjection.map((source) => source.memoryId)
    );
    const relationRows = this.relationRows(accountId)
      .filter((row) => activeProjectionMemoryIds.has(row.source_memory_id)
        && activeProjectionMemoryIds.has(row.target_memory_id));
    const after = this.authorityRows(accountId);
    const dailyReflectionAfter = this.dailyReflectionAuthorityToken(accountId, after);
    const workingCardsAfter = this.groundedCards(accountId, startDate, endDate);
    const relationRowsAfter = this.relationRows(accountId)
      .filter((row) => activeProjectionMemoryIds.has(row.source_memory_id)
        && activeProjectionMemoryIds.has(row.target_memory_id));
    const authorityStable = dailyReflectionBefore !== null
      && dailyReflectionBefore === dailyReflectionAfter
      && digest(before) === digest(after)
      && digest(workingCardsBefore) === digest(workingCardsAfter)
      && digest(relationRows) === digest(relationRowsAfter);
    const admitted = (authorityStable ? admittedProjection : []).filter(
      (source) => source.recordingDate >= startDate && source.recordingDate <= endDate
    );
    const activeMemoryIds = new Set(admitted.map((source) => source.memoryId));
    const relations = (authorityStable ? relationRows : [])
      .filter((row) => activeMemoryIds.has(row.source_memory_id)
        && activeMemoryIds.has(row.target_memory_id))
      .map((row) => ({
        sourceMemoryId: row.source_memory_id,
        targetMemoryId: row.target_memory_id,
        relationType: row.relation_type,
        confidence: row.confidence
      }));
    const workingCards = authorityStable ? workingCardsBefore : [];
    const emergingCards = workingCards.filter(
      (card): card is DailyReflectionEmergingCardSource => (
        card.cardKind === "idea" || card.cardKind === "insight"
      )
    );
    return {
      admitted,
      workingCards,
      emergingCards,
      relations
    } satisfies DailyReflectionReturnSourceSnapshot;
  }
}

export function createDailyReflectionReturnSourceRepository(
  memoryDatabase: Database.Database,
  dailyReflectionDatabase: Database.Database,
  dependencies: { sourceRepository?: DailyReflectionRepository } = {}
) {
  return new DailyReflectionReturnSourceRepository(
    memoryDatabase,
    dailyReflectionDatabase,
    dependencies
  );
}

export function getDailyReflectionReturnSourceRepository() {
  return createDailyReflectionReturnSourceRepository(
    getMemoryDatabase(),
    getDailyReflectionDatabase()
  );
}

import type Database from "better-sqlite3";

import type {
  AskWorkWeeklyQaRequest,
  CreateWorkWeeklyUserNoteRequest,
  GenerateWorkWeeklyReviewRequest,
  RegenerateWorkWeeklyReviewRequest,
  UpdateWorkWeeklyItemRequest,
  WorkWeeklyScopeRequest,
  WorkWeeklyVersionedOperationRequest
} from "@/lib/domain/work-weekly";

import { WorkWeeklyConflictError, WorkWeeklyRepository } from "./weekly-repository";
import {
  buildWorkWeeklySourceSnapshot,
  buildWorkWeeklySourceSnapshotWithinTransaction,
  deriveWorkWeeklyScope,
  type WorkWeeklySourceCapacity
} from "./weekly-source-builder";

type Options = {
  now?: () => Date;
  idFactory?: () => string;
  capacity?: Partial<WorkWeeklySourceCapacity>;
};

export class WorkWeeklyService {
  private readonly repository: WorkWeeklyRepository;
  private readonly now: () => Date;
  private readonly capacity?: Partial<WorkWeeklySourceCapacity>;

  constructor(private readonly database: Database.Database, options: Options = {}) {
    this.now = options.now ?? (() => new Date());
    this.capacity = options.capacity;
    this.repository = new WorkWeeklyRepository(database, {
      now: () => this.now().toISOString(),
      idFactory: options.idFactory,
      currentSnapshotBuilder: (input) => buildWorkWeeklySourceSnapshotWithinTransaction({
        database: this.database,
        accountId: input.accountId,
        scope: {
          weekStart: input.scope.weekStart,
          timeZone: input.scope.timeZone,
          scopeKind: input.scope.scopeKind,
          projectId: input.scope.projectId
        },
        now: input.now,
        capacity: this.capacity
      })
    });
  }

  buildSnapshot(accountId: string, scope: WorkWeeklyScopeRequest, now = this.now()) {
    return buildWorkWeeklySourceSnapshot({
      database: this.database,
      accountId,
      scope,
      now,
      capacity: this.capacity
    });
  }

  private snapshotForReview(accountId: string, reviewId: string) {
    const review = this.repository.getReview(accountId, reviewId);
    const now = this.now();
    return this.buildSnapshot(accountId, {
      weekStart: review.scope.weekStart,
      timeZone: review.scope.timeZone,
      scopeKind: review.scope.scopeKind,
      projectId: review.scope.projectId
    }, now);
  }

  getByScope(accountId: string, scopeRequest: WorkWeeklyScopeRequest) {
    const now = this.now();
    const scope = deriveWorkWeeklyScope(scopeRequest, now).scope;
    const existing = this.repository.getReviewByScope(accountId, scope);
    if (existing && existing.scope.timeZone !== scope.timeZone) {
      throw new WorkWeeklyConflictError("weekly_time_zone_conflict");
    }
    const snapshot = this.buildSnapshot(accountId, scopeRequest, now);
    if (!existing) return { review: null, items: [], sourceSummary: snapshot.summary,
      latestGeneration: null, displayedGeneration: null };
    this.repository.reconcileSourceValidity({
      accountId,
      reviewId: existing.id,
      snapshot
    });
    const detail = this.repository.getDetail(accountId, existing.id);
    return { ...detail, sourceSummary: snapshot.summary };
  }

  getDetail(accountId: string, reviewId: string) {
    const snapshot = this.snapshotForReview(accountId, reviewId);
    this.repository.reconcileSourceValidity({ accountId, reviewId, snapshot });
    return { ...this.repository.getDetail(accountId, reviewId), sourceSummary: snapshot.summary };
  }

  generate(accountId: string, request: GenerateWorkWeeklyReviewRequest) {
    const now = this.now();
    const snapshot = this.buildSnapshot(accountId, {
      weekStart: request.weekStart,
      timeZone: request.timeZone,
      scopeKind: request.scopeKind,
      projectId: request.projectId
    }, now);
    if (snapshot.allowlistedSourceRefs.length === 0) {
      throw new WorkWeeklyConflictError("weekly_insufficient_sources");
    }
    return this.repository.queueGeneration({
      accountId,
      snapshot,
      operationKey: request.operationKey,
      expectedVersion: request.expectedVersion ?? null,
      kind: "generate"
    });
  }

  regenerate(
    accountId: string,
    reviewId: string,
    request: RegenerateWorkWeeklyReviewRequest
  ) {
    const snapshot = this.snapshotForReview(accountId, reviewId);
    if (snapshot.allowlistedSourceRefs.length === 0) {
      throw new WorkWeeklyConflictError("weekly_insufficient_sources");
    }
    return this.repository.queueGeneration({
      accountId,
      snapshot,
      operationKey: request.operationKey,
      expectedVersion: request.expectedVersion,
      kind: "regenerate"
    });
  }

  updateItem(
    accountId: string,
    reviewId: string,
    itemId: string,
    request: UpdateWorkWeeklyItemRequest
  ) {
    return this.repository.updateItem({ accountId, reviewId, itemId, ...request });
  }

  createUserNote(
    accountId: string,
    reviewId: string,
    request: CreateWorkWeeklyUserNoteRequest
  ) {
    return this.repository.createUserNote({ accountId, reviewId, ...request });
  }

  deleteUserNote(
    accountId: string,
    reviewId: string,
    itemId: string,
    request: WorkWeeklyVersionedOperationRequest
  ) {
    return this.repository.deleteUserNote({ accountId, reviewId, itemId, ...request });
  }

  reset(
    accountId: string,
    reviewId: string,
    request: WorkWeeklyVersionedOperationRequest
  ) {
    return this.repository.resetToCurrentSystemVersion({ accountId, reviewId, ...request });
  }

  deleteReview(
    accountId: string,
    reviewId: string,
    request: WorkWeeklyVersionedOperationRequest
  ) {
    return this.repository.deleteReview({ accountId, reviewId, ...request });
  }

  getQa(accountId: string, reviewId: string) {
    this.getDetail(accountId, reviewId);
    return this.repository.getQaThread(accountId, reviewId);
  }

  askQa(
    accountId: string,
    reviewId: string,
    request: AskWorkWeeklyQaRequest
  ) {
    const snapshot = this.snapshotForReview(accountId, reviewId);
    this.repository.reconcileSourceValidity({ accountId, reviewId, snapshot });
    return this.repository.queueQuestion({ accountId, reviewId, snapshot, ...request });
  }

  clearQa(
    accountId: string,
    reviewId: string,
    request: WorkWeeklyVersionedOperationRequest
  ) {
    return this.repository.clearQaThread({ accountId, reviewId, ...request });
  }

  resolveLiveSource(accountId: string, reviewId: string, ref: string) {
    const snapshot = this.snapshotForReview(accountId, reviewId);
    const persistedCitation = this.repository.hasActiveSourceReference(accountId, reviewId, ref);
    if (!snapshot.allowlistedSourceRefs.includes(ref) && !persistedCitation) return null;
    const resolve = (candidateSnapshot: ReturnType<WorkWeeklyService["buildSnapshot"]>) => {
      const identity = candidateSnapshot.identities.find((candidate) => candidate.sourceRef === ref);
      if (!identity) return null;
      let source: unknown;
      switch (identity.sourceKind) {
        case "meeting":
          source = candidateSnapshot.meetings.find((candidate) => candidate.sourceRef === ref);
          break;
        case "finding":
          source = candidateSnapshot.findings.find((candidate) => candidate.sourceRef === ref);
          break;
        case "todo":
          source = candidateSnapshot.todos.find((candidate) => candidate.sourceRef === ref);
          break;
        case "todo_event":
          source = candidateSnapshot.todoEvents.find((candidate) => candidate.sourceRef === ref);
          break;
        case "evidence":
          source = candidateSnapshot.evidence.find((candidate) => candidate.sourceRef === ref);
          break;
        case "project":
          source = candidateSnapshot.projects.find((candidate) => candidate.id === identity.sourceId);
          break;
      }
      return source ? { identity, source } : null;
    };
    const current = resolve(snapshot);
    if (current || !persistedCitation) return current;
    const review = this.repository.getReview(accountId, reviewId);
    const expanded = buildWorkWeeklySourceSnapshot({
      database: this.database,
      accountId,
      scope: {
        weekStart: review.scope.weekStart,
        timeZone: review.scope.timeZone,
        scopeKind: review.scope.scopeKind,
        projectId: review.scope.projectId
      },
      now: this.now(),
      capacity: {
        maxSemanticUnits: Number.MAX_SAFE_INTEGER,
        maxUtf8Bytes: Number.MAX_SAFE_INTEGER,
        maxEvidenceSegments: Number.MAX_SAFE_INTEGER
      }
    });
    return resolve(expanded);
  }

  runtimeRepository() {
    return this.repository;
  }
}

export function createWorkWeeklyService(database: Database.Database, options?: Options) {
  return new WorkWeeklyService(database, options);
}

import type Database from "better-sqlite3";

import {
  WorkMeetingFollowUpDraftSchema,
  WorkMeetingFollowUpSourceStatsSchema,
  type WorkMeetingFollowUpDraft,
  type WorkMeetingFollowUpSourceStats
} from "@/lib/domain/work-follow-up";
import {
  WORK_REVIEW_CONTRACT_VERSION,
  WorkMeetingCandidateStructuredDataSchema,
  WorkMeetingFindingSchema
} from "@/lib/domain/work-review";

import { buildWorkMeetingFollowUpContent } from "./follow-up-content";
import {
  WorkMeetingFollowUpRepository,
  type WorkMeetingFollowUpDraftRecord
} from "./follow-up-repository";
import { WorkReviewConflictError, WorkReviewRepository } from "./repository";
import { resolveWorkReviewFeatureFlags, type WorkReviewFeatureFlags } from "./runtime-config";
import { WorkTodoRepository } from "./todo-repository";

export type WorkMeetingFollowUpResult = {
  draft: WorkMeetingFollowUpDraft | null;
  sourceStats: WorkMeetingFollowUpSourceStats;
};

type FollowUpServiceDependencies = {
  workRepository?: WorkReviewRepository;
  todoRepository?: WorkTodoRepository;
  followUpRepository?: WorkMeetingFollowUpRepository;
  resolveFeatureFlags?: () => WorkReviewFeatureFlags;
};

export class WorkMeetingFollowUpService {
  private readonly database: Database.Database;
  private readonly workRepository: WorkReviewRepository;
  private readonly todoRepository: WorkTodoRepository;
  private readonly followUpRepository: WorkMeetingFollowUpRepository;
  private readonly resolveFeatureFlags: () => WorkReviewFeatureFlags;

  constructor(database: Database.Database, dependencies: FollowUpServiceDependencies = {}) {
    this.database = database;
    this.workRepository = dependencies.workRepository ?? new WorkReviewRepository(database);
    this.todoRepository = dependencies.todoRepository ?? new WorkTodoRepository(database);
    this.followUpRepository = dependencies.followUpRepository
      ?? new WorkMeetingFollowUpRepository(database);
    this.resolveFeatureFlags = dependencies.resolveFeatureFlags ?? resolveWorkReviewFeatureFlags;
  }

  private currentContent(accountId: string, meetingId: string) {
    const detail = this.workRepository.getMeetingDetail(accountId, meetingId);
    const meeting = detail.meeting;
    if (meeting.reviewStatus !== "completed"
      || meeting.reviewCompletedAt === null
      || meeting.canonicalPublicationId === null
      || meeting.canonicalContentDigest === null) {
      throw new WorkReviewConflictError("work_review_follow_up_review_incomplete");
    }
    const findings = detail.findings.map((finding) => WorkMeetingFindingSchema.parse({
      contractVersion: WORK_REVIEW_CONTRACT_VERSION,
      ...finding,
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse(finding.structuredData)
    }));
    const flags = this.resolveFeatureFlags();
    const todos = flags.todoEnabled
      ? this.todoRepository.listMeetingTodos(accountId, meetingId)
      : [];
    return buildWorkMeetingFollowUpContent({
      meeting: {
        id: meeting.id,
        accountId: meeting.accountId,
        title: meeting.title,
        meetingDate: meeting.meetingDate,
        reviewStatus: "completed",
        reviewCompletedAt: meeting.reviewCompletedAt,
        canonicalPublicationId: meeting.canonicalPublicationId,
        canonicalContentDigest: meeting.canonicalContentDigest
      },
      findings,
      todos
    });
  }

  private draftView(
    record: WorkMeetingFollowUpDraftRecord,
    current: ReturnType<WorkMeetingFollowUpService["currentContent"]>
  ) {
    return WorkMeetingFollowUpDraftSchema.parse({
      contractVersion: 1,
      meetingId: record.meetingId,
      accountId: record.accountId,
      bodyMarkdown: record.bodyMarkdown,
      systemSnapshotDigest: record.systemSnapshotDigest,
      currentSnapshotDigest: current.systemSnapshot.digest,
      stale: record.systemSnapshotDigest !== current.systemSnapshot.digest,
      version: record.version,
      generatedAt: record.generatedAt,
      userEditedAt: record.userEditedAt,
      updatedAt: record.updatedAt,
      copySlices: {
        full: record.bodyMarkdown,
        decisions: record.decisionsMarkdown,
        actions: record.actionsMarkdown,
        selectiveSlicesSource: "system_snapshot"
      },
      sourceStats: this.sourceStats(current)
    });
  }

  private sourceStats(current: ReturnType<WorkMeetingFollowUpService["currentContent"]>) {
    const projection = current.systemSnapshot.projection;
    return WorkMeetingFollowUpSourceStatsSchema.parse({
      findingCount: projection.findings.length,
      todoCount: projection.todos.length,
      confirmedResultCount: projection.findings.length,
      myTodoCount: projection.todos.filter((todo) => todo.kind === "self").length,
      waitingForOtherTodoCount: projection.todos.filter(
        (todo) => todo.kind === "waiting_for_other"
      ).length,
      unresolvedQuestionCount: projection.findings.filter(
        (finding) => finding.kind === "open_question"
      ).length
    });
  }

  get(accountId: string, meetingId: string): WorkMeetingFollowUpResult {
    const run = this.database.transaction(() => {
      const current = this.currentContent(accountId, meetingId);
      const record = this.followUpRepository.getDraft(accountId, meetingId);
      return {
        draft: record ? this.draftView(record, current) : null,
        sourceStats: this.sourceStats(current)
      };
    });
    return run();
  }

  generate(input: {
    accountId: string;
    meetingId: string;
    operationKey: string;
    expectedVersion: number | null;
  }) {
    const run = this.database.transaction(() => {
      const current = this.currentContent(input.accountId, input.meetingId);
      const result = this.followUpRepository.generate({
        ...input,
        bodyMarkdown: current.bodyMarkdown,
        systemSnapshotDigest: current.systemSnapshot.digest,
        decisionsMarkdown: current.copySlices.decisions.markdown,
        actionsMarkdown: current.copySlices.actions.markdown,
        sourceManifest: current.sourceManifest
      });
      return { draft: this.draftView(result.draft, current), reused: result.reused };
    });
    return run.immediate();
  }

  update(input: {
    accountId: string;
    meetingId: string;
    operationKey: string;
    expectedVersion: number;
    bodyMarkdown: string;
  }) {
    const run = this.database.transaction(() => {
      const current = this.currentContent(input.accountId, input.meetingId);
      const result = this.followUpRepository.update(input);
      return { draft: this.draftView(result.draft, current), reused: result.reused };
    });
    return run.immediate();
  }

  reset(input: {
    accountId: string;
    meetingId: string;
    operationKey: string;
    expectedVersion: number;
  }) {
    const run = this.database.transaction(() => {
      const current = this.currentContent(input.accountId, input.meetingId);
      const result = this.followUpRepository.reset(input);
      return { draft: this.draftView(result.draft, current), reused: result.reused };
    });
    return run.immediate();
  }
}

export function createWorkMeetingFollowUpService(
  database: Database.Database,
  dependencies: FollowUpServiceDependencies = {}
) {
  return new WorkMeetingFollowUpService(database, dependencies);
}

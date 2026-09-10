import {
  WorkWeeklySourceSnapshotSchema,
  type WorkWeeklySourceSnapshot
} from "@/lib/domain/work-weekly";

import type {
  WorkWeeklyProviderProfile,
  WorkWeeklyProviderRole
} from "./weekly-ai-provider";

const digest = (character: string) => character.repeat(64);

const refs = {
  meeting: "work:meeting:meeting_a",
  decision: "work:finding:decision",
  proposal: "work:finding:proposal",
  assignment: "work:finding:assignment",
  commitment: "work:finding:commitment",
  dated: "work:finding:dated",
  evidenceDecision: "work:evidence:decision",
  evidenceProposal: "work:evidence:proposal",
  evidenceAssignment: "work:evidence:assignment",
  evidenceCommitment: "work:evidence:commitment",
  evidenceDated: "work:evidence:dated",
  todo: "work:todo:todo_a",
  todoCompleted: "work:todo_event:completed"
} as const;

const timestamp = "2026-09-03T08:00:00.000Z";

function evidence(
  sourceRef: string,
  segmentId: string,
  startSeconds: number,
  text: string
) {
  return {
    sourceRef,
    publicationId: "publication_a",
    publicationDigest: digest("c"),
    meetingId: "meeting_a",
    segmentId,
    startSeconds,
    endSeconds: startSeconds + 5,
    rawSpeakerLabel: "Speaker 1",
    timestampQuality: "provider_exact" as const,
    text
  };
}

function finding(input: {
  sourceRef: string;
  id: string;
  kind: "proposal" | "decision" | "commitment" | "action_item";
  title: string;
  body: string;
  evidenceRef: string;
  structuredData?: Record<string, unknown>;
}) {
  return {
    sourceRef: input.sourceRef,
    id: input.id,
    meetingId: "meeting_a",
    version: 1,
    kind: input.kind,
    title: input.title,
    body: input.body,
    structuredData: {
      decisionFinality: null,
      rawActorLabel: null,
      candidateOwner: null,
      dueAt: null,
      originalDueExpression: null,
      actionBasis: null,
      relatedCommitmentCandidateId: null,
      planStages: [],
      ...input.structuredData
    },
    userConfirmedAt: timestamp,
    userEditedAt: null,
    evidenceRefs: [input.evidenceRef]
  };
}

export function workWeeklyTestSnapshot(): WorkWeeklySourceSnapshot {
  const snapshot = {
    contractVersion: 1 as const,
    accountId: "account_a",
    scope: {
      weekStart: "2026-08-31",
      weekEnd: "2026-09-06",
      observedThrough: "2026-09-03",
      windowComplete: false,
      timeZone: "Asia/Shanghai",
      scopeKind: "all" as const,
      projectId: null
    },
    digest: digest("a"),
    inputPackDigest: digest("b"),
    createdAt: timestamp,
    summary: {
      meetingCount: 1,
      findingCount: 5,
      todoCount: 1,
      todoEventCount: 1,
      evidenceCount: 5,
      projectCount: 0,
      pendingCandidateCount: 0,
      includedFindingCount: 5,
      includedTodoCount: 1,
      includedTodoEventCount: 1,
      includedEvidenceCount: 5,
      omittedFindingCount: 0,
      omittedTodoCount: 0,
      omittedTodoEventCount: 0,
      omittedEvidenceCount: 0,
      truncated: false,
      historyCompleteness: "exact" as const
    },
    meetings: [{
      sourceRef: refs.meeting,
      id: "meeting_a",
      version: 1,
      title: "产品发布讨论",
      meetingDate: "2026-09-01",
      reviewStatus: "completed" as const,
      pendingCandidateCount: 0,
      canonicalPublicationId: "publication_a",
      canonicalContentDigest: digest("c"),
      projects: []
    }],
    findings: [
      finding({
        sourceRef: refs.decision,
        id: "decision",
        kind: "decision",
        title: "选择方案 B",
        body: "最终决定采用方案 B",
        evidenceRef: refs.evidenceDecision,
        structuredData: { decisionFinality: "final" }
      }),
      finding({
        sourceRef: refs.proposal,
        id: "proposal",
        kind: "proposal",
        title: "考虑方案 C",
        body: "有人提议采用方案 C",
        evidenceRef: refs.evidenceProposal
      }),
      finding({
        sourceRef: refs.assignment,
        id: "assignment",
        kind: "action_item",
        title: "Alex 跟进",
        body: "会议中把事项分配给 Alex，但没有接受表达",
        evidenceRef: refs.evidenceAssignment,
        structuredData: { actionBasis: "assignment_without_acceptance", candidateOwner: "Alex" }
      }),
      finding({
        sourceRef: refs.commitment,
        id: "commitment",
        kind: "commitment",
        title: "Sam 承诺检查发布清单",
        body: "Sam 明确接受在发布前检查清单",
        evidenceRef: refs.evidenceCommitment,
        structuredData: { actionBasis: "explicit_commitment", candidateOwner: "Sam" }
      }),
      finding({
        sourceRef: refs.dated,
        id: "dated",
        kind: "action_item",
        title: "文档提到 9 月 5 日",
        body: "记录中出现日期，但没有截止语义",
        evidenceRef: refs.evidenceDated
      })
    ],
    todos: [{
      sourceRef: refs.todo,
      id: "todo_a",
      version: 2,
      current: {
        title: "整理发布清单",
        kind: "self" as const,
        status: "completed" as const,
        ownerLabel: null,
        currentDueDate: "2026-09-05",
        completedAt: timestamp,
        deletedAt: null,
        version: 2
      },
      stateAtWeekEnd: {
        title: "整理发布清单",
        kind: "self" as const,
        status: "completed" as const,
        ownerLabel: null,
        currentDueDate: "2026-09-05",
        completedAt: timestamp,
        deletedAt: null,
        version: 2
      },
      historyCompleteness: "exact" as const,
      sourceMeetingId: "meeting_a",
      sourceFindingId: "commitment",
      sourceFindingKind: "commitment" as const,
      projects: []
    }],
    todoEvents: [{
      sourceRef: refs.todoCompleted,
      id: "todo_event_completed",
      todoId: "todo_a",
      eventType: "todo.completed" as const,
      changedFields: ["status", "completedAt"],
      occurredAt: timestamp,
      localDate: "2026-09-03",
      oldVersion: 1,
      newVersion: 2,
      stateAfter: {
        title: "整理发布清单",
        kind: "self" as const,
        status: "completed" as const,
        ownerLabel: null,
        currentDueDate: "2026-09-05",
        completedAt: timestamp,
        deletedAt: null,
        version: 2
      },
      historyCompleteness: "exact" as const
    }],
    projects: [],
    evidence: [
      evidence(refs.evidenceDecision, "segment_decision", 10, "因为容量风险，所以最终选择方案 B。"),
      evidence(refs.evidenceProposal, "segment_proposal", 20, "可以考虑方案 C。"),
      evidence(refs.evidenceAssignment, "segment_assignment", 30, "这个事项请 Alex 跟进。"),
      evidence(refs.evidenceCommitment, "segment_commitment", 40, "Sam 说：我会在发布前检查清单。"),
      evidence(refs.evidenceDated, "segment_dated", 50, "文档里写了 9 月 5 日。")
    ],
    identities: [] as WorkWeeklySourceSnapshot["identities"],
    allowlistedSourceRefs: [] as string[]
  };
  snapshot.identities = [
    { sourceRef: refs.meeting, sourceKind: "meeting", sourceId: "meeting_a", version: 1, digest: digest("c"), publicationId: "publication_a", segmentId: null, included: true },
    ...snapshot.findings.map((item) => ({ sourceRef: item.sourceRef, sourceKind: "finding" as const, sourceId: item.id, version: item.version, digest: digest("d"), publicationId: null, segmentId: null, included: true })),
    { sourceRef: refs.todo, sourceKind: "todo", sourceId: "todo_a", version: 2, digest: digest("e"), publicationId: null, segmentId: null, included: true },
    { sourceRef: refs.todoCompleted, sourceKind: "todo_event", sourceId: "todo_event_completed", version: 2, digest: digest("f"), publicationId: null, segmentId: null, included: true },
    ...snapshot.evidence.map((item) => ({ sourceRef: item.sourceRef, sourceKind: "evidence" as const, sourceId: item.segmentId, version: null, digest: item.publicationDigest, publicationId: item.publicationId, segmentId: item.segmentId, included: true }))
  ];
  snapshot.allowlistedSourceRefs = snapshot.identities.map((identity) => identity.sourceRef).sort();
  return WorkWeeklySourceSnapshotSchema.parse(snapshot);
}

export function emptyWorkWeeklyTestSnapshot(): WorkWeeklySourceSnapshot {
  const snapshot = workWeeklyTestSnapshot();
  return WorkWeeklySourceSnapshotSchema.parse({
    ...snapshot,
    meetings: [],
    findings: [],
    todos: [],
    todoEvents: [],
    evidence: [],
    identities: [],
    allowlistedSourceRefs: [],
    summary: {
      ...snapshot.summary,
      meetingCount: 0,
      findingCount: 0,
      todoCount: 0,
      todoEventCount: 0,
      evidenceCount: 0,
      includedFindingCount: 0,
      includedTodoCount: 0,
      includedTodoEventCount: 0,
      includedEvidenceCount: 0
    }
  });
}

export function workWeeklyProfile(role: WorkWeeklyProviderRole): WorkWeeklyProviderProfile {
  return {
    id: `test_${role}`,
    role,
    provider: "openai_compatible",
    model: "fixture-model-never-called-remotely",
    reasoningEffort: "low",
    timeoutMs: 1_000,
    maxOutputTokens: 2_000,
    promptVersion: `test_${role}_prompt_v1`,
    schemaVersion: `test_${role}_schema_v1`
  };
}

export { refs as WORK_WEEKLY_TEST_REFS };

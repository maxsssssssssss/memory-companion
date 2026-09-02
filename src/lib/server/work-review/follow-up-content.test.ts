import { describe, expect, it } from "vitest";

import {
  WORK_REVIEW_CONTRACT_VERSION,
  type WorkMeetingCandidateKind,
  type WorkMeetingFinding
} from "@/lib/domain/work-review";
import {
  WORK_TODO_CONTRACT_VERSION,
  type WorkTodo
} from "@/lib/domain/work-todo";

import {
  buildWorkMeetingFollowUpContent,
  canonicalizeWorkMeetingFollowUpSnapshot,
  digestWorkMeetingFollowUpSnapshot,
  projectWorkMeetingFollowUpSnapshot
} from "./follow-up-content";

const now = "2026-09-02T08:00:00.000Z";
const canonicalDigest = "a".repeat(64);

function finding(input: {
  id: string;
  kind: WorkMeetingCandidateKind;
  title: string;
  body?: string;
  decisionFinality?: "final" | "tentative" | "unclear" | null;
  planStages?: WorkMeetingFinding["structuredData"]["planStages"];
  accountId?: string;
  meetingId?: string;
  publicationId?: string;
}): WorkMeetingFinding {
  return {
    contractVersion: WORK_REVIEW_CONTRACT_VERSION,
    id: input.id,
    accountId: input.accountId ?? "account_a",
    meetingId: input.meetingId ?? "meeting_a",
    sourceCandidateId: `candidate_${input.id}`,
    kind: input.kind,
    title: input.title,
    body: input.body ?? input.title,
    structuredData: {
      decisionFinality: input.decisionFinality ?? null,
      rawActorLabel: null,
      candidateOwner: null,
      dueAt: null,
      originalDueExpression: null,
      actionBasis: null,
      relatedCommitmentCandidateId: null,
      planStages: input.planStages ?? []
    },
    evidenceRefs: [{
      publicationId: input.publicationId ?? "publication_a",
      segmentId: `segment_${input.id}`,
      startSeconds: 10,
      endSeconds: 20,
      rawSpeakerLabel: "Speaker 1",
      timestampQuality: "provider_exact"
    }],
    userConfirmedAt: now,
    userEditedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}

function todo(input: {
  id: string;
  sourceFindingId: string;
  sourceFindingKind: "action_item" | "commitment";
  title: string;
  kind?: "self" | "waiting_for_other";
  status?: "open" | "completed";
  ownerLabel?: string | null;
  accountId?: string;
  sourceMeetingId?: string | null;
  origin?: "manual" | "meeting_finding" | "detached_meeting_finding";
  deletedAt?: string | null;
  currentDueDate?: string | null;
  originalDueAt?: string | null;
  originalDueExpression?: string | null;
}): WorkTodo {
  const status = input.status ?? "open";
  return {
    contractVersion: WORK_TODO_CONTRACT_VERSION,
    id: input.id,
    accountId: input.accountId ?? "account_a",
    kind: input.kind ?? "self",
    status,
    origin: input.origin ?? "meeting_finding",
    title: input.title,
    notes: null,
    ownerLabel: input.ownerLabel ?? null,
    currentDueDate: input.currentDueDate ?? null,
    isImportant: false,
    myDayDate: null,
    sourceMeetingId: input.sourceMeetingId === undefined ? "meeting_a" : input.sourceMeetingId,
    sourceFindingId: input.origin === "manual" ? null : input.sourceFindingId,
    sourceFindingVersion: input.origin === "manual" ? null : 1,
    sourceFindingKind: input.origin === "manual" ? null : input.sourceFindingKind,
    sourceOwnerLabel: null,
    sourceOriginalDueAt: input.originalDueAt ?? null,
    sourceOriginalDueExpression: input.originalDueExpression ?? null,
    sourceActionBasis: "explicit_commitment",
    sourceDetachedAt: input.origin === "detached_meeting_finding" ? now : null,
    version: 2,
    createdAt: now,
    updatedAt: now,
    completedAt: status === "completed" ? now : null,
    reopenedAt: null,
    deletedAt: input.deletedAt ?? null
  };
}

function input(overrides: Partial<Parameters<typeof buildWorkMeetingFollowUpContent>[0]> = {}) {
  return {
    meeting: {
      id: "meeting_a",
      accountId: "account_a",
      title: "季度发布会",
      meetingDate: "2026-09-01",
      reviewStatus: "completed" as const,
      reviewCompletedAt: now,
      canonicalPublicationId: "publication_a",
      canonicalContentDigest: canonicalDigest
    },
    findings: [],
    todos: [],
    ...overrides
  };
}

describe("Work Review follow-up content", () => {
  it("builds every non-empty section from confirmed Findings and linked Todos only", () => {
    const findings = [
      finding({ id: "decision_final", kind: "decision", title: "最终决定", body: "周五发布", decisionFinality: "final" }),
      finding({ id: "decision_tentative", kind: "decision", title: "暂定方向", body: "先灰度 10%", decisionFinality: "tentative" }),
      finding({ id: "action_self", kind: "action_item", title: "整理验收数据" }),
      finding({ id: "commitment_other", kind: "commitment", title: "法务复核条款" }),
      finding({ id: "question", kind: "open_question", title: "仍未解决", body: "容量上限是多少" }),
      finding({
        id: "plan",
        kind: "plan_change",
        title: "发布方案变化",
        body: "发布时间调整",
        planStages: [
          {
            id: "stage_current",
            content: "周五发布",
            status: "current",
            rawSpeakerLabel: "Speaker 1",
            evidenceRefs: [{
              publicationId: "publication_a",
              segmentId: "segment_stage_current",
              startSeconds: 40,
              endSeconds: 45,
              rawSpeakerLabel: "Speaker 1",
              timestampQuality: "provider_exact"
            }]
          },
          {
            id: "stage_initial",
            content: "周四发布",
            status: "proposed",
            rawSpeakerLabel: "Speaker 1",
            evidenceRefs: [{
              publicationId: "publication_a",
              segmentId: "segment_stage_initial",
              startSeconds: 30,
              endSeconds: 35,
              rawSpeakerLabel: "Speaker 1",
              timestampQuality: "provider_exact"
            }]
          }
        ]
      }),
      finding({ id: "discussion", kind: "discussion_topic", title: "主要讨论", body: "回滚窗口" })
    ];
    const todos = [
      todo({
        id: "todo_self",
        sourceFindingId: "action_self",
        sourceFindingKind: "action_item",
        title: "整理验收数据",
        currentDueDate: "2026-09-10",
        originalDueAt: "2026-09-08T00:00:00.000Z",
        originalDueExpression: "下周二前",
        status: "completed"
      }),
      todo({
        id: "todo_other",
        sourceFindingId: "commitment_other",
        sourceFindingKind: "commitment",
        title: "法务复核条款",
        kind: "waiting_for_other",
        ownerLabel: "法务"
      })
    ];

    const result = buildWorkMeetingFollowUpContent(input({ findings, todos }));

    expect(result.label).toBe("会后纪要草稿");
    expect(result.sections.map((section) => section.title)).toEqual([
      "最终决定",
      "暂定方向",
      "我的待办",
      "等待他人",
      "仍未解决",
      "方案变化",
      "主要讨论"
    ]);
    expect(result.bodyMarkdown).toContain("# 会后纪要草稿");
    expect(result.bodyMarkdown).toContain("会议原始截止时间：下周二前（2026-09-08）");
    expect(result.bodyMarkdown).toContain("Todo 当前计划时间：2026-09-10");
    expect(result.bodyMarkdown).toContain("Todo 当前状态：已完成（仅表示 Todo 状态，不代表会议承诺已履行）");
    expect(result.bodyMarkdown).not.toContain("承诺已经履行");
    expect(result.bodyMarkdown.indexOf("初始方案：周四发布"))
      .toBeLessThan(result.bodyMarkdown.indexOf("当前确认方案：周五发布"));
    expect(result.sourceManifest.findingIds).toEqual([
      "decision_final",
      "decision_tentative",
      "action_self",
      "commitment_other",
      "question",
      "plan",
      "discussion"
    ]);
    expect(result.sourceManifest.todoIds).toEqual(["todo_self", "todo_other"]);
    expect(result.copySlices.decisions.markdown).toContain("## 最终决定");
    expect(result.copySlices.decisions.markdown).not.toContain("## 我的待办");
    expect(result.copySlices.actions.markdown).toContain("## 我的待办");
    expect(result.copySlices.actions.markdown).toContain("## 等待他人");
    expect(result.copySlices.actions.markdown).not.toContain("## 最终决定");
    expect(result.copySlices.full.text).toBe(result.bodyText);
  });

  it("omits empty sections and returns empty decision/action slices when absent", () => {
    const result = buildWorkMeetingFollowUpContent(input({
      findings: [finding({ id: "discussion", kind: "discussion_topic", title: "讨论", body: "只讨论回滚窗口" })]
    }));

    expect(result.sections.map((section) => section.key)).toEqual(["main_discussion"]);
    expect(result.bodyMarkdown).not.toContain("## 最终决定");
    expect(result.bodyMarkdown).not.toContain("## 我的待办");
    expect(result.copySlices.decisions).toEqual({ markdown: "", text: "" });
    expect(result.copySlices.actions).toEqual({ markdown: "", text: "" });
  });

  it("keeps confirmed actions and commitments visible when the Todo gate creates no projection", () => {
    const unprojectedAction = finding({
      id: "action_unprojected",
      kind: "action_item",
      title: "整理验收数据",
      body: "汇总灰度阶段的验收结果"
    });
    const unprojectedCommitment = finding({
      id: "commitment_unprojected",
      kind: "commitment",
      title: "完成法务复核",
      body: "在发布前完成条款检查"
    });
    unprojectedCommitment.structuredData.dueAt = "2026-09-08T00:00:00.000Z";
    unprojectedCommitment.structuredData.originalDueExpression = "下周二前";

    const result = buildWorkMeetingFollowUpContent(input({
      findings: [unprojectedCommitment, unprojectedAction],
      todos: []
    }));

    expect(result.sections.map((section) => section.key)).toEqual(["confirmed_actions"]);
    expect(result.bodyMarkdown).toContain("## 会议中的行动与承诺");
    expect(result.bodyMarkdown).toContain("已确认行动项：整理验收数据");
    expect(result.bodyMarkdown).toContain("已确认会议承诺：完成法务复核");
    expect(result.bodyMarkdown).toContain("会议原始截止时间：下周二前（2026-09-08）");
    expect(result.bodyMarkdown).not.toContain("Todo 当前状态");
    expect(result.bodyMarkdown).not.toContain("Todo 当前计划时间");
    expect(result.bodyMarkdown).not.toContain("我的待办");
    expect(result.bodyMarkdown).not.toContain("等待他人");
    expect(result.copySlices.actions.markdown).toContain("## 会议中的行动与承诺");
    expect(result.copySlices.actions.text).toContain("已确认会议承诺");
    expect(result.sourceManifest.findingIds).toEqual([
      "action_unprojected",
      "commitment_unprojected"
    ]);
    expect(result.sourceManifest.todoIds).toEqual([]);
    expect(result.sourceManifest.evidence.map((source) => ({
      findingId: source.findingId,
      segmentId: source.segmentId
    }))).toEqual([
      { findingId: "action_unprojected", segmentId: "segment_action_unprojected" },
      { findingId: "commitment_unprojected", segmentId: "segment_commitment_unprojected" }
    ]);
    expect(result.systemSnapshot.projection.findings.map((source) => ({
      id: source.id,
      kind: source.kind
    }))).toEqual([
      { id: "action_unprojected", kind: "action_item" },
      { id: "commitment_unprojected", kind: "commitment" }
    ]);
  });

  it("rejects Candidate-like, cross-scope, non-canonical and non-linked sources", () => {
    const confirmed = finding({ id: "action", kind: "action_item", title: "确认行动" });
    const pendingCandidate = {
      ...confirmed,
      status: "pending_review",
      userConfirmedAt: undefined
    };
    expect(() => buildWorkMeetingFollowUpContent(input({
      findings: [pendingCandidate as unknown as WorkMeetingFinding]
    }))).toThrow();
    expect(() => buildWorkMeetingFollowUpContent(input({
      findings: [{ ...confirmed, accountId: "account_b" }]
    }))).toThrow("Finding must belong to the follow-up account and meeting");
    expect(() => buildWorkMeetingFollowUpContent(input({
      findings: [finding({
        id: "wrong_publication",
        kind: "decision",
        title: "错误来源",
        publicationId: "publication_b"
      })]
    }))).toThrow("Finding Evidence must use the meeting canonical publication");
    expect(() => buildWorkMeetingFollowUpContent(input({
      findings: [confirmed],
      todos: [todo({
        id: "manual",
        sourceFindingId: "action",
        sourceFindingKind: "action_item",
        title: "手工 Todo",
        origin: "manual",
        sourceMeetingId: null
      })]
    }))).toThrow("Todo must be an active linked Todo");
    expect(() => buildWorkMeetingFollowUpContent(input({
      findings: [confirmed],
      todos: [todo({
        id: "deleted",
        sourceFindingId: "action",
        sourceFindingKind: "action_item",
        title: "已删除 Todo",
        deletedAt: now
      })]
    }))).toThrow("Todo must be an active linked Todo");
  });

  it("keeps stable ordering, canonical projection and digest regardless of input order", () => {
    const decisionA = finding({ id: "decision_a", kind: "decision", title: "A 决定", decisionFinality: "final" });
    const decisionB = finding({ id: "decision_b", kind: "decision", title: "B 决定", decisionFinality: "final" });
    const actionA = finding({ id: "action_a", kind: "action_item", title: "A 行动" });
    const actionB = finding({ id: "action_b", kind: "commitment", title: "B 行动" });
    const todoA = todo({ id: "todo_a", sourceFindingId: "action_a", sourceFindingKind: "action_item", title: "A 行动" });
    const todoB = todo({ id: "todo_b", sourceFindingId: "action_b", sourceFindingKind: "commitment", title: "B 行动", kind: "waiting_for_other", ownerLabel: "Bob" });
    const forward = input({
      findings: [decisionB, actionB, decisionA, actionA],
      todos: [todoB, todoA]
    });
    const reversed = input({
      findings: [actionA, decisionA, actionB, decisionB],
      todos: [todoA, todoB]
    });

    const first = buildWorkMeetingFollowUpContent(forward);
    const second = buildWorkMeetingFollowUpContent(reversed);
    expect(second.bodyMarkdown).toBe(first.bodyMarkdown);
    expect(second.sourceManifest).toEqual(first.sourceManifest);
    expect(second.systemSnapshot.canonical).toBe(first.systemSnapshot.canonical);
    expect(second.systemSnapshot.digest).toBe(first.systemSnapshot.digest);
    expect(first.systemSnapshot.digest).toMatch(/^[a-f0-9]{64}$/u);

    const snapshot = projectWorkMeetingFollowUpSnapshot(forward);
    expect(canonicalizeWorkMeetingFollowUpSnapshot(snapshot)).toBe(first.systemSnapshot.canonical);
    expect(digestWorkMeetingFollowUpSnapshot(snapshot)).toBe(first.systemSnapshot.digest);
  });

  it("changes the system snapshot when current Todo state changes without rewriting meeting facts", () => {
    const action = finding({ id: "action", kind: "commitment", title: "提交报告" });
    const openTodo = todo({
      id: "todo",
      sourceFindingId: "action",
      sourceFindingKind: "commitment",
      title: "提交报告",
      originalDueExpression: "本周五前",
      currentDueDate: "2026-09-05"
    });
    const completedTodo = {
      ...openTodo,
      status: "completed" as const,
      completedAt: now,
      version: openTodo.version + 1
    };

    const before = buildWorkMeetingFollowUpContent(input({ findings: [action], todos: [openTodo] }));
    const after = buildWorkMeetingFollowUpContent(input({ findings: [action], todos: [completedTodo] }));
    expect(after.systemSnapshot.digest).not.toBe(before.systemSnapshot.digest);
    expect(after.bodyMarkdown).toContain("会议原始截止时间：本周五前");
    expect(after.bodyMarkdown).toContain("Todo 当前计划时间：2026-09-05");
    expect(after.bodyMarkdown).toContain("仅表示 Todo 状态，不代表会议承诺已履行");
    expect(after.sections.find((section) => section.key === "my_actions")?.items[0])
      .toMatchObject({ findingIds: ["action"], todoIds: ["todo"] });
  });
});

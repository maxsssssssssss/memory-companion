import { createHash } from "node:crypto";

import { z } from "zod";

import {
  WorkMeetingFindingSchema,
  WorkReviewDateSchema,
  WorkReviewIdSchema,
  WorkReviewIsoDateTimeSchema
} from "@/lib/domain/work-review";
import { WorkTodoSchema } from "@/lib/domain/work-todo";

const SNAPSHOT_VERSION = "work_review_follow_up_snapshot_v1" as const;

const FollowUpMeetingSourceSchema = z.object({
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  title: z.string().trim().min(1).max(2_000),
  meetingDate: WorkReviewDateSchema,
  reviewStatus: z.literal("completed"),
  reviewCompletedAt: WorkReviewIsoDateTimeSchema,
  canonicalPublicationId: WorkReviewIdSchema,
  canonicalContentDigest: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

export const WorkMeetingFollowUpContentInputSchema = z.object({
  meeting: FollowUpMeetingSourceSchema,
  findings: z.array(WorkMeetingFindingSchema).max(512),
  todos: z.array(WorkTodoSchema).max(512)
}).strict().superRefine((input, context) => {
  const findingIds = new Set<string>();
  for (const [index, finding] of input.findings.entries()) {
    if (findingIds.has(finding.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings", index, "id"],
        message: "Duplicate confirmed Finding"
      });
    }
    findingIds.add(finding.id);
    if (finding.accountId !== input.meeting.accountId || finding.meetingId !== input.meeting.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings", index],
        message: "Finding must belong to the follow-up account and meeting"
      });
    }
    const evidence = [
      ...finding.evidenceRefs,
      ...finding.structuredData.planStages.flatMap((stage) => stage.evidenceRefs)
    ];
    if (evidence.some((reference) =>
      reference.publicationId !== input.meeting.canonicalPublicationId
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings", index, "evidenceRefs"],
        message: "Finding Evidence must use the meeting canonical publication"
      });
    }
  }

  const findingById = new Map(input.findings.map((finding) => [finding.id, finding]));
  const todoIds = new Set<string>();
  const todoSourceIds = new Set<string>();
  for (const [index, todo] of input.todos.entries()) {
    if (todoIds.has(todo.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["todos", index, "id"],
        message: "Duplicate linked Todo"
      });
    }
    todoIds.add(todo.id);
    if (todo.accountId !== input.meeting.accountId
      || todo.sourceMeetingId !== input.meeting.id
      || todo.origin !== "meeting_finding"
      || todo.deletedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["todos", index],
        message: "Todo must be an active linked Todo for the follow-up account and meeting"
      });
    }
    const sourceFindingId = todo.sourceFindingId;
    if (sourceFindingId === null) continue;
    if (todoSourceIds.has(sourceFindingId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["todos", index, "sourceFindingId"],
        message: "Only one active Todo may use a confirmed Finding"
      });
    }
    todoSourceIds.add(sourceFindingId);
    const sourceFinding = findingById.get(sourceFindingId);
    if (!sourceFinding || sourceFinding.kind !== todo.sourceFindingKind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["todos", index, "sourceFindingId"],
        message: "Linked Todo source must be a confirmed action or commitment Finding"
      });
    }
  }
});

export type WorkMeetingFollowUpContentInput = z.infer<
  typeof WorkMeetingFollowUpContentInputSchema
>;

export type WorkMeetingFollowUpSectionKey =
  | "final_decisions"
  | "tentative_directions"
  | "confirmed_actions"
  | "my_actions"
  | "waiting_for_others"
  | "unresolved_questions"
  | "plan_changes"
  | "main_discussion";

export type WorkMeetingFollowUpSection = {
  key: WorkMeetingFollowUpSectionKey;
  title: string;
  items: Array<{
    text: string;
    findingIds: string[];
    todoIds: string[];
  }>;
};

type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortEvidence<T extends {
  publicationId: string;
  segmentId: string;
  startSeconds: number;
  endSeconds: number;
}>(evidence: T[]) {
  return [...evidence].sort((left, right) =>
    compareText(left.publicationId, right.publicationId)
    || left.startSeconds - right.startSeconds
    || left.endSeconds - right.endSeconds
    || compareText(left.segmentId, right.segmentId)
  );
}

function earliestStageSecond(stage: {
  evidenceRefs: Array<{ startSeconds: number }>;
}) {
  return Math.min(...stage.evidenceRefs.map((reference) => reference.startSeconds));
}

function sortPlanStages<T extends {
  id: string;
  evidenceRefs: Array<{ startSeconds: number }>;
}>(stages: T[]) {
  return [...stages].sort((left, right) =>
    earliestStageSecond(left) - earliestStageSecond(right)
    || compareText(left.id, right.id)
  );
}

const FINDING_KIND_ORDER = new Map([
  ["decision", 0],
  ["proposal", 1],
  ["action_item", 2],
  ["commitment", 3],
  ["open_question", 4],
  ["plan_change", 5],
  ["discussion_topic", 6]
]);

function decisionFinalityOrder(value: string | null) {
  return value === "final" ? 0 : value === "tentative" ? 1 : 2;
}

function sortFindings<T extends {
  kind: string;
  title: string;
  id: string;
  structuredData: { decisionFinality: string | null };
}>(findings: T[]) {
  return [...findings].sort((left, right) =>
    (FINDING_KIND_ORDER.get(left.kind) ?? 99) - (FINDING_KIND_ORDER.get(right.kind) ?? 99)
    || (left.kind === "decision" && right.kind === "decision"
      ? decisionFinalityOrder(left.structuredData.decisionFinality)
        - decisionFinalityOrder(right.structuredData.decisionFinality)
      : 0)
    || compareText(left.title, right.title)
    || compareText(left.id, right.id)
  );
}

function sortTodos<T extends { kind: string; title: string; id: string }>(todos: T[]) {
  return [...todos].sort((left, right) =>
    (left.kind === "self" ? 0 : 1) - (right.kind === "self" ? 0 : 1)
    || compareText(left.title, right.title)
    || compareText(left.id, right.id)
  );
}

function parseInput(input: WorkMeetingFollowUpContentInput) {
  return WorkMeetingFollowUpContentInputSchema.parse(input);
}

export function projectWorkMeetingFollowUpSnapshot(
  input: WorkMeetingFollowUpContentInput
) {
  const parsed = parseInput(input);
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    meeting: {
      id: parsed.meeting.id,
      accountId: parsed.meeting.accountId,
      title: parsed.meeting.title,
      meetingDate: parsed.meeting.meetingDate,
      reviewStatus: parsed.meeting.reviewStatus,
      reviewCompletedAt: parsed.meeting.reviewCompletedAt,
      canonicalPublicationId: parsed.meeting.canonicalPublicationId,
      canonicalContentDigest: parsed.meeting.canonicalContentDigest
    },
    findings: sortFindings(parsed.findings).map((finding) => ({
      id: finding.id,
      sourceCandidateId: finding.sourceCandidateId,
      kind: finding.kind,
      title: finding.title,
      body: finding.body,
      version: finding.version,
      userConfirmedAt: finding.userConfirmedAt,
      userEditedAt: finding.userEditedAt,
      updatedAt: finding.updatedAt,
      structuredData: {
        decisionFinality: finding.structuredData.decisionFinality,
        rawActorLabel: finding.structuredData.rawActorLabel,
        candidateOwner: finding.structuredData.candidateOwner,
        dueAt: finding.structuredData.dueAt,
        originalDueExpression: finding.structuredData.originalDueExpression,
        actionBasis: finding.structuredData.actionBasis,
        relatedCommitmentCandidateId: finding.structuredData.relatedCommitmentCandidateId,
        planStages: sortPlanStages(finding.structuredData.planStages).map((stage) => ({
          id: stage.id,
          content: stage.content,
          status: stage.status,
          rawSpeakerLabel: stage.rawSpeakerLabel,
          evidenceRefs: sortEvidence(stage.evidenceRefs).map((reference) => ({ ...reference }))
        }))
      },
      evidenceRefs: sortEvidence(finding.evidenceRefs).map((reference) => ({ ...reference }))
    })),
    todos: sortTodos(parsed.todos).map((todo) => ({
      id: todo.id,
      kind: todo.kind,
      status: todo.status,
      title: todo.title,
      notes: todo.notes,
      ownerLabel: todo.ownerLabel,
      currentDueDate: todo.currentDueDate,
      isImportant: todo.isImportant,
      myDayDate: todo.myDayDate,
      sourceMeetingId: todo.sourceMeetingId,
      sourceFindingId: todo.sourceFindingId,
      sourceFindingVersion: todo.sourceFindingVersion,
      sourceFindingKind: todo.sourceFindingKind,
      sourceOwnerLabel: todo.sourceOwnerLabel,
      sourceOriginalDueAt: todo.sourceOriginalDueAt,
      sourceOriginalDueExpression: todo.sourceOriginalDueExpression,
      sourceActionBasis: todo.sourceActionBasis,
      version: todo.version,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
      completedAt: todo.completedAt,
      reopenedAt: todo.reopenedAt
    }))
  } as const;
}

export type WorkMeetingFollowUpSnapshot = ReturnType<
  typeof projectWorkMeetingFollowUpSnapshot
>;

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, nested]) => [key, sortJsonValue(nested)])
    );
  }
  return value;
}

export function canonicalizeWorkMeetingFollowUpSnapshot(
  snapshot: WorkMeetingFollowUpSnapshot
) {
  return JSON.stringify(sortJsonValue(snapshot as unknown as JsonValue));
}

export function digestWorkMeetingFollowUpSnapshot(
  snapshot: WorkMeetingFollowUpSnapshot
) {
  return createHash("sha256")
    .update(canonicalizeWorkMeetingFollowUpSnapshot(snapshot), "utf8")
    .digest("hex");
}

function normalizeText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function findingText(finding: { title: string; body: string }) {
  const title = normalizeText(finding.title);
  const body = normalizeText(finding.body);
  return title === body ? title : `${title}：${body}`;
}

function originalDueText(todo: {
  sourceOriginalDueAt: string | null;
  sourceOriginalDueExpression: string | null;
}) {
  const expression = todo.sourceOriginalDueExpression
    ? normalizeText(todo.sourceOriginalDueExpression)
    : null;
  const date = todo.sourceOriginalDueAt?.slice(0, 10) ?? null;
  if (expression && date) return `${expression}（${date}）`;
  return expression ?? date;
}

function todoText(todo: WorkMeetingFollowUpSnapshot["todos"][number]) {
  const main = todo.notes
    ? `${normalizeText(todo.title)}：${normalizeText(todo.notes)}`
    : normalizeText(todo.title);
  const details: string[] = [
    todo.sourceFindingKind === "commitment"
      ? "会议来源：已确认承诺"
      : "会议来源：已确认行动项"
  ];
  if (todo.kind === "waiting_for_other" && todo.ownerLabel) {
    details.push(`等待对象：${normalizeText(todo.ownerLabel)}`);
  }
  const originalDue = originalDueText(todo);
  if (originalDue) details.push(`会议原始截止时间：${originalDue}`);
  if (todo.currentDueDate) details.push(`Todo 当前计划时间：${todo.currentDueDate}`);
  details.push(todo.status === "completed"
    ? "Todo 当前状态：已完成（仅表示 Todo 状态，不代表会议承诺已履行）"
    : "Todo 当前状态：未完成");
  return `${main}（${details.join("；")}）`;
}

const PLAN_STAGE_STATUS_LABEL = {
  proposed: "初始方案",
  revised: "调整方案",
  current: "当前确认方案",
  withdrawn: "已撤回",
  unclear: "状态未明确"
} as const;

function planChangeText(
  finding: WorkMeetingFollowUpSnapshot["findings"][number]
) {
  const base = findingText(finding);
  if (finding.structuredData.planStages.length === 0) return base;
  const stages = finding.structuredData.planStages.map((stage) =>
    `${PLAN_STAGE_STATUS_LABEL[stage.status]}：${normalizeText(stage.content)}`
  );
  return `${base}；变化过程：${stages.join(" → ")}`;
}

function confirmedUnprojectedActionText(
  finding: WorkMeetingFollowUpSnapshot["findings"][number]
) {
  const label = finding.kind === "commitment" ? "已确认会议承诺" : "已确认行动项";
  const due = originalDueText({
    sourceOriginalDueAt: finding.structuredData.dueAt,
    sourceOriginalDueExpression: finding.structuredData.originalDueExpression
  });
  const dueSuffix = due ? `（会议原始截止时间：${due}）` : "";
  return `${label}：${findingText(finding)}${dueSuffix}`;
}

function escapeMarkdown(value: string) {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/([`*_[\]<>#|])/gu, "\\$1");
}

function renderSectionsMarkdown(sections: WorkMeetingFollowUpSection[]) {
  return sections.map((section) => [
    `## ${section.title}`,
    ...section.items.map((item) => `- ${escapeMarkdown(item.text)}`)
  ].join("\n")).join("\n\n");
}

function renderSectionsText(sections: WorkMeetingFollowUpSection[]) {
  return sections.map((section) => [
    section.title,
    ...section.items.map((item) => `• ${item.text}`)
  ].join("\n")).join("\n\n");
}

function section(
  key: WorkMeetingFollowUpSectionKey,
  title: string,
  items: WorkMeetingFollowUpSection["items"]
): WorkMeetingFollowUpSection | null {
  return items.length > 0 ? { key, title, items } : null;
}

export function buildWorkMeetingFollowUpContent(
  input: WorkMeetingFollowUpContentInput
) {
  const snapshot = projectWorkMeetingFollowUpSnapshot(input);
  const finalDecisions: WorkMeetingFollowUpSection["items"] = [];
  const tentativeDirections: WorkMeetingFollowUpSection["items"] = [];
  const confirmedActions: WorkMeetingFollowUpSection["items"] = [];
  const unresolvedQuestions: WorkMeetingFollowUpSection["items"] = [];
  const planChanges: WorkMeetingFollowUpSection["items"] = [];
  const mainDiscussion: WorkMeetingFollowUpSection["items"] = [];
  const linkedFindingIds = new Set(
    snapshot.todos.flatMap((todo) => todo.sourceFindingId ? [todo.sourceFindingId] : [])
  );

  for (const finding of snapshot.findings) {
    const item = {
      text: finding.kind === "plan_change" ? planChangeText(finding) : findingText(finding),
      findingIds: [finding.id],
      todoIds: []
    };
    if (finding.kind === "decision") {
      if (finding.structuredData.decisionFinality === "final") finalDecisions.push(item);
      else {
        const state = finding.structuredData.decisionFinality === "tentative"
          ? "暂定"
          : "结论尚未明确";
        tentativeDirections.push({ ...item, text: `${item.text}（${state}）` });
      }
    } else if (finding.kind === "proposal") {
      tentativeDirections.push({ ...item, text: `${item.text}（提议）` });
    } else if ((finding.kind === "action_item" || finding.kind === "commitment")
      && !linkedFindingIds.has(finding.id)) {
      confirmedActions.push({
        ...item,
        text: confirmedUnprojectedActionText(finding)
      });
    } else if (finding.kind === "open_question") {
      unresolvedQuestions.push(item);
    } else if (finding.kind === "plan_change") {
      planChanges.push(item);
    } else if (finding.kind === "discussion_topic") {
      mainDiscussion.push(item);
    }
  }

  const myActions: WorkMeetingFollowUpSection["items"] = [];
  const waitingForOthers: WorkMeetingFollowUpSection["items"] = [];
  for (const todo of snapshot.todos) {
    const item = {
      text: todoText(todo),
      findingIds: todo.sourceFindingId ? [todo.sourceFindingId] : [],
      todoIds: [todo.id]
    };
    if (todo.kind === "self") myActions.push(item);
    else waitingForOthers.push(item);
  }

  const sections = [
    section("final_decisions", "最终决定", finalDecisions),
    section("tentative_directions", "暂定方向", tentativeDirections),
    section("confirmed_actions", "会议中的行动与承诺", confirmedActions),
    section("my_actions", "我的待办", myActions),
    section("waiting_for_others", "等待他人", waitingForOthers),
    section("unresolved_questions", "仍未解决", unresolvedQuestions),
    section("plan_changes", "方案变化", planChanges),
    section("main_discussion", "主要讨论", mainDiscussion)
  ].filter((value): value is WorkMeetingFollowUpSection => value !== null);

  const markdownHeader = [
    "# 会后纪要草稿",
    "",
    `会议：${escapeMarkdown(snapshot.meeting.title)}`,
    `日期：${snapshot.meeting.meetingDate}`
  ].join("\n");
  const textHeader = [
    "会后纪要草稿",
    `会议：${snapshot.meeting.title}`,
    `日期：${snapshot.meeting.meetingDate}`
  ].join("\n");
  const sectionMarkdown = renderSectionsMarkdown(sections);
  const sectionText = renderSectionsText(sections);
  const bodyMarkdown = sectionMarkdown ? `${markdownHeader}\n\n${sectionMarkdown}` : markdownHeader;
  const bodyText = sectionText ? `${textHeader}\n\n${sectionText}` : textHeader;
  const decisionSections = sections.filter((item) =>
    item.key === "final_decisions" || item.key === "tentative_directions"
  );
  const actionSections = sections.filter((item) =>
    item.key === "confirmed_actions"
    || item.key === "my_actions"
    || item.key === "waiting_for_others"
  );
  const evidence = snapshot.findings.flatMap((finding) => [
    ...finding.evidenceRefs.map((reference) => ({
      findingId: finding.id,
      publicationId: reference.publicationId,
      segmentId: reference.segmentId,
      startSeconds: reference.startSeconds,
      endSeconds: reference.endSeconds
    })),
    ...finding.structuredData.planStages.flatMap((stage) =>
      stage.evidenceRefs.map((reference) => ({
        findingId: finding.id,
        publicationId: reference.publicationId,
        segmentId: reference.segmentId,
        startSeconds: reference.startSeconds,
        endSeconds: reference.endSeconds
      }))
    )
  ]).sort((left, right) =>
    compareText(left.findingId, right.findingId)
    || compareText(left.publicationId, right.publicationId)
    || left.startSeconds - right.startSeconds
    || compareText(left.segmentId, right.segmentId)
  );

  return {
    label: "会后纪要草稿" as const,
    bodyMarkdown,
    bodyText,
    sections,
    copySlices: {
      full: { markdown: bodyMarkdown, text: bodyText },
      decisions: {
        markdown: renderSectionsMarkdown(decisionSections),
        text: renderSectionsText(decisionSections)
      },
      actions: {
        markdown: renderSectionsMarkdown(actionSections),
        text: renderSectionsText(actionSections)
      }
    },
    sourceManifest: {
      findingIds: snapshot.findings.map((finding) => finding.id),
      todoIds: snapshot.todos.map((todo) => todo.id),
      evidence
    },
    systemSnapshot: {
      projection: snapshot,
      canonical: canonicalizeWorkMeetingFollowUpSnapshot(snapshot),
      digest: digestWorkMeetingFollowUpSnapshot(snapshot)
    }
  };
}

export type WorkMeetingFollowUpContent = ReturnType<
  typeof buildWorkMeetingFollowUpContent
>;

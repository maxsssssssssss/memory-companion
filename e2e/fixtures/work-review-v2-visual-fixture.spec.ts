import { mkdirSync } from "node:fs";

import { expect, test, type Page, type Route } from "@playwright/test";

import type {
  WorkMeetingDetail,
  WorkTodo,
  WorkWeeklyLiveSourceResponse
} from "../../src/lib/client/work-review-api";
import type { WorkProject, WorkProjectReference } from "../../src/lib/domain/work-project";
import type {
  WorkWeeklyQaMessage,
  WorkWeeklyQaRun,
  WorkWeeklyQaThread,
  WorkWeeklyReview,
  WorkWeeklyReviewItem,
  WorkWeeklyRun,
  WorkWeeklyScope,
  WorkWeeklySectionKind,
  WorkWeeklySourceSummary
} from "../../src/lib/domain/work-weekly";

const NOW = "2026-09-03T04:00:00.000Z";
const ACCOUNT_ID = "account_fixture";
const REVIEW_ID = "weekly_review_fixture";
const OUTPUT_DIR = process.env.WORK_REVIEW_VISUAL_OUTPUT_DIR ?? "output/playwright/work-review-v2";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const EVIDENCE_REF = "evidence:publication_fixture:segment_decision";
const FINDING_REF = "finding:finding_decision:1";
const TODO_REF = "todo:todo_alpha:0";

mkdirSync(OUTPUT_DIR, { recursive: true });

type Telemetry = {
  consoleProblems: string[];
  externalRequests: string[];
};

type FixtureState = {
  projects: WorkProject[];
  meetings: Map<string, WorkMeetingDetail>;
  todos: WorkTodo[];
  nextProject: number;
  nextTodo: number;
  nextWeeklyItem: number;
  review: WorkWeeklyReview | null;
  items: WorkWeeklyReviewItem[];
  sourceSummary: WorkWeeklySourceSummary;
  generation: "idle" | "queued";
  systemVersion: number;
  qaThread: WorkWeeklyQaThread | null;
  qaMessages: WorkWeeklyQaMessage[];
  qaPendingQuestion: string | null;
  qaPendingQuestionId: string | null;
  qaAnswerCount: number;
  invalidSourceRefs: Set<string>;
};

function response(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body)
  });
}

function addDays(day: string, amount: number) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function projectReference(project: WorkProject): WorkProjectReference {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    version: project.version
  };
}

function project(id: string, name: string, status: "active" | "archived" = "active"): WorkProject {
  return {
    contractVersion: 1,
    id,
    accountId: ACCOUNT_ID,
    name,
    description: `${name} 的轻量整理范围。`,
    status,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: status === "archived" ? NOW : null
  };
}

function meetingDetail(
  id: string,
  title: string,
  projects: WorkProjectReference[]
): WorkMeetingDetail {
  return {
    meeting: {
      id,
      title,
      meetingDate: "2026-09-02",
      ingestionStatus: "transcript_ready",
      analysisStatus: "review_ready",
      reviewStatus: "completed",
      durationSeconds: 1_560,
      pendingCandidateCount: 0,
      canonicalSegmentCount: 1,
      version: 2,
      projects,
      createdAt: NOW,
      updatedAt: NOW,
      sourceUploadId: `upload_${id}`,
      canonicalPublicationId: "publication_fixture",
      canonicalContentDigest: DIGEST_A,
      verifierMode: "enabled"
    },
    transcriptSegments: [{
      id: `segment_${id}`,
      uploadId: `upload_${id}`,
      startSeconds: 12,
      endSeconds: 18,
      speaker: "Speaker 1",
      text: "决定在九月十二日开放发布窗口。"
    }],
    candidates: [],
    findings: [{
      id: `finding_${id}`,
      sourceCandidateId: `candidate_${id}`,
      kind: "decision",
      title: "确认公开发布窗口",
      body: "团队决定在九月十二日开放发布窗口。",
      version: 1,
      decisionFinality: "final",
      evidence: [{
        publicationId: "publication_fixture",
        segmentId: `segment_${id}`,
        startSeconds: 12,
        endSeconds: 18,
        rawSpeakerLabel: "Speaker 1",
        timestampQuality: "provider_exact",
        text: "决定在九月十二日开放发布窗口。",
        contextBefore: "先核对上线条件。",
        contextAfter: "随后确认负责人。"
      }],
      createdAt: NOW,
      updatedAt: NOW
    }],
    todoProjections: [],
    linkedTodoCount: 0,
    speakerAliases: [{
      rawLabel: "Speaker 1",
      displayLabel: "Alex",
      version: 0,
      createdAt: NOW,
      updatedAt: NOW
    }]
  };
}

function todo(
  id: string,
  title: string,
  projects: WorkProjectReference[]
): WorkTodo {
  return {
    contractVersion: 1,
    id,
    accountId: ACCOUNT_ID,
    kind: "self",
    status: "open",
    origin: "manual",
    title,
    notes: null,
    ownerLabel: null,
    currentDueDate: "2026-09-08",
    isImportant: false,
    myDayDate: null,
    sourceMeetingId: null,
    sourceFindingId: null,
    sourceFindingVersion: null,
    sourceFindingKind: null,
    sourceOwnerLabel: null,
    sourceOriginalDueAt: null,
    sourceOriginalDueExpression: null,
    sourceActionBasis: null,
    sourceDetachedAt: null,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    reopenedAt: null,
    deletedAt: null,
    projects
  };
}

function weeklyScope(input: {
  weekStart: string;
  timeZone: string;
  scopeKind: "all" | "project" | "unassigned";
  projectId: string | null;
}): WorkWeeklyScope {
  return {
    weekStart: input.weekStart,
    timeZone: input.timeZone,
    scopeKind: input.scopeKind,
    projectId: input.projectId,
    weekEnd: addDays(input.weekStart, 6),
    observedThrough: addDays(input.weekStart, 3),
    windowComplete: false
  };
}

function weeklyReview(
  scope: WorkWeeklyScope,
  status: WorkWeeklyReview["status"],
  version: number,
  sourceSummary: WorkWeeklySourceSummary,
  systemVersion: number
): WorkWeeklyReview {
  return {
    contractVersion: 1,
    id: REVIEW_ID,
    accountId: ACCOUNT_ID,
    scope,
    status,
    sourceSnapshotDigest: status === "stale" ? DIGEST_B : DIGEST_A,
    sourceSummary,
    currentSystemVersion: systemVersion,
    currentRunVersion: Math.max(1, systemVersion),
    version,
    generatedAt: status === "queued" ? null : NOW,
    updatedAt: NOW,
    deletedAt: null
  };
}

function systemItem(
  id: string,
  section: WorkWeeklySectionKind,
  text: string,
  sourceRefs: string[],
  systemVersion: number,
  sortOrder = 0
): WorkWeeklyReviewItem {
  return {
    contractVersion: 1,
    id,
    accountId: ACCOUNT_ID,
    weeklyReviewId: REVIEW_ID,
    section,
    origin: "gpt",
    systemText: text,
    userText: null,
    sourceRefs,
    verificationState: "verified",
    sortOrder,
    systemVersion,
    version: systemVersion,
    userEditedAt: null,
    hiddenAt: null,
    invalidatedAt: null,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function systemItems(systemVersion: number): WorkWeeklyReviewItem[] {
  return [
    systemItem("weekly_overview", "overview", "本周聚焦发布准备，并保持来源边界清晰。", [EVIDENCE_REF], systemVersion),
    systemItem("weekly_progress", "progress", "发布检查清单已经完成第一轮核对。", [TODO_REF], systemVersion),
    systemItem("weekly_decision", "decisions", "公开发布窗口调整到 9 月 12 日。", [FINDING_REF], systemVersion),
    systemItem("weekly_completed", "completed", "发布素材清点已在系统中标记完成。", [TODO_REF], systemVersion),
    systemItem("weekly_in_progress", "in_progress", "邀请与提醒流程仍在联调。", [TODO_REF], systemVersion),
    systemItem("weekly_waiting", "waiting_for_others", "仍在等待法务确认说明。", [FINDING_REF], systemVersion),
    systemItem("weekly_questions", "open_questions", "灰度开放比例仍需确认。", [EVIDENCE_REF], systemVersion),
    systemItem("weekly_next", "next_week", "建议下周先完成发布前核对。", [TODO_REF], systemVersion)
  ];
}

function createState({ ready = false }: { ready?: boolean } = {}): FixtureState {
  const alpha = project("project_alpha", "增长计划");
  const beta = project("project_beta", "移动端发布");
  const archived = project("project_legacy", "旧版迁移", "archived");
  const sourceSummary: WorkWeeklySourceSummary = {
    meetingCount: 2,
    findingCount: 3,
    todoCount: 3,
    todoEventCount: 4,
    evidenceCount: 5,
    projectCount: 2,
    pendingCandidateCount: 1,
    includedFindingCount: 3,
    includedTodoCount: 3,
    includedTodoEventCount: 4,
    includedEvidenceCount: 5,
    omittedFindingCount: 0,
    omittedTodoCount: 0,
    omittedTodoEventCount: 0,
    omittedEvidenceCount: 0,
    truncated: false,
    historyCompleteness: "exact"
  };
  const scope = weeklyScope({
    weekStart: "2026-08-31",
    timeZone: "Asia/Shanghai",
    scopeKind: "all",
    projectId: null
  });
  return {
    projects: [alpha, beta, archived],
    meetings: new Map([
      ["meeting_alpha", meetingDetail("meeting_alpha", "增长计划周会", [projectReference(alpha)])],
      ["meeting_unassigned", meetingDetail("meeting_unassigned", "未分类同步会", [])]
    ]),
    todos: [
      todo("todo_alpha", "核对发布检查清单", [projectReference(alpha)]),
      todo("todo_unassigned", "整理临时问题", [])
    ],
    nextProject: 1,
    nextTodo: 1,
    nextWeeklyItem: 1,
    review: ready ? weeklyReview(scope, "ready", 1, sourceSummary, 1) : null,
    items: ready ? systemItems(1) : [],
    sourceSummary,
    generation: "idle",
    systemVersion: ready ? 1 : 0,
    qaThread: null,
    qaMessages: [],
    qaPendingQuestion: null,
    qaPendingQuestionId: null,
    qaAnswerCount: 0,
    invalidSourceRefs: new Set()
  };
}

function projectRefs(state: FixtureState, ids: readonly string[]) {
  return ids.map((id) => state.projects.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is WorkProject => Boolean(candidate))
    .map(projectReference);
}

function matchesProjectScope(
  projectIds: readonly string[],
  kind: string | null,
  projectId: string | null
) {
  if (kind === "unassigned") return projectIds.length === 0;
  if (kind === "project") return Boolean(projectId && projectIds.includes(projectId));
  return true;
}

function scopeFromUrl(url: URL) {
  const scopeKind = url.searchParams.get("scopeKind");
  const projectId = scopeKind === "project" ? url.searchParams.get("projectId") : null;
  return weeklyScope({
    weekStart: url.searchParams.get("weekStart") ?? "2026-08-31",
    timeZone: url.searchParams.get("timeZone") ?? "Asia/Shanghai",
    scopeKind: scopeKind === "project" ? "project" : scopeKind === "unassigned" ? "unassigned" : "all",
    projectId
  });
}

function transitionGeneration(state: FixtureState) {
  if (!state.review || state.generation !== "queued") return;
  state.systemVersion += 1;
  const notes = state.items.filter((item) => item.origin === "user_note");
  state.items = [...systemItems(state.systemVersion), ...notes];
  state.review = {
    ...state.review,
    status: "ready",
    currentSystemVersion: state.systemVersion,
    currentRunVersion: state.systemVersion,
    version: state.review.version + 1,
    generatedAt: NOW,
    updatedAt: NOW,
    sourceSnapshotDigest: DIGEST_A
  };
  state.generation = "idle";
}

function generationRun(state: FixtureState): WorkWeeklyRun {
  const review = state.review!;
  return {
    id: `weekly_run_${review.currentRunVersion}`,
    accountId: ACCOUNT_ID,
    weeklyReviewId: REVIEW_ID,
    runVersion: review.currentRunVersion,
    sourceSnapshotDigest: review.sourceSnapshotDigest,
    state: "queued",
    leaseOwner: null,
    leaseExpiresAt: null,
    pipelineVersion: "fixture-weekly-v2",
    synthesizerProfile: null,
    verifierProfile: null,
    createdAt: NOW,
    completedAt: null,
    errorCode: null
  };
}

function completePendingQa(state: FixtureState) {
  if (!state.qaThread || !state.qaPendingQuestion || !state.qaPendingQuestionId) return;
  const turn = state.qaAnswerCount;
  const insufficient = turn >= 2;
  const answer = turn === 0
    ? "发布检查清单已完成第一轮核对。"
    : turn === 1
      ? "本周决定把公开发布窗口调整到 9 月 12 日。"
      : null;
  state.qaMessages.push({
    id: `qa_answer_${turn + 1}`,
    accountId: ACCOUNT_ID,
    weeklyReviewId: REVIEW_ID,
    threadId: state.qaThread.id,
    role: "assistant",
    text: answer,
    answerStatus: insufficient ? "insufficient_evidence" : "answered",
    sourceRefs: insufficient ? [] : [turn === 0 ? EVIDENCE_REF : FINDING_REF],
    sourceSnapshotDigest: state.review?.sourceSnapshotDigest ?? DIGEST_A,
    providerProfile: "deterministic-fixture",
    promptVersion: "fixture-v1",
    verifierProfile: "deterministic-fixture-verifier",
    version: state.qaThread.version + 1,
    createdAt: NOW,
    invalidatedAt: null
  });
  state.qaThread = {
    ...state.qaThread,
    version: state.qaThread.version + 1,
    updatedAt: NOW
  };
  state.qaAnswerCount += 1;
  state.qaPendingQuestion = null;
  state.qaPendingQuestionId = null;
}

function liveSource(sourceRef: string): WorkWeeklyLiveSourceResponse {
  if (sourceRef === FINDING_REF) {
    return {
      identity: {
        sourceRef,
        sourceKind: "finding",
        sourceId: "finding_decision",
        version: 1,
        digest: DIGEST_A,
        publicationId: "publication_fixture",
        segmentId: null,
        included: true
      },
      source: {
        sourceRef,
        id: "finding_decision",
        meetingId: "meeting_alpha",
        version: 1,
        kind: "decision",
        title: "公开发布窗口",
        body: "团队决定把公开发布窗口调整到 9 月 12 日。",
        structuredData: {},
        userConfirmedAt: NOW,
        userEditedAt: null,
        evidenceRefs: [EVIDENCE_REF]
      }
    };
  }
  if (sourceRef === TODO_REF) {
    return {
      identity: {
        sourceRef,
        sourceKind: "todo",
        sourceId: "todo_alpha",
        version: 0,
        digest: DIGEST_A,
        publicationId: null,
        segmentId: null,
        included: true
      },
      source: {
        sourceRef,
        id: "todo_alpha",
        version: 0,
        current: {
          title: "核对发布检查清单",
          kind: "self",
          status: "open",
          ownerLabel: null,
          currentDueDate: "2026-09-08",
          completedAt: null,
          deletedAt: null,
          version: 0
        },
        stateAtWeekEnd: null,
        historyCompleteness: "exact",
        sourceMeetingId: null,
        sourceFindingId: null,
        sourceFindingKind: null,
        projects: [{ id: "project_alpha", name: "增长计划", status: "active", version: 0 }]
      }
    };
  }
  return {
    identity: {
      sourceRef,
      sourceKind: "evidence",
      sourceId: "segment_decision",
      version: null,
      digest: DIGEST_A,
      publicationId: "publication_fixture",
      segmentId: "segment_decision",
      included: true
    },
    source: {
      sourceRef,
      publicationId: "publication_fixture",
      publicationDigest: DIGEST_A,
      meetingId: "meeting_alpha",
      segmentId: "segment_decision",
      startSeconds: 42,
      endSeconds: 49,
      rawSpeakerLabel: "Speaker 1",
      timestampQuality: "provider_exact",
      text: "决定把公开发布窗口调整到九月十二日。"
    }
  };
}

async function installFixture(page: Page, state: FixtureState) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as typeof window & { __workReviewCopied?: string }).__workReviewCopied = value;
        }
      }
    });
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;

    if (method === "GET" && path === "/api/auth/me") {
      return response(route, {
        user: { id: ACCOUNT_ID, email: "fixture@example.com", name: "测试用户" }
      });
    }
    if (method === "GET" && path === "/api/work-reviews/config") {
      return response(route, {
        limits: { maxUploadBytes: 300 * 1024 * 1024, maxAudioDurationSeconds: 14_400 },
        capabilities: {
          projects: true,
          weekly: true,
          weeklyAi: true,
          weeklyVerifier: true,
          weeklyQa: true,
          weeklyQaVerifier: true
        }
      });
    }

    if (path === "/api/work-reviews/projects" && method === "GET") {
      const status = url.searchParams.get("status") ?? "active";
      return response(route, {
        projects: status === "all" ? state.projects : state.projects.filter((item) => item.status === status)
      });
    }
    if (path === "/api/work-reviews/projects" && method === "POST") {
      const input = request.postDataJSON() as { name: string; description?: string | null };
      const created = project(`project_created_${state.nextProject++}`, input.name);
      created.description = input.description ?? null;
      state.projects.push(created);
      return response(route, { project: created, reused: false });
    }
    const projectPath = path.match(/^\/api\/work-reviews\/projects\/([^/]+)$/u);
    if (projectPath && method === "GET") {
      const found = state.projects.find((item) => item.id === decodeURIComponent(projectPath[1]!));
      return found ? response(route, { project: found }) : response(route, { error: "project_not_found" }, 404);
    }
    if (projectPath && method === "PATCH") {
      const found = state.projects.find((item) => item.id === decodeURIComponent(projectPath[1]!));
      if (!found) return response(route, { error: "project_not_found" }, 404);
      const input = request.postDataJSON() as Partial<WorkProject>;
      if (input.name !== undefined) found.name = input.name;
      if (input.description !== undefined) found.description = input.description;
      if (input.status !== undefined) {
        found.status = input.status;
        found.archivedAt = input.status === "archived" ? NOW : null;
      }
      found.version += 1;
      found.updatedAt = NOW;
      return response(route, { project: found, reused: false });
    }

    if (path === "/api/work-reviews/meetings" && method === "GET") {
      const kind = url.searchParams.get("projectScope");
      const projectId = url.searchParams.get("projectId");
      const meetings = Array.from(state.meetings.values()).map((detail) => ({
        id: detail.meeting.id,
        title: detail.meeting.title,
        meetingDate: detail.meeting.meetingDate,
        ingestionStatus: detail.meeting.ingestionStatus,
        analysisStatus: detail.meeting.analysisStatus,
        reviewStatus: detail.meeting.reviewStatus,
        durationSeconds: detail.meeting.durationSeconds,
        pendingCandidateCount: detail.meeting.pendingCandidateCount,
        canonicalSegmentCount: detail.meeting.canonicalSegmentCount,
        version: detail.meeting.version,
        projects: detail.meeting.projects,
        createdAt: detail.meeting.createdAt,
        updatedAt: detail.meeting.updatedAt
      })).filter((meeting) => (
        matchesProjectScope((meeting.projects ?? []).map((item) => item.id), kind, projectId)
      ));
      return response(route, { meetings });
    }
    const meetingProjectsPath = path.match(/^\/api\/work-reviews\/meetings\/([^/]+)\/projects$/u);
    if (meetingProjectsPath && method === "PATCH") {
      const id = decodeURIComponent(meetingProjectsPath[1]!);
      const detail = state.meetings.get(id);
      if (!detail) return response(route, { error: "meeting_not_found" }, 404);
      const input = request.postDataJSON() as { projectIds: string[] };
      detail.meeting.projects = projectRefs(state, input.projectIds);
      detail.meeting.version += 1;
      detail.meeting.updatedAt = NOW;
      return response(route, {
        resourceId: id,
        resourceVersion: detail.meeting.version,
        projects: detail.meeting.projects,
        changed: true,
        reused: false
      });
    }
    const meetingFollowUpPath = path.match(/^\/api\/work-reviews\/meetings\/([^/]+)\/follow-up$/u);
    if (meetingFollowUpPath && method === "GET") {
      return response(route, {
        draft: null,
        sourceStats: {
          findingCount: 1,
          todoCount: 0,
          confirmedResultCount: 1,
          myTodoCount: 0,
          waitingForOtherTodoCount: 0,
          unresolvedQuestionCount: 0
        }
      });
    }
    const meetingPath = path.match(/^\/api\/work-reviews\/meetings\/([^/]+)$/u);
    if (meetingPath && method === "GET") {
      const detail = state.meetings.get(decodeURIComponent(meetingPath[1]!));
      return detail ? response(route, detail) : response(route, { error: "meeting_not_found" }, 404);
    }

    if (path === "/api/work-reviews/todos" && method === "GET") {
      const kind = url.searchParams.get("projectScope");
      const projectId = url.searchParams.get("projectId");
      const view = url.searchParams.get("view") ?? "all";
      const todos = state.todos.filter((item) => !item.deletedAt).filter((item) => {
        if (!matchesProjectScope((item.projects ?? []).map((candidate) => candidate.id), kind, projectId)) return false;
        if (view === "completed") return item.status === "completed";
        if (view === "waiting") return item.status === "open" && item.kind === "waiting_for_other";
        if (view === "planned") return item.status === "open" && item.currentDueDate !== null;
        return item.status === "open";
      });
      return response(route, { todos });
    }
    if (path === "/api/work-reviews/todos" && method === "POST") {
      const input = request.postDataJSON() as Record<string, unknown> & { projectIds?: string[] };
      const created = todo(
        `todo_created_${state.nextTodo++}`,
        String(input.title),
        projectRefs(state, input.projectIds ?? [])
      );
      created.kind = input.kind === "waiting_for_other" ? "waiting_for_other" : "self";
      created.ownerLabel = typeof input.ownerLabel === "string" ? input.ownerLabel : null;
      created.notes = typeof input.notes === "string" ? input.notes : null;
      created.currentDueDate = typeof input.currentDueDate === "string" ? input.currentDueDate : null;
      created.isImportant = Boolean(input.isImportant);
      created.myDayDate = typeof input.myDayDate === "string" ? input.myDayDate : null;
      state.todos.push(created);
      return response(route, { todo: created, reused: false });
    }
    const todoPath = path.match(/^\/api\/work-reviews\/todos\/([^/]+)$/u);
    if (todoPath && method === "GET") {
      const found = state.todos.find((item) => item.id === decodeURIComponent(todoPath[1]!) && !item.deletedAt);
      return found
        ? response(route, {
          todo: found,
          source: { state: "none", sourceChanged: false, currentFindingVersion: null, meeting: null }
        })
        : response(route, { error: "todo_not_found" }, 404);
    }
    if (todoPath && method === "PATCH") {
      const found = state.todos.find((item) => item.id === decodeURIComponent(todoPath[1]!) && !item.deletedAt);
      if (!found) return response(route, { error: "todo_not_found" }, 404);
      const input = request.postDataJSON() as Record<string, unknown> & { projectIds?: string[] };
      if (typeof input.title === "string") found.title = input.title;
      if (input.kind === "self" || input.kind === "waiting_for_other") found.kind = input.kind;
      if (input.ownerLabel === null || typeof input.ownerLabel === "string") found.ownerLabel = input.ownerLabel;
      if (input.notes === null || typeof input.notes === "string") found.notes = input.notes;
      if (input.currentDueDate === null || typeof input.currentDueDate === "string") found.currentDueDate = input.currentDueDate;
      if (input.myDayDate === null || typeof input.myDayDate === "string") found.myDayDate = input.myDayDate;
      if (typeof input.isImportant === "boolean") found.isImportant = input.isImportant;
      if (input.projectIds) found.projects = projectRefs(state, input.projectIds);
      found.version += 1;
      found.updatedAt = NOW;
      return response(route, { todo: found, reused: false });
    }

    if (path === "/api/work-reviews/weekly" && method === "GET") {
      const scope = scopeFromUrl(url);
      if (state.review) state.review = { ...state.review, scope };
      return response(route, {
        review: state.review,
        items: state.items,
        sourceSummary: state.sourceSummary
      });
    }
    if (path === "/api/work-reviews/weekly/generate" && method === "POST") {
      const input = request.postDataJSON() as {
        weekStart: string;
        timeZone: string;
        scopeKind: "all" | "project" | "unassigned";
        projectId: string | null;
      };
      state.review = weeklyReview(weeklyScope(input), "queued", 0, state.sourceSummary, 0);
      state.items = [];
      state.generation = "queued";
      return response(route, { review: state.review, run: generationRun(state), reused: false });
    }

    const regeneratePath = path.match(/^\/api\/work-reviews\/weekly\/([^/]+)\/regenerate$/u);
    if (regeneratePath && method === "POST") {
      if (!state.review) return response(route, { error: "weekly_review_not_found" }, 404);
      state.review = {
        ...state.review,
        status: "queued",
        currentRunVersion: state.review.currentRunVersion + 1,
        version: state.review.version + 1,
        updatedAt: NOW
      };
      state.generation = "queued";
      return response(route, { review: state.review, run: generationRun(state), reused: false });
    }

    const sourcePath = path.match(/^\/api\/work-reviews\/weekly\/([^/]+)\/sources\/(.+)$/u);
    if (sourcePath && method === "GET") {
      const sourceRef = decodeURIComponent(sourcePath[2]!);
      if (state.invalidSourceRefs.has(sourceRef)) {
        return response(route, { error: "weekly_source_not_found" }, 404);
      }
      return response(route, liveSource(sourceRef));
    }

    const qaPath = path.match(/^\/api\/work-reviews\/weekly\/([^/]+)\/qa$/u);
    if (qaPath && method === "GET") {
      completePendingQa(state);
      return response(route, state.qaThread ? { thread: state.qaThread, messages: state.qaMessages } : null);
    }
    if (qaPath && method === "POST") {
      const input = request.postDataJSON() as { question: string };
      state.qaThread = state.qaThread ?? {
        id: "weekly_qa_thread",
        accountId: ACCOUNT_ID,
        weeklyReviewId: REVIEW_ID,
        sourceSnapshotDigest: state.review?.sourceSnapshotDigest ?? DIGEST_A,
        version: 0,
        createdAt: NOW,
        updatedAt: NOW,
        clearedAt: null
      };
      state.qaThread = {
        ...state.qaThread,
        version: state.qaThread.version + 1,
        updatedAt: NOW
      };
      const questionId = `qa_question_${state.qaAnswerCount + 1}`;
      state.qaMessages.push({
        id: questionId,
        accountId: ACCOUNT_ID,
        weeklyReviewId: REVIEW_ID,
        threadId: state.qaThread.id,
        role: "user",
        text: input.question,
        answerStatus: null,
        sourceRefs: [],
        sourceSnapshotDigest: state.review?.sourceSnapshotDigest ?? DIGEST_A,
        providerProfile: null,
        promptVersion: null,
        verifierProfile: null,
        version: state.qaThread.version,
        createdAt: NOW,
        invalidatedAt: null
      });
      state.qaPendingQuestion = input.question;
      state.qaPendingQuestionId = questionId;
      const run: WorkWeeklyQaRun = {
        id: `qa_run_${state.qaAnswerCount + 1}`,
        accountId: ACCOUNT_ID,
        weeklyReviewId: REVIEW_ID,
        threadId: state.qaThread.id,
        questionMessageId: questionId,
        runVersion: state.qaAnswerCount + 1,
        sourceSnapshotDigest: state.review?.sourceSnapshotDigest ?? DIGEST_A,
        state: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        providerProfile: null,
        promptVersion: null,
        verifierProfile: null,
        createdAt: NOW,
        completedAt: null,
        errorCode: null
      };
      return response(route, {
        thread: state.qaThread,
        messages: state.qaMessages,
        run,
        reused: false
      });
    }
    if (qaPath && method === "DELETE") {
      state.qaThread = null;
      state.qaMessages = [];
      state.qaPendingQuestion = null;
      state.qaPendingQuestionId = null;
      return response(route, { cleared: true, reused: false });
    }

    const resetPath = path.match(/^\/api\/work-reviews\/weekly\/([^/]+)\/reset$/u);
    if (resetPath && method === "POST") {
      if (!state.review) return response(route, { error: "weekly_review_not_found" }, 404);
      state.items = state.items.map((item) => item.origin === "user_note" ? item : {
        ...item,
        userText: null,
        hiddenAt: null,
        userEditedAt: null,
        version: item.version + 1,
        updatedAt: NOW
      });
      state.review = { ...state.review, version: state.review.version + 1, updatedAt: NOW };
      return response(route, { review: state.review, reused: false });
    }

    const itemsPath = path.match(/^\/api\/work-reviews\/weekly\/([^/]+)\/items$/u);
    if (itemsPath && method === "POST") {
      if (!state.review) return response(route, { error: "weekly_review_not_found" }, 404);
      const input = request.postDataJSON() as {
        section: WorkWeeklySectionKind;
        text: string;
        sortOrder: number;
      };
      const item: WorkWeeklyReviewItem = {
        contractVersion: 1,
        id: `weekly_note_${state.nextWeeklyItem++}`,
        accountId: ACCOUNT_ID,
        weeklyReviewId: REVIEW_ID,
        section: input.section,
        origin: "user_note",
        systemText: null,
        userText: input.text,
        sourceRefs: [],
        verificationState: "user_authored",
        sortOrder: input.sortOrder,
        systemVersion: null,
        version: 0,
        userEditedAt: NOW,
        hiddenAt: null,
        invalidatedAt: null,
        createdAt: NOW,
        updatedAt: NOW
      };
      state.items.push(item);
      state.review = { ...state.review, version: state.review.version + 1, updatedAt: NOW };
      return response(route, { item, reused: false });
    }

    const itemPath = path.match(/^\/api\/work-reviews\/weekly\/([^/]+)\/items\/([^/]+)$/u);
    if (itemPath && method === "PATCH") {
      const item = state.items.find((candidate) => candidate.id === decodeURIComponent(itemPath[2]!));
      if (!item || !state.review) return response(route, { error: "weekly_item_not_found" }, 404);
      const input = request.postDataJSON() as { text?: string; hidden?: boolean; sortOrder?: number };
      if (input.text !== undefined) {
        item.userText = input.text;
        item.userEditedAt = NOW;
      }
      if (input.hidden !== undefined) item.hiddenAt = input.hidden ? NOW : null;
      if (input.sortOrder !== undefined) item.sortOrder = input.sortOrder;
      item.version += 1;
      item.updatedAt = NOW;
      state.review = { ...state.review, version: state.review.version + 1, updatedAt: NOW };
      return response(route, { item, reused: false });
    }
    if (itemPath && method === "DELETE") {
      const itemId = decodeURIComponent(itemPath[2]!);
      state.items = state.items.filter((candidate) => candidate.id !== itemId);
      if (state.review) state.review = { ...state.review, version: state.review.version + 1, updatedAt: NOW };
      return response(route, { deleted: true, reused: false });
    }

    const weeklyPath = path.match(/^\/api\/work-reviews\/weekly\/([^/]+)$/u);
    if (weeklyPath && method === "GET") {
      transitionGeneration(state);
      return state.review
        ? response(route, { review: state.review, items: state.items, sourceSummary: state.sourceSummary })
        : response(route, { error: "weekly_review_not_found" }, 404);
    }

    return response(route, { error: `unhandled_fixture_route:${method}:${path}` }, 500);
  });
}

function watchTelemetry(page: Page): Telemetry {
  const telemetry: Telemetry = { consoleProblems: [], externalRequests: [] };
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      telemetry.consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => telemetry.consoleProblems.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (!(["127.0.0.1", "localhost"].includes(url.hostname))) {
        telemetry.externalRequests.push(request.url());
      }
    }
  });
  return telemetry;
}

async function hideNextDevIndicator(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll("nextjs-portal").forEach((element) => element.remove());
    const existing = document.querySelector<HTMLStyleElement>("style[data-v2-fixture-paint]");
    if (existing) return;
    const style = document.createElement("style");
    style.dataset.v2FixturePaint = "true";
    style.textContent = "* { content-visibility: visible !important; }";
    document.head.append(style);
  });
}

async function pageMetrics(page: Page) {
  return await page.evaluate(() => {
    const isVisible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0"
        && rect.width > 0
        && rect.height > 0;
    };
    const raw = Array.from(document.querySelectorAll<HTMLElement>(
      "button, a[href], input:not([type='hidden']), textarea, select, [role='tab']"
    )).filter(isVisible);
    const targets = Array.from(new Set(raw.map((element) => {
      if (element instanceof HTMLInputElement && ["checkbox", "radio", "file"].includes(element.type)) {
        return element.closest("label") as HTMLElement | null ?? element;
      }
      return element;
    })));
    const under44 = targets.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width < 44 || rect.height < 44;
    }).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 60) ?? element.tagName,
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    });
    return {
      workAccent: getComputedStyle(document.querySelector("main")!).getPropertyValue("--db-accent").trim(),
      globalAccent: getComputedStyle(document.documentElement).getPropertyValue("--db-accent").trim(),
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      under44
    };
  });
}

async function assertPageHealth(page: Page, telemetry: Telemetry) {
  await hideNextDevIndicator(page);
  const metrics = await pageMetrics(page);
  expect(metrics.workAccent).toBe("#0f6cbd");
  expect(metrics.globalAccent).toBe("#315945");
  expect(metrics.horizontalOverflow).toBe(0);
  expect(metrics.under44).toEqual([]);
  expect(telemetry.consoleProblems).toEqual([]);
  expect(telemetry.externalRequests).toEqual([]);
  return metrics;
}

function sectionWithHeading(page: Page, heading: string) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: heading, exact: true })
  }).last();
}

test.describe("Work Review V2 deterministic browser fixture", () => {
  test("covers Project CRUD and Meeting/Todo project scopes and associations", async ({ page }) => {
    const state = createState();
    const telemetry = watchTelemetry(page);
    await installFixture(page, state);

    await page.goto("/work-review/projects");
    await expect(page.getByRole("heading", { name: "项目", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "新建项目" }).click();
    let dialog = page.getByRole("dialog", { name: "新建项目" });
    await expect(dialog).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(dialog.getByRole("button", { name: "创建项目" })).toHaveCSS("background-color", "rgb(15, 108, 189)");
    await dialog.getByLabel(/项目名称/u).fill("发布复盘");
    await dialog.getByLabel(/说明/u).fill("浏览器 fixture 创建的项目。");
    await dialog.getByRole("button", { name: "创建项目" }).click();
    await expect(page.getByText("项目已创建。你现在可以把会议和待办归入这个项目。")).toBeVisible();

    let createdRow = page.locator("li").filter({ hasText: "发布复盘" });
    await createdRow.getByRole("button", { name: "编辑" }).click();
    dialog = page.getByRole("dialog", { name: "编辑项目" });
    await dialog.getByLabel(/项目名称/u).fill("发布复盘 2026");
    await dialog.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByText("项目修改已保存。")).toBeVisible();

    createdRow = page.locator("li").filter({ hasText: "发布复盘 2026" });
    await createdRow.getByRole("button", { name: "归档" }).click();
    dialog = page.getByRole("dialog", { name: "归档这个项目吗？" });
    await dialog.getByRole("button", { name: "确认归档" }).click();
    await expect(page.getByText("项目已归档；历史会议和待办关联仍然保留。")).toBeVisible();
    const archivedSection = sectionWithHeading(page, "已归档项目");
    await expect(archivedSection.getByText("发布复盘 2026")).toBeVisible();
    await archivedSection.locator("li").filter({ hasText: "发布复盘 2026" }).getByRole("button", { name: "恢复" }).click();
    dialog = page.getByRole("dialog", { name: "恢复这个项目吗？" });
    await dialog.getByRole("button", { name: "确认恢复" }).click();
    await expect(page.getByText("项目已恢复，可以用于新的会议和待办。")).toBeVisible();
    await hideNextDevIndicator(page);
    await page.screenshot({ path: `${OUTPUT_DIR}/projects-desktop.png`, fullPage: true });
    await assertPageHealth(page, telemetry);

    await page.goto("/work-review/meetings");
    const meetingFilter = page.getByLabel("项目范围");
    await meetingFilter.selectOption("project:project_alpha");
    await expect(page.getByRole("heading", { name: "增长计划周会" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "未分类同步会" })).toBeHidden();
    await meetingFilter.selectOption("unassigned");
    await expect(page.getByRole("heading", { name: "未分类同步会" })).toBeVisible();

    await page.goto("/work-review/meetings/meeting_alpha");
    const meetingProjects = page.getByRole("group", { name: "选择项目" });
    await meetingProjects.getByRole("checkbox", { name: "增长计划" }).uncheck();
    await meetingProjects.getByRole("checkbox", { name: "移动端发布" }).check();
    await page.getByRole("button", { name: "保存项目" }).click();
    await expect(page.getByText("会议所属项目已保存。")).toBeVisible();
    expect(state.meetings.get("meeting_alpha")?.meeting.projects?.map((item) => item.id)).toEqual(["project_beta"]);
    await hideNextDevIndicator(page);
    await page.screenshot({ path: `${OUTPUT_DIR}/meeting-projects-desktop.png`, fullPage: true });
    await assertPageHealth(page, telemetry);

    await page.goto("/work-review/todos");
    const todoFilter = page.getByLabel("项目范围");
    await todoFilter.selectOption("unassigned");
    await expect(page.getByRole("button", { name: "整理临时问题" })).toBeVisible();
    await todoFilter.selectOption("project:project_alpha");
    await expect(page.getByRole("button", { name: "核对发布检查清单" })).toBeVisible();
    await todoFilter.selectOption("all");

    await page.getByRole("button", { name: "新建待办" }).click();
    dialog = page.getByRole("dialog", { name: "新建待办" });
    await dialog.getByLabel("标题").fill("完成 V2 视觉验收");
    await dialog.getByRole("group", { name: "关联项目" }).getByRole("checkbox", { name: "移动端发布" }).check();
    await dialog.getByRole("button", { name: "创建待办" }).click();
    await expect(page.getByRole("button", { name: "完成 V2 视觉验收" })).toBeVisible();
    const createdTodo = state.todos.find((item) => item.title === "完成 V2 视觉验收");
    expect(createdTodo?.projects?.map((item) => item.id)).toEqual(["project_beta"]);

    await page.getByRole("button", { name: "完成 V2 视觉验收" }).click();
    await page.getByRole("dialog", { name: "待办详情" }).getByRole("button", { name: "编辑" }).click();
    dialog = page.getByRole("dialog", { name: "编辑待办" });
    const todoProjects = dialog.getByRole("group", { name: "关联项目" });
    await todoProjects.getByRole("checkbox", { name: "移动端发布" }).uncheck();
    await todoProjects.getByRole("checkbox", { name: "增长计划" }).check();
    await dialog.getByRole("button", { name: "保存修改" }).click();
    expect(createdTodo?.projects?.map((item) => item.id)).toEqual(["project_alpha"]);
    await todoFilter.selectOption("project:project_alpha");
    await expect(page.getByRole("button", { name: "完成 V2 视觉验收" })).toBeVisible();
    await hideNextDevIndicator(page);
    await page.screenshot({ path: `${OUTPUT_DIR}/todo-projects-desktop.png`, fullPage: true });
    await assertPageHealth(page, telemetry);
  });

  test("covers Weekly generation, verified sections, edits, stale regeneration, QA, evidence, and clear", async ({ page }) => {
    const state = createState();
    const telemetry = watchTelemetry(page);
    await installFixture(page, state);

    await page.goto("/work-review/weekly");
    await expect(page.getByRole("heading", { name: "这一周还没有回顾" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "来源覆盖范围" })).toBeVisible();
    await expect(page.getByText("5", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "生成本周回顾" }).click();
    await expect(page.getByRole("heading", { name: "等待生成本周回顾" })).toBeVisible();
    await page.getByRole("button", { name: "刷新状态" }).click();
    await expect(page.getByRole("heading", { name: "本周概览" })).toBeVisible();
    for (const heading of [
      "重要进展",
      "关键决定与变化",
      "本周标记完成的待办",
      "仍在进行",
      "等待他人",
      "未解决问题",
      "下周关注"
    ]) {
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }

    const overview = sectionWithHeading(page, "本周概览");
    await overview.getByRole("button", { name: "编辑" }).click();
    await page.getByLabel("编辑回顾内容").fill("本周聚焦发布准备，且所有陈述都保留可核对来源。");
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByText("修改已保存，并标记为用户编辑。")).toBeVisible();

    const progress = sectionWithHeading(page, "重要进展");
    await progress.getByRole("button", { name: "隐藏" }).click();
    const hidden = sectionWithHeading(page, "已隐藏内容");
    await expect(hidden.getByText("发布检查清单已经完成第一轮核对。")).toBeVisible();
    await hidden.getByRole("button", { name: "恢复" }).click();
    await expect(page.getByText("这条内容已恢复显示。")).toBeVisible();

    await page.getByRole("button", { name: "增加个人补充" }).click();
    let dialog = page.getByRole("dialog", { name: "增加个人补充" });
    await dialog.getByLabel("放入区块").selectOption("progress");
    await dialog.getByLabel("补充内容").fill("个人补充：客户演示安排在周五。 ");
    await dialog.getByRole("button", { name: "保存补充" }).click();
    await expect(page.getByText("个人补充：客户演示安排在周五。")).toBeVisible();

    await page.getByRole("button", { name: "只复制决定" }).click();
    await expect(page.getByText("已复制决定部分。")).toBeVisible();
    expect(await page.evaluate(() => (
      window as typeof window & { __workReviewCopied?: string }
    ).__workReviewCopied)).toContain("公开发布窗口调整到 9 月 12 日");

    const sourceOpener = overview.getByRole("button", { name: "来源 1" });
    await sourceOpener.click();
    dialog = page.getByRole("dialog", { name: "原话证据" });
    await expect(dialog.getByText("决定把公开发布窗口调整到九月十二日。")).toBeVisible();
    await dialog.getByRole("button", { name: "返回周回顾" }).click();

    await page.getByRole("button", { name: "恢复系统版本" }).click();
    dialog = page.getByRole("dialog", { name: "恢复最近的系统版本？" });
    await dialog.getByRole("button", { name: "确认恢复" }).click();
    await expect(page.getByText("已恢复最近一次系统生成版本；个人补充仍然保留。")).toBeVisible();
    await expect(page.getByText("本周聚焦发布准备，并保持来源边界清晰。")).toBeVisible();
    await expect(page.getByText("个人补充：客户演示安排在周五。")).toBeVisible();

    state.review = { ...state.review!, status: "stale", version: state.review!.version + 1, sourceSnapshotDigest: DIGEST_B };
    await page.reload();
    await expect(page.getByRole("heading", { name: "本周来源后来发生变化" })).toBeVisible();
    await page.getByRole("button", { name: "按最新来源重新生成" }).click();
    dialog = page.getByRole("dialog", { name: "按最新来源重新生成？" });
    await dialog.getByRole("button", { name: "确认重新生成" }).click();
    await expect(page.getByRole("heading", { name: "等待生成本周回顾" })).toBeVisible();
    await page.getByRole("button", { name: "刷新状态" }).click();
    await expect(page.getByRole("heading", { name: "本周概览" })).toBeVisible();
    await hideNextDevIndicator(page);
    await page.screenshot({ path: `${OUTPUT_DIR}/weekly-ready-desktop.png`, fullPage: true });
    await assertPageHealth(page, telemetry);

    await page.getByRole("tab", { name: "问问本周" }).click();
    await page.getByRole("button", { name: "这周完成了什么？" }).click();
    await page.getByRole("button", { name: "发送问题" }).click();
    await expect(page.getByText("发布检查清单已完成第一轮核对。")).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: "本周做出了哪些决定？" }).click();
    await page.getByRole("button", { name: "发送问题" }).click();
    await expect(page.getByText("本周决定把公开发布窗口调整到 9 月 12 日。")).toBeVisible({ timeout: 5_000 });

    await page.getByLabel("继续问这一周").fill("团队下季度预算是多少？");
    await page.getByRole("button", { name: "发送问题" }).click();
    await expect(page.getByText("在本周已确认的工作记录中，没有找到足够依据回答这个问题。")).toBeVisible({ timeout: 5_000 });

    const firstAnswer = state.qaMessages.find((message) => message.id === "qa_answer_1")!;
    firstAnswer.answerStatus = "invalidated";
    firstAnswer.invalidatedAt = NOW;
    await page.getByRole("tab", { name: "本周回顾" }).click();
    await page.getByRole("tab", { name: "问问本周" }).click();
    const invalidatedAnswer = page.locator("li[data-role='assistant']").filter({
      hasText: "这条回答引用的来源已经失效"
    });
    await expect(invalidatedAnswer).toBeVisible();
    await expect(invalidatedAnswer.getByRole("button", { name: "来源 1" })).toHaveCount(0);
    await hideNextDevIndicator(page);
    await page.screenshot({ path: `${OUTPUT_DIR}/weekly-qa-desktop.png`, fullPage: true });
    await assertPageHealth(page, telemetry);

    await page.getByRole("button", { name: "清空记录" }).click();
    dialog = page.getByRole("dialog", { name: "清空这份周回顾的问答记录？" });
    await dialog.getByRole("button", { name: "清空问答" }).click();
    await expect(page.getByText("问答记录已清空；周回顾、会议、待办和 Evidence 没有改变。")).toBeVisible();
    await expect(page.locator("li[data-role='assistant']")).toHaveCount(0);
    await assertPageHealth(page, telemetry);
  });

  test("keeps nav, Weekly, QA, dialog focus, and controls usable at 390px", async ({ page }) => {
    const state = createState({ ready: true });
    const telemetry = watchTelemetry(page);
    await installFixture(page, state);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/work-review/weekly");

    const nav = page.getByRole("navigation", { name: "工作复盘" });
    await expect(nav.getByRole("link")).toHaveCount(4);
    await expect(nav.getByRole("link", { name: "周回顾" })).toHaveAttribute("aria-current", "page");

    const reviewTab = page.getByRole("tab", { name: "本周回顾" });
    await reviewTab.focus();
    await reviewTab.press("End");
    await expect(page.getByRole("tab", { name: "问问本周" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "本周回顾" }).click();

    const opener = sectionWithHeading(page, "本周概览").getByRole("button", { name: "来源 1" });
    await opener.focus();
    await opener.click();
    const sourceDialog = page.getByRole("dialog", { name: "原话证据" });
    await expect(sourceDialog).toBeVisible();
    expect(await sourceDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(sourceDialog).toBeHidden();
    await expect(opener).toBeFocused();

    await page.getByRole("tab", { name: "问问本周" }).click();
    const question = page.getByLabel("继续问这一周");
    await question.fill("这周还有哪些未结束事项？");
    await question.scrollIntoViewIfNeeded();
    const obstruction = await question.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const top = document.elementFromPoint(centerX, centerY);
      return {
        bottom: Math.round(rect.bottom),
        viewportHeight: window.innerHeight,
        centerOwned: top === element || element.contains(top) || Boolean(top && top.contains(element))
      };
    });
    expect(obstruction.bottom).toBeLessThanOrEqual(obstruction.viewportHeight);
    expect(obstruction.centerOwned).toBe(true);

    await hideNextDevIndicator(page);
    await page.screenshot({ path: `${OUTPUT_DIR}/weekly-qa-mobile-390.png`, fullPage: true });
    await assertPageHealth(page, telemetry);
  });
});

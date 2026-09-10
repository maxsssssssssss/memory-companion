import type { BrowserContext, Page, Route } from "@playwright/test";
import type {
  WorkEvidenceView, WorkMeetingCandidate, WorkMeetingDetail, WorkWeeklyLiveSourceResponse
} from "../../src/lib/client/work-review-api";
import type { WorkProject } from "../../src/lib/domain/work-project";
import type {
  WorkWeeklyQaMessage, WorkWeeklyQaRun, WorkWeeklyQaThread, WorkWeeklyReview,
  WorkWeeklyReviewItem, WorkWeeklySectionKind
} from "../../src/lib/domain/work-weekly";

// Browser transport data only. This fixture never imports repositories or Providers.
export const NOW = "2026-09-09T04:00:00.000Z";
export const ACCOUNT_ID = "ui_acceptance_account";
export const MEETING_ID = "ui_acceptance_meeting";
export const REVIEW_ID = "ui_acceptance_weekly";
export const DIGEST = "a".repeat(64);
export const SOURCE_REF = "evidence:ui_publication:ui_segment_1";
export const ORIGINAL = "匿名原文：先完成样例检查，再讨论下一步安排。";
export const PERSONAL_TEXT = "用户保留的修改：先核对已确认范围，再安排后续事项。";
export const LONG_TEXT = "本周围绕匿名项目的准备工作展开，已确认的决定与仍需讨论的事项保持区分。样例检查记录了完成情况，待办状态仅代表系统内的标记，下一步安排仍需要逐项确认。".repeat(5);

function project(id: string, name: string, status: "active" | "archived" = "active"): WorkProject {
  return { contractVersion: 1, id, accountId: ACCOUNT_ID, name, description: "匿名验收项目。",
    status, version: 0, createdAt: NOW, updatedAt: NOW, archivedAt: status === "archived" ? NOW : null };
}

const evidence: WorkEvidenceView = {
  publicationId: "ui_publication", segmentId: "ui_segment_1", startSeconds: 42, endSeconds: 58,
  rawSpeakerLabel: "Speaker 1", timestampQuality: "provider_exact", text: ORIGINAL,
  contextBefore: "匿名上文：开始核对。", contextAfter: "匿名下文：继续讨论。"
};

function candidate(kind: WorkMeetingCandidate["kind"], title: string): WorkMeetingCandidate {
  return { id: `ui_candidate_${kind}`, kind, title, body: `${title}的匿名待确认内容。`,
    status: "pending_review", publicationAction: "show_as_candidate", version: 0,
    riskLevel: ["decision", "action_item", "commitment", "plan_change"].includes(kind) ? "high" : "low",
    evidence: [evidence], structuredData: {
      decisionFinality: kind === "decision" ? "unclear" : null,
      rawActorLabel: null, candidateOwner: null, dueAt: null, originalDueExpression: null,
      actionBasis: null, relatedCommitmentCandidateId: null, planStages: []
    }, ...(kind === "decision" ? { decisionFinality: "unclear" as const } : {}),
    ...(kind === "plan_change" ? { planChangeStages: [
      { text: "先核对范围", status: "早期方案", evidence: [evidence] },
      { text: "先核对样例", status: "会议后段方案", evidence: [evidence] }
    ] } : {}) };
}

function item(id: string, section: WorkWeeklySectionKind, systemText: string, sortOrder = 0): WorkWeeklyReviewItem {
  return { contractVersion: 1, id, accountId: ACCOUNT_ID, weeklyReviewId: REVIEW_ID, section,
    origin: "gpt", systemText, userText: null, sourceRefs: [SOURCE_REF], verificationState: "verified",
    sortOrder, systemVersion: 2, version: 0, userEditedAt: null, hiddenAt: null, invalidatedAt: null,
    createdAt: NOW, updatedAt: NOW };
}

export function createFixture() {
  const projects = [project("ui_project_a", "匿名项目甲"), project("ui_project_b", "匿名项目乙"),
    project("ui_project_c", "匿名项目丙"), project("ui_project_d", "匿名项目丁"),
    project("ui_project_old", "匿名归档项目", "archived")];
  const ref = ({ id, name, status, version }: WorkProject) => ({ id, name, status, version });
  const candidates = [candidate("decision", "核对样例范围"), candidate("action_item", "准备检查清单"),
    candidate("commitment", "候选承诺事项"), candidate("open_question", "待确认的范围问题"),
    candidate("plan_change", "样例顺序变化"), candidate("proposal", "匿名建议事项"),
    candidate("discussion_topic", "匿名讨论事项")];
  const meeting: WorkMeetingDetail = {
    meeting: { id: MEETING_ID, title: "匿名项目范围会", meetingDate: "2026-09-08", version: 4,
      sourceUploadId: "ui_upload", ingestionStatus: "transcript_ready", analysisStatus: "review_ready",
      reviewStatus: "in_progress", durationSeconds: 360, pendingCandidateCount: candidates.length,
      canonicalSegmentCount: 4, verifierMode: "enabled", canonicalPublicationId: "ui_publication",
      canonicalContentDigest: DIGEST, projects: [ref(projects[0]!), ref(projects[4]!)],
      createdAt: NOW, updatedAt: NOW },
    transcriptSegments: ["Speaker 1", "speaker2", "speaker3", "未确认姓名样例"].map((speaker, i) => ({
      id: `ui_segment_${i + 1}`, uploadId: "ui_upload", startSeconds: 42 + i * 20,
      endSeconds: 58 + i * 20, speaker, text: i === 0 ? ORIGINAL : `匿名原文第 ${i + 1} 段：继续核对样例。`
    })), candidates,
    findings: [{ id: "ui_confirmed_finding", sourceCandidateId: "ui_prior_candidate", kind: "decision",
      title: "已确认的样例决定", body: "已确认只使用匿名样例。", decisionFinality: "final", version: 2,
      evidence: [evidence], createdAt: NOW, updatedAt: NOW }],
    todoProjections: [], linkedTodoCount: 0,
    speakerAliases: [{ rawLabel: "Speaker 1", displayLabel: "已保存称呼甲", version: 1 }]
  };
  const sourceSummary = { meetingCount: 1, findingCount: 1, todoCount: 1, todoEventCount: 1,
    evidenceCount: 4, projectCount: 1, pendingCandidateCount: 7, includedFindingCount: 1,
    includedTodoCount: 1, includedTodoEventCount: 1, includedEvidenceCount: 4,
    omittedFindingCount: 0, omittedTodoCount: 0, omittedTodoEventCount: 0, omittedEvidenceCount: 0,
    truncated: false, historyCompleteness: "exact" as const };
  const review: WorkWeeklyReview = { contractVersion: 1, id: REVIEW_ID, accountId: ACCOUNT_ID,
    scope: { weekStart: "2026-09-07", weekEnd: "2026-09-13", observedThrough: "2026-09-09",
      timeZone: "Asia/Shanghai", scopeKind: "all", projectId: null, windowComplete: false },
    status: "ready", sourceSnapshotDigest: DIGEST, sourceSummary, currentSystemVersion: 2,
    currentRunVersion: 2, version: 7, generatedAt: NOW, updatedAt: NOW, deletedAt: null };
  const oldEdited = { ...item("ui_old_edit", "progress", "旧系统内容"), userText: PERSONAL_TEXT,
    userEditedAt: NOW, systemVersion: 1, version: 3 };
  return { projects, meeting, review, sourceSummary, items: [
    item("ui_overview_a", "overview", LONG_TEXT, 0),
    item("ui_overview_b", "overview", "可重排的第二条匿名概览。", 10), oldEdited,
    item("ui_decision", "decisions", "匿名决定：先核对样例范围。"),
    item("ui_completed", "completed", "检查清单已在系统中标记完成。"),
    item("ui_waiting", "waiting_for_others", "等待匿名协作方确认样例。"),
    item("ui_next", "next_week", "建议下一周继续核对剩余问题。")
  ], capabilities: { projects: true, weekly: true, weeklyAi: true, weeklyVerifier: true,
    weeklyQa: true, weeklyQaVerifier: true },
    qaThread: null as WorkWeeklyQaThread | null, qaMessages: [] as WorkWeeklyQaMessage[],
    qaPending: false, forceItemConflict: false, conflictCount: 0,
    apiRequests: [] as { method: string; path: string }[],
    mutations: [] as { method: string; path: string; input: Record<string, unknown> }[],
    unknownRequests: [] as string[], externalRequests: [] as string[], consoleErrors: [] as string[],
    pageErrors: [] as string[], fixtureErrors: [] as string[] };
}

export type Fixture = ReturnType<typeof createFixture>;

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}

function completeQa(state: Fixture) {
  if (!state.qaPending || !state.qaThread) return;
  state.qaThread.version += 1;
  state.qaMessages.push({ id: `ui_answer_${state.qaThread.version}`, accountId: ACCOUNT_ID,
    weeklyReviewId: REVIEW_ID, threadId: state.qaThread.id, role: "assistant",
    text: "匿名 fixture 回答：当前范围已经确认先核对样例。", answerStatus: "answered",
    sourceRefs: [SOURCE_REF], sourceSnapshotDigest: state.review.sourceSnapshotDigest,
    providerProfile: "offline-transport-fixture", promptVersion: "fixture-v1",
    verifierProfile: "offline-transport-fixture", version: state.qaThread.version,
    createdAt: NOW, invalidatedAt: null });
  state.qaPending = false;
}

export async function installFixture(context: BrowserContext, page: Page, state: Fixture, baseURL: string) {
  const origin = new URL(baseURL).origin;
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { (window as unknown as { __uiCopied: string }).__uiCopied = text; }
    } });
  });
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") state.consoleErrors.push(message.text()); });
  await context.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (url.host === new URL(origin).host && url.pathname === "/_next/webpack-hmr") socket.connectToServer();
    else { state.externalRequests.push(`websocket:${url.origin}${url.pathname}`); socket.close(); }
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (url.origin !== origin) {
      state.externalRequests.push(`${method}:${url.origin}${path}`);
      return route.abort("blockedbyclient");
    }
    if (!path.startsWith("/api/")) {
      if (method === "GET" && (path.startsWith("/work-review") || path.startsWith("/_next/")
        || path === "/favicon.ico" || path.startsWith("/icon"))) return route.continue();
      state.unknownRequests.push(`${method}:${path}`);
      return route.abort("blockedbyclient");
    }
    state.apiRequests.push({ method, path });
    const input = method === "GET" ? {} : (request.postDataJSON() ?? {}) as Record<string, unknown>;
    if (method !== "GET") state.mutations.push({ method, path, input });
    const requireCas = (version: number | null) => {
      if (input.expectedVersion !== version || typeof input.operationKey !== "string" || !input.operationKey) {
        throw new Error(`fixture_cas_contract:${method}:${path}`);
      }
    };
    try {
      if (path === "/api/auth/me" && method === "GET") return json(route, { user: {
        id: ACCOUNT_ID, name: "匿名验收用户", email: "fixture@example.com"
      } });
      if (path === "/api/work-reviews/config" && method === "GET") return json(route, {
        limits: { maxUploadBytes: 314572800, maxAudioDurationSeconds: 14400 }, capabilities: state.capabilities
      });
      if (path === "/api/work-reviews/projects" && method === "GET") return json(route, {
        projects: state.projects.filter((p) => url.searchParams.get("status") === "all" || !url.searchParams.get("status") || p.status === url.searchParams.get("status"))
      });
      if (path === "/api/work-reviews/meetings" && method === "GET") {
        const { sourceUploadId: _upload, canonicalPublicationId: _publication, canonicalContentDigest: _digest,
          verifierMode: _verifier, ...listItem } = state.meeting.meeting;
        return json(route, { meetings: [listItem] });
      }
      if (path === `/api/work-reviews/meetings/${MEETING_ID}` && method === "GET") return json(route, state.meeting);
      if (path === `/api/work-reviews/meetings/${MEETING_ID}/projects` && method === "PATCH") {
        requireCas(state.meeting.meeting.version);
        const ids = input.projectIds as string[];
        if (!Array.isArray(ids) || ids.length > 3 || new Set(ids).size !== ids.length) throw new Error("fixture_project_ids_contract");
        state.meeting.meeting.projects = ids.map((id) => {
          const project = state.projects.find((p) => p.id === id);
          if (!project) throw new Error("fixture_project_id_unknown");
          const { name, status, version } = project;
          return { id, name, status, version };
        });
        state.meeting.meeting.version += 1;
        return json(route, { resourceId: MEETING_ID, resourceVersion: state.meeting.meeting.version,
          projects: state.meeting.meeting.projects, changed: true, reused: false });
      }
      const candidatePath = path.match(new RegExp(`^/api/work-reviews/meetings/${MEETING_ID}/candidates/([^/]+)$`));
      if (candidatePath && method === "PATCH") {
        const candidate = state.meeting.candidates.find((c) => c.id === candidatePath[1]);
        if (!candidate || candidate.status !== "pending_review") throw new Error("fixture_candidate_state");
        requireCas(candidate.version);
        if (input.action !== "edit_and_accept") throw new Error("fixture_candidate_action");
        candidate.status = "accepted";
        candidate.version += 1;
        state.meeting.findings.push({ id: "ui_new_finding", sourceCandidateId: candidate.id, kind: candidate.kind,
          title: input.title as string, body: input.body as string, version: 0, evidence: candidate.evidence,
          createdAt: NOW, updatedAt: NOW });
        state.meeting.meeting.pendingCandidateCount = state.meeting.candidates.filter((c) => c.status === "pending_review").length;
        state.meeting.meeting.version += 1;
        return json(route, { ok: true });
      }
      if (path === `/api/work-reviews/meetings/${MEETING_ID}/follow-up` && method === "GET") return json(route, {
        draft: null, sourceStats: { findingCount: 1, todoCount: 0, confirmedResultCount: 1,
          myTodoCount: 0, waitingForOtherTodoCount: 0, unresolvedQuestionCount: 0 }
      });
      if (path === "/api/work-reviews/todos" && method === "GET") return json(route, { todos: [] });
      if ((path === "/api/work-reviews/weekly" || path === `/api/work-reviews/weekly/${REVIEW_ID}`) && method === "GET") {
        return json(route, { review: state.review, items: state.items, sourceSummary: state.sourceSummary });
      }
      if (path === `/api/work-reviews/weekly/${REVIEW_ID}/sources/${encodeURIComponent(SOURCE_REF)}` && method === "GET") {
        const source: WorkWeeklyLiveSourceResponse = {
          identity: { sourceRef: SOURCE_REF, sourceKind: "evidence", sourceId: "ui_segment_1", version: null,
            digest: DIGEST, publicationId: "ui_publication", segmentId: "ui_segment_1", included: true },
          source: { sourceRef: SOURCE_REF, publicationId: "ui_publication", publicationDigest: DIGEST,
            meetingId: MEETING_ID, segmentId: "ui_segment_1", startSeconds: 42, endSeconds: 58,
            rawSpeakerLabel: "Speaker 1", timestampQuality: "provider_exact", text: ORIGINAL }
        };
        return json(route, source);
      }
      const itemPath = path.match(new RegExp(`^/api/work-reviews/weekly/${REVIEW_ID}/items/([^/]+)$`));
      if (itemPath && method === "PATCH") {
        const item = state.items.find((i) => i.id === itemPath[1]);
        if (!item) throw new Error("fixture_item_unknown");
        requireCas(item.version);
        if (state.forceItemConflict) {
          state.forceItemConflict = false; state.conflictCount += 1;
          return json(route, { error: "version_conflict" }, 409);
        }
        if (typeof input.text === "string") { item.userText = input.text; item.userEditedAt = NOW; }
        if (typeof input.hidden === "boolean") item.hiddenAt = input.hidden ? NOW : null;
        if (typeof input.sortOrder === "number") item.sortOrder = input.sortOrder;
        item.version += 1; state.review.version += 1;
        return json(route, { item, reused: false });
      }
      if (path === `/api/work-reviews/weekly/${REVIEW_ID}/qa` && method === "GET") {
        completeQa(state);
        return json(route, state.qaThread ? { thread: state.qaThread, messages: state.qaMessages } : null);
      }
      if (path === `/api/work-reviews/weekly/${REVIEW_ID}/qa` && method === "POST") {
        requireCas(state.qaThread?.version ?? null);
        state.qaThread ??= { id: "ui_qa_thread", accountId: ACCOUNT_ID, weeklyReviewId: REVIEW_ID,
          sourceSnapshotDigest: DIGEST, version: 0, createdAt: NOW, updatedAt: NOW, clearedAt: null };
        state.qaThread.version += 1;
        const questionId = `ui_question_${state.qaThread.version}`;
        state.qaMessages.push({ id: questionId, accountId: ACCOUNT_ID, weeklyReviewId: REVIEW_ID,
          threadId: state.qaThread.id, role: "user", text: input.question as string, answerStatus: null,
          sourceRefs: [], sourceSnapshotDigest: DIGEST, providerProfile: null, promptVersion: null,
          verifierProfile: null, version: state.qaThread.version, createdAt: NOW, invalidatedAt: null });
        state.qaPending = true;
        const run: WorkWeeklyQaRun = { id: `ui_qa_run_${state.qaThread.version}`, accountId: ACCOUNT_ID,
          weeklyReviewId: REVIEW_ID, threadId: state.qaThread.id, questionMessageId: questionId,
          runVersion: state.qaThread.version, sourceSnapshotDigest: DIGEST, state: "queued",
          leaseOwner: null, leaseExpiresAt: null, providerProfile: null, promptVersion: null,
          verifierProfile: null, createdAt: NOW, completedAt: null, errorCode: null };
        return json(route, { thread: state.qaThread, messages: state.qaMessages, run, reused: false });
      }
      state.unknownRequests.push(`${method}:${path}`);
      return json(route, { error: "unhandled_acceptance_fixture_route" }, 500);
    } catch (error) {
      state.fixtureErrors.push(error instanceof Error ? error.message : "fixture_error");
      return json(route, { error: "acceptance_fixture_contract_failure" }, 500);
    }
  });
}

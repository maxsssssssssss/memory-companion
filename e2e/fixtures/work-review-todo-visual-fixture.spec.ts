import { expect, test, type Page, type Route } from "@playwright/test";

import type {
  WorkMeetingDetail,
  WorkMeetingFinding,
  WorkMeetingListItem,
  WorkTodo,
  WorkTodoKind
} from "../../src/lib/client/work-review-api";

const NOW = "2026-09-02T03:00:00.000Z";

function localDay(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function makeTodo(id: string, input: Partial<WorkTodo> = {}): WorkTodo {
  return {
    contractVersion: 1,
    id,
    accountId: "account_fixture",
    kind: "self",
    status: "open",
    origin: "manual",
    title: "整理发布清单",
    notes: null,
    ownerLabel: null,
    currentDueDate: localDay(1),
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
    ...input
  };
}

function evidence(segmentId: string, text: string, startSeconds: number) {
  return {
    publicationId: "wrp_fixture",
    segmentId,
    startSeconds,
    endSeconds: startSeconds + 4,
    rawSpeakerLabel: "Speaker 1",
    timestampQuality: "provider_exact",
    text,
    contextBefore: "上一句会议上下文。",
    contextAfter: "下一句会议上下文。"
  };
}

function finding(
  id: string,
  kind: "action_item" | "commitment",
  title: string,
  actionBasis: WorkMeetingFinding["actionBasis"]
): WorkMeetingFinding {
  return {
    id,
    sourceCandidateId: `candidate_${id}`,
    kind,
    title,
    body: kind === "commitment" ? "客户资料到齐后再确认发布窗口。" : "会后整理并核对发布清单。",
    version: 1,
    candidateOwner: actionBasis === "unowned_follow_up" ? null : "Alex",
    dueAt: `${localDay(2)}T09:00:00.000Z`,
    originalDueExpression: "周五前",
    actionBasis,
    evidence: [evidence(`segment_${id}`, title, 12)],
    createdAt: NOW,
    updatedAt: NOW
  };
}

function meetingDetail(id: string, title: string, findings: WorkMeetingFinding[]): WorkMeetingDetail {
  return {
    meeting: {
      id,
      title,
      meetingDate: localDay(-1),
      ingestionStatus: "transcript_ready",
      analysisStatus: "review_ready",
      reviewStatus: "in_progress",
      durationSeconds: 480,
      pendingCandidateCount: 0,
      canonicalSegmentCount: 3,
      createdAt: NOW,
      updatedAt: NOW,
      sourceUploadId: `upload_${id}`,
      version: 2,
      canonicalPublicationId: "wrp_fixture",
      canonicalContentDigest: "fixture_digest",
      verifierMode: "enabled"
    },
    transcriptSegments: [
      { id: "segment_before", uploadId: `upload_${id}`, startSeconds: 8, endSeconds: 12, speaker: "Speaker 2", text: "先确认本周的发布范围。" },
      { id: `segment_finding_${id}`, uploadId: `upload_${id}`, startSeconds: 12, endSeconds: 16, speaker: "Speaker 1", text: findings[0]?.title ?? "整理发布清单。" },
      { id: "segment_after", uploadId: `upload_${id}`, startSeconds: 16, endSeconds: 20, speaker: "Speaker 2", text: "下次会议再核对一次。" }
    ],
    candidates: [],
    findings,
    todoProjections: [],
    linkedTodoCount: 0,
    speakerAliases: [{ rawLabel: "Speaker 1", displayLabel: "Alex", version: 0, createdAt: NOW, updatedAt: NOW }]
  };
}

type FixtureState = {
  todos: WorkTodo[];
  meetings: Map<string, WorkMeetingDetail>;
  deletedMeetingPolicies: string[];
  nextTodo: number;
};

function createState(): FixtureState {
  return {
    todos: [],
    meetings: new Map([
      ["meeting_delete", meetingDetail("meeting_delete", "发布准备会", [
        finding("finding_action", "action_item", "整理发布清单", "explicit_commitment")
      ])],
      ["meeting_detach", meetingDetail("meeting_detach", "客户跟进会", [
        finding("finding_commitment", "commitment", "跟进客户资料", "unowned_follow_up")
      ])]
    ]),
    deletedMeetingPolicies: [],
    nextTodo: 1
  };
}

function activeTodos(state: FixtureState) {
  return state.todos.filter((todo) => !todo.deletedAt);
}

function listTodos(state: FixtureState, view: string, day: string | null) {
  const items = activeTodos(state);
  if (view === "today") return items.filter((todo) => todo.status === "open" && todo.myDayDate === day);
  if (view === "all") return items.filter((todo) => todo.status === "open" && todo.kind === "self");
  if (view === "waiting") return items.filter((todo) => todo.status === "open" && todo.kind === "waiting_for_other");
  if (view === "completed") return items.filter((todo) => todo.status === "completed");
  return items.filter((todo) => todo.status === "open" && todo.currentDueDate)
    .sort((left, right) => String(left.currentDueDate).localeCompare(String(right.currentDueDate)) || Number(right.isImportant) - Number(left.isImportant));
}

function updateTodo(state: FixtureState, todo: WorkTodo, patch: Partial<WorkTodo>) {
  Object.assign(todo, patch, { version: todo.version + 1, updatedAt: NOW });
  return todo;
}

function response(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: status === 204 ? "" : JSON.stringify(body)
  });
}

async function installFixture(page: Page, state: FixtureState) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (method === "GET" && path === "/api/auth/me") {
      return response(route, { user: { id: "account_fixture", email: "fixture@example.com", name: "测试用户" } });
    }
    if (method === "GET" && path === "/api/work-reviews/config") {
      return response(route, {
        limits: { maxUploadBytes: 300 * 1024 * 1024, maxAudioDurationSeconds: 14_400 }
      });
    }
    if (method === "GET" && path === "/api/work-reviews/todos") {
      return response(route, { todos: listTodos(state, url.searchParams.get("view") ?? "all", url.searchParams.get("day")) });
    }
    if (method === "POST" && path === "/api/work-reviews/todos") {
      const input = request.postDataJSON() as Partial<WorkTodo>;
      const todo = makeTodo(`todo_manual_${state.nextTodo++}`, {
        title: input.title,
        kind: input.kind,
        notes: input.notes,
        ownerLabel: input.ownerLabel,
        currentDueDate: input.currentDueDate,
        isImportant: input.isImportant,
        myDayDate: input.myDayDate
      });
      state.todos.push(todo);
      return response(route, { todo, reused: false });
    }

    const projection = path.match(/^\/api\/work-reviews\/meetings\/([^/]+)\/findings\/([^/]+)\/todo$/u);
    if (method === "POST" && projection) {
      const [, meetingId, findingId] = projection;
      const meeting = state.meetings.get(meetingId!);
      const source = meeting?.findings.find((item) => item.id === findingId);
      const input = request.postDataJSON() as Partial<WorkTodo>;
      if (!meeting || !source) return response(route, { error: "finding_not_found" }, 404);
      const todo = makeTodo(`todo_source_${state.nextTodo++}`, {
        title: input.title,
        kind: input.kind as WorkTodoKind,
        notes: input.notes,
        ownerLabel: input.ownerLabel,
        currentDueDate: input.currentDueDate,
        isImportant: input.isImportant,
        myDayDate: input.myDayDate,
        origin: "meeting_finding",
        sourceMeetingId: meetingId,
        sourceFindingId: source.id,
        sourceFindingVersion: 0,
        sourceFindingKind: source.kind as "action_item" | "commitment",
        sourceOwnerLabel: source.candidateOwner ?? null,
        sourceOriginalDueAt: source.dueAt ?? null,
        sourceOriginalDueExpression: source.originalDueExpression ?? null,
        sourceActionBasis: source.actionBasis ?? null
      });
      state.todos.push(todo);
      meeting.todoProjections.push({
        id: todo.id,
        sourceFindingId: source.id,
        status: todo.status,
        title: todo.title,
        version: todo.version,
        kind: todo.kind,
        currentDueDate: todo.currentDueDate,
        sourceOriginalDueAt: todo.sourceOriginalDueAt,
        sourceOriginalDueExpression: todo.sourceOriginalDueExpression
      });
      meeting.linkedTodoCount = meeting.todoProjections.length;
      return response(route, { todo, reused: false });
    }

    const meetingPath = path.match(/^\/api\/work-reviews\/meetings\/([^/]+)$/u);
    if (meetingPath && method === "GET") {
      const meeting = state.meetings.get(meetingPath[1]!);
      return meeting ? response(route, meeting) : response(route, { error: "meeting_not_found" }, 404);
    }
    if (meetingPath && method === "DELETE") {
      const meetingId = meetingPath[1]!;
      const payload = request.postData() ? request.postDataJSON() as { policy?: string } : {};
      state.deletedMeetingPolicies.push(payload.policy ?? "none");
      for (const todo of activeTodos(state).filter((item) => item.sourceMeetingId === meetingId)) {
        if (payload.policy === "delete_linked_todos") updateTodo(state, todo, { deletedAt: NOW });
        if (payload.policy === "detach_linked_todos") updateTodo(state, todo, {
          origin: "detached_meeting_finding",
          sourceMeetingId: null,
          sourceFindingId: null,
          sourceFindingVersion: null,
          sourceFindingKind: null,
          sourceOwnerLabel: null,
          sourceOriginalDueAt: null,
          sourceOriginalDueExpression: null,
          sourceActionBasis: null,
          sourceDetachedAt: NOW
        });
      }
      state.meetings.delete(meetingId);
      return response(route, null, 204);
    }
    if (method === "GET" && path === "/api/work-reviews/meetings") {
      const meetings: WorkMeetingListItem[] = Array.from(state.meetings.values()).map((item) => item.meeting);
      return response(route, { meetings });
    }

    const todoSource = path.match(/^\/api\/work-reviews\/todos\/([^/]+)\/source$/u);
    if (method === "GET" && todoSource) {
      const todo = activeTodos(state).find((item) => item.id === todoSource[1]);
      const meeting = todo?.sourceMeetingId ? state.meetings.get(todo.sourceMeetingId) : null;
      const source = meeting?.findings.find((item) => item.id === todo?.sourceFindingId);
      if (!todo || !meeting || !source) return response(route, { error: "todo_source_unavailable" }, 409);
      return response(route, {
        todoId: todo.id,
        sourceChanged: true,
        meeting: { id: meeting.meeting.id, title: meeting.meeting.title, meetingDate: meeting.meeting.meetingDate },
        finding: { id: source.id, kind: source.kind, title: source.title, body: source.body, version: source.version, structuredData: {} },
        evidenceContexts: [
          { publicationId: "wrp_fixture", segmentId: "segment_before", text: "先确认本周的发布范围。", startSeconds: 8, endSeconds: 12, rawSpeakerLabel: "Speaker 2", displaySpeakerLabel: null, timestampQuality: "provider_exact", isDirectEvidence: false },
          { publicationId: "wrp_fixture", segmentId: `segment_${source.id}`, text: source.title, startSeconds: 12, endSeconds: 16, rawSpeakerLabel: "Speaker 1", displaySpeakerLabel: "Alex", timestampQuality: "provider_exact", isDirectEvidence: true },
          { publicationId: "wrp_fixture", segmentId: "segment_after", text: "下次会议再核对一次。", startSeconds: 16, endSeconds: 20, rawSpeakerLabel: "Speaker 2", displaySpeakerLabel: null, timestampQuality: "provider_exact", isDirectEvidence: false }
        ]
      });
    }

    const todoAction = path.match(/^\/api\/work-reviews\/todos\/([^/]+)(?:\/(complete|reopen|my-day))?$/u);
    if (todoAction) {
      const todo = state.todos.find((item) => item.id === todoAction[1]);
      if (!todo || todo.deletedAt) return response(route, { error: "todo_not_found" }, 404);
      const action = todoAction[2];
      if (method === "GET" && !action) {
        const meeting = todo.sourceMeetingId ? state.meetings.get(todo.sourceMeetingId) : null;
        const currentFinding = meeting?.findings.find((item) => item.id === todo.sourceFindingId);
        return response(route, {
          todo,
          source: {
            state: todo.origin === "detached_meeting_finding" ? "detached" : meeting ? "changed" : "none",
            sourceChanged: Boolean(currentFinding && currentFinding.version !== todo.sourceFindingVersion),
            currentFindingVersion: currentFinding?.version ?? null,
            meeting: meeting ? { id: meeting.meeting.id, title: meeting.meeting.title, meetingDate: meeting.meeting.meetingDate } : null
          }
        });
      }
      if (method === "PATCH" && !action) {
        const input = request.postDataJSON() as Record<string, unknown>;
        const editableKeys = new Set(["title", "kind", "notes", "ownerLabel", "currentDueDate", "isImportant", "myDayDate"]);
        const editable = Object.fromEntries(
          Object.entries(input).filter(([key]) => editableKeys.has(key))
        ) as Partial<WorkTodo>;
        return response(route, { todo: updateTodo(state, todo, editable), reused: false });
      }
      if (method === "DELETE" && !action) return response(route, { todo: updateTodo(state, todo, { deletedAt: NOW }), reused: false });
      if (method === "POST" && action === "complete") return response(route, { todo: updateTodo(state, todo, { status: "completed", completedAt: NOW }), reused: false });
      if (method === "POST" && action === "reopen") return response(route, { todo: updateTodo(state, todo, { status: "open", completedAt: null, reopenedAt: NOW }), reused: false });
      if (action === "my-day" && method === "POST") {
        const input = request.postDataJSON() as { day: string };
        return response(route, { todo: updateTodo(state, todo, { myDayDate: input.day }), reused: false });
      }
      if (action === "my-day" && method === "DELETE") return response(route, { todo: updateTodo(state, todo, { myDayDate: null }), reused: false });
    }
    return response(route, { error: `unhandled_fixture_route:${method}:${path}` }, 500);
  });
}

async function createTodoThroughDialog(page: Page, title: string, options: { waiting?: boolean; owner?: string; due?: string } = {}) {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("标题").fill(title);
  if (options.waiting) {
    await dialog.getByLabel("等待他人").check();
    await dialog.getByLabel("负责人或等待对象").fill(options.owner ?? "客户");
  }
  if (options.due) await dialog.getByLabel("当前计划日期").fill(options.due);
  await dialog.getByRole("button", { name: "创建待办" }).click();
  await expect(dialog).toBeHidden();
}

test.describe("Work Review V1-3 Todo deterministic browser fixture", () => {
  test("covers manual lifecycle, five views, projections, sources, and both meeting deletion policies", async ({ page }) => {
    const state = createState();
    await installFixture(page, state);

    await page.goto("/work-review");
    await expect(page.getByRole("heading", { name: "今天还没有安排待办" })).toBeVisible();
    await page.screenshot({ path: ".impeccable/review/work-review-todo-empty-desktop.png", fullPage: true });

    await page.getByRole("button", { name: "新建待办" }).first().click();
    await createTodoThroughDialog(page, "完成 Todo 页面", { due: localDay(1) });
    await expect(page.getByRole("button", { name: "完成 Todo 页面" })).toBeVisible();

    await page.getByRole("button", { name: "完成 Todo 页面" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "编辑" }).click();
    const editDialog = page.getByRole("dialog");
    await editDialog.getByLabel("标题").fill("完成 Todo 页面与交互");
    await editDialog.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByRole("button", { name: "完成 Todo 页面与交互" })).toBeVisible();
    await page.getByLabel("完成 Todo 页面与交互的操作").getByRole("button", { name: "移出今天" }).click();
    await expect(page.getByRole("heading", { name: "今天还没有安排待办" })).toBeVisible();

    await page.getByRole("link", { name: "待办", exact: true }).click();
    await expect(page).toHaveURL(/\/work-review\/todos$/u);
    await expect(page.getByRole("button", { name: "完成 Todo 页面与交互" })).toBeVisible();
    await page.getByLabel("完成 Todo 页面与交互的操作").getByRole("button", { name: "加入今天" }).click();
    await page.getByLabel("完成：完成 Todo 页面与交互").click();
    await page.getByRole("tab", { name: "已完成" }).click();
    await expect(page.getByLabel("重新打开：完成 Todo 页面与交互")).toBeVisible();
    await page.getByLabel("重新打开：完成 Todo 页面与交互").click();

    await page.getByRole("tab", { name: "全部" }).click();
    await page.getByRole("button", { name: "新建待办" }).click();
    await createTodoThroughDialog(page, "等待客户资料", { waiting: true, owner: "客户", due: localDay(2) });
    await page.getByRole("tab", { name: "等待他人" }).click();
    await expect(page.getByRole("button", { name: "等待客户资料" })).toBeVisible();
    await page.getByRole("tab", { name: "计划中" }).click();
    await expect(page.getByRole("button", { name: "完成 Todo 页面与交互" })).toBeVisible();
    await expect(page.getByRole("button", { name: "等待客户资料" })).toBeVisible();
    await page.screenshot({ path: ".impeccable/review/work-review-todo-desktop.png", fullPage: true });

    await page.goto("/work-review/meetings/meeting_delete");
    const actionFinding = page.locator("article").filter({ hasText: "整理发布清单" }).first();
    await actionFinding.getByRole("button", { name: "加入我的待办" }).click();
    await createTodoThroughDialog(page, "整理发布清单", { due: localDay(2) });
    await expect(actionFinding.getByText("已加入待办")).toBeVisible();
    await actionFinding.getByRole("button", { name: "查看待办" }).click();
    await expect(page.getByText("来源后来被修改；当前待办没有自动改变。")).toBeVisible();
    await page.getByRole("button", { name: "查看最新来源" }).click();
    await expect(page.getByText("来源会议结果后来被修改。当前待办没有自动改变。")).toBeVisible();
    await expect(page.getByText(/会议原文 2\/3/u)).toBeVisible();
    await expect(page.getByText(/前后文 1\/3/u)).toBeVisible();
    await page.getByRole("button", { name: "关闭" }).last().click();

    await page.getByRole("button", { name: "删除这次会议" }).click();
    const deleteDialog = page.getByRole("dialog");
    await expect(deleteDialog.getByRole("button", { name: "确认删除" })).toBeDisabled();
    await deleteDialog.getByLabel(/删除会议和关联待办/u).check();
    await deleteDialog.getByRole("button", { name: "确认删除" }).click();
    await expect(page).toHaveURL(/\/work-review\/meetings$/u);
    expect(state.deletedMeetingPolicies).toContain("delete_linked_todos");

    await page.goto("/work-review/meetings/meeting_detach");
    const commitmentFinding = page.locator("article").filter({ hasText: "跟进客户资料" }).first();
    await commitmentFinding.getByRole("button", { name: "设为等待他人" }).click();
    await createTodoThroughDialog(page, "跟进客户资料", { waiting: true, owner: "客户", due: localDay(2) });
    await page.getByRole("button", { name: "删除这次会议" }).click();
    const detachDialog = page.getByRole("dialog");
    await detachDialog.getByLabel(/保留待办，但移除会议来源/u).check();
    await detachDialog.getByRole("button", { name: "确认删除" }).click();
    await expect(page).toHaveURL(/\/work-review\/meetings$/u);
    expect(state.deletedMeetingPolicies).toContain("detach_linked_todos");
    const detached = activeTodos(state).find((todo) => todo.title === "跟进客户资料");
    expect(detached).toMatchObject({ origin: "detached_meeting_finding", sourceMeetingId: null, sourceFindingId: null, sourceOriginalDueAt: null });
  });

  test("keeps the Today and Todo navigation usable at 390px", async ({ page }) => {
    const state = createState();
    state.todos.push(
      makeTodo("todo_mobile_self", { title: "核对发布清单", myDayDate: localDay(), currentDueDate: localDay(), isImportant: true }),
      makeTodo("todo_mobile_waiting", { title: "等待客户确认", kind: "waiting_for_other", ownerLabel: "客户", myDayDate: localDay(), currentDueDate: localDay(1) })
    );
    await installFixture(page, state);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/work-review");
    await expect(page.getByRole("button", { name: "核对发布清单" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "工作复盘" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: ".impeccable/review/work-review-todo-mobile-390.png", fullPage: true });
    await page.getByRole("link", { name: "待办", exact: true }).click();
    await expect(page.getByRole("tab", { name: "计划中" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparationView } from "@/lib/domain/date-companion-preparation";
import type { PreviewStorage } from "@/components/date-companion/prepare-notebook/model";
import { createFormalNotebookAdapter, type FormalNotebookAdapter, FORMAL_NOTEBOOK_DRAFT_NAMESPACE } from "./date-companion-notebook";
import { PreparationRequestError, preparationRequest } from "./date-companion-preparation-api";
import { keepPreparationSourceReturnFor, preparationSourceReturn, rememberPreparationSourceReturn } from "./preparation-source-return";

const adapters: FormalNotebookAdapter[] = [];
afterEach(() => { adapters.splice(0).forEach(a => a.dispose()); vi.restoreAllMocks(); });
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } satisfies PreviewStorage & { values: Map<string, string> };
}
function view(id = "discussion-a", patch: Partial<PreparationView> = {}): PreparationView {
  return { id, relationshipId: "relationship-a", currentMeetingId: id, version: 2, title: "周末准备", status: "active", interactionIds: [], allowRetained: false,
    messages: [{ id: "message-a", role: "assistant", kind: "message", text: "可以先听听对方。", origin: "assistant", sources: [], createdAt: "2026-11-17" }],
    items: [{ id: "item-a", text: "先听听对方", status: "suggested", sources: [], createdAt: "2026-11-17", sourceMessageId: "message-a", meetingId: id }],
    events: [], updatedAt: "2026-11-17", createdAt: "2026-11-17", generationStatus: "idle", intent: "", date: null, constraints: [], ...patch };
}
function requestMock(handler: (path: string, init?: RequestInit) => Promise<unknown> | unknown) {
  return vi.fn(async <T,>(path = "", init?: RequestInit) => await handler(path, init) as T);
}
function make(request: (path?: string, init?: RequestInit) => Promise<unknown>, storage = memoryStorage(), extra: Partial<Parameters<typeof createFormalNotebookAdapter>[0]> = {}) {
  const adapter = createFormalNotebookAdapter({ accountId: "account-a", relationshipId: "relationship-a", relationshipName: "林子", relationshipStatus: "established", storage, request: request as typeof preparationRequest, ...extra });
  adapters.push(adapter); return adapter;
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject };
}

describe("formal notebook adapter", () => {
  it("labels a failed discussion GET by its read purpose and retries without a write", async () => {
    let attempts = 0;
    const request = requestMock(() => {
      if (!attempts++) throw new PreparationRequestError("暂时没有收到可确认的结果。", 503, "preparation_unavailable", true);
      return { preparations: [view()], availableSources: [] };
    });
    const adapter = make(request);
    await expect(adapter.load()).rejects.toBeInstanceOf(PreparationRequestError);
    expect(adapter.getSnapshot()).toMatchObject({ error: "暂时打不开这段讨论。", operations: {} });
    await adapter.load();
    expect(adapter.getSnapshot()).toMatchObject({ error: null, currentDiscussionId: "discussion-a" });
    expect(request.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
  it("resumes only the matching discussion, rechecking evidence without hiding owned notes", async () => {
    const saved = view();
    const source = { id: "evidence", interactionId: "record", recordingDate: "2026-11-08", quote: "原记录的文字",
      origin: "direct_conversation" as const, valid: true, href: "/recap", fingerprint: "v1" };
    saved.items[0] = { ...saved.items[0], status: "selected", sources: [source] };
    saved.messages[0] = { ...saved.messages[0], text: "有依据的整理", sources: [source] };
    rememberPreparationSourceReturn("account-a", saved);
    expect(preparationSourceReturn("account-b", saved.relationshipId, saved.id)).toBeUndefined();
    expect(preparationSourceReturn("account-a", "other-relationship", saved.id)).toBeUndefined();
    expect(preparationSourceReturn("account-a", saved.relationshipId, "other-discussion")).toBeUndefined();
    const returning = preparationSourceReturn("account-a", saved.relationshipId, saved.id)!;
    expect(returning.items[0].text).toBe(saved.items[0].text);
    expect(returning.items[0].sources[0]).toMatchObject({ valid: false, quote: "", href: "" });
    expect(returning.messages[0].text).toBe("");
    let attempt = 0;
    const adapter = make(requestMock(() => {
      if (attempt++ === 0) throw new PreparationRequestError("连接暂不可用", 503, "unavailable");
      return { preparations: [saved], availableSources: [] };
    }), memoryStorage(), { initialDiscussionId: saved.id, returningDiscussion: returning });
    expect(adapter.getSnapshot()).toMatchObject({ sourceRefresh: "reading", loading: false });
    await expect(adapter.load()).rejects.toThrow("连接暂不可用");
    expect(adapter.getSnapshot()).toMatchObject({ sourceRefresh: "error", error: null, loading: false });
    expect(adapter.getDiscussion(saved.id)?.items[0]).toEqual(returning.items[0]);
    await adapter.load();
    expect(adapter.getSnapshot().sourceRefresh).toBeUndefined();
    expect(adapter.getDiscussion(saved.id)).toEqual(saved);
    const denied = make(requestMock(() => { throw new PreparationRequestError("无权读取", 403, "forbidden"); }),
      memoryStorage(), { initialDiscussionId: saved.id, returningDiscussion: returning });
    await expect(denied.load()).rejects.toThrow("无权读取");
    expect(denied.getSnapshot()).toMatchObject({ discussions: [], availableSources: [], error: "无权读取" });
    keepPreparationSourceReturnFor("account-b", saved.relationshipId, saved.id);
    expect(preparationSourceReturn("account-a", saved.relationshipId, saved.id)).toBeUndefined();
  });
  it("opening only reads the authenticated catalog; storage contains UI state, never business rows", async () => {
    const storage = memoryStorage(), server = view();
    const request = requestMock(() => ({ preparations: [server], availableSources: [] }));
    const a = make(request, storage); await a.load();
    expect(request).toHaveBeenCalledExactlyOnceWith();
    expect(a.getDiscussion(server.id)).toEqual(server);
    a.writeDraft(server.id, { input: "还没发送", editingId: "item-a", editText: "还没保存" });
    const saved = JSON.parse(storage.values.get(a.storageKey)!);
    expect(a.storageKey.startsWith(FORMAL_NOTEBOOK_DRAFT_NAMESPACE)).toBe(true);
    expect(Object.keys(saved).sort()).toEqual(["drafts", "editVersions", "pending", "schema"]);
    expect(saved.discussions).toBeUndefined(); expect(saved.items).toBeUndefined();
  });

  it("restores an intentional new-discussion draft after refresh without borrowing the latest discussion's input", async () => {
    const storage = memoryStorage(), latest = view("latest-discussion");
    const request = requestMock((path) => path ? { view: latest } : { preparations: [latest], availableSources: [] });
    const a = make(request, storage, { initialDiscussionId: null }); await a.load();
    a.writeDraft(null, { input: "新讨论还没发的句子", inputSelection: [2, 6] });
    a.writeDraft(latest.id, { input: "旧讨论自己的草稿" }); a.dispose();
    const b = make(request, storage, { initialDiscussionId: null }); await b.load();
    expect(b.getSnapshot().currentDiscussionId).toBeNull();
    expect(b.readDraft(null)).toMatchObject({ input: "新讨论还没发的句子", inputSelection: [2, 6] });
    await b.openDiscussion(latest.id); expect(b.readDraft(latest.id).input).toBe("旧讨论自己的草稿");
    b.setCurrentDiscussion(null); expect(b.readDraft(null).input).toBe("新讨论还没发的句子");
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("uses exact formal mutation bodies and never selects optimistically", async () => {
    const saved = view(), response = deferred<{ view: PreparationView }>();
    const request = requestMock((_path, init) => init?.method ? response.promise : { preparations: [saved], availableSources: [] });
    const a = make(request); await a.load();
    const select = a.mutate(saved.id, { operationKey: "select-a", expectedVersion: 2, kind: "select", itemId: "item-a" });
    await Promise.resolve();
    expect(a.getDiscussion(saved.id)?.items[0].status).toBe("suggested");
    response.resolve({ view: view(saved.id, { version: 3, items: [{ ...saved.items[0], status: "selected" }] }) }); await select;
    expect(a.getDiscussion(saved.id)?.items[0].status).toBe("selected");
    const body = JSON.parse(request.mock.calls.at(-1)![1]!.body as string);
    expect(body).toEqual({ operationKey: "select-a", expectedVersion: 2, kind: "select", itemId: "item-a" });
  });

  it("editing accepts the returned shared ID, source and selection state; no local business cache survives", async () => {
    const original = view(), final = view("discussion-a", { version: 3, items: [{ ...original.items[0], text: "先听完再回应" }] });
    const storage = memoryStorage(), request = requestMock((_path, init) => init?.method ? { view: final } : { preparations: [original], availableSources: [] });
    const a = make(request, storage); await a.load();
    a.writeDraft(original.id, { editingId: "item-a", editText: "先听完再回应" });
    await a.mutate(original.id, { operationKey: "edit-a", expectedVersion: 2, kind: "edit", itemId: "item-a", text: "先听完再回应" });
    expect(a.getDiscussion(original.id)?.items[0]).toEqual(final.items[0]);
    expect(a.getDiscussion(original.id)?.items[0].status).toBe("suggested");
    const newBrowser = make(requestMock(() => ({ preparations: [final], availableSources: [] })), memoryStorage());
    await newBrowser.load(); expect(newBrowser.getDiscussion(original.id)?.items[0]).toEqual(final.items[0]);
    expect(JSON.parse(storage.values.get(a.storageKey)!).pending).toEqual({});
  });

  it("unknown create first queries its receipt, recovers the real ID, and never re-POSTs a saved request", async () => {
    const storage = memoryStorage(), saved = view("created-server-id");
    const request = requestMock((path, init) => {
      if (init?.method) throw new PreparationRequestError("连接结果未知", null, "connection_unknown", true);
      if (path.startsWith("?operationKey=")) return { found: true, id: saved.id, deleted: false, view: saved };
      return { preparations: [saved], availableSources: [] };
    });
    const a = make(request, storage); a.writeDraft(null, { input: "我的第一句话", leftScroll: 40 });
    await expect(a.send({ operationKey: "create-once", text: "我的第一句话" })).rejects.toMatchObject({ code: "unknown_result" });
    expect(a.getSnapshot().currentDiscussionId).toBeNull();
    await a.retryOperation("create-once");
    expect(a.getSnapshot().currentDiscussionId).toBe(saved.id);
    expect(a.readDraft(saved.id).leftScroll).toBe(40);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(request.mock.calls.some(([path]) => path === "?operationKey=create-once")).toBe(true);
  });

  it("moves a first-send UI draft into the relationship returned by the server, without creating another relationship", async () => {
    const storage = memoryStorage(), saved = view("first-discussion", { relationshipId: "created-relationship" });
    const request = requestMock((_path, init) => init?.method ? { view: saved } : { preparations: [saved], availableSources: [] });
    const a = make(request, storage, { relationshipId: "", relationshipStatus: "none" });
    const oldKey = a.storageKey;
    a.writeDraft(null, { input: "接下来还想说的草稿", inputSelection: [3, 3] });
    await a.send({ operationKey: "first-send", text: "今天有点紧张" });
    expect(a.storageKey.endsWith(":created-relationship")).toBe(true);
    expect(storage.values.has(oldKey)).toBe(false);
    a.dispose(); const b = make(request, storage, { relationshipId: "created-relationship" }); await b.load();
    expect(b.readDraft(saved.id)).toMatchObject({ input: "接下来还想说的草稿", inputSelection: [3, 3] });
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("an uncommitted unknown operation retries the exact body/key, including after refresh", async () => {
    const storage = memoryStorage(), original = view();
    let attempts = 0;
    const request = requestMock((path, init) => {
      if (path.startsWith("?operationKey=")) return { found: false };
      if (init?.method) { attempts++; if (attempts === 1) throw new PreparationRequestError("未知", null, "connection_unknown", true); return { view: { ...original, version: 3 } }; }
      return { preparations: [original], availableSources: [] };
    });
    const a = make(request, storage); await a.load();
    await expect(a.mutate(original.id, { operationKey: "same-key", expectedVersion: 2, kind: "remove", itemId: "item-a" })).rejects.toMatchObject({ code: "unknown_result" });
    a.dispose();
    const b = make(request, storage); await b.load(); await b.retryOperation("same-key");
    const writes = request.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(2); expect(writes[0][1]?.body).toBe(writes[1][1]?.body);
  });

  it("a fresh retry click first re-reads a successful edit receipt instead of writing the same change twice", async () => {
    const original = view(), final = view("discussion-a", { version: 3, items: [{ ...view().items[0], text: "修改后的文字" }] });
    const request = requestMock((path, init) => {
      if (path.startsWith("?operationKey=")) return { found: true, id: final.id, deleted: false, view: final };
      if (init?.method) throw new PreparationRequestError("响应丢失", null, "connection_unknown", true);
      return { preparations: [original], availableSources: [] };
    });
    const a = make(request); await a.load();
    const input = { expectedVersion: 2, kind: "edit" as const, itemId: "item-a", text: "修改后的文字" };
    await expect(a.mutate(original.id, { ...input, operationKey: "original-save" })).rejects.toMatchObject({ code: "unknown_result" });
    expect(await a.mutate(original.id, { ...input, operationKey: "second-click" })).toEqual(final);
    expect(request.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  });

  it("recovers a failed suggestion from history without resending its text or consuming the next draft", async () => {
    const failed = view("discussion-a", { generationStatus:"failed", generationMessage:"还没生成可留下的建议。",
      messages:[{id:"user-opener",role:"user",kind:"message",text:"给我一句开场白。",sources:[],origin:"user_reflection",createdAt:"2026-11-25"}],
      events:[{id:"stop",kind:"generation_stopped",text:"还没生成可留下的建议。",createdAt:"2026-11-25",ordinal:1,
        data:{failureCode:"missing_suggestions",messageId:"user-opener"}}],items:[] });
    const saved = view(failed.id,{version:4,messages:[...failed.messages,...view().messages]});
    const request = requestMock((_path,init)=> init?.method ? {view:saved} : {preparations:[failed],availableSources:[]});
    const adapter=make(request); await adapter.load();
    adapter.writeDraft(failed.id,{input:"下一题还在写",inputSelection:[1,3]});
    const action={retryMessageId:"user-opener",expectedVersion:failed.version};
    const trigger=Object.values(adapter.getSnapshot().operations)[0].key;
    await Promise.all([adapter.retryOperation(trigger,action),adapter.retryOperation(trigger,action)]);
    const writes=request.mock.calls.filter(([,init])=>init?.method);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("/discussion-a/turns");
    expect(JSON.parse(writes[0][1]!.body as string)).toEqual({...action,operationKey:"retry:user-opener:2"});
    expect(adapter.getDiscussion(failed.id)).toEqual(saved);
    expect(adapter.readDraft(failed.id)).toMatchObject({input:"下一题还在写",inputSelection:[1,3]});
  });
  it("loads full text through the formal record callback and ignores a withdrawn source's late load", async () => {
    const source = { id: "source-z", interactionId: "record-z", recordingDate: "2026-11-16", quote: "我们先去看看。", speakerRole: "self" as const,
      origin: "direct_conversation" as const, valid: true, href: "/date-companion/a/recap?interaction=record-z&segment=segment-z", fingerprint: "original" };
    let saved = view("discussion-a", { items: [{ ...view().items[0], sources: [source] }] });
    const response = deferred<import("@/components/date-companion/prepare-notebook/model").PreviewRecord>();
    const a = make(requestMock(() => ({ preparations: [saved], availableSources: [] })), memoryStorage(), { readRecord: () => response.promise });
    await a.load(); const loading = a.loadRecord(source);
    saved = { ...saved, items: [{ ...saved.items[0], sources: [{ ...source, valid: false, href: "", quote: "" }] }] }; await a.load();
    response.resolve({ id: source.interactionId, title: "真实记录", date: source.recordingDate, fullTranscript: true,
      sources: [source], segments: [{ id: "segment-z", speaker: "我", time: "14:32", text: source.quote }] });
    expect(await loading).toBeNull(); expect(a.getSnapshot().availableSources.every(record => !record.fullTranscript)).toBe(true);
  });

  it("deduplicates double-clicks and a late reply cannot change another discussion's selection or draft", async () => {
    const response = deferred<{ view: PreparationView }>(), a = make(requestMock(() => response.promise));
    a.writeDraft(null, { input: "初次发送" });
    const input = { operationKey: "same-click", text: "初次发送" };
    const first = a.send(input), second = a.send(input); await Promise.resolve();
    a.setCurrentDiscussion("discussion-b"); a.writeDraft("discussion-b", { input: "另一段的草稿" });
    response.resolve({ view: view("discussion-created") }); await Promise.all([first, second]);
    expect(a.getSnapshot().currentDiscussionId).toBe("discussion-b");
    expect(a.readDraft("discussion-b").input).toBe("另一段的草稿");
    expect(a.getDiscussion("discussion-created")?.id).toBe("discussion-created");
    expect(a.getSnapshot().operations["same-click"].attempts).toBe(1);
  });

  it("a known generation failure does not claim another generation when the same operation is re-read", async () => {
    const failed = view("discussion-a", { generationStatus: "failed", generationMessage: "消息已留下，回复暂未完成。" });
    const request = requestMock(() => ({ view: failed })), a = make(request);
    await expect(a.send({ discussionId: failed.id, expectedVersion: 1, operationKey: "generation-a", text: "想聊聊" })).rejects.toMatchObject({ code: "reply_failed" });
    await expect(a.retryOperation("generation-a")).rejects.toMatchObject({ code: "reply_failed" });
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(a.getDiscussion(failed.id)?.generationStatus).toBe("failed");
  });

  it("keeps source provenance and omits invented times; a withdrawn source cannot return from a material cache", async () => {
    const source = { id: "source-z", interactionId: "record-z", recordingDate: "2026-11-16", quote: "这次先去看画。", speakerRole: "self" as const,
      origin: "direct_conversation" as const, valid: true, href: "/date-companion/a/recap?interaction=record-z&segment=segment-z", fingerprint: "actual-fingerprint" };
    let saved = view("discussion-a", { items: [{ ...view().items[0], sources: [source] }] });
    const a = make(requestMock(() => ({ preparations: [saved], availableSources: [{ id: "record-z", title: "另一场见面", recordingDate: "2026-11-16" }] })));
    await a.load();
    const record = a.getSnapshot().availableSources[0];
    expect(record.segments).toEqual([{ id: "segment-z", speaker: "我", text: source.quote, time: "" }]); expect(record.fullTranscript).toBe(false);
    a.updateMaterials({ records: [record] });
    saved = { ...saved, items: [{ ...saved.items[0], sources: [{ ...source, valid: false, quote: "", href: "" }] }] };
    await a.load(); expect(a.getSnapshot().availableSources[0].sources).toEqual([]); expect(a.getSnapshot().availableSources[0].segments).toEqual([]);
  });

  it("another discussion cannot revive the active discussion's withdrawn source with the same canonical ID", async () => {
    const source = { id: "shared-evidence", interactionId: "record-shared", recordingDate: "2026-11-16", quote: "原话属于这场记录。",
      origin: "direct_conversation" as const, valid: true, href: "/date-companion/a/recap?interaction=record-shared&segment=segment-shared", fingerprint: "kept" };
    const active = view("discussion-a", { items: [{ ...view().items[0], sources: [{ ...source, valid: false, href: "", quote: "" }] }] });
    const other = view("discussion-b", { items: [{ ...view().items[0], sources: [source] }] });
    const a = make(requestMock(() => ({ preparations: [active, other], availableSources: [{ id: source.interactionId, title: "正式记录", recordingDate: source.recordingDate }] })), memoryStorage(), { initialDiscussionId: active.id });
    await a.load(); expect(a.getSnapshot().availableSources[0].sources).toEqual([]);
    a.setCurrentDiscussion(other.id); expect(a.getSnapshot().availableSources[0].sources[0].quote).toBe(source.quote);
    a.setCurrentDiscussion(active.id); expect(a.getSnapshot().availableSources[0].sources).toEqual([]);
  });

  it("keeps formally admitted past clues readable independently of this discussion's withdrawn reference grant", async () => {
    const source = { id: "shared-evidence", interactionId: "record-shared", recordingDate: "2026-11-16", quote: "原话属于这场记录。",
      origin: "direct_conversation" as const, valid: true, href: "/date-companion/a/recap?interaction=record-shared&segment=segment-shared", fingerprint: "past-clue" };
    const record = { id: source.interactionId, title: "来源记录", date: source.recordingDate, sources: [source], fullTranscript: true,
      segments: [{ id: "segment-shared", speaker: "我", text: source.quote, time: "1:30" }] };
    const active = view("discussion-a", { items: [{ ...view().items[0], sources: [{ ...source, valid: false, quote: "", href: "", fingerprint: "discussion-grant" }] }] });
    const readRecord = vi.fn(async () => record);
    const a = make(requestMock(() => ({ preparations: [active], availableSources: [] })), memoryStorage(), { readRecord,
      materials: { records: [record], clues: [{ id: "clue-a", group: "recent", text: "已获原页面准入的事实", sources: [source] }] } });
    await a.load(); expect(await a.loadRecord(source)).toEqual(record);
    expect(readRecord).toHaveBeenCalledExactlyOnceWith(source);
    expect(a.getDiscussion(active.id)?.items[0].sources[0]).toMatchObject({ valid: false, quote: "", href: "" });
  });

  it("isolates accounts, relations and discussion drafts, and clears deleted discussion UI data", async () => {
    const storage = memoryStorage(), saved = view();
    const request = requestMock((_path, init) => init?.method === "DELETE" ? { deleted: true } : { preparations: [saved], availableSources: [] });
    const a = make(request, storage); await a.load(); a.setCurrentDiscussion(saved.id);
    a.writeDraft(saved.id, { input: "私有草稿", editingId: "item-a", editText: "未保存编辑" });
    expect(make(request, storage, { accountId: "account-b" }).readDraft(saved.id)).toEqual({});
    expect(make(request, storage, { relationshipId: "relationship-b" }).readDraft(saved.id)).toEqual({});
    expect(a.readDraft(null)).toEqual({});
    await a.removeDiscussion(saved.id, { operationKey: "delete-a", expectedVersion: 2 });
    expect(a.readDraft(saved.id)).toEqual({}); expect(a.getDiscussion(saved.id)).toBeNull();
    a.writeDraft(saved.id, { input: "late draft" }); expect(a.readDraft(saved.id)).toEqual({});
    a.logout(); expect(storage.values.has(a.storageKey)).toBe(false);
  });

  it("does not expose another relationship's catalog or authenticated failure as an empty success", async () => {
    const a = make(requestMock(() => ({ preparations: [view("other", { relationshipId: "relation-other" })], availableSources: [] })));
    await expect(a.load()).rejects.toMatchObject({ code: "unavailable" }); expect(a.getSnapshot().discussions).toEqual([]);
    const b = make(requestMock(() => { throw new PreparationRequestError("登录已过期", 401, "unauthorized"); }));
    b.writeDraft(null, { input: "未发送" }); await expect(b.load()).rejects.toMatchObject({ status: 401 });
    expect(b.getSnapshot().loggedOut).toBe(true); expect(b.readDraft(null)).toEqual({});
  });

  it("preserves unsaved editor text on version conflict, and refuses to silently overwrite a newer server version", async () => {
    let saved = view(); const request = requestMock(() => ({ preparations: [saved], availableSources: [] }));
    const a = make(request); await a.load(); a.writeDraft(saved.id, { editingId: "item-a", editText: "还在修改", editSelection: [1, 3] });
    saved = { ...saved, version: 3 }; await a.load();
    await expect(a.mutate(saved.id, { operationKey: "stale-edit", expectedVersion: 3, kind: "edit", itemId: "item-a", text: "还在修改" })).rejects.toMatchObject({ code: "conflict" });
    expect(a.readDraft(saved.id)).toMatchObject({ editText: "还在修改", editSelection: [1, 3] });
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("resumes an explicitly reviewed edit with the fresh version and intact draft selection, without saving", async () => {
    let saved = view();
    const request = requestMock((path, init) => init?.method ? { view: { ...saved, version: saved.version + 1, items: [{ ...saved.items[0], text: JSON.parse(init.body as string).text }] } }
      : path ? { view: saved } : { preparations: [saved], availableSources: [] });
    const a = make(request); await a.load();
    a.writeDraft(saved.id, { editingId: "item-a", editText: "保留我的新措辞", editSelection: [2, 5], leftScroll: 89 });
    saved = { ...saved, version: 3, items: [{ ...saved.items[0], text: "另一处刚保存的文字" }] };
    await a.load();
    await expect(a.mutate(saved.id, { operationKey: "old-base", expectedVersion: 3, kind: "edit", itemId: "item-a", text: "保留我的新措辞" })).rejects.toMatchObject({ code: "conflict" });
    await a.resumeEditingAfterReview(saved.id, "item-a");
    expect(a.readDraft(saved.id)).toMatchObject({ editText: "保留我的新措辞", editSelection: [2, 5], leftScroll: 89 });
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    await a.mutate(saved.id, { operationKey: "explicit-save", expectedVersion: 3, kind: "edit", itemId: "item-a", text: "保留我的新措辞" });
    expect(a.getDiscussion(saved.id)?.items[0]).toMatchObject({ text: "保留我的新措辞", status: "suggested" });
  });

  it("requires another review if the server wording changed again during conflict recovery", async () => {
    let saved = view(); const request = requestMock(path => path ? { view: saved } : { preparations: [saved], availableSources: [] });
    const a = make(request); await a.load(); a.writeDraft(saved.id, { editingId: "item-a", editText: "我的未保存文字", editSelection: [1, 4] });
    saved = { ...saved, version: 3, items: [{ ...saved.items[0], text: "刚刚又更新了" }] };
    await expect(a.resumeEditingAfterReview(saved.id, "item-a")).rejects.toMatchObject({ code: "conflict" });
    expect(a.getDiscussion(saved.id)?.items[0].text).toBe("刚刚又更新了");
    expect(a.readDraft(saved.id)).toMatchObject({ editText: "我的未保存文字", editSelection: [1, 4] });
    await expect(a.resumeEditingAfterReview(saved.id, "item-a")).resolves.toMatchObject({ version: 3 });
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each(["removed", "invalid", "missing"] as const)("does not resume a %s item after the formal re-read", async kind => {
    let saved = view(); const request = requestMock(path => path ? { view: saved } : { preparations: [saved], availableSources: [] });
    const a = make(request); await a.load(); a.writeDraft(saved.id, { editingId: "item-a", editText: "不能自动丢掉的草稿", editSelection: [1, 3] });
    saved = { ...saved, version: 3, items: kind === "missing" ? [] : [{ ...saved.items[0], status: kind === "removed" ? "removed" : "suggested",
      sources: kind === "invalid" ? [{ id: "invalid", interactionId: "record", recordingDate: "2026-11-17", quote: "", href: "", valid: false, origin: "direct_conversation", fingerprint: "old" }] : [] }] };
    await expect(a.resumeEditingAfterReview(saved.id, "item-a")).rejects.toMatchObject({ code: "unavailable" });
    expect(a.readDraft(saved.id)).toMatchObject({ editText: "不能自动丢掉的草稿", editSelection: [1, 3] });
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("cancel waiting preserves the unknown request and recovers its persisted result by GET", async () => {
    const saved = view(), request = requestMock((path, init) => {
      if (path.startsWith("?operationKey=")) return { found: true, id: saved.id, deleted: false, view: saved };
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new PreparationRequestError("已停止等待", null, "wait_cancelled", true)), { once: true }));
    });
    const a = make(request), sent = a.send({ discussionId: saved.id, expectedVersion: 1, operationKey: "cancel-a", text: "已经发送的消息" });
    await vi.waitFor(() => expect(a.getSnapshot().operations["cancel-a"]?.status).toBe("running"));
    a.cancelWait("cancel-a"); await expect(sent).rejects.toMatchObject({ code: "cancelled" });
    await a.reconcile("cancel-a"); expect(a.getDiscussion(saved.id)).toEqual(saved);
    expect(request.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  });
});

describe("preparation HTTP error information", () => {
  it("retains structured failure and unknown transport information for old and new clients", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "version_conflict" }), { status: 409 }))
      .mockRejectedValueOnce(new Error("offline")));
    await expect(preparationRequest()).rejects.toMatchObject({ status: 409, versionConflict: true, uncertain: false });
    await expect(preparationRequest()).rejects.toMatchObject({ status: null, uncertain: true });
    vi.unstubAllGlobals();
  });
});

import { describe, expect, it } from "vitest";
import { preparationChoiceState } from "@/lib/domain/date-companion-preparation";
import { createPreviewAdapter, visiblePreviewItems } from "./adapter";
import { previewScenarios, PREVIEW_NAMESPACE } from "./fixtures";
import type { PreviewAdapter, PreviewStorage } from "../prepare-notebook/model";

function memoryStorage(): PreviewStorage & { values: Map<string, string> } {
  const values = new Map<string, string>(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
function make(scenario = "normal", storage = memoryStorage(), latency = 1) { return createPreviewAdapter({ scenario, storage, latency }); }
const tick = (ms = 12) => new Promise(resolve => setTimeout(resolve, ms));
const view = (adapter: PreviewAdapter) => adapter.getDiscussion("discussion-main")!;
const change = (a: PreviewAdapter, kind: "edit" | "select" | "remove", itemId: string, key: string, text?: string) => a.mutate("discussion-main", { operationKey: key, expectedVersion: view(a).version, kind, itemId, ...(text ? { text } : {}) });

describe("independent preparation notebook adapter", () => {
  it("seeds 33 distinct documented cases without creating formal records", () => {
    expect(previewScenarios).toHaveLength(33);
    for (const fixture of previewScenarios) {
      const storage = memoryStorage(), a = make(fixture.id, storage);
      expect(a.storageKey.startsWith(PREVIEW_NAMESPACE)).toBe(true);
      expect(a.getSnapshot().scenario).toBe(fixture.id);
      expect(storage.values.size).toBe(0); // Opening does not even persist the seed.
      expect(fixture.trigger).not.toBe(""); a.dispose();
    }
  });
  it("keeps the long source insert identical to its transcript and separate from existing cases",()=>{
    const a=make('long-sources'),normal=make('normal');
    const record=a.getSnapshot().availableSources[0];
    for(const source of record.sources.slice(0,2)){
      const segment=new URL(source.href,'http://preview.local').searchParams.get('segment');
      expect(source.quote.length).toBeGreaterThan(200);
      expect(record.segments.find(s=>s.id===segment)?.text).toBe(source.quote);
      expect(view(a).items.find(i=>i.id==='item-space')?.sources.find(s=>s.id===source.id)?.quote).toBe(source.quote);
    }
    expect(normal.getSnapshot().availableSources[0].sources[0].quote.length).toBeLessThan(80);
    a.dispose();normal.dispose();
  });
  it("starts with exactly two current choices, with prior and withdrawn kept separate", () => {
    const a = make(), v = view(a);
    expect(v.items.filter(i => preparationChoiceState(v, i) === "current")).toHaveLength(2);
    expect(v.items.filter(i => preparationChoiceState(v, i) === "earlier")).toHaveLength(1);
    expect(v.items.filter(i => preparationChoiceState(v, i) === "withdrawn")).toHaveLength(1);
    expect(v.items.filter(i => i.status === "suggested")).toHaveLength(0); a.dispose();
  });
  it("isolates the third-note fixture and produces a genuinely long reply with the same operation", async () => {
    const bottom=make('bottom-edit'),normal=make(),long=make('long-reply');
    expect(view(bottom).items.filter(i=>preparationChoiceState(view(bottom),i)==='current')).toHaveLength(3);
    expect(view(normal).items.filter(i=>preparationChoiceState(view(normal),i)==='current')).toHaveLength(2);
    const before=view(long).messages.length;
    await long.send({discussionId:'discussion-main',operationKey:'long-arrival',text:'给我一个建议。',expectedVersion:view(long).version});
    expect(view(long).messages.at(-1)?.text.length).toBeGreaterThan(250);
    expect(view(long).messages).toHaveLength(before+2);
    expect(view(long).items.filter(i=>i.status==='suggested')).toHaveLength(1);
    expect(Object.keys(long.getSnapshot().operations)).toEqual(['long-arrival']);
    bottom.dispose();normal.dispose();long.dispose();
  });
  it("editing a proposal preserves its suggested state, sources and shared ID", async () => {
    const a = make("one-candidate"), original = view(a).items[0];
    const result = await change(a, "edit", original.id, "edit-one", "见面时，先问问小画册有没有新进展。");
    expect(result.items[0]).toMatchObject({ id: original.id, status: "suggested", text: "见面时，先问问小画册有没有新进展。", sources: original.sources });
    a.dispose();
  });
  it("editing a selected note does not revoke the decision", async () => {
    const a = make(); const updated = await change(a, "edit", "item-album", "edit-kept", "带相册，时间来得及再一起翻。");
    expect(updated.items.find(i => i.id === "item-album")?.status).toBe("selected");
    expect(updated.items.find(i => i.id === "item-album")?.sourceMessageId).toBe("message-album"); a.dispose();
  });
  it("failed selection shows no optimistic selected note, and retry applies once", async () => {
    const a = make("select-failure");
    await expect(change(a, "select", "item-candidate", "same-key")).rejects.toMatchObject({ code: "write_failed" });
    expect(view(a).items.find(i => i.id === "item-candidate")?.status).toBe("suggested");
    await change(a, "select", "item-candidate", "same-key"); await change(a, "select", "item-candidate", "same-key");
    expect(view(a).events.filter(e => e.kind === "select" && e.data.itemId === "item-candidate")).toHaveLength(1); a.dispose();
  });
  it("failed edit leaves the selected text and status untouched", async () => {
    const a = make("edit-failure"), original = view(a).items[0];
    await expect(change(a, "edit", original.id, "edit-fail", "新措辞")).rejects.toMatchObject({ code: "write_failed" });
    expect(view(a).items[0]).toEqual(original);
    await change(a, "edit", original.id, "edit-fail", "新措辞"); expect(view(a).items[0].text).toBe("新措辞"); a.dispose();
  });
  it("removal is not deselection with an invented restore operation", async () => {
    const a = make("one-candidate"); await change(a, "remove", "item-candidate", "remove-never");
    expect(visiblePreviewItems(view(a))).toHaveLength(0);
    await expect(change(a, "select", "item-candidate", "restore")).rejects.toMatchObject({ code: "unavailable" }); a.dispose();
    const b = make(); await change(b, "remove", "item-album", "remove-kept");
    expect(preparationChoiceState(view(b), view(b).items[0])).toBe("withdrawn"); b.dispose();
  });
  it("safely hides withdrawn source prose in every returned assistant projection", async () => {
    const a = make("invalid-source"), v = view(a), selected = v.items.find(i => i.id === "item-space")!;
    expect(selected.text).toContain("摄影展"); expect(selected.sources.every(s => !s.valid && !s.quote && !s.href)).toBe(true);
    const assistant = v.messages.find(m => m.id === "message-space")!;
    expect(assistant.text).toBe("这段回复用到的资料已不再使用。");
    expect(visiblePreviewItems(v).some(i => i.id === "item-candidate")).toBe(false);
    await expect(change(a, "select", "item-candidate", "invalid-select")).rejects.toMatchObject({ code: "unavailable" }); a.dispose();
  });
  it("scope and explicit review link are separately revocable grants", async () => {
    const a = make("linked");
    await a.mutate("discussion-main", { operationKey: "scope-none", expectedVersion: view(a).version, kind: "scope", interactionIds: [], allowRetained: false });
    expect(view(a).reviewLink?.available).toBe(true); expect(view(a).items.find(i => i.id === "item-space")?.sources.every(s => s.valid)).toBe(true);
    await a.mutate("discussion-main", { operationKey: "unlink", expectedVersion: view(a).version, kind: "unlink_review" });
    expect(view(a).items.find(i => i.id === "item-space")?.sources.every(s => !s.valid)).toBe(true); a.dispose();
    const b = make("linked"); await b.mutate("discussion-main", { operationKey: "unlink-only", expectedVersion: view(b).version, kind: "unlink_review" });
    expect(view(b).interactionIds).toHaveLength(3); expect(view(b).allowRetained).toBe(true); b.dispose();
  });
  it("restoring a link retains the original meeting ownership", async () => {
    const a = make("linked"), original = view(a).reviewLink!;
    await a.mutate("discussion-main", { operationKey: "unlink", expectedVersion: view(a).version, kind: "unlink_review" });
    await a.mutate("discussion-main", { operationKey: "relink", expectedVersion: view(a).version, kind: "link_review", interactionId: "rec-walk" });
    expect(view(a).reviewLink?.originalMeetingId).toBe(original.originalMeetingId);
    expect(view(a).currentMeetingId).toBe(original.nextMeetingId); a.dispose();
  });
  it("uses formal current/earlier meeting semantics on first feedback and not every detail", async () => {
    const a = make();
    await a.send({ discussionId: "discussion-main", operationKey: "feedback-1", text: "回来记一下，我觉得今天有点累。", kind: "feedback", expectedVersion: view(a).version });
    const nextMeeting = view(a).currentMeetingId; expect(nextMeeting).not.toBe("meeting-next");
    expect(preparationChoiceState(view(a), view(a).items[0])).toBe("earlier");
    await a.send({ discussionId: "discussion-main", operationKey: "feedback-2", text: "再补充一下，我想下次安静坐一会儿。", kind: "feedback", expectedVersion: view(a).version });
    expect(view(a).currentMeetingId).toBe(nextMeeting); a.dispose();
  });
  it("new discussion is created only by the first send and preserves operation identity", async () => {
    const a = make("empty"); a.writeDraft(null, { input: "我想轻松一点" });
    expect(a.getSnapshot().discussions).toHaveLength(0);
    const first = await a.send({ operationKey: "first", text: "我想轻松一点" });
    const again = await a.send({ operationKey: "first", text: "我想轻松一点" });
    expect(first.id).toBe(again.id); expect(a.getSnapshot().discussions).toHaveLength(1); expect(again.messages.filter(m => m.role === "user")).toHaveLength(1); a.dispose();
  });
  it("can talk without historical materials, identity mapping, or candidate generation", async () => {
    const a = make("no-material"); const v = await a.send({ discussionId: "discussion-main", operationKey: "present", expectedVersion: view(a).version, text: "给我一个建议就好。" });
    expect(v.items.at(-1)?.sources).toEqual([]); expect(v.items.at(-1)?.status).toBe("suggested"); a.dispose();
    const b = make("no-candidates"); const result = await b.send({ discussionId: "discussion-main", operationKey: "talk", expectedVersion: view(b).version, text: "只想聊聊" }); expect(result.items).toHaveLength(0); b.dispose();
    const c = make("unmapped"); expect(c.getSnapshot().clues).toEqual([]); expect(c.getSnapshot().availableSources).toHaveLength(3); c.dispose();
  });
  it("obeys turn-local 0–3 candidates and does not treat vague approval as selection", async () => {
    const a = make("three-candidates"); await a.send({ discussionId: "discussion-main", operationKey: "vague", text: "不错", expectedVersion: view(a).version });
    expect(view(a).items.every(i => i.status === "suggested")).toBe(true);
    await a.send({ discussionId: "discussion-main", operationKey: "ambiguous", text: "留下这条", expectedVersion: view(a).version });
    expect(view(a).messages.at(-1)?.text).toContain("你想留下哪一条");
    await a.send({ discussionId: "discussion-main", operationKey: "three-more", text: "比较三条建议", expectedVersion: view(a).version }); expect(view(a).items).toHaveLength(6); a.dispose();
  });
  it("honors an unambiguous explicit selection, and an explicit withdrawal", async () => {
    const a = make("one-candidate");
    await change(a, "edit", "item-candidate", "plain-proposal", "见面时聊聊小画册。");
    await a.send({ discussionId: "discussion-main", operationKey: "explicit-select", text: "留下这条", expectedVersion: view(a).version }); expect(view(a).items[0].status).toBe("selected");
    await a.send({ discussionId: "discussion-main", operationKey: "explicit-remove", text: `撤回：${view(a).items[0].text}`, expectedVersion: view(a).version }); expect(view(a).items[0].status).toBe("removed");
    expect(preparationChoiceState(view(a), view(a).items[0])).toBe("withdrawn"); a.dispose();
  });
  it("unknown result is recovered rather than blindly generated again", async () => {
    const a = make("unknown-result"); const input = { discussionId: "discussion-main", operationKey: "unknown-op", expectedVersion: view(a).version, text: "给我一个建议" };
    await expect(a.send(input)).rejects.toMatchObject({ code: "unknown_result" });
    await expect(a.send(input)).rejects.toMatchObject({ code: "unknown_result" });
    await tick(); const result = await a.reconcile(input.operationKey);
    expect(result?.messages.filter(m => m.id.startsWith("user-") && m.text === input.text)).toHaveLength(1);
    expect(a.getSnapshot().operations[input.operationKey].attempts).toBe(1); expect(a.getSnapshot().operations[input.operationKey].status).toBe("succeeded"); a.dispose();
  });
  it("failed reply must be reconciled before retrying the original operation", async () => {
    const a = make("reply-failure"); const input = { discussionId: "discussion-main", operationKey: "failed-op", expectedVersion: view(a).version, text: "帮我想一句" };
    await expect(a.send(input)).rejects.toMatchObject({ code: "reply_failed" });
    await expect(a.retryOperation(input.operationKey)).rejects.toMatchObject({ code: "unknown_result" });
    await a.reconcile(input.operationKey); const result = await a.retryOperation(input.operationKey);
    expect(result.messages.filter(m => m.role === "user" && m.text === input.text)).toHaveLength(1); expect(a.getSnapshot().operations[input.operationKey].attempts).toBe(2); a.dispose();
  });
  it("cancel waiting does not revoke a saved user message and late result stays on original discussion", async () => {
    const a = make("late", memoryStorage(), 35);
    const promise = a.send({ discussionId: "discussion-main", operationKey: "late-1", expectedVersion: view(a).version, text: "继续聊聊" }).catch(error => error);
    a.cancelWait("late-1"); a.setCurrentDiscussion("discussion-earlier");
    expect((await promise).code).toBe("cancelled"); await tick(160);
    expect(a.getSnapshot().currentDiscussionId).toBe("discussion-earlier"); expect(view(a).messages.at(-1)?.role).toBe("assistant");
    expect(a.getDiscussion("discussion-earlier")?.messages).toHaveLength(2); a.dispose();
  });
  it("a new turn fences an older unfinished reply", async () => {
    const a = make("late", memoryStorage(), 25);
    const first = a.send({ discussionId: "discussion-main", operationKey: "old", expectedVersion: view(a).version, text: "旧问题" }).catch(e => e);
    await a.send({ discussionId: "discussion-main", operationKey: "new", expectedVersion: view(a).version, text: "新问题" }); await first;
    expect(a.getSnapshot().operations.old.status).toBe("cancelled"); expect(a.getSnapshot().operations.new.status).toBe("succeeded");
    expect(view(a).messages.filter(m => m.id.startsWith("reply-"))).toHaveLength(1); a.dispose();
  });
  it("reload finishes a persisted due operation without creating another message", async () => {
    const storage = memoryStorage(), a = make("late", storage, 20);
    const first = a.send({ discussionId: "discussion-main", operationKey: "refresh-op", expectedVersion: view(a).version, text: "刷新之后还在吗" }).catch(e => e); a.dispose(); await first; await tick(90);
    const b = make("late", storage, 1); await b.load(); expect(b.getSnapshot().operations["refresh-op"].status).toBe("succeeded"); expect(view(b).messages.filter(m => m.text === "刷新之后还在吗")).toHaveLength(1); b.dispose();
  });
  it("conflict preserves edits and never overwrites a newer version", async () => {
    const a = make("conflict"), version = view(a).version; a.writeDraft("discussion-main", { editingId: "item-album", editText: "还在写的草稿", editSelection: [2, 5] });
    await expect(change(a, "edit", "item-album", "conflicting", "新的文字")).rejects.toMatchObject({ code: "conflict" });
    expect(view(a).version).toBe(version + 1); expect(a.readDraft("discussion-main").editSelection).toEqual([2, 5]);
    await expect(a.mutate("discussion-main", { operationKey: "stale", expectedVersion: version, kind: "edit", itemId: "item-album", text: "覆盖" })).rejects.toMatchObject({ code: "conflict" }); a.dispose();
  });
  it("preserves separate input, caret, source and reading positions across reload", async () => {
    const storage = memoryStorage(), a = make("normal", storage);
    const draft = { input: "还没发出", inputSelection: [1, 3] as [number, number], editingId: "item-album", editText: "编辑没保存", editSelection: [2, 4] as [number, number], leftScroll: 121, chatScroll: 352, openSources: ["item-album"], focusId: "edit-item-album", mobileView: "chat" as const };
    a.writeDraft("discussion-main", draft); a.writeDraft("discussion-earlier", { input: "另一段话" }); a.writeDraft(null, { input: "新讨论草稿" }); a.dispose();
    const b = make("normal", storage); expect(b.readDraft("discussion-main")).toEqual(draft); expect(b.readDraft("discussion-earlier").input).toBe("另一段话"); expect(b.readDraft(null).input).toBe("新讨论草稿"); expect(view(b).items.filter(i => i.status === "selected")).toHaveLength(3); b.dispose();
  });
  it("namespaces by account, relationship and fixture and clears draft on logout", () => {
    const storage = memoryStorage(), a = make("normal", storage); a.writeDraft(null, { input: "账号A的未发内容" });
    const b = createPreviewAdapter({ scenario: "normal", accountId: "other-account", storage }); expect(b.readDraft(null)).toEqual({});
    const c = createPreviewAdapter({ scenario: "normal", relationshipId: "other-relation", storage }); expect(c.readDraft(null)).toEqual({});
    const d = make("other-person", storage); expect(d.readDraft(null)).toEqual({}); expect(d.getSnapshot().relationshipName).toBe("林舟");
    a.logout(); a.writeDraft(null, { input: "不应复活" }); const again = make("normal", storage); expect(again.getSnapshot().loggedOut).toBe(true); expect(again.readDraft(null)).toEqual({});
    [a, b, c, d, again].forEach(x => x.dispose());
  });
  it("delete clears owned records and drafts while retaining original source records", async () => {
    const storage = memoryStorage(), a = make("delete", storage, 20); a.writeDraft("discussion-main", { input: "即将删除" });
    const pending = a.send({ discussionId: "discussion-main", operationKey: "before-delete", expectedVersion: view(a).version, text: "删除前的问题" }).catch(e => e);
    await a.removeDiscussion("discussion-main", { operationKey: "delete", expectedVersion: view(a).version }); await pending; await tick(25);
    expect(a.getDiscussion("discussion-main")).toBeNull(); expect(a.readDraft("discussion-main")).toEqual({}); expect(a.getSnapshot().availableSources).toHaveLength(3);
    const b = make("delete", storage); expect(b.getDiscussion("discussion-main")).toBeNull(); b.writeDraft("discussion-main", { input: "无法复活" }); expect(b.readDraft("discussion-main")).toEqual({}); a.dispose(); b.dispose();
  });
  it("pause is resumable and mutation fences pending generations", async () => {
    const a = make("paused"); expect(view(a).status).toBe("paused"); await a.send({ discussionId: "discussion-main", operationKey: "continue", text: "我又想聊聊", expectedVersion: view(a).version }); expect(view(a).status).toBe("active"); a.dispose();
    const b = make("normal", memoryStorage(), 20); const response = b.send({ discussionId: "discussion-main", operationKey: "before-pause", text: "再说说", expectedVersion: view(b).version }).catch(e => e);
    await b.mutate("discussion-main", { operationKey: "pause", kind: "pause", expectedVersion: view(b).version }); await response; await tick(25);
    expect(view(b).status).toBe("paused"); expect(b.getSnapshot().operations["before-pause"].status).toBe("cancelled"); b.dispose();
  });
  it("read failure retries the existing storage, not a new seeded discussion", async () => {
    const a = make("read-failure"); await expect(a.load()).rejects.toMatchObject({ code: "read_failed" }); const ids = a.getSnapshot().discussions.map(v => v.id); await a.load(); expect(a.getSnapshot().discussions.map(v => v.id)).toEqual(ids); expect(a.getSnapshot().error).toBeNull(); a.dispose();
  });
  it("cannot reuse a successful receipt for another text, target or discussion", async () => {
    const a = make(); await change(a, "edit", "item-album", "one-decision", "第一次修改");
    await expect(change(a, "edit", "item-space", "one-decision", "另一个对象")).rejects.toMatchObject({ code: "invalid" });
    await expect(change(a, "edit", "item-album", "one-decision", "不同文字")).rejects.toMatchObject({ code: "invalid" });
    await a.send({ discussionId: "discussion-main", operationKey: "one-question", text: "只想聊聊", expectedVersion: view(a).version });
    await expect(a.send({ discussionId: "discussion-earlier", operationKey: "one-question", text: "只想聊聊" })).rejects.toMatchObject({ code: "invalid" }); a.dispose();
  });
  it("supports StrictMode effect cleanup and remount without retaining discarded timers", async () => {
    const a = make("late", memoryStorage(), 5);
    const firstLoad = a.load();
    a.dispose();
    let notifications = 0;
    const unsubscribe = a.subscribe(() => { notifications++; });
    await a.load(); await firstLoad;
    expect(a.getSnapshot().loading).toBe(false);
    const result = await a.send({ discussionId: "discussion-main", operationKey: "strict-remount", text: "重新挂载之后继续聊", expectedVersion: view(a).version });
    expect(result.messages.at(-1)?.role).toBe("assistant"); expect(notifications).toBeGreaterThan(2);
    unsubscribe(); a.dispose();
  });
  it("signing out hides and clears this account across fixtures and relationships only", async () => {
    const storage = memoryStorage(), a = make("normal", storage), b = make("history", storage);
    const relationship = createPreviewAdapter({ scenario: "normal", relationshipId: "another-relation", storage, latency: 1 });
    const otherAccount = createPreviewAdapter({ scenario: "normal", accountId: "another-account", storage, latency: 1 });
    a.writeDraft(null, { input: "当前页" }); b.writeDraft(null, { input: "另一个样例" }); relationship.writeDraft(null, { input: "另一段关系" }); otherAccount.writeDraft(null, { input: "其他账号保留" });
    a.logout(); await b.load(); await relationship.load();
    expect(b.getSnapshot().loggedOut).toBe(true); expect(relationship.readDraft(null)).toEqual({}); expect(otherAccount.readDraft(null).input).toBe("其他账号保留");
    const unseenCase = make("sources", storage); expect(unseenCase.getSnapshot().loggedOut).toBe(true);
    await expect(b.send({ operationKey: "after-logout", text: "不能恢复讨论" })).rejects.toMatchObject({ code: "unavailable" });
    [a, b, relationship, otherAccount, unseenCase].forEach(x => x.dispose());
  });
});

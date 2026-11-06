// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { effectivePreparationInteractionIds, preparationChoiceState } from "@/lib/domain/date-companion-preparation";
import { openDateCompanionDatabase } from "./db";
import { DateCompanionRepository } from "./repository";
import { PreparationRepository } from "./preparation-repository";
import { PreparationSources } from "./preparation-sources";

describe("explicit preparation review association", () => {
  let db: Database.Database;
  let repo: PreparationRepository;
  let dates: DateCompanionRepository;
  let sources: PreparationSources;
  beforeEach(() => {
    db = openDateCompanionDatabase({ filePath: ":memory:" });
    repo = new PreparationRepository(db);
    dates = new DateCompanionRepository(db);
    sources = new PreparationSources(db);
  });
  afterEach(() => db.close());

  function seed(upload: string, userId = "alice", finalize = true) {
    const relationshipId = dates.createOrGetRelationship(userId).relationship.id;
    const { interactionId } = dates.importInteraction({
      userId, relationshipId, sourceUploadId: upload, recordingDate: "2026-11-05",
      originalName: `${upload}.wav`, participants: [{ speakerId: "speaker" }],
      recapCandidates: [{ kind: "moment", proposedText: "一起安静走走", sortOrder: 0,
        evidence: [{ uploadId: upload, sourceSegmentId: `${upload}-only`, startSeconds: 0, endSeconds: 3,
          speakerId: "speaker", quote: `我们去散步吧，${upload}。` }] }],
    });
    if (finalize) {
      const item = dates.getInteractionDetail(userId, relationshipId, interactionId).recapItems[0];
      dates.updateRecap({ userId, interactionId, version: 0, assignments: [{ speakerId: "speaker", role: "companion" }],
        mutations: [{ id: item.id, version: 0, disposition: "kept" }], finalize: true });
    }
    return { relationshipId, interactionId };
  }

  function preparation(relationshipId: string, interactionIds: string[] = []) {
    const text = "明天下午想聊旅行。";
    const { id } = repo.create("alice", relationshipId, { operationKey: "create", text, interactionIds, allowRetained: false });
    const first = repo.begin("alice", id, { operationKey: "first", expectedVersion: 0, kind: "message", text });
    const proposed = repo.commit("alice", id, { generationId: first.generationId!, version: first.version!, text: "可以先轻松开场。",
      suggestions: ["聊旅行见闻"], sources: [], date: "2026-11-06", constraints: ["下午"] });
    return repo.mutate("alice", id, { kind: "select", itemId: proposed.items[0].id,
      expectedVersion: proposed.version, operationKey: "select-original" });
  }

  it("joins exactly one confirmed review and freezes actual original selections without changing base consent", () => {
    const { relationshipId, interactionId } = seed("walk");
    const unused = seed("unused");
    const before = preparation(relationshipId);
    const originalItem = before.items[0];
    const bridgeBefore = db.prepare("SELECT COUNT(*) AS n FROM dc_memory_bridge_outbox").get();
    const request = { kind: "link_review", interactionId, operationKey: "link", expectedVersion: before.version };
    const view = repo.mutate("alice", before.id, request);
    expect(view.reviewLink).toMatchObject({ interactionId, originalMeetingId: originalItem.meetingId,
      nextMeetingId: view.currentMeetingId, originalItemIds: [originalItem.id], available: true });
    expect(view.intent).toBe("");
    expect(view.date).toBeNull();
    expect(view.constraints).toEqual([]);
    expect(view.interactionIds).toEqual([]);
    expect(effectivePreparationInteractionIds(view)).toEqual([interactionId]);
    expect(view.currentMeetingId).not.toBe(originalItem.meetingId);
    expect(repo.mutate("alice", view.id, request)).toEqual(view);
    expect(view.events.filter(e => e.kind === "review_linked")).toHaveLength(1);
    expect(JSON.stringify(view.events.find(e => e.kind === "review_linked")?.data)).not.toContain("我们去散步吧");
    expect(() => repo.mutate("alice", view.id, { ...request, operationKey: "stale" })).toThrow();
    expect(() => repo.mutate("alice", view.id, { ...request, expectedVersion: view.version,
      operationKey: "silent-replace", interactionId: unused.interactionId })).toThrow("preparation_review_already_linked");
    expect(sources.reviewSources("alice", relationshipId, interactionId).map(s => s.interactionId)).toEqual([interactionId]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM dc_memory_bridge_outbox").get()).toEqual(bridgeBefore);
  });

  it("keeps ownership, user reflections and existing consent after detaching, and never reassigns the old selection to another encounter", () => {
    const first = seed("old-walk"), second = seed("new-walk");
    let view = preparation(first.relationshipId, [first.interactionId]);
    const id = view.id, originalId = view.items[0].id;
    const mutate = (operationKey: string, input: { kind: string; itemId?: string; interactionId?: string; text?: string }) => {
      view = repo.mutate("alice", id, { ...input, expectedVersion: view.version, operationKey });
    };
    mutate("link-original", { kind: "link_review", interactionId: first.interactionId });
    const oldGrant = view.reviewLink!.id;
    const feedbackText = "我觉得 Ta 工作很累。我们后来安静地走了走。";
    const feedback = repo.begin("alice", id, { operationKey: "return", expectedVersion: view.version, kind: "feedback", text: feedbackText });
    const linkedSource = sources.reviewSources("alice", first.relationshipId, first.interactionId)[0];
    view = repo.commit("alice", id, { generationId: feedback.generationId!, version: feedback.version!, text: "原话提到散步。",
      suggestions: ["下次问问想坐坐还是走走"], sources: [linkedSource], date: "2026-11-12", constraints: ["依赖本次复盘"] });
    const nextId = view.items[1].id, nextMeeting = view.currentMeetingId;
    expect(view.items[1].meetingId).toBe(nextMeeting);
    expect(view.messages.at(-1)?.reviewLinkId).toBe(oldGrant);
    mutate("choose-next", { kind: "select", itemId: nextId });
    mutate("edit-original", { kind: "edit", itemId: originalId, text: "改一下原准备" });
    mutate("detach", { kind: "unlink_review" });
    expect(view.reviewLink).toBeNull();
    expect(view.date).toBeNull();
    expect(view.constraints).toEqual([]);
    expect(effectivePreparationInteractionIds(view)).toEqual([first.interactionId]);
    expect(view.messages.find(m => m.text === feedbackText)?.origin).toBe("user_reflection");
    expect(view.messages.at(-1)?.reviewLinkId).toBe(oldGrant);
    expect(view.events.find(e => e.kind === "select" && e.data.itemId === originalId)?.text).toBe("聊旅行见闻");
    expect(view.items.map(i => i.status)).toEqual(["selected", "selected"]);

    mutate("relink", { kind: "link_review", interactionId: first.interactionId });
    expect(view.reviewLink?.originalItemIds).toEqual([originalId]);
    expect(view.reviewLink?.id).not.toBe(oldGrant);
    expect(view.currentMeetingId).toBe(nextMeeting);
    mutate("detach-again", { kind: "unlink_review" });
    mutate("different-encounter", { kind: "link_review", interactionId: second.interactionId });
    expect(view.reviewLink?.originalItemIds).toEqual([nextId]);
    expect(view.reviewLink?.originalMeetingId).toBe(nextMeeting);
    expect(view.currentMeetingId).not.toBe(nextMeeting);
    expect(view.items.find(i => i.id === originalId)?.meetingId).not.toBe(view.reviewLink?.originalMeetingId);
  });

  it("can attach after text feedback without replacing a user's new plan date, including legacy P1 selection ownership", () => {
    const { relationshipId, interactionId } = seed("after-feedback");
    let view = preparation(relationshipId);
    const originalId = view.items[0].id;
    const feedback = repo.begin("alice", view.id, { operationKey: "report", expectedVersion: view.version,
      kind: "feedback", text: "我们走了走，下次约在 2026-11-20。" });
    view = repo.commit("alice", view.id, { generationId: feedback.generationId!, version: feedback.version!, text: "好。",
      suggestions: ["在书店碰面"], sources: [], date: "2026-11-20", constraints: ["书店"] });
    const raw = JSON.parse((db.prepare("SELECT body_json FROM dc_preparations WHERE id=?").get(view.id) as {body_json:string}).body_json);
    delete raw.currentMeetingId;
    delete raw.reviewLink;
    delete raw.pendingReviewMeetingId;
    for (const message of raw.messages) delete message.meetingId;
    for (const item of raw.items) delete item.meetingId;
    db.prepare("UPDATE dc_preparations SET body_json=? WHERE id=?").run(JSON.stringify(raw), view.id);
    const migrated = repo.get("alice", view.id);
    expect(migrated.reviewLink).toBeNull();
    expect(migrated.items[0].meetingId).not.toBe(migrated.items[1].meetingId);
    view = repo.mutate("alice", view.id, { kind: "link_review", interactionId, expectedVersion: view.version, operationKey: "attach-after" });
    expect(view.reviewLink?.originalItemIds).toEqual([originalId]);
    expect(view.currentMeetingId).toBe(migrated.currentMeetingId);
    view = repo.mutate("alice", view.id, { kind: "unlink_review", expectedVersion: view.version, operationKey: "detach-after" });
    expect(view.date).toBe("2026-11-20");
    expect(view.constraints).toEqual(["书店"]);
  });

  it("retains next-meeting metadata through supplemental feedback and distinguishes checked fields from old unbound metadata", () => {
    const { relationshipId, interactionId } = seed("review-again");
    let view = preparation(relationshipId);
    expect(repo.metadataSources("alice", view.id)).toMatchObject({ dateChecked: false, constraintsChecked: false });
    view = repo.mutate("alice", view.id, { kind: "link_review", interactionId, expectedVersion: view.version, operationKey: "link" });
    const first = repo.begin("alice", view.id, {
      kind: "feedback", text: "回来记一下。下次确定 2026-11-20，还是在书店见。", expectedVersion: view.version, operationKey: "feedback-one",
    });
    const meetingId = view.currentMeetingId;
    view = repo.commit("alice", view.id, { generationId: first.generationId!, version: first.version!, text: "知道了。",
      suggestions: [], sources: [], date: "2026-11-20", constraints: ["书店"], contextChecked: true });
    expect(view.events.at(-1)?.data.contextChecked).toBe(true);
    expect(repo.metadataSources("alice", view.id)).toMatchObject({ dateChecked: true, constraintsChecked: true });
    const second = repo.begin("alice", view.id, {
      kind: "feedback", text: "补充一下上次见面的情况。我觉得 Ta 那天只是想走一走。", expectedVersion: view.version, operationKey: "feedback-two",
    });
    expect(repo.get("alice", view.id)).toMatchObject({ currentMeetingId: meetingId, date: "2026-11-20", constraints: ["书店"] });
    view = repo.commit("alice", view.id, { generationId: second.generationId!, version: second.version!, text: "这部分是你的观察。",
      suggestions: [], sources: [], constraints: ["安静"] });
    expect(view.events.at(-1)?.data.contextChecked).toBeUndefined();
    expect(repo.metadataSources("alice", view.id)).toMatchObject({ dateChecked: true, constraintsChecked: false });
  });

  it("continues across three text-only encounters and keeps a withdrawn choice in history with its original wording", () => {
    const relationshipId = dates.createOrGetRelationship("alice").relationship.id;
    let view = preparation(relationshipId);
    const id = view.id;
    const initial = view.items[0];
    const firstFeedback = repo.begin("alice", id, { operationKey: "first-return", expectedVersion: view.version, kind: "feedback", text: "我们见完了，上次没有聊旅行。" });
    view = repo.commit("alice", id, { generationId: firstFeedback.generationId!, version: firstFeedback.version!, text: "",
      suggestions: ["问问近来哪本书最喜欢"], sources: [], date: "2026-11-12", constraints: ["傍晚"] });
    const secondId = view.items[1].id, secondMeeting = view.currentMeetingId;
    view = repo.mutate("alice", id, { operationKey: "choose-second", expectedVersion: view.version, kind: "select", itemId: secondId });
    const extra = repo.begin("alice", id, { operationKey: "same-visit", expectedVersion: view.version, kind: "feedback", text: "补充上回，我们还在附近听了音乐。" });
    view = repo.commit("alice", id, { generationId: extra.generationId!, version: extra.version!, text: "收到你的补充。", suggestions: [], sources: [] });
    expect(view.currentMeetingId).toBe(secondMeeting);
    expect(view.date).toBe("2026-11-12");

    const later = repo.begin("alice", id, { operationKey: "second-return", expectedVersion: view.version, kind: "feedback",
      newEncounter: true, text: "我们昨天又见了一次，这回一起去看书了。" });
    view = repo.commit("alice", id, { generationId: later.generationId!, version: later.version!, text: "", suggestions: ["试试新书店"], sources: [] });
    expect(view.currentMeetingId).not.toBe(secondMeeting);
    expect(view).toMatchObject({ date: null, constraints: [], reviewLink: null, interactionIds: [] });
    const third = view.items[2];
    view = repo.mutate("alice", id, { operationKey: "choose-third", expectedVersion: view.version, kind: "select", itemId: third.id });
    expect(view.items.map(item => preparationChoiceState(view, item))).toEqual(["earlier", "earlier", "current"]);
    const text = "我改主意了，这条准备不用了。";
    const request = { operationKey: "withdraw", expectedVersion: view.version, kind: "correction" as const, text, withdrawItemId: third.id };
    const change = repo.begin("alice", id, request);
    expect(repo.begin("alice", id, request)).toEqual(change);
    view = repo.commit("alice", id, { generationId: change.generationId!, version: change.version!, text: "好。", suggestions: [], sources: [] });
    expect(view.items.map(item => preparationChoiceState(view, item))).toEqual(["earlier", "earlier", "withdrawn"]);
    expect(view.items.map(item => item.meetingId)).toEqual([initial.meetingId, secondMeeting, view.currentMeetingId]);
    expect(view.items[2].text).toBe(third.text);
    const reason = view.messages.find(message => message.text === text);
    expect(view.events.filter(event => event.kind === "remove")).toMatchObject([{ data: { itemId: third.id, previousStatus: "selected", reasonEventId: reason?.id } }]);
    expect(view.events.filter(event => event.kind === "select")).toHaveLength(3);
  });

  it("declines the identified current suggestion without withdrawing a different saved choice", () => {
    let view = preparation(dates.createOrGetRelationship("alice").relationship.id);
    const selected = view.items[0];
    const request = repo.begin("alice", view.id, { operationKey: "more", expectedVersion: view.version, kind: "message", text: "另有其他想法吗？" });
    view = repo.commit("alice", view.id, { generationId: request.generationId!, version: request.version!, text: "",
      suggestions: ["可以问一句最近的书", "聊一聊上周看的电影"], sources: [] });
    const decline = repo.begin("alice", view.id, { operationKey: "decline", expectedVersion: view.version, kind: "correction",
      text: "其实问书那条先不留。", withdrawItemId: view.items[1].id });
    view = repo.commit("alice", view.id, { generationId: decline.generationId!, version: decline.version!, text: "知道了。", suggestions: [], sources: [] });
    expect(view.items.map(i => i.status)).toEqual(["selected", "removed", "suggested"]);
    expect(view.items[0].id).toBe(selected.id);
    expect(view.items.map(i => preparationChoiceState(view, i))).toEqual(["current", null, null]);
    expect(view.events.filter(e => e.kind === "remove")).toMatchObject([{ data: { itemId: view.items[1].id, previousStatus: "suggested" } }]);
  });

  it("preserves an earlier explicit review on a later encounter without assigning that recording to the later meeting", () => {
    const { relationshipId, interactionId } = seed("earlier-record");
    let view = preparation(relationshipId);
    view = repo.mutate("alice", view.id, { operationKey: "link", expectedVersion: view.version, kind: "link_review", interactionId });
    const savedLink = view.reviewLink!;
    const feedback = repo.begin("alice", view.id, { operationKey: "another", expectedVersion: view.version,
      kind: "feedback", newEncounter: true, text: "这次是另一次见面，之前那份复盘仍然是上上次的。" });
    view = repo.commit("alice", view.id, { generationId: feedback.generationId!, version: feedback.version!, text: "好。", suggestions: [], sources: [] });
    expect(view.currentMeetingId).not.toBe(savedLink.nextMeetingId);
    expect(view.reviewLink).toEqual(savedLink);
    expect(view.events.filter(event => event.kind === "review_linked")).toHaveLength(1);
    expect(view.events.some(event => event.kind === "review_unlinked")).toBe(false);
  });

  it("keeps P2 JSON decisions, feedback, grants and provenance intact when an older writer appended a P1-shaped message and item", () => {
    const { relationshipId, interactionId } = seed("mixed-revision");
    let view = preparation(relationshipId);
    view = repo.mutate("alice", view.id, { kind: "link_review", operationKey: "link", expectedVersion: view.version, interactionId });
    const gen = repo.begin("alice", view.id, { kind: "feedback", operationKey: "feedback", expectedVersion: view.version, text: "我觉得 Ta 那天想走一走。" });
    const linkedSource = sources.reviewSources("alice", relationshipId, interactionId)[0];
    view = repo.commit("alice", view.id, { generationId: gen.generationId!, version: gen.version!, text: "复盘提到了散步。",
      suggestions: ["问问想在哪里散步"], sources: [linkedSource], date: "2026-11-15", constraints: ["散步"], contextChecked: true });
    const read = () => JSON.parse((db.prepare("SELECT body_json FROM dc_preparations WHERE id=?").get(view.id) as {body_json:string}).body_json);
    const initial = read();
    const extra = { id: "p1-message-appended", role: "assistant", text: "可以只聊聊。", kind: "message",
      origin: "assistant", sources: [], createdAt: "2026-11-06T00:00:00.000Z" };
    const extraItem = { id: "p1-item-appended", sourceMessageId: extra.id, text: "看看附近的地方", status: "suggested", sources: [], createdAt: extra.createdAt };
    const event = { id: extra.id, kind: "assistant_message", text: extra.text, ordinal: initial.events.length,
      createdAt: extra.createdAt, data: { generationId: "p1-gen", sourceIds: [] } };
    initial.messages.push(extra); initial.items.push(extraItem); initial.events.push(event);
    // A future or older writer's extensions must survive an unrelated edit.
    initial.extraEnvelope = { generation: 42 };
    initial.messages[0].extraEnvelope = "legacy message metadata";
    initial.items[0].extraEnvelope = "legacy choice metadata";
    db.prepare("UPDATE dc_preparations SET body_json=? WHERE id=?").run(JSON.stringify(initial), view.id);
    expect(repo.get("alice", view.id).items.at(-1)?.meetingId).toBe(view.currentMeetingId);
    expect(read()).toEqual(initial);
    const beforeVersion = initial.version;
    repo.mutate("alice", view.id, { operationKey: "write-mixed", expectedVersion: beforeVersion, kind: "edit",
      itemId: extraItem.id, text: "一起看看书店" });
    const after = read();
    expect(after.reviewLink).toEqual(initial.reviewLink);
    expect(after.dateSources).toEqual(initial.dateSources);
    expect(after.constraintSources).toEqual(initial.constraintSources);
    expect(after.dateReviewId).toBe(initial.dateReviewId);
    expect(after.constraintsContextChecked).toBe(true);
    expect(after.extraEnvelope).toEqual(initial.extraEnvelope);
    expect(after.messages.slice(0, -1)).toEqual(initial.messages.slice(0, -1));
    expect(after.items.slice(0, -1)).toEqual(initial.items.slice(0, -1));
    expect(after.events.slice(0, -1)).toEqual(initial.events);
    expect(after.items.at(-1)).toMatchObject({ id: extraItem.id, meetingId: initial.currentMeetingId, text: "一起看看书店" });
    expect(after.interactionIds).toEqual(initial.interactionIds);
    expect(after.allowRetained).toBe(initial.allowRetained);
    expect(after.version).toBe(beforeVersion + 1);
  });

  it("rejects cross-account, draft and withdrawn or corrupted source material, including a deletion crossing publication", () => {
    const first = seed("available"), draft = seed("draft", "alice", false), other = seed("other", "bob");
    const view = preparation(first.relationshipId);
    for (const foreignId of [other.interactionId, draft.interactionId, "missing"]) {
      expect(() => repo.mutate("alice", view.id, { kind: "link_review", interactionId: foreignId,
        expectedVersion: view.version, operationKey: foreignId })).toThrow("preparation_review_unavailable");
    }
    expect(() => repo.mutate("bob", view.id, { kind: "link_review", interactionId: first.interactionId,
      expectedVersion: view.version, operationKey: "foreign" })).toThrow();
    const linked = repo.mutate("alice", view.id, { kind: "link_review", interactionId: first.interactionId,
      expectedVersion: view.version, operationKey: "link" });
    const [source] = sources.reviewSources("alice", first.relationshipId, first.interactionId);
    const gen = repo.begin("alice", view.id, { kind: "message", expectedVersion: linked.version, operationKey: "in-flight", text: "回看这次原话" });
    db.prepare("UPDATE dc_interactions SET source_state='explicitly_deleted' WHERE id=?").run(first.interactionId);
    expect(repo.get("alice", view.id).reviewLink?.available).toBe(false);
    expect(sources.reviewSources("alice", first.relationshipId, first.interactionId)).toEqual([]);
    expect(() => repo.commit("alice", view.id, { generationId: gen.generationId!, version: gen.version!,
      text: "晚到回复", suggestions: ["晚到建议"], sources: [source] })).toThrow("preparation_review_changed");
    expect(repo.get("alice", view.id).items.map(i => i.text)).toEqual(["聊旅行见闻"]);
    const detached = repo.mutate("alice", view.id, { kind: "unlink_review", expectedVersion: gen.version!, operationKey: "cancel-grant" });
    expect(() => repo.commit("alice", view.id, { generationId: gen.generationId!, version: gen.version!,
      text: "晚到无来源回复", suggestions: [], sources: [] })).toThrow("preparation_generation_changed");
    expect(effectivePreparationInteractionIds(detached)).toEqual([]);
  });
});

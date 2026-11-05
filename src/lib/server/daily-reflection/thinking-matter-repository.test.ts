import Database from "better-sqlite3";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDailyReflectionDatabase } from "./db";
import { DAILY_REFLECTION_SCHEMA_VERSION, migrateDailyReflectionSchema } from "./schema";
import { ThinkingMatterConflictError, ThinkingMatterNotFoundError, ThinkingMatterRepository } from "./thinking-matter-repository";
import { ThinkingMatterCommitResponseSchema, type ThinkingMatterComparisonInput, type ThinkingMatterView } from "@/lib/domain/reflection-thinking-matter";

let database: Database.Database;
let repository: ThinkingMatterRepository;
let seq = 0;
const account = "thinking-account";

beforeEach(() => {
  database = openDailyReflectionDatabase({ filePath: ":memory:" });
  seq = 0;
  repository = new ThinkingMatterRepository(database, {
    idFactory: () => `test${++seq}`,
    now: () => "2026-11-02T01:00:00.000Z",
  });
});

function comparisonInput(): ThinkingMatterComparisonInput {
  return { question: "先做作品展示还是提供服务？", dimensions: ["当前目标", "时间成本", "尚不确定"],
    options: [
      { name: "作品展示", content: "先向潜在客户展示已有作品。", reasons: ["容易展示当前能力"], limits: ["尚无明确受众"], costs: ["整理两件作品"], unknowns: ["谁会来浏览"] },
      { name: "提供服务", content: "先了解一个具体服务需求。", reasons: ["更快了解真实需求"], limits: ["服务边界待确定"], costs: ["一次需求交流"], unknowns: ["实际需求规模"] },
    ], recommendation: { optionId: null, text: "助手倾向先验证展示对象；这不是用户决定。" } };
}
function compare(view: ThinkingMatterView, comparison = comparisonInput()) {
  const started = repository.beginTurn(account, view.matter.id, { operationKey: `compare_${++seq}`, expectedVersion: view.matter.version, text: "比较这两个方向。" });
  return repository.commitResponse(account, view.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "两个方向的目标、成本与未知信息不同。", comparison });
}

describe("Thinking matter P2 comparison, choice and correction boundaries", () => {
  it("reads an old automatic heading without rewriting history and recovers the last actual user edit", () => {
    const topic = "周末去图书馆读书，还是在家做饭？";
    const bad = "周日下午的上午安排";
    const view = compare(repository.create(account, { question: topic, operationKey: "weekend" }));
    // Recreate the old storage shape in this in-memory compatibility fixture.
    // Neither opening nor listing the legacy matter may rewrite its rows.
    const old = structuredClone(view.matter);
    old.comparison!.question = bad;
    const bytes = JSON.stringify(old);
    const storeOld = database.prepare("UPDATE dr_thinking_matters SET state_json=? WHERE id=?");
    storeOld.run(bytes, old.id);
    expect(repository.get(account, old.id).matter.comparison?.question).toBe(topic);
    expect(repository.list(account)[0].comparison?.question).toBe(topic);
    expect(database.prepare("SELECT state_json FROM dr_thinking_matters WHERE id=?").get(old.id)).toEqual({ state_json: bytes });

    const oldForm = repository.mutate(account, old.id, { kind: "comparison", comparison: { ...comparisonInput(), question: bad },
      operationKey: "pre-upgrade-editor", expectedVersion: old.version });
    expect(oldForm.matter.comparison?.question).toBe(topic);
    const manual = repository.mutate(account, old.id, { kind: "comparison", comparison: { ...comparisonInput(), question: "如何准备午饭？" },
      operationKey: "edit-title", expectedVersion: oldForm.matter.version });
    const editEvent = structuredClone(manual.events.at(-1)!);
    delete editEvent.data.comparisonQuestion; // Old full-form events only had before/after comparison snapshots.
    const storeEvent = database.prepare("UPDATE dr_thinking_events SET event_json=? WHERE id=?");
    storeEvent.run(JSON.stringify(editEvent), editEvent.id);
    const later = compare(manual);
    const laterOld = structuredClone(later.matter);
    laterOld.comparison!.question = bad;
    storeOld.run(JSON.stringify(laterOld), old.id);
    // Legacy user saved an option edit while the incorrect automatic heading was displayed.
    const form = repository.mutate(account, old.id, { kind: "comparison", comparison: comparisonInput(),
      operationKey: "other-field", expectedVersion: laterOld.version });
    const unchangedTitle = structuredClone(form.events.at(-1)!);
    delete unchangedTitle.data.comparisonQuestion;
    for (const key of ["previousComparison", "comparison"])
      (unchangedTitle.data[key] as { question: string }).question = bad;
    storeEvent.run(JSON.stringify(unchangedTitle), unchangedTitle.id);
    const resumed = repository.get(account, old.id);
    expect(resumed.matter.comparison?.question).toBe("如何准备午饭？");
    expect(compare(resumed).matter.comparison?.question).toBe("如何准备午饭？");
    expect(repository.get(account, old.id).events.find(event => event.id === unchangedTitle.id)?.data).toEqual(unchangedTitle.data);
  });

  it("uses a neutral heading for long opening instructions until the user supplies a subject", () => {
    const view = repository.create(account, { question: "请比较几种安排。".repeat(40), operationKey: "long-instructions" });
    const initial = compare(view);
    expect(initial.matter.comparison?.question).toBe("这几个方案怎么选？");
    const edited = repository.mutate(account, view.matter.id, { kind: "edit", question: "周末如何安排？",
      operationKey: "edit-subject", expectedVersion: initial.matter.version });
    expect(compare(edited).matter.comparison?.question).toBe("周末如何安排？");
  });

  it("keeps explicit corrections, rejects a stale response and preserves analysis provenance on a manual title edit", () => {
    const view = compare(create()), before = view.matter.comparison!;
    const start = repository.beginTurn(account, view.matter.id, { text: "继续比较", operationKey: "in-flight", expectedVersion: view.matter.version });
    const manual = repository.mutate(account, view.matter.id, { kind: "comparison", operationKey: "new-title", expectedVersion: start.version,
      comparison: { ...comparisonInput(), question: "周六上午如何安排？" } });
    expect(manual.matter.comparison).toEqual({ ...before, question: "周六上午如何安排？" });
    expect(() => repository.commitResponse(account, view.matter.id, { generationId: start.generationId, expectedVersion: start.version,
      reply: "旧回复", comparison: comparisonInput() })).toThrow(ThinkingMatterConflictError);
    const corrected = repository.mutate(account, view.matter.id, { kind: "correct", understanding: "聚会在下午，午饭需要提前准备。",
      comparisonQuestion: "午饭前可以做什么？", operationKey: "correct-title", expectedVersion: manual.matter.version });
    const resumed = compare(corrected);
    expect(resumed.matter.comparison?.question).toBe("午饭前可以做什么？");
    const titleOnly = repository.mutate(account, view.matter.id, { kind: "correct", understanding: resumed.matter.understanding,
      comparisonQuestion: "准备午饭要留多久？", reason: "只调整题目", operationKey: "title-only", expectedVersion: resumed.matter.version });
    expect(titleOnly.matter.comparison).toEqual({ ...resumed.matter.comparison, question: "准备午饭要留多久？" });
    expect(titleOnly.matter.understandingSourceEventId).toBe(resumed.matter.understandingSourceEventId);
    expect(titleOnly.events.at(-1)).toMatchObject({ kind: "comparison_edited", data: { reason: "只调整题目" } });
  });
  it("reads legacy P1 JSON with defaults without rewriting it or changing schema version", () => {
    const original = reply(create().matter.id, 0);
    const legacy = { ...original.matter } as Record<string, unknown>;
    for (const name of ["comparison", "userChoice", "linkedSources", "understandingSourceEventId", "judgmentsSourceEventId"]) delete legacy[name];
    // Synthetic compatibility fixture only: recreate a pre-P2 stored JSON shape.
    const bytes = JSON.stringify(legacy);
    database.prepare("UPDATE dr_thinking_matters SET state_json=? WHERE account_id=? AND id=?").run(bytes, account, original.matter.id);
    const loaded = repository.get(account, original.matter.id);
    expect(loaded.matter.comparison).toBeNull();
    expect(loaded.matter.userChoice).toEqual({ status: "undecided", optionId: null, reason: "", rejectedIds: [], sourceEventId: null });
    expect(loaded.matter.linkedSources).toEqual([]);
    expect(loaded.matter.understandingSourceEventId).toBeNull();
    expect(database.prepare("SELECT state_json FROM dr_thinking_matters WHERE account_id=? AND id=?").get(account, original.matter.id)).toEqual({ state_json: bytes });
    expect(database.pragma("user_version", { simple: true })).toBe(16);
    const corrected = repository.mutate(account, loaded.matter.id, { kind: "correct", operationKey: "legacy-correct", expectedVersion: loaded.matter.version, understanding: "不是范围问题，而是展示对象不明确。" });
    expect(corrected.events.at(-1)?.data.correctedEventIds).toContain(original.events.at(-1)?.id);
  });

  it("stores dynamic comparison and assistant recommendation without selecting or adopting for the user", () => {
    const view = compare(create());
    const event = view.events.at(-1)!;
    expect(view.matter.comparison?.dimensions).toEqual(["当前目标", "时间成本", "尚不确定"]);
    expect(new Set(view.matter.comparison?.options.map(option => option.id)).size).toBe(2);
    expect(view.matter.comparison?.options.every(option => option.sourceEventId === event.id)).toBe(true);
    expect(view.matter.comparison?.recommendation?.sourceEventId).toBe(event.id);
    expect(view.matter.userChoice.status).toBe("undecided");
    expect(view.matter.arrangements).toEqual([]);
    expect(ThinkingMatterCommitResponseSchema.safeParse({ generationId: "generation", expectedVersion: 1, reply: "讨论", userChoice: { status: "selected" } }).success).toBe(false);
  });

  it("renames options by stable ID and matches a missing ID by normalized name without overwriting explicit user choice", () => {
    let view = compare(create());
    const [first, second] = view.matter.comparison!.options;
    view = repository.mutate(account, view.matter.id, { kind: "choice", operationKey: "select-first", expectedVersion: view.matter.version, status: "selected", optionId: first.id, reason: "我先选展示，方便测试表达。" });
    const choice = structuredClone(view.matter.userChoice);
    const next = comparisonInput();
    next.options[0] = { ...next.options[0], id: first.id, name: "先做展示样例", content: "先测试能否说明作品价值。" };
    next.options[1].name = " 提供服务 ";
    next.recommendation = { optionId: second.id, text: "助手现在倾向先访谈服务需求，等待用户判断。" };
    view = compare(view, next);
    expect(view.matter.comparison!.options.map(option => option.id)).toEqual([first.id, second.id]);
    expect(view.matter.comparison!.options[0].name).toBe("先做展示样例");
    expect(view.matter.comparison!.recommendation?.optionId).toBe(second.id);
    expect(view.matter.userChoice).toEqual(choice);
    expect(view.events.filter(event => event.kind === "assistant_message")).toHaveLength(2);
  });

  it("rejects unknown IDs, duplicate names, duplicate IDs and unknown recommendation targets transactionally", () => {
    const view = compare(create());
    const started = repository.beginTurn(account, view.matter.id, { operationKey: "invalid-comparison", expectedVersion: view.matter.version, text: "继续比较" });
    const before = repository.get(account, view.matter.id);
    const invalids: ThinkingMatterComparisonInput[] = [];
    const unknown = comparisonInput(); unknown.options[0].id = "foreign_option"; invalids.push(unknown);
    const duplicateNames = comparisonInput(); duplicateNames.options[1].name = duplicateNames.options[0].name; invalids.push(duplicateNames);
    const duplicateIds = comparisonInput(); duplicateIds.options[0].id = view.matter.comparison!.options[0].id; duplicateIds.options[1].id = duplicateIds.options[0].id; invalids.push(duplicateIds);
    const badRecommendation = comparisonInput(); badRecommendation.recommendation!.optionId = "foreign_option"; invalids.push(badRecommendation);
    for (const comparison of invalids) {
      expect(() => repository.commitResponse(account, view.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "不能保存", comparison })).toThrow(ThinkingMatterConflictError);
      expect(repository.get(account, view.matter.id)).toEqual(before);
    }
  });

  it("persists undecided, leaning, rejected and changed selection reasons as explicit history without completing an arrangement", () => {
    let view = reply(create().matter.id, 0);
    view = repository.mutate(account, view.matter.id, { kind: "adopt", operationKey: "adopt-action", expectedVersion: view.matter.version, suggestionId: view.matter.suggestions[0].id });
    const arrangement = structuredClone(view.matter.arrangements[0]);
    view = compare(view);
    const [first, second] = view.matter.comparison!.options;
    view = repository.mutate(account, view.matter.id, { kind: "choice", operationKey: "undecided", expectedVersion: view.matter.version, status: "undecided", reason: "先补充信息。" });
    view = repository.mutate(account, view.matter.id, { kind: "choice", operationKey: "leaning", expectedVersion: view.matter.version, status: "leaning", optionId: first.id, reason: "更接近当前能力。", rejectedIds: [second.id] });
    view = repository.mutate(account, view.matter.id, { kind: "choice", operationKey: "changed-choice", expectedVersion: view.matter.version, status: "selected", optionId: second.id, reason: "了解到展示对象其实需要服务。", rejectedIds: [first.id] });
    expect(view.matter.userChoice).toMatchObject({ status: "selected", optionId: second.id, reason: "了解到展示对象其实需要服务。", rejectedIds: [first.id] });
    expect(view.events.filter(event => event.kind === "choice_changed").map(event => event.text)).toEqual(["先补充信息。", "更接近当前能力。", "了解到展示对象其实需要服务。"]);
    expect(view.events.at(-1)?.data.previousChoice).toMatchObject({ status: "leaning", optionId: first.id });
    expect(view.matter.arrangements).toEqual([arrangement]);
  });

  it("saves hand-edited comparison history and fences a previously running model response", () => {
    const view = compare(create());
    const started = repository.beginTurn(account, view.matter.id, { operationKey: "before-edit", expectedVersion: view.matter.version, text: "继续" });
    const comparison = comparisonInput(); comparison.options[0].id = view.matter.comparison!.options[0].id; comparison.options[0].name = "用户改成内容样例";
    const edited = repository.mutate(account, view.matter.id, { kind: "comparison", operationKey: "manual-comparison", expectedVersion: started.version, comparison });
    expect(edited.matter.comparison!.options[0].id).toBe(view.matter.comparison!.options[0].id);
    expect(edited.events.at(-1)?.kind).toBe("comparison_edited");
    expect(edited.events.at(-1)?.data.previousComparison).toEqual(view.matter.comparison);
    expect(edited.matter.comparison!.options[0].sourceEventId).toBe(edited.events.at(-1)?.id);
    expect(() => repository.commitResponse(account, view.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "旧名称", comparison: comparisonInput() })).toThrow(ThinkingMatterConflictError);
    expect(repository.get(account, view.matter.id)).toEqual(edited);
  });

  it("corrects current understanding, clears old judgments and retains their exact historical values", () => {
    let view = reply(create().matter.id, 0);
    const previous = structuredClone(view.matter);
    view = repository.mutate(account, view.matter.id, { kind: "correct", operationKey: "correction", expectedVersion: view.matter.version, understanding: "我不是害怕动手，只是不知道给谁看。", reason: "纠正此前推测。" });
    expect(view.matter.understanding).toBe("我不是害怕动手，只是不知道给谁看。");
    expect(view.matter.judgments).toEqual([]);
    expect(view.matter.understandingSourceEventId).toBe(view.events.at(-1)?.id);
    expect(view.events.at(-1)?.data).toMatchObject({ previousUnderstanding: previous.understanding, previousJudgments: previous.judgments, correctedEventIds: [previous.understandingSourceEventId], reason: "纠正此前推测。" });
    expect(view.events.find(event => event.kind === "assistant_message")?.data.judgments).toEqual(previous.judgments);
  });

  it("archives, reopens and preserves comparison/choice while discarding a late generation", () => {
    let view = compare(create());
    view = repository.mutate(account, view.matter.id, { kind: "choice", operationKey: "select", expectedVersion: view.matter.version, status: "leaning", optionId: view.matter.comparison!.options[0].id, reason: "先留个倾向。" });
    const comparison = structuredClone(view.matter.comparison), choice = structuredClone(view.matter.userChoice);
    const started = repository.beginTurn(account, view.matter.id, { operationKey: "before-archive", expectedVersion: view.matter.version, text: "继续" });
    const archive = { kind: "status" as const, operationKey: "archive", expectedVersion: started.version, status: "archived" as const, reason: "先收起来。" };
    view = repository.mutate(account, view.matter.id, archive);
    expect(view.matter.status).toBe("archived"); expect(view.matter.activeGeneration).toBeNull();
    expect(() => repository.beginTurn(account, view.matter.id, { operationKey: "archived-turn", expectedVersion: view.matter.version, text: "不能后台推进" })).toThrow("thinking_matter_not_active");
    expect(() => repository.commitResponse(account, view.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "晚到" })).toThrow(ThinkingMatterConflictError);
    view = repository.mutate(account, view.matter.id, { kind: "status", operationKey: "reopen", expectedVersion: view.matter.version, status: "active" });
    expect(view.matter.comparison).toEqual(comparison); expect(view.matter.userChoice).toEqual(choice);
    expect(repository.mutate(account, view.matter.id, archive).matter.status).toBe("active");
  });

  it("stores verified source references from creation and link/unlink mutations, never cached source text", () => {
    const source = { sourceId: "card_one", version: "canonical-1", kind: "card" as const };
    let view = repository.create(account, { operationKey: "create-source", question: "从这张卡片继续想", source });
    expect(view.matter.contextMode).toBe("none");
    expect(view.matter.linkedSources).toEqual([{ ...source, sourceEventId: view.events[0].id }]);
    view = repository.mutate(account, view.matter.id, { kind: "link_source", operationKey: "link-updated-source", expectedVersion: view.matter.version, source: { ...source, version: "canonical-2" } });
    expect(view.matter.linkedSources).toHaveLength(1); expect(view.matter.linkedSources[0].version).toBe("canonical-2");
    const started = repository.beginTurn(account, view.matter.id, { operationKey: "linked-turn", expectedVersion: view.matter.version, text: "继续" });
    view = repository.mutate(account, view.matter.id, { kind: "unlink_source", operationKey: "withdraw-link", expectedVersion: started.version, sourceId: source.sourceId });
    expect(view.matter.linkedSources).toEqual([]);
    expect(view.events.at(-1)?.data.removed).toHaveLength(1);
    expect(() => repository.commitResponse(account, view.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "迟到的来源内容" })).toThrow(ThinkingMatterConflictError);
  });

  it("atomically saves natural choice with the turn/generation receipt and rejects stale or conflicting replays", () => {
    const view = compare(create()), optionId = view.matter.comparison!.options[0].id;
    const input = { operationKey: "atomic-choice", expectedVersion: view.matter.version, text: "我选作品展示，因为更容易说明。", choice: { status: "selected" as const, optionId, reason: "更容易说明。" }, taskId: "atomic-task" };
    const started = repository.beginTurn(account, view.matter.id, input);
    expect(started.view.events.slice(-2).map(event => event.kind)).toEqual(["choice_changed", "user_message"]);
    expect(started.view.events.slice(-2).every(event => event.matterVersion === started.version)).toBe(true);
    expect(started.view.matter.userChoice.optionId).toBe(optionId);
    expect(repository.beginTurn(account, view.matter.id, input)).toEqual(started);
    const edited = repository.mutate(account, view.matter.id, { kind: "edit", operationKey: "concurrent-edit", expectedVersion: started.version, goal: "用户新目标" });
    expect(repository.beginTurn(account, view.matter.id, input).view).toEqual(edited);
    expect(edited.events.filter(event => event.kind === "choice_changed")).toHaveLength(1);
    expect(() => repository.beginTurn(account, view.matter.id, { ...input, choice: { ...input.choice, reason: "冲突原因" } })).toThrow("thinking_matter_operation_conflict");
    expect(() => repository.beginTurn(account, view.matter.id, { ...input, operationKey: "new-stale-key" })).toThrow("thinking_matter_version_conflict");
    expect(() => repository.commitResponse(account, view.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "旧生成" })).toThrow(ThinkingMatterConflictError);
  });

  it("isolates all new mutation identities by account and rejects invalid choice references without writes", () => {
    const view = compare(create()), optionId = view.matter.comparison!.options[0].id;
    const mutations = [
      { kind: "comparison" as const, comparison: comparisonInput() },
      { kind: "choice" as const, status: "selected" as const, optionId, reason: "越权选择" },
      { kind: "correct" as const, understanding: "越权纠正" },
      { kind: "link_source" as const, source: { sourceId: "card", version: "v1", kind: "card" as const } },
      { kind: "unlink_source" as const, sourceId: "card" },
    ];
    for (const mutation of mutations) expect(() => repository.mutate("other-account", view.matter.id, { ...mutation, operationKey: `foreign-${mutation.kind}`, expectedVersion: view.matter.version })).toThrow(ThinkingMatterNotFoundError);
    expect(() => repository.mutate(account, view.matter.id, { kind: "choice", operationKey: "unknown-option", expectedVersion: view.matter.version, status: "selected", optionId: "foreign", reason: "无效" })).toThrow("thinking_choice_option_unknown");
    expect(() => repository.mutate(account, view.matter.id, { kind: "choice", operationKey: "self-rejected", expectedVersion: view.matter.version, status: "selected", optionId, rejectedIds: [optionId], reason: "冲突" })).toThrow("thinking_choice_rejected_options_invalid");
    expect(repository.get(account, view.matter.id)).toEqual(view);
  });

  it("replays exact choice receipts before live validation while rejecting changed payloads or new stale writes", () => {
    const compared = compare(create()), optionId = compared.matter.comparison!.options[0].id;
    let available = true, guards = 0;
    const guard = () => { guards += 1; if (!available) throw new Error("source_unavailable"); };
    const input = { kind: "choice" as const, operationKey: "guarded-choice", expectedVersion: compared.matter.version, status: "selected" as const, optionId, reason: "明确选择" };
    const selected = repository.mutate(account, compared.matter.id, input, { beforeWrite: guard });
    const corrected = repository.mutate(account, compared.matter.id, { kind: "correct", operationKey: "after-choice-correction", expectedVersion: selected.matter.version, understanding: "当前目标已修正。" });
    available = false;
    expect(repository.mutate(account, compared.matter.id, input, { beforeWrite: guard })).toEqual(corrected);
    expect(guards).toBe(1);
    expect(() => repository.mutate(account, compared.matter.id, { ...input, reason: "不同原因" }, { beforeWrite: guard })).toThrow("thinking_matter_operation_conflict");
    expect(() => repository.mutate(account, compared.matter.id, { ...input, operationKey: "new-choice", expectedVersion: corrected.matter.version }, { beforeWrite: guard })).toThrow("source_unavailable");
    expect(repository.get(account, compared.matter.id)).toEqual(corrected);
    expect(corrected.events.filter(event => event.kind === "choice_changed")).toHaveLength(1);
    expect(() => repository.mutate("other-account", compared.matter.id, input, { beforeWrite: guard })).toThrow(ThinkingMatterNotFoundError);
  });

  it("binds creation receipts to stable public input and only resolves a source for a genuinely new write", () => {
    const input = { operationKey: "deferred-create", question: "从卡片继续想" };
    const publicInput = { ...input, sourceCardId: "card_one", sourceCardVersion: 1 };
    let available = true, resolutions = 0;
    const resolve = (value: typeof input) => { resolutions += 1; if (!available) throw new Error("source_unavailable"); return { ...value, source: { sourceId: "card_one", version: "canonical-hash-1", kind: "card" as const } }; };
    const created = repository.create(account, input, { receiptInput: publicInput, beforeWrite: resolve });
    expect(created.matter.linkedSources[0].version).toBe("canonical-hash-1");
    available = false;
    expect(repository.create(account, input, { receiptInput: publicInput, beforeWrite: resolve })).toEqual(created);
    expect(resolutions).toBe(1);
    expect(() => repository.create(account, input, { receiptInput: { ...publicInput, sourceCardVersion: 2 }, beforeWrite: resolve })).toThrow("thinking_matter_operation_conflict");
    const next = { ...input, operationKey: "new-deferred-create" };
    expect(() => repository.create(account, next, { receiptInput: { ...publicInput, operationKey: next.operationKey }, beforeWrite: resolve })).toThrow("source_unavailable");
    expect(repository.list(account)).toHaveLength(1);
  });

  it("resolves a link draft only after receipt lookup and cannot restore a later withdrawn link on replay", () => {
    const initial = create();
    const input = { kind: "link_source" as const, operationKey: "deferred-link", expectedVersion: initial.matter.version,
      source: { sourceId: "card_one", version: "1", kind: "card" as const } };
    const publicInput = { operationKey: input.operationKey, expectedVersion: input.expectedVersion, cardId: "card_one", cardVersion: 1 };
    let available = true, resolutions = 0;
    const resolve = (value: typeof input) => { resolutions += 1; if (!available) throw new Error("source_unavailable"); return { ...value, source: { ...value.source, version: "canonical-hash-1" } }; };
    const linked = repository.mutate(account, initial.matter.id, input, { receiptInput: publicInput, beforeWrite: value => resolve(value as typeof input) });
    expect(linked.matter.linkedSources[0].version).toBe("canonical-hash-1");
    const unlinked = repository.mutate(account, initial.matter.id, { kind: "unlink_source", operationKey: "withdraw-deferred-link", expectedVersion: linked.matter.version, sourceId: "card_one" });
    available = false;
    expect(repository.mutate(account, initial.matter.id, input, { receiptInput: publicInput, beforeWrite: value => resolve(value as typeof input) })).toEqual(unlinked);
    expect(resolutions).toBe(1); expect(unlinked.matter.linkedSources).toEqual([]);
    expect(() => repository.mutate(account, initial.matter.id, input, { receiptInput: { ...publicInput, cardVersion: 2 }, beforeWrite: value => resolve(value as typeof input) })).toThrow("thinking_matter_operation_conflict");
    expect(() => repository.mutate(account, initial.matter.id, { ...input, operationKey: "new-deferred-link", expectedVersion: unlinked.matter.version }, { beforeWrite: value => resolve(value as typeof input) })).toThrow("source_unavailable");
    expect(repository.get(account, initial.matter.id)).toEqual(unlinked);
  });

  it("revalidates deferred input and forbids the resolver from changing user content, mutation kind or scope", () => {
    const initial = create();
    expect(() => repository.create(account, { operationKey: "changed-create", question: "用户原问题" }, { beforeWrite: input => ({ ...input, question: "回调改了用户问题" }) })).toThrow("thinking_matter_write_identity_changed");
    const pause = { kind: "status" as const, operationKey: "changed-status", expectedVersion: initial.matter.version, status: "paused" as const };
    expect(() => repository.mutate(account, initial.matter.id, pause, { beforeWrite: input => ({ ...input, expectedVersion: input.expectedVersion + 1 }) })).toThrow("thinking_matter_write_identity_changed");
    expect(() => repository.mutate(account, initial.matter.id, pause, { beforeWrite: input => ({ ...input, kind: "cancel" }) as never })).toThrow();
    expect(() => repository.mutate(account, initial.matter.id, pause, { beforeWrite: () => ({ ...pause, status: "archived" }) })).toThrow("thinking_matter_write_identity_changed");
    expect(repository.get(account, initial.matter.id)).toEqual(initial);
  });
});

describe("Thinking matter P3 restart and concurrent snapshots", () => {
  it("reads matter and events from one SQLite snapshot when another connection commits between the reads", () => {
    const root = mkdtempSync(join(tmpdir(), "reflection-thinking-p3-snapshot-"));
    const filePath = join(root, "isolated.sqlite");
    const writerDatabase = openDailyReflectionDatabase({ filePath });
    const readerDatabase = openDailyReflectionDatabase({ filePath });
    try {
      const writer = new ThinkingMatterRepository(writerDatabase);
      const original = writer.create(account, { operationKey: "snapshot-create", question: "并发读取时保持同一进展" });
      let interleaved = false;
      const barrier = new Proxy(readerDatabase, { get(target, property) {
        if (property !== "prepare") { const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value; }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("SELECT state_json, version FROM dr_thinking_matters")) return statement;
          return new Proxy(statement, { get(targetStatement, method) {
            if (method !== "get") { const value = Reflect.get(targetStatement, method, targetStatement); return typeof value === "function" ? value.bind(targetStatement) : value; }
            return (...bindings: unknown[]) => {
              const row = targetStatement.get(...bindings);
              if (!interleaved) {
                interleaved = true;
                writer.mutate(account, original.matter.id, { kind: "edit", operationKey: "concurrent-user-edit", expectedVersion: original.matter.version, goal: "这是读操作开始后保存的新目标" });
              }
              return row;
            };
          } });
        };
      } }) as Database.Database;
      const snapshot = new ThinkingMatterRepository(barrier).get(account, original.matter.id);
      expect(interleaved).toBe(true);
      expect(snapshot).toEqual(original);
      expect(writer.get(account, original.matter.id).matter.goal).toBe("这是读操作开始后保存的新目标");
      expect(writer.get(account, original.matter.id).events).toHaveLength(original.events.length + 1);
    } finally {
      readerDatabase.close(); writerDatabase.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${filePath}${suffix}`, { force: true });
      rmdirSync(root);
    }
  });

  it("retains long history, explicit choice reasons, corrected understanding and feedback through physical restarts", () => {
    const fixture = isolatedDiskFixture();
    try {
      let connection = fixture.open(), writer = new ThinkingMatterRepository(connection);
      let view = writer.create(account, { operationKey: "long-create", question: "作品展示怎么开始" });
      const first = writer.beginTurn(account, view.matter.id, { operationKey: "long-first", expectedVersion: view.matter.version, text: "比较两个方向，也给一个小尝试。" });
      view = writer.commitResponse(account, view.matter.id, { generationId: first.generationId, expectedVersion: first.version, reply: "先比较目标，再试一个页面。", understanding: "可能是不愿动手。", judgments: ["待确认：是否缺少行动动力。"], comparison: comparisonInput(), suggestions: [{ text: "先做一页作品样例。", kind: "action" }] });
      view = writer.mutate(account, view.matter.id, { kind: "adopt", operationKey: "long-adopt", expectedVersion: view.matter.version, suggestionId: view.matter.suggestions[0].id });
      view = writer.mutate(account, view.matter.id, { kind: "choice", operationKey: "long-choice", expectedVersion: view.matter.version, status: "selected", optionId: view.matter.comparison!.options[0].id, reason: "先展示已有作品，才能获得实际反馈。" });
      view = writer.mutate(account, view.matter.id, { kind: "correct", operationKey: "long-correct", expectedVersion: view.matter.version, understanding: "我愿意动手，真正不确定的是给谁展示。", reason: "此前关于动力的判断不准确。" });
      view = writer.mutate(account, view.matter.id, { kind: "feedback", operationKey: "long-feedback", expectedVersion: view.matter.version, text: "我试过了，技术没有问题，主要是不知道展示内容。", arrangementId: view.matter.arrangements[0].id, arrangementStatus: "tried" });
      const importantEvents = structuredClone(view.events);
      const originalChoice = structuredClone(view.matter.userChoice);
      console.info("[thinking-p3-history] 0/60 creating saved turns");
      for (let index = 0; index < 60; index++) {
        const started = writer.beginTurn(account, view.matter.id, { operationKey: `long-turn-${index}`, expectedVersion: view.matter.version, text: `合成后续讨论 ${index}` });
        view = writer.commitResponse(account, view.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: `合成后续回复 ${index}` });
        if ((index + 1) % 20 === 0) console.info(`[thinking-p3-history] ${index + 1}/60 saved`);
      }
      expect(view.events.length).toBeGreaterThan(120);
      const beforeRestart = structuredClone(view);
      connection.close();
      connection = fixture.open(); writer = new ThinkingMatterRepository(connection);
      expect(writer.get(account, view.matter.id)).toEqual(beforeRestart);
      expect(beforeRestart.events.slice(0, importantEvents.length)).toEqual(importantEvents);
      expect(beforeRestart.matter.userChoice).toEqual(originalChoice);
      expect(beforeRestart.matter.understanding).toBe("我愿意动手，真正不确定的是给谁展示。");
      expect(beforeRestart.matter.judgments).toEqual([]);
      expect(beforeRestart.matter.arrangements[0].status).toBe("tried");
      expect(beforeRestart.events.every((event, index) => event.ordinal === index)).toBe(true);
      const input = { operationKey: "interrupted-before-reply", expectedVersion: beforeRestart.matter.version, text: "关闭前补充的新问题", taskId: "restart-task" };
      const pending = writer.beginTurn(account, view.matter.id, input);
      connection.close();
      connection = fixture.open(); writer = new ThinkingMatterRepository(connection);
      const resumed = writer.beginTurn(account, view.matter.id, input);
      expect(resumed).toEqual(pending);
      const response = { generationId: resumed.generationId, expectedVersion: resumed.version, reply: "这是原生成绑定下的一次合成恢复结果。", taskId: "restart-task" };
      const completed = writer.commitResponse(account, view.matter.id, response);
      connection.close();
      connection = fixture.open(); writer = new ThinkingMatterRepository(connection);
      expect(writer.commitResponse(account, view.matter.id, response)).toEqual(completed);
      expect(writer.get(account, view.matter.id).events.filter(event => event.data.generationId === resumed.generationId && event.kind === "assistant_message")).toHaveLength(1);
      expect(writer.get(account, view.matter.id).matter.userChoice).toEqual(originalChoice);
    } finally { fixture.close(); }
  });

  it("lets only one writer commit a stale shared version and replays its receipt from a second connection", () => {
    const fixture = isolatedDiskFixture();
    try {
      const first = new ThinkingMatterRepository(fixture.open()), second = new ThinkingMatterRepository(fixture.open());
      const initial = first.create(account, { operationKey: "writers-create", question: "两个客户端同时修改" });
      const firstView = first.get(account, initial.matter.id), secondView = second.get(account, initial.matter.id);
      expect(secondView).toEqual(firstView);
      const accepted = { kind: "edit" as const, operationKey: "first-writer", expectedVersion: firstView.matter.version, goal: "用户先保存的目标" };
      const committed = first.mutate(account, initial.matter.id, accepted);
      expect(() => second.mutate(account, initial.matter.id, { kind: "edit", operationKey: "second-writer", expectedVersion: secondView.matter.version, goal: "旧页面试图覆盖" })).toThrow("thinking_matter_version_conflict");
      expect(second.mutate(account, initial.matter.id, accepted)).toEqual(committed);
      expect(() => second.mutate(account, initial.matter.id, { ...accepted, goal: "复用key却换正文" })).toThrow("thinking_matter_operation_conflict");
      expect(first.get(account, initial.matter.id)).toEqual(committed);
      expect(committed.events.filter(event => event.kind === "edited")).toHaveLength(1);
      expect(() => second.mutate("other-account", initial.matter.id, accepted)).toThrow(ThinkingMatterNotFoundError);
    } finally { fixture.close(); }
  });

  it.each(["paused", "archived"] as const)("retains unknown and %s fences across a restart without accepting a late result", status => {
    const fixture = isolatedDiskFixture();
    try {
      let connection = fixture.open(), writer = new ThinkingMatterRepository(connection);
      const initial = writer.create(account, { operationKey: "fenced-create", question: "保留未确认结果与控制状态" });
      const started = writer.beginTurn(account, initial.matter.id, { operationKey: "unknown-turn", expectedVersion: initial.matter.version, text: "保存本轮输入", taskId: "unknown-task" });
      const unknown = writer.failResponse(account, initial.matter.id, { generationId: started.generationId, expectedVersion: started.version, status: "unknown", text: "结果未确认，不能自动重发。" });
      connection.close(); connection = fixture.open(); writer = new ThinkingMatterRepository(connection);
      expect(writer.get(account, initial.matter.id)).toEqual(unknown);
      expect(() => writer.beginTurn(account, initial.matter.id, { operationKey: "implicit-replacement", expectedVersion: unknown.matter.version, text: "不能隐式重试" })).toThrow("thinking_generation_pending");
      const controlled = writer.mutate(account, initial.matter.id, { kind: "status", operationKey: "explicit-control", expectedVersion: unknown.matter.version, status });
      connection.close(); connection = fixture.open(); writer = new ThinkingMatterRepository(connection);
      expect(writer.get(account, initial.matter.id)).toEqual(controlled);
      expect(() => writer.commitResponse(account, initial.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "迟到结果不能恢复事项", suggestions: [{ text: "迟到行动", kind: "action" }] })).toThrow(ThinkingMatterConflictError);
      expect(writer.get(account, initial.matter.id).matter.status).toBe(status);
      const reopened = writer.mutate(account, initial.matter.id, { kind: "status", operationKey: "resume-controlled", expectedVersion: controlled.matter.version, status: "active" });
      expect(reopened.matter.suggestions).toEqual([]); expect(reopened.matter.arrangements).toEqual([]);
      expect(reopened.events.some(event => event.kind === "generation_failed" && event.data.status === "unknown")).toBe(true);
      expect(reopened.events.some(event => event.kind === "user_message" && event.text === "保存本轮输入")).toBe(true);
    } finally { fixture.close(); }
  });
});

function isolatedDiskFixture() {
  const root = mkdtempSync(join(tmpdir(), "reflection-thinking-p3-"));
  const filePath = join(root, "isolated.sqlite");
  const opened: Database.Database[] = [];
  return { open() { const connection = openDailyReflectionDatabase({ filePath }); opened.push(connection); return connection; },
    close() { for (const connection of opened) if (connection.open) connection.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${filePath}${suffix}`, { force: true });
      rmdirSync(root);
    } };
}
afterEach(() => database.close());

function create() {
  return repository.create(account, { operationKey: "create", question: "我总是修改作品计划，一直没有开始。" });
}
function reply(matterId: string, version: number, text = "先做一个最小页面。") {
  const started = repository.beginTurn(account, matterId, { operationKey: `turn${seq}`, expectedVersion: version, text: "功能范围太大，不知道删什么。", taskId: "task_test" });
  return repository.commitResponse(account, matterId, {
    generationId: started.generationId, expectedVersion: started.version, taskId: "task_test", reply: text,
    understanding: "需要先缩小尝试范围。", judgments: ["可能是范围不清；尚待确认。"],
    suggestions: [{ text, kind: "action" }], promptVersion: "thinking-p1", model: "offline-fixture",
    sources: [{ sourceId: "card:fixture", version: "version-1", kind: "card" }],
  });
}

describe("Thinking matter persistence and explicit adoption", () => {
  it("creates product-owned matters and keeps task completion separate from adoption and business status", () => {
    const initial = create();
    expect(initial.matter.status).toBe("active");
    expect(initial.matter.arrangements).toEqual([]);
    const proposed = reply(initial.matter.id, initial.matter.version);
    expect(proposed.matter.activeGeneration).toBeNull();
    expect(proposed.matter.status).toBe("active");
    expect(proposed.matter.arrangements).toEqual([]);
    expect(proposed.matter.suggestions[0].status).toBe("proposed");
    const adopted = repository.mutate(account, initial.matter.id, {
      kind: "adopt", operationKey: "adopt", expectedVersion: proposed.matter.version,
      suggestionId: proposed.matter.suggestions[0].id,
    });
    expect(adopted.matter.arrangements).toHaveLength(1);
    expect(adopted.matter.arrangements[0].status).toBe("adopted");
    expect(adopted.matter.status).toBe("active");
    expect(adopted.events.map(event => event.kind)).toEqual(["created", "user_message", "assistant_message", "adopted"]);
  });

  it("does not write any arrangement before explicit adoption or when a suggestion is rejected", () => {
    const initial = create();
    const proposed = reply(initial.matter.id, 0);
    const rejected = repository.mutate(account, initial.matter.id, {
      kind: "reject", operationKey: "reject", expectedVersion: proposed.matter.version,
      suggestionId: proposed.matter.suggestions[0].id, reason: "今天只讨论，不安排计划。",
    });
    expect(rejected.matter.arrangements).toEqual([]);
    expect(rejected.matter.suggestions[0].status).toBe("rejected");
  });

  it("preserves exact feedback, original choice and replacement reasoning through repository reopen", () => {
    const initial = create();
    const proposed = reply(initial.matter.id, 0);
    const adopted = repository.mutate(account, initial.matter.id, {
      kind: "adopt", operationKey: "adopt", expectedVersion: proposed.matter.version,
      suggestionId: proposed.matter.suggestions[0].id,
    });
    const feedback = "我试过了，技术其实没问题，主要是不知道展示什么内容。";
    const updated = repository.mutate(account, initial.matter.id, {
      kind: "feedback", operationKey: "feedback", expectedVersion: adopted.matter.version,
      text: feedback, arrangementId: adopted.matter.arrangements[0].id, arrangementStatus: "tried",
    });
    const reopened = new ThinkingMatterRepository(database).get(account, initial.matter.id);
    expect(reopened).toEqual(updated);
    expect(reopened.events.find(event => event.kind === "feedback")?.text).toBe(feedback);
    expect(reopened.matter.arrangements[0].status).toBe("tried");
    const adjusted = reply(initial.matter.id, reopened.matter.version, "先讨论页面应该展示的一个具体内容样例。");
    expect(adjusted.matter.arrangements[0].text).toBe("先做一个最小页面。");
    expect(adjusted.matter.suggestions.map(item => item.text)).toEqual(["先做一个最小页面。", "先讨论页面应该展示的一个具体内容样例。"]);
    expect(adjusted.events.filter(event => event.kind === "assistant_message")).toHaveLength(2);
  });

  it("isolates list, reads, mutations, generations and identical operation keys by account", () => {
    const first = create();
    const second = repository.create("other-account", { operationKey: "create", question: "另一个人的问题" });
    expect(repository.list(account).map(item => item.id)).toEqual([first.matter.id]);
    expect(repository.list("other-account").map(item => item.id)).toEqual([second.matter.id]);
    expect(() => repository.get("other-account", first.matter.id)).toThrow(ThinkingMatterNotFoundError);
    expect(() => repository.beginTurn("other-account", first.matter.id, { operationKey: "wrong-turn", expectedVersion: 0, text: "越权" })).toThrow(ThinkingMatterNotFoundError);
    expect(() => repository.mutate("other-account", first.matter.id, { operationKey: "wrong-edit", expectedVersion: 0, kind: "status", status: "paused" })).toThrow(ThinkingMatterNotFoundError);
    expect(() => repository.commitResponse("other-account", first.matter.id, { generationId: "wrong", expectedVersion: 0, reply: "越权" })).toThrow(ThinkingMatterNotFoundError);
  });

  it("replays receipts without duplicate saves and rejects an operation key with a different payload", () => {
    const initial = create();
    expect(create()).toEqual(initial);
    expect(repository.list(account)).toHaveLength(1);
    const proposed = reply(initial.matter.id, 0);
    const input = { kind: "adopt" as const, operationKey: "adopt", expectedVersion: proposed.matter.version, suggestionId: proposed.matter.suggestions[0].id };
    const adopted = repository.mutate(account, initial.matter.id, input);
    expect(repository.mutate(account, initial.matter.id, input)).toEqual(adopted);
    expect(repository.get(account, initial.matter.id).matter.arrangements).toHaveLength(1);
    expect(() => repository.mutate(account, initial.matter.id, { ...input, text: "不同内容" })).toThrow("thinking_matter_operation_conflict");
    expect(() => repository.create(account, { operationKey: "create", question: "另一个问题" })).toThrow("thinking_matter_operation_conflict");
    expect(repository.get(account, initial.matter.id).events.filter(event => event.kind === "adopted")).toHaveLength(1);
  });

  it("keeps complete business history beyond both the old 100-message limit and a model context window", () => {
    const initial = create();
    let version = 0;
    for (let index = 0; index < 55; index++) {
      const started = repository.beginTurn(account, initial.matter.id, { operationKey: `history-${index}`, expectedVersion: version, text: `用户原话 ${index}` });
      const result = repository.commitResponse(account, initial.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: `本轮讨论 ${index}` });
      version = result.matter.version;
    }
    const result = repository.get(account, initial.matter.id);
    expect(result.events).toHaveLength(111);
    expect(result.events[1].text).toBe("用户原话 0");
    expect(result.events.at(-1)?.text).toBe("本轮讨论 54");
  });

  it("does not let old replies overwrite a newer user arrangement edit", () => {
    const initial = create();
    const proposed = reply(initial.matter.id, 0);
    const adopted = repository.mutate(account, initial.matter.id, { kind: "adopt", operationKey: "adopt", expectedVersion: proposed.matter.version, suggestionId: proposed.matter.suggestions[0].id });
    const started = repository.beginTurn(account, initial.matter.id, { operationKey: "pending", expectedVersion: adopted.matter.version, text: "继续" });
    const edited = repository.mutate(account, initial.matter.id, {
      kind: "edit", operationKey: "edit", expectedVersion: started.version,
      arrangementId: adopted.matter.arrangements[0].id, text: "我决定只展示一段真实作品内容。",
    });
    expect(() => repository.commitResponse(account, initial.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "迟到回复", suggestions: [{ text: "旧技术建议", kind: "action" }] })).toThrow(ThinkingMatterConflictError);
    expect(repository.get(account, initial.matter.id)).toEqual(edited);
    expect(edited.matter.arrangements[0].text).toBe("我决定只展示一段真实作品内容。");
    expect(edited.events.at(-1)?.data.previousText).toBe("先做一个最小页面。");
  });

  it("fences cancelled and paused turns without interpreting a stopped task as a resolved matter", () => {
    const initial = create();
    const started = repository.beginTurn(account, initial.matter.id, { operationKey: "pending", expectedVersion: 0, text: "继续想" });
    const cancelled = repository.mutate(account, initial.matter.id, { kind: "cancel", operationKey: "cancel", expectedVersion: started.version, generationId: started.generationId });
    expect(cancelled.matter.status).toBe("active");
    expect(() => repository.commitResponse(account, initial.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "迟到回复" })).toThrow(ThinkingMatterConflictError);
    const paused = repository.mutate(account, initial.matter.id, { kind: "status", operationKey: "pause", expectedVersion: cancelled.matter.version, status: "paused", reason: "这个方向先不考虑了，暂时放下。" });
    expect(paused.matter.status).toBe("paused");
    expect(paused.events.at(-1)?.text).toBe("这个方向先不考虑了，暂时放下。");
    expect(() => repository.beginTurn(account, initial.matter.id, { operationKey: "blocked", expectedVersion: paused.matter.version, text: "不能后台推进" })).toThrow("thinking_matter_not_active");
  });

  it("keeps unknown results visible and refuses an implicit replacement until user cancellation", () => {
    const initial = create();
    const started = repository.beginTurn(account, initial.matter.id, { operationKey: "pending", expectedVersion: 0, text: "讨论" });
    const unknown = repository.failResponse(account, initial.matter.id, { generationId: started.generationId, expectedVersion: started.version, status: "unknown", text: "结果未知，不自动重发。" });
    expect(unknown.matter.activeGeneration?.status).toBe("unknown");
    expect(unknown.events.at(-1)?.data.status).toBe("unknown");
    expect(() => repository.beginTurn(account, initial.matter.id, { operationKey: "replacement", expectedVersion: unknown.matter.version, text: "自动重试" })).toThrow("thinking_generation_pending");
    const feedback = repository.mutate(account, initial.matter.id, { kind: "feedback", operationKey: "unrelated-feedback", expectedVersion: unknown.matter.version, text: "补充一点。" });
    expect(feedback.matter.activeGeneration?.status).toBe("unknown");
    expect(() => repository.beginTurn(account, initial.matter.id, { operationKey: "replacement-2", expectedVersion: feedback.matter.version, text: "仍然不能隐式替换" })).toThrow("thinking_generation_pending");
    const cancelled = repository.mutate(account, initial.matter.id, { operationKey: "cancel-unknown", expectedVersion: feedback.matter.version, kind: "cancel" });
    expect(cancelled.matter.activeGeneration).toBeNull();
  });

  it("distinguishes a known failure, retains the user turn and permits an explicit new turn", () => {
    const initial = create();
    const started = repository.beginTurn(account, initial.matter.id, { operationKey: "pending", expectedVersion: 0, text: "用户已经说过的话" });
    const failed = repository.failResponse(account, initial.matter.id, { generationId: started.generationId, expectedVersion: started.version, status: "known_failed", text: "本轮未生成成功。" });
    expect(failed.matter.activeGeneration).toBeNull();
    expect(failed.events[1].text).toBe("用户已经说过的话");
    expect(failed.events.at(-1)?.data.status).toBe("known_failed");
    expect(repository.beginTurn(account, initial.matter.id, { operationKey: "retry-explicit", expectedVersion: failed.matter.version, text: "请再试一次" }).view.matter.activeGeneration?.status).toBe("running");
  });

  it("persists model/source versions and never creates Memory, Person or office Todo records", () => {
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(item => item.name);
    const protectedTables = tables.filter(name => /memory|person|todo/iu.test(name));
    const before = Object.fromEntries(protectedTables.map(name => [name, database.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get()]));
    const initial = create();
    const proposed = reply(initial.matter.id, 0);
    repository.mutate(account, initial.matter.id, { kind: "adopt", operationKey: "adopt", expectedVersion: proposed.matter.version, suggestionId: proposed.matter.suggestions[0].id });
    const assistant = proposed.events.find(event => event.kind === "assistant_message");
    expect(assistant?.sources).toEqual([{ sourceId: "card:fixture", version: "version-1", kind: "card" }]);
    expect(assistant?.data).toMatchObject({ promptVersion: "thinking-p1", model: "offline-fixture", taskId: "task_test" });
    const after = Object.fromEntries(protectedTables.map(name => [name, database.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get()]));
    expect(after).toEqual(before);
  });

  it("adds migration 16 transactionally and idempotently while retaining existing reflection data", () => {
    // A synthetic v15 migration fixture; no application/user database is opened.
    database.exec("DROP TABLE dr_thinking_receipts; DROP TABLE dr_thinking_events; DROP TABLE dr_thinking_matters; DELETE FROM dr_schema_migrations WHERE version = 16; PRAGMA user_version = 15;");
    database.prepare(`INSERT INTO dr_reflections (id, account_id, upload_id, input_method, source_origin, processing_profile, ingestion_context, status, version, idempotency_key, create_fingerprint, created_at, updated_at)
      VALUES ('legacy', 'old-account', NULL, 'file_upload', 'legacy_unknown', 'quick_reflection', 'daily_reflection', 'created', 0, NULL, 'fixture', ?, ?)`).run("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    migrateDailyReflectionSchema(database);
    migrateDailyReflectionSchema(database);
    expect(DAILY_REFLECTION_SCHEMA_VERSION).toBe(16);
    expect(database.pragma("user_version", { simple: true })).toBe(16);
    expect(database.prepare("SELECT id, account_id FROM dr_reflections WHERE id = 'legacy'").get()).toEqual({ id: "legacy", account_id: "old-account" });
    expect(database.prepare("SELECT COUNT(*) AS n FROM dr_schema_migrations WHERE version = 16").get()).toEqual({ n: 1 });
    expect(create().matter.question).toContain("作品计划");
  });

  it("retains adoption and feedback after physically closing and reopening an isolated SQLite file", () => {
    const root = mkdtempSync(join(tmpdir(), "reflection-thinking-repo-"));
    const filePath = join(root, "isolated.sqlite");
    let onDisk = openDailyReflectionDatabase({ filePath });
    try {
      const writer = new ThinkingMatterRepository(onDisk);
      const initial = writer.create(account, { operationKey: "create-file", question: "讨论展示内容" });
      const started = writer.beginTurn(account, initial.matter.id, { operationKey: "turn-file", expectedVersion: 0, text: "我还没开始做。" });
      const proposed = writer.commitResponse(account, initial.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "先选一个展示片段。", suggestions: [{ text: "选一个展示片段", kind: "action" }] });
      const adopted = writer.mutate(account, initial.matter.id, { kind: "adopt", operationKey: "adopt-file", expectedVersion: proposed.matter.version, suggestionId: proposed.matter.suggestions[0].id });
      const feedback = writer.mutate(account, initial.matter.id, { kind: "feedback", operationKey: "feedback-file", expectedVersion: adopted.matter.version, text: "我试过了，需要重新选择内容。", arrangementId: adopted.matter.arrangements[0].id, arrangementStatus: "tried" });
      onDisk.close();
      onDisk = openDailyReflectionDatabase({ filePath });
      expect(new ThinkingMatterRepository(onDisk).get(account, initial.matter.id)).toEqual(feedback);
    } finally {
      onDisk.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${filePath}${suffix}`, { force: true });
      rmdirSync(root);
    }
  });

  it("records explicit progress feedback with a new response fence atomically and idempotently", () => {
    const initial = create();
    const proposed = reply(initial.matter.id, 0);
    const adopted = repository.mutate(account, initial.matter.id, { kind: "adopt", operationKey: "adopt", expectedVersion: proposed.matter.version, suggestionId: proposed.matter.suggestions[0].id });
    const input = {
      operationKey: "feedback-turn", expectedVersion: adopted.matter.version,
      text: "我试过了，技术没问题。", feedback: true,
      arrangementId: adopted.matter.arrangements[0].id, arrangementStatus: "tried" as const,
    };
    const started = repository.beginTurn(account, initial.matter.id, input);
    expect(started.view.matter.arrangements[0].status).toBe("tried");
    expect(started.view.matter.arrangements[0].version).toBe(1);
    expect(started.view.events.at(-1)).toMatchObject({ kind: "feedback", text: input.text, data: { arrangementStatus: "tried", arrangementId: input.arrangementId } });
    expect(repository.beginTurn(account, initial.matter.id, input)).toEqual(started);
    expect(repository.get(account, initial.matter.id).matter.arrangements[0].version).toBe(1);
    expect(repository.commitResponse(account, initial.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "接下来讨论展示内容。" }).matter.activeGeneration).toBeNull();
  });

  it("supersedes older proposed advice when a discussion response explicitly has no next step, preserving adopted arrangements", () => {
    const initial = create();
    const first = reply(initial.matter.id, 0);
    const adopted = repository.mutate(account, initial.matter.id, { kind: "adopt", operationKey: "adopt", expectedVersion: first.matter.version, suggestionId: first.matter.suggestions[0].id });
    const proposed = reply(initial.matter.id, adopted.matter.version, "再选一个展示内容样例。");
    const originalArrangement = proposed.matter.arrangements[0];
    expect(proposed.matter.suggestions.map(item => item.status)).toEqual(["adopted", "proposed"]);
    const started = repository.beginTurn(account, initial.matter.id, { operationKey: "discussion-only", expectedVersion: proposed.matter.version, text: "今天只讨论，不需要行动计划。" });
    const discussed = repository.commitResponse(account, initial.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "我们只比较不同内容的表达效果。", suggestions: [] });
    expect(discussed.matter.suggestions.map(item => item.status)).toEqual(["adopted", "superseded"]);
    expect(discussed.matter.arrangements).toEqual([originalArrangement]);
    expect(discussed.events.some(event => event.kind === "assistant_message" && event.text === "再选一个展示内容样例。")).toBe(true);
  });
});

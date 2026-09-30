// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkInputBudget, generateStudyJson, learningRequestChars } from "./framework-generator";
import { fitQuizWindows, mergeQuizWindows, planLargeQuiz } from "./quiz-planning";
import type { GenerationParts } from "./generation-parts";
import { sourceBatches } from "./generation-sources";
import { composedQuizPrompt, composedQuizRequest } from "./quiz-composition";
import { LEARNING_QUIZ_PROMPT, quizDuplicatePreview } from "./quiz-service";

type Input = Parameters<typeof fitQuizWindows>[0][number];
const budget = 48_000;
const config = { baseURL: "https://synthetic.invalid", apiKey: "SYNTHETIC", model: "synthetic-model", maxInputChars: budget, maxOutputTokens: 8_000 };
const prompt = composedQuizPrompt(LEARNING_QUIZ_PROMPT);
const scope = { accountId: "synthetic-account", pageId: "synthetic-page", requestId: "synthetic-request", expiresAt: 0 };
const notice = "这里只是已生成题目的开头，用于避免重复，不是本题事实依据；完整旧题保持原样保存。";

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in synthetic packing tests"); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

function pdfInput(blocks: number, text: (index: number) => string): Input {
  return { count: 5, difficulty: "challenging", extras: [], materials: [{
    materialId: "00000000-0000-4000-8000-000000000001", title: "[合成] 密集 PDF", kind: "pdf",
    scopeNotice: { kind: "pdf", documentId: "00000000-0000-4000-8000-000000000002", parseVersion: 3,
      physicalPages: Array.from({ length: Math.ceil(blocks / 30) }, (_, i) => i + 1),
      excludedPhysicalPages: [199, 200], excludedBlockIds: ["synthetic-excluded"], contentVerified: false, warningCodes: ["missing_formula"] },
    paragraphs: Array.from({ length: blocks }, (_, i) => ({ number: i + 1, text: text(i),
      referenceId: `ref_${(i + 1).toString(16).padStart(64, "0")}`,
      sourceContext: { kind: "pdf", physicalPage: Math.floor(i / 30) + 1, role: i % 2 ? "body" as const : "heading" as const,
        type: "text" as const, renderSize: [1000, 1400], regions: [{ bbox: [1, 2, 3, 4], unit: "render_pixel" as const, origin: "top_left" as const }],
        note: "Parser layout only; not a verified heading hierarchy or semantic relationship" } }))
  }] };
}

function questionWire(input: Input, previous = Array.from({ length: input.count - 1 }, () => "x".repeat(160))) {
  const wire = composedQuizRequest(input, scope).input;
  return { ...wire, taskContext: { ...wire.taskContext, alreadyAsked: previous, alreadyAskedNotice: notice } };
}
const questionChars = (input: Input) => learningRequestChars(prompt, questionWire(input));

function assertActualFit(input: Input) {
  const wire = questionWire(input);
  expect(learningRequestChars(prompt, wire)).toBeLessThanOrEqual(budget);
  expect(() => checkInputBudget(config, prompt, wire, "items")).not.toThrow();
  // Read every actual alias from the final codec, not a text-only size estimate.
  const catalog = wire.taskContext.materialCatalog as unknown as Array<{ scopeNotice?: Record<string, unknown>;
    sourceLocations: Array<{ referenceId?: string; referenceIds?: string[]; context: Record<string, unknown> }> }>;
  wire.materials.forEach((material, index) => {
    const original = input.materials[index];
    expect(material.paragraphs.map(p => p.text)).toEqual(original.paragraphs.map(p => p.text));
    const aliases = material.paragraphs.map(p => p.referenceId);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases.every(id => /^r[1-9]\d*$/.test(id!))).toBe(true);
    const locations = catalog[index].sourceLocations.flatMap(location => (location.referenceIds ?? [location.referenceId!])
      .map(referenceId => ({ referenceId, context: location.context })));
    expect(locations.map(location => location.referenceId)).toEqual(aliases);
    locations.forEach((location, i) => expect(location.context).toMatchObject({
      kind: "pdf", physicalPage: original.paragraphs[i].sourceContext!.physicalPage,
      role: original.paragraphs[i].sourceContext!.role, type: original.paragraphs[i].sourceContext!.type
    }));
    expect(catalog[index].scopeNotice).toMatchObject({ physicalPages: original.scopeNotice!.physicalPages,
      excludedPhysicalPages: [199, 200], excludedRegionCount: 1, contentVerified: false, warningCodes: ["missing_formula"] });
  });
}

function assertEverySelectionFits(windows: Input[]) {
  for (const window of windows) assertActualFit(window);
  // Selection preserves the chosen order; verify both orders for each distinct pair.
  for (let i = 0; i < windows.length; i++) for (let j = 0; j < windows.length; j++) {
    if (i !== j) assertActualFit(mergeQuizWindows(windows[i], [windows[i], windows[j]], windows[i].count));
  }
}

it("fits every ordered two-window selection for 538 dense PDF blocks without dropping source text or metadata", () => {
  const request = pdfInput(538, i => `[合成] ${i + 1}：前提未满足时不能应用规则。${"不能把否定改成肯定。".repeat(7)}`);
  const before = JSON.stringify(request), target = Math.floor((budget - 10_000) / 3);
  const initial = sourceBatches(request.materials, target).map(materials => ({ ...request, materials: materials as Input["materials"] }));
  expect(initial.length).toBeGreaterThan(2);
  expect(initial.some((window, i) => initial.slice(i + 1).some(other => questionChars(mergeQuizWindows(request, [window, other], 5)) > budget))).toBe(true);
  const windows = fitQuizWindows(initial, budget, questionChars);
  expect(windows.length).toBeGreaterThan(initial.length);
  expect(windows.flatMap(window => window.materials.flatMap(m => m.paragraphs.map(p => p.text)))).toEqual(request.materials[0].paragraphs.map(p => p.text));
  expect(windows.flatMap(window => window.materials.flatMap(m => m.paragraphs.map(p => p.referenceId)))).toEqual(request.materials[0].paragraphs.map(p => p.referenceId));
  assertEverySelectionFits(windows);
  expect(JSON.stringify(request)).toBe(before);
});

it("splits one long PDF paragraph losslessly at Unicode boundaries and preserves original source identity", () => {
  const text = '[合成] 😀前提与例外不能删，\n"限定条件"需要保留。'.repeat(3_000);
  const request = pdfInput(1, () => text), before = JSON.stringify(request);
  expect(questionChars(request)).toBeGreaterThan(budget);
  const windows = fitQuizWindows([request], budget, questionChars);
  expect(windows.length).toBeGreaterThan(2);
  const fragments = windows.flatMap(window => window.materials[0].paragraphs);
  expect(fragments.map(p => p.text).join("")).toBe(text);
  let offset = 0;
  for (const fragment of fragments) {
    expect(fragment.referenceId).toBe(request.materials[0].paragraphs[0].referenceId);
    expect(fragment.number).toBe(1);
    expect(fragment.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    expect(fragment.sourceContext).toMatchObject({ physicalPage: 1, role: "heading", type: "text",
      excerpt: { start: offset, end: offset + fragment.text.length, total: text.length } });
    offset += fragment.text.length;
  }
  assertEverySelectionFits(windows);
  expect(JSON.stringify(request)).toBe(before);
});

it("preserves every selected slice range and text order while leaving legacy merge context unchanged", () => {
  for (const [first, last] of [["[合成] 前提必须满足。", "[合成] 例外必须保留。"], ["[合成] 重复项目。", "[合成] 重复项目。"]]) {
    const gap = "[合成] 未选择的中间内容。", text = first + gap + last, request = pdfInput(1, () => text);
    const spans = [{ start: 0, end: first.length, total: text.length },
      { start: first.length + gap.length, end: text.length, total: text.length }];
    const selected: Input[] = spans.map(excerpt => ({ ...request, materials: request.materials.map(material => ({ ...material,
      paragraphs: material.paragraphs.map(paragraph => ({ ...paragraph, text: text.slice(excerpt.start, excerpt.end),
        sourceContext: { ...paragraph.sourceContext, excerpt } as typeof paragraph.sourceContext })) })) }));
    const before = JSON.stringify(selected), merged = mergeQuizWindows(request, selected, 5);
    const paragraph = merged.materials[0].paragraphs[0];
    expect(merged.materials[0].paragraphs).toHaveLength(1);
    expect(paragraph.referenceId).toBe(request.materials[0].paragraphs[0].referenceId);
    expect(paragraph.text).toBe(`${first}\n〔同一原段落的另一已选片段，中间内容未用于本题〕\n${last}`);
    expect(paragraph.sourceContext).toMatchObject({ physicalPage: 1, role: "heading", excerpts: spans });
    expect(paragraph.sourceContext).not.toHaveProperty("excerpt");
    expect(questionWire(merged).taskContext.materialCatalog[0].sourceLocations[0].context).toMatchObject({ excerpts: spans });
    const legacy = mergeQuizWindows(request, selected, 5, false).materials[0].paragraphs[0];
    expect(legacy.sourceContext).toEqual(selected[0].materials[0].paragraphs[0].sourceContext);
    expect(legacy.sourceContext).not.toHaveProperty("excerpts");
    expect(legacy.text).toBe(first === last ? first : paragraph.text);
    expect(JSON.stringify(selected)).toBe(before);
  }
});

it("preserves equal note fragments from distinct ranges without exposing internal slices to the model", () => {
  const fragment = "[合成笔记] 两处各自记录同一项。", gap = "[合成笔记] 未选择的中间内容。", text = fragment + gap + fragment;
  const request: Input = { count: 5, difficulty: "standard", materials: [], extras: [{
    id: "synthetic-node:note", kind: "note", chapterId: "synthetic-chapter", nodeId: "synthetic-node",
    text, referenceId: `ref_${"e".repeat(64)}` }] };
  const spans = [{ start: 0, end: fragment.length, total: text.length },
    { start: fragment.length + gap.length, end: text.length, total: text.length }];
  const selected: Input[] = spans.map(slice => ({ ...request, extras: request.extras.map(extra => ({ ...extra,
    text: text.slice(slice.start, slice.end), slice })) }));
  const before = JSON.stringify(selected), merged = mergeQuizWindows(request, selected, 5);
  const combined = `${fragment}\n〔另一已选片段〕\n${fragment}`;
  expect(merged.extras).toHaveLength(1);
  expect(merged.extras[0]).toMatchObject({ text: combined, referenceId: request.extras[0].referenceId, slices: spans });
  expect(merged.extras[0]).not.toHaveProperty("slice");
  const codec = composedQuizRequest(merged, { ...scope, expiresAt: Date.now() + 60_000 });
  expect(codec.input.extras).toEqual([{ kind: "note", text: combined, referenceId: "r1" }]);
  expect(codec.resolveIds(["r1"])).toEqual([request.extras[0].referenceId]);
  expect(JSON.stringify(codec.input)).not.toMatch(/"slices?"\s*:/);
  const legacy = mergeQuizWindows(request, selected, 5, false);
  expect(legacy.extras[0]).toEqual(selected[0].extras[0]);
  expect(legacy.extras[0]).not.toHaveProperty("slices");
  expect(JSON.stringify(selected)).toBe(before);
});

it("uses the final escaped JSON and full prompt for the exact transport admission boundary", async () => {
  const request = pdfInput(2, () => '[合成] "引用"、换行\n及😀均保留。');
  const codec = composedQuizRequest(request, scope), wire = questionWire(request);
  const actual = learningRequestChars(prompt, wire);
  const transport = "遵循学习整理输出契约。\n只输出一个合法 JSON 对象，不要输出 Markdown，不要输出解释文字。JSON 根对象必须包含 items 字段。";
  expect(actual).toBe(prompt.length + transport.length + JSON.stringify(wire).length);
  expect(() => checkInputBudget({ ...config, maxInputChars: actual }, prompt, wire, "items")).not.toThrow();
  expect(() => checkInputBudget({ ...config, maxInputChars: actual - 1 }, prompt, wire, "items")).toThrow("generation_request_does_not_fit");
  await expect(generateStudyJson({ ...config, maxInputChars: actual - 1 }, "learning_quiz", prompt, wire, codec.schema,
    new AbortController().signal)).rejects.toThrow("generation_request_does_not_fit");
});

it("reserves serialized duplicate previews without treating saved question bodies as new source text", () => {
  const request = pdfInput(269, () => "[合成] 这段文字来自实际原文。".repeat(8));
  const windows = fitQuizWindows([request], budget, questionChars);
  const previousBodies = Array.from({ length: request.count - 1 }, (_, i) => `[合成历史] ${i} "\\\n😀`.repeat(2_000));
  const previews = previousBodies.map(quizDuplicatePreview);
  expect(previews.every(text => JSON.stringify(text).length <= 162)).toBe(true);
  for (const window of windows) {
    const actual = questionWire(window, previews), reserved = questionChars(window);
    expect(learningRequestChars(prompt, actual)).toBeLessThanOrEqual(reserved);
    expect(() => checkInputBudget(config, prompt, actual, "items")).not.toThrow();
    expect(actual.materials.flatMap(m => m.paragraphs.map(p => p.text))).toEqual(window.materials.flatMap(m => m.paragraphs.map(p => p.text)));
    expect(actual.taskContext.alreadyAsked).toEqual(previews);
  }
});

it("fails locally when indivisible content plus required context cannot fit instead of discarding text", () => {
  const request = pdfInput(1, () => "合"), before = JSON.stringify(request);
  expect(() => fitQuizWindows([request], 100, questionChars)).toThrow("generation_request_does_not_fit");
  expect(JSON.stringify(request)).toBe(before);
});

it("preserves Unicode at the initial extra-reading boundary without changing the stored note",async()=>{
  const target=Math.floor((budget-10000)/3),text="x".repeat(target-1)+"😀"+"y".repeat(30),seen:string[]=[];
  const input:Input={count:1,difficulty:"standard",materials:[],extras:[{id:"synthetic-note",kind:"note",chapterId:"synthetic-chapter",nodeId:"synthetic-node",text,referenceId:`ref_${"a".repeat(64)}`}]};
  const before=JSON.stringify(input);
  const parts={plan:()=>undefined,execute:async(_id:string,operation:(d:(v:object)=>void)=>Promise<unknown>,validate:(v:unknown)=>unknown,preflight?:()=>void)=>{preflight?.();return validate(await operation(()=>{}));}} as unknown as GenerationParts;
  const generate=vi.fn(async(_config,name,_prompt,wire:any)=>{
    if(name==="learning_quiz_reading"){seen.push(...wire.extras.map((e:any)=>e.text));return {items:[{title:"[模拟] 笔记",context:"[模拟] 上下文"}],limitation:null};}
    return {items:[{windows:["w1","w2"],count:1}]};
  });
  await planLargeQuiz(input,config,parts,scope,generate,8,{questionChars});
  expect(seen.join("")).toBe(text);seen.forEach(part=>expect(part).not.toMatch(/[\uD800-\uDFFF]/u));
  expect(JSON.stringify(input)).toBe(before);
});

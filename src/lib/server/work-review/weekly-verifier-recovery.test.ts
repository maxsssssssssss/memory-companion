// @vitest-environment node
import type OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStructuredWorkWeeklyClaimVerifier, type WorkWeeklyGeneratedItem
} from "./weekly-ai-provider";
import { runWorkWeeklyGenerationPipeline, type WorkWeeklyGenerationTrace } from "./weekly-publication-policy";
import { WORK_WEEKLY_TEST_REFS as refs, workWeeklyProfile, workWeeklyTestSnapshot } from "./weekly-ai-test-fixture";

const transport = vi.hoisted(() => ({ client: vi.fn(), runtime: vi.fn() }));
vi.mock("@/lib/server/openai/client", () => ({ createOpenAIClient: transport.client }));
vi.mock("@/lib/server/settings/provider-config", () => ({ getOpenAIClientRuntimeConfig: transport.runtime }));
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const snapshot = workWeeklyTestSnapshot();
  snapshot.findings = [refs.dated, refs.proposal].map((ref) => snapshot.findings.find((finding) => finding.sourceRef === ref)!);
  snapshot.todos = []; snapshot.todoEvents = [];
  const allowed = new Set([refs.meeting, ...snapshot.findings.flatMap((finding) => [finding.sourceRef, ...finding.evidenceRefs])]);
  snapshot.evidence = snapshot.evidence.filter((source) => allowed.has(source.sourceRef));
  snapshot.identities = snapshot.identities.filter((source) => allowed.has(source.sourceRef));
  snapshot.allowlistedSourceRefs = [...allowed];
  const generated: WorkWeeklyGeneratedItem[] = snapshot.findings.map((finding, index) => ({
    id: `item_${index}`, section: "open_questions", itemType: "evidence_backed_fact", text: finding.body,
    claims: [{ id: `claim_${index}`, text: finding.body, claimType: "fact", sourceRefs: [finding.sourceRef] }]
  }));
  const claims = generated.flatMap((item) => item.claims);
  const wire = { items: claims.map((claim): Record<string, unknown> => ({
    claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs
  })), disputes: [] as unknown[], coverage: claims.map((claim) => ({
    sourceRef: claim.sourceRefs[0]!, status: "covered", reasonCode: "covered", claimIds: [claim.id], matches: [] as unknown[]
  })) };
  const create = vi.fn((_request: { input: Array<{ role: string; content: string }> }) => ({
    async asResponse() {
      const event = { type: "response.completed", response: { status: "completed", error: null, incomplete_details: null,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(wire) }] }] } };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
  }));
  const client = { baseURL: "https://tokenhub.vision-intelligence.tech/v1", responses: { create }, withOptions: vi.fn() };
  client.withOptions.mockReturnValue(client);
  transport.runtime.mockResolvedValue({}); transport.client.mockReturnValue(client as unknown as OpenAI);
  const verifier = createStructuredWorkWeeklyClaimVerifier({
    profile: { ...workWeeklyProfile("verifier"), model: "deepseek-v4-pro", reasoningEffort: "none" }
  });
  const traces: WorkWeeklyGenerationTrace[] = [];
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  return { snapshot, generated, claims, wire, create, verifier, traces, log,
    verify: () => verifier.verify({ accountId: snapshot.accountId, snapshot, claims, items: generated, onCoverage: () => {} }),
    run: () => runWorkWeeklyGenerationPipeline({ accountId: snapshot.accountId, snapshot,
      synthesizer: { profile: workWeeklyProfile("synthesizer"), synthesize: async () => generated }, verifier,
      onTrace: (trace) => { traces.push(trace); } }) };
}

function duplicateCoverageFixture() {
  const f = fixture();
  // Two independent canonical records express the same fact; only the first
  // record is cited. Duplicate coverage must not create a citation to the second.
  const original = f.snapshot.findings[0]!; const duplicate = f.snapshot.findings[1]!;
  Object.assign(duplicate, { body: original.body, title: original.title, kind: original.kind,
    structuredData: structuredClone(original.structuredData) });
  f.snapshot.evidence.find((entry) => entry.sourceRef === duplicate.evidenceRefs[0])!.text =
    f.snapshot.evidence.find((entry) => entry.sourceRef === original.evidenceRefs[0])!.text;
  f.generated.splice(1); f.claims.splice(1); f.wire.items.splice(1);
  Object.assign(f.wire.coverage[1]!, { status: "duplicate", reasonCode: "duplicate", claimIds: [f.claims[0]!.id],
    matches: [{ claimId: f.claims[0]!.id, sourceExcerpt: duplicate.body, claimExcerpt: f.claims[0]!.text }] });
  return f;
}

describe("Weekly generation verifier row recovery through actual mock SSE", () => {
  it("preserves valid verdicts, text, source refs and complete coverage", async () => {
    const f = fixture(); const before = JSON.stringify({ wire: f.wire, snapshot: f.snapshot, generated: f.generated });
    const result = await f.run();
    expect(result.status).toBe("verified"); expect(result.items).toHaveLength(2);
    expect(result.quality_assessment).toMatchObject({ status: "passed", coveredSourceCount: 2 });
    expect(JSON.stringify({ wire: f.wire, snapshot: f.snapshot, generated: f.generated })).toBe(before);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.log).not.toHaveBeenCalled();
  });

  it("normalizes only the observed alias, retaining its negative verdict and original evidence", async () => {
    const f = fixture(); f.wire.items[1]!.verdict = "partial_entailed";
    f.wire.items[1]!.issueCodes = ["missing_qualification"];
    const before = JSON.stringify(f.wire);
    const verdicts = await f.verify();
    expect(verdicts[1]).toEqual({ ...f.wire.items[1], verdict: "partially_entailed" });
    expect(JSON.stringify(f.wire)).toBe(before);
    expect(f.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.log.mock.calls[0]![0])).toMatchObject({ normalizedAliasCount: 1, localizedInvalidCount: 0 });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it.each(["partial_entailed", "partially_entailed", "entailed"])(
    "rejects a %s row without support while publishing the safe sibling with truthful coverage", async (verdict) => {
      const f = fixture(); Object.assign(f.wire.items[1]!, { verdict, issueCodes: ["claim_exceeds_source"], supportedSourceRefs: [] });
      const result = await f.run();
      expect(result.status).toBe("needs_review");
      expect(result.items.map((item) => item.text)).toEqual([f.claims[0]!.text]);
      expect(result.quality_assessment).toMatchObject({ status: "needs_review", coveredSourceCount: 1, partialSourceCount: 1,
        reasonCodes: ["coverage_claim_filtered"] });
      const verified = f.traces.find((trace) => trace.stage === "verified")!;
      expect(verified.stage === "verified" && verified.verdicts[1]).toMatchObject({ verdict: "unverifiable",
        issueCodes: ["verifier_missing_supported_sources", "claim_exceeds_source"], supportedSourceRefs: [] });
      const published = f.traces.find((trace) => trace.stage === "published")!;
      expect(published.stage === "published" && published.claims[1]).toMatchObject({ outcome: "rejected", reasonCode: "verifier_unverifiable" });
      expect(f.create).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["unknown_verdict", "missing_verdict", "invalid_issues", "extra_field", "duplicate_refs", "malformed_refs"])(
    "localizes an identifiable %s row without approving it or leaking its content", async (mode) => {
      const f = fixture(); const row = f.wire.items[1]!;
      if (mode === "unknown_verdict") row.verdict = "PRIVATE_FULLY_ENTAILED";
      if (mode === "missing_verdict") delete row.verdict;
      if (mode === "invalid_issues") row.issueCodes = "PRIVATE_ISSUE";
      if (mode === "extra_field") row.PRIVATE_KEY = "PRIVATE_CONTENT";
      if (mode === "duplicate_refs") row.supportedSourceRefs = [refs.proposal, refs.proposal];
      if (mode === "malformed_refs") row.supportedSourceRefs = null;
      const result = await f.run();
      expect(result.items.map((item) => item.text)).toEqual([f.claims[0]!.text]);
      expect(result.quality_assessment.status).toBe("needs_review");
      const verified = f.traces.find((trace) => trace.stage === "verified")!;
      expect(verified.stage === "verified" && verified.verdicts[1]).toMatchObject({ verdict: "unverifiable",
        issueCodes: ["verifier_item_invalid"], supportedSourceRefs: [] });
      expect(JSON.stringify(f.log.mock.calls)).not.toMatch(/PRIVATE|work:finding|work:evidence|claim_\d/u);
      expect(f.create).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["duplicate_id", "unknown_id", "missing_row", "invalid_id"])("keeps %s a batch failure", async (mode) => {
    const f = fixture(); f.wire.items[1]!.verdict = "partial_entailed";
    if (mode === "duplicate_id") f.wire.items[1]!.claimId = f.claims[0]!.id;
    if (mode === "unknown_id") f.wire.items[1]!.claimId = "PRIVATE_FOREIGN_CLAIM";
    if (mode === "missing_row") f.wire.items.pop();
    if (mode === "invalid_id") f.wire.items[1]!.claimId = null;
    await expect(f.run()).rejects.toThrow(mode === "invalid_id" ? "work_weekly_provider_schema_invalid" : "work_weekly_verifier_output_invalid");
    expect(f.traces.map((trace) => trace.stage)).toEqual(["synthesized"]);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("PRIVATE_FOREIGN_CLAIM");
  });

  it.each(["foreign_ref", "foreign_with_invalid_verdict", "sibling_ref"])("never hides %s while localizing rows", async (mode) => {
    const f = fixture(); f.wire.items[1]!.supportedSourceRefs = [mode === "sibling_ref" ? refs.dated : "work:evidence:PRIVATE_FOREIGN"];
    if (mode === "foreign_with_invalid_verdict") f.wire.items[1]!.verdict = "PRIVATE_UNKNOWN";
    await expect(f.run()).rejects.toThrow("work_weekly_verifier_source_not_allowed");
    expect(f.traces.map((trace) => trace.stage)).toEqual(["synthesized"]);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("PRIVATE");
  });

  it("keeps an unknown coverage identity fatal rather than inventing coverage", async () => {
    const f = fixture(); f.wire.coverage[1]!.sourceRef = "work:finding:foreign";
    await expect(f.run()).rejects.toThrow("work_weekly_coverage_output_invalid");
    expect(f.traces.map((trace) => trace.stage)).toEqual(["synthesized"]);
  });

  it("returns no_safe_items when all rows lack support", async () => {
    const f = fixture(); f.wire.items.forEach((row) => Object.assign(row, { verdict: "partial_entailed", supportedSourceRefs: [] }));
    const result = await f.run();
    expect(result).toMatchObject({ status: "no_safe_items", items: [], quality_assessment: { status: "insufficient" } });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("keeps the non-generation verifier contract strict", async () => {
    const f = fixture(); f.wire.items[1]!.verdict = "partial_entailed";
    delete (f.wire as Record<string, unknown>).coverage;
    delete (f.wire as Record<string, unknown>).disputes;
    await expect(f.verifier.verify({ accountId: f.snapshot.accountId, snapshot: f.snapshot, claims: f.claims }))
      .rejects.toThrow("work_weekly_provider_schema_invalid");
  });

  it("rejects the wrong account before requesting any response", async () => {
    const f = fixture();
    await expect(f.verifier.verify({ accountId: "foreign_account", snapshot: f.snapshot, claims: f.claims, onCoverage: () => {} })).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("passes a conditional AI attention basis and the clarified contract to verification without changing the text", async () => {
    const f = fixture(); const text = "在确认采集可行且不涉及敏感正文后，可关注自动汇总是否进入评估。";
    f.generated[1]!.section = "next_week"; f.generated[1]!.itemType = "suggestion";
    f.generated[1]!.claims[0]!.text = text;
    // A fixed local verdict proves contract and publication behavior, not prompt effectiveness on a model.
    const result = await f.run();
    const publication = f.traces.find((trace) => trace.stage === "published");
    expect(publication?.stage === "published" && publication.claims.map((claim) => claim.reasonCode)).toEqual(["accepted", "accepted"]);
    expect(result.items[1]!.text).toBe(`AI建议关注：${text}`);
    const messages = f.create.mock.calls[0]![0].input;
    const pack = JSON.parse(messages.find((message) => message.role === "user")!.content);
    expect(pack.items[1].claim.text).toBe(text);
    expect(pack.items[1].publicationContext).toMatchObject({ section: "next_week", itemType: "suggestion" });
    const instructions = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    expect(instructions).toContain("原文不必逐字提出相同的未来建议");
    expect(instructions).toContain("不得新增owner/deadline/用户承诺、已批准或已执行状态");
    expect(instructions).toContain("重要触发条件未改变");
  });

  it.each(["成员总是否定反馈。", "他们总是延迟交付。"])("retains the actual absolute-frequency backstop: %s", async (text) => {
    const f = fixture(); f.generated[1]!.claims[0]!.text = text;
    const result = await f.run();
    expect(result.items.map((item) => item.text)).toEqual([f.claims[0]!.text]);
    const publication = f.traces.find((trace) => trace.stage === "published");
    expect(publication?.stage === "published" && publication.claims[1]!.reasonCode).toBe("claim_type_mismatch");
  });
});

describe("Weekly generation duplicate coverage status recovery", () => {
  it("recovers an explicit duplicate status without changing text, references, identity or raw input", async () => {
    const f = duplicateCoverageFixture();
    const before = JSON.stringify({ wire: f.wire, snapshot: f.snapshot, generated: f.generated });
    const result = await f.run();
    expect(result.status).toBe("verified");
    expect(result.items.map(({ text, sourceRefs }) => ({ text, sourceRefs })))
      .toEqual([{ text: f.claims[0]!.text, sourceRefs: f.claims[0]!.sourceRefs }]);
    expect(result.quality_assessment).toMatchObject({ status: "passed", coveredSourceCount: 1,
      notApplicableSourceCount: 1, partialSourceCount: 0, omittedSourceCount: 0 });
    const verified = f.traces.find((trace) => trace.stage === "verified");
    expect(verified?.stage === "verified" && verified.coverage?.[1]).toEqual({
      sourceRef: f.wire.coverage[1]!.sourceRef, status: "not_applicable", reasonCode: "duplicate", claimIds: [f.claims[0]!.id]
    });
    expect(verified?.stage === "verified" && verified.auditDetails?.coverageMatches[1]!.matches)
      .toEqual(f.wire.coverage[1]!.matches);
    expect(JSON.stringify({ wire: f.wire, snapshot: f.snapshot, generated: f.generated })).toBe(before);
    expect(f.log).toHaveBeenCalledTimes(1); // Transport and injected seam normalization are idempotent.
    expect(JSON.parse(f.log.mock.calls[0]![0])).toEqual({ component: "work-weekly-verifier-contract",
      reason: "generation_coverage_normalization", normalizedDuplicateStatusCount: 1 });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("leaves the canonical duplicate representation unchanged", async () => {
    const f = duplicateCoverageFixture(); f.wire.coverage[1]!.status = "not_applicable";
    const before = JSON.stringify(f.wire);
    expect((await f.run()).status).toBe("verified");
    expect(JSON.stringify(f.wire)).toBe(before); expect(f.log).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate", "covered"], ["duplicate", "missing_key_content"], ["duplicate", "background_only"],
    ["PRIVATE_UNKNOWN_STATUS", "duplicate"], ["duplicate", "PRIVATE_UNKNOWN_REASON"]
  ])("does not guess a canonical meaning for status=%s reason=%s", async (status, reasonCode) => {
    const f = duplicateCoverageFixture(); Object.assign(f.wire.coverage[1]!, { status, reasonCode });
    await expect(f.run()).rejects.toThrow("work_weekly_provider_schema_invalid");
    expect(f.traces.map((trace) => trace.stage)).toEqual(["synthesized"]);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("PRIVATE");
  });

  it.each(["unknown_source", "duplicate_source", "missing_source", "unknown_claim", "duplicate_claim", "unknown_match"])(
    "keeps %s identity errors fatal even with the known status alias", async (mode) => {
      const f = duplicateCoverageFixture(); const row = f.wire.coverage[1]!;
      if (mode === "unknown_source") row.sourceRef = "work:finding:PRIVATE_FOREIGN";
      if (mode === "duplicate_source") row.sourceRef = f.wire.coverage[0]!.sourceRef;
      if (mode === "missing_source") f.wire.coverage.splice(0, 1);
      if (mode === "unknown_claim") row.claimIds = ["PRIVATE_FOREIGN_CLAIM"];
      if (mode === "duplicate_claim") row.claimIds.push(row.claimIds[0]!);
      if (mode === "unknown_match") row.matches = [{ claimId: "PRIVATE_FOREIGN_CLAIM" }];
      await expect(f.run()).rejects.toThrow(mode === "unknown_match"
        ? "work_weekly_verifier_output_invalid" : "work_weekly_coverage_output_invalid");
      expect(f.traces.map((trace) => trace.stage)).toEqual(["synthesized"]);
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(f.log.mock.calls)).not.toContain("PRIVATE");
    }
  );

  it.each(["foreign", "other_source"])("does not allow a %s supporting reference through the coverage alias", async (mode) => {
    const f = duplicateCoverageFixture(); f.wire.items[0]!.supportedSourceRefs = [mode === "foreign"
      ? "work:evidence:PRIVATE_FOREIGN" : f.snapshot.findings[1]!.sourceRef];
    await expect(f.run()).rejects.toThrow("work_weekly_verifier_source_not_allowed");
    expect(f.traces.map((trace) => trace.stage)).toEqual(["synthesized"]);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("PRIVATE");
  });

  it.each(["empty_selection", "contradictory_canonical_status"])("retains an honest coverage gap for %s", async (mode) => {
    const f = duplicateCoverageFixture();
    if (mode === "empty_selection") { f.wire.coverage[1]!.claimIds = []; f.wire.coverage[1]!.matches = []; }
    else f.wire.coverage[1]!.status = "partial";
    const result = await f.run();
    expect(result.items).toHaveLength(1); expect(result.status).toBe("needs_review");
    expect(result.quality_assessment).toMatchObject({ coveredSourceCount: 1, omittedSourceCount: 1,
      notApplicableSourceCount: 0, reviewIssues: [{ sourceRef: f.wire.coverage[1]!.sourceRef, reasonCode: "missing_key_content" }] });
  });

  it("does not count duplicate coverage when its selected claim is rejected", async () => {
    const f = duplicateCoverageFixture(); Object.assign(f.wire.items[0]!, {
      verdict: "unsupported", issueCodes: ["claim_exceeds_source"], supportedSourceRefs: []
    });
    const result = await f.run();
    expect(result.status).toBe("no_safe_items"); expect(result.items).toEqual([]);
    expect(result.quality_assessment).toMatchObject({ partialSourceCount: 2, notApplicableSourceCount: 0,
      coveredSourceCount: 0, reasonCodes: expect.arrayContaining(["coverage_claim_filtered", "no_safe_items"]) });
    const verified = f.traces.find((trace) => trace.stage === "verified");
    expect(verified?.stage === "verified" && verified.verdicts[0]).toEqual(f.wire.items[0]);
  });

  it("keeps a valid non-generation verdict wire unchanged and rejects auxiliary coverage there", async () => {
    const f = duplicateCoverageFixture();
    const call = { accountId: f.snapshot.accountId, snapshot: f.snapshot, claims: f.claims };
    await expect(f.verifier.verify(call)).rejects.toThrow("work_weekly_provider_schema_invalid");
    delete (f.wire as Record<string, unknown>).coverage;
    delete (f.wire as Record<string, unknown>).disputes;
    expect(await f.verifier.verify(call)).toEqual(f.wire.items);
    expect(f.log.mock.calls.map(([message]) => JSON.parse(message).reason)).not.toContain("generation_coverage_normalization");
  });
});

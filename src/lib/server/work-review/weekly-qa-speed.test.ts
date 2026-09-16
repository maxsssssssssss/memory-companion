// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { answerWorkWeeklyQuestion, buildWorkWeeklyQaSourcePack,
  createStructuredWorkWeeklyQaAnswerer, createStructuredWorkWeeklyQaVerifier } from "./weekly-qa-provider";
import { resolveWorkWeeklySourceRecord, type WorkWeeklyGeneratedClaim, type WorkWeeklyStructuredJsonRequest } from "./weekly-ai-provider";
import { WORK_WEEKLY_TEST_REFS as refs, workWeeklyProfile, workWeeklyTestSnapshot } from "./weekly-ai-test-fixture";

describe("QA compact requests and verified paragraphs", () => {
  it("keeps all selected source values/scope/allowlist while deduplicating verifier records", async () => {
    const snapshot = workWeeklyTestSnapshot();
    const sourcePack = buildWorkWeeklyQaSourcePack({ accountId: snapshot.accountId, weeklyReviewId: "weekly_a", snapshot, question: "本周决定了什么？" });
    const claims: WorkWeeklyGeneratedClaim[] = [
      { id: "a", text: "最终选择方案 B。", claimType: "decision", sourceRefs: [refs.decision] },
      { id: "b", text: "另有待确认提议。", claimType: "fact", sourceRefs: [refs.proposal, refs.decision] }
    ];
    const request = vi.fn<WorkWeeklyStructuredJsonRequest>(async (call) => {
      call.onUsage?.({ inputTokens: 100, outputTokens: 40, reasoningTokens: 0 });
      return call.profile.role === "qa_answerer" ? { status: "answered", answer: "", claims, relevantSourceRefs: [refs.decision, refs.proposal] }
        : { items: claims.map((claim) => ({ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs })) };
    });
    const onMetrics = vi.fn();
    await createStructuredWorkWeeklyQaAnswerer({ profile: workWeeklyProfile("qa_answerer"), requestStructuredJson: request }).answer({ sourcePack, onMetrics });
    await createStructuredWorkWeeklyQaVerifier({ profile: workWeeklyProfile("qa_verifier"), requestStructuredJson: request }).verify({ snapshot, sourcePack, claims, onMetrics });
    const content = request.mock.calls.map(([call]) => (call.requestInput as Array<{ role: string; content: string }>).find((message) => message.role === "user")!.content);
    const [answerer, verifier] = content.map((value) => JSON.parse(value));
    expect(answerer).toEqual({ question: sourcePack.question, scope: sourcePack.scope, history: sourcePack.history,
      units: sourcePack.units.map(({ sourceKind, value }) => ({ sourceKind, value })), allowlistedSourceRefs: sourcePack.allowlistedSourceRefs });
    expect(Buffer.byteLength(content[0]!)).toBeLessThan(Buffer.byteLength(JSON.stringify(sourcePack)));
    expect(verifier).toEqual({ scope: sourcePack.scope, items: claims.map((claim) => ({ claim })),
      sources: [refs.decision, refs.proposal].map((ref) => resolveWorkWeeklySourceRecord(snapshot, ref)) });
    expect(onMetrics).toHaveBeenCalledWith({ inputBytes: Buffer.byteLength(content[0]!) });
    expect(onMetrics).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 40, reasoningTokens: 0 });
  });

  it("formats only surviving verified claims, with deduplication and no free answer text", async () => {
    const claims: WorkWeeklyGeneratedClaim[] = [
      { id: "a", text: "最终选择方案 B。", claimType: "decision", sourceRefs: [refs.decision] },
      { id: "b", text: "方案 C 仍是提议。", claimType: "fact", sourceRefs: [refs.proposal] },
      { id: "duplicate", text: "最终选择方案 B。", claimType: "decision", sourceRefs: [refs.decision] }
    ];
    const onDiagnostic = vi.fn();
    const result = await answerWorkWeeklyQuestion({ accountId: "account_a", weeklyReviewId: "weekly_a", snapshot: workWeeklyTestSnapshot(),
      question: "本周决定和提议是什么？", onDiagnostic,
      answerer: { profile: workWeeklyProfile("qa_answerer"), answer: async () => ({ status: "answered", answer: "UNVERIFIED_FREE_TEXT", claims, relevantSourceRefs: [refs.decision, refs.proposal] }) },
      verifier: { profile: workWeeklyProfile("qa_verifier"), verify: async () => claims.map((claim) => ({ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs })) } });
    expect(result.answer).toBe(`${claims[0]!.text}\n\n${claims[1]!.text}`);
    expect(result.sourceRefs.sort()).toEqual([refs.decision, refs.proposal].sort());
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/UNVERIFIED_FREE_TEXT|方案|work:finding/);
    expect(onDiagnostic.mock.calls.every(([event]) => event.elapsedMs >= 0)).toBe(true);
  });

  it("deduplicated records never authorize a verifier citation outside that claim", async () => {
    const snapshot = workWeeklyTestSnapshot();
    const sourcePack = buildWorkWeeklyQaSourcePack({ accountId: snapshot.accountId, weeklyReviewId: "weekly_a", snapshot, question: "本周" });
    const claims: WorkWeeklyGeneratedClaim[] = [
      { id: "a", text: "决定", claimType: "decision", sourceRefs: [refs.decision] },
      { id: "b", text: "提议", claimType: "fact", sourceRefs: [refs.proposal] }
    ];
    const verifier = createStructuredWorkWeeklyQaVerifier({ profile: workWeeklyProfile("qa_verifier"), requestStructuredJson: async () => ({
      items: claims.map((claim) => ({ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: [refs.proposal] }))
    }) });
    await expect(verifier.verify({ snapshot, sourcePack, claims })).rejects.toMatchObject({ code: "work_weekly_verifier_source_not_allowed" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { WorkWeeklyProviderError } from "./weekly-ai-provider";
import { WORK_WEEKLY_TEST_REFS as refs, workWeeklyProfile, workWeeklyTestSnapshot } from "./weekly-ai-test-fixture";
import { answerWorkWeeklyQuestion, type WorkWeeklyQaAnswerer, type WorkWeeklyQaVerifier } from "./weekly-qa-provider";
import { workWeeklyQaSchemaIssues, type WorkWeeklyQaDiagnostic } from "./weekly-qa-diagnostics";

const decision = { id: "decision", text: "选择方案 B", claimType: "decision" as const, sourceRefs: [refs.decision] };
const verdict = { claimId: decision.id, verdict: "entailed" as const, issueCodes: [], supportedSourceRefs: decision.sourceRefs };

function setup() {
  const answer = vi.fn<WorkWeeklyQaAnswerer["answer"]>(async () => ({ status: "answered", answer: "自由文本不能发布",
    claims: [decision], relevantSourceRefs: decision.sourceRefs }));
  const verify = vi.fn<WorkWeeklyQaVerifier["verify"]>(async () => [verdict]);
  const events: WorkWeeklyQaDiagnostic[] = [];
  const input = { accountId: "account_a", weeklyReviewId: "weekly_a", question: "本周工作记录有哪些？",
    snapshot: workWeeklyTestSnapshot(),
    answerer: { profile: workWeeklyProfile("qa_answerer"), answer },
    verifier: { profile: workWeeklyProfile("qa_verifier"), verify },
    onDiagnostic: (event: WorkWeeklyQaDiagnostic) => { events.push(event); } };
  return { input, answer, verify, events };
}

describe("Work Weekly QA technical failures and safe diagnostic boundaries", () => {
  it.each(["answerer", "verifier"] as const)("classifies %s timeout without publishing insufficient evidence or retrying", async (stage) => {
    const { input, answer, verify, events } = setup();
    (stage === "answerer" ? answer : verify).mockRejectedValue(new WorkWeeklyProviderError("work_weekly_provider_timeout"));
    await expect(answerWorkWeeklyQuestion(input)).rejects.toMatchObject({ code: "weekly_qa_provider_timeout", stage });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(stage === "answerer" ? 0 : 1);
    expect(events.at(-1)).toMatchObject({ stage, outcome: "failed", errorCode: "weekly_qa_provider_timeout" });
    expect(events.some((event) => event.outcome === "insufficient_evidence")).toBe(false);
  });

  it("keeps malformed Provider JSON and arbitrary error messages out of diagnostic output", async () => {
    const { input, answer, events } = setup();
    answer.mockRejectedValue(Object.assign(new Error("https://private.test/?token=secret user body"), { code: "weekly_secret_body" }));
    await expect(answerWorkWeeklyQuestion(input)).rejects.toMatchObject({ code: "weekly_qa_provider_failed" });
    expect(JSON.stringify(events)).not.toMatch(/secret|private\.test|user body|work:finding/u);
    answer.mockRejectedValue(Object.assign(new Error("private malformed JSON"), { code: "invalid_json" }));
    await expect(answerWorkWeeklyQuestion(input)).rejects.toMatchObject({ code: "weekly_qa_provider_response_invalid" });
  });

  it("preserves schema paths through a wrapped Provider error while removing keys, values and issue messages", async () => {
    const { input, answer, events } = setup();
    const parsed = z.object({ claims: z.array(z.object({ claimType: z.enum(["fact"]) }).strict()) }).strict()
      .safeParse({ claims: [{ claimType: "secret enum", "https://secret.test/token": "private body" }] });
    if (parsed.success) throw new Error("expected invalid fixture");
    answer.mockRejectedValue(new WorkWeeklyProviderError("work_weekly_provider_schema_invalid", undefined, { cause: parsed.error }));
    await expect(answerWorkWeeklyQuestion(input)).rejects.toMatchObject({ code: "weekly_qa_provider_schema_invalid" });
    expect(events.at(-1)?.schemaIssues).toContainEqual({ code: "invalid_enum_value", path: "claims.0.claimType" });
    expect(JSON.stringify(events)).not.toMatch(/secret|private body|token|https:/u);
    const dynamicPath = new z.ZodError([{ code: "custom", path: ["claims", 0, "secret field"], message: "secret message" }]);
    expect(workWeeklyQaSchemaIssues(dynamicPath)).toEqual([{ code: "custom", path: "claims.0.other" }]);
  });

  it.each(["missing", "duplicate", "foreign_claim", "foreign_ref", "extra_field"])("rejects %s verifier contract as technical failure", async (kind) => {
    const { input, verify } = setup();
    const values = {
      missing: [], duplicate: [verdict, verdict], foreign_claim: [{ ...verdict, claimId: "unknown" }],
      foreign_ref: [{ ...verdict, supportedSourceRefs: [refs.commitment] }], extra_field: [{ ...verdict, quote: "private quote" }]
    };
    verify.mockResolvedValue(values[kind as keyof typeof values]);
    await expect(answerWorkWeeklyQuestion(input)).rejects.toMatchObject({
      code: kind === "foreign_ref" ? "weekly_qa_source_not_allowlisted" : "weekly_qa_verifier_invalid"
    });
  });

  it.each(["empty", "duplicate", "foreign_ref"])("validates %s injected Answerer output before verifier", async (kind) => {
    const { input, answer, verify } = setup();
    answer.mockResolvedValue({ status: "answered", answer: "free text", relevantSourceRefs: [],
      claims: kind === "empty" ? [] : kind === "duplicate" ? [decision, decision]
        : [{ ...decision, sourceRefs: ["work:evidence:foreign"] }] });
    await expect(answerWorkWeeklyQuestion(input)).rejects.toMatchObject({
      code: kind === "foreign_ref" ? "weekly_qa_source_not_allowlisted" : "weekly_qa_answer_invalid"
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("keeps an explicit Answerer lack of support as insufficient evidence", async () => {
    const { input, answer, verify, events } = setup();
    answer.mockResolvedValue({ status: "insufficient_evidence", answer: "不安全自由文字", claims: [], relevantSourceRefs: [] });
    expect(await answerWorkWeeklyQuestion(input)).toMatchObject({ answerStatus: "insufficient_evidence", sourceRefs: [],
      failureCode: "weekly_qa_answerer_insufficient" });
    expect(verify).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ stage: "answerer", outcome: "insufficient_evidence" });
  });

  it("records unsupported verdict counts, never unknown issue text, and returns true insufficient evidence", async () => {
    const { input, verify, events } = setup();
    verify.mockResolvedValue([{ ...verdict, verdict: "unsupported", issueCodes: ["secret provider issue"], supportedSourceRefs: [] }]);
    expect(await answerWorkWeeklyQuestion(input)).toMatchObject({ answerStatus: "insufficient_evidence", sourceRefs: [],
      failureCode: "weekly_qa_no_safe_claims" });
    expect(events).toContainEqual(expect.objectContaining({ stage: "verifier", verdictCounts: { unsupported: 1 }, issueCounts: { other: 1 } }));
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("publishes only the independently supported claim as partially answered", async () => {
    const { input, answer, verify } = setup();
    const second = { id: "commitment", text: "已记录发布清单承诺", claimType: "commitment" as const, sourceRefs: [refs.commitment] };
    answer.mockResolvedValue({ status: "answered", answer: "free prose", claims: [decision, second], relevantSourceRefs: [] });
    verify.mockResolvedValue([verdict, { claimId: second.id, verdict: "unsupported", issueCodes: [], supportedSourceRefs: [] }]);
    expect(await answerWorkWeeklyQuestion(input)).toMatchObject({ answerStatus: "partially_answered", answer: decision.text, sourceRefs: decision.sourceRefs });
  });

  it("does not turn a local publication schema limit into missing evidence", async () => {
    const { input, answer, verify } = setup();
    const claims = Array.from({ length: 33 }, (_, index) => ({ ...decision, id: `claim_${index}` }));
    answer.mockResolvedValue({ status: "answered", answer: "free prose", claims, relevantSourceRefs: [] });
    verify.mockResolvedValue(claims.map((claim) => ({ ...verdict, claimId: claim.id })));
    await expect(answerWorkWeeklyQuestion(input)).rejects.toMatchObject({ code: "weekly_qa_publication_invalid" });
  });

  it("marks a surviving independent answer partial when the local safety gate rejects another claim", async () => {
    const { input, answer, verify } = setup();
    const unsafe = { id: "proposal", text: "已决定采用方案 A", claimType: "decision" as const, sourceRefs: [refs.proposal] };
    answer.mockResolvedValue({ status: "answered", answer: "free", claims: [decision, unsafe], relevantSourceRefs: [] });
    verify.mockResolvedValue([verdict, { ...verdict, claimId: unsafe.id, supportedSourceRefs: unsafe.sourceRefs }]);
    expect(await answerWorkWeeklyQuestion(input)).toMatchObject({ answerStatus: "partially_answered",
      answer: decision.text, sourceRefs: decision.sourceRefs });
  });

  it.each(["before_answerer", "after_answerer", "after_verifier"])("does not publish cancelled work %s", async (at) => {
    const { input, answer, verify } = setup();
    const controller = new AbortController();
    if (at === "before_answerer") controller.abort();
    if (at === "after_answerer") answer.mockImplementation(async () => { controller.abort(); return {
      status: "answered", answer: "free", claims: [decision], relevantSourceRefs: [] }; });
    if (at === "after_verifier") verify.mockImplementation(async () => { controller.abort(); return [verdict]; });
    await expect(answerWorkWeeklyQuestion({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: "weekly_qa_cancelled" });
    expect(answer).toHaveBeenCalledTimes(at === "before_answerer" ? 0 : 1);
    expect(verify).toHaveBeenCalledTimes(at === "after_verifier" ? 1 : 0);
  });

  it("cannot let a diagnostic observer failure alter a supported answer", async () => {
    const { input } = setup();
    expect(await answerWorkWeeklyQuestion({ ...input, onDiagnostic: async () => { throw new Error("private sink error"); } }))
      .toMatchObject({ answerStatus: "answered", answer: decision.text });
  });

  it.each(["finding_only", "static_todo"] as const)("answers %s without requiring both meetings and Todo events", async (kind) => {
    const { input, answer, verify, events } = setup();
    const keep = new Set<string>(kind === "finding_only" ? [refs.meeting, refs.decision, refs.evidenceDecision] : [refs.todo]);
    const snapshot = input.snapshot;
    snapshot.meetings = snapshot.meetings.filter((row) => keep.has(row.sourceRef));
    snapshot.findings = snapshot.findings.filter((row) => keep.has(row.sourceRef));
    snapshot.evidence = snapshot.evidence.filter((row) => keep.has(row.sourceRef));
    snapshot.todos = snapshot.todos.filter((row) => keep.has(row.sourceRef));
    snapshot.todoEvents = [];
    snapshot.identities = snapshot.identities.filter((row) => keep.has(row.sourceRef));
    snapshot.allowlistedSourceRefs = snapshot.allowlistedSourceRefs.filter((ref) => keep.has(ref));
    if (kind === "static_todo") {
      snapshot.todos[0]!.current.status = "open";
      snapshot.todos[0]!.stateAtWeekEnd!.status = "open";
      const claim = { id: "state", text: "该待办在系统中的状态为未完成。", claimType: "fact" as const, sourceRefs: [refs.todo] };
      answer.mockResolvedValue({ status: "answered", answer: "free", claims: [claim], relevantSourceRefs: claim.sourceRefs });
      verify.mockResolvedValue([{ ...verdict, claimId: claim.id, supportedSourceRefs: claim.sourceRefs }]);
    }
    const result = await answerWorkWeeklyQuestion(input);
    expect(result.answerStatus).toBe("answered");
    expect(result.sourceRefs).toEqual([kind === "finding_only" ? refs.decision : refs.todo]);
    expect(events[0]).toMatchObject({ stage: "source_selection", sourceUnitCount: 1,
      findingUnitCount: kind === "finding_only" ? 1 : 0, todoUnitCount: kind === "static_todo" ? 1 : 0 });
  });
});

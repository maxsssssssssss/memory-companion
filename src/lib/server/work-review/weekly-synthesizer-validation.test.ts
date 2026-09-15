// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptWorkWeeklyModelResponse, createStructuredWorkWeeklySynthesizer,
  WorkWeeklySynthesizerModelResponseSchema, workWeeklyCoverageSourceRefs } from "./weekly-ai-provider";
import { applyWorkWeeklyClaimPublicationPolicy, runWorkWeeklyGenerationPipeline } from "./weekly-publication-policy";
import { WORK_WEEKLY_TEST_REFS as refs, workWeeklyProfile, workWeeklyTestSnapshot } from "./weekly-ai-test-fixture";

afterEach(() => vi.restoreAllMocks());

function response(text = "待办已在系统中标记为完成，不代表实际交付。", sourceRefs = [refs.todoCompleted as string]) {
  return { items: [{ section: "completed", text, claimType: "completion", isInterpretation: false, sourceRefs }] };
}

function diagnostic(log: ReturnType<typeof vi.spyOn>) {
  return JSON.parse(String(log.mock.calls.at(-1)![0]));
}

describe("Weekly synthesis tolerates representation differences without losing evidence", () => {
  it.each([
    "待办已在系统中标记为完成，不代表实际交付。",
    "系统已将该待办标记完成，现实履行情况仍需核对。",
    "本周把待办状态改成了“已完成”；这只是系统记录。",
    "该待办在应用内被勾选为完成，尚不能据此确认交付。",
    "完成标记已写入待办清单，实际交付另需确认。",
    "上周创建的待办，本周已在系统中标记为完成。",
    "The todo was marked complete in the app this week; delivery is not established."
  ])("lets verified natural wording reach publication: %s", (text) => {
    const snapshot = workWeeklyTestSnapshot();
    const items = adaptWorkWeeklyModelResponse({ snapshot, response: response(text) });
    expect(applyWorkWeeklyClaimPublicationPolicy({ snapshot, items,
      verdicts: items.flatMap((item) => item.claims.map((claim) => ({ claimId: claim.id,
        verdict: "entailed" as const, issueCodes: [], supportedSourceRefs: claim.sourceRefs })))
    })).toMatchObject([{ text, sourceRefs: [refs.todoCompleted], section: "completed" }]);
  });

  it("deduplicates repeated citations before internal validation without changing text, scope or input", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const snapshot = workWeeklyTestSnapshot();
    const wire = response(undefined, [refs.todoCompleted, refs.todo, refs.todoCompleted, refs.todo]);
    const before = JSON.stringify({ snapshot, wire });
    expect(WorkWeeklySynthesizerModelResponseSchema.safeParse(wire).success).toBe(true);
    const items = adaptWorkWeeklyModelResponse({ snapshot, response: wire });
    expect(items[0]!.claims[0]!.sourceRefs).toEqual([refs.todoCompleted, refs.todo]);
    expect(items[0]!.claims[0]!.text).toBe(wire.items[0]!.text);
    expect(JSON.stringify({ snapshot, wire })).toBe(before);
    expect(diagnostic(log)).toMatchObject({ stage: "normalization", duplicateSourceRefCount: 2, affectedItemCount: 1 });
  });

  it.each(["2026-08-30", "2026-09-04", "2026-09-07"])("rejects an event outside the observed week with an actionable reason: %s", (date) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const snapshot = workWeeklyTestSnapshot(); snapshot.todoEvents[0]!.localDate = date;
    expect(() => adaptWorkWeeklyModelResponse({ snapshot, response: response() }))
      .toThrow("work_weekly_synthesizer_output_invalid");
    expect(diagnostic(log)).toMatchObject({ stage: "internal_validation", reason: "generated_items_invalid",
      validationIssues: [{ path: ["items", 0, "section"], reason: "completion_event_missing" }] });
  });

  it("does not let deduplication hide an unknown citation and does not log its value", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const wire = response("SYNTHETIC_PRIVATE_BODY", [refs.todoCompleted, "work:todo_event:PRIVATE_SOURCE", "work:todo_event:PRIVATE_SOURCE"]);
    expect(() => adaptWorkWeeklyModelResponse({ snapshot: workWeeklyTestSnapshot(), response: wire }))
      .toThrow("work_weekly_source_not_allowlisted");
    expect(diagnostic(log)).toMatchObject({ stage: "source_validation", reason: "source_not_allowlisted",
      invalidSourceRefCount: 1, affectedItemCount: 1, itemIndexes: [0] });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|work:todo_event|account_a/u);
  });

  it.each([
    ["missing field", { claimType: undefined }, "invalid_type", "claimType"],
    ["unknown value", { claimType: "PRIVATE_ENUM" }, "invalid_enum_value", "claimType"],
    ["unknown key", { PRIVATE_KEY: "PRIVATE_VALUE" }, "unrecognized_keys", null],
    ["wrong shape", { sourceRefs: null }, "invalid_type", "sourceRefs"]
  ] as const)("logs safe field paths and categories for %s", (_name, change, code, field) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const wire = response("PRIVATE_BODY"); Object.assign(wire.items[0]!, change);
    expect(() => adaptWorkWeeklyModelResponse({ snapshot: workWeeklyTestSnapshot(), response: wire }))
      .toThrow("work_weekly_synthesizer_output_invalid");
    expect(diagnostic(log)).toMatchObject({ component: "work-weekly-synthesizer-contract", stage: "model_schema",
      validationIssueCount: 1, validationIssues: [{ path: ["items", 0, ...(field ? [field] : [])], code }] });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|account_a|work:todo_event/u);
  });

  it("bounds diagnostic details but retains the full error count", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const wire = { items: Array.from({ length: 20 }, () => ({ ...response().items[0], claimType: "PRIVATE_ENUM" })) };
    expect(() => adaptWorkWeeklyModelResponse({ snapshot: workWeeklyTestSnapshot(), response: wire })).toThrow();
    expect(diagnostic(log)).toMatchObject({ validationIssueCount: 20, schemaIssueCounts: { invalid_enum_value: 20 },
      validationIssuesTruncated: true });
    expect(diagnostic(log).validationIssues).toHaveLength(10);
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
  });

  it("keeps independently supported content when another completion claim fails semantic verification", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshot = workWeeklyTestSnapshot();
    const good = "本周该待办在应用中勾选完成，现实履行仍需核对。";
    const bad = "PRIVATE_BODY：待办已经实际交付。";
    const wire = { items: [good, bad].map((text) => response(text, [refs.todo, refs.todoCompleted]).items[0]!) };
    const request = vi.fn(async () => wire);
    const result = await runWorkWeeklyGenerationPipeline({ accountId: snapshot.accountId, snapshot,
      synthesizer: createStructuredWorkWeeklySynthesizer({ profile: workWeeklyProfile("synthesizer"), requestStructuredJson: request }),
      verifier: { profile: workWeeklyProfile("verifier"), async verify(call) {
        const goodClaim = call.claims[0]!;
        call.onCoverage?.(workWeeklyCoverageSourceRefs(snapshot).map((sourceRef) => ({ sourceRef,
          status: goodClaim.sourceRefs.includes(sourceRef) ? "covered" : "omitted",
          reasonCode: goodClaim.sourceRefs.includes(sourceRef) ? "covered" : "missing_key_content",
          claimIds: goodClaim.sourceRefs.includes(sourceRef) ? [goodClaim.id] : [] })));
        return call.claims.map((claim, index) => ({ claimId: claim.id, verdict: index === 0 ? "entailed" : "unsupported",
          issueCodes: index === 0 ? [] : ["todo_state_not_real_world_completion", "PRIVATE_ISSUE"],
          supportedSourceRefs: index === 0 ? claim.sourceRefs : [] }));
      } }
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("needs_review");
    expect(result.items.map((item) => item.text)).toEqual([good]);
    expect(diagnostic(log)).toMatchObject({ stage: "publication", publishableItemCount: 1,
      rejectionReasons: { verifier_unsupported: 1 }, verifierIssueCounts: { todo_state_not_real_world_completion: 1, other: 1 } });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|work:todo|account_a|现实履行/u);
  });
});

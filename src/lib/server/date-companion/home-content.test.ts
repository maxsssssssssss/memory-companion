// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { DateCompanionHomeContent, DateCompanionProactiveValueContext } from "@/lib/domain/date-companion-proactive-value";
import { validateDateCompanionHomeContent } from "./home-content";

function context(): DateCompanionProactiveValueContext {
  return {
    schemaVersion: 1, scope: "person_relationship", relationshipId: "relationship_1",
    personId: "companion_1", mappingVersion: 1, referenceDate: "2026-09-08",
    evidence: [{
      evidenceId: "source_1", uploadId: "upload_1", sourceSegmentId: "segment_1",
      recordingDate: "2026-09-07", quote: "我正在准备周五的答辩。",
      contentDigest: "a".repeat(64), origin: "direct_conversation", subject: "companion"
    }]
  };
}

function content(): DateCompanionHomeContent {
  return { home: { about: [{ kind: "recent_update", text: "Ta 在准备周五的答辩。", evidenceIds: ["source_1"] }], beforeMeeting: [] }, evidenceIds: ["source_1"] };
}

describe("Date Companion home content authority", () => {
  it("accepts a grounded item and a genuinely empty selection", () => {
    expect(validateDateCompanionHomeContent({ context: context(), value: content() }).value).toEqual(content());
    const empty = { home: { about: [], beforeMeeting: [] }, evidenceIds: [] };
    expect(validateDateCompanionHomeContent({ context: context(), value: empty }).value).toEqual(empty);
  });
  it("rejects fabricated or incompletely covered citations", () => {
    const value = content();
    value.home.about[0].evidenceIds = ["fabricated"];
    value.evidenceIds = ["fabricated"];
    expect(validateDateCompanionHomeContent({ context: context(), value }).failureCode).toBe("invalid_evidence");
    value.evidenceIds = [];
    expect(validateDateCompanionHomeContent({ context: context(), value }).value).toBeNull();
  });
  it("does not turn self facts or mixed self facts into the companion's preferences", () => {
    const source = context();
    source.evidence[0].subject = "self";
    expect(validateDateCompanionHomeContent({ context: source, value: content() }).failureCode).toBe("invalid_home_subject");
    source.evidence.push({ ...source.evidence[0], evidenceId: "source_2", sourceSegmentId: "segment_2", subject: "companion" });
    const value = content();
    value.evidenceIds.push("source_2");
    value.home.about[0].evidenceIds.push("source_2");
    expect(validateDateCompanionHomeContent({ context: source, value }).value).toBeNull();
  });
  it("requires shared-moment evidence to have confirmed both subject", () => {
    const value = content();
    value.home.about[0].kind = "shared_moment";
    expect(validateDateCompanionHomeContent({ context: context(), value }).value).toBeNull();
    const source = context();
    source.evidence[0].subject = "both";
    expect(validateDateCompanionHomeContent({ context: source, value }).value).not.toBeNull();
  });
  it("frames reflection sources without turning them into direct quotes and remains cache-idempotent", () => {
    const source = context();
    source.evidence[0].origin = "user_reflection";
    const first = validateDateCompanionHomeContent({ context: source, value: content() });
    expect(first.value?.home.about[0].text).toBe("你在复盘中提到：Ta 在准备周五的答辩。");
    expect(validateDateCompanionHomeContent({ context: source, value: first.value }).value).toEqual(first.value);
    expect(validateDateCompanionHomeContent({ context: context(), value: first.value }).value).toBeNull();
  });
  it("rejects duplicate content across cards even with punctuation or width changes", () => {
    const value = content();
    value.home.beforeMeeting.push({ kind: "follow_up", text: "Ta 在准备周五的答辩！", reason: "可以跟进进度。", evidenceIds: ["source_1"] });
    expect(validateDateCompanionHomeContent({ context: context(), value }).value).toBeNull();
  });
  it.each(["missing", "done", "wrong_source"])("rejects %s promises", (mode) => {
    const source = context();
    if (mode !== "missing") source.promises = [{ id: "promise_1", text: "发送资料", status: mode === "done" ? "done" : "open", evidenceIds: mode === "wrong_source" ? ["another_source"] : ["source_1"] }];
    const value = { home: { about: [], beforeMeeting: [{ kind: "open_promise", promiseId: "promise_1", text: "记得发送资料。", reason: "你答应过发送资料。", evidenceIds: ["source_1"] }] }, evidenceIds: ["source_1"] };
    expect(validateDateCompanionHomeContent({ context: source, value }).value).toBeNull();
  });
  it("accepts an open promise but cannot disguise its done state as a follow-up", () => {
    const source = context();
    source.promises = [{ id: "promise_1", text: "发送资料", status: "open", evidenceIds: ["source_1"] }];
    const value: DateCompanionHomeContent = { home: { about: [], beforeMeeting: [{ kind: "open_promise", promiseId: "promise_1", text: "记得发送资料。", reason: "你答应过发送资料。", evidenceIds: ["source_1"] }] }, evidenceIds: ["source_1"] };
    expect(validateDateCompanionHomeContent({ context: source, value }).value).not.toBeNull();
    source.promises[0].status = "done";
    value.home.beforeMeeting[0].kind = "follow_up";
    delete value.home.beforeMeeting[0].promiseId;
    expect(validateDateCompanionHomeContent({ context: source, value }).failureCode).toBe("resolved_home_promise");
  });
});

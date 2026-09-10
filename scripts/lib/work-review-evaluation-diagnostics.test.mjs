import assert from "node:assert/strict";
import test from "node:test";
import { safeWorkProviderFields, summarizeWorkProviderFailures, evaluateWorkOrganizationOutcome } from "./work-review-evaluation-diagnostics.mjs";

test("preserves failure paths/counts and removes private values at the report boundary", () => {
  const result = safeWorkProviderFields({
    rawResponse: "PRIVATE_ANSWER", requestInput: "PRIVATE_SOURCE", apiKey: "PRIVATE_SECRET",
    failureCaptureState: "saved", diagnostics: {
      validationIssueCount: 2, validationIssuesTruncated: false,
      validationIssues: [{ path: "items", code: "too_big", message: "PRIVATE_MESSAGE", received: "PRIVATE_VALUE" },
        { path: "$", code: "unrecognized_keys", keys: ["PRIVATE_FIELD"] }],
      responseTextLength: 120, responseBody: "PRIVATE_BODY"
    }
  });
  assert.deepEqual(result.diagnostics.validationIssues, [
    { path: "items", code: "too_big" }, { path: "$", code: "unrecognized_keys" }
  ]);
  assert.equal(result.diagnostics.validationIssueCount, 2);
  assert.equal(result.diagnostics.validationIssuesTruncated, false);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
});

test("links only successfully saved failures with the original request number", () => {
  const requestTraceId = "61480af1-2c4d-4640-a645-68a4976329e6";
  const events = [
    { event: "request_started", requestTraceId },
    { event: "request_finished", requestTraceId, state: "failed", failureCaptureState: "saved", stage: "extractor" }
  ];
  assert.equal(summarizeWorkProviderFailures(events)[0].callNumber, 1);
  assert.equal(summarizeWorkProviderFailures(events)[0].rawResponseArtifact, `provider-failures/${requestTraceId}.json`);
  events[1].failureCaptureState = "write_failed";
  assert.equal(summarizeWorkProviderFailures(events)[0].rawResponseArtifact, null);
  events[1].state = "completed";
  assert.deepEqual(summarizeWorkProviderFailures(events), []);
});

test("cancellation, timeout and audited fallback cannot look like all successful requests", () => {
  const requestTraceId = "61480af1-2c4d-4640-a645-68a4976329e6";
  const events = [{ event: "request_started", requestTraceId, stage: "deduplicator" },
    { event: "request_finished", requestTraceId, stage: "deduplicator", state: "cancelled",
      errorCode: "work_analysis_provider_timeout", failureCaptureState: "saved" }];
  const result = summarizeWorkProviderFailures(events, { state: "fallback", reason: "provider_timeout", response: "PRIVATE_ANSWER" });
  assert.equal(result.length, 2); assert.equal(result[0].callNumber, 1);
  assert.equal(result[0].rawResponseArtifact, `provider-failures/${requestTraceId}.json`);
  assert.equal(result[1].reason, "provider_timeout");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  events[1].state = "completed";
  assert.equal(summarizeWorkProviderFailures(events, { state: "fallback", reason: "verification_capacity" }).length, 1);
  assert.equal(summarizeWorkProviderFailures([], { state: "fallback", reason: "budget_or_deadline" })[0].callNumber, 0);
});

test("separates local rejection, applied safety and effective removal", () => {
  const input = { requestCompleted: true, jsonCompleted: true, sourceFatesComplete: true,
    evidenceLayer: "fixture", organization: { acceptedPlan: { duplicates: [{}] }, skippedInvalidCount: 4,
      rejectedAdvice: [{ section: "duplicates", row: 1, reason: "cross_kind" }] },
    deduplication: { removed: [{ duplicateId: "recap", coveredByIds: ["detail"] }], decisions: [] } };
  const result = evaluateWorkOrganizationOutcome({ ...input, uniqueInformationLost: false });
  assert.equal(result.processStatus, "PASS"); assert.equal(result.rejectedCount, 4);
  assert.equal(result.deduplicationEffective, true); assert.equal(result.contentQualityStatus, "NOT RUN");
  assert.equal(evaluateWorkOrganizationOutcome({ ...input, uniqueInformationLost: true }).safetyStatus, "FAIL");
  assert.equal(evaluateWorkOrganizationOutcome(input).deduplicationEffective, false);
  assert.equal(evaluateWorkOrganizationOutcome(input).safetyStatus, "NOT RUN");
});

test("keeping everything is safe but is not effective deduplication", () => {
  const result = evaluateWorkOrganizationOutcome({ requestCompleted: true, jsonCompleted: true, sourceFatesComplete: true,
    uniqueInformationLost: false, evidenceLayer: "fixture", organization: { acceptedPlan: { duplicates: [] }, skippedInvalidCount: 7 },
    deduplication: { removed: [], decisions: [] } });
  assert.equal(result.processStatus, "PASS"); assert.equal(result.safetyStatus, "PASS");
  assert.equal(result.deduplicationEffective, false);
});

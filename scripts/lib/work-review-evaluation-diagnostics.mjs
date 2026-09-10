// Evaluation report boundary: raw responses live only in separate failure artifacts.
export function safeWorkProviderFields(value) {
  const numeric = new Set(["inputCharacters", "maxOutputTokens", "timeoutMs", "elapsedMs", "responseTextLength", "responseCharacters", "inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "httpStatus", "status", "headersMs", "headersReceivedMs", "firstBodyByteMs", "lastBodyByteMs", "bodyCompletedMs", "bodyBytes", "receivedBytes", "requestCount", "validationIssueCount", "responseCompleteDurationMs", "firstEventMs", "firstTextDeltaMs", "parseDurationMs", "validationDurationMs", "totalDurationMs"]);
  const enums = new Set(["stage", "state", "reason", "errorCode", "parseResult", "validationResult", "responseStatus", "incompleteReason", "transport", "rejectionClass", "failurePhase", "rejectionCategory", "phase", "finishReason", "failureCaptureState"]);
  const objects = new Set(["diagnostics", "http", "usage"]);
  const result = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (numeric.has(key) && typeof item === "number" && Number.isFinite(item) && item >= 0) result[key] = item;
    else if (enums.has(key) && typeof item === "string" && /^[a-z][a-z0-9_]{0,95}$/u.test(item)) result[key] = item;
    else if (objects.has(key) && item && typeof item === "object" && !Array.isArray(item)) result[key] = safeWorkProviderFields(item);
    else if (key === "requestTraceId" && typeof item === "string" && /^[a-f0-9-]{36}$/u.test(item)) result[key] = item;
    else if (key === "requestIdHash" && typeof item === "string" && /^[a-f0-9]{64}$/u.test(item)) result[key] = item;
    else if (key === "validationIssuesTruncated" && typeof item === "boolean") result[key] = item;
    else if (key === "validationIssues" && Array.isArray(item)) {
      result[key] = item.slice(0, 10).filter((issue) => issue && typeof issue.path === "string"
        && /^(?:\$|[A-Za-z0-9_.\[\]-]{1,240})$/u.test(issue.path)
        && typeof issue.code === "string" && /^[a-z_]{1,64}$/u.test(issue.code))
        .map(({ path, code }) => ({ path, code }));
    }
  }
  return result;
}

export function summarizeWorkProviderFailures(events, organization) {
  const starts = events.filter((event) => event.event === "request_started");
  const failures = events.filter((event) => event.event === "request_finished"
    && ["failed", "cancelled", "timeout", "fallback"].includes(event.state))
    .map((event) => {
      const safe = safeWorkProviderFields(event);
      return {
        callNumber: starts.findIndex((start) => start.requestTraceId === safe.requestTraceId) + 1,
        ...safe,
        rawResponseArtifact: safe.failureCaptureState === "saved" && safe.requestTraceId
          ? `provider-failures/${safe.requestTraceId}.json` : null
      };
    });
  // An optional stage may fall back after a completed HTTP request (invalid
  // plan/capacity), or without a request (budget). Reuse its retained audit.
  if (organization?.state === "fallback") {
    failures.push({ event: "organization_finished", stage: "deduplicator",
      ...safeWorkProviderFields({ state: organization.state, reason: organization.reason }),
      callNumber: starts.findLastIndex(event => event.stage === "deduplicator") + 1,
      rawResponseArtifact: null });
  }
  return failures;
}

// A rejected suggestion is not an applied semantic error. This summary requires
// an explicit information-loss audit; HTTP/JSON success or zero removals cannot
// be promoted to a content-quality/effectiveness pass.
export function evaluateWorkOrganizationOutcome({ requestCompleted, jsonCompleted, organization,
  deduplication, uniqueInformationLost = null, sourceFatesComplete = false, evidenceLayer }) {
  const accepted = Object.fromEntries(Object.entries(organization?.acceptedPlan ?? {}).map(([section, rows]) => [section, rows.length]));
  const removed = deduplication?.removed ?? [];
  const structurallyComplete = Boolean(requestCompleted && jsonCompleted && organization && sourceFatesComplete);
  return {
    evidenceLayer, requestCompleted: Boolean(requestCompleted), jsonCompleted: Boolean(jsonCompleted),
    accepted, rejectedAdvice: organization?.rejectedAdvice ?? [], rejectedCount: organization?.skippedInvalidCount ?? 0,
    deletionDecisions: deduplication?.decisions ?? [], appliedDeletions: removed,
    sourceFatesComplete, uniqueInformationLost,
    processStatus: structurallyComplete ? "PASS" : "FAIL",
    safetyStatus: uniqueInformationLost === true ? "FAIL" : uniqueInformationLost === false ? "PASS" : "NOT RUN",
    deduplicationEffective: structurallyComplete && uniqueInformationLost === false && removed.length > 0,
    contentQualityStatus: "NOT RUN"
  };
}

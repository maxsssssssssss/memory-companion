"use client";

import { useEffect, useState } from "react";

import { DateCompanionApiError } from "@/lib/client/date-companion-api";
import type { SourceRefVM } from "@/lib/domain/date-companion";
import {
  DateCompanionProactiveValueResponseSchema,
  type DateCompanionHomeContent,
  type DateCompanionProactiveValueResponse
} from "@/lib/domain/date-companion-proactive-value";

export type DateCompanionProactiveValueTarget =
  | {
      scope: "current_interaction";
      accountId: string;
      relationshipId: string;
      interactionId: string;
      mappingVersion: number;
      sourceRevision: string;
    }
  | {
      scope: "person_relationship";
      accountId: string;
      relationshipId: string;
      personId: string;
      mappingVersion: number;
      sourceRevision: string;
    };

type UnavailableReason = "access" | "sources" | "processing" | "generation" | "qualification";

function unavailableReason(code?: string): UnavailableReason | undefined {
  if (code === "source_changed" || code === "source_unavailable") return "sources";
  if (code === "needs_review") return "qualification";
  if (code === "invalid_provider_result" || code === "provider_error" || code === "fallback_invalid") return "generation";
}

export type DateCompanionProactiveValueLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; response: DateCompanionProactiveValueResponse; refresh?: "reading" | "failed" }
  | { status: "unavailable"; reason?: UnavailableReason };

export type DateCompanionProactiveValuePresentation = {
  fingerprint: string;
  status: "ready" | "fallback";
  observation: string;
  caution: string;
  suggestedQuestions: string[];
  sources: SourceRefVM[];
};

export type DateCompanionHomeContentPresentation = {
  fingerprint: string;
  about: Array<DateCompanionHomeContent["home"]["about"][number] & { sources: SourceRefVM[] }>;
  beforeMeeting: Array<DateCompanionHomeContent["home"]["beforeMeeting"][number] & { sources: SourceRefVM[] }>;
};

export type DateCompanionHomeContentState =
  | { status: "ready"; content: DateCompanionHomeContentPresentation; refresh?: "reading" | "failed" }
  | { status: "empty"; note?: string }
  | { status: "loading" }
  | { status: "unavailable"; reason?: UnavailableReason };

export type DateCompanionProactiveValueClient = {
  getCurrentInteraction(
    interactionId: string,
    signal?: AbortSignal
  ): Promise<DateCompanionProactiveValueResponse>;
  getPersonRelationship(
    relationshipId: string,
    signal?: AbortSignal
  ): Promise<DateCompanionProactiveValueResponse>;
};

// Lives in the signed-in product layout, for a single confirmed relationship.
export type HomeMaterialRead = {
  current: { key: string; response: DateCompanionProactiveValueResponse } | null;
};

export const DATE_COMPANION_PROACTIVE_POLL_INTERVAL_MS = 1_500;
export const DATE_COMPANION_PROACTIVE_MAX_POLL_ATTEMPTS = 48;

function responseErrorCode(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "proactive_value_request_failed";
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error.trim() : "proactive_value_request_failed";
}

async function parseResponse(response: Response): Promise<DateCompanionProactiveValueResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new DateCompanionApiError({
      status: response.status,
      code: "invalid_response",
      message: "Server response did not match the expected contract",
      cause
    });
  }
  if (!response.ok) {
    throw new DateCompanionApiError({ status: response.status, code: responseErrorCode(payload) });
  }
  const parsed = DateCompanionProactiveValueResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new DateCompanionApiError({
      status: response.status,
      code: "invalid_response",
      message: "Server response did not match the expected contract",
      cause: parsed.error
    });
  }
  return parsed.data;
}

function validId(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new DateCompanionApiError({ status: 400, code });
  }
  return normalized;
}

export function createDateCompanionProactiveValueClient(
  fetcher: typeof fetch = fetch
): DateCompanionProactiveValueClient {
  const get = async (path: string, signal?: AbortSignal) => parseResponse(await fetcher(path, {
    method: "GET",
    credentials: "same-origin",
    signal
  }));
  return {
    getCurrentInteraction(interactionId, signal) {
      const id = validId(interactionId, "invalid_interaction_id");
      return get(`/api/date-companion/interactions/${encodeURIComponent(id)}/proactive-value`, signal);
    },
    getPersonRelationship(relationshipId, signal) {
      const id = validId(relationshipId, "invalid_relationship_id");
      return get(`/api/date-companion/relationships/${encodeURIComponent(id)}/proactive-value`, signal);
    }
  };
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function shanghaiDate() {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function targetKey(target: DateCompanionProactiveValueTarget, currentShanghaiDate: string) {
  return target.scope === "current_interaction"
    ? [
        target.accountId,
        target.scope,
        target.relationshipId,
        target.interactionId,
        target.mappingVersion,
        target.sourceRevision
      ].join("\u0000")
    : [
        target.accountId,
        target.scope,
        target.relationshipId,
        target.personId,
        target.mappingVersion,
        target.sourceRevision,
        currentShanghaiDate
      ].join("\u0000");
}

function responseMatchesTarget(
  response: DateCompanionProactiveValueResponse,
  target: DateCompanionProactiveValueTarget
) {
  if (response.scope !== target.scope || response.relationshipId !== target.relationshipId) return false;
  if (target.scope === "current_interaction") {
    if (response.interactionId !== target.interactionId || response.personId !== undefined) return false;
  } else if ((response.personId !== target.personId && !(response.status === "unavailable" && response.personId === undefined))
    || response.interactionId !== undefined) {
    return false;
  }
  if (response.status === "processing") {
    return response.mappingVersion === target.mappingVersion
      && response.value === undefined
      && response.sourceFingerprint === undefined
      && response.evidenceReferences.length === 0;
  }
  if (response.status === "unavailable") return response.evidenceReferences.length === 0;
  if (response.mappingVersion !== target.mappingVersion || !response.value || !response.sourceFingerprint) return false;
  const referenceIds = response.evidenceReferences.map((reference) => reference.evidenceId);
  if (new Set(referenceIds).size !== referenceIds.length) return false;
  return response.value.evidenceIds.every((evidenceId) => referenceIds.includes(evidenceId));
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function waitForNextPoll(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, DATE_COMPANION_PROACTIVE_POLL_INTERVAL_MS);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function useDateCompanionProactiveValue(
  target: DateCompanionProactiveValueTarget | null,
  client?: DateCompanionProactiveValueClient,
  requestRevision = 0,
  lastHomeRead?: HomeMaterialRead | null
): DateCompanionProactiveValueLoadState {
  const [defaultClient] = useState(() => createDateCompanionProactiveValueClient());
  const activeClient = client ?? defaultClient;
  const [currentShanghaiDate, setCurrentShanghaiDate] = useState(shanghaiDate);
  const relationshipScope = target?.scope === "person_relationship";
  const key = target ? targetKey(target, currentShanghaiDate) : null;
  const [result, setResult] = useState<{
    key: string | null;
    state: DateCompanionProactiveValueLoadState;
  }>({ key: null, state: { status: "idle" } });

  useEffect(() => {
    if (!relationshipScope) return;
    let timer: number;
    const refreshDate = () => {
      setCurrentShanghaiDate(shanghaiDate());
      window.clearTimeout(timer);
      const now = Date.now();
      const nextMidnight = (Math.floor((now + SHANGHAI_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - SHANGHAI_OFFSET_MS;
      timer = window.setTimeout(refreshDate, nextMidnight - now + 1);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshDate();
    };
    refreshDate();
    window.addEventListener("focus", refreshDate);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refreshDate);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [relationshipScope]);

  useEffect(() => {
    if (!target || !key) {
      if (lastHomeRead) lastHomeRead.current = null;
      setResult({ key: null, state: { status: "idle" } });
      return;
    }
    const controller = new AbortController();
    const matching = lastHomeRead?.current?.key === key ? lastHomeRead.current.response : null;
    if (lastHomeRead && !matching) lastHomeRead.current = null;
    setResult({ key, state: matching ? { status: "ready", response: matching, refresh: "reading" } : { status: "loading" } });
    function unavailable(reason?: UnavailableReason) {
      if (lastHomeRead) lastHomeRead.current = null;
      setResult({ key, state: { status: "unavailable", reason } });
    }
    const request = () => target.scope === "current_interaction"
      ? activeClient.getCurrentInteraction(target.interactionId, controller.signal)
      : activeClient.getPersonRelationship(target.relationshipId, controller.signal);
    const load = async () => {
      for (let attempt = 0; attempt <= DATE_COMPANION_PROACTIVE_MAX_POLL_ATTEMPTS; attempt += 1) {
        const response = await request();
        if (controller.signal.aborted) return;
        if (!responseMatchesTarget(response, target)) {
          unavailable("sources");
          return;
        }
        if (response.status === "processing") {
          // The server has explicitly withheld Evidence while processing.
          if (lastHomeRead?.current) {
            lastHomeRead.current = null;
            setResult({ key, state: { status: "loading" } });
          }
          if (attempt === DATE_COMPANION_PROACTIVE_MAX_POLL_ATTEMPTS) {
            unavailable("processing");
            return;
          }
          await waitForNextPoll(controller.signal);
          continue;
        }
        if (response.status === "unavailable") {
          unavailable(unavailableReason(response.failureCode));
          return;
        }
        if (lastHomeRead) lastHomeRead.current = response.status === "ready" && response.value && "home" in response.value
          ? { key, response } : null;
        setResult({ key, state: { status: "ready", response } });
        return;
      }
    };
    void load().catch((error: unknown) => {
      if (!controller.signal.aborted && !isAbortError(error)) {
        const temporaryFailure = error instanceof TypeError || error instanceof DateCompanionApiError && error.status >= 500;
        if (temporaryFailure && lastHomeRead?.current?.key === key) {
          setResult({ key, state: { status: "ready", response: lastHomeRead.current.response, refresh: "failed" } });
        } else {
          unavailable(error instanceof DateCompanionApiError && [401,403,404].includes(error.status) ? "access" : undefined);
        }
      }
    });
    return () => controller.abort();
  }, [activeClient, key, requestRevision, lastHomeRead]); // key includes identity, mapping version, source revision and day.

  if (!key) return { status: "idle" };
  if (result.key === key) return result.state;
  return lastHomeRead?.current?.key === key
    ? { status: "ready", response: lastHomeRead.current.response, refresh: "reading" }
    : { status: "loading" };
}

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

export function dateCompanionProactiveSourceRevision(
  sources: readonly SourceRefVM[],
  contextRevision?: number | string
) {
  const signatures = new Set<string>();
  for (const source of sources) {
    for (const segmentId of source.segmentIds) {
      signatures.add(JSON.stringify([
        source.uploadId,
        segmentId,
        source.recordingDate,
        source.startSeconds,
        source.endSeconds,
        source.speakerId ?? null,
        normalizedText(source.quote),
        source.contentDigest ?? null,
        source.memorySubject ?? null,
        source.sourceOrigin ?? null,
        source.timeKnown ?? true
      ]));
    }
  }
  return JSON.stringify({
    contextRevision: contextRevision ?? null,
    sources: [...signatures].sort()
  });
}

function sourceKey(uploadId: string, sourceSegmentId: string) {
  return `${uploadId}\u0000${sourceSegmentId}`;
}

function sourceMatchesReference(
  source: SourceRefVM,
  reference: DateCompanionProactiveValueResponse["evidenceReferences"][number]
) {
  if (
    source.uploadId !== reference.uploadId
    || !source.segmentIds.includes(reference.sourceSegmentId)
    || source.recordingDate !== reference.recordingDate
    || normalizedText(source.quote) !== normalizedText(reference.quote)
    || source.contentDigest !== reference.contentDigest
  ) return false;
  if (
    reference.startSeconds !== undefined
    && (source.timeKnown === false || source.startSeconds !== reference.startSeconds || source.endSeconds !== reference.endSeconds)
  ) return false;
  return (!source.sourceOrigin || source.sourceOrigin === reference.origin)
    && (reference.speakerId === undefined || source.speakerId === reference.speakerId);
}

function canonicalSourceResolver(
  response: DateCompanionProactiveValueResponse,
  availableSources: SourceRefVM[],
  requireSubjectMatch = false
) {
  const references = new Map(response.evidenceReferences.map((reference) => [reference.evidenceId, reference]));
  const sourcesByKey = new Map<string, SourceRefVM[]>();
  for (const source of availableSources) {
    for (const segmentId of source.segmentIds) {
      const key = sourceKey(source.uploadId, segmentId);
      sourcesByKey.set(key, [...(sourcesByKey.get(key) ?? []), source]);
    }
  }
  return (evidenceIds: string[]): SourceRefVM[] | null => {
    if (references.size !== response.evidenceReferences.length) return null;
    const selectedReferences = evidenceIds.map((evidenceId) => references.get(evidenceId));
    if (selectedReferences.some((reference) => !reference)) return null;
    const resolved: SourceRefVM[] = [];
    const seen = new Set<string>();
    for (const reference of selectedReferences) {
      const canonicalReference = reference!;
      const key = sourceKey(canonicalReference.uploadId, canonicalReference.sourceSegmentId);
      const canonicalCandidates = sourcesByKey.get(key) ?? [];
      const declaredOrigins = new Set(canonicalCandidates.flatMap(source => source.sourceOrigin ? [source.sourceOrigin] : []));
      if (declaredOrigins.size > 1) return null;
      const canonicalSignatures = new Set(canonicalCandidates.map((source) => JSON.stringify([
        source.recordingDate,
        source.startSeconds,
        source.endSeconds,
        source.speakerId ?? null,
        normalizedText(source.quote),
        source.contentDigest ?? null,
        ...(requireSubjectMatch ? [source.memorySubject ?? null] : [])
      ])));
      if (canonicalSignatures.size !== 1) return null;
      const candidates = canonicalCandidates.filter((source) =>
        sourceMatchesReference(source, canonicalReference)
        && (!requireSubjectMatch || source.memorySubject === canonicalReference.subject)
      );
      if (candidates.length === 0) return null;
      if (seen.has(key)) continue;
      candidates.sort((left, right) =>
        Number(Boolean(right.canOpenTranscript)) - Number(Boolean(left.canOpenTranscript))
        || left.id.localeCompare(right.id)
      );
      resolved.push(requireSubjectMatch
        ? { ...candidates[0], sourceOrigin: canonicalReference.origin, segmentIds: [canonicalReference.sourceSegmentId] }
        : candidates[0]);
      seen.add(key);
    }
    return resolved.length > 0 ? resolved : null;
  };
}

export function presentDateCompanionProactiveValue(
  response: DateCompanionProactiveValueResponse,
  availableSources: SourceRefVM[]
): DateCompanionProactiveValuePresentation | null {
  if (
    response.status === "processing"
    || response.status === "unavailable"
    || !response.value
    || "home" in response.value
    || !response.sourceFingerprint
  ) return null;
  const resolved = canonicalSourceResolver(response, availableSources)(response.value.evidenceIds);
  if (!resolved) return null;
  return {
    fingerprint: response.sourceFingerprint,
    status: response.status,
    observation: response.value.observation,
    caution: response.value.caution,
    suggestedQuestions: response.value.suggestedQuestions,
    sources: resolved
  };
}

export function presentDateCompanionHomeContent(
  response: DateCompanionProactiveValueResponse,
  canonicalSources: SourceRefVM[]
): DateCompanionHomeContentPresentation | null {
  const parsed = DateCompanionProactiveValueResponseSchema.safeParse(response);
  if (!parsed.success) return null;
  const current = parsed.data;
  if (current.status !== "ready" || current.scope !== "person_relationship"
    || !current.value || !("home" in current.value) || !current.sourceFingerprint) return null;
  const resolve = canonicalSourceResolver(current, canonicalSources, true);
  const about: DateCompanionHomeContentPresentation["about"] = [];
  const beforeMeeting: DateCompanionHomeContentPresentation["beforeMeeting"] = [];
  for (const item of current.value.home.about) {
    const sources = resolve(item.evidenceIds);
    if (!sources || (item.kind === "shared_moment"
      ? !sources.some((source) => source.memorySubject === "both")
      : sources.some((source) => source.memorySubject !== "companion" && source.memorySubject !== "both"))) return null;
    about.push({ ...item, sources });
  }
  for (const item of current.value.home.beforeMeeting) {
    const sources = resolve(item.evidenceIds);
    if (!sources) return null;
    beforeMeeting.push({ ...item, sources });
  }
  return { fingerprint: current.sourceFingerprint, about, beforeMeeting };
}

export function proactiveSuggestedQuestions(
  presentation: DateCompanionProactiveValuePresentation | null
) {
  return presentation?.suggestedQuestions.slice(0, 2) ?? [];
}

function aboutQuestionTopic(
  item: DateCompanionHomeContentPresentation["about"][number],
  beforeMeeting: DateCompanionHomeContent["home"]["beforeMeeting"]
) {
  // Leave qualified statements intact rather than turning a condition or a
  // negation into an apparent topic that the speaker already agreed upon.
  if (/不|没|未|无|或|可能|也许|好像|如果|除非|暂|只|待定|据说|听说|但|尚|取消|避免/u.test(item.text)) return;
  const matching = beforeMeeting.find(entry => entry.kind === "follow_up"
    && entry.evidenceIds.length === item.evidenceIds.length
    && entry.evidenceIds.every(id => item.evidenceIds.includes(id)));
  const namedTopic = matching && /^聊聊([^，。！？；：]{2,24}?)(?:的进展|的进度)?[。！]?$/u.exec(matching.text)?.[1];
  const sharedTopic = item.kind === "shared_moment"
    && /^(?:我们|你们)一起(?:完成了|做了|聊到了|提到了)([^，。！？；：]{2,24})[，。！]/u.exec(item.text)?.[1];
  // The follow-up and the shared-moment template only nominate a phrase.
  // Both the original item and its own admitted sources must contain it.
  const comparable = (text: string) => text.replace(/\s+/gu, "").replace(/色的/gu, "色");
  for (const topic of [namedTopic, sharedTopic]) {
    if (topic && comparable(item.text).includes(comparable(topic))
      && item.sources.some(source => comparable(source.quote).includes(comparable(topic)))) return topic;
  }
}

export function homeAboutSuggestedQuestions(
  response: DateCompanionProactiveValueResponse,
  personQaSources: SourceRefVM[],
  style: "quoted" | "concise" = "quoted"
) {
  const parsed = DateCompanionProactiveValueResponseSchema.safeParse(response);
  if (!parsed.success || !parsed.data.value || !("home" in parsed.data.value)) return [];
  const about = parsed.data.value.home.about;
  // Recheck only the selected about items against Person QA's own allowlist.
  // Self promises may support the home page but never authorize a QA suggestion.
  const presentation = presentDateCompanionHomeContent({
    ...parsed.data,
    value: {
      home: { about, beforeMeeting: [] },
      evidenceIds: [...new Set(about.flatMap((item) => item.evidenceIds))]
    }
  }, personQaSources);
  const beforeMeeting = parsed.data.value.home.beforeMeeting;
  return presentation?.about.slice(0, 2).map(item => {
    const topic = style === "concise" && aboutQuestionTopic(item, beforeMeeting);
    return topic ? `关于${topic}，当时怎么说？` : `关于「${item.text}」，当时具体说了什么？`;
  }) ?? [];
}

"use client";

import { useEffect, useState } from "react";

import { DateCompanionApiError } from "@/lib/client/date-companion-api";
import type { SourceRefVM } from "@/lib/domain/date-companion";
import {
  DateCompanionProactiveValueResponseSchema,
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

export type DateCompanionProactiveValueLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; response: DateCompanionProactiveValueResponse }
  | { status: "unavailable" };

export type DateCompanionProactiveValuePresentation = {
  fingerprint: string;
  status: "ready" | "fallback";
  observation: string;
  caution: string;
  suggestedQuestions: string[];
  sources: SourceRefVM[];
};

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

function targetKey(target: DateCompanionProactiveValueTarget) {
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
        target.sourceRevision
      ].join("\u0000");
}

function responseMatchesTarget(
  response: DateCompanionProactiveValueResponse,
  target: DateCompanionProactiveValueTarget
) {
  if (response.scope !== target.scope || response.relationshipId !== target.relationshipId) return false;
  if (target.scope === "current_interaction") {
    if (response.interactionId !== target.interactionId || response.personId !== undefined) return false;
  } else if (response.personId !== target.personId || response.interactionId !== undefined) {
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
  client?: DateCompanionProactiveValueClient
): DateCompanionProactiveValueLoadState {
  const [defaultClient] = useState(() => createDateCompanionProactiveValueClient());
  const activeClient = client ?? defaultClient;
  const key = target ? targetKey(target) : null;
  const [result, setResult] = useState<{
    key: string | null;
    state: DateCompanionProactiveValueLoadState;
  }>({ key: null, state: { status: "idle" } });

  useEffect(() => {
    if (!target || !key) {
      setResult({ key: null, state: { status: "idle" } });
      return;
    }
    const controller = new AbortController();
    setResult({ key, state: { status: "loading" } });
    const request = () => target.scope === "current_interaction"
      ? activeClient.getCurrentInteraction(target.interactionId, controller.signal)
      : activeClient.getPersonRelationship(target.relationshipId, controller.signal);
    const load = async () => {
      for (let attempt = 0; attempt <= DATE_COMPANION_PROACTIVE_MAX_POLL_ATTEMPTS; attempt += 1) {
        const response = await request();
        if (controller.signal.aborted) return;
        if (!responseMatchesTarget(response, target)) {
          setResult({ key, state: { status: "unavailable" } });
          return;
        }
        if (response.status === "processing") {
          if (attempt === DATE_COMPANION_PROACTIVE_MAX_POLL_ATTEMPTS) {
            setResult({ key, state: { status: "unavailable" } });
            return;
          }
          await waitForNextPoll(controller.signal);
          continue;
        }
        if (response.status === "unavailable") {
          setResult({ key, state: { status: "unavailable" } });
          return;
        }
        setResult({ key, state: { status: "ready", response } });
        return;
      }
    };
    void load().catch((error: unknown) => {
      if (!controller.signal.aborted && !isAbortError(error)) {
        setResult({ key, state: { status: "unavailable" } });
      }
    });
    return () => controller.abort();
  }, [activeClient, key]); // target identity is fully represented by key.

  if (!key) return { status: "idle" };
  return result.key === key ? result.state : { status: "loading" };
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
        source.memorySubject ?? null
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
    && (source.startSeconds !== reference.startSeconds || source.endSeconds !== reference.endSeconds)
  ) return false;
  return reference.speakerId === undefined || source.speakerId === reference.speakerId;
}

export function presentDateCompanionProactiveValue(
  response: DateCompanionProactiveValueResponse,
  availableSources: SourceRefVM[]
): DateCompanionProactiveValuePresentation | null {
  if (
    response.status === "processing"
    || response.status === "unavailable"
    || !response.value
    || !response.sourceFingerprint
  ) return null;
  const references = new Map(response.evidenceReferences.map((reference) => [reference.evidenceId, reference]));
  const selectedReferences = response.value.evidenceIds.map((evidenceId) => references.get(evidenceId));
  if (selectedReferences.some((reference) => !reference)) return null;

  const sourcesByKey = new Map<string, SourceRefVM[]>();
  for (const source of availableSources) {
    for (const segmentId of source.segmentIds) {
      const key = sourceKey(source.uploadId, segmentId);
      sourcesByKey.set(key, [...(sourcesByKey.get(key) ?? []), source]);
    }
  }
  const resolved: SourceRefVM[] = [];
  const seen = new Set<string>();
  for (const reference of selectedReferences) {
    const canonicalReference = reference!;
    const key = sourceKey(canonicalReference.uploadId, canonicalReference.sourceSegmentId);
    if (seen.has(key)) continue;
    const canonicalCandidates = sourcesByKey.get(key) ?? [];
    const canonicalSignatures = new Set(canonicalCandidates.map((source) => JSON.stringify([
      source.recordingDate,
      source.startSeconds,
      source.endSeconds,
      source.speakerId ?? null,
      normalizedText(source.quote),
      source.contentDigest ?? null
    ])));
    if (canonicalSignatures.size !== 1) return null;
    const candidates = canonicalCandidates.filter((source) =>
      sourceMatchesReference(source, canonicalReference)
    );
    if (candidates.length === 0) return null;
    candidates.sort((left, right) =>
      Number(Boolean(right.canOpenTranscript)) - Number(Boolean(left.canOpenTranscript))
      || left.id.localeCompare(right.id)
    );
    resolved.push(candidates[0]);
    seen.add(key);
  }
  if (resolved.length === 0) return null;
  return {
    fingerprint: response.sourceFingerprint,
    status: response.status,
    observation: response.value.observation,
    caution: response.value.caution,
    suggestedQuestions: response.value.suggestedQuestions,
    sources: resolved
  };
}

export function proactiveSuggestedQuestions(
  presentation: DateCompanionProactiveValuePresentation | null
) {
  return presentation?.suggestedQuestions.slice(0, 2) ?? [];
}

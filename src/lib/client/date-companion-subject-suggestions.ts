import { z } from "zod";

import {
  DcIdSchema,
  DcSubjectSuggestionConfirmationSchema,
  DcSubjectSuggestionResponseSchema,
  DcSubjectSuggestionStatusResponseSchema,
  type DcMemorySubject,
  type DcSubjectSuggestionBatch,
  type DcSubjectSuggestionConfirmation,
  type DcSubjectSuggestionStatusResponse
} from "@/lib/domain/date-companion-stage2";

const ErrorSchema = z.object({ error: z.string().min(1).optional() }).passthrough();
const SUBJECT_SUGGESTION_STATUS_POLL_INTERVAL_MS = 2_000;
const SUBJECT_SUGGESTION_STATUS_MAX_POLLS = 180;

export class DateCompanionSubjectSuggestionClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
    this.name = "DateCompanionSubjectSuggestionClientError";
  }
}

async function parsedJson(response: Response) {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new DateCompanionSubjectSuggestionClientError(response.status, "invalid_subject_suggestion_response");
  }
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(value);
    throw new DateCompanionSubjectSuggestionClientError(
      response.status,
      parsed.success ? parsed.data.error ?? "subject_suggestion_request_failed" : "subject_suggestion_request_failed"
    );
  }
  return value;
}

export async function requestDateCompanionSubjectSuggestions(
  interactionId: string,
  signal?: AbortSignal
): Promise<DcSubjectSuggestionBatch> {
  const id = DcIdSchema.parse(interactionId);
  const response = await fetch(
    `/api/date-companion/interactions/${encodeURIComponent(id)}/subject-suggestions`,
    { method: "POST", signal }
  );
  return DcSubjectSuggestionResponseSchema.parse(await parsedJson(response)).batch;
}

export async function getDateCompanionSubjectSuggestionStatus(
  interactionId: string,
  signal?: AbortSignal
): Promise<DcSubjectSuggestionStatusResponse> {
  const id = DcIdSchema.parse(interactionId);
  const response = await fetch(
    `/api/date-companion/interactions/${encodeURIComponent(id)}/subject-suggestions`,
    { method: "GET", signal }
  );
  return DcSubjectSuggestionStatusResponseSchema.parse(await parsedJson(response));
}

function waitForSubjectSuggestionPoll(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function assertSubjectSuggestionFence(input: {
  response: DcSubjectSuggestionStatusResponse;
  interactionId: string;
  interactionVersion: number;
  mappingVersion: number;
  evidenceDigest?: string;
}) {
  if (
    input.response.interactionId !== input.interactionId
    || input.response.interactionVersion !== input.interactionVersion
    || input.response.mappingVersion !== input.mappingVersion
    || (input.evidenceDigest !== undefined && input.response.evidenceDigest !== input.evidenceDigest)
  ) {
    throw new DateCompanionSubjectSuggestionClientError(409, "subject_suggestion_status_stale");
  }
}

function assertBatchFence(input: {
  batch: DcSubjectSuggestionBatch;
  interactionId: string;
  interactionVersion: number;
  mappingVersion: number;
  evidenceDigest: string;
}) {
  if (
    input.batch.interactionId !== input.interactionId
    || input.batch.interactionVersion !== input.interactionVersion
    || input.batch.mappingVersion !== input.mappingVersion
    || input.batch.evidenceDigest !== input.evidenceDigest
  ) {
    throw new DateCompanionSubjectSuggestionClientError(409, "subject_suggestion_status_stale");
  }
}

type SubjectSuggestionGenerationOutcome =
  | { kind: "ready"; batch: DcSubjectSuggestionBatch }
  | { kind: "error"; error: unknown };

function canRetrySubjectSuggestionStatusRead(error: unknown) {
  if (!(error instanceof DateCompanionSubjectSuggestionClientError)) return true;
  return error.status === 408
    || error.status === 429
    || error.status >= 500;
}

function canRecoverSubjectSuggestionGenerationWithStatusRead(error: unknown) {
  return error instanceof DateCompanionSubjectSuggestionClientError && error.status === 409
    ? true
    : canRetrySubjectSuggestionStatusRead(error);
}

export async function loadDateCompanionSubjectSuggestions(input: {
  interactionId: string;
  interactionVersion: number;
  mappingVersion: number;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxPolls?: number;
}): Promise<DcSubjectSuggestionBatch> {
  const pollIntervalMs = input.pollIntervalMs ?? SUBJECT_SUGGESTION_STATUS_POLL_INTERVAL_MS;
  const maxPolls = input.maxPolls ?? SUBJECT_SUGGESTION_STATUS_MAX_POLLS;
  const initialReadAttempts = Math.max(1, Math.min(maxPolls, 3));
  let initial: DcSubjectSuggestionStatusResponse | null = null;
  for (let attempt = 0; attempt < initialReadAttempts; attempt += 1) {
    try {
      initial = await getDateCompanionSubjectSuggestionStatus(input.interactionId, input.signal);
      break;
    } catch (error) {
      if (
        input.signal?.aborted
        || !canRetrySubjectSuggestionStatusRead(error)
        || attempt + 1 >= initialReadAttempts
      ) throw error;
      await waitForSubjectSuggestionPoll(pollIntervalMs, input.signal);
    }
  }
  if (!initial) {
    throw new DateCompanionSubjectSuggestionClientError(408, "subject_suggestion_status_timeout");
  }
  assertSubjectSuggestionFence({ response: initial, ...input });
  if (initial.status === "ready") {
    assertBatchFence({ batch: initial.batch, evidenceDigest: initial.evidenceDigest, ...input });
    return initial.batch;
  }

  const evidenceDigest = initial.evidenceDigest;
  let generation: Promise<SubjectSuggestionGenerationOutcome> | null = initial.status === "idle"
    ? requestDateCompanionSubjectSuggestions(input.interactionId, input.signal).then(
        (batch) => ({ kind: "ready" as const, batch }),
        (error: unknown) => ({ kind: "error" as const, error })
      )
    : null;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    let generationOutcome: SubjectSuggestionGenerationOutcome | null = null;
    if (generation) {
      generationOutcome = await Promise.race([
        generation,
        waitForSubjectSuggestionPoll(pollIntervalMs, input.signal).then(() => null)
      ]);
      if (generationOutcome) generation = null;
    } else {
      await waitForSubjectSuggestionPoll(pollIntervalMs, input.signal);
    }

    if (generationOutcome?.kind === "ready") {
      assertBatchFence({ batch: generationOutcome.batch, evidenceDigest, ...input });
      return generationOutcome.batch;
    }
    if (
      generationOutcome?.kind === "error"
      && !canRecoverSubjectSuggestionGenerationWithStatusRead(generationOutcome.error)
    ) {
      throw generationOutcome.error;
    }

    let status: DcSubjectSuggestionStatusResponse;
    try {
      status = await getDateCompanionSubjectSuggestionStatus(input.interactionId, input.signal);
    } catch (error) {
      if (input.signal?.aborted || !canRetrySubjectSuggestionStatusRead(error)) throw error;
      continue;
    }
    assertSubjectSuggestionFence({ response: status, evidenceDigest, ...input });
    if (status.status === "ready") {
      assertBatchFence({ batch: status.batch, evidenceDigest, ...input });
      return status.batch;
    }
    if (status.status === "idle" && !generation) {
      throw new DateCompanionSubjectSuggestionClientError(409, "subject_suggestion_not_ready");
    }
  }
  throw new DateCompanionSubjectSuggestionClientError(408, "subject_suggestion_status_timeout");
}

export async function confirmDateCompanionSubjectSuggestions(input: {
  interactionId: string;
  mappingVersion: number;
  confirmation: DcSubjectSuggestionConfirmation;
  selections: Array<{ evidenceSnapshotId: string; subject: DcMemorySubject }>;
  signal?: AbortSignal;
}) {
  const interactionId = DcIdSchema.parse(input.interactionId);
  const confirmation = DcSubjectSuggestionConfirmationSchema.parse(input.confirmation);
  const response = await fetch(
    `/api/date-companion/interactions/${encodeURIComponent(interactionId)}/memory-sync`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mappingVersion: input.mappingVersion,
        subjectSuggestionConfirmation: confirmation,
        selections: input.selections
      }),
      signal: input.signal
    }
  );
  await parsedJson(response);
}

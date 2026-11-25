"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { PERSON_MATERIAL_READ_TIMEOUT_MS, readPersonMaterialWithDeadline } from "./date-companion-read-deadline";

const RecordIdSchema = z.string().trim().min(1).max(512).regex(/^[^\s]+$/u);
const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const MemoryTypeSchema = z.enum([
  "event",
  "commitment",
  "question",
  "relationship_signal",
  "preference",
  "summary"
]);
const MemoryStatusSchema = z.enum(["active", "resolved", "expired", "superseded"]);

const ConfirmedPersonSchema = z.object({
  id: RecordIdSchema,
  displayName: z.string().trim().min(1).max(500).nullable(),
  status: z.literal("confirmed"),
  explicitlyConfirmed: z.literal(true),
  confirmedAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).passthrough();

const PersonEvidenceSchema = z.object({
  id: RecordIdSchema,
  uploadId: RecordIdSchema,
  sourceSegmentId: RecordIdSchema,
  quote: z.string().trim().min(1).max(4_000),
  createdAt: z.string().datetime()
}).passthrough();

const PersonTimelineResponseSchema = z.object({
  person: ConfirmedPersonSchema,
  timeline: z.array(z.object({
    date: DateKeySchema,
    memory: z.object({
      id: RecordIdSchema,
      type: MemoryTypeSchema,
      title: z.string().trim().min(1).max(500),
      summary: z.string().trim().min(1).max(4_000),
      status: MemoryStatusSchema,
      date: DateKeySchema,
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime()
    }).passthrough(),
    evidenceLinks: z.array(z.object({
      memoryEvidence: z.object({
        id: RecordIdSchema.optional(),
        date: DateKeySchema
      }).passthrough(),
      personEvidence: PersonEvidenceSchema
    }).passthrough()),
    sourceAttribution: z.object({
      origin: z.enum(["user_reflection", "direct_conversation", "unknown"]),
      statement: z.string().trim().min(1).max(1_000),
      date: DateKeySchema
    }).passthrough(),
    subjectPersonIds: z.array(RecordIdSchema).min(1),
    shared: z.boolean()
  }).passthrough())
}).strict();

export type DateCompanionPersonArchiveSource = {
  id: string;
  memoryEvidenceIds?: string[];
  uploadId: string;
  sourceSegmentId: string;
  quote: string;
  date: string;
};

export type DateCompanionPersonArchiveEntry = {
  id: string;
  type: z.infer<typeof MemoryTypeSchema>;
  status: z.infer<typeof MemoryStatusSchema>;
  title: string;
  summary: string;
  date: string;
  updatedAt: string;
  sourceStatement: string;
  sourceOrigin: "user_reflection" | "direct_conversation" | "unknown";
  shared: boolean;
  sources: DateCompanionPersonArchiveSource[];
};

export type DateCompanionPersonArchive = {
  person: {
    id: string;
    displayName: string | null;
    confirmedAt: string;
    updatedAt: string;
  };
  entries: DateCompanionPersonArchiveEntry[];
};

export type DateCompanionPersonArchiveState =
  | { status: "idle" | "loading" }
  | { status: "ready"; archive: DateCompanionPersonArchive; refresh?: "loading" | "error"; message?: string }
  | { status: "not_found" }
  | { status: "error"; message: string };

function uniqueSources(
  links: z.infer<typeof PersonTimelineResponseSchema>["timeline"][number]["evidenceLinks"]
) {
  const sources = new Map<string, DateCompanionPersonArchiveSource>();
  for (const link of links) {
    const source = link.personEvidence;
    const key = `${source.uploadId}\u0000${source.sourceSegmentId}`;
    sources.set(key, {
      id: source.id,
      ...(link.memoryEvidence.id ? { memoryEvidenceIds: [...new Set([...(sources.get(key)?.memoryEvidenceIds ?? []), link.memoryEvidence.id])].sort() } : {}),
      uploadId: source.uploadId,
      sourceSegmentId: source.sourceSegmentId,
      quote: source.quote,
      date: link.memoryEvidence.date
    });
  }
  return [...sources.values()];
}

export async function readDateCompanionPersonArchive(
  personId: string,
  options: Readonly<{ signal?: AbortSignal; fetchImpl?: typeof fetch }> = {}
): Promise<DateCompanionPersonArchive> {
  const id = RecordIdSchema.parse(personId);
  const response = await (options.fetchImpl ?? fetch)(
    `/api/people/${encodeURIComponent(id)}/timeline?limit=50`,
    { method: "GET", cache: "no-store", signal: options.signal }
  );
  if (response.status === 404) throw new Error("person_not_found");
  if (!response.ok) throw new Error(response.status === 401 ? "unauthenticated" : response.status === 403 ? "person_archive_forbidden" : "person_archive_unavailable");
  const parsed = PersonTimelineResponseSchema.safeParse(await response.json());
  if (
    !parsed.success
    || parsed.data.person.id !== id
    || parsed.data.timeline.some((entry) => !entry.subjectPersonIds.includes(id))
  ) throw new Error("invalid_person_archive");
  return {
    person: {
      id: parsed.data.person.id,
      displayName: parsed.data.person.displayName,
      confirmedAt: parsed.data.person.confirmedAt,
      updatedAt: parsed.data.person.updatedAt
    },
    entries: parsed.data.timeline.map((entry) => ({
      id: entry.memory.id,
      type: entry.memory.type,
      status: entry.memory.status,
      title: entry.memory.title,
      summary: entry.memory.summary,
      date: entry.date,
      updatedAt: entry.memory.updatedAt,
      sourceStatement: entry.sourceAttribution.statement,
      sourceOrigin: entry.sourceAttribution.origin,
      shared: entry.shared,
      sources: uniqueSources(entry.evidenceLinks)
    }))
  };
}

export function useDateCompanionPersonArchive(personId: string | null, scope = "", revision = 0, timeoutMs = PERSON_MATERIAL_READ_TIMEOUT_MS): DateCompanionPersonArchiveState {
  const requestKey = personId ? JSON.stringify([scope, personId]) : null;
  const [requestState, setRequestState] = useState<{
    key: string | null;
    value: DateCompanionPersonArchiveState;
  }>({ key: null, value: { status: "idle" } });
  useEffect(() => {
    if (!personId) {
      setRequestState({ key: null, value: { status: "idle" } });
      return;
    }
    const controller = new AbortController();
    setRequestState(current => current.key === requestKey && current.value.status === "ready"
      ? { key: requestKey, value: { ...current.value, refresh: "loading", message: undefined } } :
      { key: requestKey, value: { status: "loading" } });
    void readPersonMaterialWithDeadline(signal => readDateCompanionPersonArchive(personId, { signal }), controller.signal, timeoutMs)
      .then((archive) => {
        if (controller.signal.aborted) return;
        setRequestState((current) => current.key === requestKey
          ? { key: requestKey, value: { status: "ready", archive } }
          : current);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const unavailable = error instanceof Error && ["person_not_found", "unauthenticated", "person_archive_forbidden", "invalid_person_archive"].includes(error.message);
        const message = error && typeof error === "object" && "name" in error && error.name === "TimeoutError"
          ? "人物档案读取超时。" : "人物内容暂时没有读取成功，请稍后再试。";
        setRequestState((current) => current.key === requestKey
          ? {
              key: requestKey,
              value: !unavailable && current.value.status === "ready"
                ? { ...current.value, refresh: "error", message }
                : error instanceof Error && error.message === "person_not_found"
                ? { status: "not_found" }
                : { status: "error", message }
            }
          : current);
      });
    return () => controller.abort();
  }, [personId, requestKey, revision, timeoutMs]);
  if (requestState.key !== requestKey) return personId ? { status: "loading" } : { status: "idle" };
  return requestState.value;
}

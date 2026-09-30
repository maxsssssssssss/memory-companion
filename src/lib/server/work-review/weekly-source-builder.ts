import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import {
  WorkWeeklySourceSnapshotSchema,
  WorkWeeklyTodoStateSchema,
  type WorkWeeklyScope,
  type WorkWeeklyScopeRequest,
  type WorkWeeklySourceIdentity,
  type WorkWeeklySourceSnapshot
} from "@/lib/domain/work-weekly";
import type { WorkProjectReference } from "@/lib/domain/work-project";

export const WORK_WEEKLY_SOURCE_POLICY_VERSION = "work_weekly_source_v1" as const;

export type WorkWeeklySourceCapacity = {
  maxSemanticUnits: number;
  maxUtf8Bytes: number;
  maxEvidenceSegments: number;
};

export const DEFAULT_WORK_WEEKLY_SOURCE_CAPACITY: WorkWeeklySourceCapacity = {
  maxSemanticUnits: 400,
  maxUtf8Bytes: 256 * 1024,
  maxEvidenceSegments: 512
};

export class WorkWeeklySourceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkWeeklySourceError";
  }
}

type BuilderInput = {
  database: Database.Database;
  accountId: string;
  scope: WorkWeeklyScopeRequest;
  now?: Date;
  capacity?: Partial<WorkWeeklySourceCapacity>;
};

type MeetingRow = {
  id: string;
  title: string;
  meeting_date: string;
  review_status: "not_started" | "in_progress" | "completed";
  version: number;
  canonical_publication_id: string;
  canonical_content_digest: string;
  pending_candidate_count: number;
};

type FindingRow = {
  id: string;
  meeting_id: string;
  source_candidate_id: string;
  kind: "discussion_topic" | "proposal" | "decision" | "commitment"
    | "open_question" | "plan_change" | "action_item";
  title: string;
  body: string;
  structured_data_json: string;
  user_confirmed_at: string;
  user_edited_at: string | null;
  version: number;
};

type FindingEvidenceRow = {
  finding_id: string;
  meeting_id: string;
  publication_id: string;
  position: number;
  segment_id: string;
  start_seconds: number;
  end_seconds: number;
  raw_speaker_label: string | null;
  timestamp_quality: "provider_exact" | "provider_estimated" | "synthetic" | "unknown";
};

type TodoRow = {
  id: string;
  kind: "self" | "waiting_for_other";
  status: "open" | "completed";
  title: string;
  owner_label: string | null;
  current_due_date: string | null;
  source_meeting_id: string | null;
  source_finding_id: string | null;
  source_finding_kind: "action_item" | "commitment" | null;
  version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
};

type TodoEventRow = {
  event_id: string;
  todo_id: string;
  event_type: "todo.created_manual" | "todo.created_from_finding" | "todo.updated"
    | "todo.completed" | "todo.reopened" | "todo.added_to_my_day"
    | "todo.removed_from_my_day" | "todo.deleted" | "todo.detached_from_source";
  payload_json: string;
  created_at: string;
};

type PublicationRow = {
  publication_id: string;
  meeting_id: string;
  content_digest: string;
  payload_json: string;
};

type EventPayload = {
  schemaVersion?: number;
  changedFields?: unknown;
  oldVersion?: unknown;
  newVersion?: unknown;
  occurredAt?: unknown;
  stateAfter?: unknown;
};

type Unit = {
  sourceRef: string;
  priority: number;
  localDate: string;
  utf8Bytes: number;
  evidenceRefs: string[];
  refs: string[];
  findingId?: string;
  todoId?: string;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function sha256(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function sourceRef(accountId: string, sourceKind: string, identity: unknown) {
  return `wrs_${sha256({ accountId, sourceKind, identity })}`;
}

function utf8Bytes(value: unknown) {
  return Buffer.byteLength(stableStringify(value), "utf8");
}

function dateParts(dateKey: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dateKey);
  if (!match) throw new WorkWeeklySourceError("work_weekly_invalid_week_start");
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function addCalendarDays(dateKey: string, days: number) {
  const { year, month, day } = dateParts(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function localParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"), month: value("month"), day: value("day"),
    hour: value("hour"), minute: value("minute"), second: value("second")
  };
}

function localDateKey(instant: Date, timeZone: string) {
  const value = localParts(instant, timeZone);
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function zonedStartOfDay(dateKey: string, timeZone: string) {
  const target = dateParts(dateKey);
  const targetUtc = Date.UTC(target.year, target.month - 1, target.day);
  let candidate = targetUtc;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = localParts(new Date(candidate), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second
    );
    const next = candidate + (targetUtc - actualAsUtc);
    if (next === candidate) break;
    candidate = next;
  }
  return new Date(candidate);
}

export function deriveWorkWeeklyScope(
  input: WorkWeeklyScopeRequest,
  now = new Date()
): { scope: WorkWeeklyScope; startInstant: string; observedEndExclusive: string; endExclusive: string } {
  const { year, month, day } = dateParts(input.weekStart);
  const canonical = new Date(Date.UTC(year, month - 1, day));
  if (canonical.toISOString().slice(0, 10) !== input.weekStart || canonical.getUTCDay() !== 1) {
    throw new WorkWeeklySourceError("work_weekly_week_start_must_be_monday");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(now);
  } catch {
    throw new WorkWeeklySourceError("work_weekly_invalid_time_zone");
  }
  if ((input.scopeKind === "project") !== (input.projectId !== null)) {
    throw new WorkWeeklySourceError("work_weekly_invalid_scope");
  }
  const weekEnd = addCalendarDays(input.weekStart, 6);
  const endExclusiveDate = addCalendarDays(input.weekStart, 7);
  const start = zonedStartOfDay(input.weekStart, input.timeZone);
  const end = zonedStartOfDay(endExclusiveDate, input.timeZone);
  if (now.getTime() < start.getTime()) {
    throw new WorkWeeklySourceError("work_weekly_future_week_not_allowed");
  }
  const observedEnd = new Date(Math.min(now.getTime(), end.getTime()));
  const windowComplete = now.getTime() >= end.getTime();
  return {
    scope: {
      ...input,
      weekEnd,
      observedThrough: windowComplete ? weekEnd : localDateKey(now, input.timeZone),
      windowComplete
    },
    startInstant: start.toISOString(),
    observedEndExclusive: observedEnd.toISOString(),
    endExclusive: end.toISOString()
  };
}

function capacity(input?: Partial<WorkWeeklySourceCapacity>): WorkWeeklySourceCapacity {
  const resolved = { ...DEFAULT_WORK_WEEKLY_SOURCE_CAPACITY, ...input };
  if (!Number.isSafeInteger(resolved.maxSemanticUnits) || resolved.maxSemanticUnits < 0
    || !Number.isSafeInteger(resolved.maxUtf8Bytes) || resolved.maxUtf8Bytes < 0
    || !Number.isSafeInteger(resolved.maxEvidenceSegments) || resolved.maxEvidenceSegments < 0) {
    throw new WorkWeeklySourceError("work_weekly_invalid_capacity");
  }
  return resolved;
}

function projectReferences(
  database: Database.Database,
  accountId: string,
  resource: "meeting" | "todo",
  resourceId: string
): WorkProjectReference[] {
  const relation = resource === "meeting" ? "wr_meeting_projects" : "wr_todo_projects";
  const column = resource === "meeting" ? "meeting_id" : "todo_id";
  return (database.prepare(`
    SELECT p.id, p.name, p.status, p.version
    FROM ${relation} link
    JOIN wr_projects p ON p.id = link.project_id AND p.account_id = link.account_id
    WHERE link.account_id = ? AND link.${column} = ? AND p.deleted_at IS NULL
    ORDER BY p.id
  `).all(accountId, resourceId) as Array<{
    id: string; name: string; status: "active" | "archived"; version: number;
  }>).map((row) => ({ id: row.id, name: row.name, status: row.status, version: row.version }));
}

function scopeSql(scopeKind: WorkWeeklyScopeRequest["scopeKind"], resource: "meeting" | "todo") {
  if (scopeKind === "all") return { sql: "", parameters: [] as unknown[] };
  const table = resource === "meeting" ? "wr_meeting_projects" : "wr_todo_projects";
  const column = resource === "meeting" ? "meeting_id" : "todo_id";
  const alias = resource === "meeting" ? "m" : "t";
  if (scopeKind === "project") {
    return {
      sql: `AND EXISTS (SELECT 1 FROM ${table} link WHERE link.account_id = ${alias}.account_id AND link.${column} = ${alias}.id AND link.project_id = ?)`,
      parameters: [] as unknown[]
    };
  }
  return {
    sql: `AND NOT EXISTS (SELECT 1 FROM ${table} link WHERE link.account_id = ${alias}.account_id AND link.${column} = ${alias}.id)`,
    parameters: [] as unknown[]
  };
}

function todoState(row: TodoRow, overrides: Partial<{
  status: TodoRow["status"];
  completedAt: string | null;
  version: number;
}> = {}) {
  return WorkWeeklyTodoStateSchema.parse({
    title: row.title,
    kind: row.kind,
    status: overrides.status ?? row.status,
    ownerLabel: row.owner_label,
    currentDueDate: row.current_due_date,
    completedAt: overrides.completedAt === undefined ? row.completed_at : overrides.completedAt,
    deletedAt: row.deleted_at,
    version: overrides.version ?? row.version
  });
}

function parseEventPayload(row: TodoEventRow): EventPayload {
  try {
    const value = JSON.parse(row.payload_json) as unknown;
    return value && typeof value === "object" ? value as EventPayload : {};
  } catch {
    return {};
  }
}

function changedFields(payload: EventPayload) {
  return Array.isArray(payload.changedFields)
    ? payload.changedFields.filter((value): value is string => typeof value === "string")
    : [];
}

function eventVersion(payload: EventPayload) {
  return Number.isInteger(payload.newVersion) && Number(payload.newVersion) >= 0
    ? Number(payload.newVersion) : null;
}

function stateAtObservedEnd(
  todo: TodoRow,
  events: TodoEventRow[],
  observedEndExclusive: string,
  windowComplete: boolean
) {
  const before = events.filter((event) => event.created_at < observedEndExclusive);
  const after = events.filter((event) => event.created_at >= observedEndExclusive);
  let status: TodoRow["status"] = "open";
  let completedAt: string | null = null;
  let version = 0;
  let hasLegacy = false;
  let latestExact: ReturnType<typeof WorkWeeklyTodoStateSchema.parse> | null = null;
  for (const event of before) {
    const payload = parseEventPayload(event);
    version = eventVersion(payload) ?? version;
    const parsedState = WorkWeeklyTodoStateSchema.safeParse(payload.stateAfter);
    if (payload.schemaVersion === 2 && parsedState.success) latestExact = parsedState.data;
    else {
      hasLegacy = true;
      latestExact = null;
    }
    if (event.event_type === "todo.completed") {
      status = "completed";
      completedAt = event.created_at;
    } else if (event.event_type === "todo.reopened") {
      status = "open";
      completedAt = null;
    }
  }
  if (!windowComplete) {
    return { state: null, historyCompleteness: hasLegacy ? "legacy_limited" as const : "exact" as const };
  }
  if (latestExact) {
    return { state: latestExact, historyCompleteness: hasLegacy ? "legacy_limited" as const : "exact" as const };
  }
  const unsafeFields = new Set(["title", "kind", "ownerLabel", "currentDueDate"]);
  const cannotReverse = after.some((event) => {
    const payload = parseEventPayload(event);
    return changedFields(payload).some((field) => unsafeFields.has(field));
  });
  return {
    state: cannotReverse ? null : todoState(todo, { status, completedAt, version }),
    historyCompleteness: hasLegacy || cannotReverse ? "legacy_limited" as const : "exact" as const
  };
}

function findingPriority(kind: FindingRow["kind"]) {
  if (kind === "decision" || kind === "plan_change") return 0;
  if (kind === "open_question") return 4;
  if (kind === "action_item" || kind === "commitment") return 5;
  return 6;
}

function readSnapshot(input: BuilderInput): WorkWeeklySourceSnapshot {
  const accountId = input.accountId.trim();
  if (!accountId) throw new WorkWeeklySourceError("work_weekly_invalid_account");
  const now = input.now ?? new Date();
  const window = deriveWorkWeeklyScope(input.scope, now);
  const limits = capacity(input.capacity);
  if (window.scope.scopeKind === "project") {
    const project = input.database.prepare(`
      SELECT 1 FROM wr_projects WHERE id = ? AND account_id = ? AND deleted_at IS NULL
    `).get(window.scope.projectId, accountId);
    if (!project) throw new WorkWeeklySourceError("work_weekly_project_not_found");
  }

  const meetingScope = scopeSql(window.scope.scopeKind, "meeting");
  const meetingParameters = [accountId, window.scope.weekStart, window.scope.observedThrough];
  if (window.scope.scopeKind === "project") meetingParameters.push(window.scope.projectId!);
  const rawMeetings = input.database.prepare(`
    SELECT m.id, m.title, m.meeting_date, m.review_status, m.version,
      m.canonical_publication_id, m.canonical_content_digest,
      SUM(CASE WHEN c.status = 'pending_review' THEN 1 ELSE 0 END) AS pending_candidate_count
    FROM wr_meetings m
    LEFT JOIN wr_meeting_candidates c
      ON c.account_id = m.account_id AND c.meeting_id = m.id
    WHERE m.account_id = ? AND m.deleted_at IS NULL AND m.ingestion_status <> 'deleted'
      AND m.meeting_date >= ? AND m.meeting_date <= ?
      AND m.canonical_publication_id IS NOT NULL
      AND m.canonical_content_digest IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM wr_canonical_publications revoked
        WHERE revoked.account_id = m.account_id AND revoked.meeting_id = m.id
          AND revoked.publication_id = m.canonical_publication_id
          AND revoked.tombstoned_at IS NOT NULL
      )
      ${meetingScope.sql}
    GROUP BY m.id
    ORDER BY m.meeting_date, m.id
  `).all(...meetingParameters) as MeetingRow[];

  const meetingProjects = new Map(rawMeetings.map((meeting) => [
    meeting.id,
    projectReferences(input.database, accountId, "meeting", meeting.id)
  ]));
  const findingRows: FindingRow[] = [];
  const findingEvidenceRows: FindingEvidenceRow[] = [];
  for (const meeting of rawMeetings) {
    findingRows.push(...input.database.prepare(`
      SELECT id, meeting_id, source_candidate_id, kind, title, body,
        structured_data_json, user_confirmed_at, user_edited_at, version
      FROM wr_findings
      WHERE account_id = ? AND meeting_id = ? AND user_confirmed_at IS NOT NULL
      ORDER BY id
    `).all(accountId, meeting.id) as FindingRow[]);
    findingEvidenceRows.push(...input.database.prepare(`
      SELECT finding_id, meeting_id, publication_id, position, segment_id,
        start_seconds, end_seconds, raw_speaker_label, timestamp_quality
      FROM wr_finding_evidence
      WHERE account_id = ? AND meeting_id = ?
      ORDER BY finding_id, position
    `).all(accountId, meeting.id) as FindingEvidenceRow[]);
  }
  const findingIds = new Set(findingRows.map((finding) => finding.id));
  const relevantEvidenceRows = findingEvidenceRows.filter((row) => findingIds.has(row.finding_id));
  const meetings = rawMeetings.filter((meeting) =>
    meeting.pending_candidate_count > 0 || findingRows.some((finding) => finding.meeting_id === meeting.id));
  const meetingById = new Map(meetings.map((meeting) => [meeting.id, meeting]));

  const publications = new Map<string, PublicationRow>();
  for (const meeting of meetings) {
    const publication = input.database.prepare(`
      SELECT publication_id, meeting_id, content_digest, payload_json
      FROM wr_canonical_publications
      WHERE publication_id = ? AND account_id = ? AND meeting_id = ?
        AND content_digest = ? AND tombstoned_at IS NULL
    `).get(
      meeting.canonical_publication_id,
      accountId,
      meeting.id,
      meeting.canonical_content_digest
    ) as PublicationRow | undefined;
    if (!publication) throw new WorkWeeklySourceError("work_weekly_canonical_publication_missing");
    publications.set(publication.publication_id, publication);
  }

  const evidenceByRef = new Map<string, WorkWeeklySourceSnapshot["evidence"][number]>();
  const evidenceRefByIdentity = new Map<string, string>();
  for (const row of relevantEvidenceRows) {
    const publication = publications.get(row.publication_id);
    if (!publication || publication.meeting_id !== row.meeting_id) {
      throw new WorkWeeklySourceError("work_weekly_evidence_publication_mismatch");
    }
    let segments: unknown;
    try { segments = JSON.parse(publication.payload_json); } catch {
      throw new WorkWeeklySourceError("work_weekly_canonical_payload_invalid");
    }
    if (!Array.isArray(segments)) throw new WorkWeeklySourceError("work_weekly_canonical_payload_invalid");
    const segment = segments.find((value) => value && typeof value === "object"
      && (value as { id?: unknown }).id === row.segment_id) as Record<string, unknown> | undefined;
    if (!segment || typeof segment.text !== "string" || !segment.text.trim()) {
      throw new WorkWeeklySourceError("work_weekly_evidence_segment_missing");
    }
    const identityKey = `${row.publication_id}\u0000${row.segment_id}`;
    const ref = sourceRef(accountId, "evidence", {
      publicationId: row.publication_id, segmentId: row.segment_id
    });
    evidenceRefByIdentity.set(identityKey, ref);
    if (!evidenceByRef.has(ref)) {
      evidenceByRef.set(ref, {
        sourceRef: ref,
        publicationId: row.publication_id,
        publicationDigest: publication.content_digest,
        meetingId: row.meeting_id,
        segmentId: row.segment_id,
        startSeconds: row.start_seconds,
        endSeconds: row.end_seconds,
        rawSpeakerLabel: row.raw_speaker_label,
        timestampQuality: row.timestamp_quality,
        text: segment.text.trim()
      });
    }
  }

  const findingSources = findingRows.map((finding) => {
    if (!meetingById.has(finding.meeting_id)) {
      throw new WorkWeeklySourceError("work_weekly_finding_meeting_missing");
    }
    const rows = relevantEvidenceRows.filter((row) => row.finding_id === finding.id);
    if (rows.length === 0) throw new WorkWeeklySourceError("work_weekly_finding_evidence_missing");
    const evidenceRefs = rows.map((row) => evidenceRefByIdentity.get(
      `${row.publication_id}\u0000${row.segment_id}`
    )).filter((value): value is string => Boolean(value));
    if (evidenceRefs.length !== rows.length) {
      throw new WorkWeeklySourceError("work_weekly_finding_evidence_missing");
    }
    let structuredData: unknown;
    try { structuredData = JSON.parse(finding.structured_data_json); } catch {
      throw new WorkWeeklySourceError("work_weekly_finding_payload_invalid");
    }
    return {
      sourceRef: sourceRef(accountId, "finding", finding.id),
      id: finding.id,
      meetingId: finding.meeting_id,
      version: finding.version,
      kind: finding.kind,
      title: finding.title,
      body: finding.body,
      structuredData,
      userConfirmedAt: finding.user_confirmed_at,
      userEditedAt: finding.user_edited_at,
      evidenceRefs: [...new Set(evidenceRefs)].sort()
    };
  });

  const todoScope = scopeSql(window.scope.scopeKind, "todo");
  const todoParameters: unknown[] = [accountId, window.observedEndExclusive];
  if (window.scope.scopeKind === "project") todoParameters.push(window.scope.projectId);
  const todoRows = input.database.prepare(`
    SELECT id, kind, status, title, owner_label, current_due_date,
      source_meeting_id, source_finding_id, source_finding_kind,
      version, created_at, updated_at, completed_at, deleted_at
    FROM wr_todos t
    WHERE t.account_id = ? AND t.deleted_at IS NULL AND t.created_at < ?
      ${todoScope.sql}
    ORDER BY t.id
  `).all(...todoParameters) as TodoRow[];
  const todoProjects = new Map(todoRows.map((todo) => [
    todo.id,
    projectReferences(input.database, accountId, "todo", todo.id)
  ]));
  const todoEventRows = new Map<string, TodoEventRow[]>();
  for (const todo of todoRows) {
    todoEventRows.set(todo.id, input.database.prepare(`
      SELECT event_id, todo_id, event_type, payload_json, created_at
      FROM wr_todo_events
      WHERE account_id = ? AND todo_id = ?
      ORDER BY CAST(json_extract(payload_json, '$.newVersion') AS INTEGER), created_at, event_id
    `).all(accountId, todo.id) as TodoEventRow[]);
  }

  const todoSources: WorkWeeklySourceSnapshot["todos"] = [];
  const todoEventSources: WorkWeeklySourceSnapshot["todoEvents"] = [];
  for (const todo of todoRows) {
    const events = todoEventRows.get(todo.id) ?? [];
    const inWindow = events.filter((event) =>
      event.created_at >= window.startInstant && event.created_at < window.observedEndExclusive);
    const reconstructed = stateAtObservedEnd(
      todo,
      events,
      window.observedEndExclusive,
      window.scope.windowComplete
    );
    const effectiveStatus = reconstructed.state?.status ?? todo.status;
    const hasNarrativeEvent = inWindow.some((event) => {
      const fields = changedFields(parseEventPayload(event));
      return ["todo.created_manual", "todo.created_from_finding", "todo.completed", "todo.reopened"]
        .includes(event.event_type) || fields.includes("currentDueDate");
    });
    if (!hasNarrativeEvent && effectiveStatus !== "open") continue;
    const historyCompleteness = reconstructed.historyCompleteness;
    todoSources.push({
      sourceRef: sourceRef(accountId, "todo", todo.id),
      id: todo.id,
      version: todo.version,
      current: todoState(todo),
      stateAtWeekEnd: reconstructed.state,
      historyCompleteness,
      sourceMeetingId: todo.source_meeting_id,
      sourceFindingId: todo.source_finding_id,
      sourceFindingKind: todo.source_finding_kind,
      projects: todoProjects.get(todo.id) ?? []
    });
    for (const event of inWindow) {
      const payload = parseEventPayload(event);
      const parsedState = WorkWeeklyTodoStateSchema.safeParse(payload.stateAfter);
      const exact = payload.schemaVersion === 2 && parsedState.success;
      todoEventSources.push({
        sourceRef: sourceRef(accountId, "todo_event", event.event_id),
        id: event.event_id,
        todoId: todo.id,
        eventType: event.event_type,
        changedFields: changedFields(payload),
        occurredAt: event.created_at,
        localDate: localDateKey(new Date(event.created_at), window.scope.timeZone),
        oldVersion: Number.isInteger(payload.oldVersion) ? Number(payload.oldVersion) : null,
        newVersion: eventVersion(payload) ?? todo.version,
        stateAfter: exact ? parsedState.data : null,
        historyCompleteness: exact ? "exact" : "legacy_limited"
      });
    }
  }

  const meetingSources: WorkWeeklySourceSnapshot["meetings"] = meetings.map((meeting) => ({
    sourceRef: sourceRef(accountId, "meeting", meeting.id),
    id: meeting.id,
    version: meeting.version,
    title: meeting.title,
    meetingDate: meeting.meeting_date,
    reviewStatus: meeting.review_status,
    pendingCandidateCount: meeting.pending_candidate_count,
    canonicalPublicationId: meeting.canonical_publication_id,
    canonicalContentDigest: meeting.canonical_content_digest,
    projects: meetingProjects.get(meeting.id) ?? []
  }));

  const projectMap = new Map<string, WorkProjectReference>();
  for (const refs of [...meetingProjects.values(), ...todoProjects.values()]) {
    for (const project of refs) projectMap.set(project.id, project);
  }
  const projects = [...projectMap.values()].sort((left, right) => left.id.localeCompare(right.id));

  const identities: WorkWeeklySourceIdentity[] = [];
  for (const meeting of meetingSources) identities.push({
    sourceRef: meeting.sourceRef, sourceKind: "meeting", sourceId: meeting.id,
    version: meeting.version, digest: meeting.canonicalContentDigest,
    publicationId: meeting.canonicalPublicationId, segmentId: null, included: false
  });
  for (const finding of findingSources) identities.push({
    sourceRef: finding.sourceRef, sourceKind: "finding", sourceId: finding.id,
    version: finding.version, digest: sha256({
      title: finding.title, body: finding.body, structuredData: finding.structuredData,
      evidenceRefs: finding.evidenceRefs
    }), publicationId: null, segmentId: null, included: false
  });
  for (const todo of todoSources) identities.push({
    sourceRef: todo.sourceRef, sourceKind: "todo", sourceId: todo.id,
    version: todo.version, digest: sha256({ current: todo.current, projects: todo.projects }),
    publicationId: null, segmentId: null, included: false
  });
  for (const event of todoEventSources) identities.push({
    sourceRef: event.sourceRef, sourceKind: "todo_event", sourceId: event.id,
    version: event.newVersion, digest: sha256(event), publicationId: null, segmentId: null,
    included: false
  });
  for (const project of projects) identities.push({
    sourceRef: sourceRef(accountId, "project", project.id), sourceKind: "project",
    sourceId: project.id, version: project.version, digest: sha256(project),
    publicationId: null, segmentId: null, included: false
  });
  for (const evidence of evidenceByRef.values()) identities.push({
    sourceRef: evidence.sourceRef, sourceKind: "evidence", sourceId: evidence.segmentId,
    version: null, digest: evidence.publicationDigest, publicationId: evidence.publicationId,
    segmentId: evidence.segmentId, included: false
  });
  identities.sort((left, right) => left.sourceKind.localeCompare(right.sourceKind)
    || left.sourceId.localeCompare(right.sourceId) || left.sourceRef.localeCompare(right.sourceRef));

  const eventByTodo = new Map<string, typeof todoEventSources>();
  for (const event of todoEventSources) {
    const list = eventByTodo.get(event.todoId) ?? [];
    list.push(event);
    eventByTodo.set(event.todoId, list);
  }
  const units: Unit[] = [];
  for (const finding of findingSources) {
    const meeting = meetingById.get(finding.meetingId)!;
    const meetingRef = sourceRef(accountId, "meeting", meeting.id);
    const projectRefs = (meetingProjects.get(meeting.id) ?? []).map((project) =>
      sourceRef(accountId, "project", project.id));
    const evidence = finding.evidenceRefs.map((ref) => evidenceByRef.get(ref));
    units.push({
      sourceRef: finding.sourceRef,
      priority: findingPriority(finding.kind),
      localDate: meeting.meeting_date,
      utf8Bytes: utf8Bytes({ finding, evidence }),
      evidenceRefs: finding.evidenceRefs,
      refs: [finding.sourceRef, meetingRef, ...projectRefs, ...finding.evidenceRefs],
      findingId: finding.id
    });
  }
  for (const todo of todoSources) {
    const events = eventByTodo.get(todo.id) ?? [];
    const completed = events.some((event) => event.eventType === "todo.completed");
    const effective = todo.stateAtWeekEnd ?? todo.current;
    const priority = completed ? 1 : effective.kind === "self" && effective.status === "open"
      ? 2 : effective.kind === "waiting_for_other" && effective.status === "open" ? 3 : 7;
    const projectRefs = todo.projects.map((project) => sourceRef(accountId, "project", project.id));
    units.push({
      sourceRef: todo.sourceRef,
      priority,
      localDate: events[0]?.localDate ?? window.scope.weekStart,
      utf8Bytes: utf8Bytes({ todo, events }),
      evidenceRefs: [],
      refs: [todo.sourceRef, ...events.map((event) => event.sourceRef), ...projectRefs],
      todoId: todo.id
    });
  }
  units.sort((left, right) => left.priority - right.priority
    || left.localDate.localeCompare(right.localDate)
    || left.sourceRef.localeCompare(right.sourceRef));
  const includedRefs = new Set<string>();
  let usedUnits = 0;
  let usedBytes = 0;
  let usedEvidence = 0;
  for (const unit of units) {
    const newEvidence = unit.evidenceRefs.filter((ref) => !includedRefs.has(ref)).length;
    if (usedUnits + 1 > limits.maxSemanticUnits
      || usedBytes + unit.utf8Bytes > limits.maxUtf8Bytes
      || usedEvidence + newEvidence > limits.maxEvidenceSegments) continue;
    usedUnits += 1;
    usedBytes += unit.utf8Bytes;
    usedEvidence += newEvidence;
    for (const ref of unit.refs) includedRefs.add(ref);
  }
  for (const identity of identities) identity.included = includedRefs.has(identity.sourceRef);

  const includedFindings = findingSources.filter((finding) => includedRefs.has(finding.sourceRef));
  const includedTodos = todoSources.filter((todo) => includedRefs.has(todo.sourceRef));
  const includedEvents = todoEventSources.filter((event) => includedRefs.has(event.sourceRef));
  const includedEvidence = [...evidenceByRef.values()].filter((evidence) =>
    includedRefs.has(evidence.sourceRef)).sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
  const includedMeetingIds = new Set(includedFindings.map((finding) => finding.meetingId));
  const includedProjectIds = new Set<string>();
  for (const meeting of meetingSources) {
    if (!includedMeetingIds.has(meeting.id)) continue;
    for (const project of meeting.projects) includedProjectIds.add(project.id);
  }
  for (const todo of includedTodos) for (const project of todo.projects) includedProjectIds.add(project.id);
  const includedMeetings = meetingSources.filter((meeting) => includedMeetingIds.has(meeting.id));
  const includedProjects = projects.filter((project) => includedProjectIds.has(project.id));
  const legacyLimited = todoSources.some((todo) => todo.historyCompleteness === "legacy_limited")
    || todoEventSources.some((event) => event.historyCompleteness === "legacy_limited");
  const summary = {
    meetingCount: meetings.length,
    findingCount: findingSources.length,
    todoCount: todoSources.length,
    todoEventCount: todoEventSources.length,
    evidenceCount: evidenceByRef.size,
    projectCount: projects.length,
    pendingCandidateCount: meetings.reduce((sum, meeting) => sum + meeting.pending_candidate_count, 0),
    includedFindingCount: includedFindings.length,
    includedTodoCount: includedTodos.length,
    includedTodoEventCount: includedEvents.length,
    includedEvidenceCount: includedEvidence.length,
    omittedFindingCount: findingSources.length - includedFindings.length,
    omittedTodoCount: todoSources.length - includedTodos.length,
    omittedTodoEventCount: todoEventSources.length - includedEvents.length,
    omittedEvidenceCount: evidenceByRef.size - includedEvidence.length,
    truncated: usedUnits < units.length,
    historyCompleteness: legacyLimited ? "legacy_limited" as const : "exact" as const
  };
  const digestIdentities = identities.map(({ included: _included, ...identity }) => identity);
  const digest = sha256({
    policyVersion: WORK_WEEKLY_SOURCE_POLICY_VERSION,
    accountId,
    scope: {
      weekStart: window.scope.weekStart,
      weekEnd: window.scope.weekEnd,
      timeZone: window.scope.timeZone,
      scopeKind: window.scope.scopeKind,
      projectId: window.scope.projectId,
      windowComplete: window.scope.windowComplete
    },
    identities: digestIdentities
  });
  const allowlistedSourceRefs = [...includedRefs].sort();
  const inputPackDigest = sha256({
    policyVersion: WORK_WEEKLY_SOURCE_POLICY_VERSION,
    accountId,
    scope: {
      weekStart: window.scope.weekStart,
      weekEnd: window.scope.weekEnd,
      timeZone: window.scope.timeZone,
      scopeKind: window.scope.scopeKind,
      projectId: window.scope.projectId,
      windowComplete: window.scope.windowComplete
    },
    capacity: limits,
    sourceRefs: allowlistedSourceRefs,
    identities: digestIdentities.filter((identity) => includedRefs.has(identity.sourceRef))
  });
  return WorkWeeklySourceSnapshotSchema.parse({
    contractVersion: 1,
    accountId,
    scope: window.scope,
    digest,
    inputPackDigest,
    createdAt: now.toISOString(),
    summary,
    identities,
    meetings: includedMeetings,
    findings: includedFindings,
    todos: includedTodos,
    todoEvents: includedEvents,
    projects: includedProjects,
    evidence: includedEvidence,
    allowlistedSourceRefs
  });
}

export function buildWorkWeeklySourceSnapshot(input: BuilderInput) {
  const read = input.database.transaction(() =>
    buildWorkWeeklySourceSnapshotWithinTransaction(input));
  return read.deferred();
}

/** Caller must already own a read or write transaction when atomicity matters. */
export function buildWorkWeeklySourceSnapshotWithinTransaction(input: BuilderInput) {
  return readSnapshot(input);
}

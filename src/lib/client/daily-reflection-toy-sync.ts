import { isSupportedAudioUpload } from "@/lib/audio/compat";

export const TOY_SYNC_DESTINATIONS = [
  "daily_reflection",
  "date_companion"
] as const;

export type ToySyncDestination = typeof TOY_SYNC_DESTINATIONS[number];

/** Existing callers and legacy v1 rows belong to Daily Reflection. */
export const DEFAULT_TOY_SYNC_DESTINATION: ToySyncDestination = "daily_reflection";

export function isToySyncDestination(value: unknown): value is ToySyncDestination {
  return typeof value === "string"
    && (TOY_SYNC_DESTINATIONS as readonly string[]).includes(value);
}

export type ToySyncEntryStatus =
  | "new"
  | "uploading"
  | "uploaded"
  | "failed"
  | "ignored";

export type ToySyncReceiptStatus =
  | "reserving"
  | "accepted"
  | "processing"
  | "completed"
  | "failed"
  | "deleted";

export type ToySyncTimestampSource =
  | "manifest"
  | "file_created_time"
  | "file_last_modified";

export type ToySyncFileHandle = Readonly<{
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}>;

export type ToySyncDirectoryHandle = Readonly<{
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[
    string,
    ToySyncFileHandle | ToySyncDirectoryHandle
  ]>;
}>;

export type ToySyncScannedRecording = Readonly<{
  file: File;
  filename: string;
  fileSize: number;
  lastModified: number;
  duplicateKey: string;
  suggestedTimestampMs: number;
  timestampSource: ToySyncTimestampSource;
  /**
   * Only device-authored manifest metadata is treated as reliable. Browser file
   * timestamps are best-effort hints and can change when a file is copied or moved.
   */
  timestampReliable: boolean;
}>;

export type ToySyncManifestStatus = "absent" | "valid" | "invalid";

export type ToySyncScanResult = Readonly<{
  recordings: readonly ToySyncScannedRecording[];
  manifestStatus: ToySyncManifestStatus;
  usedRecordingsSubdirectory: boolean;
  unreadableFileCount: number;
}>;

export type ToySyncStateRecord = Readonly<{
  duplicateKey: string;
  filename: string;
  fileSize: number;
  lastModified: number;
  recordingDate?: string;
  sha256?: string;
  /** Stable before the first request and reused for every retry of this recording. */
  operationKey?: string;
  /** Date Companion scope. Legacy and Daily Reflection records omit it. */
  relationshipId?: string;
  /** Legacy persisted input only; stripped by parseToySyncState. */
  generation?: number;
  receiptId?: string;
  uploadId?: string;
  jobId?: string;
  serverAcceptedAt?: string;
  receiptStatus?: ToySyncReceiptStatus;
  /** Legacy persisted input only; stripped by parseToySyncState. */
  sourceCleanedAt?: string;
  /** Legacy persisted input only; stripped by parseToySyncState. */
  reimportOfReceiptId?: string;
  status: ToySyncEntryStatus;
  updatedAt: string;
  errorMessage?: string;
}>;

export type ToySyncState = Readonly<{
  version: 1;
  records: readonly ToySyncStateRecord[];
}>;

export interface ToySyncStateStore {
  load(destination?: ToySyncDestination): Promise<ToySyncState | null>;
  save(state: ToySyncState, destination?: ToySyncDestination): Promise<void>;
}

type ToySyncManifestRecording = Readonly<{
  filename: string;
  createdAtMs: number;
}>;

type DirectoryEntry = readonly [
  string,
  ToySyncFileHandle | ToySyncDirectoryHandle
];

const STATE_VERSION = 1;
const DUPLICATE_KEY_VERSION = "toy-sync:v1";
const MANIFEST_FILENAME = "manifest.json";
const RECORDINGS_DIRECTORY_NAME = "recordings";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const VALID_STATUSES = new Set<ToySyncEntryStatus>([
  "new",
  "uploading",
  "uploaded",
  "failed",
  "ignored"
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const RECEIPT_STATUSES = new Set<ToySyncReceiptStatus>([
  "reserving",
  "accepted",
  "processing",
  "completed",
  "failed",
  "deleted"
]);

function normalizeFilename(filename: string): string {
  return filename.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function normalizeFiniteInteger(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function createToySyncDuplicateKey(input: {
  filename: string;
  fileSize: number;
  lastModified: number;
}): string {
  const normalizedFilename = encodeURIComponent(normalizeFilename(input.filename));
  const fileSize = normalizeFiniteInteger(input.fileSize);
  const lastModified = normalizeFiniteInteger(input.lastModified);
  return `${DUPLICATE_KEY_VERSION}:${normalizedFilename}:${fileSize}:${lastModified}`;
}

function toTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && value.trim()) {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
  }
  return null;
}

function readFileCreatedTime(file: File): number | null {
  return toTimestampMs((file as File & { createdTime?: unknown }).createdTime);
}

function isNamed(name: string, expected: string): boolean {
  return normalizeFilename(name) === expected;
}

async function readDirectoryEntries(
  directory: ToySyncDirectoryHandle
): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = [];
  for await (const entry of directory.entries()) entries.push(entry);
  return entries;
}

export function parseToySyncManifest(value: string): readonly ToySyncManifestRecording[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const recordings = (parsed as { recordings?: unknown }).recordings;
  if (!Array.isArray(recordings)) return null;

  const result: ToySyncManifestRecording[] = [];
  const seen = new Set<string>();
  for (const entry of recordings) {
    if (!entry || typeof entry !== "object") continue;
    const filename = (entry as { filename?: unknown }).filename;
    const createdAt = (entry as { created_at?: unknown }).created_at;
    if (typeof filename !== "string" || !filename.trim()) continue;
    const createdAtMs = toTimestampMs(createdAt);
    if (createdAtMs === null) continue;
    const normalizedFilename = normalizeFilename(filename);
    if (seen.has(normalizedFilename)) continue;
    seen.add(normalizedFilename);
    result.push({ filename: filename.trim(), createdAtMs });
  }
  return result;
}

async function readManifest(
  candidates: readonly DirectoryEntry[][]
): Promise<{
  status: ToySyncManifestStatus;
  recordings: readonly ToySyncManifestRecording[];
}> {
  let foundManifest = false;
  for (const entries of candidates) {
    const manifestEntry = entries.find(
      ([name, handle]) => handle.kind === "file" && isNamed(name, MANIFEST_FILENAME)
    );
    if (!manifestEntry || manifestEntry[1].kind !== "file") continue;
    foundManifest = true;
    try {
      const file = await manifestEntry[1].getFile();
      if (file.size > MAX_MANIFEST_BYTES || typeof file.text !== "function") continue;
      const parsed = parseToySyncManifest(await file.text());
      if (parsed) return { status: "valid", recordings: parsed };
    } catch {
      // An unreadable optional manifest must not prevent fallback file scanning.
    }
  }
  return {
    status: foundManifest ? "invalid" : "absent",
    recordings: []
  };
}

function manifestTimestampMap(
  recordings: readonly ToySyncManifestRecording[]
): ReadonlyMap<string, number> {
  return new Map(
    recordings.map((recording) => [
      normalizeFilename(recording.filename),
      recording.createdAtMs
    ])
  );
}

function compareNewestFirst(
  left: ToySyncScannedRecording,
  right: ToySyncScannedRecording
): number {
  return right.suggestedTimestampMs - left.suggestedTimestampMs
    || right.lastModified - left.lastModified
    || left.duplicateKey.localeCompare(right.duplicateKey);
}

export async function scanToySyncDirectory(
  selectedDirectory: ToySyncDirectoryHandle
): Promise<ToySyncScanResult> {
  const selectedEntries = await readDirectoryEntries(selectedDirectory);
  const recordingsSubdirectory = isNamed(selectedDirectory.name, RECORDINGS_DIRECTORY_NAME)
    ? null
    : selectedEntries.find(
      ([name, handle]) => handle.kind === "directory"
        && isNamed(name, RECORDINGS_DIRECTORY_NAME)
    )?.[1] ?? null;
  const useSubdirectory = recordingsSubdirectory?.kind === "directory";
  const recordingEntries = useSubdirectory
    ? await readDirectoryEntries(recordingsSubdirectory)
    : selectedEntries;
  const manifest = await readManifest(
    useSubdirectory ? [recordingEntries, selectedEntries] : [recordingEntries]
  );
  const manifestTimestamps = manifestTimestampMap(manifest.recordings);
  const recordings: ToySyncScannedRecording[] = [];
  let unreadableFileCount = 0;

  for (const [entryName, handle] of recordingEntries) {
    if (handle.kind !== "file" || isNamed(entryName, MANIFEST_FILENAME)) continue;
    try {
      const file = await handle.getFile();
      const filename = file.name || entryName;
      if (!isSupportedAudioUpload({ name: filename, type: file.type })) continue;
      const manifestTimestamp = manifestTimestamps.get(normalizeFilename(filename));
      const fileCreatedTime = readFileCreatedTime(file);
      const suggestedTimestampMs = manifestTimestamp
        ?? fileCreatedTime
        ?? normalizeFiniteInteger(file.lastModified);
      const timestampSource: ToySyncTimestampSource = manifestTimestamp !== undefined
        ? "manifest"
        : fileCreatedTime !== null
          ? "file_created_time"
          : "file_last_modified";
      recordings.push({
        file,
        filename,
        fileSize: file.size,
        lastModified: normalizeFiniteInteger(file.lastModified),
        duplicateKey: createToySyncDuplicateKey({
          filename,
          fileSize: file.size,
          lastModified: file.lastModified
        }),
        suggestedTimestampMs,
        timestampSource,
        timestampReliable: timestampSource === "manifest"
      });
    } catch {
      unreadableFileCount += 1;
    }
  }

  recordings.sort(compareNewestFirst);
  return {
    recordings,
    manifestStatus: manifest.status,
    usedRecordingsSubdirectory: useSubdirectory,
    unreadableFileCount
  };
}

export function createEmptyToySyncState(): ToySyncState {
  return { version: STATE_VERSION, records: [] };
}

export type ToySyncRecordScope = Readonly<{
  relationshipId: string;
}>;

function normalizedRecordScope(scope: ToySyncRecordScope): {
  relationshipId: string;
} {
  const relationshipId = scope.relationshipId.normalize("NFKC").trim();
  if (!relationshipId) throw new Error("toy_sync_relationship_scope_required");
  return { relationshipId };
}

function recordIdentity(record: Pick<
  ToySyncStateRecord,
  "duplicateKey" | "relationshipId"
>): string {
  return JSON.stringify([
    record.duplicateKey,
    record.relationshipId ?? null
  ]);
}

export function findToySyncStateRecord(
  state: ToySyncState,
  duplicateKey: string,
  scope?: ToySyncRecordScope
): ToySyncStateRecord | undefined {
  if (!scope) {
    return state.records.find((record) => (
      record.duplicateKey === duplicateKey && !record.relationshipId
    ));
  }
  const normalized = normalizedRecordScope(scope);
  const matches = state.records.filter((record) => (
    record.duplicateKey === duplicateKey
    && record.relationshipId === normalized.relationshipId
  ));
  return matches[0];
}

function sortStateRecords(records: readonly ToySyncStateRecord[]): ToySyncStateRecord[] {
  return [...records].sort((left, right) =>
    left.duplicateKey.localeCompare(right.duplicateKey)
    || (left.relationshipId ?? "").localeCompare(right.relationshipId ?? "")
  );
}

export function reconcileToySyncState(
  state: ToySyncState,
  recordings: readonly ToySyncScannedRecording[],
  updatedAt = new Date().toISOString(),
  operationScope?: ToySyncRecordScope
): ToySyncState {
  const records = [...state.records];
  const normalizedScope = operationScope
    ? normalizedRecordScope(operationScope)
    : null;
  for (const recording of recordings) {
    if (normalizedScope) {
      const scopedIndex = records.findIndex((record) => (
        record.duplicateKey === recording.duplicateKey
        && record.relationshipId === normalizedScope.relationshipId
      ));
      if (scopedIndex >= 0) continue;
      const legacyIndex = records.findIndex((record) => (
        record.duplicateKey === recording.duplicateKey && !record.relationshipId
      ));
      if (legacyIndex >= 0) {
        records[legacyIndex] = {
          ...records[legacyIndex],
          relationshipId: normalizedScope.relationshipId
        };
        continue;
      }
    } else if (records.some((record) => (
      record.duplicateKey === recording.duplicateKey && !record.relationshipId
    ))) {
      continue;
    }
    records.push({
      duplicateKey: recording.duplicateKey,
      filename: recording.filename,
      fileSize: recording.fileSize,
      lastModified: recording.lastModified,
      ...(normalizedScope ? {
        relationshipId: normalizedScope.relationshipId
      } : {}),
      status: "new",
      updatedAt
    });
  }
  return { version: STATE_VERSION, records: sortStateRecords(records) };
}

const ALLOWED_TRANSITIONS: Readonly<Record<ToySyncEntryStatus, readonly ToySyncEntryStatus[]>> = {
  new: ["uploading", "ignored"],
  uploading: ["uploaded", "failed"],
  uploaded: [],
  failed: ["uploading", "ignored"],
  ignored: ["new"]
};

export function transitionToySyncState(
  state: ToySyncState,
  duplicateKey: string,
  nextStatus: ToySyncEntryStatus,
  options: {
    updatedAt?: string;
    errorMessage?: string;
    sha256?: string;
    recordingDate?: string;
    operationKey?: string;
    relationshipId?: string;
  } = {}
): ToySyncState {
  const requestedScope = options.relationshipId
    ? { relationshipId: options.relationshipId }
    : undefined;
  const target = findToySyncStateRecord(state, duplicateKey, requestedScope);
  const index = target
    ? state.records.findIndex((record) => recordIdentity(record) === recordIdentity(target))
    : -1;
  if (index < 0) throw new Error("toy_sync_record_not_found");
  const current = state.records[index];
  if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
    throw new Error(`toy_sync_invalid_transition:${current.status}:${nextStatus}`);
  }
  const sha256 = options.sha256?.trim().toLowerCase();
  if (sha256 && !SHA256_PATTERN.test(sha256)) {
    throw new Error("toy_sync_invalid_sha256");
  }
  const recordingDate = options.recordingDate?.trim();
  if (recordingDate && !/^\d{4}-\d{2}-\d{2}$/u.test(recordingDate)) {
    throw new Error("toy_sync_invalid_recording_date");
  }
  if (
    recordingDate
    && current.recordingDate
    && current.recordingDate !== recordingDate
  ) {
    throw new Error("toy_sync_recording_date_conflict");
  }
  const operationKey = options.operationKey?.trim();
  if (operationKey && !OPERATION_KEY_PATTERN.test(operationKey)) {
    throw new Error("toy_sync_invalid_operation_key");
  }
  if (
    operationKey
    && current.operationKey
    && current.operationKey !== operationKey
  ) {
    throw new Error("toy_sync_operation_key_conflict");
  }
  const nextRecord: ToySyncStateRecord = {
    ...current,
    status: nextStatus,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
    ...(sha256 ? { sha256 } : {}),
    ...(recordingDate ? { recordingDate } : {}),
    ...(operationKey ? { operationKey } : {}),
    ...(nextStatus === "failed" && options.errorMessage?.trim()
      ? { errorMessage: options.errorMessage.trim() }
      : {})
  };
  if (nextStatus !== "failed") delete (nextRecord as { errorMessage?: string }).errorMessage;
  const records = [...state.records];
  records[index] = nextRecord;
  return { version: STATE_VERSION, records };
}

export type ToySyncReceiptUpdate = Readonly<{
  receiptId: string;
  operationKey: string;
  relationshipId: string;
  uploadId: string;
  jobId: string;
  state: ToySyncReceiptStatus;
  recordingDate: string;
  serverAcceptedAt?: string;
}>;

export function isToySyncReceiptDurablyAccepted(
  receipt: Pick<ToySyncReceiptUpdate, "state" | "serverAcceptedAt">
): boolean {
  return Boolean(receipt.serverAcceptedAt)
    || ["accepted", "processing", "completed"].includes(receipt.state);
}

export function applyToySyncReceipt(
  state: ToySyncState,
  duplicateKey: string,
  receipt: ToySyncReceiptUpdate,
  updatedAt = new Date().toISOString()
): ToySyncState {
  const scope = normalizedRecordScope({
    relationshipId: receipt.relationshipId
  });
  const target = findToySyncStateRecord(state, duplicateKey, scope);
  if (!target) throw new Error("toy_sync_record_not_found");
  if (!OPERATION_KEY_PATTERN.test(receipt.operationKey)) {
    throw new Error("toy_sync_invalid_operation_key");
  }
  for (const serverId of [receipt.receiptId, receipt.uploadId, receipt.jobId]) {
    if (!SERVER_ID_PATTERN.test(serverId)) throw new Error("toy_sync_invalid_server_identity");
  }
  if (!RECEIPT_STATUSES.has(receipt.state)) {
    throw new Error("toy_sync_invalid_receipt_status");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(receipt.recordingDate)) {
    throw new Error("toy_sync_invalid_recording_date");
  }
  if (target.operationKey && target.operationKey !== receipt.operationKey) {
    throw new Error("toy_sync_operation_key_conflict");
  }
  if (target.receiptId && target.receiptId !== receipt.receiptId) {
    throw new Error("toy_sync_receipt_id_conflict");
  }
  if (target.uploadId && target.uploadId !== receipt.uploadId) {
    throw new Error("toy_sync_upload_id_conflict");
  }
  if (target.jobId && target.jobId !== receipt.jobId) {
    throw new Error("toy_sync_job_id_conflict");
  }
  if (target.recordingDate && target.recordingDate !== receipt.recordingDate) {
    throw new Error("toy_sync_recording_date_conflict");
  }
  for (const value of [receipt.serverAcceptedAt]) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) {
      throw new Error("toy_sync_invalid_receipt_timestamp");
    }
  }
  const index = state.records.findIndex((record) => (
    recordIdentity(record) === recordIdentity(target)
  ));
  const nextRecord: ToySyncStateRecord = {
    ...target,
    operationKey: receipt.operationKey,
    recordingDate: receipt.recordingDate,
    receiptId: receipt.receiptId,
    uploadId: receipt.uploadId,
    jobId: receipt.jobId,
    receiptStatus: receipt.state === "deleted" ? "failed" : receipt.state,
    ...(receipt.serverAcceptedAt ? { serverAcceptedAt: receipt.serverAcceptedAt } : {}),
    status: isToySyncReceiptDurablyAccepted(receipt) ? "uploaded" : "failed",
    updatedAt
  };
  delete (nextRecord as { errorMessage?: string }).errorMessage;
  const records = [...state.records];
  records[index] = nextRecord;
  return { version: STATE_VERSION, records: sortStateRecords(records) };
}

export function recoverInterruptedToySyncUploads(
  state: ToySyncState,
  updatedAt = new Date().toISOString()
): ToySyncState {
  return {
    version: STATE_VERSION,
    records: state.records.map((record) => record.status === "uploading"
      ? record.receiptId && isToySyncReceiptDurablyAccepted({
        state: record.receiptStatus ?? "reserving",
        serverAcceptedAt: record.serverAcceptedAt
      })
        ? {
            ...record,
            status: "uploaded",
            receiptStatus: record.receiptStatus ?? "accepted",
            updatedAt
          }
        : {
          ...record,
          status: "failed",
          updatedAt,
          errorMessage: "上传中断，请重试。"
        }
      : record)
  };
}

export function isToySyncUploadCandidate(status: ToySyncEntryStatus): boolean {
  return status === "new";
}

export function isToySyncRetryable(status: ToySyncEntryStatus): boolean {
  return status === "failed";
}

function isStateRecord(value: unknown): value is ToySyncStateRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ToySyncStateRecord>;
  if (
    typeof record.duplicateKey !== "string"
    || typeof record.filename !== "string"
    || typeof record.fileSize !== "number"
    || typeof record.lastModified !== "number"
    || typeof record.status !== "string"
    || !VALID_STATUSES.has(record.status as ToySyncEntryStatus)
    || typeof record.updatedAt !== "string"
    || !Number.isFinite(Date.parse(record.updatedAt))
  ) return false;
  if (record.fileSize < 0 || record.lastModified < 0) return false;
  if (record.sha256 !== undefined && !SHA256_PATTERN.test(record.sha256)) return false;
  if (record.operationKey !== undefined && !OPERATION_KEY_PATTERN.test(record.operationKey)) {
    return false;
  }
  if (
    record.relationshipId !== undefined
    && (typeof record.relationshipId !== "string" || !record.relationshipId.trim())
  ) return false;
  if (
    record.generation !== undefined
    && (!Number.isSafeInteger(record.generation) || record.generation < 0)
  ) return false;
  if (record.generation !== undefined && !record.relationshipId) return false;
  if (record.receiptId !== undefined && !SERVER_ID_PATTERN.test(record.receiptId)) return false;
  if (record.uploadId !== undefined && !SERVER_ID_PATTERN.test(record.uploadId)) return false;
  if (record.jobId !== undefined && !SERVER_ID_PATTERN.test(record.jobId)) return false;
  if (
    record.receiptStatus !== undefined
    && !RECEIPT_STATUSES.has(record.receiptStatus)
  ) return false;
  for (const value of [record.serverAcceptedAt, record.sourceCleanedAt]) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) return false;
  }
  if (
    record.reimportOfReceiptId !== undefined
    && !SERVER_ID_PATTERN.test(record.reimportOfReceiptId)
  ) return false;
  if (
    (record.receiptId || record.uploadId || record.jobId || record.receiptStatus)
    && !record.operationKey
  ) return false;
  if (
    record.recordingDate !== undefined
    && !/^\d{4}-\d{2}-\d{2}$/u.test(record.recordingDate)
  ) return false;
  if (record.errorMessage !== undefined && typeof record.errorMessage !== "string") return false;
  return record.duplicateKey === createToySyncDuplicateKey({
    filename: record.filename,
    fileSize: record.fileSize,
    lastModified: record.lastModified
  });
}

export function parseToySyncState(value: string | null): ToySyncState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { version?: unknown; records?: unknown };
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.records)) return null;
    if (!parsed.records.every(isStateRecord)) return null;
    const activeRecords = new Map<string, ToySyncStateRecord>();
    for (const legacyRecord of parsed.records as ToySyncStateRecord[]) {
      const {
        generation: _legacyGeneration,
        reimportOfReceiptId: _legacyReimport,
        sourceCleanedAt: _legacySourceCleanup,
        ...current
      } = legacyRecord;
      const normalized: ToySyncStateRecord = legacyRecord.receiptStatus === "deleted"
        ? {
            ...current,
            receiptStatus: "failed",
            status: "failed",
            errorMessage: "这条录音需要重新确认后恢复。"
          }
        : current;
      const key = recordIdentity(normalized);
      const previous = activeRecords.get(key);
      if (
        !previous
        || Date.parse(normalized.updatedAt) >= Date.parse(previous.updatedAt)
      ) activeRecords.set(key, normalized);
    }
    return {
      version: STATE_VERSION,
      records: sortStateRecords([...activeRecords.values()])
    };
  } catch {
    return null;
  }
}

export function serializeToySyncState(state: ToySyncState): string {
  return JSON.stringify({
    version: STATE_VERSION,
    records: sortStateRecords(state.records)
  });
}

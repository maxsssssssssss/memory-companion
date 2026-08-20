import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOY_SYNC_DESTINATION,
  TOY_SYNC_DESTINATIONS,
  applyToySyncReceipt,
  createEmptyToySyncState,
  createToySyncDuplicateKey,
  isToySyncDestination,
  isToySyncReceiptDurablyAccepted,
  isToySyncRetryable,
  isToySyncUploadCandidate,
  parseToySyncManifest,
  parseToySyncState,
  reconcileToySyncState,
  recoverInterruptedToySyncUploads,
  scanToySyncDirectory,
  serializeToySyncState,
  transitionToySyncState,
  type ToySyncDirectoryHandle,
  type ToySyncFileHandle,
  type ToySyncScannedRecording
} from "./daily-reflection-toy-sync";

const NOW = "2026-08-18T08:00:00.000Z";

describe("toy sync destinations", () => {
  it("keeps the legacy default explicit and accepts only supported product destinations", () => {
    expect(DEFAULT_TOY_SYNC_DESTINATION).toBe("daily_reflection");
    expect(TOY_SYNC_DESTINATIONS).toEqual(["daily_reflection", "date_companion"]);
    expect(isToySyncDestination("daily_reflection")).toBe(true);
    expect(isToySyncDestination("date_companion")).toBe(true);
    expect(isToySyncDestination("memory")).toBe(false);
  });
});

function fileHandle(
  name: string,
  options: {
    body?: string;
    type?: string;
    lastModified?: number;
    createdTime?: unknown;
    fail?: boolean;
  } = {}
): ToySyncFileHandle {
  return {
    kind: "file",
    name,
    async getFile() {
      if (options.fail) throw new DOMException("unavailable", "NotReadableError");
      const file = new File([options.body ?? "audio"], name, {
        type: options.type ?? "",
        lastModified: options.lastModified ?? Date.parse("2026-08-18T06:00:00.000Z")
      });
      if (options.createdTime !== undefined) {
        Object.defineProperty(file, "createdTime", {
          configurable: true,
          value: options.createdTime
        });
      }
      if (name.toLowerCase() === "manifest.json") {
        Object.defineProperty(file, "text", {
          configurable: true,
          value: async () => options.body ?? ""
        });
      }
      return file;
    }
  };
}

function directoryHandle(
  name: string,
  entries: readonly [string, ToySyncFileHandle | ToySyncDirectoryHandle][]
): ToySyncDirectoryHandle {
  return {
    kind: "directory",
    name,
    async *entries() {
      for (const entry of entries) yield entry;
    }
  };
}

function scanned(
  filename = "note.wav",
  lastModified = Date.parse("2026-08-18T06:00:00.000Z")
): ToySyncScannedRecording {
  const file = new File(["audio"], filename, {
    type: "audio/wav",
    lastModified
  });
  return {
    file,
    filename,
    fileSize: file.size,
    lastModified,
    duplicateKey: createToySyncDuplicateKey({
      filename,
      fileSize: file.size,
      lastModified
    }),
    suggestedTimestampMs: lastModified,
    timestampSource: "file_last_modified",
    timestampReliable: false
  };
}

describe("daily reflection toy sync directory scanning", () => {
  it("scans supported audio files in a directly selected recordings directory", async () => {
    const directory = directoryHandle("recordings", [
      ["note.txt", fileHandle("note.txt")],
      ["first.wav", fileHandle("first.wav", {
        type: "audio/wav",
        lastModified: Date.parse("2026-08-18T05:00:00.000Z")
      })],
      ["second.opus", fileHandle("second.opus", {
        type: "application/octet-stream",
        lastModified: Date.parse("2026-08-18T07:00:00.000Z")
      })]
    ]);

    const result = await scanToySyncDirectory(directory);

    expect(result.recordings.map((recording) => recording.filename)).toEqual([
      "second.opus",
      "first.wav"
    ]);
    expect(result.usedRecordingsSubdirectory).toBe(false);
    expect(result.manifestStatus).toBe("absent");
  });

  it("uses an immediate recordings child when the selected directory is the device root", async () => {
    const recordings = directoryHandle("Recordings", [
      ["inside.m4a", fileHandle("inside.m4a", { type: "audio/mp4" })]
    ]);
    const root = directoryHandle("DAILYBRIEF", [
      ["root.wav", fileHandle("root.wav", { type: "audio/wav" })],
      ["Recordings", recordings]
    ]);

    const result = await scanToySyncDirectory(root);

    expect(result.recordings.map((recording) => recording.filename)).toEqual(["inside.m4a"]);
    expect(result.usedRecordingsSubdirectory).toBe(true);
  });

  it("prefers optional manifest device time and sorts newest first", async () => {
    const rootManifest = JSON.stringify({
      recordings: [
        { filename: "older-by-file.wav", created_at: "2026-08-18T09:00:00.000Z" },
        { filename: "newer-by-file.wav", created_at: "2026-08-18T08:00:00.000Z" }
      ]
    });
    const recordings = directoryHandle("recordings", [
      ["older-by-file.wav", fileHandle("older-by-file.wav", {
        type: "audio/wav",
        lastModified: Date.parse("2026-08-18T05:00:00.000Z")
      })],
      ["newer-by-file.wav", fileHandle("newer-by-file.wav", {
        type: "audio/wav",
        lastModified: Date.parse("2026-08-18T07:00:00.000Z")
      })]
    ]);
    const root = directoryHandle("TOY", [
      ["manifest.json", fileHandle("manifest.json", {
        body: rootManifest,
        type: "application/json"
      })],
      ["recordings", recordings]
    ]);

    const result = await scanToySyncDirectory(root);

    expect(result.manifestStatus).toBe("valid");
    expect(result.recordings.map((recording) => recording.filename)).toEqual([
      "older-by-file.wav",
      "newer-by-file.wav"
    ]);
    expect(result.recordings[0]).toMatchObject({
      timestampSource: "manifest",
      timestampReliable: true,
      suggestedTimestampMs: Date.parse("2026-08-18T09:00:00.000Z")
    });
  });

  it("uses File.createdTime when exposed but still marks filesystem metadata best-effort", async () => {
    const createdTime = Date.parse("2026-08-18T04:00:00.000Z");
    const directory = directoryHandle("recordings", [
      ["created.wav", fileHandle("created.wav", {
        type: "audio/wav",
        createdTime,
        lastModified: Date.parse("2026-08-18T07:00:00.000Z")
      })]
    ]);

    const result = await scanToySyncDirectory(directory);

    expect(result.recordings[0]).toMatchObject({
      suggestedTimestampMs: createdTime,
      timestampSource: "file_created_time",
      timestampReliable: false
    });
  });

  it("falls back to lastModified and marks it unreliable", async () => {
    const lastModified = Date.parse("2026-08-18T07:00:00.000Z");
    const directory = directoryHandle("recordings", [
      ["fallback.wav", fileHandle("fallback.wav", { type: "audio/wav", lastModified })]
    ]);

    const result = await scanToySyncDirectory(directory);

    expect(result.recordings[0]).toMatchObject({
      suggestedTimestampMs: lastModified,
      timestampSource: "file_last_modified",
      timestampReliable: false
    });
  });

  it("falls back to scanning when the optional manifest is invalid", async () => {
    const directory = directoryHandle("recordings", [
      ["manifest.json", fileHandle("manifest.json", {
        body: "not-json",
        type: "application/json"
      })],
      ["fallback.wav", fileHandle("fallback.wav", { type: "audio/wav" })]
    ]);

    const result = await scanToySyncDirectory(directory);

    expect(result.manifestStatus).toBe("invalid");
    expect(result.recordings).toHaveLength(1);
    expect(result.recordings[0].timestampSource).toBe("file_last_modified");
  });

  it("skips an unreadable audio entry without failing the remaining scan", async () => {
    const directory = directoryHandle("recordings", [
      ["broken.wav", fileHandle("broken.wav", { fail: true })],
      ["good.wav", fileHandle("good.wav", { type: "audio/wav" })]
    ]);

    const result = await scanToySyncDirectory(directory);

    expect(result.recordings.map((recording) => recording.filename)).toEqual(["good.wav"]);
    expect(result.unreadableFileCount).toBe(1);
  });
});

describe("daily reflection toy sync manifest parsing", () => {
  it("accepts future recordings[{filename,created_at}] and ignores malformed entries", () => {
    expect(parseToySyncManifest(JSON.stringify({
      recordings: [
        { filename: "valid.wav", created_at: "2026-08-18T08:00:00.000Z" },
        { filename: "missing-time.wav" },
        { filename: "valid.wav", created_at: "2026-08-19T08:00:00.000Z" }
      ]
    }))).toEqual([{
      filename: "valid.wav",
      createdAtMs: Date.parse("2026-08-18T08:00:00.000Z")
    }]);
  });

  it("rejects JSON without a recordings array", () => {
    expect(parseToySyncManifest("{}" )).toBeNull();
    expect(parseToySyncManifest("not-json")).toBeNull();
  });
});

describe("daily reflection toy sync duplicate and persisted state", () => {
  it.each([
    ["reserving", undefined, false],
    ["failed", undefined, false],
    ["failed", NOW, true],
    ["accepted", undefined, true],
    ["processing", undefined, true],
    ["completed", undefined, true]
  ] as const)("classifies receipt state %s by durable server acceptance", (
    state,
    serverAcceptedAt,
    expected
  ) => {
    expect(isToySyncReceiptDurablyAccepted({ state, serverAcceptedAt })).toBe(expected);
  });

  it("creates a deterministic duplicate key from normalized filename, size and modification time", () => {
    const left = createToySyncDuplicateKey({
      filename: " Note.WAV ",
      fileSize: 1024,
      lastModified: 1_723_000_000_123
    });
    const right = createToySyncDuplicateKey({
      filename: "note.wav",
      fileSize: 1024,
      lastModified: 1_723_000_000_123
    });

    expect(left).toBe(right);
    expect(left).toBe("toy-sync:v1:note.wav:1024:1723000000123");
  });

  it("reconciles newly discovered files without duplicating or pruning prior records", () => {
    const first = scanned("first.wav");
    const second = scanned("second.wav", first.lastModified + 1_000);
    const initial = reconcileToySyncState(createEmptyToySyncState(), [first], NOW);
    const uploaded = transitionToySyncState(
      transitionToySyncState(initial, first.duplicateKey, "uploading", { updatedAt: NOW }),
      first.duplicateKey,
      "uploaded",
      { updatedAt: NOW }
    );

    const reconciled = reconcileToySyncState(uploaded, [first, second, second], NOW);

    expect(reconciled.records).toHaveLength(2);
    expect(reconciled.records.find((record) => record.duplicateKey === first.duplicateKey)?.status)
      .toBe("uploaded");
    expect(reconciled.records.find((record) => record.duplicateKey === second.duplicateKey)?.status)
      .toBe("new");
  });

  it("supports failed upload retry while ignored records are not upload candidates", () => {
    const recording = scanned();
    const initial = reconcileToySyncState(createEmptyToySyncState(), [recording], NOW);
    const uploading = transitionToySyncState(initial, recording.duplicateKey, "uploading", {
      updatedAt: NOW,
      recordingDate: "2026-08-18"
    });
    const failed = transitionToySyncState(uploading, recording.duplicateKey, "failed", {
      updatedAt: NOW,
      errorMessage: "network unavailable"
    });

    expect(isToySyncRetryable(failed.records[0].status)).toBe(true);
    const retrying = transitionToySyncState(failed, recording.duplicateKey, "uploading", {
      updatedAt: NOW
    });
    expect(retrying.records[0]).toMatchObject({ status: "uploading" });
    expect(retrying.records[0].recordingDate).toBe("2026-08-18");
    expect(retrying.records[0].errorMessage).toBeUndefined();

    const other = scanned("ignored.wav");
    const withOther = reconcileToySyncState(retrying, [other], NOW);
    const ignored = transitionToySyncState(withOther, other.duplicateKey, "ignored", {
      updatedAt: NOW
    });
    expect(isToySyncUploadCandidate(ignored.records.find(
      (record) => record.duplicateKey === other.duplicateKey
    )!.status)).toBe(false);
    expect(isToySyncRetryable("ignored")).toBe(false);
  });

  it("locks the user-confirmed recording date across ambiguous failed retries", () => {
    const recording = scanned();
    const initial = reconcileToySyncState(createEmptyToySyncState(), [recording], NOW);
    const uploading = transitionToySyncState(initial, recording.duplicateKey, "uploading", {
      updatedAt: NOW,
      recordingDate: "2026-08-18"
    });
    const failed = transitionToySyncState(uploading, recording.duplicateKey, "failed", {
      updatedAt: NOW,
      errorMessage: "response lost"
    });

    expect(() => transitionToySyncState(failed, recording.duplicateKey, "uploading", {
      recordingDate: "2026-08-17"
    })).toThrow("toy_sync_recording_date_conflict");
  });

  it("adopts a legacy record once without letting another relationship reuse it", () => {
    const recording = scanned();
    const legacy = transitionToySyncState(
      reconcileToySyncState(createEmptyToySyncState(), [recording], NOW),
      recording.duplicateKey,
      "ignored",
      { updatedAt: NOW }
    );

    const firstRelationship = reconcileToySyncState(
      legacy,
      [recording],
      "2026-08-18T09:00:00.000Z",
      { relationshipId: "relationship_1" }
    );
    expect(firstRelationship.records[0]).toMatchObject({
      relationshipId: "relationship_1",
      status: "ignored"
    });
    const secondRelationship = reconcileToySyncState(
      firstRelationship,
      [recording],
      "2026-08-18T10:00:00.000Z",
      { relationshipId: "relationship_2" }
    );
    expect(secondRelationship.records).toHaveLength(2);
    expect(secondRelationship.records.find((record) => (
      record.relationshipId === "relationship_1"
    ))).toEqual(expect.objectContaining({ status: "ignored" }));
    expect(secondRelationship.records.find((record) => (
      record.relationshipId === "relationship_2"
    ))).toEqual(expect.objectContaining({
      relationshipId: "relationship_2",
      status: "new"
    }));
  });

  it("retains independent operation and status when switching relationships both ways", () => {
    const recording = scanned();
    const scopeA = { relationshipId: "relationship_1" };
    const scopeB = { relationshipId: "relationship_2" };
    const stateA = reconcileToySyncState(
      createEmptyToySyncState(),
      [recording],
      NOW,
      scopeA
    );
    const uploadingA = transitionToySyncState(stateA, recording.duplicateKey, "uploading", {
      ...scopeA,
      operationKey: `toyop_v1_${"a".repeat(64)}`,
      recordingDate: "2026-08-18",
      updatedAt: NOW
    });
    const uploadedA = transitionToySyncState(uploadingA, recording.duplicateKey, "uploaded", {
      ...scopeA,
      updatedAt: NOW
    });
    const stateB = reconcileToySyncState(uploadedA, [recording], NOW, scopeB);
    const uploadingB = transitionToySyncState(stateB, recording.duplicateKey, "uploading", {
      ...scopeB,
      operationKey: `toyop_v1_${"b".repeat(64)}`,
      recordingDate: "2026-08-17",
      updatedAt: NOW
    });
    const failedB = transitionToySyncState(uploadingB, recording.duplicateKey, "failed", {
      ...scopeB,
      errorMessage: "network unavailable",
      updatedAt: NOW
    });

    const backToA = reconcileToySyncState(failedB, [recording], NOW, scopeA);
    expect(backToA.records).toHaveLength(2);
    expect(backToA.records.find((record) => record.relationshipId === "relationship_1"))
      .toEqual(expect.objectContaining({
        status: "uploaded",
        operationKey: `toyop_v1_${"a".repeat(64)}`,
        recordingDate: "2026-08-18"
      }));
    expect(backToA.records.find((record) => record.relationshipId === "relationship_2"))
      .toEqual(expect.objectContaining({
        status: "failed",
        operationKey: `toyop_v1_${"b".repeat(64)}`,
        recordingDate: "2026-08-17"
      }));
  });

  it("recovers persisted uploading records as failed and retryable after interruption", () => {
    const recording = scanned();
    const initial = reconcileToySyncState(createEmptyToySyncState(), [recording], NOW);
    const uploading = transitionToySyncState(initial, recording.duplicateKey, "uploading", {
      updatedAt: NOW
    });

    const recovered = recoverInterruptedToySyncUploads(
      uploading,
      "2026-08-18T09:00:00.000Z"
    );

    expect(recovered.records[0]).toMatchObject({
      status: "failed",
      errorMessage: "上传中断，请重试。",
      updatedAt: "2026-08-18T09:00:00.000Z"
    });
    expect(isToySyncRetryable(recovered.records[0].status)).toBe(true);
  });

  it("preserves a durably accepted receipt across refresh but leaves pre-accept claims retryable", () => {
    const recording = scanned();
    const scope = { relationshipId: "relationship_1" };
    const initial = reconcileToySyncState(createEmptyToySyncState(), [recording], NOW, scope);
    const uploading = transitionToySyncState(initial, recording.duplicateKey, "uploading", {
      ...scope,
      operationKey: `toyop_v1_${"d".repeat(64)}`,
      recordingDate: "2026-08-18",
      updatedAt: NOW
    });
    const accepted = applyToySyncReceipt(uploading, recording.duplicateKey, {
      receiptId: "receipt_1",
      operationKey: `toyop_v1_${"d".repeat(64)}`,
      relationshipId: scope.relationshipId,
      uploadId: "upload_1",
      jobId: "job_1",
      state: "accepted",
      recordingDate: "2026-08-18",
      serverAcceptedAt: NOW
    }, NOW);
    expect(recoverInterruptedToySyncUploads(accepted, "2026-08-18T09:00:00.000Z").records[0])
      .toMatchObject({ status: "uploaded", receiptStatus: "accepted", receiptId: "receipt_1" });
    expect(parseToySyncState(serializeToySyncState(accepted))).toEqual(accepted);

    const reserving = applyToySyncReceipt(uploading, recording.duplicateKey, {
      receiptId: "receipt_preclaim",
      operationKey: `toyop_v1_${"d".repeat(64)}`,
      relationshipId: scope.relationshipId,
      uploadId: "upload_1",
      jobId: "job_1",
      state: "reserving",
      recordingDate: "2026-08-18"
    }, NOW);
    expect(recoverInterruptedToySyncUploads(reserving, "2026-08-18T09:00:00.000Z").records[0])
      .toMatchObject({ status: "failed", receiptStatus: "reserving" });
  });

  it("round-trips valid state and rejects tampered duplicate keys", () => {
    const recording = scanned();
    const state = reconcileToySyncState(createEmptyToySyncState(), [recording], NOW);

    expect(parseToySyncState(serializeToySyncState(state))).toEqual(state);
    expect(parseToySyncState(JSON.stringify({
      version: 1,
      records: [{ ...state.records[0], duplicateKey: "tampered" }]
    }))).toBeNull();
  });

  it("round-trips an optional stable operation identity without rejecting legacy rows", () => {
    const recording = scanned();
    const legacy = reconcileToySyncState(createEmptyToySyncState(), [recording], NOW);
    expect(parseToySyncState(serializeToySyncState(legacy))).toEqual(legacy);

    const scoped = reconcileToySyncState(
      legacy,
      [recording],
      NOW,
      { relationshipId: "relationship_1" }
    );
    const uploading = transitionToySyncState(scoped, recording.duplicateKey, "uploading", {
      relationshipId: "relationship_1",
      updatedAt: NOW,
      recordingDate: "2026-08-18",
      operationKey: `toyop_v1_${"b".repeat(64)}`
    });
    expect(parseToySyncState(serializeToySyncState(uploading))).toEqual(uploading);
    expect(() => transitionToySyncState(
      transitionToySyncState(uploading, recording.duplicateKey, "failed", {
        relationshipId: "relationship_1",
        updatedAt: NOW
      }),
      recording.duplicateKey,
      "uploading",
      {
        relationshipId: "relationship_1",
        operationKey: `toyop_v1_${"c".repeat(64)}`
      }
    )).toThrow("toy_sync_operation_key_conflict");
  });

  it("rejects invalid transitions and accepts a valid sha256 receipt", () => {
    const recording = scanned();
    const initial = reconcileToySyncState(createEmptyToySyncState(), [recording], NOW);
    expect(() => transitionToySyncState(initial, recording.duplicateKey, "uploaded"))
      .toThrow("toy_sync_invalid_transition:new:uploaded");

    const uploading = transitionToySyncState(initial, recording.duplicateKey, "uploading", {
      updatedAt: NOW
    });
    const uploaded = transitionToySyncState(uploading, recording.duplicateKey, "uploaded", {
      updatedAt: NOW,
      sha256: "A".repeat(64)
    });
    expect(uploaded.records[0].sha256).toBe("a".repeat(64));
  });
});

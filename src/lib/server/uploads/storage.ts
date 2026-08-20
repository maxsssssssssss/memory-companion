import * as fs from "fs/promises";
import { extname, join } from "path";

import { mimeTypeToAudioExtension, normalizeAudioForTranscription } from "@/lib/audio/compat";
import type { AudioUpload } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";

const mimeTypeToExtension: Record<string, string> = {
  "audio/m4a": ".m4a",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/mpga": ".mpga",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/x-pcm": ".pcm",
  "video/mp4": ".mp4"
};

export class AudioUploadPersistenceError extends Error {
  readonly code = "audio_upload_persistence_failed";

  constructor(readonly filePath: string, options?: ErrorOptions) {
    super("Audio upload persistence failed", options);
    this.name = "AudioUploadPersistenceError";
  }
}

export async function cleanupPersistedAudioUploadAttempt(input: {
  store: JsonStore;
  upload: { id: string; filePath: string };
  removeProjection?: boolean;
}) {
  await fs.rm(input.upload.filePath, { force: true }).catch(() => undefined);
  if (!input.removeProjection) return;
  const stored = await input.store.read<{ id?: string; filePath?: string }>(
    "uploads",
    input.upload.id
  ).catch(() => null);
  if (stored?.id === input.upload.id && stored.filePath === input.upload.filePath) {
    await input.store.delete("uploads", input.upload.id).catch(() => undefined);
  }
}

export async function cleanupOlderAudioUploadAttempts(input: {
  uploadDir: string;
  uploadId: string;
  currentAttempt: number;
}) {
  if (!Number.isSafeInteger(input.currentAttempt) || input.currentAttempt < 1) return;
  const attemptPrefix = `${input.uploadId}.attempt-`;
  const escapedUploadId = input.uploadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const entries = await fs.readdir(input.uploadDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.flatMap((entry) => {
    if (!entry.isFile() || !entry.name.startsWith(attemptPrefix)) return [];
    const match = new RegExp(`^${escapedUploadId}\\.attempt-(\\d+)\\.`, "u").exec(entry.name);
    return match && Number(match[1]) < input.currentAttempt
      ? [fs.rm(join(input.uploadDir, entry.name), { force: true })]
      : [];
  }).map((cleanup) => cleanup.catch(() => undefined)));
}

export function normalizeUploadRecordingDate(value: FormDataEntryValue | null) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return new Date().toISOString().slice(0, 10);
}

export function extensionForAudioUpload(fileName: string, mimeType: string) {
  return extname(fileName)
    || mimeTypeToAudioExtension(mimeType)
    || mimeTypeToExtension[mimeType]
    || ".bin";
}

export async function persistAudioUpload<Extra extends Record<string, unknown> = Record<string, never>>(
  input: {
    store: JsonStore;
    uploadId: string;
    uploadDir: string;
    file: File;
    recordingDate: string;
    extra?: Extra;
    attemptSuffix?: string;
    assertWritable?: () => void | Promise<void>;
    publishUpload?: (
      upload: AudioUpload & { filePath: string } & Extra
    ) => void | Promise<void>;
  }
): Promise<AudioUpload & { filePath: string } & Extra> {
  const originalBytes = new Uint8Array(await input.file.arrayBuffer());
  const normalizedAudio = normalizeAudioForTranscription({
    name: input.file.name,
    type: input.file.type,
    bytes: originalBytes
  });
  const rawAttemptSuffix = input.attemptSuffix;
  const attemptSuffix = rawAttemptSuffix === undefined
    ? ""
    : (() => {
      if (!/^[a-zA-Z0-9_-]+$/u.test(rawAttemptSuffix)) {
        throw new AudioUploadPersistenceError("", {
          cause: new Error("invalid_upload_attempt_suffix")
        });
      }
      return `.${rawAttemptSuffix}`;
    })();
  const filePath = join(
    input.uploadDir,
    `${input.uploadId}${attemptSuffix}${extensionForAudioUpload(
      normalizedAudio.name,
      normalizedAudio.mimeType
    )}`
  );
  const upload = {
    id: input.uploadId,
    originalName: input.file.name,
    mimeType: normalizedAudio.mimeType,
    sizeBytes: input.file.size,
    recordingDate: input.recordingDate,
    createdAt: new Date().toISOString(),
    status: "uploaded" as const,
    filePath,
    ...(input.extra ?? {} as Extra)
  };

  await fs.mkdir(input.uploadDir, { recursive: true });
  try {
    await input.assertWritable?.();
    await fs.writeFile(filePath, normalizedAudio.bytes);
    await input.assertWritable?.();
    if (input.publishUpload) {
      await input.publishUpload(upload);
    } else {
      await input.store.write("uploads", input.uploadId, upload);
    }
    await input.assertWritable?.();
    const numberedAttempt = rawAttemptSuffix
      ? /^attempt-(\d+)$/u.exec(rawAttemptSuffix)
      : null;
    if (numberedAttempt) {
      await cleanupOlderAudioUploadAttempts({
        uploadDir: input.uploadDir,
        uploadId: input.uploadId,
        currentAttempt: Number(numberedAttempt[1])
      });
    }
    return upload;
  } catch (error) {
    await cleanupPersistedAudioUploadAttempt({
      store: input.store,
      upload,
      removeProjection: rawAttemptSuffix === undefined
    });
    throw new AudioUploadPersistenceError(filePath, { cause: error });
  }
}

export const DATE_COMPANION_UPLOAD_CONTEXT_FIELD = "uploadContext";
export const DATE_COMPANION_UPLOAD_CONTEXT_VALUE = "date-companion";

/**
 * Internal persisted marker. The upload route derives this value from the
 * exact multipart context above instead of persisting arbitrary client input.
 */
export const DATE_COMPANION_AUDIO_SNAPSHOT_VERSION = 1 as const;

export type DateCompanionMarkedUpload = {
  dateCompanionAudioSnapshotVersion?: typeof DATE_COMPANION_AUDIO_SNAPSHOT_VERSION;
  /** Server-owned binding for Toy uploads; ordinary manual uploads omit it. */
  toyIngestionRelationshipId?: string;
};

export function requestsDateCompanionAudioSnapshot(
  formData: Pick<FormData, "get">
) {
  return formData.get(DATE_COMPANION_UPLOAD_CONTEXT_FIELD) ===
    DATE_COMPANION_UPLOAD_CONTEXT_VALUE;
}

export function isDateCompanionMarkedUpload(
  upload: DateCompanionMarkedUpload
) {
  return upload.dateCompanionAudioSnapshotVersion ===
    DATE_COMPANION_AUDIO_SNAPSHOT_VERSION;
}

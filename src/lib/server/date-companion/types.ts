import type {
  DcParticipantRole,
  DcRecapDisposition,
  DcRecapKind
} from "@/lib/domain/date-companion-stage2";

export type DcImportEvidenceCandidate = {
  uploadId: string;
  sourceSegmentId: string;
  startSeconds: number;
  endSeconds: number;
  speakerId?: string;
  quote: string;
};

export type DcImportRecapCandidate = {
  kind: DcRecapKind;
  proposedText: string;
  sortOrder: number;
  evidence: DcImportEvidenceCandidate[];
};

export type DcImportInteractionInput = {
  userId: string;
  relationshipId: string;
  sourceUploadId: string;
  recordingDate: string;
  originalName: string;
  durationSeconds?: number;
  participants: Array<{
    speakerId: string;
    continuityKey?: string;
  }>;
  recapCandidates: DcImportRecapCandidate[];
};

export type DcParticipantMutation = {
  speakerId: string;
  role: DcParticipantRole;
};

export type DcVoiceEnrollmentSnapshotInput = {
  reviewGroupId: string;
  speakerIds: string[];
  sourceUploadId: string;
  providerRecordId: string;
  chunkId: string;
  localSpeaker: string;
  auditStatus: "verified" | "pending" | "unknown";
  auditReason: string;
  auditDigest: string;
  expiresAt: string;
};

export type DcVoiceEnrollmentIntent = {
  speakerIds: string[];
};

export type DcVoiceEnrollmentDispatchJob = {
  id: string;
  userId: string;
  relationshipId: string;
  interactionId: string;
  snapshotId: string;
  idempotencyKey: string;
  providerSpeakerId: string;
  expectedGlobalSpeakerId: string;
  sourceUploadId: string;
  providerRecordId: string;
  chunkId: string;
  localSpeaker: string;
  speakerIds: string[];
  attemptCount: number;
  claimToken: string;
  leaseExpiresAt: string;
};

export type DcVoiceEnrollmentDispatchCandidate = {
  outboxId: string;
  userId: string;
  status: "pending" | "processing" | "failed";
  attemptCount: number;
  updatedAt: string;
  leaseExpiresAt?: string;
};

export type DcParticipantAudioSample = {
  speakerId: string;
  mimeType: "audio/mpeg";
  durationMilliseconds: number;
  audio: Uint8Array;
};

export type DcRecapMutation = {
  id: string;
  version: number;
  userText?: string | null;
  disposition: DcRecapDisposition;
};

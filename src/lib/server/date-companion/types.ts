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
  speakerIds: string[];
  recapCandidates: DcImportRecapCandidate[];
};

export type DcParticipantMutation = {
  speakerId: string;
  role: DcParticipantRole;
};

export type DcRecapMutation = {
  id: string;
  version: number;
  userText?: string | null;
  disposition: DcRecapDisposition;
};

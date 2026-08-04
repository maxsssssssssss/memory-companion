import type { QuestionAnswer } from "@/lib/domain/types";

export type AuthUser = {
  id: string;
  email: string;
  name?: string;
};

export type AuthState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "error"; message: string };

export type SourceRefVM = {
  id: string;
  uploadId: string;
  segmentIds: string[];
  recordingDate: string;
  startSeconds: number;
  endSeconds: number;
  speakerId?: string;
  speakerLabel?: string;
  quote: string;
  kind: "transcript" | "brief" | "semantic" | "relationship" | "proactive";
  presentation: "direct_quote" | "derived_summary" | "suggestion";
  /** Only true when this browser has the complete DayPayload for uploadId. */
  canOpenTranscript?: boolean;
};

export type DateCompanionParticipantRole = "self" | "companion" | "unresolved";

export type RelationshipVM = {
  id?: string;
  displayName?: string;
  knownSinceDate?: string;
  lastInteractionAt?: string;
  participantState: "confirmed" | "unresolved";
  status?: "active" | "archived";
  version?: number;
};

export type TranscriptLineVM = {
  id: string;
  uploadId: string;
  startSeconds: number;
  endSeconds: number;
  speakerId?: string;
  speakerLabel?: string;
  text: string;
};

export type InteractionVM = {
  id: string;
  uploadIds: string[];
  recordingDate: string;
  fileName: string;
  title: string;
  place?: string;
  durationSeconds?: number;
  status: "processing" | "ready" | "failed";
  progress?: number;
  errorMessage?: string;
  transcript: TranscriptLineVM[];
  relationshipInteractionId?: string;
  sourceUploadId?: string;
  persistenceStatus?: "draft" | "confirmed";
  sourceState?: "available" | "server_cleaned" | "explicitly_deleted";
  version?: number;
};

export type RecapItemVM = {
  id: string;
  kind: "moment" | "mentioned" | "promise" | "continue";
  title: string;
  proposedText: string;
  displayedText: string;
  disposition: "pending" | "kept" | "excluded";
  sources: SourceRefVM[];
  version?: number;
  interactionId?: string;
  sortOrder?: number;
};

export type ParticipantReviewVM = {
  speakerId: string;
  displayLabel: string;
  alias?: string;
  state: "unresolved" | "confirmed";
  role: DateCompanionParticipantRole;
  version?: number;
  sampleQuotes: SourceRefVM[];
};

export type PromiseVM = {
  id: string;
  relationshipId: string;
  originatingRecapItemId: string;
  text: string;
  status: "open" | "done";
  version: number;
  resolvedAt?: string;
  sources: SourceRefVM[];
};

export type TranscriptChapterVM = {
  id: string;
  title: string;
  startSeconds: number;
  endSeconds: number;
  sourceSegmentIds: string[];
};

export type HomeVM = {
  remembered: RecapItemVM | null;
  preparePreview: RecapItemVM | null;
  participantNotice: string | null;
};

export type PersonVM = {
  remembered: RecapItemVM[];
  recent: RecapItemVM[];
  relationship: RecapItemVM[];
  promises: PromiseVM[];
  interactions: InteractionVM[];
  observation: RecapItemVM | null;
  limitedToCurrentInteraction: boolean;
};

export type RecapVM = {
  interaction: InteractionVM | null;
  items: RecapItemVM[];
  participants: ParticipantReviewVM[];
  chapters: TranscriptChapterVM[];
};

export type PrepareVM = {
  headline: string;
  recentConcern: RecapItemVM | null;
  lastTopic: RecapItemVM | null;
  promise: RecapItemVM | null;
  conversationStarter: RecapItemVM | null;
  items: RecapItemVM[];
  openPromises: PromiseVM[];
};

export type DateCompanionRelationshipState =
  | { status: "idle" | "loading" }
  | { status: "absent" }
  | { status: "creating" }
  | { status: "ready"; relationship: RelationshipVM }
  | { status: "error"; message: string };

export type DateCompanionMutationState =
  | { status: "idle" }
  | { status: "saving"; operation: "participants" | "recap" | "finalize" | "promise" | "delete" }
  | { status: "error"; operation: "participants" | "recap" | "finalize" | "promise" | "delete"; message: string };

export type DateCompanionSearchResultVM = {
  id: string;
  kind: RecapItemVM["kind"] | "promise";
  text: string;
  recordingDate: string;
  sources: SourceRefVM[];
};

export type DateCompanionSearchState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "ready"; query: string; results: DateCompanionSearchResultVM[] }
  | { status: "error"; query: string; message: string };

export type DateCompanionViewModel = {
  relationship: RelationshipVM | null;
  currentInteraction: InteractionVM | null;
  home: HomeVM;
  person: PersonVM;
  recap: RecapVM;
  prepare: PrepareVM;
};

export type UploadReceipt = {
  uploadId: string;
  jobId: string;
  status: "uploaded" | "waiting";
  executionMode?: "inline" | "queue";
  queueJobId?: string;
  evaluationRetention?: boolean;
};

export type FailedUploadReceipt = {
  uploadId: string;
  jobId: string;
  status: "failed";
  error: string;
};

export type UploadState =
  | { status: "idle" }
  | { status: "uploading"; fileName: string; recordingDate: string }
  | {
      status: "processing";
      receipt?: UploadReceipt;
      failedReceipt?: FailedUploadReceipt;
      jobStatus?: "uploaded" | "waiting" | "processing" | "transcribing" | "extracting" | "ready" | "failed";
      progress?: number;
      statusMessage?: string;
    }
  | {
      status: "ready";
      receipt?: UploadReceipt;
      uploadId: string;
      cacheStatus: "saved";
      serverCleanupStatus: "pending" | "completed" | "not_completed";
      cleanupMessage?: string;
    }
  | {
      status: "failed";
      uploadId?: string;
      receipt?: UploadReceipt;
      failedReceipt?: FailedUploadReceipt;
      message: string;
      failureStage: "upload" | "read" | "processing" | "cache" | "relationship_import";
      serverDataRetained?: boolean;
    };

export type QaState =
  | { status: "idle" }
  | { status: "streaming"; question: string; committedText: string }
  | { status: "complete"; answer: QuestionAnswer }
  | { status: "failed"; question: string; message: string };

export function emptyDateCompanionViewModel(): DateCompanionViewModel {
  return {
    relationship: null,
    currentInteraction: null,
    home: {
      remembered: null,
      preparePreview: null,
      participantNotice: null
    },
    person: {
      remembered: [],
      recent: [],
      relationship: [],
      promises: [],
      interactions: [],
      observation: null,
      limitedToCurrentInteraction: true
    },
    recap: {
      interaction: null,
      items: [],
      participants: [],
      chapters: []
    },
    prepare: {
      headline: "见 Ta 之前，花半分钟想一想",
      recentConcern: null,
      lastTopic: null,
      promise: null,
      conversationStarter: null,
      items: [],
      openPromises: []
    }
  };
}

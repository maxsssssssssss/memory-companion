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
  /** Server-verified digest for this exact canonical Evidence source. */
  contentDigest?: string;
  kind: "transcript" | "brief" | "semantic" | "relationship" | "proactive";
  presentation: "direct_quote" | "derived_summary" | "suggestion";
  /** Only true when this browser has the complete DayPayload for uploadId. */
  canOpenTranscript?: boolean;
  /** Server-confirmed long-term subject for this exact retained source. */
  memorySubject?: DateCompanionMemorySubject;
};

export type DateCompanionMemorySubject = "self" | "companion" | "both" | "unknown";
export type DateCompanionMemoryBridgeStatus =
  | "waiting_for_cleanup"
  | "pending"
  | "processing"
  | "completed"
  | "retryable_failed"
  | "needs_review"
  | "cancelled";

export type DateCompanionRelationshipType = "dating" | "partner" | "friend" | "other";

export type DateCompanionConfirmedPerson = {
  id: string;
  displayName: string | null;
  status: "confirmed";
  version: number;
  explicitlyConfirmed: true;
  confirmedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type DateCompanionPersonMapping = {
  id: string;
  selfPersonId: string;
  companionPersonId: string;
  relationshipType: DateCompanionRelationshipType;
  status: "confirmed" | "needs_review" | "archived";
  version: number;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DateCompanionRetentionSetting = {
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  enabledAt: string | null;
  disabledAt: string | null;
};

export type DateCompanionSelfBinding = {
  personId: string | null;
  status: "active" | "cleared";
  version: number;
  setAt: string | null;
  clearedAt: string | null;
  updatedAt: string;
};

export type DateCompanionMemoryBridgeReview =
  | {
      kind: "relationship_reconfirmation_required";
      canReconfirm: true;
      reason: "relationship_was_archived";
      nextAction: "reconfirm_archived_relationship";
    }
  | {
      kind: "mapping_review_required";
      canReconfirm: false;
      reason: "person_mapping_changed";
      nextAction: "review_person_mapping";
    }
  | {
      kind: "evidence_review_required";
      canReconfirm: false;
      reason: "source_evidence_changed";
      nextAction: "review_source_evidence";
    };

export type DateCompanionRelationshipReconfirmationRequest = {
  action: "reconfirm_archived_relationship";
  idempotencyKey: string;
};

export type DateCompanionMemoryReviewInteraction = {
  interactionId: string;
  sourceUploadId: string;
  recordingDate: string;
  sourceState: "available" | "server_cleaned" | "explicitly_deleted";
  status: DateCompanionMemoryBridgeStatus | "not_queued";
  attemptCount: number;
  selectionCount: number;
  unknownCount: number;
  updatedAt: string | null;
  review?: DateCompanionMemoryBridgeReview;
};

export type DateCompanionMemoryReview = {
  retention: DateCompanionRetentionSetting;
  mapping: DateCompanionPersonMapping | null;
  interactions: DateCompanionMemoryReviewInteraction[];
};

export type DateCompanionRetainedSourceSubjects = Record<string, DateCompanionMemorySubject>;

export type DateCompanionMemoryBridgeState =
  | { status: "idle" | "loading" }
  | {
      status: "ready";
      people: DateCompanionConfirmedPerson[];
      selfBinding: DateCompanionSelfBinding | null;
      setting: DateCompanionRetentionSetting;
      mapping: DateCompanionPersonMapping | null;
      review: DateCompanionMemoryReview;
      retainedSubjects: DateCompanionRetainedSourceSubjects;
      /** Memory-only source keys; relationship-only sources require exact snapshot admission. */
      memoryRetainedSourceKeys: string[];
      /** Exact relationship-only sources admitted by the server-owned catalog. */
      relationshipPersonSources: DateCompanionRelationshipPersonSource[];
      /** Exact server-retained sources currently eligible for asking about Ta. */
      personQaSources: SourceRefVM[];
      notice?: string;
    }
  | { status: "error"; message: string };

export type DateCompanionMemoryMutationState =
  | { status: "idle" }
  | {
      status: "saving";
      operation: "create_person" | "mapping" | "retention" | "sync" | "purge";
      targetId?: string;
    }
  | {
      status: "error";
      operation: "create_person" | "mapping" | "retention" | "sync" | "purge";
      message: string;
      targetId?: string;
    };

export type DateCompanionParticipantRole = "self" | "companion" | "unresolved";

/**
 * Explicit, one-time opt-in collected while the user reviews a draft recap.
 * Only recording-local raw speaker ids cross this boundary; synthetic UI
 * grouping ids are deliberately excluded.
 */
export type DateCompanionVoiceEnrollmentIntent = {
  speakerIds: string[];
};

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
  memoryBridge?: {
    status: DateCompanionMemoryBridgeStatus;
    attemptCount: number;
    updatedAt: string;
    retryable: boolean;
    review?: DateCompanionMemoryBridgeReview;
  };
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
  memberSpeakerIds?: string[];
  audioSpeakerId?: string;
  voiceEnrollmentEligible?: true;
  displayLabel: string;
  alias?: string;
  state: "unresolved" | "confirmed";
  role: DateCompanionParticipantRole;
  roleSuggestion?: {
    role: Exclude<DateCompanionParticipantRole, "unresolved">;
    source: "previous_confirmation";
  };
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

export type ToyIngestionReceiptState =
  | "reserving"
  | "accepted"
  | "processing"
  | "completed"
  | "failed"
  | "deleted";

export type ToyIngestionReceipt = {
  receiptId: string;
  operationKey: string;
  destination: "date_companion";
  relationshipId: string;
  /** Legacy compatibility only; minimal recovery operations do not use generations. */
  generation?: number;
  uploadId: string;
  jobId: string;
  state: ToyIngestionReceiptState;
  decision: "accepted" | "replayed" | "already_uploaded";
  recordingDate: string;
  serverAcceptedAt?: string;
  processingAt?: string;
  completedAt?: string;
  failedAt?: string;
  sourceCleanedAt?: string;
  deletedAt?: string;
  reimportOfReceiptId?: string;
};

export type UploadReceipt = {
  uploadId: string;
  jobId: string;
  status: "uploaded" | "waiting";
  executionMode?: "inline" | "queue";
  queueJobId?: string;
  enqueueDeferred?: boolean;
  warning?: "pipeline_queue_unavailable";
  evaluationRetention?: boolean;
  ingestionReceipt?: ToyIngestionReceipt;
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
      cacheStatus: "saved" | "relationship_only";
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
import type { DateCompanionRelationshipPersonSource } from "./date-companion-person-source";

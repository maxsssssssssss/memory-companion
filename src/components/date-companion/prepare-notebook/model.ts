import type { PreparationItem, PreparationMessage, PreparationSource, PreparationView } from "@/lib/domain/date-companion-preparation";

export type { PreparationItem, PreparationMessage, PreparationSource, PreparationView };
export { preparationChoiceState, effectivePreparationInteractionIds, missingSuggestionTurn } from "@/lib/domain/date-companion-preparation";

/** A preview-only catalog enriches a source for the local facsimile reader. The
 * production PreparationSource has no reliable in-sentence time field. */
export interface PreviewRecord {
  id: string;
  title: string;
  date: string;
  fullTranscript: boolean;
  sources: PreparationSource[];
  segments: Array<{ id: string; speaker: string; text: string; time: string }>;
  /** Formal catalog qualification for the independent recap association. */
  reviewAvailable?: boolean;
  scopeAvailable?: boolean;
  sourceDetails?: Record<string, { presentation: "direct_quote" | "derived_summary" | "suggestion"; speakerLabel?: string; time?: string }>;
}
export interface PreviewClue {
  id: string;
  group: "recent" | "together" | "promise" | "continue";
  text: string;
  reason?: string;
  sources: PreparationSource[];
}
export type PreviewScenarioId = string;
export type ResponseMode = "normal" | "slow" | "failed" | "unknown" | "late" | "none" | "three" | "long";
export interface PreviewScenario {
  id: PreviewScenarioId;
  name: string;
  description: string;
  trigger: string;
  group: "阅读与选择" | "资料与身份" | "异步与恢复" | "历史与归属";
  response?: ResponseMode;
  failure?: "read" | "select" | "edit" | "conflict";
}
export interface PreviewOperation {
  key: string;
  discussionId: string;
  kind: "send" | "mutation" | "delete";
  status: "running" | "unknown" | "failed" | "succeeded" | "cancelled";
  input: string;
  dueAt?: number;
  responseMode?: ResponseMode;
  request?: PreviewSendInput;
  generation?: string;
  waitCancelled?: boolean;
  reconciled?: boolean;
  attempts: number;
  message?: string;
}
export interface PreviewDraft {
  input?: string;
  inputSelection?: [number, number];
  feedback?: boolean;
  editingId?: string | null;
  editText?: string;
  editSelection?: [number, number];
  leftScroll?: number;
  chatScroll?: number;
  windowScroll?: number;
  openSources?: string[];
  focusId?: string;
  mobileView?: "preparations" | "chat";
  selectedTab?: string;
  showEarlier?: boolean;
  sourceSheetId?: string | null;
  sourceRecordId?: string | null;
  sourceSheetScroll?: number;
  sourceReturn?: { id: string; editId?: string; selection?: [number, number]; scroll: number; left: number; chat: number };
  scope?: string[];
  allowRetained?: boolean;
}
export interface PreviewSnapshot {
  schema: 1;
  accountId: string;
  relationshipId: string;
  relationshipName: string;
  relationshipStatus: "established" | "unmapped" | "none" | "loading" | "unavailable";
  scenario: string;
  discussions: PreparationView[];
  availableSources: PreviewRecord[];
  clues: PreviewClue[];
  operations: Record<string, PreviewOperation>;
  drafts: Record<string, PreviewDraft>;
  deletedIds: string[];
  currentDiscussionId: string | null;
  loading: boolean;
  sourceRefresh?: "reading" | "error";
  sourceRefreshError?: string;
  error: string | null;
  loggedOut: boolean;
  failuresConsumed: string[];
  materialsStatus?: "loading" | "ready" | "empty" | "unmapped" | "error";
  materialsError?: string | null;
}
export interface PreviewSendInput {
  discussionId?: string | null;
  operationKey: string;
  text: string;
  kind?: PreparationMessage["kind"];
  expectedVersion?: number;
  interactionIds?: string[];
  allowRetained?: boolean;
  /** Fixture override, only used by the separate sample index / tests. */
  responseMode?: ResponseMode;
}
export interface PreviewMutation {
  operationKey: string;
  expectedVersion: number;
  kind: "select" | "edit" | "remove" | "scope" | "pause" | "link_review" | "unlink_review";
  itemId?: string;
  text?: string;
  interactionIds?: string[];
  interactionId?: string;
  allowRetained?: boolean;
}
export interface PreviewStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface PreviewAdapterOptions {
  scenario?: string;
  accountId?: string;
  relationshipId?: string;
  storage?: PreviewStorage | null;
  /** Tests can run timers quickly without changing service semantics. */
  latency?: number;
  now?: () => number;
}
export class PreviewError extends Error {
  constructor(public code: "read_failed" | "write_failed" | "reply_failed" | "unknown_result" | "conflict" | "unavailable" | "cancelled" | "invalid", message: string, public operationKey?: string) { super(message); this.name = "PreviewError"; }
}
export interface PreviewAdapter {
  readonly storageKey: string;
  getSnapshot(): PreviewSnapshot;
  subscribe(listener: () => void): () => void;
  load(): Promise<PreviewSnapshot>;
  getDiscussion(id: string): PreparationView | null;
  setCurrentDiscussion(id: string | null): void;
  /** Formal adapters re-read detail and transcript through authenticated paths. */
  openDiscussion?(id: string): Promise<PreparationView>;
  loadRecord?(source: PreparationSource): Promise<PreviewRecord | null>;
  /** Explicitly resume an unsaved edit after reviewing the fresh server text. */
  resumeEditingAfterReview?(discussionId: string, itemId: string): Promise<PreparationView>;
  send(input: PreviewSendInput): Promise<PreparationView>;
  mutate(id: string, input: PreviewMutation): Promise<PreparationView>;
  reconcile(operationKey: string): Promise<PreparationView | null>;
  retryOperation(operationKey: string, failedTurn?: { retryMessageId: string; expectedVersion: number }): Promise<PreparationView>;
  cancelWait(operationKey: string): void;
  removeDiscussion(id: string, input: { operationKey: string; expectedVersion: number }): Promise<void>;
  readDraft(id: string | null): PreviewDraft;
  writeDraft(id: string | null, patch: Partial<PreviewDraft>): void;
  clearDraft(id: string | null): void;
  logout(): void;
  dispose(): void;
}

import type { PreparationSource, PreparationView } from "@/lib/domain/date-companion-preparation";
import type { PreviewAdapter, PreviewClue, PreviewDraft, PreviewMutation, PreviewOperation, PreviewRecord, PreviewSendInput, PreviewSnapshot, PreviewStorage } from "@/components/date-companion/prepare-notebook/model";
import { PreviewError } from "@/components/date-companion/prepare-notebook/model";
import { preparationRequest, PreparationRequestError, type PreparationCatalog } from "./date-companion-preparation-api";

/** Only disposable UI state and requests whose outcome is unknown use this store.
 * Discussion, message, item and source data always come from authenticated APIs. */
export const FORMAL_NOTEBOOK_DRAFT_NAMESPACE = "daily-brief.prepare-notebook.formal-ui.v1";
export function clearFormalNotebookDraftsForAccount(accountId: string, storage?: Pick<Storage, "length" | "key" | "removeItem">) {
  try {
    const target = storage ?? (typeof window === "undefined" ? null : window.localStorage);
    if (!target) return;
    const prefix = `${FORMAL_NOTEBOOK_DRAFT_NAMESPACE}:${encodeURIComponent(accountId)}:`;
    const keys = Array.from({ length: target.length }, (_, index) => target.key(index)).filter((key): key is string => !!key && key.startsWith(prefix));
    keys.forEach(key => target.removeItem(key));
  } catch { /* Logging out must remain possible when browser storage is unavailable. */ }
}
export type FormalNotebookRecord = PreviewRecord & { reviewAvailable?: boolean };
export type FormalNotebookMaterials = { records?: FormalNotebookRecord[]; clues?: PreviewClue[];
  status?: PreviewSnapshot["materialsStatus"]; error?: string | null };
type Request = typeof preparationRequest;
type Receipt = { found: false } | { found: true; id: string; deleted: true } | { found: true; id: string; deleted: false; view: PreparationView };
type Pending = {
  key: string; path: string; method: "POST" | "PATCH" | "DELETE";
  body: Record<string, unknown>; discussionId: string | null;
  kind: PreviewOperation["kind"]; input: string; attempts: number;
  status: "running" | "unknown" | "cancelled"; reconciled?: boolean;
};
type LocalState = { schema: 1; drafts: Record<string, PreviewDraft>; editVersions: Record<string, number>; pending: Record<string, Pending> };
export interface FormalNotebookOptions {
  accountId: string;
  relationshipId: string;
  relationshipName: string;
  relationshipStatus: PreviewSnapshot["relationshipStatus"];
  initialDiscussionId?: string | null;
  /** Same-account, same-discussion reading point with all evidence stripped. */
  returningDiscussion?: PreparationView;
  storage?: PreviewStorage | null;
  request?: Request;
  pollInterval?: number;
  materials?: FormalNotebookMaterials;
  readRecord?: (source: PreparationSource) => Promise<PreviewRecord | null>;
  onUnauthorized?: () => void;
}
export interface FormalNotebookAdapter extends PreviewAdapter {
  openDiscussion(id: string): Promise<PreparationView>;
  updateMaterials(materials: FormalNotebookMaterials): void;
  loadRecord(source: PreparationSource): Promise<PreviewRecord | null>;
  updateContext(context: Pick<PreviewSnapshot, "relationshipName" | "relationshipStatus">): void;
  resumeEditingAfterReview(discussionId: string, itemId: string): Promise<PreparationView>;
  /** Exact pending operation details never leave the adapter or reach JSX. */
  hasPendingOperation(id: string | null): boolean;
}

function storageDefault(): PreviewStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
function segmentId(source: PreparationSource): string {
  try { return new URL(source.href, "http://local.invalid").searchParams.get("segment") || source.id; } catch { return source.id; }
}
function emptyLocal(): LocalState { return { schema: 1, drafts: {}, editVersions: {}, pending: {} }; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "暂时没有收到可确认的结果。"; }
function discussionReadError(error: unknown) {
  if (error instanceof PreviewError || (error instanceof PreparationRequestError && [401, 403, 404].includes(error.status ?? 0))) {
    return error.message;
  }
  return "暂时打不开这段讨论。";
}
function ownDraftKey(id: string | null) { return id ? `discussion:${id}` : "new-discussion"; }
function operation(pending: Pending): PreviewOperation {
  return { key: pending.key, discussionId: pending.discussionId ?? "", kind: pending.kind, status: pending.status,
    input: pending.input, attempts: pending.attempts, reconciled: pending.reconciled, waitCancelled: pending.status === "cancelled" };
}

export function createFormalNotebookAdapter(options: FormalNotebookOptions): FormalNotebookAdapter {
  let storageKey = `${FORMAL_NOTEBOOK_DRAFT_NAMESPACE}:${encodeURIComponent(options.accountId)}:${encodeURIComponent(options.relationshipId || "new-relationship")}`;
  let activeRelationshipId = options.relationshipId;
  const storage = options.storage === undefined ? storageDefault() : options.storage;
  const request = options.request ?? preparationRequest;
  let local = emptyLocal();
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) ?? "null") as LocalState | null;
    if (saved?.schema === 1 && saved.drafts && saved.pending && saved.editVersions) {
      local = { schema: 1, drafts: saved.drafts, editVersions: saved.editVersions, pending: {} };
      for (const [key, value] of Object.entries(saved.pending)) {
        if (value?.key === key && ["POST", "PATCH", "DELETE"].includes(value.method) && typeof value.path === "string"
          && /^\/(?:[^/?]+(?:\/turns)?)?$/.test(value.path || "/") && value.body?.operationKey === key) {
          local.pending[key] = { ...value, status: "unknown" };
        }
      }
    }
  } catch { /* An unreadable draft does not prevent reading server history. */ }
  let materials = options.materials ?? {};
  const returning = options.returningDiscussion;
  const resume = returning && returning.id === options.initialDiscussionId &&
    returning.relationshipId === options.relationshipId ? returning : undefined;
  let catalog: PreparationCatalog["availableSources"] = [];
  let state: PreviewSnapshot = {
    schema: 1, accountId: options.accountId, relationshipId: options.relationshipId, relationshipName: options.relationshipName,
    relationshipStatus: options.relationshipStatus, scenario: "formal", discussions: resume ? [resume] : [], availableSources: [], clues: [],
    operations: Object.fromEntries(Object.values(local.pending).map(p => [p.key, operation(p)])), drafts: local.drafts,
    deletedIds: [], currentDiscussionId: options.initialDiscussionId ?? null, loading: !resume,
    sourceRefresh: resume ? "reading" : undefined, error: null, loggedOut: false, failuresConsumed: []
  };
  const listeners = new Set<() => void>();
  const controllers = new Map<string, AbortController>();
  const flights = new Map<string, Promise<PreparationView | null>>();
  let disposed = false, loadedOnce = false, epoch = 0, readEpoch = 0, selectedEpoch = 0;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const persist = () => { try { storage?.setItem(storageKey, JSON.stringify(local)); } catch { /* Server saves remain authoritative. */ } };
  const publish = (patch: Partial<PreviewSnapshot> = {}) => {
    if (disposed) return;
    state = { ...state, ...patch, drafts: local.drafts };
    listeners.forEach(listener => listener());
  };
  const setOperation = (key: string, patch: Partial<PreviewOperation>) => {
    const prior = state.operations[key];
    if (prior) publish({ operations: { ...state.operations, [key]: { ...prior, ...patch } } });
  };
  const adoptCreatedRelationship = (view: PreparationView) => {
    if (activeRelationshipId || !view.relationshipId) return;
    activeRelationshipId = view.relationshipId;
    const priorKey = storageKey;
    storageKey = `${FORMAL_NOTEBOOK_DRAFT_NAMESPACE}:${encodeURIComponent(options.accountId)}:${encodeURIComponent(activeRelationshipId)}`;
    // A first send may establish the relationship. Move only temporary UI state;
    // the discussion itself is still read again from the formal API on remount.
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) ?? "null") as LocalState | null;
      if (saved?.schema === 1 && saved.drafts && saved.pending && saved.editVersions) {
        local = { schema: 1, drafts: { ...saved.drafts, ...local.drafts }, pending: { ...saved.pending, ...local.pending }, editVersions: { ...saved.editVersions, ...local.editVersions } };
      }
      persist(); storage?.removeItem(priorKey);
    } catch { persist(); }
  };
  const sourcesFor = () => {
    const all = new Map<string, PreparationSource>();
    const current = state.discussions.find(view => view.id === state.currentDiscussionId);
    const ordered = [...state.discussions.filter(view => view.id !== current?.id).reverse(), ...(current ? [current] : [])];
    // Eligibility belongs to the active discussion's grant. Another history row
    // using the same canonical source ID must not revive a withdrawn quote here.
    for (const view of ordered) for (const source of [...view.items.flatMap(i => i.sources), ...view.messages.flatMap(m => m.sources)]) all.set(source.id, source);
    return [...all.values()];
  };
  const rebuildMaterials = () => {
    const sources = sourcesFor();
    const records = new Map<string, FormalNotebookRecord>();
    for (const row of catalog) records.set(row.id, { id: row.id, title: row.title, date: row.recordingDate,
      reviewAvailable: row.reviewAvailable, scopeAvailable: true, fullTranscript: false, sources: [], segments: [] });
    for (const record of materials.records ?? []) records.set(record.id, { ...record,
      scopeAvailable: catalog.some(row => row.id === record.id), reviewAvailable: catalog.find(row => row.id === record.id)?.reviewAvailable ?? false,
      sources: [...record.sources], segments: [...record.segments] });
    for (const source of sources) {
      if (!source.interactionId || !source.valid) continue;
      const record = records.get(source.interactionId) ?? { id: source.interactionId, title: "已保存的相处记录", date: source.recordingDate,
        fullTranscript: false, scopeAvailable: false, reviewAvailable: false, sources: [], segments: [] };
      // The latest authenticated projection wins over material caches.
      record.sources = [...record.sources.filter(s => s.id !== source.id), source];
      if (!record.fullTranscript && source.quote) {
        const id = segmentId(source);
        record.segments = [...record.segments.filter(s => s.id !== id), { id, text: source.quote,
          speaker: source.speakerRole === "self" ? "我" : source.speakerRole === "companion" ? state.relationshipName : "说话人待核对", time: "" }];
      }
      records.set(record.id, record);
    }
    const invalid = new Set(sources.filter(source => !source.valid).map(source => source.id));
    for (const record of records.values()) {
      const removedSegments = new Set(record.sources.filter(s => invalid.has(s.id)).map(segmentId));
      record.sources = record.sources.filter(s => !invalid.has(s.id));
      if (removedSegments.size && record.fullTranscript) {
        // A reader already open while scope/identity changes must not keep the
        // previously loaded transcript in this discussion. Valid evidence still
        // remains readable as its saved fragments; full text can be re-authorized.
        record.fullTranscript = false;
        record.segments = record.sources.filter(s => s.valid && s.quote).map(s => ({ id: segmentId(s), text: s.quote,
          speaker: s.speakerRole === "self" ? "我" : s.speakerRole === "companion" ? state.relationshipName : "说话人待核对", time: "" }));
      } else if (!record.fullTranscript) record.segments = record.segments.filter(s => !removedSegments.has(s.id));
    }
    publish({ availableSources: [...records.values()], clues: materials.clues ?? [],
      materialsStatus: materials.status ?? (materials.clues?.length ? "ready" : "empty"), materialsError: materials.error ?? null });
  };
  const assertView = (view: PreparationView) => {
    if (activeRelationshipId && view.relationshipId !== activeRelationshipId) throw new PreviewError("unavailable", "这段讨论属于另一段关系，请从对应关系重新打开。");
    if (state.deletedIds.includes(view.id)) throw new PreviewError("unavailable", "这段讨论已经删除。");
  };
  const accept = (view: PreparationView) => {
    assertView(view);
    adoptCreatedRelationship(view);
    const prior = state.discussions.find(v => v.id === view.id);
    if (prior && prior.version > view.version) return prior;
    publish({ ...(state.sourceRefresh && state.currentDiscussionId === view.id ? { sourceRefresh: undefined, sourceRefreshError: undefined } : {}),
      discussions: [...state.discussions.filter(v => v.id !== view.id), view]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)) });
    rebuildMaterials(); schedulePoll(); return view;
  };
  const assertActive = () => {
    if (disposed || state.loggedOut) throw new PreviewError("unavailable", "登录状态已变化，请重新进入准备页。");
  };
  const clearAccount = () => {
    epoch++; readEpoch++; selectedEpoch++; clearTimeout(poll);
    controllers.forEach(controller => controller.abort()); controllers.clear();
    local = emptyLocal(); try { storage?.removeItem(storageKey); } catch { /* best effort */ }
    publish({ loggedOut: true, loading: false, discussions: [], availableSources: [], clues: [], operations: {}, currentDiscussionId: null });
  };
  const handleAuth = (error: unknown) => {
    if (error instanceof PreparationRequestError && error.status === 401) { clearAccount(); options.onUnauthorized?.(); }
  };
  const handleInaccessible = (error: unknown, id?: string | null) => {
    handleAuth(error);
    if (!(error instanceof PreparationRequestError) || ![403, 404].includes(error.status ?? 0)) return;
    publish({ discussions: id ? state.discussions.filter(view => view.id !== id) : [], error: errorMessage(error) });
    // Drop old full-text material projections as well as the inaccessible view.
    materials = { ...materials, records: [], clues: [] }; catalog = []; rebuildMaterials();
  };
  const forgetPending = (key: string) => { delete local.pending[key]; persist(); };
  const bindDiscussion = (pending: Pending, view: PreparationView, selection: number) => {
    if (pending.discussionId) return;
    pending.discussionId = view.id;
    const fresh = ownDraftKey(null), actual = ownDraftKey(view.id);
    if (selectedEpoch === selection && state.currentDiscussionId === null) {
      local.drafts = { ...local.drafts, [actual]: { ...local.drafts[fresh], ...local.drafts[actual] } };
      delete local.drafts[fresh];
      publish({ currentDiscussionId: view.id });
    }
    persist();
  };
  const markReadGeneration = (view: PreparationView) => {
    const owned = Object.values(state.operations).reverse().find(op => op.discussionId === view.id && op.kind === "send");
    if (owned) {
      if (!controllers.has(owned.key) && !local.pending[owned.key]) setOperation(owned.key, {
        status: view.generationStatus === "running" ? "running" : view.generationStatus === "failed" ? "failed" : "succeeded",
        message: view.generationMessage
      });
    } else if (view.generationStatus !== "idle") {
      const key = `server-generation:${view.id}`;
      publish({ operations: { ...state.operations, [key]: { key, discussionId: view.id, kind: "send", input: "", attempts: 0,
        status: view.generationStatus === "running" ? "running" : "failed", message: view.generationMessage, reconciled: true } } });
    }
  };
  function schedulePoll() {
    clearTimeout(poll);
    if (disposed || state.loggedOut || !state.discussions.some(v => v.generationStatus === "running")) return;
    poll = setTimeout(() => {
      const ids = state.discussions.filter(v => v.generationStatus === "running").map(v => v.id);
      const runEpoch = epoch;
      void Promise.allSettled(ids.map(async id => {
        try {
          const { view } = await request<{ view: PreparationView }>(`/${encodeURIComponent(id)}`);
          if (disposed || epoch !== runEpoch) return;
          accept(view); markReadGeneration(view);
        } catch (error) {
          if (!disposed && epoch === runEpoch) handleInaccessible(error, id);
          throw error;
        }
      })).then(results => {
        results.forEach(result => { if (result.status === "rejected") handleAuth(result.reason); });
        if (!disposed && epoch === runEpoch) schedulePoll();
      });
    }, options.pollInterval ?? 1500);
  }
  const deleteLocal = (id: string) => {
    delete local.drafts[ownDraftKey(id)]; delete local.editVersions[ownDraftKey(id)];
    for (const [key, pending] of Object.entries(local.pending)) if (pending.discussionId === id) delete local.pending[key];
    persist();
    publish({ discussions: state.discussions.filter(v => v.id !== id), deletedIds: [...new Set([...state.deletedIds, id])],
      currentDiscussionId: state.currentDiscussionId === id ? null : state.currentDiscussionId });
    rebuildMaterials();
  };
  const readReceipt = async (key: string): Promise<PreparationView | null> => {
    assertActive();
    const token = epoch, selection = selectedEpoch, pending = local.pending[key];
    if (!pending) {
      const op = state.operations[key];
      if (!op?.discussionId) return null;
      const { view } = await request<{ view: PreparationView }>(`/${encodeURIComponent(op.discussionId)}`);
      if (epoch !== token || disposed) return null;
      accept(view); markReadGeneration(view); return view;
    }
    let receipt: Receipt;
    try { receipt = await request<Receipt>(`?operationKey=${encodeURIComponent(key)}`); }
    catch (error) { handleAuth(error); throw error; }
    if (epoch !== token || disposed) return null;
    pending.reconciled = true;
    if (!receipt.found) {
      // A retry may now replay this exact request/key. It never invents a new key.
      pending.status = "unknown"; persist();
      setOperation(key, { status: "unknown", reconciled: true, message: "尚未查到这次操作的保存结果，可以用原请求重试。" }); return null;
    }
    if (receipt.deleted) {
      forgetPending(key); deleteLocal(receipt.id); setOperation(key, { discussionId: receipt.id, status: "succeeded", reconciled: true }); return null;
    }
    assertView(receipt.view); bindDiscussion(pending, receipt.view, selection); accept(receipt.view);
    const isEmptyCreateWindow = pending.kind === "send" && pending.path === "" && receipt.view.messages.length === 0;
    if (!isEmptyCreateWindow) forgetPending(key); else { pending.status = "unknown"; persist(); }
    setOperation(key, { discussionId: receipt.id, reconciled: true,
      status: isEmptyCreateWindow ? "unknown" : receipt.view.generationStatus === "running" && pending.kind === "send" ? "running"
        : receipt.view.generationStatus === "failed" && pending.kind === "send" ? "failed" : "succeeded",
      message: isEmptyCreateWindow ? "讨论已建立，第一句话的保存结果仍需核对。请用原请求继续。" : receipt.view.generationMessage });
    return receipt.view;
  };
  const execute = (pending: Pending): Promise<PreparationView | null> => {
    const existing = flights.get(pending.key); if (existing) return existing;
    assertActive();
    const runEpoch = epoch, selection = selectedEpoch, controller = new AbortController();
    controllers.set(pending.key, controller);
    pending.status = "running"; pending.attempts++; local.pending[pending.key] = pending; persist();
    publish({ error: null, operations: { ...state.operations, [pending.key]: operation(pending) } });
    const flight = (async () => {
      try {
        const result = await request<{ view?: PreparationView; deleted?: boolean }>(pending.path,
          { method: pending.method, body: JSON.stringify(pending.body), signal: controller.signal });
        if (disposed || epoch !== runEpoch) throw new PreviewError("cancelled", "页面上下文已变化。", pending.key);
        if (pending.kind === "delete" && result.deleted && pending.discussionId) {
          forgetPending(pending.key); deleteLocal(pending.discussionId); setOperation(pending.key, { status: "succeeded" }); return null;
        }
        if (!result.view) throw new PreparationRequestError("暂时没能读到完整结果。", 200, "response_unknown", true);
        assertView(result.view); bindDiscussion(pending, result.view, selection); accept(result.view); forgetPending(pending.key);
        setOperation(pending.key, { discussionId: result.view.id,
          status: pending.kind === "send" && result.view.generationStatus === "failed" ? "failed"
            : pending.kind === "send" && result.view.generationStatus === "running" ? "running" : "succeeded",
          message: result.view.generationMessage });
        if (pending.kind === "send" && result.view.generationStatus === "failed") {
          throw new PreviewError("reply_failed", result.view.generationMessage || "消息已保存，但本轮回复没有完成。可以重新读取，或继续说。", pending.key);
        }
        return result.view;
      } catch (error) {
        if (disposed || epoch !== runEpoch) throw new PreviewError("cancelled", "页面上下文已变化。", pending.key);
        handleInaccessible(error, pending.discussionId);
        if (error instanceof PreviewError) throw error;
        const cancelled = controller.signal.aborted;
        const known = error instanceof PreparationRequestError && !error.uncertain;
        if (known) forgetPending(pending.key);
        else { pending.status = cancelled ? "cancelled" : "unknown"; local.pending[pending.key] = pending; persist(); }
        setOperation(pending.key, { status: known ? "failed" : cancelled ? "cancelled" : "unknown", message: errorMessage(error) });
        throw new PreviewError(cancelled ? "cancelled" : error instanceof PreparationRequestError && error.versionConflict ? "conflict"
          : known ? "write_failed" : "unknown_result", errorMessage(error), pending.key);
      } finally { controllers.delete(pending.key); flights.delete(pending.key); }
    })();
    flights.set(pending.key, flight); return flight;
  };
  const pendingFor = (id: string | null) => Object.values(local.pending).find(p => p.discussionId === id);
  const signature = (body: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(body)
    .filter(([key]) => key !== "operationKey" && key !== "expectedVersion").sort(([a], [b]) => a.localeCompare(b))));
  const recoverMatching = async (id: string | null, kind: Pending["kind"], body: Record<string, unknown>): Promise<{ matched: false } | { matched: true; view: PreparationView | null }> => {
    const pending = pendingFor(id);
    if (!pending || pending.kind !== kind || signature(pending.body) !== signature(body)) return { matched: false };
    if (controllers.has(pending.key)) return { matched: true, view: await execute(pending) };
    const view = await readReceipt(pending.key);
    if (!local.pending[pending.key]) return { matched: true, view };
    // A new click expressing the same intent still replays the old receipt key.
    return { matched: true, view: await execute(pending) };
  };
  const ensureKnown = async (id: string | null, newKey: string) => {
    const pending = pendingFor(id);
    if (!pending || pending.key === newKey) return;
    if (controllers.has(pending.key)) throw new PreviewError("unavailable", "上一项操作仍在进行，请稍候。", pending.key);
    await readReceipt(pending.key);
    if (local.pending[pending.key]) throw new PreviewError("unknown_result", "上一项操作的结果尚未确定，请先重新读取或重试原操作。", pending.key);
  };

  const adapter: FormalNotebookAdapter = {
    get storageKey() { return storageKey; },
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async load() {
      assertActive(); const token = ++readEpoch, runEpoch = epoch;
      const resuming = Boolean(state.sourceRefresh && state.currentDiscussionId === resume?.id);
      let readingReceipts = false;
      publish({ loading: !resuming, sourceRefresh: resuming ? "reading" : undefined, sourceRefreshError: undefined, error: null });
      try {
        const next = await request<PreparationCatalog>();
        if (disposed || token !== readEpoch || runEpoch !== epoch) return state;
        if (activeRelationshipId && next.preparations.some(view => view.relationshipId !== activeRelationshipId)) {
          // The previous read point is no longer authorized in this session.
          publish({ discussions: [], availableSources: [], clues: [], sourceRefresh: undefined });
          throw new PreviewError("unavailable", "当前关系已变化，请从对应关系重新进入准备页。");
        }
        if (next.preparations[0]) adoptCreatedRelationship(next.preparations[0]);
        catalog = next.availableSources;
        const ids = new Set(next.preparations.map(v => v.id));
        for (const key of Object.keys(local.drafts)) if (key.startsWith("discussion:") && !ids.has(key.slice(11))) {
          delete local.drafts[key]; delete local.editVersions[key];
        }
        persist();
        const defaultDiscussion = !loadedOnce && selectedEpoch === 0 && options.initialDiscussionId === undefined && !pendingFor(null) ? next.preparations[0]?.id ?? null : null;
        const requested = state.currentDiscussionId;
        loadedOnce = true;
        const needsDetail = Boolean(requested && !ids.has(requested) && !state.deletedIds.includes(requested));
        // Editing an owned note can finish while the return read is in flight.
        // On equal versions the fresh access projection still wins (revoked
        // citations need not change a discussion's edit version).
        const discussions = next.preparations.map(view => {
          const saved = adapter.getDiscussion(view.id);
          return saved && saved.version > view.version ? saved : view;
        });
        publish({ discussions, loading: needsDetail, sourceRefresh: undefined,
          currentDiscussionId: requested && ids.has(requested) ? requested : defaultDiscussion });
        rebuildMaterials(); discussions.forEach(markReadGeneration); schedulePoll();
        if (requested && needsDetail) await adapter.openDiscussion(requested);
        // The saved key is queried before a caller can repeat an uncertain write.
        readingReceipts = true;
        for (const pending of Object.values(local.pending)) await readReceipt(pending.key);
        return state;
      } catch (error) {
        if (!disposed && token === readEpoch && runEpoch === epoch) {
          handleInaccessible(error);
          if (resuming && resume && adapter.getDiscussion(resume.id) && state.currentDiscussionId === resume.id && state.sourceRefresh) {
            publish({ loading: false, sourceRefresh: "error", sourceRefreshError: errorMessage(error) });
          } else publish({ loading: false, sourceRefresh: undefined, error: readingReceipts ? errorMessage(error) : discussionReadError(error) });
        }
        throw error;
      }
    },
    getDiscussion: id => state.discussions.find(view => view.id === id) ?? null,
    setCurrentDiscussion(id) { selectedEpoch++; publish({ currentDiscussionId: id, sourceRefresh: undefined, sourceRefreshError: undefined, error: null }); rebuildMaterials(); },
    async openDiscussion(id) {
      assertActive(); const selection = ++selectedEpoch, token = epoch;
      publish({ currentDiscussionId: id, loading: true, sourceRefresh: undefined, sourceRefreshError: undefined, error: null });
      try {
        const { view } = await request<{ view: PreparationView }>(`/${encodeURIComponent(id)}`);
        if (disposed || token !== epoch) throw new PreviewError("cancelled", "页面上下文已变化。");
        accept(view); markReadGeneration(view);
        if (selection === selectedEpoch) publish({ loading: false }); return view;
      } catch (error) { handleInaccessible(error, id); if (selection === selectedEpoch) publish({ loading: false, error: discussionReadError(error) }); throw error; }
    },
    updateMaterials(next) { materials = { ...materials, ...next }; rebuildMaterials(); },
    updateContext(context) { publish(context); rebuildMaterials(); },
    async resumeEditingAfterReview(id, itemId) {
      assertActive();
      const pending = pendingFor(id);
      if (pending) throw new PreviewError("unknown_result", "请先核对上一次操作的保存结果，再继续编辑。", pending.key);
      const before = adapter.readDraft(id), reviewed = adapter.getDiscussion(id)?.items.find(item => item.id === itemId);
      if (before.editingId !== itemId || !reviewed) throw new PreviewError("unavailable", "这条编辑已不在当前讨论中，请重新打开它。");
      const token = epoch;
      let view: PreparationView;
      try { ({ view } = await request<{ view: PreparationView }>(`/${encodeURIComponent(id)}`)); }
      catch (error) { handleInaccessible(error, id); throw error; }
      if (disposed || epoch !== token) throw new PreviewError("cancelled", "页面上下文已变化。");
      assertView(view); const latest = view.items.find(item => item.id === itemId);
      accept(view);
      if (!latest || latest.status === "removed" || latest.status === "suggested" && latest.sources.some(source => !source.valid)) {
        throw new PreviewError("unavailable", "这条准备已移除或不再可编辑，未保存的文字仍留在编辑草稿中。");
      }
      if (adapter.readDraft(id).editingId !== itemId) throw new PreviewError("cancelled", "你已切换编辑位置，原草稿没有更改。");
      if (latest.text !== reviewed.text) throw new PreviewError("conflict", "服务端文字刚有变化，已为你重新读取。请核对这份最新内容后再继续，草稿仍在。");
      local.editVersions[ownDraftKey(id)] = view.version; persist(); publish(); return view;
    },
    async loadRecord(source) {
      assertActive(); if (!source.valid || !source.href || !source.interactionId) return null;
      const token = epoch;
      const fromPastClues = materials.clues?.some(clue => clue.sources.some(item => item === source)) ?? false;
      const loaded = await options.readRecord?.(source);
      if (disposed || epoch !== token || !loaded || loaded.id !== source.interactionId) return null;
      if (fromPastClues && !materials.clues?.some(clue => clue.sources.some(item => item.valid && item.id === source.id && item.fingerprint === source.fingerprint && item.quote === source.quote))) return null;
      // Never revive a source invalidated while its full record was loading.
      const latest = sourcesFor().find(item => item.id === source.id);
      if (!fromPastClues && latest && (!latest.valid || latest.fingerprint !== source.fingerprint)) return null;
      materials = { ...materials, records: [...(materials.records ?? []).filter(record => record.id !== loaded.id), loaded] };
      rebuildMaterials(); return fromPastClues ? loaded : state.availableSources.find(record => record.id === loaded.id) ?? null;
    },
    hasPendingOperation: id => !!pendingFor(id),
    async send(input: PreviewSendInput) {
      assertActive();
      if (!input.text.trim() || input.text.trim().length > 6000) throw new PreviewError("invalid", "请填写 1—6000 字的内容。");
      const id = input.discussionId ?? null;
      const body = id ? { operationKey: input.operationKey, expectedVersion: input.expectedVersion ?? adapter.getDiscussion(id)?.version ?? 0, text: input.text.trim(), kind: input.kind ?? "message" }
        : { operationKey: input.operationKey, text: input.text.trim(), interactionIds: input.interactionIds ?? [], allowRetained: input.allowRetained ?? false };
      const recovered = await recoverMatching(id, "send", body);
      if (recovered.matched) {
        if (!recovered.view) throw new PreviewError("unavailable", "讨论已删除。");
        if (recovered.view.generationStatus === "failed") throw new PreviewError("reply_failed", recovered.view.generationMessage || "消息已保存，但本轮回复没有完成。请继续说。");
        return recovered.view;
      }
      await ensureKnown(id, input.operationKey);
      const result = await execute({ key: input.operationKey, path: id ? `/${encodeURIComponent(id)}/turns` : "", method: "POST", body,
        discussionId: id, kind: "send", input: input.text.trim(), status: "running", attempts: 0 });
      if (!result) throw new PreviewError("unavailable", "讨论已删除。"); return result;
    },
    async mutate(id: string, input: PreviewMutation) {
      assertActive();
      const recovered = await recoverMatching(id, "mutation", { ...input });
      if (recovered.matched) {
        if (!recovered.view) throw new PreviewError("unavailable", "讨论已删除。");
        if (input.kind === "edit") { delete local.editVersions[ownDraftKey(id)]; persist(); }
        return recovered.view;
      }
      await ensureKnown(id, input.operationKey);
      if (input.kind === "edit" && (!input.text?.trim() || input.text.trim().length > 500)) throw new PreviewError("invalid", "准备内容请保留在 1—500 字。");
      const editVersion = local.editVersions[ownDraftKey(id)];
      if (input.kind === "edit" && editVersion !== undefined && editVersion !== input.expectedVersion) throw new PreviewError("conflict", "编辑期间这段讨论已更新。草稿仍在，请先核对最新内容再修改。");
      const saved = local.pending[input.operationKey];
      const result = await execute(saved ?? { key: input.operationKey, path: `/${encodeURIComponent(id)}`, method: "PATCH",
        body: { ...input }, discussionId: id, kind: "mutation", input: input.text ?? "", status: "running", attempts: 0 });
      if (!result) throw new PreviewError("unavailable", "讨论已删除。");
      if (input.kind === "edit") { delete local.editVersions[ownDraftKey(id)]; persist(); } return result;
    },
    reconcile: readReceipt,
    async retryOperation(key, failedTurn) {
      assertActive();
      if (failedTurn) {
        const id = state.operations[key]?.discussionId;
        if (!id) throw new PreviewError("unavailable", "请重新打开这段讨论。");
        // The attempt version changes only when a fresh generation begins. Two
        // clicks on the same failed turn share its receipt, including across tabs.
        const operationKey = `retry:${failedTurn.retryMessageId}:${failedTurn.expectedVersion}`;
        await ensureKnown(id, operationKey);
        const result = await execute({ key: operationKey, path: `/${encodeURIComponent(id)}/turns`, method: "POST",
          body: { operationKey, ...failedTurn }, discussionId: id, kind: "send", input: "", status: "running", attempts: 0 });
        if (!result) throw new PreviewError("unavailable", "讨论已删除。");
        return result;
      }
      const result = await readReceipt(key), pending = local.pending[key];
      if (!pending) {
        if (!result) throw new PreviewError("unavailable", "这项操作已结束或讨论已删除。");
        if (result.generationStatus === "failed") throw new PreviewError("reply_failed", result.generationMessage || "消息已保存，本轮回复没有完成。请继续说，不会重复发送原消息。", key);
        return result;
      }
      const retried = await execute(pending); if (!retried) throw new PreviewError("unavailable", "讨论已删除。"); return retried;
    },
    cancelWait(key) {
      const pending = local.pending[key];
      if (pending) { pending.status = "cancelled"; persist(); }
      controllers.get(key)?.abort(); setOperation(key, { status: "cancelled", waitCancelled: true });
    },
    async removeDiscussion(id, input) {
      assertActive();
      const recovered = await recoverMatching(id, "delete", { ...input }); if (recovered.matched) return;
      await ensureKnown(id, input.operationKey);
      await execute(local.pending[input.operationKey] ?? { key: input.operationKey, path: `/${encodeURIComponent(id)}`, method: "DELETE",
        body: { ...input }, discussionId: id, kind: "delete", input: "", status: "running", attempts: 0 });
    },
    readDraft(id) { return local.drafts[ownDraftKey(id)] ?? {}; },
    writeDraft(id, patch) {
      if (disposed || state.loggedOut || id && state.deletedIds.includes(id)) return;
      const key = ownDraftKey(id), prior = local.drafts[key] ?? {};
      if (patch.editingId && patch.editingId !== prior.editingId && id) local.editVersions[key] = adapter.getDiscussion(id)?.version ?? 0;
      if (patch.editingId === null) delete local.editVersions[key];
      local.drafts = { ...local.drafts, [key]: { ...prior, ...patch } }; persist(); publish();
    },
    clearDraft(id) { delete local.drafts[ownDraftKey(id)]; delete local.editVersions[ownDraftKey(id)]; persist(); publish(); },
    logout: clearAccount,
    dispose() {
      if (disposed) return;
      disposed = true; epoch++; readEpoch++; selectedEpoch++; clearTimeout(poll);
      controllers.forEach(controller => controller.abort()); controllers.clear(); listeners.clear();
    }
  };
  return adapter;
}

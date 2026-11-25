import { effectivePreparationInteractionIds, preparationChoiceState, PreparationCreateSchema, PreparationDeleteSchema, PreparationMutationSchema, PreparationTurnSchema } from "@/lib/domain/date-companion-preparation";
import { createPreviewFixture, PREVIEW_NAMESPACE, previewScenarios } from "./fixtures";
import { PreviewError, type PreparationSource, type PreparationView, type PreviewAdapter, type PreviewAdapterOptions, type PreviewDraft, type PreviewMutation, type PreviewOperation, type PreviewSendInput, type PreviewSnapshot, type ResponseMode } from "../prepare-notebook/model";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (key: string) => { let h = 2166136261; for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// The same conservative finite command boundary used by preparation-agent.ts.
// This is deliberately not a natural-language model or a topic/name matcher.
function explicitWithdrawal(view: PreparationView, text: string) {
  const command = /(?:这条|那条|这项|那项|这个准备|之前(?:留下|选)(?:来|中)?的)[^。！？?\n]{0,36}(?:不再(?:保留|采用|用)|不打算用|不用了|不采用了|不留了|先不留|先放下|撤回)|(?:撤回|取消|不再采用|不再保留|不用)(?:之前|刚才|原来)?(?:选的|留下的)?(?:这条|那条|这项|那项)|^(?:撤回|取消选用)[：:]/u.test(text);
  if (!command || /[？?]|(?:要不要|考虑|也许|可能|如果|假如|是否|能不能)|(?:不(?:要|会|想|用)?|别)(?:撤回|取消)|(?:Ta|她|他)说/iu.test(text)) return;
  const current = view.items.filter(i => i.status !== "removed" && (i.meetingId ?? view.id) === (view.currentMeetingId ?? view.id));
  const named = current.filter(i => text.includes(i.text)); if (named.length === 1) return named[0];
  if (named.length || /[“「《:：]/u.test(text)) return;
  const last = [...view.messages].reverse().find(m => m.role === "assistant");
  const visible = current.filter(i => i.sourceMessageId === last?.id);
  const candidates = /(?:已(?:经)?|之前|原来|刚才)(?:选|留)/u.test(text) ? current.filter(i => i.status === "selected") : visible.length ? visible : current;
  return candidates.length === 1 ? candidates[0] : undefined;
}
function anotherEncounter(text: string) {
  return /^(?:(?:后来|之后|这几天|这周|昨天|今天|周末|我们|我和\s*Ta|跟\s*Ta|和\s*Ta)[，,\s]*){0,3}(?:又见(?:了一(?:次面?|面)|面了|过一(?:次|面))|(?:第二次|第三次|又一次)(?:见完面|见面结束|见了面))(?=$|[。，,！!\s]|是|时|之后)/u.test(text)
    && !/[？?]|(?:没有|还没|计划|打算|要不要)/u.test(text.split(/[。！!\n]/u, 1)[0]);
}

/** The prototype's only persistence boundary. It never calls fetch, production
 * repositories, the formal local cache, a model, or a consent endpoint. */
export function createPreviewAdapter(options: PreviewAdapterOptions = {}): PreviewAdapter {
  const scenario = previewScenarios.find(s => s.id === options.scenario) ?? previewScenarios[0];
  const accountId = options.accountId ?? "notebook-preview-account";
  const relationshipId = options.relationshipId ?? (scenario.id === "other-person" ? "notebook-relationship-b" : "notebook-relationship-a");
  const storageKey = `${PREVIEW_NAMESPACE}:${encodeURIComponent(accountId)}:${encodeURIComponent(relationshipId)}:${scenario.id}`;
  const accountKey = `${PREVIEW_NAMESPACE}:${encodeURIComponent(accountId)}`;
  const logoutKey = `${accountKey}:signed-out`;
  const indexKey = `${accountKey}:owned-keys`;
  const storage = options.storage === undefined ? (typeof window === "undefined" ? null : window.localStorage) : options.storage;
  const now = options.now ?? Date.now;
  const latency = options.latency ?? 520;
  const iso = () => new Date(now()).toISOString();
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let lifecycle = 0;
  let state = createPreviewFixture(scenario.id, accountId, relationshipId);
  let snapshot: PreviewSnapshot;

  const signedOut = () => storage?.getItem(logoutKey) === "true";
  function clearAccountContent(target: PreviewSnapshot) {
    target.loggedOut = true; target.drafts = {}; target.discussions = []; target.operations = {};
    target.availableSources = []; target.clues = []; target.currentDiscussionId = null;
  }

  function readStored() {
    const raw = storage?.getItem(storageKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as PreviewSnapshot;
      if (parsed.schema === 1 && parsed.accountId === accountId && parsed.relationshipId === relationshipId && parsed.scenario === scenario.id && Array.isArray(parsed.discussions)) state = parsed;
    } catch { /* A damaged demo cache does not touch or read official caches. */ }
    if (signedOut()) clearAccountContent(state);
  }
  function safeSource(view: PreparationView, ref: PreparationSource, linked = true): PreparationSource {
    const permitted = effectivePreparationInteractionIds(view).includes(ref.interactionId) || (view.allowRetained && state.relationshipStatus === "established");
    const found = state.availableSources.flatMap(r => r.sources).find(s => s.id === ref.id);
    return permitted && linked && found?.valid && found.fingerprint === ref.fingerprint ? clone(found) : { ...ref, valid: false, quote: "", href: "" };
  }
  function safe(view: PreparationView): PreparationView {
    const result = clone(view);
    const owners = new Map(result.messages.map(m => [m.id, m]));
    const linked = (linkId?: string) => !linkId || Boolean(view.reviewLink?.available && view.reviewLink.id === linkId);
    result.items = result.items.map(i => ({ ...i, sources: i.sources.map(s => safeSource(view, s, linked(owners.get(i.sourceMessageId)?.reviewLinkId))) }));
    result.messages = result.messages.map(m => {
      if (m.role === "user") return m;
      const sources = m.sources.map(s => safeSource(view, s, linked(m.reviewLinkId)));
      return { ...m, sources, text: sources.some(s => !s.valid) ? "这段回复用到的资料已不再使用。" : m.text };
    });
    const byMessage = new Map(result.messages.map(m => [m.id, m]));
    result.events = result.events.map(e => e.kind === "assistant_message" ? { ...e, text: byMessage.get(e.id)?.text ?? "" } : e);
    return result;
  }
  function emit(persist = true) {
    state.discussions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (signedOut()) clearAccountContent(state);
    if (persist && storage) {
      storage.setItem(storageKey, JSON.stringify({ ...state, loading: false, error: null }));
      let keys: string[] = []; try { keys = JSON.parse(storage.getItem(indexKey) ?? "[]") as string[]; } catch { /* only the demo key index */ }
      if (!Array.isArray(keys)) keys = [];
      if (!keys.includes(storageKey)) storage.setItem(indexKey, JSON.stringify([...keys, storageKey]));
    }
    snapshot = { ...clone(state), discussions: state.discussions.map(safe) };
    if (!disposed) listeners.forEach(listener => listener());
  }
  function live(id: string) {
    const found = state.discussions.find(v => v.id === id);
    if (!found || state.deletedIds.includes(id) || state.loggedOut) throw new PreviewError("unavailable", "这段讨论已不存在，请从聊过的重新选择。");
    return found;
  }
  function event(view: PreparationView, kind: string, text: string, data: Record<string, unknown> = {}) {
    const id = `event-${uid(`${view.id}:${view.events.length}:${now()}`)}`;
    view.events.push({ id, kind, text, data, createdAt: iso(), ordinal: view.events.length });
    view.updatedAt = iso();
    return id;
  }
  function requireVersion(view: PreparationView, expected?: number) {
    if (expected !== undefined && expected !== view.version) throw new PreviewError("conflict", "这段讨论在另一处有了更新。先重新读取，再继续刚才的修改。");
  }
  function consumeFailure(kind: string) {
    if (state.failuresConsumed.includes(kind)) return false;
    state.failuresConsumed.push(kind); return true;
  }
  function modeFor(input: PreviewSendInput): ResponseMode { return input.responseMode ?? scenario.response ?? "normal"; }
  function answer(view: PreparationView, op: PreviewOperation) {
    const request = op.request!;
    const text = request.text.trim().replace(/[。！!]+$/u, "");
    const last = [...view.messages].reverse().find(m => m.role === "assistant");
    const named = /^(?:留下|留下这条)[：:]\s*(.+)$/u.exec(text)?.[1];
    let reply = "可以把这句话留得轻一点，等见面时再顺着当下的感觉继续。";
    let suggestions: string[] = [];
    let sources: PreparationSource[] = [];
    const available = state.availableSources.flatMap(r => r.sources).filter(s => safeSource(view, s).valid);
    if (named || /^(?:这条留下|留下这条|把这条留下|把这条记下来)$/u.test(text)) {
      const candidates = safe(view).items.filter(i => i.status === "suggested" && (named ? i.text === named : i.sourceMessageId === last?.id) && i.sources.every(s => s.valid));
      if (candidates.length === 1) {
        const original = view.items.find(i => i.id === candidates[0].id)!; original.status = "selected"; event(view, "select", original.text, { itemId: original.id }); reply = "已经留下了。之后仍然可以改一改，或者放下这条准备。";
      } else reply = "你想留下哪一条？可以点那条旁边的“留下这条”。";
    } else if (/^(?:这次先不聊|先不聊了|暂时不继续|这次先到这里)$/u.test(text)) {
      view.status = "paused"; event(view, "paused", "先到这里"); reply = "好，先到这里。想继续时再回来就好。";
    } else if (/^(?:取消关联|不用这份复盘|不用这份记录)$/u.test(text)) {
      view.reviewLink = null; event(view, "review_unlinked", "取消关联"); reply = view.interactionIds.length || view.allowRetained ? "现在没有关联复盘。单独选用的资料仍可在“资料范围”里查看或取消。" : "现在没有关联复盘了，我们可以接着聊你自己的感受。";
    } else if (/^(?:这次|本次|现在|我)?(?:不(?:用|想用|要用)|别用|撤回)(?:以前的?|之前的?|旧的?|全部的?|所有的?)?(?:历史(?:资料|记录)?|资料|记录)/u.test(text)) {
      reply = "好，接下来就从你现在想说的事情开始。";
    } else if (view.events.some(e => e.kind === "remove" && e.data.reasonOperation === op.key)) {
      reply = "已经放下这条准备。它不再是这次选用的内容。";
    } else if (/^(?:不错|有道理|挺好|好的|嗯)$/u.test(text)) {
      reply = "可以先放在这里，想留下时再决定。你还想接着聊什么？";
    } else if (op.responseMode === "none" || /(?:只想聊|先聊聊|不(?:要|用)(?:给)?建议|不用建议)/u.test(text)) {
      reply = "可以先不安排做什么。你最想说的，是当时哪一刻的感觉？";
    } else {
      const count = op.responseMode === "three" || /三(?:条|个)|3(?:条|个)|比较|对比/u.test(text) ? 3 : /两(?:条|个)|二(?:条|个)|2(?:条|个)/u.test(text) ? 2 : 1;
      const feedback = request.kind === "feedback" || view.messages.at(-1)?.kind === "feedback";
      const photo = available.find(s => s.id === "source-photo");
      const quiet = available.find(s => s.id === "source-quiet");
      if (feedback || /安静|累|坐一会|坐坐/u.test(text)) {
        reply = feedback ? "" : "可以先问一个简单的问题，把决定留给当下。";
        suggestions = ["见面时先问，要不要一起找个地方坐坐。", "见面时问问，今天想慢慢走一会儿吗？", "先问问对方当下想怎么度过这段时间。"].slice(0, count);
        sources = quiet ? [quiet] : [];
      } else if (photo) {
        reply = "从之前确实聊过的细节接着问，不必把整个下午都安排好。";
        suggestions = state.relationshipName === "林舟" ? ["那只深一点的杯子，杯口的弧度试得怎么样了？", "下次一起看看不同温度烧出的试釉片。", "先问问最近有没有一块试片让你想多看一眼。"].slice(0, count) : ["那本蓝色小画册，做得怎么样了？", "上次挑的照片，有没有一张已经决定留下？", "那只海边飞过的鸟，后来放进小画册了吗？"].slice(0, count);
        sources = available.filter(s => ["source-photo", "source-bird"].includes(s.id));
      } else {
        reply = "没有过往资料也可以，从你刚才的表达开始就好。";
        suggestions = ["见面时先问问，今天想怎么度过这段时间？", "先说一件你最近想与对方分享的小事。", "聊到一半时，留一点空隙听听对方想说什么。"].slice(0, count);
      }
    }
    if(op.responseMode==='long') reply += '\n\n准备可以是一点提醒，不必是一张需要做完的清单。比如见面时，先听听对方今天想说什么，再决定要不要提起之前的话题。如果那天没有合适的空隙，也可以暂时放下。\n\n你已经留下的两件小事仍然在那里，这次的讨论不会把它们自动换掉。下面的建议也还只是候选，只有你明确选择以后，才会成为左页的准备。修改文字本身不会替你作出选择。\n\n如果你想继续聊，可以从刚才那句话里最在意的部分说起；如果现在已经够了，也可以先停在这里。不必为了留下更多准备，把本来轻松的一次见面安排得很满。';
    const messageId = `reply-${uid(op.key)}`;
    view.messages.push({ id: messageId, role: "assistant", text: reply, kind: "message", createdAt: iso(), meetingId: view.currentMeetingId, origin: "assistant", sources: clone(sources), ...(view.reviewLink?.available ? { reviewLinkId: view.reviewLink.id } : {}) });
    suggestions.forEach((text, index) => view.items.push({ id: `option-${uid(op.key)}-${index}`, sourceMessageId: messageId, meetingId: view.currentMeetingId, text, status: "suggested", createdAt: iso(), sources: clone(sources) }));
    const messageEvent = { id: messageId, kind: "assistant_message", text: reply, createdAt: iso(), ordinal: view.events.length, data: { contextChecked: true } };
    view.events.push(messageEvent); view.version++; view.updatedAt = iso(); view.generationStatus = "idle"; delete view.generationMessage;
    op.status = "succeeded"; op.message = "已恢复本轮结果";
  }
  function settle(key: string) {
    // Re-read before a delayed commit so deletion/logout/another adapter wins.
    readStored();
    if (state.loggedOut) { emit(false); return; }
    const op = state.operations[key];
    if (!op || !["running", "unknown"].includes(op.status)) return;
    const view = state.discussions.find(v => v.id === op.discussionId);
    if (!view || state.deletedIds.includes(op.discussionId) || state.loggedOut) { op.status = "cancelled"; emit(); return; }
    const newer = Object.values(state.operations).some(other => other.discussionId === op.discussionId && other.kind === "send" && other.key !== op.key && other.generation && Number(other.generation) > Number(op.generation));
    if (newer) { op.status = "cancelled"; emit(); return; }
    if (op.responseMode === "failed" && consumeFailure("reply")) {
      op.status = "failed"; op.message = "刚才的话已经留下，这次回复没能完成。先重新读取，再继续或重试。";
      view.generationStatus = "failed"; view.generationMessage = op.message; view.version++; view.updatedAt = iso();
    } else answer(view, op);
    emit();
  }
  function schedule(op: PreviewOperation) {
    if (timers.has(op.key) || !["running", "unknown"].includes(op.status)) return;
    const timer = setTimeout(() => { timers.delete(op.key); settle(op.key); }, Math.max(0, (op.dueAt ?? now()) - now()));
    timers.set(op.key, timer);
  }
  function recover() { for (const op of Object.values(state.operations)) if (["running", "unknown"].includes(op.status)) { if ((op.dueAt ?? 0) <= now()) settle(op.key); else schedule(op); } }
  function duration(mode: ResponseMode) { return options.latency !== undefined ? latency * (mode === "slow" || mode === "late" ? 4 : mode === "unknown" ? 3 : 2) : mode === "slow" || mode === "late" ? 8000 : mode === "unknown" ? 2600 : 1150; }
  async function awaitOperation(key: string): Promise<PreparationView> {
    while (true) {
      const op = state.operations[key];
      if (!op || op.status === "cancelled" || op.waitCancelled || disposed) throw new PreviewError("cancelled", "已停止等待。发出的消息仍在讨论中，可重新读取结果。", key);
      if (op.status === "succeeded") return safe(live(op.discussionId));
      if (op.status === "failed") throw new PreviewError("reply_failed", op.message ?? "回复暂时没有完成。", key);
      if (op.status === "unknown") throw new PreviewError("unknown_result", "消息已接收，但结果尚未确认。请先重新读取，不要重复发送。", key);
      await wait(Math.max(1, Math.min(latency, 80)));
    }
  }
  // Constructing a React state value must not start timers: StrictMode may
  // discard that instance without ever running its effect cleanup.
  readStored(); emit(false);

  const adapter: PreviewAdapter = {
    storageKey,
    getSnapshot: () => snapshot,
    subscribe(listener) { disposed = false; listeners.add(listener); return () => listeners.delete(listener); },
    async load() {
      disposed = false;
      const session = lifecycle;
      state.loading = true; state.error = null; emit(false); await wait(latency);
      if (disposed || session !== lifecycle) return snapshot;
      readStored();
      if (scenario.failure === "read" && consumeFailure("read")) { state.loading = false; state.error = "这本手帐暂时没能读取。已经留下的内容还在，可以再读一次。"; emit(); throw new PreviewError("read_failed", state.error); }
      state.loading = false; state.error = null; recover(); emit(); return snapshot;
    },
    getDiscussion(id) { const view = state.discussions.find(v => v.id === id); return view ? safe(view) : null; },
    setCurrentDiscussion(id) { if (id) live(id); state.currentDiscussionId = id; emit(); },
    async send(input) {
      if (state.loggedOut) throw new PreviewError("unavailable", "已退出这个样稿账号。");
      readStored();
      if (signedOut() || state.loggedOut) throw new PreviewError("unavailable", "已退出这个样稿账号。");
      const existing = state.operations[input.operationKey];
      if (existing) {
        if (existing.input !== input.text || existing.kind !== "send" || (input.discussionId && input.discussionId !== existing.discussionId)) throw new PreviewError("invalid", "同一操作不能用于另一句话或另一段讨论。");
        if (existing.status === "succeeded") return safe(live(existing.discussionId));
        if (existing.status === "unknown" || existing.status === "running") throw new PreviewError("unknown_result", "这句话已经接收，请先重新读取结果。", existing.key);
        if (existing.status === "cancelled") throw new PreviewError("cancelled", "这轮回复已经结束，请继续新的表达。", existing.key);
        if (!existing.reconciled) throw new PreviewError("unknown_result", "先重新读取，确认这轮回复确实没有完成，再重试。", existing.key);
        // Retry the same persisted operation. Never append its user message twice.
        const view = live(existing.discussionId); existing.status = "running"; existing.waitCancelled = false; existing.attempts++; existing.dueAt = now() + duration("normal"); existing.responseMode = "normal"; view.generationStatus = "running"; view.generationMessage = undefined; view.version++; emit(); schedule(existing); return awaitOperation(existing.key);
      }
      const parsed = input.discussionId ? PreparationTurnSchema.parse({ operationKey: input.operationKey, expectedVersion: input.expectedVersion ?? live(input.discussionId).version, text: input.text, kind: input.kind ?? "message" }) : PreparationCreateSchema.parse({ operationKey: input.operationKey, text: input.text, interactionIds: input.interactionIds ?? [], allowRetained: input.allowRetained ?? false });
      let view: PreparationView;
      if (input.discussionId) { view = live(input.discussionId); requireVersion(view, input.expectedVersion); }
      else {
        const id = `discussion-${uid(input.operationKey)}`;
        view = { id, relationshipId, version: 0, title: parsed.text.slice(0, 45), currentMeetingId: `meeting-${uid(input.operationKey)}`, status: "active", interactionIds: input.interactionIds ?? [], allowRetained: input.allowRetained ?? false, reviewLink: null, messages: [], items: [], events: [], createdAt: iso(), updatedAt: iso(), generationStatus: "idle", intent: parsed.text, date: null, constraints: [] };
        state.discussions.unshift(view); state.currentDiscussionId = id;
      }
      for (const previous of Object.values(state.operations)) if (previous.discussionId === view.id && ["running", "unknown"].includes(previous.status)) previous.status = "cancelled";
      const kind = input.kind ?? (/^(?:不是|不对|纠正|我说错|其实|我改主意了)/u.test(input.text) ? "correction" : anotherEncounter(input.text) || /回来记一下|见完面|没用上/u.test(input.text) ? "feedback" : "message");
      const withdrawn = explicitWithdrawal(view, input.text);
      if (withdrawn) { const previousStatus = withdrawn.status; withdrawn.status = "removed"; event(view, "remove", withdrawn.text, { itemId: withdrawn.id, previousStatus, reasonOperation: input.operationKey }); }
      if (/^(?:这次|本次|现在|我)?(?:不(?:用|想用|要用)|别用|撤回)(?:以前的?|之前的?|旧的?|全部的?|所有的?)?(?:历史(?:资料|记录)?|资料|记录)/u.test(input.text.trim())) {
        view.interactionIds = []; view.allowRetained = false; if (view.reviewLink) event(view, "review_unlinked", "已解除本次复盘关联", { ...view.reviewLink }); view.reviewLink = null; event(view, "scope_changed", "用户明确撤回本次历史资料");
      }
      const previousBoundary = [...view.events].reverse().find(e => e.kind === "feedback_boundary");
      if (anotherEncounter(input.text) || (kind === "feedback" && !view.reviewLink && !previousBoundary)) {
        const originalMeetingId = view.currentMeetingId; view.currentMeetingId = `meeting-${uid(`${input.operationKey}:feedback`)}`; view.date = null; view.constraints = [];
        event(view, "feedback_boundary", "本次反馈对应新的见面背景", { originalMeetingId, nextMeetingId: view.currentMeetingId });
      }
      if (kind === "correction" && !withdrawn) for (const option of view.items) if (option.status === "suggested") option.status = "removed";
      view.status = "active"; view.messages.push({ id: `user-${uid(input.operationKey)}`, role: "user", text: parsed.text, kind, origin: "user_reflection", sources: [], createdAt: iso(), meetingId: view.currentMeetingId });
      event(view, kind, parsed.text); view.version++; view.generationStatus = "running"; view.intent = parsed.text;
      const mode = modeFor(input);
      const op: PreviewOperation = { key: input.operationKey, discussionId: view.id, kind: "send", status: mode === "unknown" ? "unknown" : "running", input: input.text, request: { ...input, kind }, dueAt: now() + duration(mode), responseMode: mode, generation: String(now() * 1000 + Object.keys(state.operations).length), attempts: 1 };
      state.operations[op.key] = op;
      const draftKey = input.discussionId ?? "new"; const draft = state.drafts[draftKey]; if (draft) state.drafts[view.id] = { ...draft, input: "", inputSelection: [0, 0], feedback: false }; if (!input.discussionId) delete state.drafts.new;
      emit(); schedule(op); return awaitOperation(op.key);
    },
    async mutate(id, raw) {
      const input = PreparationMutationSchema.parse(raw); await wait(latency); readStored(); const view = live(id);
      const previous = state.operations[input.operationKey];
      if (previous?.status === "succeeded") {
        const prior = JSON.parse(previous.input || "{}") as PreviewMutation;
        // A retry may reread the latest version, but cannot reuse a receipt for
        // another decision, object, grant, or wording.
        const { expectedVersion: _previousVersion, ...priorDecision } = prior;
        const { expectedVersion: _currentVersion, ...currentDecision } = input;
        if (previous.kind !== "mutation" || previous.discussionId !== id || JSON.stringify(priorDecision) !== JSON.stringify(currentDecision)) throw new PreviewError("invalid", "这个操作已经用于另一项修改，请重新确认本次决定。");
        return safe(view);
      }
      requireVersion(view, input.expectedVersion);
      if (scenario.failure === "conflict" && consumeFailure("conflict")) { view.version++; emit(); throw new PreviewError("conflict", "这段讨论在另一处有了更新。先重新读取，再继续刚才的修改。", input.operationKey); }
      if (scenario.failure === input.kind && consumeFailure(input.kind)) { emit(); throw new PreviewError("write_failed", input.kind === "select" ? "还没能留下这条，刚才的文字没有丢。可以再试一次。" : "修改暂时没能保存，编辑中的文字仍在。可以再试一次。", input.operationKey); }
      if (["select", "edit", "remove"].includes(input.kind)) {
        const target = view.items.find(i => i.id === input.itemId && i.status !== "removed");
        if (!target) throw new PreviewError("unavailable", "这条准备已放下，当前不提供恢复操作。");
        const previousStatus = target.status;
        if (input.kind === "select") { if (safe(view).items.find(i => i.id === target.id)?.sources.some(s => !s.valid)) throw new PreviewError("unavailable", "建议的资料已撤回，请重新讨论后再留下。"); target.status = "selected"; }
        if (input.kind === "edit") { if (!input.text) throw new PreviewError("invalid", "请写下要保留的文字。"); target.text = input.text; }
        if (input.kind === "remove") target.status = "removed";
        event(view, input.kind, target.text, { itemId: target.id, previousStatus, meetingId: target.meetingId });
      } else if (input.kind === "scope") {
        const allowed = new Set(state.availableSources.map(r => r.id));
        if (input.interactionIds?.some(sourceId => !allowed.has(sourceId))) throw new PreviewError("unavailable", "选中的记录当前不可用。");
        view.interactionIds = input.interactionIds ?? []; view.allowRetained = Boolean(input.allowRetained) && state.relationshipStatus === "established"; event(view, "scope_changed", "更新本次资料范围");
      } else if (input.kind === "link_review") {
        const record = state.availableSources.find(r => r.id === input.interactionId); if (!record) throw new PreviewError("unavailable", "这份复盘当前不可用。");
        if (view.reviewLink && view.reviewLink.interactionId !== record.id) throw new PreviewError("conflict", "这段讨论已关联另一场复盘，请先取消原关联。");
        const previousLink = [...view.events].reverse().find(e => e.kind === "review_unlinked" && e.data.interactionId === record.id);
        const boundary = [...view.events].reverse().find(e => e.kind === "feedback_boundary");
        const current = view.currentMeetingId ?? view.id;
        if (previousLink?.data.nextMeetingId && previousLink.data.nextMeetingId !== current) throw new PreviewError("conflict", "这场复盘属于更早的见面背景，请核对后再关联。");
        const originalMeetingId = (previousLink?.data.originalMeetingId ?? (boundary?.data.nextMeetingId === current ? boundary.data.originalMeetingId : current)) as string;
        const existing = view.reviewLink?.interactionId === record.id ? view.reviewLink : null;
        view.reviewLink = existing ?? { id: `review-${uid(input.operationKey)}`, interactionId: record.id, recordingDate: record.date, linkedAt: iso(), available: true, originalMeetingId, nextMeetingId: originalMeetingId === current ? `meeting-${uid(input.operationKey)}` : current, originalItemIds: view.items.filter(i => i.status === "selected" && (i.meetingId ?? view.id) === originalMeetingId).map(i => i.id) };
        view.currentMeetingId = view.reviewLink.nextMeetingId; view.date = null; view.constraints = []; event(view, "review_linked", "关联复盘", { interactionId: record.id, originalMeetingId, nextMeetingId: view.currentMeetingId });
      } else if (input.kind === "unlink_review") { const link = view.reviewLink; view.reviewLink = null; event(view, "review_unlinked", "取消关联", link ? { ...link } : {}); }
      else if (input.kind === "pause") { view.status = "paused"; event(view, "paused", "先到这里"); }
      // Formal mutations terminate an in-flight generation; a stale reply must
      // not restore an old scope, old choice or paused discussion.
      for (const op of Object.values(state.operations)) if (op.discussionId === id && ["running", "unknown"].includes(op.status)) op.status = "cancelled";
      view.generationStatus = "idle"; delete view.generationMessage;
      view.version++; view.updatedAt = iso(); state.operations[input.operationKey] = { key: input.operationKey, discussionId: id, kind: "mutation", status: "succeeded", input: JSON.stringify(input), attempts: 1 }; emit(); return safe(view);
    },
    async reconcile(operationKey) {
      await wait(latency); readStored(); const op = state.operations[operationKey]; if (!op || state.deletedIds.includes(op.discussionId)) return null;
      if (["running", "unknown"].includes(op.status) && (op.dueAt ?? 0) <= now()) settle(operationKey); else if (["running", "unknown"].includes(op.status)) schedule(op);
      const current = state.operations[operationKey]; if (current?.status === "failed") current.reconciled = true;
      emit(); return adapter.getDiscussion(op.discussionId);
    },
    async retryOperation(operationKey) {
      const op = state.operations[operationKey];
      if (!op?.request || op.status !== "failed" || !op.reconciled) throw new PreviewError("unknown_result", "请先重新读取这轮结果；只有确认失败的回复才能重试。", operationKey);
      return adapter.send(op.request);
    },
    cancelWait(operationKey) { const op = state.operations[operationKey]; if (!op || !["running", "unknown"].includes(op.status)) return; op.waitCancelled = true; op.message = "已停止等待；消息没有撤回，可以重新读取结果。"; emit(); },
    async removeDiscussion(id, raw) {
      const input = PreparationDeleteSchema.parse(raw); await wait(latency); readStored();
      if (state.deletedIds.includes(id)) return; const view = live(id); requireVersion(view, input.expectedVersion);
      state.deletedIds.push(id); state.discussions = state.discussions.filter(v => v.id !== id); delete state.drafts[id];
      for (const op of Object.values(state.operations)) if (op.discussionId === id) { op.status = "cancelled"; op.input = ""; delete op.request; }
      if (state.currentDiscussionId === id) state.currentDiscussionId = state.discussions[0]?.id ?? null;
      state.operations[input.operationKey] = { key: input.operationKey, discussionId: id, kind: "delete", status: "succeeded", input: "", attempts: 1 }; emit();
    },
    readDraft(id) { if (signedOut() || state.loggedOut || (id && state.deletedIds.includes(id))) return {}; return clone(state.drafts[id ?? "new"] ?? {}); },
    writeDraft(id, patch) { if (signedOut() || state.loggedOut || (id && (state.deletedIds.includes(id) || !state.discussions.some(v => v.id === id)))) return; const key = id ?? "new"; state.drafts[key] = { ...state.drafts[key], ...clone(patch) }; emit(); },
    clearDraft(id) { delete state.drafts[id ?? "new"]; emit(); },
    logout() {
      timers.forEach(clearTimeout); timers.clear(); storage?.setItem(logoutKey, "true");
      // The account owns its preview drafts across fixtures and relationships.
      // Do not clear localStorage wholesale or inspect another product's cache.
      let keys: string[] = []; try { keys = JSON.parse(storage?.getItem(indexKey) ?? "[]") as string[]; } catch { /* corrupted demo index */ }
      if (Array.isArray(keys)) for (const key of keys) if (typeof key === "string" && key.startsWith(`${accountKey}:`)) {
        try { const stored = JSON.parse(storage?.getItem(key) ?? "null") as PreviewSnapshot | null; if (stored?.schema === 1 && stored.accountId === accountId) { clearAccountContent(stored); storage?.setItem(key, JSON.stringify(stored)); } } catch { /* do not touch unrecognized contents */ }
      }
      clearAccountContent(state); emit();
    },
    dispose() { disposed = true; lifecycle++; timers.forEach(clearTimeout); timers.clear(); listeners.clear(); },
  };
  return adapter;
}

export function visiblePreviewItems(view: PreparationView) {
  return view.items.filter(item => preparationChoiceState(view, item) || (item.status === "suggested" && item.sources.every(source => source.valid)));
}

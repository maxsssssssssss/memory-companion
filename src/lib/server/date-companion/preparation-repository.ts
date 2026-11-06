import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PreparationView, PreparationSource, PreparationReviewLink } from "@/lib/domain/date-companion-preparation";
import { DcConflictError, DcNotFoundError, DcVersionConflictError, DcValidationError } from "./errors";
import { PreparationSources } from "./preparation-sources";
type State = PreparationView & {
  pendingReviewMeetingId?: string;
  dateContextChecked?: boolean;
  constraintsContextChecked?: boolean;
  dateReviewId?: string;
  constraintReviewId?: string;
  generationId?: string;
  taskId?: string;
  planningAfterFeedback?: string;
  dateSources?: Array<{id: string; fingerprint: string}>;
  constraintSources?: Array<{id: string; fingerprint: string}>;
};
type Receipt = {
  id: string;
  generationId?: string;
  version?: number;
  taskId?: string;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
/** The preparation owns conversation and decisions, never Promise, Person or Memory. */
export class PreparationRepository {
  private readonly sources: PreparationSources;
  constructor(readonly database: Database.Database) {
    this.sources = new PreparationSources(database);
  }
  private state(accountId: string, id: string): State {
    const row = this.database.prepare("SELECT body_json FROM dc_preparations WHERE id=? AND user_id=? AND deleted=0").get(id, accountId) as {
      body_json: string;
    } | undefined;
    if (!row)
      throw new DcNotFoundError("Preparation not found");
    const state: State = JSON.parse(row.body_json);
    // Older writers may have appended a message or item to an already upgraded JSON body.
    // Fill only absent ownership fields. An observed event is never an implied review grant.
    if (!state.currentMeetingId || state.messages.some(m => !m.meetingId) || state.items.some(i => !i.meetingId)) {
      const byId = new Map(state.messages.map(message => [message.id, message]));
      let inferred = state.id;
      let pending: string | undefined;
      for (const event of state.events) {
        if (event.kind === "review_linked" && typeof event.data.nextMeetingId === "string") inferred = event.data.nextMeetingId;
        const message = byId.get(event.id);
        if (!message) continue;
        const attributed = message.meetingId ?? (typeof event.data.meetingId === "string" ? event.data.meetingId : undefined);
        if (attributed) {
          if (!state.currentMeetingId && message.kind === "feedback" && attributed !== inferred) pending = inferred;
          inferred = attributed;
        }
        else if (message.kind === "feedback" && !state.currentMeetingId) {
          pending = inferred;
          inferred = message.id;
        }
        message.meetingId ??= inferred;
      }
      for (const message of state.messages) message.meetingId ??= state.currentMeetingId ?? inferred;
      for (const item of state.items) item.meetingId ??= byId.get(item.sourceMessageId)?.meetingId ?? state.id;
      if (!state.currentMeetingId) {
        state.currentMeetingId = inferred;
        state.pendingReviewMeetingId ??= pending;
      }
    }
    state.reviewLink ??= null;
    return state;
  }
  get(accountId: string, id: string): PreparationView {
    const { generationId: _generation, taskId: _task, planningAfterFeedback: _planning,
      pendingReviewMeetingId: _pending, dateContextChecked: _dateChecked, constraintsContextChecked: _constraintsChecked,
      dateReviewId: _dateReview, constraintReviewId: _constraintReview,
      dateSources: _dateSources, constraintSources: _constraintSources, ...view } = this.state(accountId, id);
    if (view.reviewLink) {
      const link = view.reviewLink;
      const current = this.reviewAvailable(accountId, view.relationshipId, link.interactionId);
      view.reviewLink = { ...link, available: current !== null };
      if (!current && _dateReview === link.id) view.date = null;
      if (!current && _constraintReview === link.id) view.constraints = [];
    }
    const feedback = [...view.messages].reverse().find(m => m.kind === "feedback");
    if (!feedback || _planning === feedback.id) return view;
    // A legacy date after feedback has no meeting attribution. Show the full
    // conversation and choices without promoting old metadata to a new plan.
    const since = view.messages.slice(view.messages.indexOf(feedback));
    return { ...view, intent: [...since].reverse().find(m => m.kind === "correction")?.text ?? feedback.text, date: null, constraints: [] };
  }
  private reviewAvailable(accountId: string, relationshipId: string, interactionId: string) {
    try {
      return this.sources.reviewSources(accountId, relationshipId, interactionId)[0]?.recordingDate ?? null;
    } catch (error) {
      if (error instanceof DcNotFoundError) return null;
      throw error;
    }
  }
  private unlinkReview(state: State) {
    const link = state.reviewLink;
    if (!link) return;
    this.event(state, "review_unlinked", "已解除本次复盘关联。", {
      reviewLinkId: link.id, interactionId: link.interactionId,
      originalMeetingId: link.originalMeetingId, nextMeetingId: link.nextMeetingId,
      originalItemIds: [...link.originalItemIds],
    });
    state.reviewLink = null;
    if (state.dateReviewId === link.id) {
      state.date = null;
      delete state.dateReviewId;
      delete state.dateSources;
    }
    if (state.constraintReviewId === link.id) {
      state.constraints = [];
      delete state.constraintReviewId;
      delete state.constraintSources;
    }
  }
  private linkReview(accountId: string, state: State, interactionId: string | undefined) {
    if (!interactionId) throw new DcValidationError("preparation_review_required");
    const recordingDate = this.reviewAvailable(accountId, state.relationshipId, interactionId);
    if (!recordingDate) throw new DcValidationError("preparation_review_unavailable");
    if (state.reviewLink) {
      if (state.reviewLink.interactionId !== interactionId) throw new DcConflictError("preparation_review_already_linked");
      return;
    }
    const current = state.currentMeetingId!;
    const prior = [...state.events].reverse().find(event => event.kind === "review_unlinked");
    const sameRecord = [...state.events].reverse().find(event =>
      event.kind === "review_unlinked" && event.data.interactionId === interactionId);
    let original = state.pendingReviewMeetingId ?? current;
    let next = current;
    let originalItemIds: string[] | undefined;
    // Reopening the same review restores its original ownership with a *new* grant.
    if (sameRecord) {
      if (sameRecord.data.nextMeetingId !== current) throw new DcConflictError("preparation_review_from_earlier_meeting");
      original = sameRecord.data.originalMeetingId as string;
      originalItemIds = [...sameRecord.data.originalItemIds as string[]];
    } else if (!state.pendingReviewMeetingId && prior?.data.nextMeetingId === current
      && !state.items.some(item => item.status === "selected" && item.meetingId === current)) {
      // Correcting a just-unlinked association before a new selection.
      original = prior.data.originalMeetingId as string;
    }
    if (original === current) {
      next = randomUUID();
      state.currentMeetingId = next;
      state.intent = "";
      state.date = null;
      state.constraints = [];
      delete state.dateSources;
      delete state.constraintSources;
      delete state.dateReviewId;
      delete state.constraintReviewId;
    }
    const link: PreparationReviewLink = {
      id: randomUUID(), interactionId, recordingDate, linkedAt: now(), available: true,
      originalMeetingId: original, nextMeetingId: next,
      originalItemIds: originalItemIds ?? state.items.filter(item => item.status === "selected" && item.meetingId === original).map(item => item.id),
    };
    state.reviewLink = link;
    delete state.pendingReviewMeetingId;
    this.event(state, "review_linked", "已关联这次相处的复盘。", {
      reviewLinkId: link.id, interactionId, recordingDate,
      originalMeetingId: original, nextMeetingId: next, originalItemIds: [...link.originalItemIds],
    });
  }
  metadataSources(accountId: string, id: string) {
    const state = this.state(accountId, id);
    return {
      date: state.dateSources ?? [], constraints: state.constraintSources ?? [],
      dateChecked: state.dateContextChecked === true, constraintsChecked: state.constraintsContextChecked === true,
    };
  }
  active(accountId: string, id: string) {
    const view = this.state(accountId, id);
    return {
      generationId: view.generationId, taskId: view.taskId, version: view.version
    };
  }
  list(accountId: string, relationshipId: string) {
    return (this.database.prepare("SELECT id FROM dc_preparations WHERE user_id=? AND relationship_id=? AND deleted=0 ORDER BY updated_at DESC").all(accountId, relationshipId) as {
      id: string;
    }[]).map(row => this.get(accountId, row.id));
  }
  private write(accountId: string, state: State) {
    this.database.prepare("UPDATE dc_preparations SET body_json=?,updated_at=? WHERE id=? AND user_id=?").run(JSON.stringify(state), state.updatedAt, state.id, accountId);
  }
  private event(state: State, kind: string, text: string, data: Record<string, unknown> = {}) {
    const event = {
      id: randomUUID(), kind, text, data, createdAt: now(), ordinal: state.events.length
    };
    state.events.push(event);
    return event;
  }
  private receipt(accountId: string, key: string, request: unknown): Receipt | undefined {
    const row = this.database.prepare("SELECT request_hash,result_json FROM dc_preparation_operations WHERE user_id=? AND operation_key=?").get(accountId, key) as {
      request_hash: string;
      result_json: string;
    } | undefined;
    if (!row)
      return;
    if (row.request_hash !== hash(request))
      throw new DcConflictError("operation_key_reused");
    return JSON.parse(row.result_json);
  }
  private record(accountId: string, key: string, request: unknown, result: Receipt) {
    this.database.prepare("INSERT INTO dc_preparation_operations(user_id,operation_key,request_hash,result_json)VALUES(?,?,?,?)").run(accountId, key, hash(request), JSON.stringify(result));
  }
  create(accountId: string, relationshipId: string, input: {
    operationKey: string;
    text: string;
    interactionIds: string[];
    allowRetained: boolean;
  }) {
    return this.database.transaction(() => {
      const prior = this.receipt(accountId, input.operationKey, { kind: "create", ...input });
      if (prior)
        return prior;
      const time = now(), id = randomUUID();
      const state: State = {
        id, relationshipId, currentMeetingId: id, reviewLink: null, version: 0, title: input.text.slice(0, 45), intent: input.text, date: null, constraints: [], status: "active", interactionIds: [...new Set(input.interactionIds)], allowRetained: input.allowRetained, messages: [], items: [], events: [], createdAt: time, updatedAt: time, generationStatus: "idle"
      };
      this.database.prepare("INSERT INTO dc_preparations(id,user_id,relationship_id,body_json,created_at,updated_at)VALUES(?,?,?,?,?,?)").run(id, accountId, relationshipId, JSON.stringify(state), time, time);
      const result = { id };
      this.record(accountId, input.operationKey, { kind: "create", ...input }, result);
      return result;
    }).immediate();
  }
  begin(accountId: string, id: string, input: {
    operationKey: string;
    expectedVersion: number;
    text: string;
    kind: "message" | "feedback" | "correction";
    revokeHistory?: boolean;
    unlinkReview?: boolean;
    newEncounter?: boolean;
    withdrawItemId?: string;
  }) {
    return this.database.transaction(() => {
      // This flag is derived from the submitted text. Keep operation hashes
      // compatible with an identical P1 turn.
      const { unlinkReview, newEncounter, withdrawItemId, ...submitted } = input;
      const request = {
        operation: "turn", id, ...submitted
      };
      const prior = this.receipt(accountId, input.operationKey, request);
      if (prior)
        return prior;
      const state = this.state(accountId, id);
      if (state.version !== input.expectedVersion)
        throw new DcVersionConflictError(state.version);
      const generationId = randomUUID(), taskId = hash([accountId, id, input.operationKey]);
      if (input.revokeHistory) {
        this.unlinkReview(state);
        state.interactionIds = [];
        state.allowRetained = false;
        this.event(state, "scope_changed", "用户明确撤回本次历史资料。", { interactionIds: [], allowRetained: false });
      } else if (unlinkReview) this.unlinkReview(state);
      if (input.kind === "correction" && !withdrawItemId)
        for (const item of state.items)
          if (item.status === "suggested")
            item.status = "removed";
      const event = this.event(state, input.kind, input.text, { origin: "user_reflection" });
      const previousMeetingId = state.currentMeetingId;
      if (withdrawItemId) {
        const item = state.items.find(item => item.id === withdrawItemId && item.status !== "removed"
          && item.meetingId === previousMeetingId);
        if (!item) throw new DcConflictError("preparation_selection_changed");
        const previousStatus = item.status;
        item.status = "removed";
        this.event(state, "remove", item.text, {
          itemId: item.id, meetingId: item.meetingId, previousStatus, status: "removed", reasonEventId: event.id,
        });
      }
      if (newEncounter || (input.kind === "feedback" && !state.reviewLink && !state.pendingReviewMeetingId)) {
        // A distinctly reported later encounter advances the discussion. Additional detail or
        // a change of mind alone does not advance it or revoke a separate source authorization.
        state.pendingReviewMeetingId = state.currentMeetingId;
        state.currentMeetingId = event.id;
      }
      event.data.meetingId = state.currentMeetingId;
      const priorFeedback = [...state.messages].reverse().find(m => m.kind === "feedback");
      const legacyUnattributed = priorFeedback && state.planningAfterFeedback !== priorFeedback.id;
      if (previousMeetingId !== state.currentMeetingId || legacyUnattributed) {
        // Only a different encounter (or an unbound P1 plan) invalidates the plan date.
        // Additional reflections about a linked review do not replace the next confirmed plan.
        state.date = null;
        state.constraints = [];
        delete state.dateSources;
        delete state.constraintSources;
        delete state.dateReviewId;
        delete state.constraintReviewId;
        delete state.dateContextChecked;
        delete state.constraintsContextChecked;
        if (input.kind === "message") state.intent = this.get(accountId, id).intent;
      }
      if (input.kind === "feedback") state.planningAfterFeedback = event.id;
      else if (legacyUnattributed) state.planningAfterFeedback = priorFeedback.id;
      state.messages.push({
        id: event.id, meetingId: state.currentMeetingId, role: "user", text: input.text, kind: input.kind, createdAt: event.createdAt, sources: [], origin: "user_reflection"
      });
      state.version++;
      state.updatedAt = now();
      state.status = "active";
      state.generationStatus = "running";
      delete state.generationMessage;
      state.generationId = generationId;
      state.taskId = taskId;
      if (newEncounter || !state.intent || input.kind === "correction" || input.kind === "feedback")
        state.intent = input.text;
      this.write(accountId, state);
      const result = {
        id, generationId, taskId, version: state.version
      };
      this.record(accountId, input.operationKey, request, result);
      return result;
    }).immediate();
  }
  assertGeneration(accountId: string, id: string, generationId: string, version: number) {
    const state = this.state(accountId, id);
    if (state.version !== version || state.generationId !== generationId || state.generationStatus !== "running")
      throw new DcConflictError("preparation_generation_changed");
    return state;
  }
  commit(accountId: string, id: string, input: {
    generationId: string;
    version: number;
    text: string;
    suggestions: string[];
    sources: PreparationSource[];
    contextChecked?: boolean;
    date?: string | null;
    constraints?: string[];
  }) {
    return this.database.transaction(() => {
      const state = this.assertGeneration(accountId, id, input.generationId, input.version);
      const link = state.reviewLink;
      const reviewLinkId = link && input.sources.some(source => source.interactionId === link.interactionId) ? link.id : undefined;
      // Confirm the linked snapshots again under the Date database write lock.
      // A source deletion in another process cannot win between this check and publication.
      const linkedSnapshots = link ? input.sources.filter(source =>
        source.interactionId === link.interactionId && !source.id.startsWith("retained:")) : [];
      if (link && linkedSnapshots.length) {
        const current = new Map(this.sources.reviewSources(accountId, state.relationshipId, link.interactionId)
          .map(source => [source.id, source.fingerprint]));
        if (linkedSnapshots.some(source => current.get(source.id) !== source.fingerprint))
          throw new DcConflictError("preparation_review_changed");
      }
      const event = this.event(state, "assistant_message", input.text, {
        generationId: input.generationId, meetingId: state.currentMeetingId, sourceIds: input.sources.map(s => s.id),
        ...(reviewLinkId ? { reviewLinkId } : {}),
        ...(input.contextChecked === true ? { contextChecked: true } : {}),
      });
      state.messages.push({
        id: event.id, meetingId: state.currentMeetingId, ...(reviewLinkId ? { reviewLinkId } : {}), role: "assistant", text: input.text, kind: "message", createdAt: event.createdAt, sources: input.sources, origin: "assistant"
      });
      for (const text of input.suggestions)
        state.items.push({
          id: randomUUID(), meetingId: state.currentMeetingId, text, status: "suggested", sources: input.sources, createdAt: event.createdAt, sourceMessageId: event.id
        });
      if (input.date !== undefined) {
        state.dateContextChecked = input.contextChecked === true;
        state.dateReviewId = reviewLinkId;
        state.date = input.date;
        state.dateSources = input.sources.map(({id,fingerprint})=>({id,fingerprint}));
      }
      if (input.constraints) {
        state.constraintsContextChecked = input.contextChecked === true;
        state.constraintReviewId = reviewLinkId;
        state.constraints = input.constraints;
        state.constraintSources = input.sources.map(({id,fingerprint})=>({id,fingerprint}));
      }
      state.version++;
      state.updatedAt = now();
      state.generationStatus = "idle";
      delete state.generationId;
      delete state.generationMessage;
      this.write(accountId, state);
      return this.get(accountId, id);
    }).immediate();
  }
  fail(accountId: string, id: string, generationId: string, version: number, message: string) {
    this.database.transaction(() => {
      let state: State;
      try {
        state = this.assertGeneration(accountId, id, generationId, version);
      }
      catch {
        return;
      }
      state.generationStatus = "failed";
      state.generationMessage = message;
      state.updatedAt = now();
      delete state.generationId;
      this.event(state, "generation_stopped", message);
      this.write(accountId, state);
    }).immediate();
  }
  mutate(accountId: string, id: string, input: {
    operationKey: string;
    expectedVersion: number;
    kind: string;
    itemId?: string;
    interactionId?: string;
    text?: string;
    interactionIds?: string[];
    allowRetained?: boolean;
  }, validate?: (view: PreparationView) => void) {
    return this.database.transaction(() => {
      const request = { id, ...input };
      const prior = this.receipt(accountId, input.operationKey, request);
      if (prior)
        return this.get(accountId, prior.id);
      const state = this.state(accountId, id);
      if (state.version !== input.expectedVersion)
        throw new DcVersionConflictError(state.version);
      validate?.(state);
      if (["select", "edit", "remove"].includes(input.kind)) {
        const item = state.items.find(i => i.id === input.itemId && i.status !== "removed");
        if (!item)
          throw new DcNotFoundError("Preparation item not found");
        const previousStatus = item.status;
        if (input.kind === "edit") {
          if (!input.text)
            throw new DcValidationError("item_text_required");
          item.text = input.text;
        }
        if (input.kind === "select")
          item.status = "selected";
        if (input.kind === "remove")
          item.status = "removed";
        this.event(state, input.kind, input.text ?? item.text, {
          itemId: item.id, meetingId: item.meetingId, status: item.status, previousStatus,
        });
      }
      else if (input.kind === "link_review") {
        this.linkReview(accountId, state, input.interactionId);
      }
      else if (input.kind === "unlink_review") {
        this.unlinkReview(state);
      }
      else if (input.kind === "scope") {
        state.interactionIds = [...new Set(input.interactionIds ?? [])];
        state.allowRetained = input.allowRetained ?? false;
        this.event(state, "scope_changed", "本次资料范围已更新。", { interactionIds: state.interactionIds, allowRetained: state.allowRetained });
      }
      else if (input.kind === "pause") {
        state.status = "paused";
        this.event(state, "paused", "这次先不聊。", {});
      }
      else
        throw new DcValidationError("invalid_preparation_operation");
      state.version++;
      state.updatedAt = now();
      state.generationStatus = "idle";
      delete state.generationId;
      delete state.generationMessage;
      this.write(accountId, state);
      this.record(accountId, input.operationKey, request, { id });
      return this.get(accountId, id);
    }).immediate();
  }
  delete(accountId: string, id: string, input: {
    operationKey: string;
    expectedVersion: number;
  }) {
    return this.database.transaction(() => {
      const request = {
        kind: "delete", id, ...input
      };
      if (this.receipt(accountId, input.operationKey, request))
        return;
      const state = this.state(accountId, id);
      if (state.version !== input.expectedVersion)
        throw new DcVersionConflictError(state.version);
      this.database.prepare("UPDATE dc_preparations SET deleted=1,body_json='{}',updated_at=? WHERE id=? AND user_id=?").run(now(), id, accountId);
      this.database.prepare("UPDATE agent_tasks SET goal='[deleted]',scope_json='{}',status='cancelled',version=version+1 WHERE account_id=? AND resource_id=?").run(accountId, id);
      this.database.prepare("UPDATE agent_actions SET args_json='{}',summary='',reason=NULL WHERE task_id IN(SELECT id FROM agent_tasks WHERE account_id=? AND resource_id=?)").run(accountId, id);
      this.record(accountId, input.operationKey, request, { id });
    }).immediate();
  }
}

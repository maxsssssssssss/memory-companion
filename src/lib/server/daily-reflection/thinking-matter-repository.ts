import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

import {
  ThinkingMatterBeginTurnSchema,
  ThinkingMatterCommitResponseSchema,
  ThinkingMatterCreateSchema,
  ThinkingMatterEventSchema,
  ThinkingMatterMutationSchema,
  ThinkingMatterSchema,
  type ThinkingMatter,
  type ThinkingMatterBeginTurn,
  type ThinkingMatterCommitResponse,
  type ThinkingMatterComparison,
  type ThinkingMatterComparisonInput,
  type ThinkingMatterChoiceInput,
  type ThinkingMatterCreate,
  type ThinkingMatterEvent,
  type ThinkingMatterMutation,
  type ThinkingMatterSource,
  type ThinkingMatterView,
} from "@/lib/domain/reflection-thinking-matter";

export class ThinkingMatterNotFoundError extends Error {
  constructor() { super("thinking_matter_not_found"); }
}
export class ThinkingMatterConflictError extends Error {
  constructor(readonly code = "thinking_matter_version_conflict") { super(code); }
}

type MatterRow = { state_json: string; version: number };
type ReceiptRow = { matter_id: string; fingerprint: string; result_json: string };
type BeginTurnResult = { view: ThinkingMatterView; generationId: string; version: number };

/** Internal adapters may defer live guards until after exact receipt lookup.
 * receiptInput is their validated public request identity, never model output. */
type WriteOptions<T> = {
  receiptInput?: unknown;
  beforeWrite?: (input: T) => T | void;
};

const FailureSchema = z.object({
  generationId: z.string().min(1).max(200),
  expectedVersion: z.number().int().nonnegative(),
  status: z.enum(["known_failed", "unknown", "cancelled"]),
  text: z.string().trim().min(1).max(8_000),
}).strict();

/** Owns business progress only; shared AgentStore owns execution and model calls. */
export class ThinkingMatterRepository {
  private readonly now: () => string;
  private readonly idFactory: () => string;
  constructor(private readonly database: Database.Database, options: {
    now?: () => string;
    idFactory?: () => string;
  } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private id(prefix: string) { return `${prefix}_${this.idFactory().replace(/-/gu, "")}`; }
  private fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

  get(accountId: string, matterId: string): ThinkingMatterView {
    // A concurrent connection may commit between these SELECTs. Keep the state
    // and complete history in one read snapshot, including outside write calls.
    return this.database.transaction(() => {
      const row = this.database.prepare("SELECT state_json, version FROM dr_thinking_matters WHERE account_id = ? AND id = ?")
        .get(accountId, matterId) as MatterRow | undefined;
      if (!row) throw new ThinkingMatterNotFoundError();
      const matter = ThinkingMatterSchema.parse(JSON.parse(row.state_json));
      if (matter.accountId !== accountId || matter.id !== matterId || matter.version !== row.version) {
        throw new ThinkingMatterConflictError("thinking_matter_corrupt_binding");
      }
      const events = (this.database.prepare("SELECT event_json FROM dr_thinking_events WHERE account_id = ? AND matter_id = ? ORDER BY ordinal")
        .all(accountId, matterId) as Array<{ event_json: string }>).map(item => ThinkingMatterEventSchema.parse(JSON.parse(item.event_json)));
      return { matter, events };
    })();
  }

  list(accountId: string): ThinkingMatter[] {
    return (this.database.prepare("SELECT state_json FROM dr_thinking_matters WHERE account_id = ? ORDER BY updated_at DESC, id")
      .all(accountId) as Array<{ state_json: string }>).map(row => ThinkingMatterSchema.parse(JSON.parse(row.state_json)));
  }

  private save(matter: ThinkingMatter, previousVersion: number) {
    const parsed = ThinkingMatterSchema.parse(matter);
    const result = this.database.prepare("UPDATE dr_thinking_matters SET state_json = ?, version = ?, updated_at = ? WHERE account_id = ? AND id = ? AND version = ?")
      .run(JSON.stringify(parsed), parsed.version, parsed.updatedAt, parsed.accountId, parsed.id, previousVersion);
    if (result.changes !== 1) throw new ThinkingMatterConflictError();
  }

  private append(matter: ThinkingMatter, kind: ThinkingMatterEvent["kind"], text: string, data: Record<string, unknown> = {}, sources: ThinkingMatterSource[] = [], eventId?: string) {
    const ordinal = (this.database.prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM dr_thinking_events WHERE account_id = ? AND matter_id = ?")
      .get(matter.accountId, matter.id) as { ordinal: number }).ordinal;
    const event = ThinkingMatterEventSchema.parse({
      id: eventId ?? this.id("think_event"), matterId: matter.id, ordinal, kind, text, data, sources,
      matterVersion: matter.version, createdAt: this.now(),
    });
    this.database.prepare("INSERT INTO dr_thinking_events(account_id, matter_id, id, ordinal, event_json) VALUES (?, ?, ?, ?, ?)")
      .run(matter.accountId, matter.id, event.id, ordinal, JSON.stringify(event));
    return event;
  }

  private operation<T extends ThinkingMatterView | BeginTurnResult>(accountId: string, operationKey: string, matterId: string | null, payload: unknown, perform: () => { matterId: string; value: T }): T {
    const fingerprint = this.fingerprint(payload);
    return this.database.transaction(() => {
      const receipt = this.database.prepare("SELECT matter_id, fingerprint, result_json FROM dr_thinking_receipts WHERE account_id = ? AND operation_key = ?")
        .get(accountId, operationKey) as ReceiptRow | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint || (matterId !== null && receipt.matter_id !== matterId)) {
          throw new ThinkingMatterConflictError("thinking_matter_operation_conflict");
        }
        const reference = JSON.parse(receipt.result_json) as { generationId?: string; version: number };
        const view = this.get(accountId, receipt.matter_id);
        // Receipts contain result references, never another copy of all history.
        // A repeated save shows current progress rather than resurrecting an old view.
        return (reference.generationId
          ? { view, generationId: reference.generationId, version: reference.version }
          : view) as T;
      }
      const result = perform();
      const reference = "generationId" in result.value
        ? { generationId: result.value.generationId, version: result.value.version }
        : { version: result.value.matter.version };
      this.database.prepare("INSERT INTO dr_thinking_receipts(account_id, operation_key, matter_id, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(accountId, operationKey, result.matterId, fingerprint, JSON.stringify(reference), this.now());
      return result.value;
    }).immediate();
  }

  create(accountId: string, rawInput: ThinkingMatterCreate, options: WriteOptions<ThinkingMatterCreate> = {}): ThinkingMatterView {
    const input = ThinkingMatterCreateSchema.parse(rawInput);
    return this.operation(accountId, input.operationKey, null, { kind: "create", input: options.receiptInput ?? input }, () => {
      const prepared = ThinkingMatterCreateSchema.parse(options.beforeWrite?.(structuredClone(input)) ?? input);
      const { source: _originalSource, ...originalFields } = input;
      const { source: _preparedSource, ...preparedFields } = prepared;
      if (JSON.stringify(originalFields) !== JSON.stringify(preparedFields)) throw new ThinkingMatterConflictError("thinking_matter_write_identity_changed");
      const now = this.now();
      const matter = ThinkingMatterSchema.parse({
        id: this.id("thinking"), accountId, question: prepared.question, goal: prepared.goal ?? "",
        mode: prepared.mode ?? "brainstorm", contextMode: prepared.contextMode ?? "none",
        status: "active", version: 0, understanding: "", judgments: [], suggestions: [], arrangements: [],
        activeGeneration: null, createdAt: now, updatedAt: now,
      });
      this.database.prepare("INSERT INTO dr_thinking_matters(id, account_id, version, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(matter.id, accountId, matter.version, JSON.stringify(matter), now, now);
      const created = this.append(matter, "created", prepared.question, { goal: matter.goal, ...(prepared.source ? { source: prepared.source } : {}) });
      if (prepared.source) {
        matter.linkedSources = [{ ...prepared.source, sourceEventId: created.id }];
        this.save(matter, matter.version);
      }
      return { matterId: matter.id, value: this.get(accountId, matter.id) };
    });
  }

  private current(accountId: string, matterId: string, version: number) {
    const { matter } = this.get(accountId, matterId);
    if (matter.version !== version) throw new ThinkingMatterConflictError();
    return matter;
  }

  private normalizedName(value: string) { return value.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("zh-CN"); }

  private comparison(previous: ThinkingMatterComparison | null, input: ThinkingMatterComparisonInput, sourceEventId: string): ThinkingMatterComparison {
    const existing = previous?.options ?? [];
    const options = [...existing];
    const touched = new Set<string>();
    for (const proposed of input.options) {
      const named = existing.find(option => this.normalizedName(option.name) === this.normalizedName(proposed.name));
      const current = proposed.id ? existing.find(option => option.id === proposed.id) : named;
      if (proposed.id && !current) throw new ThinkingMatterConflictError("thinking_comparison_option_unknown");
      const id = current?.id ?? this.id("think_option");
      if (touched.has(id)) throw new ThinkingMatterConflictError("thinking_comparison_duplicate_option");
      touched.add(id);
      const { id: _providedId, ...fields } = proposed;
      const same = current && JSON.stringify({ name: current.name, content: current.content, reasons: current.reasons, limits: current.limits, costs: current.costs, unknowns: current.unknowns }) === JSON.stringify(fields);
      const next = { id, ...fields, sourceEventId: same ? current.sourceEventId : sourceEventId };
      const index = options.findIndex(option => option.id === id);
      if (index < 0) options.push(next);
      else options[index] = next;
    }
    if (options.length > 12) throw new ThinkingMatterConflictError("thinking_comparison_option_limit");
    if (new Set(options.map(option => this.normalizedName(option.name))).size !== options.length) throw new ThinkingMatterConflictError("thinking_comparison_duplicate_name");
    if (new Set(input.dimensions.map(value => this.normalizedName(value))).size !== input.dimensions.length) throw new ThinkingMatterConflictError("thinking_comparison_duplicate_dimension");
    if (input.recommendation?.optionId && !options.some(option => option.id === input.recommendation!.optionId)) throw new ThinkingMatterConflictError("thinking_comparison_recommendation_unknown");
    return { question: input.question, dimensions: input.dimensions, options,
      recommendation: input.recommendation ? { ...input.recommendation, sourceEventId } : null, sourceEventId };
  }

  private recordChoice(matter: ThinkingMatter, input: ThinkingMatterChoiceInput) {
    const options = matter.comparison?.options ?? [];
    const optionId = input.optionId ?? null;
    if ((input.status === "undecided") !== (optionId === null)) throw new ThinkingMatterConflictError("thinking_choice_option_required");
    if (optionId && !options.some(option => option.id === optionId)) throw new ThinkingMatterConflictError("thinking_choice_option_unknown");
    const rejectedIds = input.rejectedIds ?? matter.userChoice.rejectedIds.filter(id => id !== optionId);
    if (new Set(rejectedIds).size !== rejectedIds.length || rejectedIds.includes(optionId ?? "") || rejectedIds.some(id => !options.some(option => option.id === id))) throw new ThinkingMatterConflictError("thinking_choice_rejected_options_invalid");
    const eventId = this.id("think_event"), previousChoice = matter.userChoice;
    matter.userChoice = { status: input.status, optionId, reason: input.reason, rejectedIds, sourceEventId: eventId };
    this.append(matter, "choice_changed", input.reason || (input.status === "selected" ? "用户确认选择。" : input.status === "leaning" ? "用户记录当前倾向，尚未决定。" : "用户尚未决定。"), { previousChoice, choice: matter.userChoice, reason: input.reason }, [], eventId);
  }

  mutate(accountId: string, matterId: string, rawInput: ThinkingMatterMutation, options: WriteOptions<ThinkingMatterMutation> = {}): ThinkingMatterView {
    const original = ThinkingMatterMutationSchema.parse(rawInput);
    return this.operation(accountId, original.operationKey, matterId, { kind: "mutate", matterId, input: options.receiptInput ?? original }, () => {
      const matter = this.current(accountId, matterId, original.expectedVersion);
      const input = ThinkingMatterMutationSchema.parse(options.beforeWrite?.(structuredClone(original)) ?? original);
      if (input.operationKey !== original.operationKey || input.kind !== original.kind || input.expectedVersion !== original.expectedVersion)
        throw new ThinkingMatterConflictError("thinking_matter_write_identity_changed");
      if (input.kind === "link_source" && original.kind === "link_source") {
        if (input.source.sourceId !== original.source.sourceId || input.source.kind !== original.source.kind) throw new ThinkingMatterConflictError("thinking_matter_write_identity_changed");
      } else if (JSON.stringify(input) !== JSON.stringify(original)) throw new ThinkingMatterConflictError("thinking_matter_write_identity_changed");
      const before = matter.version;
      matter.version += 1;
      matter.updatedAt = this.now();
      // Explicit user edits/feedback invalidate every earlier generated result.
      const activeGeneration = matter.activeGeneration;
      matter.activeGeneration = activeGeneration?.status === "unknown" && !["cancel", "edit", "status", "comparison", "correct", "link_source", "unlink_source"].includes(input.kind)
        ? { ...activeGeneration, version: matter.version }
        : null;
      switch (input.kind) {
        case "adopt": {
          const suggestion = matter.suggestions.find(item => item.id === input.suggestionId);
          if (!suggestion || suggestion.status !== "proposed") throw new ThinkingMatterConflictError("thinking_suggestion_not_proposed");
          suggestion.status = "adopted";
          const arrangement = {
            id: this.id("think_arrangement"), suggestionId: suggestion.id, text: input.text ?? suggestion.text,
            kind: suggestion.kind, status: "adopted" as const, adoptedAt: matter.updatedAt, updatedAt: matter.updatedAt, version: 0,
          };
          matter.arrangements.push(arrangement);
          this.append(matter, "adopted", arrangement.text, { suggestionId: suggestion.id, arrangementId: arrangement.id, kind: arrangement.kind });
          break;
        }
        case "reject": {
          const suggestion = matter.suggestions.find(item => item.id === input.suggestionId);
          if (!suggestion || suggestion.status !== "proposed") throw new ThinkingMatterConflictError("thinking_suggestion_not_proposed");
          suggestion.status = "rejected";
          this.append(matter, "rejected", input.reason ?? "用户不采纳这项建议。", { suggestionId: suggestion.id, suggestionText: suggestion.text });
          break;
        }
        case "feedback": {
          if (input.arrangementStatus && !input.arrangementId) throw new ThinkingMatterConflictError("thinking_arrangement_required");
          if (input.arrangementId) {
            const arrangement = matter.arrangements.find(item => item.id === input.arrangementId);
            if (!arrangement) throw new ThinkingMatterNotFoundError();
            if (input.arrangementStatus) {
              arrangement.status = input.arrangementStatus;
              arrangement.version += 1;
              arrangement.updatedAt = matter.updatedAt;
            }
          }
          this.append(matter, "feedback", input.text, { arrangementId: input.arrangementId ?? null, arrangementStatus: input.arrangementStatus ?? null });
          break;
        }
        case "edit": {
          if (input.question !== undefined) matter.question = input.question;
          if (input.goal !== undefined) matter.goal = input.goal;
          if (input.mode !== undefined) matter.mode = input.mode;
          if (input.contextMode !== undefined) matter.contextMode = input.contextMode;
          if (input.text !== undefined || input.arrangementId !== undefined) {
            const arrangement = matter.arrangements.find(item => item.id === input.arrangementId);
            if (!arrangement || !input.text) throw new ThinkingMatterConflictError("thinking_arrangement_edit_invalid");
            const previousText = arrangement.text;
            arrangement.text = input.text;
            arrangement.status = "changed";
            arrangement.version += 1;
            arrangement.updatedAt = matter.updatedAt;
            this.append(matter, "edited", input.text, { arrangementId: arrangement.id, previousText, question: input.question, goal: input.goal });
          } else this.append(matter, "edited", input.question ?? input.goal ?? "用户修改讨论设置。", { question: input.question, goal: input.goal, mode: input.mode, contextMode: input.contextMode });
          break;
        }
        case "status": {
          const previousStatus = matter.status;
          matter.status = input.status;
          this.append(matter, "status_changed", input.reason ?? (input.status === "paused" ? "用户暂停这件事。" : input.status === "resolved" ? "用户将这件事标为已解决。" : input.status === "archived" ? "用户归档这件事。" : "用户继续这件事。"), { previousStatus, status: input.status });
          break;
        }
        case "cancel": {
          if (input.generationId && activeGeneration?.id !== input.generationId) throw new ThinkingMatterConflictError("thinking_generation_changed");
          this.append(matter, "cancelled", "用户停止了本轮回复；事情本身没有完成。", { generationId: activeGeneration?.id ?? null, taskId: activeGeneration?.taskId ?? null });
          break;
        }
        case "comparison": {
          const eventId = this.id("think_event"), previousComparison = matter.comparison;
          matter.comparison = this.comparison(previousComparison, input.comparison, eventId);
          this.append(matter, "comparison_edited", "用户修改了当前比较。", { previousComparison, comparison: matter.comparison }, [], eventId);
          break;
        }
        case "choice": {
          this.recordChoice(matter, input);
          break;
        }
        case "correct": {
          const eventId = this.id("think_event");
          const legacyEventId = matter.understandingSourceEventId === null || matter.judgmentsSourceEventId === null
            ? [...this.get(accountId, matterId).events].reverse().find(event => event.kind === "assistant_message")?.id
            : undefined;
          const data = { previousUnderstanding: matter.understanding, previousJudgments: matter.judgments,
            previousUnderstandingSourceEventId: matter.understandingSourceEventId, previousJudgmentsSourceEventId: matter.judgmentsSourceEventId,
            correctedEventIds: [...new Set([matter.understandingSourceEventId, matter.judgmentsSourceEventId, legacyEventId].filter((id): id is string => typeof id === "string"))], reason: input.reason ?? "" };
          matter.understanding = input.understanding;
          matter.judgments = [];
          matter.understandingSourceEventId = eventId;
          matter.judgmentsSourceEventId = eventId;
          this.append(matter, "corrected", input.understanding, data, [], eventId);
          break;
        }
        case "link_source": {
          const eventId = this.id("think_event");
          matter.linkedSources = [...matter.linkedSources.filter(source => source.sourceId !== input.source.sourceId || source.kind !== input.source.kind), { ...input.source, sourceEventId: eventId }];
          this.append(matter, "source_linked", "用户关联了日常来源。", { source: input.source }, [input.source], eventId);
          break;
        }
        case "unlink_source": {
          const removed = matter.linkedSources.filter(source => source.sourceId === input.sourceId);
          matter.linkedSources = matter.linkedSources.filter(source => source.sourceId !== input.sourceId);
          this.append(matter, "source_unlinked", "用户撤回了关联来源。", { sourceId: input.sourceId, removed });
          break;
        }
      }
      this.save(matter, before);
      return { matterId, value: this.get(accountId, matterId) };
    });
  }

  beginTurn(accountId: string, matterId: string, rawInput: ThinkingMatterBeginTurn): BeginTurnResult {
    const input = ThinkingMatterBeginTurnSchema.parse(rawInput);
    return this.operation(accountId, input.operationKey, matterId, { kind: "begin_turn", matterId, input }, () => {
      const matter = this.current(accountId, matterId, input.expectedVersion);
      if (matter.status !== "active") throw new ThinkingMatterConflictError("thinking_matter_not_active");
      if (matter.activeGeneration) throw new ThinkingMatterConflictError("thinking_generation_pending");
      const before = matter.version;
      matter.version += 1;
      matter.updatedAt = this.now();
      matter.mode = input.mode ?? matter.mode;
      matter.contextMode = input.contextMode ?? matter.contextMode;
      if (input.choice) this.recordChoice(matter, input.choice);
      if (input.arrangementId !== undefined || input.arrangementStatus !== undefined) {
        if (!input.feedback || !input.arrangementId || !input.arrangementStatus) throw new ThinkingMatterConflictError("thinking_feedback_arrangement_invalid");
        const arrangement = matter.arrangements.find(item => item.id === input.arrangementId);
        if (!arrangement) throw new ThinkingMatterNotFoundError();
        arrangement.status = input.arrangementStatus;
        arrangement.version += 1;
        arrangement.updatedAt = matter.updatedAt;
      }
      const generationId = this.id("think_generation");
      matter.activeGeneration = { id: generationId, version: matter.version, taskId: input.taskId ?? null, status: "running" };
      this.append(matter, input.feedback ? "feedback" : "user_message", input.text, { generationId, taskId: input.taskId ?? null, mode: matter.mode, contextMode: matter.contextMode,
        arrangementId: input.arrangementId ?? null, arrangementStatus: input.arrangementStatus ?? null, ...(input.choice ? { choice: input.choice } : {}) });
      this.save(matter, before);
      return { matterId, value: { view: this.get(accountId, matterId), generationId, version: matter.version } };
    });
  }

  commitResponse(accountId: string, matterId: string, rawInput: ThinkingMatterCommitResponse): ThinkingMatterView {
    const input = ThinkingMatterCommitResponseSchema.parse(rawInput);
    const operationKey = `response:${input.generationId}`;
    return this.operation(accountId, operationKey, matterId, { kind: "response", matterId, input }, () => {
      const matter = this.current(accountId, matterId, input.expectedVersion);
      if (matter.status !== "active" || matter.activeGeneration?.id !== input.generationId) throw new ThinkingMatterConflictError("thinking_generation_changed");
      if (input.taskId && matter.activeGeneration.taskId && input.taskId !== matter.activeGeneration.taskId) throw new ThinkingMatterConflictError("thinking_generation_task_changed");
      const before = matter.version;
      matter.version += 1;
      matter.updatedAt = this.now();
      matter.activeGeneration = null;
      if (input.understanding !== undefined) matter.understanding = input.understanding;
      if (input.judgments !== undefined) matter.judgments = input.judgments;
      const eventId = this.id("think_event");
      if (input.understanding !== undefined) matter.understandingSourceEventId = eventId;
      if (input.judgments !== undefined) matter.judgmentsSourceEventId = eventId;
      if (input.comparison !== undefined) matter.comparison = this.comparison(matter.comparison, input.comparison, eventId);
      const event = this.append(matter, "assistant_message", input.reply, { generationId: input.generationId, taskId: input.taskId ?? null, promptVersion: input.promptVersion ?? null, model: input.model ?? null,
        understanding: input.understanding ?? null, judgments: input.judgments ?? [], suggestions: input.suggestions ?? [], comparison: input.comparison === undefined ? null : matter.comparison }, input.sources ?? [], eventId);
      if (input.suggestions !== undefined) {
        for (const suggestion of matter.suggestions) if (suggestion.status === "proposed") suggestion.status = "superseded";
        for (const suggestion of input.suggestions) matter.suggestions.push({
          id: this.id("think_suggestion"), text: suggestion.text, kind: suggestion.kind, status: "proposed", createdAt: matter.updatedAt, sourceEventId: event.id,
        });
      }
      this.save(matter, before);
      return { matterId, value: this.get(accountId, matterId) };
    });
  }

  failResponse(accountId: string, matterId: string, rawInput: z.infer<typeof FailureSchema>): ThinkingMatterView {
    const input = FailureSchema.parse(rawInput);
    return this.operation(accountId, `failure:${input.generationId}:${input.status}`, matterId, { kind: "failure", matterId, input }, () => {
      const matter = this.current(accountId, matterId, input.expectedVersion);
      if (matter.activeGeneration?.id !== input.generationId) throw new ThinkingMatterConflictError("thinking_generation_changed");
      const before = matter.version;
      matter.version += 1;
      matter.updatedAt = this.now();
      matter.activeGeneration = input.status === "unknown"
        ? { ...matter.activeGeneration, version: matter.version, status: "unknown" }
        : null;
      this.append(matter, input.status === "cancelled" ? "cancelled" : "generation_failed", input.text, { generationId: input.generationId, status: input.status });
      this.save(matter, before);
      return { matterId, value: this.get(accountId, matterId) };
    });
  }
}

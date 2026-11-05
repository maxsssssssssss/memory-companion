import { z } from "zod";

import { ContextModeSchema, ThinkingModeSchema } from "./daily-reflection-thinking";

const Id = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u);
const Text = z.string().trim().min(1).max(8_000);
const Operation = z.string().trim().min(1).max(512);
const Version = z.number().int().nonnegative();

/** References only. A saved excerpt is never an authority for a later turn. */
export const ThinkingMatterSourceSchema = z.object({
  sourceId: z.string().trim().min(1).max(512),
  version: z.string().trim().min(1).max(256),
  kind: z.enum(["card", "memory", "record"]),
}).strict();

const ComparisonText = z.string().trim().max(4_000);
const ComparisonPoints = z.array(z.string().trim().min(1).max(1_200)).max(12);
const ComparisonOptionFields = {
  name: z.string().trim().min(1).max(240),
  content: ComparisonText,
  reasons: ComparisonPoints,
  limits: ComparisonPoints,
  costs: ComparisonPoints,
  unknowns: ComparisonPoints,
};

/** Missing IDs mean a new option; existing options are updated by stable ID. */
export const ThinkingMatterComparisonInputSchema = z.object({
  question: Text,
  dimensions: z.array(z.string().trim().min(1).max(240)).max(16),
  options: z.array(z.object({ id: Id.optional(), ...ComparisonOptionFields }).strict()).min(1).max(12),
  recommendation: z.object({ optionId: Id.nullable(), text: ComparisonText }).strict().nullable(),
}).strict();

// Older respond actions include a question. The user owns the title, so the
// model may omit it and a saved action can still be replayed in its old shape.
export const ThinkingMatterComparisonUpdateSchema = ThinkingMatterComparisonInputSchema.extend({
  question: z.string().max(8_000).nullish().describe("题目由用户确定，请省略。"),
});

export const ThinkingMatterComparisonSchema = z.object({
  question: Text,
  dimensions: z.array(z.string().trim().min(1).max(240)).max(16),
  options: z.array(z.object({ id: Id, ...ComparisonOptionFields, sourceEventId: Id }).strict()).min(1).max(12),
  recommendation: z.object({ optionId: Id.nullable(), text: ComparisonText, sourceEventId: Id }).strict().nullable(),
  sourceEventId: Id,
}).strict();

export const ThinkingMatterUserChoiceSchema = z.object({
  status: z.enum(["undecided", "leaning", "selected"]),
  optionId: Id.nullable(),
  reason: z.string().trim().max(8_000),
  rejectedIds: z.array(Id).max(12),
  sourceEventId: Id.nullable(),
}).strict();

export const ThinkingMatterChoiceInputSchema = z.object({
  status: ThinkingMatterUserChoiceSchema.shape.status,
  optionId: Id.nullable().optional(),
  reason: z.string().trim().max(8_000),
  rejectedIds: z.array(Id).max(12).optional(),
}).strict();

export const ThinkingMatterLinkedSourceSchema = ThinkingMatterSourceSchema.extend({ sourceEventId: Id }).strict();

export const ThinkingMatterSuggestionSchema = z.object({
  id: Id,
  text: Text,
  kind: z.enum(["action", "decision"]),
  status: z.enum(["proposed", "adopted", "rejected", "superseded"]),
  createdAt: z.string().datetime(),
  sourceEventId: Id,
}).strict();

export const ThinkingMatterArrangementSchema = z.object({
  id: Id,
  suggestionId: Id,
  text: Text,
  kind: z.enum(["action", "decision"]),
  status: z.enum(["adopted", "tried", "not_started", "changed", "completed"]),
  adoptedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: Version,
}).strict();

export const ThinkingMatterGenerationSchema = z.object({
  id: Id,
  version: Version,
  taskId: z.string().min(1).max(256).nullable(),
  status: z.enum(["running", "known_failed", "unknown"]),
}).strict();

export const ThinkingMatterSchema = z.object({
  id: Id,
  accountId: z.string().trim().min(1).max(512),
  question: Text,
  goal: z.string().trim().max(8_000),
  mode: ThinkingModeSchema,
  contextMode: ContextModeSchema,
  status: z.enum(["active", "paused", "resolved", "archived"]),
  version: Version,
  understanding: z.string().trim().max(8_000),
  judgments: z.array(Text).max(24),
  understandingSourceEventId: Id.nullable().default(null),
  judgmentsSourceEventId: Id.nullable().default(null),
  comparison: ThinkingMatterComparisonSchema.nullable().default(null),
  userChoice: ThinkingMatterUserChoiceSchema.default({ status: "undecided", optionId: null, reason: "", rejectedIds: [], sourceEventId: null }),
  linkedSources: z.array(ThinkingMatterLinkedSourceSchema).max(32).default([]),
  suggestions: z.array(ThinkingMatterSuggestionSchema),
  arrangements: z.array(ThinkingMatterArrangementSchema),
  activeGeneration: ThinkingMatterGenerationSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const ThinkingMatterEventSchema = z.object({
  id: Id,
  matterId: Id,
  ordinal: Version,
  kind: z.enum(["created", "user_message", "assistant_message", "adopted", "rejected", "feedback", "edited", "status_changed", "cancelled", "generation_failed", "comparison_edited", "choice_changed", "corrected", "source_linked", "source_unlinked"]),
  text: z.string().max(12_000),
  data: z.record(z.unknown()),
  sources: z.array(ThinkingMatterSourceSchema).max(32),
  matterVersion: Version,
  createdAt: z.string().datetime(),
}).strict();

export const ThinkingMatterViewSchema = z.object({
  matter: ThinkingMatterSchema,
  events: z.array(ThinkingMatterEventSchema),
}).strict();

export const ThinkingMatterCreateSchema = z.object({
  operationKey: Operation,
  question: Text,
  goal: z.string().trim().max(8_000).optional(),
  mode: ThinkingModeSchema.optional(),
  contextMode: ContextModeSchema.optional(),
  source: ThinkingMatterSourceSchema.optional(),
}).strict();

const MutationBase = { operationKey: Operation, expectedVersion: Version };
export const ThinkingMatterMutationSchema = z.discriminatedUnion("kind", [
  z.object({ ...MutationBase, kind: z.literal("adopt"), suggestionId: Id, text: Text.optional() }).strict(),
  z.object({ ...MutationBase, kind: z.literal("reject"), suggestionId: Id, reason: z.string().trim().max(8_000).optional() }).strict(),
  z.object({ ...MutationBase, kind: z.literal("feedback"), text: Text, arrangementId: Id.optional(), arrangementStatus: ThinkingMatterArrangementSchema.shape.status.optional() }).strict(),
  z.object({ ...MutationBase, kind: z.literal("edit"), question: Text.optional(), goal: z.string().trim().max(8_000).optional(), mode: ThinkingModeSchema.optional(), contextMode: ContextModeSchema.optional(), arrangementId: Id.optional(), text: Text.optional() }).strict(),
  z.object({ ...MutationBase, kind: z.literal("status"), status: ThinkingMatterSchema.shape.status, reason: Text.optional() }).strict(),
  z.object({ ...MutationBase, kind: z.literal("cancel"), generationId: Id.optional() }).strict(),
  z.object({ ...MutationBase, kind: z.literal("comparison"), comparison: ThinkingMatterComparisonInputSchema, questionEdited: z.boolean().optional() }).strict(),
  z.object({ ...MutationBase, kind: z.literal("retitle"), question: Text, message: Text.optional(), reason: z.string().trim().max(8_000).optional() }).strict(),
  z.object({ ...MutationBase, kind: z.literal("choice"), ...ThinkingMatterChoiceInputSchema.shape }).strict(),
  z.object({ ...MutationBase, kind: z.literal("correct"), understanding: Text, reason: z.string().trim().max(8_000).optional(), comparisonQuestion: Text.optional() }).strict(),
  z.object({ ...MutationBase, kind: z.literal("link_source"), source: ThinkingMatterSourceSchema }).strict(),
  z.object({ ...MutationBase, kind: z.literal("unlink_source"), sourceId: ThinkingMatterSourceSchema.shape.sourceId }).strict(),
]);

export const ThinkingMatterBeginTurnSchema = z.object({
  operationKey: Operation,
  expectedVersion: Version,
  text: Text,
  mode: ThinkingModeSchema.optional(),
  contextMode: ContextModeSchema.optional(),
  feedback: z.boolean().optional(),
  arrangementId: Id.optional(),
  arrangementStatus: z.enum(["tried", "not_started", "changed"]).optional(),
  taskId: z.string().min(1).max(256).optional(),
  choice: ThinkingMatterChoiceInputSchema.optional(),
}).strict();

export const ThinkingMatterCommitResponseSchema = z.object({
  generationId: Id,
  expectedVersion: Version,
  reply: Text,
  understanding: z.string().trim().max(8_000).optional(),
  judgments: z.array(Text).max(24).optional(),
  suggestions: z.array(z.object({ text: Text, kind: z.enum(["action", "decision"]) }).strict()).max(8).optional(),
  sources: z.array(ThinkingMatterSourceSchema).max(32).optional(),
  taskId: z.string().min(1).max(256).optional(),
  promptVersion: z.string().trim().min(1).max(256).optional(),
  model: z.string().trim().min(1).max(256).optional(),
  comparison: ThinkingMatterComparisonUpdateSchema.optional(),
}).strict();

export type ThinkingMatter = z.infer<typeof ThinkingMatterSchema>;
export type ThinkingMatterSource = z.infer<typeof ThinkingMatterSourceSchema>;
export type ThinkingMatterEvent = z.infer<typeof ThinkingMatterEventSchema>;
export type ThinkingMatterView = z.infer<typeof ThinkingMatterViewSchema>;
export type ThinkingMatterCreate = z.infer<typeof ThinkingMatterCreateSchema>;
export type ThinkingMatterMutation = z.infer<typeof ThinkingMatterMutationSchema>;
export type ThinkingMatterBeginTurn = z.infer<typeof ThinkingMatterBeginTurnSchema>;
export type ThinkingMatterCommitResponse = z.infer<typeof ThinkingMatterCommitResponseSchema>;
export type ThinkingMatterComparisonInput = z.infer<typeof ThinkingMatterComparisonInputSchema>;
export type ThinkingMatterComparison = z.infer<typeof ThinkingMatterComparisonSchema>;
export type ThinkingMatterUserChoice = z.infer<typeof ThinkingMatterUserChoiceSchema>;
export type ThinkingMatterChoiceInput = z.infer<typeof ThinkingMatterChoiceInputSchema>;

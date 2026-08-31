import { z } from "zod";

import { DailyReflectionIdSchema } from "./daily-reflection";
import { DailyReflectionQueryClaimSchema } from "./daily-reflection-query";

export const ThinkingModeSchema = z.enum([
  "brainstorm",
  "clarify_decision",
  "compare_directions",
  "extend_idea",
  "past_clues"
]);

export const ContextModeSchema = z.enum(["none", "personal", "auto"]);

export const DailyReflectionThinkingCompletionStatusSchema = z.enum([
  "completed",
  "no_result",
  "provider_error",
  "cancelled"
]);

export const DAILY_REFLECTION_THINKING_SAFETY_BOUNDARY_VERSION = "v2" as const;
export const DailyReflectionThinkingSafetyBoundaryVersionSchema = z.literal(
  DAILY_REFLECTION_THINKING_SAFETY_BOUNDARY_VERSION
);

export const DailyReflectionThinkingConversationIdSchema = z.string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/u);

const OperationKeySchema = z.string().trim().min(1).max(512);
const MessageTextSchema = z.string().trim().min(1).max(8_000);
const AssistantPartSchema = z.string().trim().min(1).max(2_000);

function uniqueIds(values: string[], context: z.RefinementCtx, path: string) {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: `${path} must contain unique IDs`
    });
  }
}

export const DailyReflectionThinkingRequestSchema = z.object({
  operationKey: OperationKeySchema,
  conversationId: DailyReflectionThinkingConversationIdSchema.optional(),
  mode: ThinkingModeSchema,
  contextMode: ContextModeSchema,
  message: MessageTextSchema,
  pinnedCardIds: z.array(DailyReflectionIdSchema).max(32).optional(),
  pinnedMemoryIds: z.array(DailyReflectionIdSchema).max(32).optional(),
  pinnedEvidenceIds: z.array(DailyReflectionIdSchema).max(64).optional()
}).strict().superRefine((request, context) => {
  uniqueIds(request.pinnedCardIds ?? [], context, "pinnedCardIds");
  uniqueIds(request.pinnedMemoryIds ?? [], context, "pinnedMemoryIds");
  uniqueIds(request.pinnedEvidenceIds ?? [], context, "pinnedEvidenceIds");
  const hasPinnedContext = Boolean(
    request.pinnedCardIds?.length
    || request.pinnedMemoryIds?.length
    || request.pinnedEvidenceIds?.length
  );
  if (request.contextMode === "none" && hasPinnedContext) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contextMode"],
      message: "contextMode none cannot include pinned personal context"
    });
  }
  if (request.mode === "past_clues" && request.contextMode !== "personal") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contextMode"],
      message: "past_clues requires contextMode personal"
    });
  }
});

export const DailyReflectionThinkingSourceSchema = z.object({
  sourceId: DailyReflectionIdSchema,
  claim: DailyReflectionQueryClaimSchema
}).strict();

export const DailyReflectionThinkingPersonalClaimSchema = z.object({
  text: AssistantPartSchema,
  sourceIds: z.array(DailyReflectionIdSchema).min(1).max(16)
}).strict().superRefine((claim, context) => {
  uniqueIds(claim.sourceIds, context, "sourceIds");
});

export const DailyReflectionThinkingProviderOutputSchema = z.object({
  answer: z.string().trim().min(1).max(6_000),
  personalContextClaims: z.array(DailyReflectionThinkingPersonalClaimSchema).max(12),
  interpretations: z.array(AssistantPartSchema).max(12),
  hypotheses: z.array(AssistantPartSchema).max(12)
}).strict();

export const DailyReflectionThinkingMessageSchema = z.object({
  id: DailyReflectionIdSchema,
  operationKey: OperationKeySchema,
  role: z.enum(["user", "assistant"]),
  mode: ThinkingModeSchema,
  contextMode: ContextModeSchema,
  content: z.string().trim().min(1).max(8_000),
  safetyBoundaryVersion: DailyReflectionThinkingSafetyBoundaryVersionSchema.nullable().optional(),
  usedPersonalContext: z.boolean(),
  sources: z.array(DailyReflectionThinkingSourceSchema).max(16),
  personalContextClaims: z.array(DailyReflectionThinkingPersonalClaimSchema).max(12),
  interpretations: z.array(AssistantPartSchema).max(12),
  hypotheses: z.array(AssistantPartSchema).max(12),
  model: z.string().trim().min(1).max(240).nullable(),
  createdAt: z.string().datetime(),
  completionStatus: DailyReflectionThinkingCompletionStatusSchema
}).strict().superRefine((message, context) => {
  if (message.usedPersonalContext !== (message.sources.length > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["usedPersonalContext"],
      message: "usedPersonalContext must reflect whether sources are present"
    });
  }
  if (message.role === "user") {
    if (message.safetyBoundaryVersion != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["safetyBoundaryVersion"],
        message: "user messages cannot declare an assistant safety boundary"
      });
    }
    if (message.model !== null || message.completionStatus !== "completed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["role"],
        message: "user messages cannot have a model or non-completed status"
      });
    }
    if (
      message.personalContextClaims.length > 0
      || message.interpretations.length > 0
      || message.hypotheses.length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["role"],
        message: "user messages cannot contain assistant attribution parts"
      });
    }
  }
  const allowedSourceIds = new Set(message.sources.map((source) => source.sourceId));
  if (message.personalContextClaims.some((claim) => (
    claim.sourceIds.some((sourceId) => !allowedSourceIds.has(sourceId))
  ))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["personalContextClaims"],
      message: "personal claims must cite sources stored on the same message"
    });
  }
});

export const DailyReflectionThinkingConversationSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: DailyReflectionThinkingConversationIdSchema,
  messages: z.array(DailyReflectionThinkingMessageSchema).max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const DailyReflectionThinkingResponseSchema = z.object({
  conversationId: DailyReflectionThinkingConversationIdSchema,
  operationKey: OperationKeySchema,
  assistantMessage: DailyReflectionThinkingMessageSchema,
  usedPersonalContext: z.boolean(),
  sources: z.array(DailyReflectionThinkingSourceSchema).max(16),
  model: z.string().trim().min(1).max(240)
}).strict().superRefine((response, context) => {
  if (response.assistantMessage.role !== "assistant") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assistantMessage", "role"],
      message: "assistantMessage must have the assistant role"
    });
  }
  if (
    response.assistantMessage.operationKey !== response.operationKey
    || response.assistantMessage.model !== response.model
    || response.assistantMessage.usedPersonalContext !== response.usedPersonalContext
    || JSON.stringify(response.assistantMessage.sources) !== JSON.stringify(response.sources)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assistantMessage"],
      message: "response metadata must match the assistant message"
    });
  }
});

export const DailyReflectionThinkingConversationResponseSchema = z.object({
  conversation: DailyReflectionThinkingConversationSchema
}).strict();

export const DailyReflectionThinkingContextResolveRequestSchema = z.object({
  accountId: DailyReflectionIdSchema,
  mode: ThinkingModeSchema,
  contextMode: z.enum(["personal", "auto"]),
  message: MessageTextSchema,
  pinnedCardIds: z.array(DailyReflectionIdSchema).max(32),
  pinnedMemoryIds: z.array(DailyReflectionIdSchema).max(32),
  pinnedEvidenceIds: z.array(DailyReflectionIdSchema).max(64)
}).strict();

export const DailyReflectionThinkingContextResolveResultSchema = z.object({
  sources: z.array(DailyReflectionThinkingSourceSchema).max(16)
}).strict();

export type ThinkingMode = z.infer<typeof ThinkingModeSchema>;
export type ContextMode = z.infer<typeof ContextModeSchema>;
export type DailyReflectionThinkingRequest = z.infer<
  typeof DailyReflectionThinkingRequestSchema
>;
export type DailyReflectionThinkingSource = z.infer<
  typeof DailyReflectionThinkingSourceSchema
>;
export type DailyReflectionThinkingProviderOutput = z.infer<
  typeof DailyReflectionThinkingProviderOutputSchema
>;
export type DailyReflectionThinkingMessage = z.infer<
  typeof DailyReflectionThinkingMessageSchema
>;
export type DailyReflectionThinkingConversation = z.infer<
  typeof DailyReflectionThinkingConversationSchema
>;
export type DailyReflectionThinkingResponse = z.infer<
  typeof DailyReflectionThinkingResponseSchema
>;
export type DailyReflectionThinkingContextResolveRequest = z.infer<
  typeof DailyReflectionThinkingContextResolveRequestSchema
>;
export type DailyReflectionThinkingContextResolveResult = z.infer<
  typeof DailyReflectionThinkingContextResolveResultSchema
>;

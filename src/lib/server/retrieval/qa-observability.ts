import { z } from "zod";

export const QaAnswerModeSchema = z.enum(["agent", "direct"]);

export type QaAnswerMode = z.infer<typeof QaAnswerModeSchema>;

const NullableDurationMsSchema = z.number().int().nonnegative().nullable();
const NullableCharacterCountSchema = z.number().int().nonnegative().nullable();

/**
 * Internal, content-free diagnostics for one QA execution.
 *
 * Every timing field is required. A stage that did not run or could not be
 * measured must be represented as `null` instead of being omitted or reported
 * as a misleading zero-duration stage.
 */
export const QaExecutionDiagnosticsSchema = z.object({
  answerMode: QaAnswerModeSchema,
  memoryRetrievalMs: NullableDurationMsSchema,
  relationshipContextBuildingMs: NullableDurationMsSchema,
  rerankingMs: NullableDurationMsSchema,
  promptConstructionMs: NullableDurationMsSchema,
  llmGenerationMs: NullableDurationMsSchema,
  responseValidationMs: NullableDurationMsSchema,
  totalMs: z.number().int().nonnegative(),
  promptCharacters: NullableCharacterCountSchema,
  responseCharacters: NullableCharacterCountSchema,
  evidenceCount: z.number().int().nonnegative(),
  providerCallCount: z.number().int().nonnegative(),
  fallbackReason: z.string().trim().min(1).max(128),
  retrievalMode: z.enum(["off", "shadow", "phase31"]).optional(),
  denseRetrievalMs: NullableDurationMsSchema.optional(),
  embeddingIndexCoverage: z.number().min(0).max(1).nullable().optional(),
  retrievalFallbackReason: z.string().trim().min(1).max(128).nullable().optional()
}).strict();

export type QaExecutionDiagnostics = z.infer<typeof QaExecutionDiagnosticsSchema>;

export type QaExecutionDiagnosticsObserver = (
  diagnostics: QaExecutionDiagnostics
) => unknown;

export type QaObservabilityWarnLogger = Pick<Console, "warn">;

/** Converts a monotonic-clock interval to a safe, non-negative integer. */
export function safeElapsedMs(startedAt: number, completedAt = performance.now()): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return 0;
  return Math.max(0, Math.round(completedAt - startedAt));
}

function errorName(error: unknown) {
  if (error instanceof Error && error.name.trim()) return error.name.trim();
  return "unknown";
}

function warnObserverFailure(error: unknown, logger: QaObservabilityWarnLogger) {
  try {
    logger.warn(`[qa-observability] observer_failed error_name=${errorName(error)}`);
  } catch {
    // Diagnostics and diagnostics logging must never affect the QA result.
  }
}

/**
 * Validates and notifies an optional observer without allowing observer code to
 * alter the QA control flow. Promise rejections are observed in the background.
 */
export function notifyQaExecutionDiagnostics(
  observer: QaExecutionDiagnosticsObserver | undefined,
  diagnostics: unknown,
  logger: QaObservabilityWarnLogger = console
): void {
  if (!observer) return;

  try {
    const validated = QaExecutionDiagnosticsSchema.parse(diagnostics);
    const result = observer(validated);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch((error: unknown) => {
        warnObserverFailure(error, logger);
      });
    }
  } catch (error) {
    warnObserverFailure(error, logger);
  }
}

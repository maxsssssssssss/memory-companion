import { pathToFileURL } from "node:url";
import type { TranscriptSegment } from "../src/lib/domain/types";
import type { ProactiveInsightContext } from "../src/lib/domain/proactive-insights";
import type { MemoryRelevanceJudge } from "../src/lib/server/memory/relevance/types";
import { MemoryRelevanceResultSchema, type MemoryRelevanceFailureCode } from "../src/lib/server/memory/relevance/types";
import type { StructuredJsonFailureCode } from "../src/lib/server/openai/structured-json";
import type { MemoryRelevanceRejectionReason } from "../src/lib/server/memory/relevance/validator";
import type { MemoryRelevanceResponseDiagnostic } from "../src/lib/server/memory/relevance/deepseek-judge";

type MemorySmokeDiagnostic = {
  stage: "memory_transport" | "memory_response_schema" | "memory_adapter" | "memory_result_validation";
  adapterStatus: "disabled" | "fallback" | "judged";
  transportCode?: StructuredJsonFailureCode | "request_failed";
  responseSchema?: MemoryRelevanceResponseDiagnostic;
  rawResultCount?: number;
  validResultCount?: number;
  rejectionReasons?: Partial<Record<MemoryRelevanceRejectionReason, number>>;
  schemaIssues?: Array<{ index: number; code: string; path: string }>;
};

export class MemoryRelevanceSmokeError extends Error {
  constructor(public readonly code: MemoryRelevanceFailureCode | "invalid_evidence", public readonly diagnostic: MemorySmokeDiagnostic) {
    super("memory_relevance_smoke_failed");
    this.name = "MemoryRelevanceSmokeError";
  }
}

/** Whitelisted diagnostics only; arbitrary exceptions never expose their message or properties. */
export function summarizeTokenHubFlashSmokeFailure(error: unknown) {
  return error instanceof MemoryRelevanceSmokeError
    ? { status: "failed", errorCode: error.code, diagnostic: error.diagnostic }
    : { status: "failed", errorCode: "tokenhub_flash_smoke_failed" };
}

export const flashSmokeSegments: TranscriptSegment[] = [{
  id: "synthetic_segment", uploadId: "synthetic_upload", startSeconds: 0, endSeconds: 8,
  speaker: "speaker_1", text: "I hear your suggestion. Let us check the sample together tomorrow.",
  confidence: 1, sceneLabels: ["self_reflection"], valueLabels: ["commitment"]
}];
export const flashSmokeContext: ProactiveInsightContext = {
  schemaVersion: 1, scope: "current", referenceDate: "2026-09-10",
  dateRange: { startDate: "2026-09-10", endDate: "2026-09-10" },
  sourceUploadIds: ["synthetic_upload"], distinctDates: ["2026-09-10"], truncated: false,
  evidence: [{ evidenceId: "brief:synthetic", kind: "brief", sourceType: "brief", sourceId: "synthetic",
    uploadId: "synthetic_upload", recordingDate: "2026-09-10", sourceSegmentIds: ["synthetic_segment"],
    timeRange: { startSeconds: 0, endSeconds: 8 }, title: "Sample check", summary: "A sample check was proposed for tomorrow.",
    excerpt: flashSmokeSegments[0]!.text }]
};
export const flashSmokeMemoryInput: Parameters<MemoryRelevanceJudge["judge"]>[0] = {
  current: { referenceDate: "2026-09-10", topics: ["sample check"], briefItems: ["Check a sample tomorrow"],
    semanticSummaries: [], relationshipSignals: [] },
  candidates: [{ memoryId: "synthetic_memory", memoryRef: "memory:synthetic_memory", type: "commitment",
    summary: "An earlier note suggested checking the sample with a colleague.", dates: ["2026-09-09"],
    importanceScore: 0.6, status: "active", occurrenceCount: 1, evidenceSummaries: ["Let us check the sample together."] }]
};

export type FlashSmokeRole = "audio" | "proactive" | "memory";
const routeKeys = { audio: "AUDIO_INSIGHT_BASE_URL", proactive: "PROACTIVE_INSIGHT_BASE_URL", memory: "MEMORY_RELEVANCE_BASE_URL" } as const;

export function checkTokenHubFlashSmokeConfig(role: FlashSmokeRole) {
  if (process.env[routeKeys[role]]?.trim().replace(/\/+$/, "") !== "https://tokenhub.vision-intelligence.tech/v1") throw new Error("smoke_route_not_tokenhub");
  const model = process.env[role === "audio" ? "DEEPSEEK_AUDIO_INSIGHT_MODEL" : "DEEPSEEK_MODEL"]?.trim() || "deepseek-v4-flash";
  if (model !== "deepseek-v4-flash") throw new Error("smoke_model_not_flash");
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("smoke_tokenhub_key_missing");
}

/** One direct production adapter call, synthetic inputs only, no fallback
 * wrapper, database, queue submission, retry loop or environment mutation. */
export async function runTokenHubFlashSmoke(role: FlashSmokeRole, fetch?: typeof globalThis.fetch) {
  checkTokenHubFlashSmokeConfig(role);
  const started = Date.now();
  let count: number;
  let providerStatus: string;
  if (role === "audio") {
    const { createDeepseekAudioInsightProvider } = await import("../src/lib/server/audio-insights/deepseek-provider");
    const items = await createDeepseekAudioInsightProvider({ fetch, logger: { info() {}, warn() {} } }).analyze("synthetic_upload", flashSmokeSegments);
    if (!items.length) throw new Error("smoke_audio_no_valid_items");
    count = items.length; providerStatus = "analyzed";
  } else if (role === "proactive") {
    const { createDeepseekProactiveInsightProvider } = await import("../src/lib/server/proactive-insights/deepseek-provider");
    const result = await createDeepseekProactiveInsightProvider({ fetch, logger: { info() {}, warn() {} } }).generate({ context: flashSmokeContext });
    if (result.status !== "generated" || result.failureCode) throw new Error(`smoke_proactive_${result.failureCode ?? result.status}`);
    if (!result.items.length) throw new Error("smoke_proactive_no_valid_items");
    count = result.items.length; providerStatus = result.status;
  } else {
    const { createDeepseekMemoryRelevanceJudge } = await import("../src/lib/server/memory/relevance/deepseek-judge");
    const { validateMemoryRelevanceResults } = await import("../src/lib/server/memory/relevance/validator");
    let transportCode: StructuredJsonFailureCode | "request_failed" | undefined;
    let responseSchema: MemoryRelevanceResponseDiagnostic | undefined;
    const result = await createDeepseekMemoryRelevanceJudge({ fetch,
      onTransportFailure: (code) => { transportCode = code; },
      onResponseSchemaFailure: (diagnostic) => { responseSchema = diagnostic; }
    }).judge(flashSmokeMemoryInput);
    if (result.status !== "judged" || result.failureCode) throw new MemoryRelevanceSmokeError(result.failureCode ?? "api_error", {
      stage: transportCode ? "memory_transport" : result.failureCode === "invalid_schema" ? "memory_response_schema" : "memory_adapter",
      adapterStatus: result.status, ...(transportCode ? { transportCode } : {}), ...(responseSchema ? { responseSchema } : {})
    });
    // The ordinary caller's relevance validator is also required for this smoke.
    const checked = validateMemoryRelevanceResults({ candidates: flashSmokeMemoryInput.candidates, memories: [], rawResults: result.rawResults });
    count = checked.decisions.length; providerStatus = result.status;
    if (!count) {
      const fields = new Set(Object.keys(MemoryRelevanceResultSchema.shape));
      const schemaIssues = result.rawResults.flatMap((raw, index) => {
        const parsed = MemoryRelevanceResultSchema.safeParse(raw);
        return parsed.success ? [] : parsed.error.issues.map((issue) => ({
          index, code: issue.code,
          // Never emit unknown property names, Zod messages, or the model values.
          path: issue.path.length === 0 ? "$" : issue.path.map((part) => fields.has(String(part)) ? String(part) : "other").join(".")
        }));
      }).slice(0, 10);
      throw new MemoryRelevanceSmokeError("invalid_evidence", {
        stage: "memory_result_validation", adapterStatus: result.status,
        rawResultCount: result.rawResults.length, validResultCount: count,
        rejectionReasons: checked.rejectionReasons, schemaIssues
      });
    }
  }
  return { role, channel: "tokenhub", model: "deepseek-v4-flash", status: "passed", providerStatus, count, elapsedMs: Date.now() - started };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { loadRuntimeEnv } = await import("../src/lib/server/env/runtime-env");
    loadRuntimeEnv();
    const role = process.argv.find((arg) => arg.startsWith("--role="))?.slice(7);
    if (role !== "audio" && role !== "proactive" && role !== "memory") throw new Error("use_role_audio_proactive_or_memory");
    if (process.argv.includes("--check")) {
      checkTokenHubFlashSmokeConfig(role);
      console.log(JSON.stringify({ role, status: "configured", providerCalls: 0 }));
    } else if (process.argv.includes("--execute-once")) {
      console.log(JSON.stringify(await runTokenHubFlashSmoke(role)));
    } else throw new Error("use_check_or_execute_once");
  } catch (error) {
    // Never print SDK errors, request bodies, credentials or response text.
    console.error(JSON.stringify(summarizeTokenHubFlashSmokeFailure(error)));
    process.exitCode = 1;
  }
}

import {
  DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION,
  DailyReflectionAiReviewLookupResponseSchema,
  DailyReflectionAiReviewSummarySchema,
  type DailyReflectionAiReviewOperationView,
  type DailyReflectionAiReviewScope
} from "@/lib/domain/daily-reflection-ai-review";
import { getUserScopedStore } from "@/lib/server/auth/session";
import { resolveOpenAIClientProvider } from "@/lib/server/openai/client";
import { enqueueDailyReflectionAiReviewJob } from
  "@/lib/server/queue/daily-reflection-ai-review-queue";
import { getOpenAIClientRuntimeConfig } from
  "@/lib/server/settings/provider-config";
import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  buildDailyReflectionAiReviewContext,
  projectDailyReflectionAiReviewDraft,
  type DailyReflectionAiReviewContext
} from "./ai-review-context";
import {
  createDailyReflectionAiReviewProvider,
  DailyReflectionAiReviewProviderOutputError,
  DailyReflectionAiReviewProviderTimeoutError,
  resolveDailyReflectionAiReviewGptModel,
  type DailyReflectionAiReviewProvider
} from "./ai-review-provider";
import {
  createDailyReflectionAiReviewRepository,
  type DailyReflectionAiReviewClaim,
  type DailyReflectionAiReviewRecord,
  type DailyReflectionAiReviewRepository
} from "./ai-review-repository";
import { getDailyReflectionDatabase } from "./db";
import {
  getDailyReflectionAiReviewMode,
  type DailyReflectionAiReviewMode
} from "./runtime-config";
import { dailyReflectionSevenDayWindow } from "./return-time";

export const DAILY_REFLECTION_AI_REVIEW_PROMPT_VERSION =
  "daily-reflection-ai-review-v2" as const;
const CLAIM_LEASE_MS = 12 * 60 * 1_000;

type AiReviewServiceDependencies = {
  repository: DailyReflectionAiReviewRepository;
  provider: DailyReflectionAiReviewProvider;
  mode(): DailyReflectionAiReviewMode;
  getStore(accountId: string): JsonStore;
  resolveModel(store: JsonStore): Promise<string>;
  buildContext(input: {
    accountId: string;
    scope: DailyReflectionAiReviewScope;
    referenceDate: string;
    promptVersion: string;
    model: string;
  }): DailyReflectionAiReviewContext | null;
  enqueue(input: { version: 1; reviewId: string; userRef: string }): Promise<{
    jobId: string;
    enqueued: boolean;
  }>;
};

export class DailyReflectionAiReviewNotFoundError extends Error {
  constructor() {
    super("Daily Reflection AI review was not found");
    this.name = "DailyReflectionAiReviewNotFoundError";
  }
}

function windowFor(scope: DailyReflectionAiReviewScope, referenceDate: string) {
  return scope === "daily"
    ? { startDate: referenceDate, endDate: referenceDate }
    : dailyReflectionSevenDayWindow(referenceDate);
}

function operationForExposure(
  record: DailyReflectionAiReviewRecord,
  mode: Exclude<DailyReflectionAiReviewMode, "off">
): DailyReflectionAiReviewOperationView {
  return {
    schemaVersion: DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION,
    reviewId: record.reviewId,
    scope: record.scope,
    startDate: record.startDate,
    endDate: record.endDate,
    status: record.status,
    sourceFingerprint: record.sourceFingerprint,
    promptVersion: record.promptVersion,
    model: record.model,
    content: mode === "on" ? record.content : null,
    failureCode: record.failureCode,
    providerStartedAt: record.providerStartedAt,
    completedAt: record.completedAt,
    seenAt: mode === "on" ? record.seenAt : null,
    updatedAt: record.updatedAt
  };
}

function failureCode(error: unknown) {
  if (error instanceof DailyReflectionAiReviewProviderTimeoutError) {
    return "provider_timeout";
  }
  if (error instanceof DailyReflectionAiReviewProviderOutputError) {
    return error.code;
  }
  return "provider_unavailable";
}

function usageFromProvider(input: {
  outputTokenCount: number | null;
  totalTokenCount: number | null;
}) {
  const inputTokenCount = input.totalTokenCount !== null
    && input.outputTokenCount !== null
    ? Math.max(0, input.totalTokenCount - input.outputTokenCount)
    : null;
  return { ...input, inputTokenCount };
}

export class DailyReflectionAiReviewService {
  constructor(private readonly dependencies: AiReviewServiceDependencies) {}

  private exposureMode() {
    const mode = this.dependencies.mode();
    return mode === "off" ? null : mode;
  }

  private async currentContext(input: {
    accountId: string;
    scope: DailyReflectionAiReviewScope;
    referenceDate: string;
    store?: JsonStore;
  }) {
    const store = input.store ?? this.dependencies.getStore(input.accountId);
    const model = await this.dependencies.resolveModel(store);
    const context = this.dependencies.buildContext({
      accountId: input.accountId,
      scope: input.scope,
      referenceDate: input.referenceDate,
      promptVersion: DAILY_REFLECTION_AI_REVIEW_PROMPT_VERSION,
      model
    });
    return { context, model, store };
  }

  private lookupResponse(input: {
    mode: Exclude<DailyReflectionAiReviewMode, "off">;
    scope: DailyReflectionAiReviewScope;
    referenceDate: string;
    record: DailyReflectionAiReviewRecord | null;
  }) {
    return DailyReflectionAiReviewLookupResponseSchema.parse({
      schemaVersion: DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION,
      exposureMode: input.mode,
      scope: input.scope,
      referenceDate: input.referenceDate,
      review: input.record
        ? operationForExposure(input.record, input.mode)
        : null
    });
  }

  async ensure(input: {
    accountId: string;
    scope: DailyReflectionAiReviewScope;
    referenceDate: string;
  }) {
    const mode = this.exposureMode();
    if (!mode) throw new DailyReflectionAiReviewNotFoundError();
    const { context } = await this.currentContext(input);
    if (!context) {
      const window = windowFor(input.scope, input.referenceDate);
      const previous = this.dependencies.repository.getLatest({
        accountId: input.accountId,
        scope: input.scope,
        ...window
      });
      if (previous && previous.status !== "stale") {
        this.dependencies.repository.stale(input.accountId, previous.reviewId);
      }
      return this.lookupResponse({
        mode,
        scope: input.scope,
        referenceDate: input.referenceDate,
        record: previous
          ? this.dependencies.repository.get(input.accountId, previous.reviewId)
          : null
      });
    }
    const ensured = this.dependencies.repository.ensure({
      accountId: input.accountId,
      scope: context.scope,
      startDate: context.startDate,
      endDate: context.endDate,
      sourceFingerprint: context.sourceFingerprint,
      promptVersion: context.promptVersion,
      model: context.model,
      sources: context.sources
    });
    if (ensured.record.status === "queued") {
      await this.dependencies.enqueue({
        version: 1,
        reviewId: ensured.record.reviewId,
        userRef: input.accountId
      }).catch((error: unknown) => {
        console.warn(
          `[daily-reflection-ai-review] enqueue_unavailable error_name=${
            error instanceof Error ? error.name : "unknown"
          }`
        );
      });
    }
    return this.lookupResponse({
      mode,
      scope: input.scope,
      referenceDate: input.referenceDate,
      record: this.dependencies.repository.get(
        input.accountId,
        ensured.record.reviewId
      )
    });
  }

  async lookup(input: {
    accountId: string;
    scope: DailyReflectionAiReviewScope;
    referenceDate: string;
  }) {
    const mode = this.exposureMode();
    if (!mode) throw new DailyReflectionAiReviewNotFoundError();
    const window = windowFor(input.scope, input.referenceDate);
    const record = this.dependencies.repository.getLatest({
      accountId: input.accountId,
      scope: input.scope,
      ...window
    });
    if (!record) {
      return this.lookupResponse({ ...input, mode, record: null });
    }
    if (record.status === "ready") {
      const { context } = await this.currentContext(input);
      if (!context || context.sourceFingerprint !== record.sourceFingerprint) {
        this.dependencies.repository.stale(input.accountId, record.reviewId);
      }
    }
    return this.lookupResponse({
      mode,
      scope: input.scope,
      referenceDate: input.referenceDate,
      record: this.dependencies.repository.get(input.accountId, record.reviewId)
    });
  }

  async summary(accountId: string) {
    const mode = this.exposureMode();
    if (!mode) throw new DailyReflectionAiReviewNotFoundError();
    for (const item of this.dependencies.repository.listUnseenReady(accountId)) {
      const record = this.dependencies.repository.get(accountId, item.reviewId);
      if (!record || record.status !== "ready") continue;
      const { context } = await this.currentContext({
        accountId,
        scope: record.scope,
        referenceDate: record.endDate
      });
      if (!context || context.sourceFingerprint !== record.sourceFingerprint) {
        this.dependencies.repository.stale(accountId, record.reviewId);
      }
    }
    const summary = this.dependencies.repository.summary(accountId);
    return DailyReflectionAiReviewSummarySchema.parse({
      schemaVersion: DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION,
      exposureMode: mode,
      pendingCount: summary.pendingCount,
      unseenReadyCount: mode === "on" ? summary.unseenReadyCount : 0,
      items: mode === "on" ? summary.items : []
    });
  }

  async markSeen(accountId: string, reviewId: string) {
    const mode = this.exposureMode();
    if (mode !== "on") throw new DailyReflectionAiReviewNotFoundError();
    const record = this.dependencies.repository.get(accountId, reviewId);
    if (!record) throw new DailyReflectionAiReviewNotFoundError();
    const { context } = await this.currentContext({
      accountId,
      scope: record.scope,
      referenceDate: record.endDate
    });
    if (
      record.status !== "ready"
      || !context
      || context.sourceFingerprint !== record.sourceFingerprint
    ) {
      if (record.status === "ready") {
        this.dependencies.repository.stale(accountId, reviewId);
      }
      throw new DailyReflectionAiReviewNotFoundError();
    }
    this.dependencies.repository.markSeen(accountId, reviewId);
    const updated = this.dependencies.repository.get(accountId, reviewId);
    if (!updated) throw new DailyReflectionAiReviewNotFoundError();
    return operationForExposure(updated, "on");
  }

  async process(input: {
    accountId: string;
    reviewId: string;
    workerId: string;
  }) {
    if (this.dependencies.mode() === "off") {
      return { status: "disabled" } as const;
    }
    const claimed = this.dependencies.repository.claim({
      ...input,
      leaseMs: CLAIM_LEASE_MS
    });
    if (!claimed.claimed) {
      return { status: claimed.record?.status ?? "missing" } as const;
    }
    const { claim, record } = claimed;
    try {
      const store = this.dependencies.getStore(input.accountId);
      const before = await this.currentContext({
        accountId: input.accountId,
        scope: record.scope,
        referenceDate: record.endDate,
        store
      });
      if (
        before.model !== record.model
        || !before.context
        || before.context.sourceFingerprint !== record.sourceFingerprint
      ) {
        this.dependencies.repository.stale(input.accountId, input.reviewId);
        return { status: "stale" } as const;
      }
      if (this.dependencies.mode() === "off") {
        this.dependencies.repository.stale(input.accountId, input.reviewId);
        return { status: "stale" } as const;
      }
      if (!this.dependencies.repository.providerStarted(claim)) {
        return { status: "superseded" } as const;
      }
      const generated = await this.dependencies.provider.generate({
        scope: before.context.scope,
        startDate: before.context.startDate,
        endDate: before.context.endDate,
        sources: before.context.sources,
        settingsStore: store
      });
      if (!this.dependencies.repository.validating(claim)) {
        return { status: "superseded" } as const;
      }
      const after = await this.currentContext({
        accountId: input.accountId,
        scope: record.scope,
        referenceDate: record.endDate,
        store
      });
      if (
        generated.model !== record.model
        || after.model !== record.model
        || !after.context
        || after.context.sourceFingerprint !== record.sourceFingerprint
        || this.dependencies.mode() === "off"
      ) {
        this.dependencies.repository.stale(input.accountId, input.reviewId);
        return { status: "stale" } as const;
      }
      const content = projectDailyReflectionAiReviewDraft({
        context: after.context,
        draft: generated.draft
      });
      const completed = this.dependencies.repository.complete({
        claim,
        content,
        usage: usageFromProvider(generated.usage)
      });
      return { status: completed ? "ready" : "superseded" } as const;
    } catch (error) {
      this.dependencies.repository.fail({
        claim,
        failureCode: failureCode(error)
      });
      console.warn(
        `[daily-reflection-ai-review] generation_failed review_id=${input.reviewId} `
        + `error_name=${error instanceof Error ? error.name : "unknown"}`
      );
      return { status: "failed" } as const;
    }
  }

  recover() {
    const recovered = this.dependencies.repository.recoverExpiredLeases();
    return {
      ...recovered,
      queued: this.dependencies.repository.listQueued()
    };
  }
}

async function resolveModel(store: JsonStore) {
  const runtimeConfig = await getOpenAIClientRuntimeConfig(store);
  return resolveDailyReflectionAiReviewGptModel(
    resolveOpenAIClientProvider(runtimeConfig)
  );
}

export function createDailyReflectionAiReviewService(
  dependencies: Partial<AiReviewServiceDependencies> = {}
) {
  return new DailyReflectionAiReviewService({
    repository: dependencies.repository
      ?? createDailyReflectionAiReviewRepository(getDailyReflectionDatabase()),
    provider: dependencies.provider ?? createDailyReflectionAiReviewProvider(),
    mode: dependencies.mode ?? getDailyReflectionAiReviewMode,
    getStore: dependencies.getStore ?? getUserScopedStore,
    resolveModel: dependencies.resolveModel ?? resolveModel,
    buildContext: dependencies.buildContext ?? buildDailyReflectionAiReviewContext,
    enqueue: dependencies.enqueue ?? enqueueDailyReflectionAiReviewJob
  });
}

export function getDailyReflectionAiReviewService() {
  return createDailyReflectionAiReviewService();
}

export type { DailyReflectionAiReviewClaim };

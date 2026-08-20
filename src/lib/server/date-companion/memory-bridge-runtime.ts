import Database from "better-sqlite3";

import { getDateCompanionDatabasePath } from "./db";
import { DcConflictError } from "./errors";
import { processNextDateCompanionMemoryBridge } from "./memory-bridge-consumer";
import {
  publishDateCompanionMemoryBridgeRuntimeReport,
  type DateCompanionMemoryBridgeRuntimeReport
} from "./memory-bridge-health";
import {
  inspectDateCompanionMemoryBridgePreflight,
  type DateCompanionMemoryBridgePreflightResult
} from "./memory-bridge-preflight";
import {
  getDateCompanionMemoryBridgeRuntimeConfig,
  type DateCompanionMemoryBridgeRuntimeConfig
} from "./memory-bridge-runtime-config";
import { getMemoryDatabasePath } from "@/lib/server/memory/db";

type RuntimeLogger = Pick<Console, "info" | "warn" | "error">;

export type DateCompanionMemoryBridgeRuntimeHealthSnapshot =
  DateCompanionMemoryBridgeRuntimeReport;

export type DateCompanionMemoryBridgePollReport = {
  handled: number;
  completed: number;
  needsReview: number;
  retryableFailed: number;
  idle: boolean;
  stopped: boolean;
};

export type DateCompanionMemoryBridgeCloseReport = {
  timedOut: boolean;
};

export type DateCompanionMemoryBridgeRuntime = {
  readonly config: DateCompanionMemoryBridgeRuntimeConfig;
  readonly runPromise: Promise<void>;
  pollNow(): Promise<DateCompanionMemoryBridgePollReport>;
  getHealthSnapshot(): DateCompanionMemoryBridgeRuntimeHealthSnapshot;
  close(): Promise<DateCompanionMemoryBridgeCloseReport>;
};

export type DateCompanionMemoryBridgeRuntimeDependencies = {
  inspectPreflight(dataDirectory: string): Pick<
    DateCompanionMemoryBridgePreflightResult,
    "ok" | "errorCodes"
  >;
  openDateCompanionDatabase(dataDirectory: string): Database.Database;
  openMemoryDatabase(dataDirectory: string): Database.Database;
  processNext: typeof processNextDateCompanionMemoryBridge;
  now(): number;
  logger: RuntimeLogger;
  reportHealth?(
    snapshot: DateCompanionMemoryBridgeRuntimeHealthSnapshot
  ): void | Promise<void>;
};

export type StartDateCompanionMemoryBridgeRuntimeOptions = {
  env?: Record<string, string | undefined>;
  config?: DateCompanionMemoryBridgeRuntimeConfig;
  dependencies?: Partial<DateCompanionMemoryBridgeRuntimeDependencies>;
  startImmediately?: boolean;
};

const defaultDependencies: DateCompanionMemoryBridgeRuntimeDependencies = {
  inspectPreflight: (dataDirectory) =>
    inspectDateCompanionMemoryBridgePreflight({ dataDirectory }),
  openDateCompanionDatabase: (dataDirectory) =>
    openExistingRuntimeDatabase(getDateCompanionDatabasePath(dataDirectory)),
  openMemoryDatabase: (dataDirectory) =>
    openExistingRuntimeDatabase(getMemoryDatabasePath(dataDirectory)),
  processNext: processNextDateCompanionMemoryBridge,
  now: Date.now,
  logger: console
};

function openExistingRuntimeDatabase(filePath: string) {
  const database = new Database(filePath, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function emptyPollReport(stopped = false): DateCompanionMemoryBridgePollReport {
  return {
    handled: 0,
    completed: 0,
    needsReview: 0,
    retryableFailed: 0,
    idle: false,
    stopped
  };
}

function safeErrorCode(error: unknown) {
  const candidate = error instanceof DcConflictError
    ? error.code
    : error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "memory_bridge_failed";
  return /^[A-Za-z0-9_-]{1,120}$/u.test(candidate)
    ? candidate
    : "memory_bridge_failed";
}

function unrefTimer(timer: ReturnType<typeof setTimeout>) {
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

function retryDelayMs(
  consecutiveFailures: number,
  config: DateCompanionMemoryBridgeRuntimeConfig
) {
  const exponent = Math.max(0, Math.min(30, consecutiveFailures - 1));
  return Math.min(config.retryMaxMs, config.retryBaseMs * (2 ** exponent));
}

export class DateCompanionMemoryBridgeRuntimePreflightError extends Error {
  constructor(readonly errorCodes: string[]) {
    super(
      `Date Companion Memory Bridge preflight failed: ${
        errorCodes.length > 0 ? errorCodes.join(",") : "unknown"
      }`
    );
    this.name = "DateCompanionMemoryBridgeRuntimePreflightError";
  }
}

let activeRuntime: DateCompanionMemoryBridgeRuntime | null = null;

export function startDateCompanionMemoryBridgeRuntime(
  options: StartDateCompanionMemoryBridgeRuntimeOptions = {}
): DateCompanionMemoryBridgeRuntime | null {
  const config = options.config
    ?? getDateCompanionMemoryBridgeRuntimeConfig(options.env ?? process.env);
  if (!config.enabled) return null;
  if (activeRuntime) return activeRuntime;

  const hasHealthReporterOverride = options.dependencies
    ? Object.prototype.hasOwnProperty.call(options.dependencies, "reportHealth")
    : false;
  const dependencies: DateCompanionMemoryBridgeRuntimeDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
    reportHealth: hasHealthReporterOverride
      ? options.dependencies?.reportHealth
      : (snapshot) => publishDateCompanionMemoryBridgeRuntimeReport({
          dataDirectory: config.dataDirectory,
          report: snapshot
        })
  };
  const preflight = dependencies.inspectPreflight(config.dataDirectory);
  if (!preflight.ok) {
    throw new DateCompanionMemoryBridgeRuntimePreflightError([
      ...preflight.errorCodes
    ]);
  }
  const dateCompanionDatabase = dependencies.openDateCompanionDatabase(
    config.dataDirectory
  );
  let memoryDatabase: Database.Database;
  try {
    memoryDatabase = dependencies.openMemoryDatabase(config.dataDirectory);
  } catch (error) {
    if (dateCompanionDatabase.open) dateCompanionDatabase.close();
    throw error;
  }

  const startedAt = new Date(dependencies.now()).toISOString();
  let running = true;
  let closing = false;
  let resourcesClosed = false;
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<DateCompanionMemoryBridgePollReport> | null = null;
  let closePromise: Promise<DateCompanionMemoryBridgeCloseReport> | null = null;
  let healthReportChain = Promise.resolve();
  let consecutiveRetryableFailures = 0;
  const counters = {
    processed: 0,
    retried: 0,
    failed: 0,
    lastSuccessAt: null as string | null,
    lastErrorCode: null as string | null
  };
  let resolveRunPromise: (() => void) | undefined;
  let rejectRunPromise: ((error: unknown) => void) | undefined;
  let runPromiseSettled = false;
  const runPromise = new Promise<void>((resolve, reject) => {
    resolveRunPromise = resolve;
    rejectRunPromise = reject;
  });

  const getHealthSnapshot = (): DateCompanionMemoryBridgeRuntimeHealthSnapshot => ({
    running,
    startedAt,
    heartbeatAt: new Date(dependencies.now()).toISOString(),
    processed: counters.processed,
    retried: counters.retried,
    failed: counters.failed,
    lastSuccessAt: counters.lastSuccessAt,
    lastErrorCode: counters.lastErrorCode
  });

  const reportHealth = () => {
    const snapshot = getHealthSnapshot();
    if (!dependencies.reportHealth) return;
    healthReportChain = healthReportChain
      .then(() => dependencies.reportHealth?.(snapshot))
      .catch((error: unknown) => {
        dependencies.logger.warn(
          `[date-companion-memory-bridge] health_report_failed error_name=${
            error instanceof Error ? error.name : "unknown"
          }`
        );
      });
  };

  const settleRunPromise = (error?: unknown) => {
    if (runPromiseSettled) return;
    runPromiseSettled = true;
    if (error === undefined) resolveRunPromise?.();
    else rejectRunPromise?.(error);
  };

  const closeOwnedDatabases = async () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    let closeError: unknown;
    try {
      if (memoryDatabase.open) memoryDatabase.close();
    } catch (error) {
      closeError = error;
    }
    try {
      if (dateCompanionDatabase.open) dateCompanionDatabase.close();
    } catch (error) {
      closeError ??= error;
    } finally {
      if (activeRuntime === runtime) activeRuntime = null;
    }
    if (closeError !== undefined) throw closeError;
  };

  const runTick = async () => {
    const report = emptyPollReport();
    dependencies.logger.info(
      `[date-companion-memory-bridge] tick_started processed=0 state=running batch_limit=${config.batchSize}`
    );
    for (let index = 0; index < config.batchSize; index += 1) {
      if (closing) {
        report.stopped = true;
        break;
      }
      try {
        const result = await dependencies.processNext({
          dateCompanionDatabase,
          memoryDatabase,
          now: new Date(dependencies.now()).toISOString(),
          leaseMs: config.leaseMs
        });
        if (!result) {
          report.idle = true;
          consecutiveRetryableFailures = 0;
          break;
        }
        report.handled += 1;
        report.completed += 1;
        counters.processed += 1;
        counters.lastSuccessAt = new Date(dependencies.now()).toISOString();
        counters.lastErrorCode = null;
        consecutiveRetryableFailures = 0;
        dependencies.logger.info(
          `[date-companion-memory-bridge] processed=${report.handled} state=completed`
        );
        reportHealth();
      } catch (error) {
        const errorCode = safeErrorCode(error);
        report.handled += 1;
        counters.lastErrorCode = errorCode;
        if (
          error instanceof DcConflictError
          && error.code !== "memory_bridge_claim_lost"
        ) {
          report.needsReview += 1;
          consecutiveRetryableFailures = 0;
          dependencies.logger.warn(
            `[date-companion-memory-bridge] processed=${report.handled} state=needs_review error_code=${errorCode}`
          );
          reportHealth();
          continue;
        }
        report.retryableFailed += 1;
        counters.failed += 1;
        counters.retried += 1;
        consecutiveRetryableFailures += 1;
        dependencies.logger.warn(
          `[date-companion-memory-bridge] processed=${report.handled} state=retryable_failed error_code=${errorCode}`
        );
        reportHealth();
        // claimNext() will select this retryable row again. Stop this tick so a
        // single failure cannot consume the whole batch or inflate attempts.
        break;
      }
    }
    dependencies.logger.info(
      `[date-companion-memory-bridge] tick_finished processed=${report.handled} state=${
        report.stopped ? "stopped" : report.retryableFailed > 0 ? "retry_wait" : report.idle ? "idle" : "bounded"
      }`
    );
    reportHealth();
    return report;
  };

  const finalizeAfterInFlight = () => {
    if (!closing || resourcesClosed) return;
    void closeOwnedDatabases().catch((error: unknown) => {
      dependencies.logger.error(
        `[date-companion-memory-bridge] resource_close_failed error_name=${
          error instanceof Error ? error.name : "unknown"
        }`
      );
    });
  };

  const pollNow = () => {
    if (closing) return Promise.resolve(emptyPollReport(true));
    if (inFlight) return inFlight;
    const current = runTick();
    inFlight = current;
    void current.then(
      () => {
        if (inFlight === current) inFlight = null;
        finalizeAfterInFlight();
      },
      () => {
        if (inFlight === current) inFlight = null;
        finalizeAfterInFlight();
      }
    );
    return current;
  };

  const stopUnexpectedly = async (error: unknown) => {
    if (closing) return;
    closing = true;
    running = false;
    if (scheduledTimer) {
      clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
    counters.failed += 1;
    counters.lastErrorCode = safeErrorCode(error);
    dependencies.logger.error(
      `[date-companion-memory-bridge] runtime_stopped error_name=${
        error instanceof Error ? error.name : "unknown"
      }`
    );
    reportHealth();
    try {
      if (!inFlight) await closeOwnedDatabases();
    } catch (closeError) {
      dependencies.logger.error(
        `[date-companion-memory-bridge] resource_close_failed error_name=${
          closeError instanceof Error ? closeError.name : "unknown"
        }`
      );
    } finally {
      settleRunPromise(error);
    }
  };

  const scheduleNext = (delayMs: number) => {
    if (closing || scheduledTimer) return;
    scheduledTimer = setTimeout(() => {
      scheduledTimer = null;
      void pollNow()
        .then((report) => {
          if (closing) return;
          const delay = report.retryableFailed > 0
            ? retryDelayMs(consecutiveRetryableFailures, config)
            : !report.idle && report.handled >= config.batchSize
              ? 0
              : config.pollIntervalMs;
          scheduleNext(delay);
        })
        .catch((error: unknown) => void stopUnexpectedly(error));
    }, delayMs);
    unrefTimer(scheduledTimer);
  };

  const waitForDrain = (
    current: Promise<DateCompanionMemoryBridgePollReport>
  ): Promise<boolean> => new Promise((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(timedOut);
    };
    const timer = setTimeout(() => finish(true), config.shutdownDrainTimeoutMs);
    void current.then(() => finish(false), () => finish(false));
  });

  const runtime: DateCompanionMemoryBridgeRuntime = {
    config,
    runPromise,
    pollNow,
    getHealthSnapshot,
    close() {
      closePromise ??= (async () => {
        closing = true;
        running = false;
        if (scheduledTimer) {
          clearTimeout(scheduledTimer);
          scheduledTimer = null;
        }
        dependencies.logger.info(
          "[date-companion-memory-bridge] shutdown_started state=draining"
        );
        reportHealth();
        const current = inFlight;
        const timedOut = current ? await waitForDrain(current) : false;
        try {
          if (timedOut) {
            counters.failed += 1;
            counters.lastErrorCode = "memory_bridge_shutdown_timeout";
            dependencies.logger.warn(
              "[date-companion-memory-bridge] shutdown_timed_out lease_preserved=true"
            );
            reportHealth();
          } else {
            await closeOwnedDatabases();
          }
        } finally {
          settleRunPromise();
        }
        dependencies.logger.info(
          `[date-companion-memory-bridge] shutdown_completed timed_out=${timedOut}`
        );
        return { timedOut };
      })();
      return closePromise;
    }
  };

  activeRuntime = runtime;
  void reportHealth();
  scheduleNext(options.startImmediately === false ? config.pollIntervalMs : 0);
  return runtime;
}

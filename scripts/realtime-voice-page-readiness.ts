export const DEFAULT_REALTIME_VOICE_PAGE_READY_TIMEOUT_MS = 20_000;
export const DEFAULT_REALTIME_VOICE_PAGE_STABILITY_MS = 750;
export const DEFAULT_REALTIME_VOICE_PAGE_POLL_MS = 50;

export type RealtimeVoicePageObservation = {
  atMs: number;
  pathname: string;
  documentReady: boolean;
  authenticatedShellReady: boolean;
  navigationSequence: number;
};

export type RealtimeVoicePagePreparationAdapter = {
  now(): number;
  observe(): Promise<RealtimeVoicePageObservation>;
  wait(delayMs: number): Promise<void>;
  installHarness(): Promise<void>;
  startProviderSession(): Promise<void>;
  isNavigationError(error: unknown): boolean;
};

export type RealtimeVoicePagePreparationOptions = {
  expectedPathname: string;
  timeoutMs?: number;
  stabilityWindowMs?: number;
  pollIntervalMs?: number;
};

export class RealtimeVoicePagePreparationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RealtimeVoicePagePreparationError";
  }
}

export function isExecutionContextDestroyed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|cannot find context with specified id|most likely because of a navigation/iu
    .test(message);
}

export async function prepareRealtimeVoicePageAndStartSession(
  adapter: RealtimeVoicePagePreparationAdapter,
  options: RealtimeVoicePagePreparationOptions
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REALTIME_VOICE_PAGE_READY_TIMEOUT_MS;
  const stabilityWindowMs =
    options.stabilityWindowMs ?? DEFAULT_REALTIME_VOICE_PAGE_STABILITY_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_REALTIME_VOICE_PAGE_POLL_MS;
  const startedAtMs = adapter.now();
  const deadlineMs = startedAtMs + timeoutMs;
  let candidateSinceMs: number | null = null;
  let candidateNavigationSequence: number | null = null;
  let harnessNavigationSequence: number | null = null;
  let lastObservation: RealtimeVoicePageObservation | null = null;
  let navigationChanges = 0;
  let harnessInstallCount = 0;
  let providerSessionStartAttempts = 0;

  const snapshot = () => ({
    navigationChanges,
    harnessInstallCount,
    providerSessionStartAttempts,
    lastObservation
  });

  const timeoutError = () => new RealtimeVoicePagePreparationError(
    lastObservation && lastObservation.pathname !== options.expectedPathname
      ? "page_ready_wrong_final_route"
      : "page_ready_timeout"
  );

  const waitForObservation = async () => {
    while (adapter.now() <= deadlineMs) {
      let observation: RealtimeVoicePageObservation;
      try {
        observation = await adapter.observe();
      } catch (error) {
        if (!adapter.isNavigationError(error)) throw error;
        candidateSinceMs = null;
        candidateNavigationSequence = null;
        navigationChanges += 1;
        await adapter.wait(pollIntervalMs);
        continue;
      }

      if (
        lastObservation &&
        observation.navigationSequence !== lastObservation.navigationSequence
      ) {
        navigationChanges += 1;
      }
      lastObservation = observation;
      const ready =
        observation.pathname === options.expectedPathname &&
        observation.documentReady &&
        observation.authenticatedShellReady;
      if (!ready) {
        candidateSinceMs = null;
        candidateNavigationSequence = null;
        await adapter.wait(pollIntervalMs);
        continue;
      }

      if (candidateNavigationSequence !== observation.navigationSequence) {
        candidateNavigationSequence = observation.navigationSequence;
        candidateSinceMs = observation.atMs;
      }
      if (
        candidateSinceMs !== null &&
        observation.atMs - candidateSinceMs >= stabilityWindowMs
      ) {
        return observation;
      }
      await adapter.wait(pollIntervalMs);
    }
    throw timeoutError();
  };

  while (adapter.now() <= deadlineMs) {
    const stableBeforeInstall = await waitForObservation();
    try {
      await adapter.installHarness();
    } catch (error) {
      if (!adapter.isNavigationError(error)) throw error;
      navigationChanges += 1;
      candidateSinceMs = null;
      candidateNavigationSequence = null;
      harnessNavigationSequence = null;
      await adapter.wait(pollIntervalMs);
      continue;
    }
    harnessInstallCount += 1;
    harnessNavigationSequence = stableBeforeInstall.navigationSequence;

    // A second full stability window proves that installing the feeder did not
    // race with a late auth/navigation transition. No Provider work has begun.
    candidateSinceMs = stableBeforeInstall.atMs;
    candidateNavigationSequence = stableBeforeInstall.navigationSequence;
    const stableAfterInstall = await waitForObservation();
    if (stableAfterInstall.navigationSequence !== harnessNavigationSequence) {
      harnessNavigationSequence = null;
      candidateSinceMs = null;
      candidateNavigationSequence = null;
      continue;
    }

    providerSessionStartAttempts += 1;
    try {
      await adapter.startProviderSession();
    } catch (error) {
      // Once startProviderSession has been attempted, the Provider budget may
      // already be consumed. Even a navigation error is terminal and cannot be
      // retried automatically.
      throw new RealtimeVoicePagePreparationError(
        adapter.isNavigationError(error)
          ? "page_navigation_after_provider_session_start"
          : error instanceof Error
            ? error.message
            : "provider_session_start_failed"
      );
    }
    return {
      readyAtMs: stableAfterInstall.atMs,
      navigationSequence: stableAfterInstall.navigationSequence,
      ...snapshot()
    };
  }

  throw timeoutError();
}

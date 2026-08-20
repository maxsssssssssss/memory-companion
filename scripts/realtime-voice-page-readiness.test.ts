import { describe, expect, it, vi } from "vitest";

import {
  prepareRealtimeVoicePageAndStartSession,
  type RealtimeVoicePageObservation
} from "./realtime-voice-page-readiness";

type FakeStep = Omit<RealtimeVoicePageObservation, "atMs"> & {
  fromMs: number;
  observationError?: Error;
};

function fakeAdapter(
  steps: FakeStep[],
  options: {
    installErrors?: Array<Error | undefined>;
    startError?: Error;
  } = {}
) {
  let nowMs = 0;
  let installAttempt = 0;
  const installHarness = vi.fn(async () => {
    const error = options.installErrors?.[installAttempt];
    installAttempt += 1;
    if (error) throw error;
  });
  const startProviderSession = vi.fn(async () => {
    if (options.startError) throw options.startError;
  });
  return {
    adapter: {
      now: () => nowMs,
      observe: async () => {
        const step = [...steps].reverse().find((entry) => entry.fromMs <= nowMs)!;
        if (step.observationError) throw step.observationError;
        return {
          atMs: nowMs,
          pathname: step.pathname,
          documentReady: step.documentReady,
          authenticatedShellReady: step.authenticatedShellReady,
          navigationSequence: step.navigationSequence
        };
      },
      wait: async (delayMs: number) => {
        nowMs += delayMs;
      },
      installHarness,
      startProviderSession,
      isNavigationError: (error: unknown) =>
        error instanceof Error && error.message.includes("Execution context was destroyed")
    },
    installHarness,
    startProviderSession
  };
}

const ready = (fromMs: number, navigationSequence: number): FakeStep => ({
  fromMs,
  pathname: "/date-companion/modules",
  documentReady: true,
  authenticatedShellReady: true,
  navigationSequence
});

const options = {
  expectedPathname: "/date-companion/modules",
  timeoutMs: 3_000,
  stabilityWindowMs: 200,
  pollIntervalMs: 50
};

describe("realtime voice runner page readiness", () => {
  it("waits through one redirect and two stability windows before starting one session", async () => {
    const fake = fakeAdapter([
      {
        fromMs: 0,
        pathname: "/date-companion",
        documentReady: true,
        authenticatedShellReady: false,
        navigationSequence: 1
      },
      ready(150, 2)
    ]);

    const result = await prepareRealtimeVoicePageAndStartSession(fake.adapter, options);

    expect(result.readyAtMs).toBeGreaterThanOrEqual(550);
    expect(result.navigationSequence).toBe(2);
    expect(fake.installHarness).toHaveBeenCalledTimes(1);
    expect(fake.startProviderSession).toHaveBeenCalledTimes(1);
  });

  it("waits through consecutive redirects without consuming the session budget early", async () => {
    const fake = fakeAdapter([
      {
        fromMs: 0,
        pathname: "/date-companion",
        documentReady: false,
        authenticatedShellReady: false,
        navigationSequence: 1
      },
      {
        fromMs: 100,
        pathname: "/date-companion/a",
        documentReady: false,
        authenticatedShellReady: false,
        navigationSequence: 2
      },
      ready(300, 3)
    ]);

    await prepareRealtimeVoicePageAndStartSession(fake.adapter, options);

    expect(fake.installHarness).toHaveBeenCalledTimes(1);
    expect(fake.startProviderSession).toHaveBeenCalledTimes(1);
  });

  it("fails a redirect timeout before installing the harness or starting a session", async () => {
    const fake = fakeAdapter(Array.from({ length: 20 }, (_, index) => ({
      fromMs: index * 50,
      pathname: index % 2 === 0 ? "/date-companion" : "/date-companion/a",
      documentReady: false,
      authenticatedShellReady: false,
      navigationSequence: index + 1
    })));

    await expect(prepareRealtimeVoicePageAndStartSession(fake.adapter, {
      ...options,
      timeoutMs: 700
    })).rejects.toMatchObject({
      code: "page_ready_wrong_final_route"
    });
    expect(fake.installHarness).not.toHaveBeenCalled();
    expect(fake.startProviderSession).not.toHaveBeenCalled();
  });

  it("fails a stable wrong final route without consuming the session budget", async () => {
    const fake = fakeAdapter([{
      fromMs: 0,
      pathname: "/date-companion/a",
      documentReady: true,
      authenticatedShellReady: true,
      navigationSequence: 1
    }]);

    await expect(prepareRealtimeVoicePageAndStartSession(fake.adapter, {
      ...options,
      timeoutMs: 500
    })).rejects.toMatchObject({
      code: "page_ready_wrong_final_route"
    });
    expect(fake.installHarness).not.toHaveBeenCalled();
    expect(fake.startProviderSession).not.toHaveBeenCalled();
  });

  it("reinstalls the harness if a page that looked ready navigates before Provider start", async () => {
    const fake = fakeAdapter(
      [ready(0, 1), ready(450, 2)],
      {
        installErrors: [new Error("Execution context was destroyed"), undefined]
      }
    );

    const result = await prepareRealtimeVoicePageAndStartSession(fake.adapter, options);

    expect(result.navigationSequence).toBe(2);
    expect(fake.installHarness).toHaveBeenCalledTimes(2);
    expect(fake.startProviderSession).toHaveBeenCalledTimes(1);
  });

  it("invalidates an installed harness when the ready page navigates during the final window", async () => {
    const fake = fakeAdapter([
      ready(0, 1),
      ready(300, 2)
    ]);

    const result = await prepareRealtimeVoicePageAndStartSession(fake.adapter, options);

    expect(result.navigationSequence).toBe(2);
    expect(fake.installHarness).toHaveBeenCalledTimes(2);
    expect(fake.startProviderSession).toHaveBeenCalledTimes(1);
  });

  it("treats context destruction while observing as safe only before session start", async () => {
    const fake = fakeAdapter([
      {
        ...ready(0, 1),
        observationError: new Error("Execution context was destroyed")
      },
      ready(100, 2)
    ]);

    await prepareRealtimeVoicePageAndStartSession(fake.adapter, options);

    expect(fake.startProviderSession).toHaveBeenCalledTimes(1);
  });

  it("fails closed and never retries when navigation destroys context after start", async () => {
    const fake = fakeAdapter([ready(0, 1)], {
      startError: new Error("Execution context was destroyed")
    });

    await expect(
      prepareRealtimeVoicePageAndStartSession(fake.adapter, options)
    ).rejects.toMatchObject({
      code: "page_navigation_after_provider_session_start"
    });
    expect(fake.installHarness).toHaveBeenCalledTimes(1);
    expect(fake.startProviderSession).toHaveBeenCalledTimes(1);
  });
});

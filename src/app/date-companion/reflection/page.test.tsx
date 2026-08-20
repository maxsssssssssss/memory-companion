import { afterEach, describe, expect, it, vi } from "vitest";

import DailyReflectionPage from "./page";

const navigationMocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("next/navigation", () => ({
  notFound: navigationMocks.notFound
}));

vi.mock("@/components/daily-reflection/daily-reflection-shell", () => ({
  DailyReflectionShell: (props: {
    browserRecordingEnabled: boolean;
    initialReflectionId?: string | null;
    toySyncEnabled: boolean;
  }) => ({
    type: "daily-reflection-shell",
    props,
    key: null
  })
}));

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
const originalBrowserRecordingFlag =
  process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED;
const originalToySyncFlag = process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED;
const originalSharedToySyncFlag = process.env.DAILY_BRIEF_TOY_SYNC_ENABLED;

describe("Daily Reflection page", () => {
  afterEach(() => {
    navigationMocks.notFound.mockClear();
    if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
    if (originalBrowserRecordingFlag === undefined) {
      delete process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED;
    } else {
      process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED =
        originalBrowserRecordingFlag;
    }
    if (originalToySyncFlag === undefined) {
      delete process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED;
    } else {
      process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED = originalToySyncFlag;
    }
    if (originalSharedToySyncFlag === undefined) {
      delete process.env.DAILY_BRIEF_TOY_SYNC_ENABLED;
    } else {
      process.env.DAILY_BRIEF_TOY_SYNC_ENABLED = originalSharedToySyncFlag;
    }
  });

  it("is a server-side 404 when uploads are disabled even if browser recording is enabled", async () => {
    delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED = "true";

    await expect(DailyReflectionPage({ searchParams: Promise.resolve({}) }))
      .rejects.toThrow("NEXT_NOT_FOUND");
    expect(navigationMocks.notFound).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, false],
    ["false", false],
    ["true", true]
  ] as const)(
    "passes browser recording flag %s through the server page as %s",
    async (flag, expected) => {
      process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
      process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED = "true";
      delete process.env.DAILY_BRIEF_TOY_SYNC_ENABLED;
      if (flag === undefined) {
        delete process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED;
      } else {
        process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED = flag;
      }

      const element = await DailyReflectionPage({ searchParams: Promise.resolve({}) });
      expect(element.props).toMatchObject({
        browserRecordingEnabled: expected,
        initialReflectionId: null,
        toySyncEnabled: true
      });
    }
  );

  it("passes only a single string reflection id to the internal shell when enabled", async () => {
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    delete process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED;
    delete process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED;
    delete process.env.DAILY_BRIEF_TOY_SYNC_ENABLED;

    const element = await DailyReflectionPage({
      searchParams: Promise.resolve({ reflectionId: "  reflection-1  " })
    });
    expect(element.props.initialReflectionId).toBe("reflection-1");
    expect(element.props.browserRecordingEnabled).toBe(false);
    expect(element.props.toySyncEnabled).toBe(false);

    const arrayElement = await DailyReflectionPage({
      searchParams: Promise.resolve({ reflectionId: ["reflection-1", "reflection-2"] })
    });
    expect(arrayElement.props.initialReflectionId).toBeNull();
  });
});

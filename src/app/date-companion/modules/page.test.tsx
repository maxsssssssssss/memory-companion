import { afterEach, describe, expect, it, vi } from "vitest";

import DateCompanionModulesPage from "./page";

vi.mock("@/components/date-companion/date-companion-shell", () => ({
  DateCompanionShell: (props: { dailyReflectionEnabled?: boolean; entry: string }) => ({
    type: "date-companion-shell",
    props,
    key: null
  })
}));

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
const originalBrowserRecordingFlag =
  process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED;

describe("Date Companion modules page", () => {
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
    if (originalBrowserRecordingFlag === undefined) {
      delete process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED;
    } else {
      process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED =
        originalBrowserRecordingFlag;
    }
  });

  it.each([
    [undefined, undefined, false],
    ["false", "true", false],
    ["true", undefined, true],
    ["true", "false", true],
    ["true", "true", true]
  ] as const)(
    "passes upload flag %s with browser flag %s through the server shell as %s",
    (uploadFlag, browserRecordingFlag, expected) => {
      if (uploadFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
      else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = uploadFlag;
      if (browserRecordingFlag === undefined) {
        delete process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED;
      } else {
        process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED = browserRecordingFlag;
      }

      const page = DateCompanionModulesPage();
      const shell = page.props.children;
      expect(shell.props).toMatchObject({
        entry: "modules",
        dailyReflectionEnabled: expected
      });
    }
  );
});

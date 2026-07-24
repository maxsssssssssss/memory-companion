// @vitest-environment node

import { describe, expect, it } from "vitest";

import { parseDailyBriefReplayArgs } from "./replay-cli";

const baseArgs = [
  "--upload-id",
  "retained_upload_1",
  "--data-dir",
  ".data/evaluation/retained/runtime",
  "--report",
  ".data/evaluation/daily-brief-replay-v1/report.json"
];

describe("Daily Brief-only replay CLI safety gates", () => {
  it("defaults to offline replay when no remote option is supplied", () => {
    expect(parseDailyBriefReplayArgs(baseArgs, {})).toEqual({
      uploadId: "retained_upload_1",
      dataDir: ".data/evaluation/retained/runtime",
      reportPath: ".data/evaluation/daily-brief-replay-v1/report.json",
      remote: false
    });
  });

  it("does not enable remote calls from the environment flag alone", () => {
    expect(
      parseDailyBriefReplayArgs(baseArgs, { RUN_DAILY_BRIEF_REMOTE_VERIFY: "1" })
    ).toMatchObject({ remote: false });
  });

  it("rejects --remote unless RUN_DAILY_BRIEF_REMOTE_VERIFY is exactly 1", () => {
    expect(() => parseDailyBriefReplayArgs([...baseArgs, "--remote"], {})).toThrow(
      /RUN_DAILY_BRIEF_REMOTE_VERIFY=1/u
    );
    expect(() =>
      parseDailyBriefReplayArgs([...baseArgs, "--remote"], {
        RUN_DAILY_BRIEF_REMOTE_VERIFY: "true"
      })
    ).toThrow(/RUN_DAILY_BRIEF_REMOTE_VERIFY=1/u);
  });

  it("enables remote replay only when both explicit gates are present", () => {
    expect(
      parseDailyBriefReplayArgs([...baseArgs, "--remote"], {
        RUN_DAILY_BRIEF_REMOTE_VERIFY: "1"
      })
    ).toEqual({
      uploadId: "retained_upload_1",
      dataDir: ".data/evaluation/retained/runtime",
      reportPath: ".data/evaluation/daily-brief-replay-v1/report.json",
      remote: true
    });
  });

  it("supports an explicit retained user and rejects unknown arguments", () => {
    expect(parseDailyBriefReplayArgs([...baseArgs, "--user-id", "retained_user_1"], {})).toMatchObject({
      userId: "retained_user_1"
    });
    expect(() => parseDailyBriefReplayArgs([...baseArgs, "--overwrite"], {})).toThrow(
      /Unknown argument.*--overwrite/u
    );
  });

  it("requires every retained replay coordinate", () => {
    expect(() => parseDailyBriefReplayArgs(["--upload-id", "retained_upload_1"], {})).toThrow(
      /--data-dir|--report/u
    );
  });
});

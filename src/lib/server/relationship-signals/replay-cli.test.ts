// @vitest-environment node

import { describe, expect, it } from "vitest";

import { parseRelationshipReplayArgs } from "./replay-cli";

const baseArgs = [
  "--upload-id",
  "retained_upload_1",
  "--data-dir",
  ".data/evaluation/retained/runtime",
  "--report",
  ".data/evaluation/relationship-latency-v2/report.json"
];

describe("Relationship-only replay CLI safety gates", () => {
  it("defaults to offline replay when no remote option is supplied", () => {
    expect(parseRelationshipReplayArgs(baseArgs, {})).toEqual({
      uploadId: "retained_upload_1",
      dataDir: ".data/evaluation/retained/runtime",
      reportPath: ".data/evaluation/relationship-latency-v2/report.json",
      remote: false
    });
  });

  it("does not enable remote calls from the environment flag alone", () => {
    expect(
      parseRelationshipReplayArgs(baseArgs, { RUN_RELATIONSHIP_REMOTE_VERIFY: "1" })
    ).toMatchObject({ remote: false });
  });

  it("rejects --remote unless RUN_RELATIONSHIP_REMOTE_VERIFY is exactly 1", () => {
    expect(() => parseRelationshipReplayArgs([...baseArgs, "--remote"], {})).toThrow(
      /RUN_RELATIONSHIP_REMOTE_VERIFY=1/u
    );
    expect(() =>
      parseRelationshipReplayArgs([...baseArgs, "--remote"], {
        RUN_RELATIONSHIP_REMOTE_VERIFY: "true"
      })
    ).toThrow(/RUN_RELATIONSHIP_REMOTE_VERIFY=1/u);
  });

  it("enables one remote replay only when both explicit gates are present", () => {
    expect(
      parseRelationshipReplayArgs([...baseArgs, "--remote"], {
        RUN_RELATIONSHIP_REMOTE_VERIFY: "1"
      })
    ).toEqual({
      uploadId: "retained_upload_1",
      dataDir: ".data/evaluation/retained/runtime",
      reportPath: ".data/evaluation/relationship-latency-v2/report.json",
      remote: true
    });
  });

  it("requires all retained replay coordinates and rejects unknown arguments", () => {
    expect(() => parseRelationshipReplayArgs(["--upload-id", "retained_upload_1"], {})).toThrow(
      /--data-dir|--report/u
    );
    expect(() => parseRelationshipReplayArgs([...baseArgs, "--overwrite"], {})).toThrow(
      /Unknown argument.*--overwrite/u
    );
  });
});

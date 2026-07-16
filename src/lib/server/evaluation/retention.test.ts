// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  EVALUATION_DELETE_CONFIRMATION_HEADER,
  EVALUATION_RETENTION_REQUEST_HEADER,
  isConfirmedEvaluationDelete,
  isEvaluationMode,
  isEvaluationRetentionUpload,
  shouldMarkUploadForEvaluationRetention
} from "./retention";

describe("evaluation retention mode", () => {
  it.each([undefined, "", "false", "1", "yes", "invalid"])(
    "keeps retention disabled for %s",
    (value) => {
      expect(isEvaluationMode(value)).toBe(false);
    }
  );

  it("only enables retention for an explicit case-insensitive true value", () => {
    expect(isEvaluationMode("true")).toBe(true);
    expect(isEvaluationMode(" TRUE ")).toBe(true);
  });

  it("requires an explicit confirmation header before deleting retained data", () => {
    expect(isConfirmedEvaluationDelete(new Request("http://localhost/api/uploads/upload_1"))).toBe(false);
    expect(isConfirmedEvaluationDelete(new Request("http://localhost/api/uploads/upload_1", {
      headers: { [EVALUATION_DELETE_CONFIRMATION_HEADER]: "true" }
    }))).toBe(true);
  });

  it("requires both the server feature flag and per-upload opt-in", () => {
    const optedIn = new Request("http://localhost/api/uploads", {
      headers: { [EVALUATION_RETENTION_REQUEST_HEADER]: "true" }
    });
    const ordinary = new Request("http://localhost/api/uploads");

    expect(shouldMarkUploadForEvaluationRetention(optedIn, "false")).toBe(false);
    expect(shouldMarkUploadForEvaluationRetention(ordinary, "true")).toBe(false);
    expect(shouldMarkUploadForEvaluationRetention(optedIn, "true")).toBe(true);
  });

  it("only protects uploads explicitly marked while evaluation mode is enabled", () => {
    expect(isEvaluationRetentionUpload({}, "true")).toBe(false);
    expect(isEvaluationRetentionUpload({ evaluationRetention: true }, "false")).toBe(false);
    expect(isEvaluationRetentionUpload({ evaluationRetention: true }, "true")).toBe(true);
  });
});

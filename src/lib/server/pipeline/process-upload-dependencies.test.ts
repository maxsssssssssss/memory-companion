import { describe, expect, it } from "vitest";

import { assertProcessUploadDependenciesAllowed } from "./process-upload";

describe("processUpload development dependencies", () => {
  it("rejects custom providers in production", () => {
    expect(() =>
      assertProcessUploadDependenciesAllowed(
        {
          now: () => "2026-07-14T00:00:00.000Z"
        },
        "production"
      )
    ).toThrow("only available in development or test");
  });

  it("allows custom providers in development and test", () => {
    const dependencies = { now: () => "2026-07-14T00:00:00.000Z" };

    expect(() => assertProcessUploadDependenciesAllowed(dependencies, "development")).not.toThrow();
    expect(() => assertProcessUploadDependenciesAllowed(dependencies, "test")).not.toThrow();
  });

  it("does not affect production when no custom providers are supplied", () => {
    expect(() => assertProcessUploadDependenciesAllowed(undefined, "production")).not.toThrow();
  });
});

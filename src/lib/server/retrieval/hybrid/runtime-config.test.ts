// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveQaHybridRetrievalMode } from "./runtime-config";

describe("Hybrid QA runtime modes", () => {
  it("preserves the existing Hybrid off-shadow-phase31 modes", () => {
    expect(resolveQaHybridRetrievalMode("off")).toBe("off");
    expect(resolveQaHybridRetrievalMode("shadow")).toBe("shadow");
    expect(resolveQaHybridRetrievalMode("phase31")).toBe("phase31");
  });
});

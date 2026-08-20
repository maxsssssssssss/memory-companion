// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  requireSpokenProjection
} from "./spoken-projection";

describe("requireSpokenProjection", () => {
  it("accepts only the citation-free spoken view", () => {
    expect(requireSpokenProjection("  今天确认了排练安排。  "))
      .toBe("今天确认了排练安排。");
  });

  it.each([
    ["citation", "今天确认了排练安排。[E1]", "citation_residue"],
    ["source metadata", "安排如下。 sourceId=segment_1", "metadata_residue"],
    ["serialized citations", "安排如下。 \"citations\":[]", "metadata_residue"],
    ["unsupported control", "安排\u0000如下。", "unsupported_characters"],
    ["empty", "   ", "empty_text"]
  ] as const)("rejects %s before Provider TTS", (_label, value, reason) => {
    expect(() => requireSpokenProjection(value)).toThrow(
      expect.objectContaining({ reason })
    );
  });
});

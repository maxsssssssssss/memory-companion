import { describe, expect, it } from "vitest";

import { metadata } from "./layout";

describe("Date Companion layout metadata", () => {
  it("uses the independent companion product title", () => {
    expect(metadata.title).toBe("约会陪伴 · Daily Brief");
  });
});

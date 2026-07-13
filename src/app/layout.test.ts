import { describe, expect, it } from "vitest";

import { metadata } from "./layout";

describe("Root layout metadata", () => {
  it("declares the browser tab icon", () => {
    expect(metadata.icons).toEqual({
      icon: "/icon.svg",
      apple: "/icon.svg"
    });
  });
});

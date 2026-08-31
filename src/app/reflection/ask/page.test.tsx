import { describe, expect, it, vi } from "vitest";

import ReflectionAskPage from "./page";

const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  })
}));

vi.mock("next/navigation", () => navigation);

describe("legacy Reflection Ask route", () => {
  it("redirects to the single Together Think workspace in past-clues mode", () => {
    expect(() => ReflectionAskPage()).toThrow(
      "NEXT_REDIRECT:/reflection/think?mode=past_clues"
    );
    expect(navigation.redirect).toHaveBeenCalledTimes(1);
  });
});

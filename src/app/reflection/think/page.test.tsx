import { describe, expect, it } from "vitest";

import ReflectionThinkPage from "./page";

describe("ReflectionThinkPage", () => {
  it("accepts only the fixed mode contract from the URL", async () => {
    const valid = await ReflectionThinkPage({
      searchParams: Promise.resolve({ mode: "past_clues" })
    });
    const invalid = await ReflectionThinkPage({
      searchParams: Promise.resolve({ mode: "private draft text" })
    });

    expect(valid.props.initialMode).toBe("past_clues");
    expect(invalid.props.initialMode).toBeUndefined();
  });
});

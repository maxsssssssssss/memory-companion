import { describe, expect, it } from "vitest";

import { getLocalTimeGreeting } from "./local-time-greeting";

describe("getLocalTimeGreeting", () => {
  it.each([
    [4, "晚上好"],
    [5, "早上好"],
    [8, "早上好"],
    [9, "上午好"],
    [10, "上午好"],
    [11, "中午好"],
    [13, "中午好"],
    [14, "下午好"],
    [17, "下午好"],
    [18, "晚上好"]
  ] as const)("maps local hour %i to %s", (hour, greeting) => {
    expect(getLocalTimeGreeting(hour)).toBe(greeting);
  });
});

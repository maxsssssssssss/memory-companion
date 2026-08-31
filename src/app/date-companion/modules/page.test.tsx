import { describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ redirect }));

import DateCompanionModulesPage from "./page";

describe("legacy Date Companion modules route", () => {
  it("redirects to the one canonical global product entry", () => {
    DateCompanionModulesPage();
    expect(redirect).toHaveBeenCalledWith("/");
  });
});

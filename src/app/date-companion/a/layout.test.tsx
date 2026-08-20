import { describe, expect, it } from "vitest";

import { DateCompanionSessionProvider } from "@/lib/client/date-companion-session-provider";

import DateCompanionAppLayout from "./layout";

describe("Date Companion app layout", () => {
  it("owns the persistent session above the replaceable screen page", () => {
    const child = <div data-testid="screen-page" />;
    const layout = DateCompanionAppLayout({ children: child });

    expect(layout.type).toBe(DateCompanionSessionProvider);
    expect(layout.props.children).toBe(child);
    expect(layout.key).toBeNull();
  });
});

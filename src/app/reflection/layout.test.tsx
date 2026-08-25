import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  browser: false,
  enabled: true,
  toy: false
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("@/lib/server/daily-reflection/runtime-config", () => ({
  isDailyReflectionBrowserRecordingEnabled: () => state.browser,
  isDailyReflectionToySyncEnabled: () => state.toy,
  isDailyReflectionUploadEnabled: () => state.enabled
}));

vi.mock("@/components/daily-reflection/reflection-app-shell", () => ({
  ReflectionAppShell: ({
    browserRecordingEnabled,
    children,
    toySyncEnabled
  }: {
    browserRecordingEnabled: boolean;
    children: ReactNode;
    toySyncEnabled: boolean;
  }) => (
    <div
      data-browser={String(browserRecordingEnabled)}
      data-testid="reflection-shell"
      data-toy={String(toySyncEnabled)}
    >{children}</div>
  )
}));

import ReflectionLayout from "./layout";

beforeEach(() => {
  state.enabled = true;
  state.browser = false;
  state.toy = false;
});

describe("ReflectionLayout", () => {
  it("cannot bypass the main Daily Reflection feature flag", () => {
    state.enabled = false;
    expect(() => ReflectionLayout({ children: <p>私密内容</p> })).toThrow("NEXT_NOT_FOUND");
  });

  it("passes independent browser and toy flags into the only shared shell", () => {
    state.browser = true;
    state.toy = false;
    render(ReflectionLayout({ children: <p>页面内容</p> }));

    expect(screen.getByTestId("reflection-shell")).toHaveAttribute("data-browser", "true");
    expect(screen.getByTestId("reflection-shell")).toHaveAttribute("data-toy", "false");
    expect(screen.getByText("页面内容")).toBeVisible();
  });
});

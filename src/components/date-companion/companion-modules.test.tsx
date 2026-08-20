import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanionModules } from "./companion-modules";

describe("CompanionModules", () => {
  afterEach(cleanup);

  it("keeps the everyday card unavailable and unchanged when Daily Reflection is off", () => {
    render(<CompanionModules dailyReflectionEnabled={false} onLogout={vi.fn()} userLabel="user@example.com" />);

    expect(screen.getByRole("heading", { name: "日常闲聊" })).toBeInTheDocument();
    expect(screen.getAllByText("暂不可进入", { selector: "span" })).toHaveLength(2);
    expect(screen.queryByRole("link", { name: /日常复盘/u })).not.toBeInTheDocument();
  });

  it("turns only the third card into the internal Daily Reflection link when enabled", () => {
    render(<CompanionModules dailyReflectionEnabled onLogout={vi.fn()} userLabel="user@example.com" />);

    const reflectionLink = screen.getByRole("link", { name: /日常复盘/u });
    expect(reflectionLink).toHaveAttribute("href", "/date-companion/reflection");
    expect(screen.getByText("先选择一个空间。日常复盘目前仅作内部开放。")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "日常闲聊" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /约会陪伴/u })).toHaveAttribute("href", "/date-companion/a");
  });
});

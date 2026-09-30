import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { productPreferenceKey } from "@/components/product-system/product-preference";
import { ProductCapabilitiesProvider } from "@/components/product-system/product-capabilities";

import { CompanionModules } from "./companion-modules";

describe("CompanionModules", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  it("inherits the enabled Work Review entry from the server capability", () => {
    render(
      <ProductCapabilitiesProvider workReviewEnabled>
        <CompanionModules
          accountId="account_1"
          dailyReflectionEnabled
          onLogout={vi.fn()}
          userLabel="user@example.com"
        />
      </ProductCapabilitiesProvider>
    );

    expect(screen.getByRole("heading", { name: "选择一个空间" })).toBeVisible();
    expect(screen.getByRole("link", { name: /约会陪伴/u })).toHaveAttribute("href", "/date-companion/a");
    expect(screen.getByRole("link", { name: /日常复盘/u })).toHaveAttribute("href", "/reflection");
    expect(screen.getByRole("link", { name: /工作复盘/u })).toHaveAttribute("href", "/work-review");
    expect(screen.queryByText(/统计|最近任务|内部开放/u)).not.toBeInTheDocument();
  });

  it("keeps the Daily Reflection feature flag fail closed", () => {
    render(
      <CompanionModules
        accountId="account_1"
        dailyReflectionEnabled={false}
        onLogout={vi.fn()}
        userLabel="user@example.com"
      />
    );

    expect(screen.queryByRole("link", { name: /日常复盘/u })).not.toBeInTheDocument();
    const reflectionEntry = screen.getByRole("heading", { name: "日常复盘" }).closest("article");
    expect(reflectionEntry).not.toBeNull();
    expect(within(reflectionEntry!).getByText("暂未开放")).toBeVisible();
  });

  it("recovers the last module only inside the current account", async () => {
    window.localStorage.setItem(productPreferenceKey("account_1"), "daily_reflection");
    window.localStorage.setItem(productPreferenceKey("account_2"), "date_companion");
    render(
      <CompanionModules
        accountId="account_1"
        dailyReflectionEnabled
        onLogout={vi.fn()}
        userLabel="user@example.com"
      />
    );

    expect(await screen.findByText("上次使用")).toBeVisible();
    const productSpaces = within(screen.getByRole("region", { name: "产品空间" }));
    expect(productSpaces.getByRole("link", { name: /日常复盘/u })).toHaveTextContent("继续进入");
    expect(productSpaces.getByRole("link", { name: /约会陪伴/u })).not.toHaveTextContent("继续进入");
  });
});

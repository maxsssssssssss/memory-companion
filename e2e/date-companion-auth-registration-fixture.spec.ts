import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const artifactDir = resolve(
  process.env.DATE_COMPANION_E2E_ARTIFACT_DIR ?? "test-results/date-companion-auth-registration"
);
const password = "DateAuth!2026";

function progress(completed: number, total: number, message: string) {
  console.log(`[date-companion-auth-registration] ${completed}/${total} ${message}`);
}

function isLoopbackUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return true;
  return url.hostname === "localhost" || url.hostname === "::1" || url.hostname.startsWith("127.");
}

test("registers, restores, logs out, logs in, and restores again through the formal UI", async ({ page }) => {
  await mkdir(artifactDir, { recursive: true });
  const email = `date-auth-${Date.now()}@example.com`;
  const externalRequests: string[] = [];
  const authRequests: Array<{ method: string; path: string; status: number }> = [];

  page.on("request", (request) => {
    if (!isLoopbackUrl(request.url())) externalRequests.push(request.url());
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/auth/")) {
      authRequests.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    }
  });

  progress(0, 8, "opening the anonymous formal Date Companion entry");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/date-companion");
  await expect(page).toHaveURL(/\/date-companion$/u);
  await expect(page.getByRole("tab", { name: "登录" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "注册" })).toBeVisible();
  progress(1, 8, "login and registration modes are both reachable");

  await page.getByRole("tab", { name: "注册" }).click();
  await expect(page.getByRole("heading", { name: "创建你的空间" })).toBeVisible();
  await expect(page.getByLabel("昵称（可选）")).toBeVisible();
  await expect(page.getByLabel("邀请码")).toBeVisible();
  await page.screenshot({ path: resolve(artifactDir, "registration-1920x1080.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tab", { name: "注册" })).toBeVisible();
  await expect(page.getByLabel("邀请码")).toBeVisible();
  await page.screenshot({ path: resolve(artifactDir, "registration-390x844.png"), fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  progress(2, 8, "desktop and mobile registration controls are visible");

  await page.getByLabel("昵称（可选）").fill("Fixture User");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByLabel("邀请码").fill("wrong-invite");
  await page.getByRole("button", { name: "注册并进入" }).click();
  await expect(page.getByText("邀请码不正确，请重新输入。", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/date-companion$/u);
  await expect(page.getByRole("tab", { name: "注册" })).toHaveAttribute("aria-selected", "true");
  progress(3, 8, "invalid invite remains fail-closed in registration mode");

  await page.getByLabel("昵称（可选）").fill("Fixture User");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByLabel("邀请码").fill("date-e2e");
  await page.getByRole("button", { name: "注册并进入" }).click();
  await expect(page).toHaveURL(/\/date-companion\/modules$/u);
  await expect(page.getByRole("heading", { name: "今天，你想从哪里开始？" })).toBeVisible();
  progress(4, 8, "successful registration established the real session and entered modules");

  await page.reload();
  await expect(page).toHaveURL(/\/date-companion\/modules$/u);
  await expect(page.getByText("Fixture User", { exact: true })).toBeVisible();
  progress(5, 8, "registration session restored after refresh");

  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/date-companion$/u);
  await expect(page.getByRole("tab", { name: "登录" })).toHaveAttribute("aria-selected", "true");
  progress(6, 8, "logout returned to the formal login and registration boundary");

  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/date-companion\/modules$/u);
  await page.reload();
  await expect(page.getByText("Fixture User", { exact: true })).toBeVisible();
  progress(7, 8, "real login and refresh restored the registered account");

  expect(authRequests.filter((request) => request.path === "/api/auth/register" && request.method === "POST"))
    .toEqual([
      { method: "POST", path: "/api/auth/register", status: 403 },
      { method: "POST", path: "/api/auth/register", status: 201 }
    ]);
  expect(authRequests.filter((request) => request.path === "/api/auth/login" && request.method === "POST"))
    .toEqual([{ method: "POST", path: "/api/auth/login", status: 200 }]);
  expect(authRequests.some((request) => request.path === "/api/auth/logout" && request.status === 200)).toBe(true);
  expect(externalRequests).toEqual([]);
  progress(8, 8, "real auth transports and zero external browser requests confirmed");
});

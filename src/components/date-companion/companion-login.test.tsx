import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CompanionLogin, type CompanionAuthMode } from "./companion-login";

function AuthHarness({
  onLogin = vi.fn(),
  onRegister = vi.fn()
}: {
  onLogin?: React.ComponentProps<typeof CompanionLogin>["onLogin"];
  onRegister?: React.ComponentProps<typeof CompanionLogin>["onRegister"];
}) {
  const [mode, setMode] = useState<CompanionAuthMode>("login");
  return (
    <CompanionLogin
      mode={mode}
      onLogin={onLogin}
      onModeChange={setMode}
      onRegister={onRegister}
    />
  );
}

describe("CompanionLogin", () => {
  it("exposes both real auth modes and submits entered login credentials", async () => {
    const onLogin = vi.fn();

    render(<AuthHarness onLogin={onLogin} />);

    expect(screen.getByRole("tab", { name: "登录" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "注册" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /演示/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "  user@example.com  " }
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "real-password" }
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(onLogin).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "real-password"
    });
    await waitFor(() => expect(screen.getByLabelText("密码")).toHaveValue(""));
  });

  it("submits the actual registration contract and clears sensitive fields when modes change", async () => {
    const onRegister = vi.fn(async () => undefined);
    render(<AuthHarness onRegister={onRegister} />);

    fireEvent.click(screen.getByRole("tab", { name: "注册" }));
    expect(screen.getByRole("tab", { name: "注册" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("昵称（可选）")).toBeVisible();
    expect(screen.getByLabelText("邀请码")).toBeVisible();

    fireEvent.change(screen.getByLabelText("昵称（可选）"), { target: { value: "  小林  " } });
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "  new@example.com  " } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password-123" } });
    fireEvent.change(screen.getByLabelText("邀请码"), { target: { value: "  invitation  " } });
    fireEvent.click(screen.getByRole("button", { name: "注册并进入" }));

    await waitFor(() => expect(onRegister).toHaveBeenCalledTimes(1));
    expect(onRegister).toHaveBeenCalledWith({
      email: "new@example.com",
      password: "password-123",
      name: "小林",
      inviteCode: "invitation"
    });
    await waitFor(() => expect(screen.getByLabelText("密码")).toHaveValue(""));
    expect(screen.getByLabelText("邀请码")).toHaveValue("");

    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "another-secret" } });
    fireEvent.change(screen.getByLabelText("邀请码"), { target: { value: "another-invite" } });
    fireEvent.click(screen.getByRole("tab", { name: "登录" }));

    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(screen.queryByLabelText("邀请码")).not.toBeInTheDocument();
  });

  it("prevents duplicate registration submissions while the request is pending", async () => {
    let finish!: () => void;
    const onRegister = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<AuthHarness onRegister={onRegister} />);

    fireEvent.click(screen.getByRole("tab", { name: "注册" }));
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password-123" } });
    fireEvent.change(screen.getByLabelText("邀请码"), { target: { value: "invitation" } });
    const submit = screen.getByRole("button", { name: "注册并进入" });
    fireEvent.click(submit);
    fireEvent.submit(submit.closest("form")!);

    expect(onRegister).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在处理…" })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "注册并进入" })).toBeDisabled());
  });
});

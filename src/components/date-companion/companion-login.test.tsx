import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CompanionLogin } from "./companion-login";

describe("CompanionLogin", () => {
  it("does not expose a demo login and submits the entered account credentials", () => {
    const onLogin = vi.fn();

    render(<CompanionLogin onLogin={onLogin} />);

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
  });
});

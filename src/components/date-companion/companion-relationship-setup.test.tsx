import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CompanionRelationshipSetup } from "./companion-relationship-setup";

describe("CompanionRelationshipSetup", () => {
  it("creates the single relationship without inventing a name", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<CompanionRelationshipSetup onCreate={onCreate} />);

    expect(screen.getByText(/不会根据说话人编号、姓名、性别或对话内容猜测/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始记录这段关系" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(undefined));
  });

  it("trims an optional display name and reports a failed server write", async () => {
    const onCreate = vi.fn(async () => {
      throw new Error("这次没有保存成功");
    });
    render(<CompanionRelationshipSetup onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("称呼（可选）"), { target: { value: "  小满  " } });
    fireEvent.click(screen.getByRole("button", { name: "开始记录这段关系" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("小满"));
    expect(await screen.findByRole("alert")).toHaveTextContent("这次没有保存成功");
  });
});

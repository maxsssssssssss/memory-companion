import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ReflectionConfirmDialog } from "./reflection-confirm-dialog";

function Harness({ onConfirm = vi.fn() }: Readonly<{ onConfirm?: () => void }>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">打开确认</button>
      <ReflectionConfirmDialog
        confirmLabel="确认删除"
        onCancel={() => setOpen(false)}
        onConfirm={onConfirm}
        open={open}
        title="删除原始记录？"
      >
        <p>这会删除原始录音和完整文字记录。</p>
      </ReflectionConfirmDialog>
    </>
  );
}

describe("ReflectionConfirmDialog", () => {
  it("moves focus into the dialog and traps keyboard navigation", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "打开确认" }));

    const confirm = screen.getByRole("button", { name: "确认删除" });
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it("closes on Escape and restores focus to the triggering control", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开确认" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

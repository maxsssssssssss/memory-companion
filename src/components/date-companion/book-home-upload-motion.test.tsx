import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookHome } from "./book-home";

type Props = ComponentProps<typeof BookHome>;
const submit = vi.fn(async () => undefined);
function Home({ initiallyOpen = false, ...overrides }: Partial<Props> & { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [file, setFile] = useState<File | null>(null);
  const [date, setDate] = useState("2026-01-08");
  return <BookHome book={{ lastSaved: null, href: path => path }} currentInteraction={null}
    uploadState={{ status: "idle" }} file={file} fileError={null} recordingDate={date}
    dateMax="2026-11-19" toySelection={null} open={open} onOpenChange={setOpen}
    onDate={setDate} onSelectFile={setFile} onSubmit={submit} statusLabel=""
    homeContent={{ status: "empty" }} relationshipName="虚构人物" onRetryRead={vi.fn()}
    {...overrides} />;
}
const toggle = () => screen.getByRole("button", { name: "上传这次相处的录音" });
const fold = () => document.querySelector<HTMLElement>("[data-upload-fold]")!;
const click = (detail = 1) => fireEvent.click(toggle(), { detail });
let reduced = false;
let listeners: Set<() => void>;
function preference(value: boolean) {
  act(() => { reduced = value; for (const listener of listeners) listener(); });
}
beforeEach(() => {
  reduced = false;
  listeners = new Set();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return reduced; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); submit.mockClear(); });

describe("BookHome upload fold", () => {
  it("repeats three active open/close cycles without replacing the form or submitting", () => {
    render(<Home />);
    const form = document.getElementById("home-upload-form");
    for (let round = 0; round < 3; round++) {
      click();
      expect(fold()).toHaveAttribute("data-open", "true");
      expect(fold()).toHaveAttribute("data-fold-motion", "active");
      expect(fold()).not.toHaveAttribute("inert");
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
      click();
      expect(fold()).toHaveAttribute("data-open", "false");
      expect(fold()).toHaveAttribute("aria-hidden", "true");
      expect(fold()).toHaveAttribute("inert");
      expect(fold()).toHaveAttribute("data-fold-motion", "active");
      expect(toggle()).toHaveFocus();
      expect(document.getElementById("home-upload-form")).toBe(form);
    }
    expect(submit).not.toHaveBeenCalled();
  });
  it("reverses its target immediately and allows another active operation after interruption", () => {
    render(<Home />);
    click(); click(); click();
    expect(fold()).toHaveAttribute("data-open", "true");
    expect(fold()).toHaveAttribute("data-fold-motion", "active");
    fireEvent.focus(screen.getByLabelText("相处日期"));
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    click(); click();
    expect(fold()).toHaveAttribute("data-fold-motion", "active");
  });
  it("keeps the chosen file, date and actual file input while collapsed", () => {
    render(<Home />);
    click();
    const file = new File(["synthetic"], "很长的虚构录音文件名—仅供动效验证.wav", { type: "audio/wav" });
    const input = screen.getByLabelText<HTMLInputElement>("选择录音文件");
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("相处日期"), { target: { value: "2026-01-10" } });
    click(); click();
    expect(screen.getByLabelText<HTMLInputElement>("更换录音文件")).toBe(input);
    expect(input.files?.[0]).toBe(file);
    expect(screen.getByLabelText("相处日期")).toHaveValue("2026-01-10");
    expect(submit).not.toHaveBeenCalled();
  });
  it("keeps keyboard opening and Escape static without consuming the next pointer opening", () => {
    render(<Home />);
    click(0);
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    fireEvent.keyDown(screen.getByLabelText("相处日期"), { key: "Escape" });
    expect(fold()).toHaveAttribute("data-open", "false");
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    expect(toggle()).toHaveFocus();
    click();
    expect(fold()).toHaveAttribute("data-fold-motion", "active");
  });
  it("keeps reduced-motion opening static and permits the next normal active operation", () => {
    preference(true);
    render(<Home />);
    click();
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    preference(false);
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    click(); click();
    expect(fold()).toHaveAttribute("data-fold-motion", "active");
  });
  it("settles a running operation when reduced motion changes, without replaying on preference restore", () => {
    render(<Home />);
    click();
    expect(fold()).toHaveAttribute("data-fold-motion", "active");
    const cancel = vi.fn();
    Object.defineProperty(fold(), "getAnimations", { configurable: true, value: () => [{ cancel }] });
    preference(true);
    expect(fold()).toHaveAttribute("data-open", "true");
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    expect(cancel).toHaveBeenCalledOnce();
    preference(false);
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    click(); click();
    expect(fold()).toHaveAttribute("data-fold-motion", "active");
  });
  it("settles before editing and does not restart for error or background data renders", () => {
    const view = render(<Home />);
    click();
    fireEvent.pointerDown(screen.getByLabelText("相处日期"));
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    view.rerender(<Home fileError="模拟文件说明；请重新选择。" uploadState={{ status: "failed", errorMessage: "模拟读取失败" }} />);
    expect(fold()).toHaveAttribute("data-open", "true");
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    expect(screen.getByText("模拟文件说明；请重新选择。")).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });
  it("does not animate a restored open form or programmatic busy-state changes", () => {
    const view = render(<StrictMode><Home initiallyOpen /></StrictMode>);
    expect(fold()).toHaveAttribute("data-open", "true");
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    view.rerender(<StrictMode><Home initiallyOpen uploadState={{ status: "processing" }} /></StrictMode>);
    expect(fold()).toHaveAttribute("data-open", "false");
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    view.rerender(<StrictMode><Home initiallyOpen /></StrictMode>);
    expect(fold()).toHaveAttribute("data-open", "true");
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    click(); click();
    expect(fold()).toHaveAttribute("data-fold-motion", "active");
  });
  it("cleans preference listeners on leave, and a new mounted page accepts active openings", () => {
    const view = render(<StrictMode><Home /></StrictMode>);
    expect(listeners.size).toBe(1);
    click();
    view.unmount();
    expect(listeners.size).toBe(0);
    render(<Home />);
    click();
    expect(fold()).toHaveAttribute("data-fold-motion", "active");
    fireEvent(window, new Event("pagehide"));
    expect(fold()).toHaveAttribute("data-fold-motion", "static");
    click(); click();
    expect(fold()).toHaveAttribute("data-fold-motion", "active");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { readPersonMaterialWithDeadline } from "./date-companion-read-deadline";

describe("person material read deadline", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([false, true])("bounds a non-settling adapter and fences its late result (fallback=%s)", async fallback => {
    const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    if (fallback) Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
    try {
    const controller = new AbortController();
    let late!: (value: string) => void;
    let requestSignal!: AbortSignal;
    const read = readPersonMaterialWithDeadline(signal => {
      requestSignal = signal;
      return new Promise<string>(resolve => { late = resolve; });
    }, controller.signal, 20);
    await expect(read).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requestSignal.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    late("too late");
    await expect(read).rejects.toMatchObject({ name: "TimeoutError" });
    } finally { if (fallback && timeout) Object.defineProperty(AbortSignal, "timeout", timeout); }
  });
  it("preserves caller cancellation instead of reporting a timeout", async () => {
    const controller = new AbortController();
    const read = readPersonMaterialWithDeadline(() => new Promise(() => {}), controller.signal, 1000);
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });
});

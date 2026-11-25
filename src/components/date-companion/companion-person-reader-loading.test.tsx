import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import { dateCompanionRetainedSourceKey } from "@/lib/client/date-companion-adapter";
import type { SourceRefVM } from "@/lib/domain/date-companion";
import type { DcInteractionDetail } from "@/lib/domain/date-companion-stage2";
import { CompanionPersonReader } from "./companion-person-reader";

const mocks = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock("@/lib/client/date-companion-api", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/client/date-companion-api")>(),
  createDateCompanionApi: () => ({ getInteractionDetail: mocks.detail })
}));
vi.mock("@/lib/client/local-analysis", () => ({ readLocalDayPayload: () => undefined }));

const quote = "虚构验收：一起印过那张照片。";
const stamp = "2026-11-20T12:00:00.000Z";
const evidence = { id: "e1", uploadId: "u1", sourceSegmentId: "s1", recapItemId: "item",
  startSeconds: 10, endSeconds: 14, speakerId: "voice1", quote, createdAt: stamp };
const detail: DcInteractionDetail = {
  id: "r1", relationshipId: "rel", sourceUploadId: "u1", originalName: "虚构验收.wav", recordingDate: "2026-11-20",
  version: 1, status: "confirmed", sourceState: "server_cleaned", createdAt: stamp, updatedAt: stamp, confirmedAt: stamp,
  participants: [{ speakerId: "voice1", role: "self", confirmedAt: stamp }],
  recapItems: [{ id: "item", interactionId: "r1", kind: "moment", proposedText: "试印", displayedText: "共同印过",
    disposition: "kept", version: 1, sortOrder: 0, evidence: [evidence] }],
  memoryBridge: { status: "completed", retryable: false, updatedAt: stamp, attemptCount: 1 }
};
const retainedKey = dateCompanionRetainedSourceKey("u1", "s1");
const source = { id: "e1", uploadId: "u1", segmentIds: ["s1"], recordingDate: "2026-11-20", quote,
  presentation: "direct_quote", memorySubject: "both" } as SourceRefVM;
function session(account="fictional-reader") {
  return {
    auth: { status: "authenticated", user: { id: account } },
    relationshipState: { status: "ready", relationship: { id: "rel" } },
    memoryBridgeState: { status: "ready", people: [{ id: "person", explicitlyConfirmed: true }],
      mapping: { status: "confirmed", version: 1, companionPersonId: "person" },
      memoryRetainedSourceKeys: [retainedKey], retainedSubjects: { [retainedKey]: "both" } },
    viewModel: { recap: { history: [{ sourceUploadId: "u1", relationshipInteractionId: "r1", title: "虚构见面" }] } },
    ensureMemoryBridgeLoaded: vi.fn(async () => undefined)
  } as unknown as DateCompanionSessionValue;
}
function deferred<T>() {
  let resolve!: (value:T) => void, reject!: (reason:unknown) => void;
  const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; });
  return { promise, resolve, reject };
}
const base = { personId: "person", personName: "虚构小榆", currentPerson: true,
  material: { id: "material", sources: [source] }, fullId: null, onFull: vi.fn(), onBack: vi.fn() };
const port = () => document.querySelector<HTMLElement>("[data-insert-scroll]")!;

describe("person source admission loading handoff", () => {
  beforeEach(() => {
    mocks.detail.mockReset(); history.replaceState({}, "", location.pathname);
    vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: false }));
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable:true, value:function(this:HTMLDialogElement){this.open=true;} });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable:true, value:function(this:HTMLDialogElement){this.open=false;} });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("shows quote, attribution and action placeholders without unverified words, then fills the same sheet immediately", async () => {
    const pending=deferred<DcInteractionDetail>(); mocks.detail.mockReturnValue(pending.promise);
    const state=session(); render(<CompanionPersonReader {...base} session={state}/>);
    const dialog=screen.getByRole("dialog"), close=screen.getByRole("button",{name:/关闭插页/});
    expect(port()).toHaveAttribute("aria-busy","true");
    expect(document.querySelectorAll("[data-person-source-loading] i")).toHaveLength(7);
    expect(document.querySelector(".pa-source-loading-quote")?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(quote);
    expect(document.body.innerHTML).not.toContain("虚构小榆");
    close.focus();
    await act(async () => pending.resolve(detail));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(close).toHaveFocus();
    expect(port()).toHaveAttribute("aria-busy","false");
    expect(screen.getByText(`“${quote}”`)).toBeVisible();
    expect(document.querySelector("[data-person-source-loading]")).toBeNull();
    expect(state.ensureMemoryBridgeLoaded).toHaveBeenCalledWith(true);
  });

  it("rechecks all three genuine opens instead of reusing a cross-open plaintext cache", async () => {
    const state=session();
    for(let round=0;round<3;round++) {
      const pending=deferred<DcInteractionDetail>(); mocks.detail.mockReturnValueOnce(pending.promise);
      const view=render(<CompanionPersonReader {...base} session={state}/>);
      expect(document.body.textContent).not.toContain(quote);
      expect(document.querySelector("[data-person-source-loading]")).not.toBeNull();
      await act(async () => pending.resolve(detail));
      expect(screen.getByText(`“${quote}”`)).toBeVisible(); view.unmount();
    }
    expect(mocks.detail).toHaveBeenCalledTimes(3);
    expect(state.ensureMemoryBridgeLoaded).toHaveBeenCalledTimes(3);
  });

  it("keeps a qualified same-scope result across rerenders and layer changes", async () => {
    mocks.detail.mockResolvedValue(detail); const state=session();
    const view=render(<CompanionPersonReader {...base} session={state}/>);
    await screen.findByText(`“${quote}”`);
    view.rerender(<CompanionPersonReader {...base} session={state} fullId="e1"/>);
    expect(port()).toHaveAttribute("aria-busy","false");
    view.rerender(<CompanionPersonReader {...base} session={state}/>);
    expect(screen.getByText(`“${quote}”`)).toBeVisible();
    expect(mocks.detail).toHaveBeenCalledTimes(1);
  });

  it("keeps failure and retry reachable on the same sheet, with no unverified text", async () => {
    const failed=deferred<DcInteractionDetail>(); mocks.detail.mockReturnValueOnce(failed.promise);
    render(<CompanionPersonReader {...base} session={session()}/>); const dialog=screen.getByRole("dialog");
    await act(async () => failed.reject(new Error("fictional read failure")));
    expect(screen.getByRole("alert")).toHaveTextContent("来源暂时没有读取成功");
    expect(port()).toHaveAttribute("aria-busy","false");
    expect(document.body.textContent).not.toContain(quote);
    const retry=deferred<DcInteractionDetail>(); mocks.detail.mockReturnValueOnce(retry.promise);
    fireEvent.click(screen.getByRole("button",{name:"重新读取"}));
    expect(screen.getByRole("dialog")).toBe(dialog); expect(port()).toHaveAttribute("aria-busy","true");
    await act(async () => retry.resolve(detail));
    expect(screen.getByText(`“${quote}”`)).toBeVisible(); expect(mocks.detail).toHaveBeenCalledTimes(2);
  });

  it("ignores an old account's late callback and does not expose withdrawn words after the new check", async () => {
    const old=deferred<DcInteractionDetail>(), current=deferred<DcInteractionDetail>();
    mocks.detail.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view=render(<CompanionPersonReader {...base} session={session("old-account")}/>);
    const oldSignal=mocks.detail.mock.calls[0][2] as AbortSignal;
    view.rerender(<CompanionPersonReader {...base} session={session("new-account")}/>);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => old.resolve(detail));
    expect(document.body.textContent).not.toContain(quote); expect(port()).toHaveAttribute("aria-busy","true");
    await act(async () => current.resolve({...detail,sourceState:"explicitly_deleted"}));
    expect(screen.getByText("来源已撤回")).toBeVisible();
    expect(document.body.textContent).not.toContain(quote); expect(port()).toHaveAttribute("aria-busy","false");
  });

  it("reserves each known source structure while retaining the entire authorized long quote", async () => {
    const long=quote.repeat(80); const pending=deferred<DcInteractionDetail>(); mocks.detail.mockReturnValue(pending.promise);
    const material={id:"multi",sources:[{...source,quote:long},{...source,id:"e2",quote:long}]};
    render(<CompanionPersonReader {...base} material={material} session={session()}/>);
    expect(document.querySelectorAll(".pa-source-loading")).toHaveLength(2);
    expect(screen.getAllByText("正在核对这条来源…")).toHaveLength(1);
    await act(async () => pending.resolve({...detail,recapItems:[{...detail.recapItems[0],evidence:[{...evidence,quote:long},{...evidence,id:"e2",quote:long}]}]}));
    const words=document.querySelectorAll(".pa-evidence blockquote");
    expect(words).toHaveLength(2); expect(words[0].textContent).toBe(`“${long}”`);
  });
});

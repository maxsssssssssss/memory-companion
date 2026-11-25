import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDateCompanionViewModel } from "@/lib/domain/date-companion";
import type { DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import type { FormalNotebookAdapter } from "@/lib/client/date-companion-notebook";
import type { PreviewSnapshot } from "./prepare-notebook/model";
import { CompanionPreparationBook, PreparationRestoring } from "./companion-preparation-book";

const harness = vi.hoisted(() => ({ adapters: [] as FormalNotebookAdapter[], initialIds: [] as Array<string | null | undefined>, firstRelationship: false, catalogPending: null as Promise<void> | null }));
vi.mock("./prepare-notebook/notebook", () => ({ Notebook: ({ adapter }: { adapter: FormalNotebookAdapter }) =>
  <section data-testid="notebook" data-identity={adapter.getSnapshot().relationshipStatus}><textarea aria-label="聊天草稿" /></section> }));
vi.mock("@/lib/client/date-companion-notebook", () => ({
  createFormalNotebookAdapter: (options: { accountId: string; relationshipId: string; relationshipName: string; initialDiscussionId?: string | null; relationshipStatus: PreviewSnapshot["relationshipStatus"] }) => {
    harness.initialIds.push(options.initialDiscussionId);
    let state: PreviewSnapshot = { schema: 1, ...options, scenario: "formal", discussions: [], availableSources: [], clues: [],
      operations: {}, drafts: {}, deletedIds: [], currentDiscussionId: null, loading: true, error: null, loggedOut: false, failuresConsumed: [] };
    const listeners = new Set<() => void>();
    const adapter = {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      readDraft: vi.fn(() => ({})),
      // A previously unknown create can be resolved by the first load's receipt
      // query before React commits the adapter into its child Notebook.
      load: vi.fn(async () => { if (harness.catalogPending) await harness.catalogPending; state = { ...state, currentDiscussionId: "receipt-created-id", loading: false,
        discussions: harness.firstRelationship ? [{ id: "receipt-created-id", relationshipId: "relationship-a", version: 2, title: "第一句话", status: "active", interactionIds: [], allowRetained: false,
          messages: [], items: [], events: [], updatedAt: "2026-11-17", createdAt: "2026-11-17", generationStatus: "idle", intent: "", date: null, constraints: [] }] : []
      }; listeners.forEach(listener => listener()); return state; }),
      setCurrentDiscussion: vi.fn((id: string | null) => { state = { ...state, currentDiscussionId: id }; listeners.forEach(listener => listener()); }),
      openDiscussion: vi.fn(async (id: string) => { state = { ...state, currentDiscussionId: id }; listeners.forEach(listener => listener()); }),
      updateMaterials: vi.fn(), updateContext: vi.fn((context: Partial<PreviewSnapshot>) => {
        state = { ...state, ...context }; listeners.forEach(listener => listener());
      }), logout: vi.fn(), dispose: vi.fn()
    } as unknown as FormalNotebookAdapter;
    harness.adapters.push(adapter); return adapter;
  }
}));

function session(): DateCompanionSessionValue {
  const vm = emptyDateCompanionViewModel();
  vm.relationship = { id: "relationship-a", displayName: "阿岚", participantState: "confirmed" };
  return { auth: { status: "authenticated", user: { id: "account-a", email: "local@example.test" } }, viewModel: vm,
    relationshipState: { status: "ready", relationship: vm.relationship }, relationshipDetailsLoaded: true,
    detailReadState: { status: "ready" }, memoryBridgeState: { status: "idle" }, sourceSpeakerLabel: () => undefined,
    ensureRelationshipDetailsLoaded: vi.fn(async () => {}), ensureMemoryBridgeLoaded: vi.fn(async () => {}), refreshRelationship: vi.fn(async () => {})
  } as unknown as DateCompanionSessionValue;
}
afterEach(() => { cleanup(); harness.adapters.length = 0; harness.initialIds.length = 0; harness.firstRelationship = false; harness.catalogPending = null; window.history.replaceState({}, "", "/"); });

describe("restoring a formal preparation", () => {
  it("only draws inert contents for the first read of an existing discussion", () => {
    const { container, rerender } = render(<PreparationRestoring />);
    const status = screen.getByRole("status");
    expect(container.querySelector(".prep-opening-note")).toBeNull();
    rerender(<PreparationRestoring existing />);
    expect(screen.getByRole("status")).toBe(status);
    const note = container.querySelector(".prep-opening-note");
    const composer = container.querySelector(".prep-opening-composer");
    expect(note?.closest('[aria-hidden="true"]')).toBeInTheDocument();
    expect(composer).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("input,textarea,button,a,[tabindex]")).toBeNull();
    rerender(<PreparationRestoring existing error="讨论读取失败" retry={vi.fn()} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("讨论读取失败");
    expect(screen.getByRole("button", { name: "重新读取" })).toBeEnabled();
    expect(container.querySelector(".prep-opening-note,.prep-opening-composer")).toBeNull();
  });
  it("holds one neutral status from account lookup through binding and the discussion read", async () => {
    let finish!: () => void;
    harness.catalogPending = new Promise<void>(resolve => { finish = resolve; });
    const state = session();
    const { rerender } = render(<CompanionPreparationBook session={{ ...state, auth: { status: "checking" } }} initialDiscussionId="history-id" />);
    const status = screen.getByRole("status");
    expect(harness.adapters).toHaveLength(0);
    expect(state.ensureMemoryBridgeLoaded).not.toHaveBeenCalled();
    expect(screen.queryByText("阿岚")).not.toBeInTheDocument();
    rerender(<CompanionPreparationBook session={{ ...state, relationshipState: { status: "loading" } }} initialDiscussionId="history-id" />);
    expect(screen.getByRole("status")).toBe(status);
    expect(harness.adapters).toHaveLength(0);
    rerender(<CompanionPreparationBook session={{ ...state, memoryBridgeState: { status: "ready", mapping: null } } as DateCompanionSessionValue} initialDiscussionId="history-id" />);
    expect(screen.getByRole("status")).toBe(status);
    await act(async () => finish());
    expect(await screen.findByTestId("notebook")).toHaveAttribute("data-identity", "unmapped");
  });
  it.each(["discussion first", "identity first"])("waits for both reads when %s resolves", async (order) => {
    const state = session();
    const ready = { ...state, memoryBridgeState: { status: "ready", mapping: { status: "confirmed" } } } as DateCompanionSessionValue;
    let release!: () => void;
    harness.catalogPending = new Promise<void>(resolve => { release = resolve; });
    const { rerender } = render(<CompanionPreparationBook session={state} initialDiscussionId="history-id" />);
    const expectReading = () => {
      expect(screen.getByRole("status")).toHaveTextContent("正在恢复这次讨论");
      expect(screen.queryByTestId("notebook")).not.toBeInTheDocument();
    };
    expectReading();
    if (order === "discussion first") {
      await act(async () => release()); expectReading();
      rerender(<CompanionPreparationBook session={ready} initialDiscussionId="history-id" />);
    } else {
      rerender(<CompanionPreparationBook session={ready} initialDiscussionId="history-id" />); expectReading();
      await act(async () => release());
    }
    expect(await screen.findByTestId("notebook")).toHaveAttribute("data-identity", "established");
  });

  it("keeps a failed mapping read distinct from a confirmed missing mapping", async () => {
    const state = session(); state.memoryBridgeState = { status: "error", message: "读取失败" };
    const { rerender } = render(<CompanionPreparationBook session={state} />);
    expect(await screen.findByTestId("notebook")).toHaveAttribute("data-identity", "unavailable");
    const composer = screen.getByRole("textbox", { name: "聊天草稿" });
    composer.focus();
    rerender(<CompanionPreparationBook session={{ ...state, memoryBridgeState: { status: "loading" } }} />);
    expect(composer).toHaveFocus();
    expect(screen.getByTestId("notebook")).toHaveAttribute("data-identity", "loading");
    const missing = { ...state, memoryBridgeState: { status: "ready", mapping: null } } as DateCompanionSessionValue;
    rerender(<CompanionPreparationBook session={missing} />);
    expect(await screen.findByTestId("notebook")).toHaveAttribute("data-identity", "unmapped");
    expect(composer).toHaveFocus();
  });
});

describe("formal notebook URL draft target", () => {
  it("does not overwrite a recovered real ID with the stale new-draft prop on adapter initialization", async () => {
    render(<CompanionPreparationBook session={session()} initialDiscussionId={null} />);
    await waitFor(() => expect(harness.adapters[0]?.getSnapshot().currentDiscussionId).toBe("receipt-created-id"));
    expect(harness.adapters[0].setCurrentDiscussion).not.toHaveBeenCalled();
  });

  it("still honors a deliberate URL navigation from an existing discussion back to the new draft", async () => {
    const state = session(); const { rerender } = render(<CompanionPreparationBook session={state} initialDiscussionId={null} />);
    await waitFor(() => expect(harness.adapters[0]?.getSnapshot().currentDiscussionId).toBe("receipt-created-id"));
    rerender(<CompanionPreparationBook session={state} initialDiscussionId="history-id" />);
    await waitFor(() => expect(harness.adapters[0].openDiscussion).toHaveBeenCalledWith("history-id"));
    rerender(<CompanionPreparationBook session={state} initialDiscussionId={null} />);
    await waitFor(() => expect(harness.adapters[0].setCurrentDiscussion).toHaveBeenCalledExactlyOnceWith(null));
  });

  it("uses the newly bound browser ID when the remounted shell still passes an old draft=null snapshot", async () => {
    window.history.replaceState({}, "", "/date-companion/a/prepare?view=book&preparation=receipt-created-id");
    render(<CompanionPreparationBook session={session()} initialDiscussionId={null} />);
    await waitFor(() => expect(harness.adapters).toHaveLength(1));
    expect(harness.initialIds[0]).toBe("receipt-created-id");
    expect(harness.adapters[0].setCurrentDiscussion).not.toHaveBeenCalled();
  });

  it("uses an explicit browser new-draft target instead of an old existing-discussion prop", async () => {
    window.history.replaceState({}, "", "/date-companion/a/prepare?view=book&draft=new");
    render(<CompanionPreparationBook session={session()} initialDiscussionId="old-route-snapshot" />);
    await waitFor(() => expect(harness.adapters).toHaveLength(1));
    expect(harness.initialIds[0]).toBeNull();
    expect(harness.adapters[0].openDiscussion).not.toHaveBeenCalled();
  });

  it("settles the first saved discussion URL before the relationship shell refresh unmounts Notebook", async () => {
    harness.firstRelationship = true;
    window.history.replaceState({}, "", "/date-companion/a/prepare?view=book&draft=new");
    const state = session(); state.relationshipState = { status: "absent" }; state.viewModel.relationship = null;
    const observed: string[] = []; state.refreshRelationship = vi.fn(async () => { observed.push(window.location.search); });
    render(<CompanionPreparationBook session={state} initialDiscussionId={null} />);
    await waitFor(() => expect(state.refreshRelationship).toHaveBeenCalledTimes(1));
    expect(new URLSearchParams(observed[0]).get("preparation")).toBe("receipt-created-id");
    expect(new URLSearchParams(observed[0]).has("draft")).toBe(false);
  });
});

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparationView } from "@/lib/domain/date-companion-preparation";
import { preparationRequest } from "@/lib/client/date-companion-preparation-api";
import { CompanionPreparation } from "./companion-preparation";
vi.mock("@/lib/client/date-companion-preparation-api", () => ({ preparationRequest: vi.fn() }));
const request = vi.mocked(preparationRequest);
const source = { id: "source-1", interactionId: "interaction-1", recordingDate: "2026-11-01", quote: "我想去旅行", origin: "direct_conversation" as const, valid: true, href: "/date-companion/a/recap?interaction=interaction-1", fingerprint: "fingerprint" };
function saved(): PreparationView {
  return { id: "prep-1", relationshipId: "rel-1", title: "见面想轻松一点", version: 2, status: "active", interactionIds: [], allowRetained: false,
    messages: [{ id: "m1", role: "user", text: "明天想轻松一点", kind: "message", createdAt: "2026-11-05T01:00:00Z", sources: [], origin: "user_reflection" }, { id: "m2", role: "assistant", text: "可以顺着旅行的话题聊聊。", kind: "message", createdAt: "2026-11-05T01:00:01Z", sources: [source], origin: "assistant" }],
    items: [{ id: "item-1", text: "聊聊最近想去的地方", status: "suggested", sources: [source], createdAt: "2026-11-05T01:00:01Z", sourceMessageId: "m2" }], events: [], updatedAt: "2026-11-05T01:00:01Z", createdAt: "2026-11-05T01:00:00Z", generationStatus: "idle", intent: "轻松见面", date: null, constraints: [] };
}
const catalog = (preparations: PreparationView[] = []) => ({ preparations, availableSources: [{ id: "interaction-1", recordingDate: "2026-11-01", title: "一次相处" }] });
beforeEach(() => {
  request.mockReset(); request.mockResolvedValue(catalog());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("CompanionPreparation", () => {
  it("links just the chosen confirmed review after explicit confirmation", async () => {
    const view = saved();
    const candidates = [
      { id: "recap-a", recordingDate: "2026-11-01", title: "午饭后", reviewAvailable: true },
      { id: "recap-b", recordingDate: "2026-11-01", title: "河边散步", reviewAvailable: true },
      { id: "recap-no-evidence", recordingDate: "2026-11-02", title: "没有可用原话", reviewAvailable: false }
    ];
    request.mockResolvedValueOnce({ preparations: [view], availableSources: candidates });
    render(<CompanionPreparation />);
    const trigger = await screen.findByRole("button", { name: "用一份相处记录聊聊" });
    fireEvent.click(trigger);
    const choose = screen.getByRole("dialog", { name: "选一份相处记录" });
    expect(within(choose).getAllByRole("radio")).toHaveLength(2);
    expect(within(choose).getByRole("button", { name: "用这份记录" })).toBeDisabled();
    expect(within(choose).getByText(/关联不会开启长期记忆/)).toBeVisible();
    fireEvent.click(within(choose).getByRole("radio", { name: /午饭后/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "用这份记录" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /河边散步/ }));
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({ view: { ...view, version: 3, currentMeetingId: "next", reviewLink: {
      id: "link-1", interactionId: "recap-b", linkedAt: view.updatedAt, recordingDate: candidates[1].recordingDate,
      available: true, originalMeetingId: "original", nextMeetingId: "next", originalItemIds: [] } } });
    fireEvent.click(screen.getByRole("button", { name: "用这份记录" }));
    const linked = await screen.findByRole("button", { name: "查看已关联的相处记录" });
    expect(linked).toHaveTextContent("2026-11-01 · 河边散步");
    expect(request.mock.calls[1][1]?.method).toBe("PATCH");
    const body = JSON.parse(request.mock.calls[1][1]?.body as string);
    expect(body).toMatchObject({ kind: "link_review", interactionId: "recap-b", expectedVersion: 2 });
    expect(body).not.toHaveProperty("interactionIds");
    expect(body).not.toHaveProperty("allowRetained");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "回来记一下。" } });
    fireEvent.click(linked);
    expect(screen.getByRole("link", { name: "打开原记录" })).toHaveAttribute("href", "/date-companion/a/recap?interaction=recap-b");
    fireEvent.click(screen.getByRole("button", { name: "看看这次发生了什么" }));
    expect(screen.getByRole("textbox")).toHaveValue("回来记一下。\n结合这份记录，看看原来准备的和这次实际聊到的内容吧。");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("keeps original and next selections after revocation without offering an invalid source-dependent suggestion", async () => {
    const view = saved();
    view.currentMeetingId = "next";
    view.reviewLink = { id: "link-1", interactionId: source.interactionId, linkedAt: view.updatedAt, recordingDate: source.recordingDate,
      available: false, originalMeetingId: "previous", nextMeetingId: "next", originalItemIds: [view.items[0].id] };
    const invalid = { ...source, valid: false };
    view.messages[1] = { ...view.messages[1], text: "这次回复用到的资料已不可用。", sources: [invalid] };
    view.items = [
      { ...view.items[0], status: "selected", meetingId: "previous", sources: [invalid] },
      { ...view.items[0], id: "saved-next", status: "selected", meetingId: "next", text: "留出安静相处的时间", sources: [] },
      { ...view.items[0], id: "unavailable", status: "suggested", meetingId: "next", text: "已撤回的原话生成的未选内容", sources: [invalid] }
    ];
    view.events.push({ id: "e1", kind: "review_linked", ordinal: 0, createdAt: view.createdAt, text: "", data: { originalMeetingId: "previous", nextMeetingId: "next" } });
    request.mockResolvedValueOnce(catalog([view]));
    render(<CompanionPreparation />);
    const older = await screen.findByText("以前留下的 · 1");
    expect(older.parentElement).not.toHaveAttribute("open");
    fireEvent.click(older);
    const original = screen.getByRole("group", { name: "这次见面前留下的" });
    expect(original).toHaveTextContent(view.items[0].text);
    expect(screen.getByRole("group", { name: "为下一次留下的" })).toHaveTextContent(view.items[1].text);
    expect(screen.queryByText(view.items[2].text)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "留下这条" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看已关联的相处记录" }));
    const linked = screen.getByRole("dialog", { name: "已关联的相处记录" });
    expect(within(linked).getByText(/原记录已不可用/)).toBeVisible();
    expect(within(linked).queryByRole("link", { name: "打开原记录" })).not.toBeInTheDocument();
    request.mockResolvedValueOnce({ view: { ...view, version: 3, reviewLink: null } });
    fireEvent.click(within(linked).getByRole("button", { name: "取消关联" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "查看已关联的相处记录" })).not.toBeInTheDocument());
    expect(JSON.parse(request.mock.calls[1][1]?.body as string)).toMatchObject({ kind: "unlink_review", expectedVersion: 2 });
    expect(screen.getByRole("group", { name: "这次见面前留下的" })).toHaveTextContent(view.items[0].text);
    expect(screen.getByRole("group", { name: "为下一次留下的" })).toHaveTextContent(view.items[1].text);
    expect(screen.getByRole("textbox", { name: "想聊点什么？" })).toBeEnabled();
  });
  it("opens a remembered discussion from the authenticated catalog on a fresh page", async () => {
    const latest = saved();
    const earlier = { ...saved(), id: "older", title: "之前的相处", messages: [{ ...latest.messages[0], text: "旧讨论的原始表达" }] };
    window.history.replaceState({}, "", "/date-companion/a/prepare?preparation=older");
    try {
      request.mockResolvedValueOnce(catalog([latest, earlier]));
      render(<CompanionPreparation />);
      await screen.findByText("旧讨论的原始表达");
      expect(screen.getByText("最近聊到 · 旧讨论的原始表达")).toBeVisible();
      expect(screen.queryByText(latest.messages[0].text)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "聊过的" }));
      expect(screen.getByRole("button", { name: /之前的相处.*当前这段/ })).toBeVisible();
      expect(request).toHaveBeenCalledTimes(1);
    } finally { window.history.replaceState({}, "", "/"); }
  });
  it("leaves withdrawn choices available in collapsed history without an adoption action", async () => {
    const view = saved();
    const item = view.items[0]; item.status = "removed";
    view.events.push({ id: "select", kind: "select", ordinal: 1, text: item.text, createdAt: view.createdAt, data: { itemId: item.id } });
    request.mockResolvedValueOnce(catalog([view])); render(<CompanionPreparation />);
    const past = await screen.findByText("以前留下的 · 1");
    expect(past.parentElement).not.toHaveAttribute("open");
    expect(screen.queryByText(/这次想记得的事/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "留下这条" })).not.toBeInTheDocument();
    fireEvent.click(past);
    expect(past.parentElement).toHaveTextContent(item.text);
    expect(past.parentElement).toHaveTextContent("后来放下了");
  });
  it("keeps new draft text typed while the previous response was pending", async () => {
    request.mockResolvedValueOnce(catalog([saved()])); render(<CompanionPreparation />);
    await screen.findByText(saved().messages[0].text);
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "先聊这句" } }); fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.change(input, { target: { value: "新想起来的另一句话" } });
    await act(async () => finish({ view: saved() }));
    expect(input).toHaveValue("新想起来的另一句话");
  });
  it("re-reads a confirmed stale version before explicitly sending the rejected text", async () => {
    const view = saved(); request.mockResolvedValueOnce(catalog([view])); render(<CompanionPreparation />);
    await screen.findByText(view.messages[0].text);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "我改主意了" } });
    request.mockRejectedValueOnce(Object.assign(new Error("版本有变化"), { versionConflict: true }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("刚才的话没有送出");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    request.mockResolvedValueOnce({ view: { ...view, version: 9 } });
    fireEvent.click(screen.getByRole("button", { name: "重新读取" })); await screen.findByText("已重新读取这段讨论。");
    expect(request).toHaveBeenCalledTimes(3); expect(screen.getByRole("textbox")).toHaveValue("我改主意了");
    request.mockResolvedValueOnce({ view }); fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    const first = JSON.parse(request.mock.calls[1][1]?.body as string), next = JSON.parse(request.mock.calls[3][1]?.body as string);
    expect(next.expectedVersion).toBe(9); expect(next.operationKey).not.toBe(first.operationKey);
  });
  it("stops waiting, keeps the exact unresolved request, and never automatically replays it", async () => {
    const view = saved(); request.mockResolvedValueOnce(catalog([view])); render(<CompanionPreparation />); await screen.findByText(view.messages[0].text);
    request.mockImplementationOnce((_path, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "还有点拿不准" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(await screen.findByRole("button", { name: "先不等回复" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("已停止等待");
    const failed = { ...view, generationStatus: "failed", messages: [...view.messages, { ...view.messages[0], id: "kept-input", text: "还有点拿不准" }] };
    request.mockResolvedValueOnce({ view: failed }); fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await screen.findByText(/你说的话已保存，这次没有完整回复/);
    fireEvent.click(screen.getByRole("button", { name: "接着说" }));
    expect(screen.getByRole("textbox")).toHaveFocus(); expect(request).toHaveBeenCalledTimes(3);
  });
  it("fences a late initial read from restoring old history into a new discussion", async () => {
    let first!: (value: unknown) => void; let second!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise(done => { first = done; }));
    request.mockImplementationOnce(() => new Promise(done => { second = done; }));
    render(<StrictMode><CompanionPreparation /></StrictMode>);
    expect(screen.getByRole("button", { name: "聊过的" })).toBeDisabled();
    const old = saved(); old.interactionIds = ["interaction-1"]; old.allowRetained = true;
    await act(async () => second(catalog([old])));
    fireEvent.click(screen.getByRole("button", { name: "聊过的" }));
    fireEvent.click(screen.getByRole("button", { name: "聊点新的" }));
    await act(async () => first(catalog([old])));
    expect(screen.queryByText(old.messages[0].text)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "只想讨论，不用历史" } });
    request.mockResolvedValueOnce({ view: saved() });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[2][0]).toBe("");
    expect(JSON.parse(request.mock.calls[2][1]?.body as string)).toMatchObject({ interactionIds: [], allowRetained: false });
  });
  it("keeps the original create request when recovering an unknown first response", async () => {
    render(<CompanionPreparation />); await screen.findByText("从你现在想说的开始。");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "我只想聊聊" } });
    request.mockRejectedValueOnce(new Error("暂时没能完成"));
    fireEvent.click(screen.getByRole("button", { name: "发送" })); await screen.findByRole("alert");
    const original = request.mock.calls[1];
    request.mockResolvedValueOnce(catalog([saved()]));
    fireEvent.click(screen.getByRole("button", { name: "重新读取" })); await screen.findByText("可以顺着旅行的话题聊聊。");
    expect(screen.getByRole("textbox")).toHaveValue("我只想聊聊");
    request.mockResolvedValueOnce({ view: saved() }); fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(request.mock.calls[3][0]).toBe(original[0]);
    expect(request.mock.calls[3][1]?.body).toBe(original[1]?.body);
  });
  it("starts directly with text and no automatic history authorization", async () => {
    render(<CompanionPreparation />);
    await screen.findByText("从你现在想说的开始。");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    request.mockResolvedValueOnce({ view: saved() });
    fireEvent.change(screen.getByRole("textbox", { name: "想聊点什么？" }), { target: { value: "明天想轻松一点" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("可以顺着旅行的话题聊聊。");
    const body = JSON.parse(request.mock.calls[1][1]?.body as string);
    expect(body).toMatchObject({ text: "明天想轻松一点", interactionIds: [], allowRetained: false });
    expect(body.operationKey).toBeTruthy();
    expect(screen.queryByText(/当前理解|任务状态|agent_decision/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "留下这条" })).toBeInTheDocument();
    expect(screen.queryByText(/这次想记得的事/)).not.toBeInTheDocument();
  });
  it("keeps each editable suggestion in its own reply and deduplicates the reply's sources", async () => {
    const view = saved();
    const original = view.items[0];
    const laterReply = { ...view.messages[1], id: "reply-2", text: "你觉得 Ta 那天有点累。", sources: [] };
    const next = { ...original, id: "suggestion-2", text: "先问问想不想安静走走。", sources: [], sourceMessageId: laterReply.id };
    view.messages.push(laterReply);
    view.items.push(next);
    request.mockResolvedValueOnce(catalog([view]));
    render(<CompanionPreparation />);
    const [first, latest] = await screen.findAllByRole("article", { name: "助手回复" });
    expect(within(first).getByText(original.text)).toBeVisible();
    expect(within(first).getAllByText("看看来源 · 1")).toHaveLength(1);
    expect(within(first).queryByText(next.text)).not.toBeInTheDocument();
    expect(within(latest).getByRole("group", { name: "可选准备" })).toHaveTextContent(next.text);
    expect(within(latest).getAllByText(next.text)).toHaveLength(1);
    fireEvent.click(within(latest).getByRole("button", { name: "改一下" }));
    const edit = screen.getByRole("dialog", { name: "改一下这条" });
    const edited = { ...next, text: "先问 Ta 想坐一坐还是走走。" };
    fireEvent.change(within(edit).getByRole("textbox", { name: "内容" }), { target: { value: edited.text } });
    request.mockResolvedValueOnce({ view: { ...view, version: 3, items: [original, edited] } });
    fireEvent.click(within(edit).getByRole("button", { name: "保存修改" }));
    await within(latest).findByText(edited.text);
    expect(within(latest).queryByText(next.text)).not.toBeInTheDocument();
    expect(JSON.parse(request.mock.calls[1][1]?.body as string)).toMatchObject({ kind: "edit", itemId: next.id, text: edited.text });
    expect(within(latest).getByRole("button", { name: "留下这条" })).toBeVisible();
    request.mockResolvedValueOnce({ view: { ...view, version: 4, items: [original, { ...edited, status: "selected" }] } });
    fireEvent.click(within(latest).getByRole("button", { name: "留下这条" }));
    expect(await within(latest).findByRole("group", { name: "已选准备" })).toHaveTextContent(edited.text);
    expect(within(latest).queryByRole("button", { name: "留下这条" })).not.toBeInTheDocument();
    expect(within(first).getByRole("button", { name: "留下这条" })).toBeVisible();
    expect(screen.getByText("这次想记得的事 · 1").parentElement).toHaveTextContent(edited.text);
  });
  it("preserves earlier suggestion-only messages without displaying two copies", async () => {
    const view = saved();
    view.messages[1].text = view.items[0].text;
    view.items[0].status = "selected";
    request.mockResolvedValueOnce(catalog([view]));
    render(<CompanionPreparation />);
    const reply = await screen.findByRole("article", { name: "助手回复" });
    expect(within(reply).getAllByText(view.items[0].text)).toHaveLength(1);
    expect(within(reply).getByText("已留下")).toBeVisible();
    expect(within(reply).getByText("看看来源 · 1")).toBeInTheDocument();
  });
  it("persists explicit selection through PATCH and exposes editing and sources", async () => {
    const view = saved(); request.mockResolvedValueOnce(catalog([view]));
    render(<CompanionPreparation />);
    await screen.findByRole("button", { name: "留下这条" });
    request.mockResolvedValueOnce({ view: { ...view, version: 3, items: [{ ...view.items[0], status: "selected" }] } });
    fireEvent.click(screen.getByRole("button", { name: "留下这条" }));
    await screen.findByText("这次想记得的事 · 1");
    expect(JSON.parse(request.mock.calls[1][1]?.body as string)).toMatchObject({ kind: "select", expectedVersion: 2, itemId: "item-1" });
    expect(request.mock.calls[1][1]?.method).toBe("PATCH");
    fireEvent.click(screen.getByRole("button", { name: "改一下" }));
    const dialog = screen.getByRole("dialog", { name: "改一下这条" });
    expect(within(dialog).getByRole("textbox", { name: "内容" })).toHaveValue("聊聊最近想去的地方");
    expect(within(dialog).getByRole("button", { name: "这条不留了" })).toBeInTheDocument();
  });
  it("restores earlier progress and sends raw feedback without requiring a state picker", async () => {
    const view = saved(); request.mockResolvedValueOnce(catalog([view]));
    render(<CompanionPreparation />); await screen.findByText(view.messages[0].text);
    fireEvent.click(screen.getByRole("button", { name: "回来记一下" }));
    fireEvent.change(screen.getByRole("textbox", { name: "后来怎么样？" }), { target: { value: "准备没用上，后来聊了工作" } });
    request.mockResolvedValueOnce({ view }); fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1][0]).toBe("/prep-1/turns");
    expect(JSON.parse(request.mock.calls[1][1]?.body as string)).toMatchObject({ kind: "feedback", text: "准备没用上，后来聊了工作" });
  });
  it("applies source authorization only after confirming the scope", async () => {
    render(<CompanionPreparation />); await screen.findByText("从你现在想说的开始。");
    fireEvent.click(screen.getByRole("button", { name: "资料范围" }));
    expect(screen.getByRole("link", { name: "回看准备卡" })).toHaveAttribute("href", "/date-companion/a/prepare?view=records");
    fireEvent.click(screen.getByRole("checkbox", { name: /一次相处/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "资料范围" }));
    expect(screen.getByRole("checkbox", { name: /一次相处/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /一次相处/ }));
    fireEvent.click(screen.getByRole("button", { name: "用这些资料" }));
    expect(screen.getByText("只使用你选定的资料")).toBeInTheDocument();
    request.mockResolvedValueOnce({ view: saved() });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "找找旅行" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(JSON.parse(request.mock.calls[1][1]?.body as string).interactionIds).toEqual(["interaction-1"]);
  });
  it("preserves input and the same operation key after a network failure", async () => {
    render(<CompanionPreparation />); await screen.findByText("从你现在想说的开始。");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "我只想聊聊" } });
    request.mockRejectedValueOnce(new Error("暂时没能完成"));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("alert"); expect(screen.getByRole("textbox")).toHaveValue("我只想聊聊");
    request.mockResolvedValueOnce({ view: saved() }); fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(JSON.parse(request.mock.calls[2][1]?.body as string).operationKey).toBe(JSON.parse(request.mock.calls[1][1]?.body as string).operationKey);
  });
  it("does not pull the reader down when a reply arrives after scrolling up", async () => {
    const view = saved(); request.mockResolvedValueOnce(catalog([view]));
    render(<CompanionPreparation />); await screen.findByText(view.messages[0].text);
    let resolve!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "继续" } }); fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const log = screen.getByRole("region", { name: "聊天记录" });
    Object.defineProperties(log, { scrollHeight: { value: 1400, configurable: true }, clientHeight: { value: 400, configurable: true } });
    log.scrollTop = 100; fireEvent.scroll(log);
    await act(async () => resolve({ view: { ...view, messages: [...view.messages, { ...view.messages[1], id: "m3", text: "接着聊" }] } }));
    expect(log.scrollTop).toBe(100); expect(screen.getByRole("button", { name: "看看新回复" })).toBeInTheDocument();
  });
  it("never renders revoked quotes as sources", async () => {
    const view = saved(); view.messages[1].sources = [{ ...source, valid: false }]; view.items = [];
    request.mockResolvedValueOnce(catalog([view])); render(<CompanionPreparation />);
    await screen.findByText("这条来源已不可用，之后的讨论不会再使用它。");
    expect(screen.queryByText("我想去旅行")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查看原记录" })).not.toBeInTheDocument();
  });
});

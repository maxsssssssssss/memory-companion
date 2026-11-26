import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractionVM, ParticipantReviewVM, RecapItemVM, SourceRefVM } from "@/lib/domain/date-companion";
import { bookItemCopy, bookMeetingTitle, bookRetentionReason } from "./book-recap";
import { CompanionRecap } from "./companion-recap";

const source: SourceRefVM = {
  id: "evidence-map", uploadId: "recording-map", segmentIds: ["line-map"], recordingDate: "2026-11-13",
  startSeconds: 12, endSeconds: 18, speakerId: "speaker-b", quote: "这家书店有一本手绘地图。",
  kind: "transcript", presentation: "direct_quote",
};
const sourceSelf: SourceRefVM = {
  ...source, id: "evidence-promise", segmentIds: ["line-promise"], startSeconds: 25, endSeconds: 30,
  speakerId: "speaker-a", quote: "下次我把那张旧地图带来。",
};
const item: RecapItemVM = {
  id: "item-map", kind: "moment", title: "这次值得记住", proposedText: "在书店读手绘地图。",
  displayedText: "在书店读手绘地图。", disposition: "kept", sources: [source], version: 1,
};
const participants: ParticipantReviewVM[] = [
  {speakerId: "speaker-a", displayLabel: "声音一", state: "confirmed", role: "self", sampleQuotes: []},
  {speakerId: "speaker-b", displayLabel: "声音二", state: "confirmed", role: "companion", sampleQuotes: []},
];
const interaction: InteractionVM = {
  id: "recording-map", sourceUploadId: "recording-map", uploadIds: ["recording-map"],
  relationshipInteractionId: "interaction-map", recordingDate: "2026-11-13", fileName: "周五，书店的雨声.wav",
  title: "这次相处", status: "ready", persistenceStatus: "draft",
  transcript: [source, sourceSelf].map(s => ({id: s.segmentIds[0], uploadId: s.uploadId, startSeconds: s.startSeconds,
    endSeconds: s.endSeconds, speakerId: s.speakerId, text: s.quote})),
};
const role = (id?: string) => participants.find(p => p.speakerId === id)?.role;
const now = "2026-11-13T10:00:00.000Z";
const setting = {enabled:true,version:1,createdAt:now,updatedAt:now,enabledAt:now,disabledAt:null};
const mapping = {id:"mapping-map",selfPersonId:"person-self",companionPersonId:"person-ta",relationshipType:"dating" as const,status:"confirmed" as const,version:4,confirmedAt:now,createdAt:now,updatedAt:now};
const readyMemory = {status:"ready" as const,people:[],selfBinding:null,setting,mapping,review:{retention:setting,mapping,interactions:[]},
  retainedSubjects:{},memoryRetainedSourceKeys:[],relationshipPersonSources:[],personQaSources:[]};
const previewBatch = {batchId:"batch-map",interactionId:"interaction-map",interactionVersion:0,mappingVersion:4,
  evidenceDigest:"a".repeat(64),proposalDigest:"b".repeat(64),confirmationFingerprint:"c".repeat(64),
  model:"Qwen/Qwen3.6-27B",status:"degraded",createdAt:now,
  suggestions:[{canonicalSourceKey:"d".repeat(64),uploadId:source.uploadId,sourceSegmentId:source.segmentIds[0],contentDigest:"e".repeat(64),
    recapItemIds:[item.id],evidenceSnapshotIds:[source.id],proposedSubject:"unknown",confidence:0.2,reasonCode:"ambiguous_pronoun"}]};

describe("book recap display contracts", () => {
  beforeEach(() => {
    document.body.style.overflow="";
    document.documentElement.style.overflow="";
    window.history.replaceState({}, "", "/date-companion/a/recap?view=book");
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {callback(0); return 1;});
    vi.stubGlobal("scrollTo", vi.fn());
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {configurable: true, value: vi.fn()});
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {configurable: true, value: function(this: HTMLDialogElement) {this.open = true;}});
    Object.defineProperty(HTMLDialogElement.prototype, "close", {configurable: true, value: function(this: HTMLDialogElement) {this.open = false; this.dispatchEvent(new Event("close"));}});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the real meeting title, filename, or date without inventing a scene", () => {
    expect(bookMeetingTitle({...interaction, title: "城南图书馆的午后"})).toBe("城南图书馆的午后");
    expect(bookMeetingTitle(interaction)).toBe("周五，书店的雨声");
    expect(bookMeetingTitle({...interaction, fileName: "20261113_1400.wav"})).toBe("11 月 13 日的相处");
  });

  it("keeps an available short title only while the summary still matches its proposed content", () => {
    const titled = {...item, title: "在书店翻地图"};
    expect(bookItemCopy(titled, item.displayedText, false).title).toBe("在书店翻地图");
    expect(bookItemCopy(titled, "我们聊到旧地图里的街道。", false).title).toBe("我们聊到旧地图里的街道。");
    expect(bookItemCopy({...item, title: "一".repeat(60)}, item.displayedText, false).title).toBe(item.displayedText);
  });

  it("uses final displayed text for generic titles, never source concatenation", () => {
    const full = "我们翻到海边街道的一页。后来还聊到屋檐的走向，以及下次可以带来的旧地图。";
    expect(bookItemCopy({...item, sources: [source, sourceSelf]}, full, false)).toEqual({title: "我们翻到海边街道的一页。", text: full});
    expect(bookItemCopy(item, "小夏喜欢地图。", true).title).toBe("待核对的片段 · 0:12");
    expect(bookItemCopy(item, "小夏喜欢地图。", true).text).not.toContain("小夏");
  });

  it("distinguishes missing identity, confirmed self, mixed sources, and manual removal", () => {
    const mentioned = {...item, kind: "mentioned" as const};
    expect(bookRetentionReason(mentioned, "excluded", false, () => undefined)).toContain("身份尚未确认");
    expect(bookRetentionReason({...mentioned, sources: [sourceSelf]}, "excluded", false, role)).toContain("已确认由我说出");
    expect(bookRetentionReason({...mentioned, sources: [source, sourceSelf]}, "excluded", false, role)).toContain("包含我和 Ta");
    expect(bookRetentionReason(mentioned, "excluded", true, role)).toContain("你选择不留下");
    expect(bookRetentionReason({...item, sources: []}, "excluded", false, role)).toContain("没有可核对的来源");
  });

  it("shows saved identities on first commit while relationship settings are still being read", () => {
    const titles: string[] = [];
    render(<Profiler id="recap" onRender={() => {
      const row = document.querySelector("[data-book-item] h4");
      if (row) titles.push(row.textContent || "");
    }}><CompanionRecap interaction={{...interaction, persistenceStatus: "confirmed"}}
      items={[item]} participants={participants} memoryBridgeState={{status:"loading"}} /></Profiler>);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every(title => !title.includes("待核对"))).toBe(true);
    expect(screen.getByText("正在读取人物设置…")).toBeVisible();
    expect(screen.queryByRole("link", {name: "查看人物设置"})).toBeNull();
  });

  it("keeps a confirmed self source readable without claiming its identity is pending", () => {
    render(<CompanionRecap relationshipName="阿林" interaction={interaction}
      items={[{...item, kind: "mentioned", sources: [sourceSelf]}]} participants={participants} onFinalize={vi.fn()}/>);
    const leaf = document.querySelector('[data-book-item="item-map"]')!;
    expect(leaf).toHaveTextContent("已确认由我说出");
    expect(leaf).not.toHaveTextContent("待核对的话题");
    expect(screen.getByRole("button", {name: "查看已核对的身份"})).toBeInTheDocument();
    expect(within(leaf as HTMLElement).queryByRole("button", {name: "核对说话人"})).not.toBeInTheDocument();
    fireEvent.click(leaf.querySelector("h4 button")!);
    expect(leaf).toHaveTextContent("我 · 0:25");
    expect(within(leaf as HTMLElement).getByRole("button", {name: "查看文字稿"})).toBeInTheDocument();
  });

  it("separates multi-speaker eligibility from completed identity review", () => {
    render(<CompanionRecap interaction={interaction}
      items={[{...item, kind: "mentioned", sources: [source, sourceSelf]}]} participants={participants} onFinalize={vi.fn()}/>);
    const leaf = document.querySelector('[data-book-item="item-map"]')!;
    expect(leaf).toHaveTextContent("2 条来源");
    expect(leaf).toHaveTextContent("包含我和 Ta");
    expect(leaf).not.toHaveTextContent("身份尚未确认");
  });

  it("updates a pending identity without losing an applied summary or overriding manual removal", () => {
    render(<CompanionRecap relationshipName="阿林" interaction={interaction}
      items={[{...item, kind: "mentioned"}]} onFinalize={vi.fn()}
      participants={[participants[0], {...participants[1], state: "unresolved", role: "unresolved"}]}/>);
    const leaf = document.querySelector('[data-book-item="item-map"]')!;
    const review = () => {
      fireEvent.click(within(document.querySelector('[data-book-recap] > aside') as HTMLElement).getByRole("button", {name: "核对说话人"}));
      return screen.getByRole("dialog", {name: "核对说话人"});
    };
    expect(leaf).toHaveTextContent("待核对的话题");
    expect(leaf).toHaveAttribute("data-disposition", "excluded");
    let dialog = review();
    fireEvent.click(within(dialog).getAllByRole("button", {name: "Ta"})[1]);
    fireEvent.click(within(dialog).getByRole("button", {name: "返回复盘"}));
    expect(leaf).not.toHaveTextContent("待核对的话题");
    expect(leaf).toHaveAttribute("data-disposition", "kept");
    fireEvent.click(leaf.querySelector("h4 button")!);
    fireEvent.click(within(leaf as HTMLElement).getByRole("button", {name: "修改"}));
    fireEvent.change(screen.getByLabelText("修改摘要"), {target: {value: "我们重新看了手绘地图。"}});
    fireEvent.click(screen.getByRole("button", {name: "应用修改"}));
    fireEvent.click(within(leaf as HTMLElement).getByRole("button", {name: "这条不留下"}));
    dialog = review();
    fireEvent.click(within(dialog).getAllByRole("button", {name: "我"})[1]);
    fireEvent.click(within(dialog).getByRole("button", {name: "返回复盘"}));
    expect(leaf).toHaveTextContent("你选择不留下这条");
    expect(leaf.querySelector("h4")).toHaveTextContent("我们重新看了手绘地图。");
    fireEvent.click(within(leaf as HTMLElement).getByRole("button", {name: "恢复这条"}));
    expect(leaf).toHaveAttribute("data-disposition", "excluded");
    expect(leaf).toHaveTextContent("已确认由我说出");
    dialog = review();
    fireEvent.click(within(dialog).getAllByRole("button", {name: "Ta"})[1]);
    fireEvent.click(within(dialog).getByRole("button", {name: "返回复盘"}));
    expect(leaf).toHaveAttribute("data-disposition", "kept");
    expect(leaf.querySelector("h4")).toHaveTextContent("我们重新看了手绘地图。");
  });

  it("does not repeat a verbatim summary after the same quote while keeping editing and source access", () => {
    render(<CompanionRecap interaction={interaction} participants={participants} onFinalize={vi.fn()}
      items={[{...item, proposedText: source.quote, displayedText: source.quote}]}/>);
    const leaf = document.querySelector('[data-book-item="item-map"]')!;
    fireEvent.click(leaf.querySelector("h4 button")!);
    expect(leaf.querySelector("h4")).toHaveTextContent(source.quote);
    expect(leaf.querySelector("[data-recap-feedback] p")).toBeNull();
    expect(leaf.querySelectorAll("blockquote")).toHaveLength(1);
    expect(within(leaf as HTMLElement).getByRole("button", {name: "修改"})).toBeEnabled();
    expect(within(leaf as HTMLElement).getByRole("button", {name: "查看文字稿"})).toBeEnabled();
  });

  it("keeps independent open pages and applies a title only when summary editing is applied", () => {
    render(<CompanionRecap interaction={interaction} participants={participants} onFinalize={vi.fn()}
      items={[item, {...item, id: "item-second", title: "另一条", sources: [sourceSelf]}]}/>);
    const first = document.querySelector('[data-book-item="item-map"]')!;
    const second = document.querySelector('[data-book-item="item-second"]')!;
    fireEvent.click(first.querySelector("h4 button")!);
    fireEvent.click(second.querySelector("h4 button")!);
    fireEvent.click(first.querySelector("h4 button")!);
    expect(first).toHaveAttribute("data-open", "false");
    expect(second).toHaveAttribute("data-open", "true");
    fireEvent.click(first.querySelector("h4 button")!);
    fireEvent.click(within(first as HTMLElement).getByRole("button", {name: "修改"}));
    fireEvent.change(screen.getByLabelText("修改摘要"), {target: {value: "未应用的修改"}});
    expect(first.querySelector("h4")).toHaveTextContent(item.displayedText);
    fireEvent.click(screen.getByRole("button", {name: "取消"}));
    expect(first.querySelector("h4")).toHaveTextContent(item.displayedText);
    fireEvent.click(within(first as HTMLElement).getByRole("button", {name: "修改"}));
    fireEvent.change(screen.getByLabelText("修改摘要"), {target: {value: "我们聊到了旧街道的地图。"}});
    fireEvent.click(screen.getByRole("button", {name: "应用修改"}));
    expect(first.querySelector("h4")).toHaveTextContent("我们聊到了旧街道的地图。");
    expect(first).toHaveAttribute("data-disposition", "kept");
  });

  it("retargets pointer toggles immediately without closing another page or exposing closed controls", () => {
    render(<CompanionRecap interaction={interaction} participants={participants} onFinalize={vi.fn()}
      items={[item, {...item, id: "item-second", title: "另一条", sources: [sourceSelf]}]}/>);
    const first = document.querySelector('[data-book-item="item-map"]')!;
    const second = document.querySelector('[data-book-item="item-second"]')!;
    const trigger = first.querySelector("h4 button")!;
    const content = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    fireEvent.click(second.querySelector("h4 button")!, {detail:1});
    fireEvent.click(trigger, {detail:1});
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(content).not.toHaveAttribute("inert");
    fireEvent.click(trigger, {detail:1});
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(content).toHaveAttribute("inert");
    expect(content).toHaveAttribute("aria-hidden", "true");
    expect(second).toHaveAttribute("data-open", "true");
    fireEvent.click(trigger, {detail:1});
    expect(first).toHaveAttribute("data-open", "true");
    expect(first).toHaveAttribute("data-keyboard-toggle", "false");
    expect(content).not.toHaveAttribute("inert");
    expect(first.querySelector("[data-book-curl]")).toHaveAttribute("aria-hidden", "true");
    expect(first.querySelector("[data-book-curl]")).toHaveAttribute("focusable", "false");
  });

  it("settles an opening page when reading focus enters, and keeps keyboard toggles immediate", () => {
    render(<CompanionRecap interaction={interaction} participants={participants} onFinalize={vi.fn()}
      items={[item]}/>);
    const leaf = document.querySelector('[data-book-item="item-map"]')!;
    const trigger = leaf.querySelector("h4 button")!;
    fireEvent.click(trigger, {detail:1});
    const sourceButton = within(leaf as HTMLElement).getByRole("button", {name:"查看文字稿"});
    act(() => sourceButton.focus());
    expect(leaf).toHaveAttribute("data-keyboard-toggle", "true");
    expect(leaf).toHaveAttribute("data-open", "true");
    expect(sourceButton).toHaveFocus();
    fireEvent.click(trigger, {detail:0});
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(leaf).toHaveAttribute("data-keyboard-toggle", "true");
    fireEvent.click(trigger, {detail:0});
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(leaf).toHaveAttribute("data-keyboard-toggle", "true");
  });

  it("keeps summary and removal choices through a failed submit and retries without long-term or voice consent", async () => {
    const finalize = vi.fn().mockRejectedValueOnce(new Error("本地提交暂时失败")).mockResolvedValue(undefined);
    render(<CompanionRecap interaction={interaction} participants={participants} onFinalize={finalize}
      items={[item, {...item, id: "item-second", sources: [sourceSelf]}]}/>);
    const first = document.querySelector('[data-book-item="item-map"]')!;
    const second = document.querySelector('[data-book-item="item-second"]')!;
    fireEvent.click(first.querySelector("h4 button")!);
    fireEvent.click(within(first as HTMLElement).getByRole("button", {name: "修改"}));
    fireEvent.change(screen.getByLabelText("修改摘要"), {target: {value: "用户最后应用的地图摘要。"}});
    fireEvent.click(screen.getByRole("button", {name: "应用修改"}));
    fireEvent.click(second.querySelector("h4 button")!);
    fireEvent.click(within(second as HTMLElement).getByRole("button", {name: "这条不留下"}));
    expect(finalize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "完成本次复盘"}));
    await screen.findByText("本地提交暂时失败");
    expect(first.querySelector("h4")).toHaveTextContent("用户最后应用的地图摘要。");
    expect(second).toHaveAttribute("data-disposition", "excluded");
    fireEvent.click(screen.getByRole("button", {name: "重试完成本次复盘"}));
    await waitFor(() => expect(finalize).toHaveBeenCalledTimes(2));
    expect(finalize.mock.calls[1]).toEqual(finalize.mock.calls[0]);
    expect(finalize.mock.calls[1][1]).toEqual([
      {id: "item-map", version: 1, userText: "用户最后应用的地图摘要。", disposition: "kept"},
      {id: "item-second", version: 1, disposition: "excluded"},
    ]);
    expect(finalize.mock.calls[1][2]).toEqual([]);
    expect(finalize.mock.calls[1]).toHaveLength(3);
  });

  it("reopens the saved final summary in read-only mode and keeps source links", () => {
    render(<CompanionRecap interaction={{...interaction, persistenceStatus: "confirmed"}}
      participants={participants} items={[{...item, displayedText: "保存后的新摘要。"}]} onFinalize={vi.fn()}/>);
    const leaf = document.querySelector('[data-book-item="item-map"]')!;
    fireEvent.click(leaf.querySelector("h4 button")!);
    expect(leaf.querySelector("h4")).toHaveTextContent("保存后的新摘要。");
    expect(leaf).toHaveTextContent("已保留");
    expect(screen.getByRole("button", {name: "查看文字稿"})).toBeEnabled();
    expect(screen.queryByRole("button", {name: "修改"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "完成本次复盘"})).not.toBeInTheDocument();
  });

  it("keeps the saved source readable in the memory booklet when the current transcript differs", () => {
    const changed = {...interaction, transcript: [{...interaction.transcript[0], text:"全文里的另一版文字。"}]};
    render(<CompanionRecap interaction={changed} participants={participants}
      items={[item]} onFinalize={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", {name:"查看内容与归属"}));
    const booklet = screen.getByRole("dialog", {name:"长期记忆"});
    const evidence = booklet.querySelector(`[data-book-source="${source.id}"]`)!;
    expect(evidence).toHaveTextContent(source.quote);
    expect(evidence).not.toHaveTextContent(item.displayedText);
    expect(evidence).toHaveTextContent("已保存片段 · 与当前文字稿不同");
    expect(evidence.querySelector("blockquote")).toBeNull();
    fireEvent.click(within(evidence as HTMLElement).getByRole("button", {name:"查看依据 · 0:12"}));
    const transcript = screen.getByRole("dialog", {name:"完整文字稿"});
    expect(transcript).toHaveTextContent("全文里的另一版文字。");
    expect(transcript.querySelector('[data-segment-id="line-map"]')).toHaveAttribute("aria-current", "true");
  });

  it.each(["derived_summary", "suggestion"] as const)("preserves a %s source separately from the recap summary in the booklet", presentation => {
    render(<CompanionRecap interaction={interaction} participants={participants}
      items={[{...item,sources:[{...source,presentation,quote:"原来保存的依据内容。"}]}]} onFinalize={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", {name:"查看内容与归属"}));
    const evidence = screen.getByRole("dialog", {name:"长期记忆"}).querySelector(`[data-book-source="${source.id}"]`)!;
    expect(evidence).toHaveTextContent("原来保存的依据内容。");
    expect(evidence).not.toHaveTextContent(item.displayedText);
    expect(evidence).toHaveTextContent(presentation === "suggestion" ? "根据原话整理的建议" : "根据原话整理");
    expect(evidence.querySelector("blockquote")).toBeNull();
  });

  it("explains why removing the last kept item disables completion and restores the normal action on recovery", () => {
    const finalize = vi.fn();
    render(<CompanionRecap interaction={interaction} participants={participants}
      items={[item]} onFinalize={finalize}/>);
    const leaf = document.querySelector('[data-book-item="item-map"]')!;
    fireEvent.click(leaf.querySelector("h4 button")!);
    fireEvent.click(screen.getByRole("button", {name:"这条不留下"}));
    const complete = screen.getByRole("button", {name:"完成本次复盘"});
    expect(complete).toBeDisabled();
    expect(complete).toHaveAccessibleDescription(/需要先确认至少一条有真实来源/u);
    expect(screen.getByText(/可以恢复已移除的条目/u)).toBeInTheDocument();
    fireEvent.click(complete);
    expect(finalize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name:"恢复这条"}));
    expect(complete).toBeEnabled();
    expect(complete).not.toHaveAttribute("aria-describedby");
  });

  it.each([null,"processing","failed"] as const)("uses the book empty/error layout and return context for %s", status => {
    render(<CompanionRecap interaction={status ? {...interaction,status} : null}
      bookHomeHref="/date-companion/a?view=book&from=book-home" items={[]} participants={[]}/>);
    expect(document.querySelector("[data-book-recap]")).toBeInTheDocument();
    expect(screen.getByRole("heading", {name:status === "failed" ? "这次整理没有完成" : status === "processing" ? "这次相处正在整理" : "还没有相处记录"})).toBeInTheDocument();
    expect(screen.getByRole("link", {name:"返回首页"})).toHaveAttribute("href","/date-companion/a?view=book&from=book-home");
    expect(screen.queryByRole("button", {name:"完成本次复盘"})).not.toBeInTheDocument();
  });

  it("returns an initial home source to its origin without hijacking later in-page transcript reading", () => {
    const returnToOrigin = vi.fn();
    Object.defineProperty(window,"scrollTo",{configurable:true,value:vi.fn()});
    render(<CompanionRecap interaction={interaction} participants={participants}
      items={[item]} initialSegmentId="line-map" onReturnToSourceOrigin={returnToOrigin}/>);
    expect(screen.getByRole("dialog",{name:"完整文字稿"})).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"← 返回刚才的位置"}));
    expect(returnToOrigin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button",{name:"完整文字稿"}));
    fireEvent.click(screen.getByRole("button",{name:"← 返回刚才的位置"}));
    expect(returnToOrigin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button",{name:"完整文字稿"})).toHaveFocus();
  });

  it("locks the speaker dialog and returns its focus and reading position on Escape", () => {
    document.body.style.overflow="auto";
    document.documentElement.style.overflow="scroll";
    vi.stubGlobal("scrollX",0);
    vi.stubGlobal("scrollY",352);
    const {unmount}=render(<CompanionRecap interaction={interaction} participants={participants}
      items={[item]} onFinalize={vi.fn()}/>);
    const trigger=screen.getByRole("button",{name:"核对说话人"});
    trigger.focus();
    fireEvent.click(trigger);
    const dialog=screen.getByRole("dialog",{name:"核对说话人"});
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overflow).toBe("hidden");
    fireEvent(dialog,new Event("cancel",{cancelable:true}));
    expect(trigger).toHaveFocus();
    expect(window.scrollTo).toHaveBeenLastCalledWith({left:0,top:352,behavior:"instant"});
    expect(document.body.style.overflow).toBe("auto");
    expect(document.documentElement.style.overflow).toBe("scroll");
    fireEvent.click(trigger);
    unmount();
    expect(document.body.style.overflow).toBe("auto");
    expect(document.documentElement.style.overflow).toBe("scroll");
    document.body.style.overflow="";
    document.documentElement.style.overflow="";
  });

  it("does not let a late native close event unlock a rapidly reopened speaker dialog", () => {
    Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(this:HTMLDialogElement){this.open=false;}});
    const {unmount}=render(<CompanionRecap interaction={interaction} participants={participants}
      items={[item]} onFinalize={vi.fn()}/>);
    const trigger=screen.getByRole("button",{name:"核对说话人"});
    fireEvent.click(trigger);
    const dialog=screen.getByRole("dialog",{name:"核对说话人"});
    fireEvent.click(within(dialog).getByRole("button",{name:"返回复盘"}));
    fireEvent.click(trigger);
    fireEvent(dialog,new Event("close"));
    expect(dialog).toHaveAttribute("open");
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent(dialog,new Event("cancel",{cancelable:true}));
    expect(document.body.style.overflow).toBe("");
    unmount();
  });

  it("keeps the outer booklet locked while returning from a nested source reader", () => {
    const {unmount}=render(<CompanionRecap interaction={interaction} participants={participants}
      items={[item]} onFinalize={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"查看内容与归属"}));
    const booklet=screen.getByRole("dialog",{name:"长期记忆"});
    const sourceButton=within(booklet).getByRole("button",{name:"查看文字稿"});
    sourceButton.focus();
    fireEvent.click(sourceButton);
    expect(document.querySelectorAll("dialog[open]")).toHaveLength(2);
    fireEvent.click(within(screen.getByRole("dialog",{name:"完整文字稿"})).getByRole("button",{name:"← 返回刚才的位置"}));
    expect(document.body.style.overflow).toBe("hidden");
    expect(sourceButton).toHaveFocus();
    fireEvent.click(sourceButton);
    unmount();
    expect(document.body.style.overflow).toBe("");
    expect(document.documentElement.style.overflow).toBe("");
  });

  it.each(["never opened", "withdrew", "included"] as const)("only requests draft ownership preview with consent and does not restart it after saving (%s)", async choice => {
    const fetchPreview = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const status = {interactionId:previewBatch.interactionId, mappingVersion:4, evidenceDigest:previewBatch.evidenceDigest};
      if (String(url).endsWith("?read=status")) return Response.json({...status, interactionVersion:0, status:"idle"});
      if (init?.method === "GET") return Response.json({...status, interactionVersion:1, status:"idle"});
      return Response.json({batch:{...previewBatch, interactionVersion:init?.body ? 0 : 1}});
    });
    const generations = () => fetchPreview.mock.calls.filter(([url, init]) =>
      init?.method === "POST" && !String(url).endsWith("?read=status")).length;
    vi.stubGlobal("fetch",fetchPreview);
    const finalize=vi.fn();
    const sync=vi.fn();
    const recap = (record: InteractionVM) => <CompanionRecap interaction={record} participants={participants}
      items={[{...item,interactionId:"interaction-map"}]} onFinalize={finalize} onMemorySync={sync}
      memoryBridgeState={readyMemory}/>;
    const {rerender, unmount} = render(recap(interaction));
    if (choice !== "never opened") {
      fireEvent.click(screen.getByRole("button",{name:"查看内容与归属"}));
      const consent=screen.getByRole("checkbox",{name:/这次也整理进长期记忆/u});
      const degraded="无法确认归属的内容会保持“暂不确定”，不会自动关联人物。";
      expect(consent).not.toBeChecked();
      expect(fetchPreview).not.toHaveBeenCalled();
      expect(screen.queryByText(degraded)).not.toBeInTheDocument();
      fireEvent.click(consent);
      expect(await screen.findByText(degraded)).toBeInTheDocument();
      expect(screen.getByText("完成复盘时会接受这些归属；真正长期保留哪些内容，仍受现有安全规则约束。")).toBeInTheDocument();
      expect(generations()).toBe(1);
      expect(finalize).not.toHaveBeenCalled();
      if (choice === "withdrew") {
        fireEvent.click(consent);
        expect(consent).not.toBeChecked();
        expect(screen.queryByText(degraded)).not.toBeInTheDocument();
      }
      fireEvent.click(screen.getByRole("button",{name:"← 返回复盘"}));
    }
    expect(screen.getByRole("button",{name:"完成本次复盘"})).toBeEnabled();
    fireEvent.click(screen.getByRole("button",{name:"完成本次复盘"}));
    await waitFor(()=>expect(finalize).toHaveBeenCalledTimes(1));
    const included = choice === "included";
    if (included) expect(finalize.mock.calls[0][3].selections).toEqual([{evidenceSnapshotId:source.id,subject:"unknown"}]);
    else expect(finalize.mock.calls[0]).toHaveLength(3);
    const saved: InteractionVM = {...interaction, persistenceStatus:"confirmed", version:1,
      ...(included && {memoryBridge:{status:"pending", attemptCount:0, updatedAt:now, retryable:false}})};
    await act(async () => rerender(recap(saved)));
    expect(generations()).toBe(choice === "never opened" ? 0 : 1);
    unmount();
    await act(async () => { render(recap(saved)); });
    fireEvent.click(screen.getByRole("button",{name:"查看内容与归属"}));
    await act(async () => { fireEvent.click(screen.getByRole("button",{name:"← 返回复盘"})); });
    expect(generations()).toBe(choice === "never opened" ? 0 : 1);
    expect(sync).not.toHaveBeenCalled();
  });

  it.each(["change record", "close booklet"] as const)("discards an interrupted preview and reuses a ready batch only on request (%s)", async interruption => {
    const saved: InteractionVM = {...interaction, persistenceStatus:"confirmed", version:1};
    const batch = {...previewBatch, interactionVersion:1};
    const status = {interactionId:batch.interactionId, interactionVersion:1, mappingVersion:4, evidenceDigest:batch.evidenceDigest};
    let respond!: (value: Response) => void;
    let cached = false;
    const fetchPreview = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json(cached ? {...status, status:"ready", batch} : {...status, status:"idle"});
      return new Promise<Response>(resolve => { respond = resolve; });
    });
    vi.stubGlobal("fetch",fetchPreview);
    const sync = vi.fn();
    const recap = (record: InteractionVM) => <CompanionRecap interaction={record} participants={participants}
      items={[{...item,interactionId:record.relationshipInteractionId}]} memoryBridgeState={readyMemory} onMemorySync={sync}/>;
    const openBooklet = () => {
      if (!screen.queryByRole("dialog",{name:"长期记忆"})) fireEvent.click(screen.getByRole("button",{name:"查看内容与归属"}));
    };
    const {rerender} = render(recap(saved));
    openBooklet();
    expect(fetchPreview).not.toHaveBeenCalled();
    const generate = screen.getByRole("button",{name:"生成归属建议"});
    fireEvent.click(generate);
    fireEvent.click(generate);
    await waitFor(() => expect(fetchPreview).toHaveBeenCalledTimes(2));
    const signal = fetchPreview.mock.calls[1][1]?.signal;
    expect(signal?.aborted).toBe(false);

    if (interruption === "change record") {
      rerender(recap({...saved,id:"other-upload",relationshipInteractionId:"other-record"}));
    } else {
      fireEvent.click(screen.getByRole("button",{name:"← 返回复盘"}));
    }
    expect(signal?.aborted).toBe(true);
    await act(async () => { respond(Response.json({batch})); });
    openBooklet();
    expect(screen.getByRole("button",{name:"生成归属建议"})).toBeEnabled();
    expect(fetchPreview).toHaveBeenCalledTimes(2);
    if (interruption === "change record") rerender(recap(saved));
    openBooklet();
    expect(fetchPreview).toHaveBeenCalledTimes(2);

    cached = true;
    fireEvent.click(screen.getByRole("button",{name:"生成归属建议"}));
    await waitFor(() => expect(screen.getByRole("button",{name:"开始长期整理"})).toBeEnabled());
    expect(fetchPreview).toHaveBeenCalledTimes(3);
    expect(fetchPreview.mock.calls.at(-1)?.[1]?.method).toBe("GET");
    fireEvent.click(screen.getByRole("button",{name:"← 返回复盘"}));
    openBooklet();
    expect(screen.getByRole("button",{name:"开始长期整理"})).toBeEnabled();
    expect(fetchPreview).toHaveBeenCalledTimes(3);
    expect(sync).not.toHaveBeenCalled();
  });

  it("keeps a failed saved-record preview outside admission until explicitly retried and confirmed", async () => {
    const saved: InteractionVM = {...interaction, persistenceStatus:"confirmed", version:1};
    const batch = {...previewBatch, interactionVersion:1};
    let attempts = 0;
    const getSuggestions = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") return Response.json({status:"idle", interactionId:batch.interactionId,
        interactionVersion:1, mappingVersion:batch.mappingVersion, evidenceDigest:batch.evidenceDigest});
      attempts += 1;
      return attempts === 1 ? Response.json({error:"invalid_subject_suggestion_response"}, {status:400}) : Response.json({batch});
    });
    vi.stubGlobal("fetch", getSuggestions);
    const sync = vi.fn();
    render(<CompanionRecap interaction={saved} participants={participants}
      items={[{...item,interactionId:saved.relationshipInteractionId}]} memoryBridgeState={readyMemory} onMemorySync={sync}/>);
    fireEvent.click(screen.getByRole("button",{name:"查看内容与归属"}));
    fireEvent.click(screen.getByRole("button",{name:"生成归属建议"}));
    const retry = await screen.findByRole("button",{name:"重新生成归属建议"});
    expect(attempts).toBe(1);
    expect(sync).not.toHaveBeenCalled();
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("button",{name:"开始长期整理"})).toBeEnabled());
    expect(document.activeElement).toBe(screen.getByRole("button",{name:"已生成归属建议"}));
    expect(attempts).toBe(2);
    expect(sync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"开始长期整理"}));
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    expect(sync).toHaveBeenCalledWith([{evidenceSnapshotId:source.id, subject:"unknown"}],
      expect.objectContaining({batchId:batch.batchId, confirmedVisibleSuggestions:true}));
  });
});

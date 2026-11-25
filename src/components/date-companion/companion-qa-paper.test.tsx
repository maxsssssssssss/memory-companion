import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { QaState } from "@/lib/domain/date-companion";
import type { DayPayload } from "@/lib/domain/day-payload";
import { QA_INSUFFICIENT_EVIDENCE_ANSWER } from "@/lib/domain/qa-copy";
import type { QuestionAnswer } from "@/lib/domain/types";
import { CompanionQaPaper, type QaPaperProps } from "./companion-qa-paper";
import { clearQaDrafts, qaDraftKey, readQaDraft } from "./companion-qa-drafts";

const key = qaDraftKey("fixture-account", "relationship", "rel-a", "person-a", 1);
const base: QaPaperProps = {
  scopeKey: key, title: "关于小夏", mode: "person", verifying: false, enabled: true, answers: [],
  qaState: { status: "idle" }, suggestedQuestions: ["可以接着聊什么？"], sources: [], sourceDay: () => null,
  sourceSpeakerLabel: () => undefined,
  onActivate: () => {}, onCancel: () => {}, onAsk: async () => null
};
const button = (name: RegExp | string) => screen.getByRole("button", { name });
const open = () => fireEvent.click(button("问问 Ta"), { detail: 1 });
const close = () => fireEvent.click(button("关闭问答"));
const input = () => screen.getByRole("textbox", { name: "你的问题" }) as HTMLTextAreaElement;

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: true }));
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } }
  });
});
afterEach(() => { cleanup(); clearQaDrafts("fixture-account"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("正式问答纸面", () => {
  it("cancels an active recording answer on Escape and returns focus to the recap trigger", () => {
    const onCancel = vi.fn();
    const props: QaPaperProps = { ...base, mode: "current-interaction", title: "散步",
      scopeKey: qaDraftKey("fixture-account", "recording", "rel-a", "upload-a") };
    const {rerender} = render(<CompanionQaPaper {...props} onCancel={onCancel} />);
    const trigger = button("问问这次相处");
    fireEvent.click(trigger);
    rerender(<CompanionQaPaper {...props} onCancel={onCancel}
      qaState={{status:"streaming", question:"原问题", committedText:"已收到的回答"}} />);
    fireEvent.keyDown(screen.getByRole("dialog"), {key:"Escape"});
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    rerender(<CompanionQaPaper {...props} onCancel={onCancel} />);
  });

  it("settles the suggestion paper when motion is reduced mid-transition and only replays on new input", () => {
    const pref = Object.assign(new EventTarget(), {matches: false});
    vi.stubGlobal("matchMedia", () => pref);
    render(<CompanionQaPaper {...base}/>);
    open();
    const trigger = button("提问建议");
    const paper = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    const cancel = vi.fn();
    Object.defineProperty(paper, "getAnimations", {value: () => [{cancel}]});
    fireEvent.click(trigger, {detail:1}); fireEvent.click(trigger, {detail:1});
    expect(paper.dataset.motion).toBe("true");
    act(() => { pref.matches = true; pref.dispatchEvent(new Event("change")); });
    expect(cancel).toHaveBeenCalledOnce();
    expect(paper.dataset.motion).toBe("false");
    expect(paper.dataset.open).toBe("true");
    act(() => { pref.matches = false; pref.dispatchEvent(new Event("change")); });
    expect(paper.dataset.motion).toBe("false");
    fireEvent.click(trigger, {detail:1});
    expect(paper.dataset.motion).toBe("true");
  });
  it("folds suggestions for restored history, accepts repeated disclosure and keeps a draft's selected text", async () => {
    const history: QuestionAnswer = { id: "prior", uploadId: "person-a", createdAt: new Date().toISOString(),
      question: "上次问过的事？", answer: QA_INSUFFICIENT_EVIDENCE_ANSWER, citedSegmentIds: [] };
    const ask = vi.fn();
    render(<CompanionQaPaper {...base} answers={[history]} onAsk={ask}/>);
    open();
    const toggle = button("提问建议");
    const option = "可以接着聊什么？";
    for (let round = 0; round < 3; round++) {
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle, {detail: 1});
      expect(button(option)).toBeEnabled();
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(toggle, {detail: 1});
      expect(screen.queryByRole("button", {name:option})).toBeNull();
    }
    fireEvent.change(input(), {target:{value:"草稿里的下一问"}});
    input().focus();
    input().setSelectionRange(1, 5, "backward");
    fireEvent.select(input());
    fireEvent.click(toggle, {detail: 0});
    expect(button(option)).toBeDisabled();
    fireEvent.click(button(option));
    fireEvent.keyDown(screen.getByRole("dialog"), {key:"Escape"});
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(readQaDraft(key)).toEqual({text:"草稿里的下一问",start:1,end:5,direction:"backward"});
    expect(ask).not.toHaveBeenCalled();
  });
  it("updates eligibility inside the open paper, isolates drafts and only restores the matching scope", async () => {
    const otherKey = qaDraftKey("fixture-account", "relationship", "rel-b", "person-a", 3);
    const pending = { ...base, scopeKey: null, enabled: false, verifying: true, title: "问问 Ta", disabledMessage: "正在核对…" };
    const { rerender } = render(<CompanionQaPaper {...pending}/>);
    open();
    const dialog = screen.getByRole("dialog");
    expect(input()).toBeDisabled();
    rerender(<CompanionQaPaper {...base}/>);
    expect(screen.getByRole("dialog")).toBe(dialog);
    fireEvent.click(button("可以接着聊什么？"));
    expect(input().value).toBe("可以接着聊什么？");
    expect(screen.queryByRole("button", {name:"可以接着聊什么？"})).toBeNull();
    input().focus();
    input().setSelectionRange(1, 4, "backward");
    fireEvent.select(input());
    close();
    open();
    expect([input().selectionStart, input().selectionEnd]).toEqual([1, 4]);
    rerender(<CompanionQaPaper {...base} scopeKey={otherKey}/>);
    expect(input().value).toBe("");
    rerender(<CompanionQaPaper {...base}/>);
    expect(input().value).toBe("可以接着聊什么？");
    expect(readQaDraft(key).direction).toBe("backward");
    close();
    rerender(<CompanionQaPaper {...pending}/>);
    rerender(<CompanionQaPaper {...base}/>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("drops a revoked partial answer and a late receipt in the same drawer, preserving the next draft and selection", async () => {
    let finish!: (answer: QuestionAnswer) => void;
    const request = { ...base, onAsk: () => new Promise<QuestionAnswer>(resolve => { finish = resolve; }) };
    const {rerender} = render(<CompanionQaPaper {...request}/>);
    open();
    const dialog = screen.getByRole("dialog");
    fireEvent.change(input(), {target:{value:"原问题"}});
    fireEvent.click(button("发送"));
    rerender(<CompanionQaPaper {...request} qaState={{status:"streaming",question:"原问题",committedText:"已发出的旧句子"}}/>);
    expect(screen.getByText("已发出的旧句子")).toBeVisible();
    fireEvent.change(input(), {target:{value:"下一题的草稿"}});
    input().focus(); input().setSelectionRange(1,4,"backward"); fireEvent.select(input());
    rerender(<CompanionQaPaper {...request} enabled={false} disabledMessage="这段关系的长期资料已撤回。"/>);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(input()).toBeDisabled();
    expect(button("关闭问答")).toHaveFocus();
    await act(async () => finish({id:"late-answer",uploadId:"person-a",question:"原问题",answer:"迟到的回答",citedSegmentIds:[],createdAt:"2026-11-24T12:00:00Z"}));
    expect(screen.queryByText("已发出的旧句子")).toBeNull();
    expect(screen.queryByText("迟到的回答")).toBeNull();
    rerender(<CompanionQaPaper {...request}/>);
    expect(document.querySelectorAll(".qa-pair")).toHaveLength(0);
    expect(input()).toHaveValue("下一题的草稿");
    expect(readQaDraft(key)).toEqual({text:"下一题的草稿",start:1,end:4,direction:"backward"});
  });

  it("keeps a retry in its original turn, retains the next draft, and permits the same question as a new turn", async () => {
    const replies: ((q: QuestionAnswer | null) => void)[] = [];
    const seen: string[] = [];
    let fail!: (outcome?: "unconfirmed") => void;
    let succeed!: () => void;
    function Host() {
      const [state, setState] = useState<QaState>({status:"idle"});
      const [answers, setAnswers] = useState<QuestionAnswer[]>([]);
      async function ask(q: string) {
        seen.push(q);
        setState({status:"streaming",question:q,committedText:""});
        const answer = await new Promise<QuestionAnswer | null>(resolve => {
          replies.push(resolve);
          fail = outcome => { setState({status:"failed",question:q,message:"reply failed",outcome});resolve(null); };
          succeed = () => {
            const answer: QuestionAnswer = {id:"formal-" + seen.length, uploadId:"person-a", createdAt:new Date().toISOString(),
              question:q, answer:"从当前关系的材料找到了线索。", citedSegmentIds:[]};
            setState({status:"complete",answer});
            setAnswers(previous => [...previous, answer]);
            resolve(answer);
          };
        });
        return answer;
      }
      return <CompanionQaPaper {...base} onAsk={ask} answers={answers} qaState={state}/>;
    }
    render(<Host/>); open();
    fireEvent.change(input(), {target:{value:"第一问"}});
    fireEvent.compositionStart(input());
    fireEvent.keyDown(input(), {key:"Enter", keyCode:229, isComposing:true});
    expect(seen).toHaveLength(0);
    fireEvent.compositionEnd(input());
    fireEvent.click(button("发送")); fireEvent.change(input(), {target:{value:"下一题草稿"}});
    await act(async () => fail());
    const retry = button("重试这次回答");
    fireEvent.click(retry); fireEvent.click(retry);
    expect(seen).toEqual(["第一问","第一问"]);
    await act(async () => fail("unconfirmed"));
    expect(screen.getByText(/结果尚未确认/)).toBeVisible();
    expect(input().value).toBe("下一题草稿");
    fireEvent.click(button("重新生成这次回答"));
    await act(async () => succeed());
    expect(document.querySelectorAll(".qa-question")).toHaveLength(1);
    expect(input().value).toBe("下一题草稿");
    fireEvent.change(input(),{target:{value:"第一问"}}); fireEvent.click(button("发送"));
    await act(async () => succeed());
    expect(document.querySelectorAll(".qa-question")).toHaveLength(2);
    fireEvent.click(button("聊过的"));
    expect(within(screen.getByLabelText("问答历史")).getAllByRole("button")).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole("dialog"), {key:"Escape"});
    expect(input()).toBeVisible();
  });

  it("keeps a withheld past answer out of the flat history and labels its absence", async () => {
    render(<CompanionQaPaper {...base} withheldCount={2}/>);
    open(); fireEvent.click(button("聊过的"));
    expect(screen.getByText(/2 条历史回答/)).toBeVisible();
    expect(screen.queryByText(/还没有已完成/)).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), {key:"Escape"});
    await waitFor(() => expect(button("聊过的")).toHaveFocus());
  });

  it("opens a direct trial link statically once and keeps other navigation state", () => {
    window.history.replaceState({paper: "keep"}, "", "?view=book&qa=ta#original");
    const { rerender } = render(<CompanionQaPaper {...base} openFromLink/>);
    expect(screen.getByRole("dialog")).toHaveAttribute("data-static", "true");
    expect(location.search + location.hash).toBe("?view=book#original");
    expect(history.state).toEqual({ paper: "keep" });
    close(); rerender(<CompanionQaPaper {...base} openFromLink/>);
    expect(screen.queryByRole("dialog")).toBeNull();
    window.history.replaceState(null, "", location.pathname);
  });

  it.each([
    {
      scenario: "R17 shared citation",
      question: "关于画册封面，当时怎么说？",
      raw: "画册封面采用蓝色水彩。[E1] 同一份记录说的是画册封面。[E1]",
      paragraphs: ["画册封面采用蓝色水彩。 同一份记录说的是画册封面。"],
      quotes: ["画册封面采用蓝色水彩。"]
    },
    {
      scenario: "R18 quoted literal and separate evidence marker",
      question: "青柠计划定在什么时候，请逐字引用便笺的图例编号原话？",
      raw: "青柠计划定在周四。[E1]\n\n原话是「图例编号是 [E1]。」[E2]",
      paragraphs: ["青柠计划定在周四。", "原话是「图例编号是 [E1]。」"],
      quotes: ["青柠计划定在周四。", "便笺页上写的是「图例编号是 [E1]。」"]
    }
  ])("$scenario reads consistently while streaming, after completion and on reopening history", async ({ question, raw, paragraphs, quotes }) => {
    const sources: QaPaperProps["sources"] = quotes.map((quote, index) => ({
      id: "s" + index, uploadId: "album", recordingDate: "2026-11-05", segmentIds: ["s" + index],
      startSeconds: 3 + index, endSeconds: 4 + index, quote, kind: "transcript", presentation: "direct_quote", canOpenTranscript: false
    }));
    const result: QuestionAnswer = {
      id: "paper-answer", uploadId: "person-a", createdAt: "2026-11-05T12:00:00Z", question, answer: raw,
      citedSegmentIds: sources.map(source => source.id),
      citations: sources.map((source, index) => ({ id: "E" + (index + 1), title: "原始转写片段",
        startSeconds: source.startSeconds, endSeconds: source.endSeconds, excerpt: source.quote, sourceSegmentIds: source.segmentIds }))
    };
    let finish!: (value: QuestionAnswer) => void;
    const props = { ...base, sources, onAsk: () => new Promise<QuestionAnswer>(resolve => { finish = resolve; }) };
    const { rerender } = render(<CompanionQaPaper {...props}/>);
    open();
    fireEvent.change(input(), {target: {value: result.question}});
    fireEvent.click(button("发送"));
    const committedText = paragraphs.join(" ");
    rerender(<CompanionQaPaper {...props} qaState={{status: "streaming", question, committedText}}/>);
    expect(screen.getByText(committedText)).toBeVisible();
    await act(async () => {
      rerender(<CompanionQaPaper {...props} answers={[result]} qaState={{status: "complete", answer: result}}/>);
      finish(result);
    });
    const body = () => Array.from(screen.getByRole("dialog").querySelectorAll(".qa-prose p"), node => node.textContent);
    expect(body()).toEqual(paragraphs);
    expect(screen.getByLabelText("回答依据")).toHaveTextContent(quotes.length + " 条依据");
    close(); open();
    fireEvent.click(button("聊过的"));
    fireEvent.click(within(screen.getByLabelText("问答历史")).getByRole("button", {name: new RegExp(result.question)}));
    expect(body()).toEqual(paragraphs);
    expect(button(/查看原话/)).toBeVisible();
    expect(result.answer).toBe(raw);
  });

  it("R17 preserves paragraphs, literal bracketed text, unknown IDs and verbatim evidence with multiple citations", () => {
    const first = "原标签写作「[E1]」。";
    const literal = "另一处写着“图例编号是 [E1]，请勿更改。”";
    const quoted = '她写下 "OK."';
    const second = "示例编号 [E9] 待核对。[书单]的条目已读";
    const raw = first + "[E1][E4]\n" + literal + "[E1]\n" + quoted + "[E1] " + second + "[E4]。";
    const ids = ["E1", "E4"];
    const sources: QaPaperProps["sources"] = [first + "图例编号是 [E1]，请勿更改。", "纸签原文包含 [E4]。"].map((quote, index) => ({
      id: "s" + index, uploadId: "album", recordingDate: "2026-11-05", segmentIds: ["s" + index],
      startSeconds: index + 3, endSeconds: index + 4, quote, kind: "transcript", presentation: "direct_quote",
      canOpenTranscript: false
    }));
    const result: QuestionAnswer = {
      id: "multi", uploadId: "person-a", createdAt: "2026-11-05T12:00:00Z", question: "纸签上写了什么？",
      answer: raw, citedSegmentIds: sources.map(source => source.id), citations: sources.map((source, index) => ({
        id: ids[index], title: "原始转写片段", startSeconds: source.startSeconds, endSeconds: source.endSeconds,
        excerpt: source.quote, sourceSegmentIds: source.segmentIds
      }))
    };
    render(<CompanionQaPaper {...base} sources={sources} answers={[result]}/>);
    open();
    const dialog = screen.getByRole("dialog");
    expect(Array.from(dialog.querySelectorAll(".qa-prose p"), node => node.textContent)).toEqual([first, literal, quoted + " " + second + "。"]);
    fireEvent.click(button("展开其余 1 条依据"));
    expect(Array.from(screen.getByLabelText("回答依据").querySelectorAll("blockquote"), node => node.textContent))
      .toEqual(sources.map(source => "“" + source.quote + "”"));
    expect(result.answer).toBe(raw);
  });

  it("moves a matching terminal evidence marker to its slip and preserves unmatched text", () => {
    const first: QuestionAnswer = { id:"one", uploadId:"person-a", createdAt:new Date().toISOString(), question:"从哪一段来？",
      answer:"当时提到的是[书单]。[E1]", citedSegmentIds:["s1"], citations:[{ id:"E1", title:"原始转写片段",
        startSeconds:3, endSeconds:4, excerpt:"提到书单。", sourceSegmentIds:["s1"] }] };
    const second = { ...first, id:"two", question:"另一题", answer:"尚待核对。[E2]" };
    render(<CompanionQaPaper {...base} answers={[first, second]}/>);
    open();
    expect(screen.getByText("当时提到的是[书单]。")).toBeVisible();
    expect(screen.getByText("尚待核对。[E2]")).toBeVisible();
    expect(first.answer).toBe("当时提到的是[书单]。[E1]");
  });

  it("checks all recording history before showing bodies and withdraws stale answers on a recording revision", async () => {
    const rec = "recording-a";
    const day = (text: string) => ({
      upload: { id: rec, recordingDate: "2026-11-05" },
      segments: [{ uploadId: rec, id: "segment", startSeconds: 3, endSeconds: 8, text }],
      speakerAliases: {}, speakerAliasesByUploadId: {}
    } as DayPayload);
    const quote = "那天没有换时间。";
    const raw: QuestionAnswer = { id: "raw-a", uploadId: rec, createdAt: new Date().toISOString(), question: "时间呢？",
      answer: "旧答已经核对。", citedSegmentIds: ["segment"], citations: [
        { id: "E1", title: "原始转写片段", excerpt: quote, sourceSegmentIds: ["segment"], startSeconds: 3, endSeconds: 8 }
      ] };
    const derived: QuestionAnswer = {...raw, id: "old-summary", answer: "未经核验的旧答。",
      citations: [{...raw.citations![0], title: "当时的概括", evidenceKind: "semantic", excerpt: "过去的概括。"}]};
    const zero = {...raw, id: "zero", answer: QA_INSUFFICIENT_EVIDENCE_ANSWER, citations: [], citedSegmentIds: []};
    const fabricated = {...zero, id: "other", answer: "没有依据的旧陈述。"};
    const props: QaPaperProps = {...base, mode: "current-interaction", recordingId: rec,
      recordingRevision: {}, answers: [raw,derived,zero,fabricated], sourceDay: () => day(quote)};
    const { rerender } = render(<CompanionQaPaper {...props}/>);
    fireEvent.click(button("问问这次相处"));
    expect(screen.queryByText(raw.answer)).toBeNull();
    expect(await screen.findByText(raw.answer)).toBeVisible();
    expect(screen.getByText(zero.answer)).toBeVisible();
    expect(screen.queryByText(derived.answer)).toBeNull();
    expect(screen.queryByText(fabricated.answer)).toBeNull();
    rerender(<CompanionQaPaper {...props} recordingRevision={{}} sourceDay={() => day("时间确实改了。")}/>);
    expect(screen.queryByText(raw.answer)).toBeNull();
    fireEvent.click(button("聊过的"));
    expect(await screen.findByText(/3 条历史回答/)).toBeVisible();
    expect(within(screen.getByLabelText("问答历史")).getAllByRole("button")).toHaveLength(1);
  });
});

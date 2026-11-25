import { createElement, forwardRef, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewAdapter, PreviewRecord } from "../prepare-notebook/model";
import { preparationChoiceState, PreviewError } from "../prepare-notebook/model";
import { createFormalNotebookAdapter } from "@/lib/client/date-companion-notebook";
import type { PreparationView } from "@/lib/domain/date-companion-preparation";
import { Notebook } from "../prepare-notebook/notebook";

const instances = vi.hoisted(() => [] as PreviewAdapter[]);
const feedback = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("../paper-state-motion", async importOriginal => {
  const original=await importOriginal<typeof import("../paper-state-motion")>();
  return {...original,usePaperFeedback:(scope:string)=>{
    const controller=original.usePaperFeedback(scope);
    return {...controller,confirm:(args:Parameters<typeof controller.confirm>[0])=>{feedback.confirm(args);return controller.confirm(args);}};
  }};
});
vi.mock("./adapter", async importOriginal => {
  const original = await importOriginal<typeof import("./adapter")>();
  return { ...original, createPreviewAdapter: (options: Parameters<typeof original.createPreviewAdapter>[0]) => { const instance = original.createPreviewAdapter({ ...options, latency: 1 }); instances.push(instance); return instance; } };
});
// This suite tests user decisions and recovery. Motion is verified in the real
// browser; DOM-only tests do not pretend to measure animation quality.
vi.mock("motion/react", () => {
  const components = new Map<string, unknown>();
  return {
    useReducedMotion: () => false,
    MotionConfig: ({ children }: { children: ReactNode }) => children,
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: new Proxy({}, { get: (_, tag: string) => {
      if (!components.has(tag)) components.set(tag, forwardRef<HTMLElement, Record<string, unknown>>(function MotionStub(props, ref) {
        const plain = { ...props }; for (const key of ["layout", "layoutScroll", "layoutDependency", "initial", "animate", "exit", "transition"]) delete plain[key];
        return createElement(tag, { ...plain, ref });
      }));
      return components.get(tag);
    } }),
  };
});
import { PreparePreview } from "./prepare-preview";

const adapter = () => instances.at(-1)!;
const current = () => adapter().getDiscussion(adapter().getSnapshot().currentDiscussionId!)!;
async function open(scenario = "normal") {
  window.history.replaceState({}, "", `/?case=${scenario}&account=component-check`);
  render(<PreparePreview />);
  await waitFor(() => expect(screen.queryByText("正在翻开手帐…")).not.toBeInTheDocument());
}
function note(id: string) { return document.getElementById(`note-${id}`)!; }

describe("notebook preparation decisions and recovery", () => {
  beforeEach(() => {
    feedback.confirm.mockClear();
    localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    HTMLElement.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
    Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(this:HTMLDialogElement){this.open=false;this.dispatchEvent(new Event("close"));}});
    // Geometry and animation are exercised in Chromium, not inferred from jsdom.
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => { cleanup(); instances.splice(0).forEach(a => a.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("edits a proposal without selecting it, then leaves the same object on both pages", async () => {
    await open("one-candidate");
    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    fireEvent.change(screen.getByLabelText("修改这条准备"), { target: { value: "见面时问问那本画册的新进展。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(current().items[0].text).toBe("见面时问问那本画册的新进展。"));
    expect(current().items[0].status).toBe("suggested"); expect(note("item-candidate")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "留下这条" }));
    await waitFor(() => expect(note("item-candidate")).toHaveTextContent("见面时问问那本画册的新进展。"));
    expect(current().items.filter(i => i.id === "item-candidate")).toHaveLength(1); expect(current().items[0].status).toBe("selected");
    expect(document.querySelector('[data-item-id="item-candidate"]')).toHaveAttribute("data-status", "selected");
  });

  it("edits selected and earlier choices without changing their meeting attribution", async () => {
    await open();
    fireEvent.click(within(note("item-album")).getByRole("button", { name: "修改" }));
    fireEvent.change(screen.getByLabelText("修改这条准备"), { target: { value: "带上相册，不着急把它翻完。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(current().items.find(i => i.id === "item-album")?.text).toBe("带上相册，不着急把它翻完。"));
    expect(preparationChoiceState(current(), current().items.find(i => i.id === "item-album")!)).toBe("current");
    fireEvent.click(screen.getByRole("button", { name: /以前留下的/ }));
    fireEvent.click(within(note("item-travel")).getByRole("button", { name: "修改" }));
    fireEvent.change(screen.getByLabelText("修改这条准备"), { target: { value: "那次想聊聊沿海旅行。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(current().items.find(i => i.id === "item-travel")?.text).toBe("那次想聊聊沿海旅行。"));
    expect(preparationChoiceState(current(), current().items.find(i => i.id === "item-travel")!)).toBe("earlier");
  });

  it("keeps unsaved edit text on a failed save and allows retry without selection", async () => {
    await open("edit-failure");
    const candidate = document.querySelector('[data-item-id="item-candidate"]') as HTMLElement;
    fireEvent.click(within(candidate).getByRole("button", { name: "修改" }));
    fireEvent.change(screen.getByLabelText("修改这条准备"), { target: { value: "失败以后也不能丢的文字。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText("修改暂时没能保存，编辑中的文字仍在。可以再试一次。");
    expect(feedback.confirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText("修改这条准备")).toHaveValue("失败以后也不能丢的文字。");
    expect(current().items.find(i => i.id === "item-candidate")?.text).not.toBe("失败以后也不能丢的文字。");
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(current().items.find(i => i.id === "item-candidate")?.text).toBe("失败以后也不能丢的文字。"));
    expect(current().items.find(i => i.id === "item-candidate")?.status).toBe("suggested");
    expect(feedback.confirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['write_failed','暂时没有收到可确认的结果。','这次修改未能保存，编辑中的文字仍在。请检查后再试。'],
    ['unknown_result','暂时没有收到连接结果。','保存结果尚未确认，修改仍在。请再次保存以核对这次结果。'],
    ['conflict','其他地方刚更新了这段讨论，这次修改没有保存。请重新读取后继续。','其他地方刚更新了这段讨论，这次修改没有保存。请重新读取后继续。'],
    ['write_failed','当前账号无权操作这段讨论。','当前账号无权操作这段讨论。'],
  ] as const)('expires the previous success during a new edit, pending save and %s',async(code,message,expected)=>{
    await open('one-candidate');
    const candidate=document.querySelector<HTMLElement>('[data-item-id="item-candidate"]')!;
    const edit=()=>fireEvent.click(within(candidate).getByRole('button',{name:'修改'}),{detail:1});
    edit();fireEvent.change(screen.getByLabelText('修改这条准备'),{target:{value:'已经真正保存的上一轮。'}});
    fireEvent.click(screen.getByRole('button',{name:'保存修改'}),{detail:1});
    await screen.findByText('文字已修改，选用状态不变。');expect(feedback.confirm).toHaveBeenCalledTimes(1);
    edit();expect(screen.queryByText('文字已修改，选用状态不变。')).not.toBeInTheDocument();
    const input=screen.getByLabelText('修改这条准备');fireEvent.change(input,{target:{value:'新一轮仍未确认的编辑。'}});
    let reject!:(error:PreviewError)=>void;
    const write=vi.spyOn(adapter(),'mutate').mockImplementationOnce(()=>new Promise((_,fail)=>{reject=fail;}));
    fireEvent.click(screen.getByRole('button',{name:'保存修改'}),{detail:1});
    expect(screen.getByRole('button',{name:'正在保存…'})).toBeDisabled();
    expect(screen.queryByText('文字已修改，选用状态不变。')).not.toBeInTheDocument();
    await act(async()=>reject(new PreviewError(code,message,'status-error')));
    expect(screen.getByText(expected)).toHaveAttribute('role','alert');
    expect(screen.queryByText('文字已修改，选用状态不变。')).not.toBeInTheDocument();
    expect(input).toHaveValue('新一轮仍未确认的编辑。');expect(feedback.confirm).toHaveBeenCalledTimes(1);
    write.mockRestore();fireEvent.click(screen.getByRole('button',{name:'保存修改'}),{detail:1});
    await screen.findByText('文字已修改，选用状态不变。');expect(feedback.confirm).toHaveBeenCalledTimes(2);
    expect(current().items[0].status).toBe('suggested');
    act(()=>adapter().writeDraft(current().id,{input:'与回执无关的重复发布'}));
    expect(feedback.confirm).toHaveBeenCalledTimes(2);
  });

  it("confirms three independent saves at the same candidate without selecting it",async()=>{
    await open('one-candidate');
    const candidate=document.querySelector<HTMLElement>('[data-item-id="item-candidate"]')!;
    for(let round=1;round<=3;round++){
      fireEvent.click(within(candidate).getByRole('button',{name:'修改'}));
      fireEvent.change(screen.getByLabelText('修改这条准备'),{target:{value:`第${round}次真正保存的文字。`}});
      fireEvent.click(screen.getByRole('button',{name:'保存修改'}),{detail:round===2?0:1});
      await waitFor(()=>expect(feedback.confirm).toHaveBeenCalledTimes(round));
      expect(current().items[0].status).toBe('suggested');
      expect(feedback.confirm.mock.calls[round-1][0].target()).toBe(candidate);
    }
    const saved=feedback.confirm.mock.calls.map(call=>call[0]);
    expect(new Set(saved.map(value=>value.id)).size).toBe(3);
    expect(saved.map(value=>value.detail)).toEqual([1,0,1]);
    expect(saved.every(value=>value.kind==='saved')).toBe(true);
    expect(candidate.querySelectorAll('[data-paper-feedback-ink]')).toHaveLength(1);
    act(()=>adapter().writeDraft(current().id,{input:'一次无关的草稿发布'}));
    expect(feedback.confirm).toHaveBeenCalledTimes(3);
  });

  it('keeps separate nonzero category read points and isolates discussion scope',async()=>{
    await open();
    const a=adapter(),id=current().id,left=screen.getByRole('region',{name:'留下的准备列表'});
    // This verifies position ownership, not browser overflow geometry. The
    // before/after Chromium probe separately exercises real clamping.
    left.scrollTop=80;fireEvent.scroll(left);
    fireEvent.click(screen.getByRole('button',{name:/以前留下的/}));
    expect(left.scrollTop).toBe(0);left.scrollTop=35;fireEvent.scroll(left);
    fireEvent.click(screen.getByRole('button',{name:'自己留下的准备'}));
    expect(left.scrollTop).toBe(80);
    fireEvent.click(screen.getByRole('button',{name:/以前留下的/}));expect(left.scrollTop).toBe(35);
    act(()=>{a.writeDraft(null,{leftScroll:17,selectedTab:'current'});a.setCurrentDiscussion(null);});
    expect(left.scrollTop).toBe(17);
    act(()=>a.setCurrentDiscussion(id));expect(left.scrollTop).toBe(35);
    fireEvent.click(screen.getByRole('button',{name:'自己留下的准备'}));expect(left.scrollTop).toBe(80);
  });

  it('ignores hidden-pane zero scroll and does not overwrite a source-return read point',async()=>{
    await open();const a=adapter(),id=current().id;
    const left=screen.getByRole('region',{name:'留下的准备列表'}),chat=screen.getByRole('region',{name:'讨论内容'});
    left.scrollTop=80;fireEvent.scroll(left);chat.scrollTop=140;fireEvent.scroll(chat);
    const leftPage=left.closest<HTMLElement>('.prep-left')!,rightPage=chat.closest<HTMLElement>('.prep-right')!;
    leftPage.style.display='none';left.scrollTop=0;fireEvent.scroll(left);
    rightPage.style.display='none';chat.scrollTop=0;fireEvent.scroll(chat);
    expect(a.readDraft(id).leftScroll).toBe(80);expect(a.readDraft(id).chatScroll).toBe(140);
    leftPage.style.display='';rightPage.style.display='';
    act(()=>a.writeDraft(id,{mobileView:'chat'}));expect(chat.scrollTop).toBe(140);
    act(()=>a.writeDraft(id,{mobileView:'preparations'}));expect(left.scrollTop).toBe(80);
    left.scrollTop=93;fireEvent.scroll(left);act(()=>a.writeDraft(id,{sourceSheetScroll:72,input:'来源返回后保留'}));
    expect(left.scrollTop).toBe(93);expect(a.readDraft(id).leftScroll).toBe(93);
  });

  it("uses the recovered original receipt for an unknown save retry and ignores duplicate publishes",async()=>{
    await open('one-candidate');
    const a=adapter(),mutate=a.mutate.bind(a);let originalKey='';
    // This component test models the adapter's public recovered-operation
    // metadata. The real receipt-first HTTP contract has its own adapter test.
    vi.spyOn(a,'mutate').mockImplementation(async(id,input)=>{
      if(!originalKey){
        originalKey=input.operationKey;
        a.getSnapshot().operations[originalKey]={key:originalKey,discussionId:id,kind:'mutation',status:'unknown',input:'',attempts:1};
        throw new PreviewError('unknown_result','保存结果暂未确认。',originalKey);
      }
      return mutate(id,{...input,operationKey:originalKey});
    });
    fireEvent.click(screen.getByRole('button',{name:'修改'}));
    fireEvent.change(screen.getByLabelText('修改这条准备'),{target:{value:'同一份未决保存。'}});
    fireEvent.click(screen.getByRole('button',{name:'保存修改'}),{detail:1});
    await screen.findByText('保存结果尚未确认，修改仍在。请再次保存以核对这次结果。');
    expect(feedback.confirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText('修改这条准备')).toHaveValue('同一份未决保存。');
    fireEvent.click(screen.getByRole('button',{name:'保存修改'}),{detail:1});
    await waitFor(()=>expect(feedback.confirm).toHaveBeenCalledTimes(1));
    expect(feedback.confirm.mock.calls[0][0].id).toBe(originalKey);
    expect(current().items[0].status).toBe('suggested');
    act(()=>{a.writeDraft(current().id,{input:'保持正文的重复发布'});a.writeDraft(current().id,{input:'保持正文的重复发布'});});
    expect(feedback.confirm).toHaveBeenCalledTimes(1);
  });

  it("changes the existing tabs immediately and preserves drafts through repeated and keyboard choices",async()=>{
    await open();
    const input=screen.getByLabelText('还有什么想聊的？');
    fireEvent.change(input,{target:{value:'页签切换时仍未发送的草稿'}});
    for(let round=0;round<3;round++){
      fireEvent.click(screen.getByRole('button',{name:/以前留下的/}),{detail:1});
      expect(adapter().readDraft(current().id).selectedTab).toBe('past');
      expect(note('item-travel')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button',{name:'自己留下的准备'}),{detail:1});
      expect(adapter().readDraft(current().id).selectedTab).toBe('current');
      expect(note('item-album')).toBeInTheDocument();
    }
    const mobileTabs=screen.getByRole('tablist',{name:'手帐视图'}),choices=within(mobileTabs).getAllByRole('tab');
    fireEvent.keyDown(choices[0],{key:'ArrowRight'});
    expect(choices[1]).toHaveAttribute('aria-selected','true');expect(choices[1]).toHaveFocus();
    fireEvent.keyDown(choices[1],{key:'ArrowLeft'});
    expect(choices[0]).toHaveAttribute('aria-selected','true');expect(choices[0]).toHaveFocus();
    expect(input).toHaveValue('页签切换时仍未发送的草稿');
    expect(feedback.confirm).not.toHaveBeenCalled();
  });

  it("never submits an unfinished Chinese IME composition", async () => {
    await open("empty"); const input = screen.getByLabelText("还有什么想聊的？");
    fireEvent.change(input, { target: { value: "还没选好汉字" } });
    fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
    expect(adapter().getSnapshot().discussions).toHaveLength(0); expect(input).toHaveValue("还没选好汉字");
    fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: "Enter", code: "Enter", isComposing: false, keyCode: 13 });
    await waitFor(() => expect(adapter().getSnapshot().discussions).toHaveLength(1));
    expect(current().messages.filter(m => m.role === "user")).toHaveLength(1);
  });

  it("does not render withdrawn quote text or a selectable invalid proposal", async () => {
    await open("invalid-source");
    const candidate = document.querySelector('[data-item-id="item-candidate"]') as HTMLElement;
    expect(candidate).toHaveTextContent("这条建议的来源已不可用");
    expect(within(candidate).queryByRole("button", { name: "留下这条" })).not.toBeInTheDocument();
    fireEvent.click(within(candidate).getByRole("button", { name: /查看依据/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent("这条来源已不可用");
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /查看全文|查看已存片段/ })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("我最近在准备一个小小的摄影展，还在挑照片。");
    expect(note("item-space")).toHaveTextContent("问问摄影展的进展。");
  });

  it("keeps new-discussion input separate and restores it after opening an existing discussion", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("还有什么想聊的？"), { target: { value: "当前讨论的输入" } });
    fireEvent.click(screen.getByRole("button", { name: "更多讨论操作" }));
    fireEvent.click(screen.getByRole("button", { name: /聊点新的/ }));
    fireEvent.change(screen.getByLabelText("还有什么想聊的？"), { target: { value: "新讨论的草稿" } });
    expect(adapter().getSnapshot().discussions).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "聊过的" }));
    fireEvent.click(screen.getByRole("button", { name: /下次见面，留一点从容的时间/ }));
    expect(screen.getByLabelText("还有什么想聊的？")).toHaveValue("当前讨论的输入");
    fireEvent.click(screen.getByRole("button", { name: "更多讨论操作" })); fireEvent.click(screen.getByRole("button", { name: /聊点新的/ }));
    expect(screen.getByLabelText("还有什么想聊的？")).toHaveValue("新讨论的草稿");
  });

  it("preserves unsaved input and editing selection through the source reader", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("还有什么想聊的？"), { target: { value: "这句话先不发送" } });
    const target = note("item-album"); fireEvent.click(within(target).getByRole("button", { name: "修改" }));
    const edit = screen.getByLabelText("修改这条准备") as HTMLTextAreaElement;
    fireEvent.change(edit, { target: { value: "带上相册，先问问当天想不想看。" } });
    act(() => { edit.setSelectionRange(3, 7); fireEvent.select(edit); });
    fireEvent.click(within(target).getByRole("button", { name: /查看依据/ }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /查看全文/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent("下次我把那本相册带给你。");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /返回来源/ }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("这条准备的依据");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("查找原文");
    fireEvent.click(screen.getByRole("button", { name: /返回刚才的位置/ }));
    await waitFor(() => expect(edit).toHaveFocus());
    expect(edit.selectionStart).toBe(3); expect(edit.selectionEnd).toBe(7);
    expect(edit).toHaveValue("带上相册，先问问当天想不想看。");
    expect(screen.getByLabelText("还有什么想聊的？")).toHaveValue("这句话先不发送");
    expect(current().items[0].text).not.toBe("带上相册，先问问当天想不想看。");
  });

  it("keeps the next input and its selection through scope edits and retrying the original turn", async () => {
    const createdAt = "2026-11-01T10:00:00Z", message = "下次见面请帮我写一句开场白。";
    let view: PreparationView = {
      id: "retry-discussion", relationshipId: "retry-relation", version: 1, title: "画册", status: "active",
      interactionIds: [], allowRetained: false, items: [], updatedAt: createdAt, createdAt, intent: message,
      date: null, constraints: [], generationStatus: "failed", generationMessage: "还没生成可留下的建议。",
      messages: [{ id: "original", role: "user", kind: "message", text: message, sources: [], origin: "user_reflection", createdAt }],
      events: [{ id: "stopped", ordinal: 0, kind: "generation_stopped", text: "还没生成可留下的建议。", createdAt,
        data: { failureCode: "missing_suggestions", messageId: "original" } }]
    };
    const writes: unknown[] = [];
    const formal = createFormalNotebookAdapter({ accountId: "scope-dom", relationshipId: view.relationshipId,
      relationshipName: "小夏", relationshipStatus: "established", storage: localStorage,
      request: async <T,>(_path = "", init?: RequestInit) => {
        if (!init?.method) return { preparations: [view], availableSources: [] } as T;
        const body = JSON.parse(init.body as string);
        writes.push(body);
        if (init.method === "PATCH") {
          view = { ...view, version: 2, allowRetained: body.allowRetained, events: [...view.events,
            { id: "scope", ordinal: 1, kind: "scope_changed", text: "范围已更新", createdAt, data: {} }] };
        } else {
          view = { ...view, version: 4, generationStatus: "idle", generationMessage: undefined,
            messages: [...view.messages, { id: "answer", role: "assistant", kind: "message", text: "", sources: [], origin: "assistant", createdAt }],
            items: [{ id: "card", sourceMessageId: "answer", status: "suggested", text: "周末逛得怎么样？", sources: [], createdAt }] };
        }
        return { view } as T;
      }
    });
    instances.push(formal);
    await formal.load();
    render(<Notebook adapter={formal} formalMode />);
    const input = screen.getByLabelText("还有什么想聊的？") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "下一题先写在这里。" } });
    act(() => { input.focus(); input.setSelectionRange(1, 4); fireEvent.select(input); });
    fireEvent.click(screen.getByRole("button", { name: "资料范围" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /参考已获准保留的长期资料/ }));
    fireEvent.click(screen.getByRole("button", { name: "用这些资料" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "重试这一轮建议" }));
    await screen.findByRole("button", { name: "留下这条" });
    expect(writes).toEqual([expect.objectContaining({ kind: "scope", allowRetained: true, expectedVersion: 1 }),
      { operationKey: "retry:original:2", retryMessageId: "original", expectedVersion: 2 }]);
    expect(input).toHaveValue("下一题先写在这里。");
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
    expect(formal.readDraft(view.id)).toMatchObject({ input: "下一题先写在这里。", inputSelection: [1, 4] });
  });

  it("replaces the reading area and action row in place, and cancellation writes nothing", async () => {
    await open();
    const original = structuredClone(current().items.find(i => i.id === "item-album")!);
    const target = note(original.id);
    fireEvent.click(within(target).getByRole("button", { name: "修改" }));
    expect(target.querySelector(".prep-note-text")).toBeNull();
    expect(within(target).getAllByRole("textbox")).toHaveLength(1);
    expect(within(target).getByRole("textbox")).toHaveAttribute("rows", "1");
    expect(within(target).queryByRole("button", { name: "修改" })).not.toBeInTheDocument();
    expect(within(target).queryByRole("button", { name: "这条不留了" })).not.toBeInTheDocument();
    expect(within(target).getAllByRole("button", { name: "保存修改" })).toHaveLength(1);
    expect(within(target).getAllByRole("button", { name: "取消修改" })).toHaveLength(1);
    expect(within(target).getByRole("button", { name: /查看依据/ })).toBeInTheDocument();
    fireEvent.change(within(target).getByRole("textbox"), { target: { value: "这句没有保存，不应替换原文。" } });
    fireEvent.click(within(target).getByRole("button", { name: "取消修改" }));
    await waitFor(() => expect(within(target).getByRole("button", { name: "修改" })).toHaveFocus());
    expect(target.querySelector(".prep-note-text")).toHaveTextContent(original.text);
    expect(within(target).queryByRole("textbox")).not.toBeInTheDocument();
    expect(current().items.find(i => i.id === original.id)).toEqual(original);
    expect(adapter().readDraft(current().id).editingId).toBeNull();
    expect(adapter().readDraft(current().id).editText).toBe("");
  });

  it("ordinary source close returns to its trigger, while the explicit return resumes editing", async () => {
    await open();
    const target = note("item-space");
    fireEvent.click(within(target).getByRole("button", { name: "修改" }));
    const edit = screen.getByLabelText("修改这条准备") as HTMLTextAreaElement;
    fireEvent.change(edit, { target: { value: "先听听她想分享的选片故事，不急着问结果。" } });
    act(() => { edit.focus(); edit.setSelectionRange(2, 8); fireEvent.select(edit); });
    const trigger = within(target).getByRole("button", { name: /查看依据/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(edit).toHaveValue("先听听她想分享的选片故事，不急着问结果。");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /返回刚才的位置/ }));
    await waitFor(() => expect(edit).toHaveFocus());
    expect([edit.selectionStart, edit.selectionEnd]).toEqual([2, 8]);
  });

  it("Escape steps from transcript back to source before closing the source sheet", async () => {
    await open();
    const target = note("item-space");
    const trigger = within(target).getByRole("button", { name: /查看依据/ });
    fireEvent.click(trigger);
    const originalDialog = screen.getByRole("dialog");
    const secondSource = within(originalDialog).getAllByRole("button", { name: /查看全文/ })[1];
    act(() => { secondSource.focus(); });
    fireEvent.click(secondSource);
    expect(screen.getByRole("dialog")).toBe(originalDialog);
    expect(screen.getByRole("dialog")).toHaveTextContent("完整文字稿");
    fireEvent(screen.getByRole("dialog"), new Event("cancel",{cancelable:true}));
    expect(screen.getByRole("dialog")).toBe(originalDialog);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("这条准备的依据");
    await waitFor(() => expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: /查看全文/ })[1]).toHaveFocus());
    fireEvent(screen.getByRole("dialog"), new Event("cancel",{cancelable:true}));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reopens the same native source and full-text layers three times without losing the draft",async()=>{
    await open();
    const input=screen.getByLabelText("还有什么想聊的？");
    fireEvent.change(input,{target:{value:"尚未发送的草稿"}});
    const trigger=within(note("item-album")).getByRole("button",{name:/查看依据/});
    for(let i=0;i<3;i++){
      fireEvent.click(trigger,{detail:1});const dialog=screen.getByRole('dialog');
      expect(dialog.tagName).toBe('DIALOG');
      expect(dialog).toHaveAttribute('data-full-reading','false');
      fireEvent.click(within(dialog).getByRole('button',{name:/查看全文/}));
      expect(screen.getByRole('dialog')).toBe(dialog);
      expect(dialog).toHaveAttribute('data-full-reading','true');
      await waitFor(()=>expect(dialog.querySelector('[data-highlight="true"]')).toHaveFocus());
      fireEvent.click(within(dialog).getByRole('button',{name:/返回来源/}));
      expect(dialog).toHaveAttribute('data-full-reading','false');
      fireEvent.click(within(dialog).getByRole('button',{name:'关闭'}));
      await waitFor(()=>expect(trigger).toHaveFocus());
    }
    expect(input).toHaveValue('尚未发送的草稿');
  });

  it("late full text never takes focus from an already used search field",async()=>{
    await open();
    let finish!:(record:PreviewRecord|null)=>void;
    adapter().loadRecord=()=>new Promise(resolve=>{finish=resolve;});
    fireEvent.click(within(note('item-album')).getByRole('button',{name:/查看依据/}));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:/查看文字稿/}));
    const search=screen.getByRole('searchbox');act(()=>search.focus());
    fireEvent.change(search,{target:{value:'相册'}});
    const saved=adapter().getSnapshot().availableSources.find(r=>r.sources.some(s=>s.quote.includes('相册')))!;
    await act(async()=>finish(saved));
    expect(search).toHaveFocus();expect(search).toHaveValue('相册');
  });

  it("shows a readable saved quote during loading without claiming the full text is absent",async()=>{
    await open();
    const saved=adapter().getSnapshot().availableSources.find(r=>r.sources.some(s=>s.quote.includes('相册')))!;
    saved.fullTranscript=false;
    let finish!:(record:PreviewRecord|null)=>void;
    adapter().loadRecord=()=>new Promise(resolve=>{finish=resolve;});
    fireEvent.click(within(note('item-album')).getByRole('button',{name:/查看依据/}));
    // Opening the source publishes a fresh fixture snapshot. Set the actual
    // record consumed by openReader to the formal app's saved-fragment state.
    adapter().getSnapshot().availableSources.find(r=>r.id===saved.id)!.fullTranscript=false;
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:/查看文字稿/}));
    const dialog=screen.getByRole('dialog'),quote=dialog.querySelector('[data-highlight="true"]')!;
    expect(quote).toHaveTextContent(saved.segments[0].text);expect(quote).toHaveFocus();
    expect(dialog.querySelector('[data-reader-state]')).toHaveAttribute('data-reader-state','loading');
    expect(within(dialog).queryByText(/本机没有完整文字稿/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText('仅有已保存片段')).not.toBeInTheDocument();
    const context=dialog.querySelector('.prep-reader-context'),state=dialog.querySelector('.prep-reader-state');
    expect(context).toBeInTheDocument();
    const focus=vi.spyOn(quote as HTMLElement,'focus');
    await act(async()=>finish({...saved,segments:saved.segments.map(s=>({...s,time:'08:12'}))}));
    expect(dialog.querySelector('[data-highlight="true"]')).toBe(quote);
    expect(dialog.querySelector('.prep-reader-context')).toBe(context);
    expect(dialog.querySelector('.prep-reader-state')).toBe(state);
    expect(state).toHaveAttribute('data-reader-state','success-empty');
    const explanation=within(dialog).getByText(/本机没有完整文字稿/);
    expect(quote.compareDocumentPosition(explanation)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not insert late preceding text above the quote until explicitly requested and searches all text",async()=>{
    await open();
    const saved=adapter().getSnapshot().availableSources.find(r=>r.sources.some(s=>s.quote.includes('相册')))!;
    saved.fullTranscript=false;
    let finish!:(record:PreviewRecord|null)=>void;
    adapter().loadRecord=()=>new Promise(resolve=>{finish=resolve;});
    fireEvent.click(within(note('item-album')).getByRole('button',{name:/查看依据/}));
    adapter().getSnapshot().availableSources.find(r=>r.id===saved.id)!.fullTranscript=false;
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:/查看文字稿/}));
    const dialog=screen.getByRole('dialog'),quote=dialog.querySelector('[data-highlight="true"]')!;
    const focus=vi.spyOn(quote as HTMLElement,'focus');
    const before={id:'earlier-context',speaker:'我',text:'先聊了本周的展览。',time:'01:12'};
    const after={id:'later-context',speaker:'小夏',text:'后来一起喝了茶。',time:'12:16'};
    await act(async()=>finish({...saved,fullTranscript:true,segments:[before,...saved.segments,after]}));
    expect(dialog.querySelector('[data-reader-state]')).toHaveAttribute('data-reader-state','success-full');
    expect(dialog.querySelector('[data-highlight="true"]')).toBe(quote);expect(quote).toHaveFocus();
    expect(within(dialog).queryByText(before.text)).not.toBeInTheDocument();
    expect(within(dialog).getByText(after.text)).toBeInTheDocument();
    expect(focus).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button',{name:'查看原句前文（1 段）'}));
    const preceding=within(dialog).getByText(before.text);
    expect(preceding.compareDocumentPosition(quote)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog.querySelectorAll('[data-highlight="true"]')).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button',{name:'收起原句前文（1 段）'}));
    const search=within(dialog).getByRole('searchbox');act(()=>search.focus());
    fireEvent.change(search,{target:{value:'展览'}});
    expect(within(dialog).getByText(before.text)).toBeInTheDocument();
    expect(within(dialog).getByText('1 处匹配')).toBeInTheDocument();expect(search).toHaveFocus();
  });

  it("keeps the visible quote and typed search during an error retry without a second positioning",async()=>{
    await open();
    const saved=adapter().getSnapshot().availableSources.find(r=>r.sources.some(s=>s.quote.includes('相册')))!;
    saved.fullTranscript=false;
    let finish!:(record:PreviewRecord|null)=>void;
    adapter().loadRecord=vi.fn().mockRejectedValueOnce(new Error('http_503')).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    fireEvent.click(within(note('item-album')).getByRole('button',{name:/查看依据/}));
    adapter().getSnapshot().availableSources.find(r=>r.id===saved.id)!.fullTranscript=false;
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:/查看文字稿/}));
    const dialog=screen.getByRole('dialog'),quote=dialog.querySelector('[data-highlight="true"]')!;
    await waitFor(()=>expect(dialog.querySelector('[data-reader-state]')).toHaveAttribute('data-reader-state','error'));
    expect(quote.compareDocumentPosition(within(dialog).getByRole('alert'))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const search=within(dialog).getByRole('searchbox');act(()=>search.focus());fireEvent.change(search,{target:{value:'相册'}});
    const retry=within(dialog).getByRole('button',{name:'重新读取文字稿'});act(()=>retry.focus());fireEvent.click(retry);
    expect(search).toHaveValue('相册');expect(dialog.querySelector('[data-highlight="true"]')).toBe(quote);
    expect(retry).toHaveFocus();expect(retry).toHaveAttribute('aria-disabled','true');
    expect(dialog.querySelector('[data-reader-state]')).toHaveAttribute('data-reader-state','loading');
    expect(within(dialog).queryByText(/本机没有完整文字稿/)).not.toBeInTheDocument();
    const focus=vi.spyOn(quote as HTMLElement,'focus');
    await act(async()=>finish({...saved,fullTranscript:true}));
    expect(dialog.querySelector('[data-reader-state]')).toHaveAttribute('data-reader-state','success-full');
    expect(search).toHaveValue('相册');expect(retry).toHaveFocus();expect(focus).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button',{name:'文字稿已核对'})).toBe(retry);
    fireEvent.click(retry);expect(adapter().loadRecord).toHaveBeenCalledTimes(2);
  });

  it("a failed full-text read retries locally and returns to the original source button",async()=>{
    await open();
    const saved=adapter().getSnapshot().availableSources.find(r=>r.sources.some(s=>s.quote.includes('相册')))!;
    adapter().loadRecord=vi.fn().mockRejectedValueOnce(new Error('http_503')).mockResolvedValueOnce(saved);
    fireEvent.click(within(note('item-album')).getByRole('button',{name:/查看依据/}));
    const original=within(screen.getByRole('dialog')).getByRole('button',{name:/查看文字稿/});act(()=>original.focus());fireEvent.click(original);
    await waitFor(()=>expect(screen.getByText('文字稿暂时没能读取，已保存的依据仍可核对。')).toBeInTheDocument());
    const retry=screen.getByRole('button',{name:'重新读取文字稿'});act(()=>retry.focus());fireEvent.click(retry);
    await waitFor(()=>expect(screen.queryByRole('button',{name:'重新读取文字稿'})).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button',{name:/返回来源/}));
    await waitFor(()=>expect(within(screen.getByRole('dialog')).getByRole('button',{name:/查看文字稿/})).toHaveFocus());
  });
});

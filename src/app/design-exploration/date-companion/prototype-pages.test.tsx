import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CompanionLogin,
  CompanionModuleSelection,
  CompanionPrototype,
  prototypeScreens
} from "./_components/companion-prototypes";
import { getLocalTimeGreeting } from "./_components/local-time-greeting";
import { generateStaticParams } from "./a/[[...screen]]/page";

const explorationPath = "/design-exploration/date-companion";
const modulesPath = `${explorationPath}/modules`;
const aPath = `${explorationPath}/a`;
const explorationDirectory = resolve(
  process.cwd(),
  "src/app/design-exploration/date-companion"
);
const componentPath = resolve(
  explorationDirectory,
  "_components/companion-prototypes.tsx"
);
const stylesheetPath = resolve(
  explorationDirectory,
  "_components/exploration.module.css"
);
const explicitARoutePath = resolve(
  explorationDirectory,
  "a/[[...screen]]/page.tsx"
);
const oldConceptRoutePath = resolve(
  explorationDirectory,
  "[concept]/[[...screen]]/page.tsx"
);
const componentSource = readFileSync(componentPath, "utf8");
const stylesheetSource = readFileSync(stylesheetPath, "utf8");
const explicitARouteSource = readFileSync(explicitARoutePath, "utf8");
const forbiddenTerms = /\b(memory|retrieval|citation|scope|current|week|all|provider|model|embedding|identity|pipeline|shadow)\b|owner\s+review/i;
const forbiddenRuntime = /fetch\s*\(|\/api\/|axios|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie|cookies\s*\(|["']use server["']|next-auth|signIn\s*\(|clerk|supabase|firebase|MediaRecorder|getUserMedia|navigator\.mediaDevices|FormData|FileReader|URL\.createObjectURL|new\s+Audio|HTMLAudioElement|HTMLMediaElement|type\s*=\s*["']file["']/i;

function collectRuntimeSource(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return [collectRuntimeSource(path)];
      if (!entry.name.match(/\.(?:ts|tsx)$/) || entry.name.endsWith(".test.tsx")) return [];
      return [readFileSync(path, "utf8")];
    })
    .join("\n");
}

describe("Daily Brief static product entry and date companion", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("starts from an immediate static login screen", () => {
    render(<CompanionLogin />);

    expect(document.querySelector("main")).toHaveAttribute("data-entry-screen", "login");
    expect(screen.getByRole("heading", { name: "把重要的人和片段，轻轻放在这里。" })).toBeInTheDocument();
    expect(screen.getByText("私人空间已准备好")).toBeInTheDocument();
    expect(screen.getByText("Daily Brief 体验账号")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /使用演示账号登录/ })).toHaveAttribute(
      "href",
      modulesPath
    );
    expect(document.querySelector("form, input, button[type=submit]")).not.toBeInTheDocument();
    expect(screen.getByText("不会验证、保存或发送任何账号信息")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "问问 Daily Brief" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows three themed spaces but only date companion can be entered", () => {
    render(<CompanionModuleSelection />);

    expect(document.querySelector("main")).toHaveAttribute(
      "data-entry-screen",
      "module-selection"
    );
    const productSpaces = screen.getByRole("region", { name: "三个产品空间" });
    expect(within(productSpaces).getByRole("heading", { name: "约会陪伴" })).toBeInTheDocument();
    expect(within(productSpaces).getByRole("heading", { name: "办公复盘" })).toBeInTheDocument();
    expect(within(productSpaces).getByRole("heading", { name: "日常闲聊" })).toBeInTheDocument();
    expect(within(productSpaces).getAllByText("开发中")).toHaveLength(2);

    const productLinks = within(productSpaces).getAllByRole("link");
    expect(productLinks).toHaveLength(1);
    expect(productLinks[0]).toHaveAttribute("href", aPath);

    const dateCard = productSpaces.querySelector('[data-module="date-companion"]');
    const officeCard = productSpaces.querySelector('[data-module="office-recap"]');
    const chatCard = productSpaces.querySelector('[data-module="daily-chat"]');
    expect(dateCard).toHaveAttribute("data-theme", "rose");
    expect(officeCard).toHaveAttribute("data-theme", "mist-blue");
    expect(chatCard).toHaveAttribute("data-theme", "sage");
    expect(officeCard).toHaveAttribute("aria-disabled", "true");
    expect(chatCard).toHaveAttribute("aria-disabled", "true");
    expect(officeCard?.querySelector("a[href]")).toBeNull();
    expect(chatCard?.querySelector("a[href]")).toBeNull();
    expect(screen.queryByRole("button", { name: "问问 Daily Brief" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the selected date companion focused on one person and long recordings", () => {
    render(<CompanionPrototype screen="home" />);

    expect(document.querySelector("main")).toHaveAttribute(
      "data-resolution-support",
      "1080p-2k"
    );
    expect(document.querySelector("main")).toHaveAttribute("data-theme", "rose");
    expect(document.querySelector('[data-relationship-mode="single-person"]')).toBeInTheDocument();
    expect(screen.queryByText("最近的人")).not.toBeInTheDocument();
    expect(screen.queryByText(/夏晚/)).not.toBeInTheDocument();

    const uploadLabel = screen.getByText("上传这次相处的录音");
    const uploadDetails = uploadLabel.closest("details");
    expect(uploadDetails).toHaveAttribute("data-upload-mode", "long-recording");
    expect(uploadDetails).toHaveAttribute("data-panel-mode", "dropdown-drawer");
    expect(uploadDetails).not.toHaveAttribute("open");
    fireEvent.click(uploadLabel.closest("summary")!);
    expect(uploadDetails).toHaveAttribute("open");
    expect(screen.getByText("把这次相处的声音放进来")).toBeInTheDocument();
    expect(screen.getByText("从电脑里选择一段完整录音 · 这里只演示入口")).toBeInTheDocument();
    expect(screen.queryByText("选择一段长录音")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "录音选择抽屉" })).toHaveAttribute(
      "data-upload-drawer",
      "anchored"
    );
    expect(screen.getByRole("link", { name: /查看整理后的样例/ })).toHaveAttribute(
      "href",
      `${aPath}/recap`
    );
    expect(document.querySelector("input[type=file], audio, video")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [4, "晚上好"],
    [5, "早上好"],
    [8, "早上好"],
    [9, "上午好"],
    [10, "上午好"],
    [11, "中午好"],
    [13, "中午好"],
    [14, "下午好"],
    [17, "下午好"],
    [18, "晚上好"]
  ] as const)("maps local hour %i to %s", (hour, greeting) => {
    expect(getLocalTimeGreeting(hour)).toBe(greeting);
  });

  it("shows only a local-time greeting on the home page", () => {
    render(<CompanionPrototype screen="home" />);

    const greeting = document.querySelector("[data-local-time-greeting]");
    expect(greeting).toHaveTextContent(/^(早上好|上午好|中午好|下午好|晚上好)$/);
    expect(greeting).not.toHaveTextContent(/你和|林澄/);
  });

  it("keeps the desktop upload drawer out of the home grid flow", () => {
    expect(stylesheetSource).toMatch(/\.aUploadAction\s*\{[\s\S]*?position:\s*relative;/);
    expect(stylesheetSource).toMatch(/@media \(min-width:\s*1000px\)[\s\S]*?\.aUploadPanel\s*\{[\s\S]*?position:\s*absolute;/);
    expect(stylesheetSource).toMatch(/\.aUploadPanel\s*\{[\s\S]*?overflow-y:\s*auto;/);
  });

  it("keeps every date companion action explicit and static", () => {
    const person = render(<CompanionPrototype screen="person" />);
    expect(screen.getByRole("link", { name: /见Ta前看一眼/ })).toHaveAttribute(
      "href",
      `${aPath}/prepare`
    );
    expect(screen.getByText("打开见面前提示，不会修改任何记录")).toBeInTheDocument();
    person.unmount();

    const recap = render(<CompanionPrototype screen="recap" />);
    const confirm = screen.getByRole("button", { name: /确认留下 4 条内容/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认是我和林澄" }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(within(recap.container.querySelector('[data-module="recap-confirmation"]') as HTMLElement).getByRole("status")).toHaveTextContent("未保存任何内容");
    recap.unmount();

    render(<CompanionPrototype screen="prepare" />);
    expect(screen.queryByText("我准备好了")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /看完了，回到林澄/ })).toHaveAttribute(
      "href",
      `${aPath}/person`
    );
    const preparePromises = screen.getByRole("list", { name: "见面前想起的约定" });
    expect(preparePromises.querySelectorAll("li")).toHaveLength(3);
    expect(within(preparePromises).getAllByText("还没做到")).toHaveLength(2);
    expect(within(preparePromises).getByText("已经做到")).toBeInTheDocument();
    expect(screen.getByText("只结束这次查看，不会修改任何内容")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses uniform four-card grids for the person and recap pages", () => {
    const person = render(<CompanionPrototype screen="person" />);
    const personCards = screen.getByRole("region", { name: "关于Ta的四个片段" });
    expect(personCards).toHaveAttribute("data-uniform-card-group", "person");
    expect(personCards.querySelectorAll(":scope > article")).toHaveLength(4);
    for (const title of ["你记得的Ta", "Ta最近", "你们之间", "你答应了"]) {
      expect(within(personCards).getByRole("heading", { name: title })).toBeInTheDocument();
    }
    person.unmount();

    const recap = render(<CompanionPrototype screen="recap" />);
    const recapCards = recap.container.querySelector('[data-uniform-card-group="recap"]');
    expect(recapCards).toBeInTheDocument();
    expect(recapCards?.querySelectorAll(":scope > article")).toHaveLength(4);
    for (const title of [
      "这次最值得留下的一刻",
      "Ta特别提到了什么？",
      "你答应了什么？",
      "下次想从哪里继续？"
    ]) {
      expect(within(recapCards as HTMLElement).getByRole("heading", { name: title })).toBeInTheDocument();
    }

    expect(stylesheetSource).toMatch(
      /--a-profile-card-row:\s*clamp\(210px,\s*24vh,\s*238px\)/
    );
    expect(stylesheetSource).toMatch(
      /\.aProfileFacts\s*\{[\s\S]*?grid-template-rows:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/
    );
    expect(stylesheetSource).toMatch(
      /\.aPromptCards\s*\{[\s\S]*?grid-auto-rows:\s*clamp\(224px,\s*24vh,\s*250px\)/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["你记得的Ta", "remembered", "right"],
    ["Ta最近", "recent", "left"],
    ["你们之间", "between", "right"],
    ["你答应了", "promise", "left"]
  ] as const)("expands %s into the four-card canvas and restores it", (title, cardId, squeezeSide) => {
    render(<CompanionPrototype screen="person" />);

    const group = screen.getByRole("region", { name: "关于Ta的四个片段" });
    const trigger = within(group).getByRole("button", { name: title });
    expect(group).toHaveAttribute("data-expanded-card", "none");
    expect(group).toHaveAttribute("data-squeeze-side", "none");
    expect(trigger).toHaveAttribute("type", "button");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls");
    trigger.focus();

    fireEvent.click(trigger);

    expect(group).toHaveAttribute("data-expanded-card", cardId);
    expect(group).toHaveAttribute("data-squeeze-side", squeezeSide);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const cards = Array.from(group.querySelectorAll<HTMLElement>(":scope > article"));
    const expanded = cards.find((card) => card.dataset.cardState === "expanded");
    const compact = cards.filter((card) => card.dataset.cardState === "compact");
    expect(expanded).toHaveAttribute("data-card-id", cardId);
    expect(expanded?.querySelector("[data-profile-fact-content]")).not.toHaveAttribute("hidden");
    expect(within(expanded as HTMLElement).getAllByText("回到原话")).toHaveLength(3);
    expect(compact).toHaveLength(3);
    expect(compact.map((card) => card.dataset.railOrder)).toEqual(["1", "2", "3"]);
    for (const card of compact) {
      expect(card.querySelector("[data-profile-fact-content]")).toHaveAttribute("hidden");
    }

    fireEvent.click(trigger);

    expect(group).toHaveAttribute("data-expanded-card", "none");
    expect(group).toHaveAttribute("data-squeeze-side", "none");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(cards.every((card) => card.dataset.cardState === "idle")).toBe(true);
    expect(cards.every((card) => !card.querySelector("[data-profile-fact-content]")?.hasAttribute("hidden"))).toBe(true);
    expect(trigger).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("switches directly from a compact card to the opposite expanded side", () => {
    render(<CompanionPrototype screen="person" />);

    const group = screen.getByRole("region", { name: "关于Ta的四个片段" });
    fireEvent.click(within(group).getByRole("button", { name: "你记得的Ta" }));
    expect(group).toHaveAttribute("data-expanded-card", "remembered");
    expect(group).toHaveAttribute("data-squeeze-side", "right");

    const recent = within(group).getByRole("button", { name: "Ta最近" });
    fireEvent.click(recent);

    expect(group).toHaveAttribute("data-expanded-card", "recent");
    expect(group).toHaveAttribute("data-squeeze-side", "left");
    expect(recent).toHaveAttribute("aria-expanded", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps participant confirmation and every recap control inside a reversible UI demo", () => {
    const rendered = render(<CompanionPrototype screen="recap" />);

    const existingProgress = screen.getByLabelText("本次录音整理进度");
    expect(existingProgress.children).toHaveLength(3);
    expect(existingProgress).toHaveTextContent("录音已上传");
    expect(existingProgress).toHaveTextContent("已经转成文字");
    expect(existingProgress).toHaveTextContent("等你确认");
    expect(rendered.container).not.toHaveTextContent(/失败|重试|删除录音|隐私与数据/);

    const people = screen.getByRole("region", { name: "你和林澄（Ta）" });
    expect(people).toHaveAttribute("data-module", "people-confirmation");
    fireEvent.click(within(people).getByText("需要核对？"));
    expect(within(people).getByText(/录音里的原话 A · 我/)).toBeInTheDocument();
    expect(within(people).getByText(/录音里的原话 B · 林澄/)).toBeInTheDocument();
    expect(within(people).getByText(/不会真的辨认或改写人物/)).toBeInTheDocument();

    const finalConfirm = screen.getByRole("button", { name: /确认留下 4 条内容/ });
    expect(finalConfirm).toBeDisabled();

    const confirmPeople = within(people).getByRole("button", { name: "确认是我和林澄" });
    fireEvent.click(confirmPeople);
    expect(confirmPeople).toHaveAttribute("aria-pressed", "true");
    expect(within(people).getByRole("status")).toHaveTextContent("没有保存");
    expect(finalConfirm).toBeEnabled();

    const recapGroup = rendered.container.querySelector('[data-uniform-card-group="recap"]')!;
    expect(recapGroup.querySelectorAll(":scope > article")).toHaveLength(4);
    const mentioned = recapGroup.querySelector<HTMLElement>('[data-recap-item="mentioned"]')!;

    fireEvent.click(within(mentioned).getByRole("button", { name: "修改这条：Ta特别提到了什么？" }));
    const editor = within(mentioned).getByRole("textbox", { name: "修改这条：Ta特别提到了什么？" });
    expect(editor).toHaveValue("第一次参加市集，担心自己的作品还不够成熟。");
    fireEvent.change(editor, { target: { value: "Ta很期待第一次独立摆摊，也希望有人听听准备过程。" } });
    fireEvent.click(within(mentioned).getByRole("button", { name: "应用到界面样例" }));
    expect(within(mentioned).getByText("Ta很期待第一次独立摆摊，也希望有人听听准备过程。")).toBeInTheDocument();
    expect(screen.getByText("修改只显示在这个界面样例里，刷新后会恢复。")).toBeInTheDocument();

    const original = within(mentioned).getByRole("button", { name: "回到原话：Ta特别提到了什么？" });
    expect(original).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(original);
    expect(original).toHaveAttribute("aria-expanded", "true");
    const originalTray = screen.getByLabelText("原话：Ta特别提到了什么？");
    expect(originalTray).toHaveAttribute("data-original-fragment", "mentioned");
    expect(within(originalTray).getByText("18:42")).toBeInTheDocument();
    expect(within(originalTray).getByText(/第一次一个人摆摊/)).toBeInTheDocument();
    fireEvent.click(within(originalTray).getByRole("button", { name: "在完整文字稿中查看" }));
    expect(screen.getByText("查看完整文字稿").closest("details")).toHaveAttribute("open");
    expect(document.querySelector("#transcript-market-concern")).toHaveAttribute("aria-current", "true");

    fireEvent.click(within(mentioned).getByRole("button", { name: "这条不留下：Ta特别提到了什么？" }));
    expect(mentioned).toHaveAttribute("data-review-state", "excluded");
    expect(screen.getByRole("button", { name: /确认留下 3 条内容/ })).toBeEnabled();
    fireEvent.click(within(mentioned).getByRole("button", { name: "恢复这条：Ta特别提到了什么？" }));
    expect(mentioned).toHaveAttribute("data-review-state", "kept");
    expect(screen.getByRole("button", { name: /确认留下 4 条内容/ })).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();

    rendered.unmount();
    render(<CompanionPrototype screen="recap" />);
    expect(screen.getByText("第一次参加市集，担心自己的作品还不够成熟。")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows multiple promises with reversible status inside the expanded person card", () => {
    render(<CompanionPrototype screen="person" />);

    const group = screen.getByRole("region", { name: "关于Ta的四个片段" });
    fireEvent.click(within(group).getByRole("button", { name: "你答应了" }));
    const promiseList = within(group).getByRole("region", { name: "你答应的几件事" });
    expect(promiseList).toHaveAttribute("data-module", "promise-list");
    expect(promiseList.querySelectorAll("li")).toHaveLength(3);
    expect(promiseList.querySelectorAll('[data-promise-state="open"]')).toHaveLength(2);
    expect(promiseList.querySelectorAll('[data-promise-state="done"]')).toHaveLength(1);

    const markDone = within(promiseList).getByRole("button", {
      name: "标为已经做到：把那家唱片店的地址发给Ta"
    });
    fireEvent.click(markDone);
    expect(promiseList.querySelector('[data-promise-state="done"]')).toBeInTheDocument();
    expect(within(promiseList).getByRole("button", {
      name: "改回还没做到：把那家唱片店的地址发给Ta"
    })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(group).getByRole("button", { name: "你答应了" }));
    expect(within(group).getByText("1 件还记着 · 2 件已经做到。点开可以逐件看看。")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "你答应了" }));
    fireEvent.click(within(group).getAllByText("回到原话")[0]);
    expect(within(group).getByText(/那家周六下午也开门/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searches the whole relationship while keeping history and gentle observations intact", () => {
    const rendered = render(<CompanionPrototype screen="person" />);

    const history = screen.getByRole("region", { name: "一起走过的几次" });
    expect(history).toHaveAttribute("data-module", "interaction-history");
    expect(history.querySelectorAll("[data-interaction-entry]")).toHaveLength(3);
    expect(history.querySelectorAll("[data-interaction-fragment]")).toHaveLength(7);
    expect(screen.getByRole("navigation", { name: "约会陪伴页面" }).querySelectorAll("a")).toHaveLength(4);

    const search = screen.getByRole("search", { name: "找一找你和林澄之间的内容" });
    const searchInput = within(search).getByRole("textbox", { name: "找一句话、一个地方或一件小事" });
    fireEvent.change(searchInput, { target: { value: "唱片店" } });

    const promiseResult = rendered.container.querySelector<HTMLElement>('[data-relationship-search-result][data-search-kind="promise"]')!;
    const recapResult = rendered.container.querySelector<HTMLElement>('[data-relationship-search-result][data-search-kind="recap"]')!;
    const interactionResults = rendered.container.querySelectorAll<HTMLElement>('[data-relationship-search-result][data-search-kind="interaction"]');
    expect(promiseResult).toHaveTextContent("把唱片店的地址发给Ta");
    expect(recapResult).toHaveTextContent("你答应了什么？");
    expect([...interactionResults].some((result) => result.textContent?.includes("唱片店和桂花拿铁"))).toBe(true);
    expect(within(recapResult).getByRole("link", { name: /打开这次相处/ })).toHaveAttribute(
      "href",
      `${aPath}/recap#recap-card-promise`
    );
    fireEvent.click(within(promiseResult).getByText("回到原话"));
    expect(within(promiseResult).getByText(/我回去把那家唱片店的地址发给你/)).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "桂花" } });
    expect(rendered.container.querySelector('[data-search-kind="remembered"]')).toBeInTheDocument();
    expect(rendered.container.querySelector('[data-search-kind="interaction"]')).toBeInTheDocument();
    expect(history.querySelectorAll("[data-interaction-entry]")).toHaveLength(3);

    fireEvent.change(searchInput, { target: { value: "没有出现的词" } });
    expect(screen.getByRole("status")).toHaveTextContent("还没有");
    fireEvent.click(within(search).getByRole("button", { name: "清空" }));
    expect(searchInput).toHaveValue("");
    expect(rendered.container.querySelector("[data-relationship-search-result]")).toBeNull();
    expect(history.querySelectorAll("[data-interaction-entry]")).toHaveLength(3);

    const observations = screen.getByRole("region", { name: "关于你们的一点观察" });
    expect(observations).toHaveAttribute("data-module", "relationship-observations");
    expect(observations.querySelectorAll("article")).toHaveLength(1);
    expect(observations).toHaveTextContent(/可能/);
    expect(observations).toHaveTextContent(/不一定完整/);
    expect(observations.querySelector("meter, progress")).toBeNull();
    expect(rendered.container.querySelector('[data-module="privacy-controls"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives every prepare item a quiet and specific original fragment", () => {
    const rendered = render(<CompanionPrototype screen="prepare" />);
    const items = rendered.container.querySelectorAll("[data-prepare-item]");
    expect(items).toHaveLength(6);

    const sourceLabels: string[] = [];
    for (const item of items) {
      const source = item.querySelector<HTMLElement>("[data-prepare-source]");
      expect(source).not.toBeNull();
      expect(source?.querySelector("time[datetime]")).not.toBeNull();
      const summary = source?.querySelector("summary");
      expect(summary?.getAttribute("aria-label")).toMatch(/^回到原话：/);
      sourceLabels.push(summary?.getAttribute("aria-label") ?? "");
    }
    expect(new Set(sourceLabels).size).toBe(sourceLabels.length);

    fireEvent.click(screen.getByText("你答应过的事"));
    fireEvent.click(screen.getByLabelText("回到原话：把唱片店的地址发给Ta"));
    expect(screen.getByText(/我回去把那家唱片店的地址发给你/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("可以自然继续的话题"));
    fireEvent.click(screen.getByLabelText("回到原话：可以自然继续的话题"));
    expect(screen.getByText(/下次见面给我看看/)).toBeInTheDocument();
    expect(rendered.container.querySelector('input[type="file"], audio, video')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expands a substantial ordered transcript and searches inside it locally", () => {
    const rendered = render(<CompanionPrototype screen="recap" />);
    const transcriptDetails = screen.getByText("查看完整文字稿").closest("details")!;
    expect(transcriptDetails).not.toHaveAttribute("open");

    fireEvent.click(within(transcriptDetails).getByText("查看完整文字稿"));
    expect(transcriptDetails).toHaveAttribute("open");

    const transcript = screen.getByRole("region", { name: "周日晚餐完整文字稿" });
    expect(transcript).toHaveAttribute("data-transcript-mode", "full-review");
    const lines = transcript.querySelectorAll<HTMLElement>("[data-transcript-line]");
    expect(lines.length).toBeGreaterThanOrEqual(20);
    for (const line of lines) {
      expect(line.querySelector("time[datetime]")).not.toBeNull();
      expect(line.getAttribute("data-speaker")).toMatch(/^(你|林澄)$/);
    }
    const dateTimes = [...lines].map((line) => line.querySelector("time")!.getAttribute("datetime"));
    expect(dateTimes).toEqual([...dateTimes].sort());
    expect(transcript).toHaveTextContent(/第一次一个人摆摊/);
    expect(transcript).toHaveTextContent(/围巾给你一半/);
    expect(transcript).toHaveTextContent(/妈妈生日/);
    expect(transcript).toHaveTextContent(/唱片店的地址发给你/);

    const transcriptSearch = within(transcript).getByRole("search", { name: "在周日晚餐文字稿里查找" });
    const transcriptInput = within(transcriptSearch).getByRole("textbox", { name: "在这次相处里找一句话" });
    fireEvent.change(transcriptInput, { target: { value: "围巾" } });
    expect(within(transcript).getByRole("status")).toHaveTextContent(/找到 2 处/);
    expect(transcript.querySelectorAll("[data-transcript-line]")).toHaveLength(2);
    fireEvent.click(within(transcriptSearch).getByRole("button", { name: "清空" }));
    expect(transcript.querySelectorAll("[data-transcript-line]").length).toBeGreaterThanOrEqual(20);
    expect(transcript.querySelector("audio, video")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("links only the four selected date companion screens and returns to spaces", () => {
    for (const selectedScreen of prototypeScreens) {
      const rendered = render(<CompanionPrototype screen={selectedScreen} />);
      const navigation = screen.getByRole("navigation", { name: "约会陪伴页面" });
      const links = within(navigation).getAllByRole("link");

      expect(links).toHaveLength(4);
      for (const link of links) {
        expect(link.getAttribute("href")).toMatch(new RegExp(`^${aPath}(?:/|$)`));
      }
      expect(screen.getByRole("link", { name: /返回空间选择/ })).toHaveAttribute(
        "href",
        modulesPath
      );
      expect(navigation.querySelector('[aria-current="page"]')).toBeInTheDocument();
      rendered.unmount();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["home", "Ta最近提到过什么？"],
    ["person", "林澄喜欢什么？"],
    ["recap", "帮我回顾这次值得记住的内容。"],
    ["prepare", "见Ta之前，我最需要想起什么？"]
  ] as const)("opens a contextual static question drawer from %s", (selectedScreen, prompt) => {
    render(<CompanionPrototype screen={selectedScreen} />);

    const trigger = screen.getByRole("button", { name: "问问 Daily Brief" });
    expect(trigger).toHaveAttribute("type", "button");
    expect(trigger).toHaveAttribute("data-emphasis", "primary");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "问问 Daily Brief" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("button", { name: prompt })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "约会陪伴页面" }).querySelector('[aria-current="page"]')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("presents the question entry as a visible primary companion action", () => {
    render(<CompanionPrototype screen="home" />);

    const trigger = screen.getByRole("button", { name: "问问 Daily Brief" });
    expect(within(trigger).getByText("✦")).toHaveAttribute("aria-hidden", "true");
    expect(stylesheetSource).toMatch(/\.questionTrigger\s*\{[\s\S]*?background:\s*linear-gradient/);
    expect(stylesheetSource).toMatch(/\.questionTrigger\s*\{[\s\S]*?box-shadow:/);
    expect(stylesheetSource).toMatch(/\.questionTrigger:focus-visible\s*\{/);
  });

  it.each([
    ["person", "Ta最近在准备什么？", /还在挑要带去市集的那一组杯子/],
    ["recap", "这次我答应了什么？", /我回去把那家唱片店的地址发给你/]
  ] as const)("keeps the original fragments matched to a %s question", (selectedScreen, prompt, sourceText) => {
    render(<CompanionPrototype screen={selectedScreen} />);

    fireEvent.click(screen.getByRole("button", { name: "问问 Daily Brief" }));
    const dialog = screen.getByRole("dialog", { name: "问问 Daily Brief" });
    fireEvent.click(within(dialog).getByRole("button", { name: prompt }));
    fireEvent.click(within(dialog).getByRole("button", { name: "显示静态回答样例" }));
    fireEvent.click(within(dialog).getByText("回到原话 · 2 段相处"));
    expect(within(dialog).getByText(sourceText)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the question interaction static, closable and keyboard friendly", () => {
    render(<CompanionPrototype screen="home" />);

    const trigger = screen.getByRole("button", { name: "问问 Daily Brief" });
    fireEvent.click(trigger);
    let dialog = screen.getByRole("dialog", { name: "问问 Daily Brief" });
    const prompt = within(dialog).getByRole("button", { name: "Ta最近提到过什么？" });
    fireEvent.click(prompt);

    const showAnswer = within(dialog).getByRole("button", { name: "显示静态回答样例" });
    expect(showAnswer).toBeEnabled();
    fireEvent.click(showAnswer);
    expect(within(dialog).getByText("静态回答样例")).toBeInTheDocument();
    expect(within(dialog).getByText(/第一次独立摆摊/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭问问 Daily Brief" }));
    expect(screen.queryByRole("dialog", { name: "问问 Daily Brief" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    dialog = screen.getByRole("dialog", { name: "问问 Daily Brief" });
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "问问 Daily Brief" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets the question drawer demonstrate free text, recent questions and original fragments without sending", () => {
    render(<CompanionPrototype screen="person" />);

    fireEvent.click(screen.getByRole("button", { name: "问问 Daily Brief" }));
    let dialog = screen.getByRole("dialog", { name: "问问 Daily Brief" });
    const input = within(dialog).getByRole("textbox", { name: "想问的内容" });
    const submit = within(dialog).getByRole("button", { name: "显示静态回答样例" });
    expect(input).not.toHaveAttribute("readonly");
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: "Ta最近有没有反复提到一件事？" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(within(dialog).getByText("“Ta最近有没有反复提到一件事？”")).toBeInTheDocument();
    expect(within(dialog).getByText(/从你和林澄已经留下的片段里/)).toBeInTheDocument();

    const history = within(dialog).getByRole("region", { name: "刚刚问过" });
    expect(history).toHaveAttribute("data-module", "question-history");
    expect(within(history).getByRole("button", {
      name: "重新查看：Ta最近有没有反复提到一件事？"
    })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByText("回到原话 · 2 段相处"));
    expect(within(dialog).getByText(/书页边上有以前读者留下的小字/)).toBeInTheDocument();
    expect(dialog.querySelectorAll("time")).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭问问 Daily Brief" }));
    fireEvent.click(screen.getByRole("button", { name: "问问 Daily Brief" }));
    dialog = screen.getByRole("dialog", { name: "问问 Daily Brief" });
    expect(within(dialog).getByRole("textbox", { name: "想问的内容" })).toHaveValue("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes B, C and D from components, styles and routing", () => {
    expect(componentSource).not.toMatch(
      /function\s+(?:B|C|D)(?:Home|Person|Recap|Prepare)\b|四套原型|四个方向|同一段关系，四种产品入口|prototypePath\(["'][bcd]["']/
    );
    expect(stylesheetSource).not.toMatch(/(^|[\s,{])\.(?:b|c|d)[A-Z][\w-]*/m);
    expect(existsSync(oldConceptRoutePath)).toBe(false);
    expect(existsSync(explicitARoutePath)).toBe(true);
    expect(explicitARouteSource).toContain("export const dynamicParams = false");
    expect(explicitARouteSource).not.toMatch(/conceptIds|isConceptId|\[concept\]/);
    expect(generateStaticParams()).toEqual([
      { screen: [] },
      { screen: ["person"] },
      { screen: ["recap"] },
      { screen: ["prepare"] }
    ]);
  });

  it("keeps rendered product copy free of implementation terminology", () => {
    const fragments: string[] = [];
    const entry = render(<CompanionLogin />);
    fragments.push(entry.container.textContent ?? "");
    entry.unmount();
    const modules = render(<CompanionModuleSelection />);
    fragments.push(modules.container.textContent ?? "");
    modules.unmount();

    for (const selectedScreen of prototypeScreens) {
      const rendered = render(<CompanionPrototype screen={selectedScreen} />);
      fragments.push(rendered.container.textContent ?? "");
      rendered.unmount();
    }

    expect(fragments.join(" ")).not.toMatch(forbiddenTerms);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the whole exploration static and declares laptop resolution tiers", () => {
    const runtimeSource = collectRuntimeSource(explorationDirectory);
    expect(runtimeSource).not.toMatch(forbiddenRuntime);
    expect(runtimeSource).not.toMatch(/[他她]/);
    expect(stylesheetSource).toMatch(/@media\s*\(min-width:\s*1920px\)/);
    expect(stylesheetSource).toMatch(/@media\s*\(min-width:\s*2560px\)/);
  });
});

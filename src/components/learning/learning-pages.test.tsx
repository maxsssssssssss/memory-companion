import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningPages } from "./learning-pages";
import { learningApi, LearningApiError } from "@/lib/client/learning-api";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/client/learning-api", async original => ({ ...await original<typeof import("@/lib/client/learning-api")>(), learningApi: { list: vi.fn(), create: vi.fn(), deletePage: vi.fn() } }));
const page = { id: "p", title: "统计学基础", materialCount: 3, createdAt: "2026-09-22T01:00:00Z", updatedAt: "2026-09-22T01:00:00Z" };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(learningApi.create).mockReset(); vi.mocked(learningApi.list).mockResolvedValue({pages:[page]}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("prioritizes existing pages and preserves an unfinished title across cancel and reopen", async () => {
  render(<LearningPages />);await screen.findByRole("link",{name:/继续学习/});
  expect(screen.queryByLabelText("学习页名称")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"新建学习页"}));fireEvent.change(screen.getByLabelText("学习页名称"),{target:{value:"下一章"}});
  fireEvent.click(screen.getByRole("button",{name:"取消"}));expect(screen.getByRole("button",{name:"新建学习页"})).toHaveFocus();
  fireEvent.click(screen.getByRole("button",{name:"新建学习页"}));expect(screen.getByLabelText("学习页名称")).toHaveValue("下一章");
  expect(learningApi.create).not.toHaveBeenCalled();expect(learningApi.deletePage).not.toHaveBeenCalled();
});

it("retains the page after a failed delete, and removes it only on confirmed success", async () => {
  vi.mocked(learningApi.deletePage).mockRejectedValueOnce(new LearningApiError(503,"learning_storage_unavailable")).mockResolvedValueOnce({deleted:true});
  render(<LearningPages />);fireEvent.click(await screen.findByRole("button",{name:"删除学习页 统计学基础"}));
  const dialog=within(screen.getByRole("dialog"));expect(dialog.getByText(/永久删除/)).toHaveTextContent("无法恢复");
  fireEvent.click(dialog.getByRole("button",{name:"删除学习页"}));await waitFor(()=>expect(dialog.getByRole("alert")).toBeVisible());
  expect(screen.getByRole("link",{name:/统计学基础/})).toBeInTheDocument();
  fireEvent.click(dialog.getByRole("button",{name:"删除学习页"}));await screen.findByText("还没有学习页");
  expect(screen.queryByRole("link",{name:/统计学基础/})).not.toBeInTheDocument();
});

it("explains an empty or whitespace title instead of silently disabling creation", async () => {
  vi.mocked(learningApi.list).mockResolvedValueOnce({pages:[]});render(<LearningPages />);
  const input = await screen.findByLabelText("学习页名称"), button = screen.getByRole("button",{name:"创建学习页"});
  expect(button).toBeEnabled();fireEvent.click(button);
  expect(screen.getByRole("alert")).toHaveTextContent("请先给学习页起个名字");expect(input).toHaveFocus();
  expect(input).toHaveAttribute("aria-invalid", "true");expect(learningApi.create).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:"   "}});fireEvent.click(button);expect(learningApi.create).not.toHaveBeenCalled();
  fireEvent.change(input,{target:{value:"合成课程"}});expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("creates from the empty account form once and opens the saved page", async () => {
  vi.mocked(learningApi.list).mockResolvedValueOnce({pages:[]});
  let resolve!: (value: Awaited<ReturnType<typeof learningApi.create>>) => void;
  vi.mocked(learningApi.create).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<LearningPages />);const input=await screen.findByLabelText("学习页名称");
  fireEvent.change(input,{target:{value:"  合成课程  "}});fireEvent.click(screen.getByRole("button",{name:"创建学习页"}));
  expect(screen.getByRole("button",{name:"正在创建…"})).toBeDisabled();expect(input).toBeDisabled();
  fireEvent.submit(input.closest("form")!);expect(learningApi.create).toHaveBeenCalledTimes(1);
  expect(learningApi.create).toHaveBeenCalledWith(expect.any(String),"合成课程");
  resolve({page:{...page,title:"合成课程",revision:0,materials:[]}});
  await waitFor(()=>expect(router.push).toHaveBeenCalledWith("/learning/p"));expect(input).toHaveValue("");
});

it("keeps the title and submission identity when a failed create is retried", async () => {
  vi.mocked(learningApi.list).mockResolvedValueOnce({pages:[]});
  vi.mocked(learningApi.create).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({page:{...page,revision:0,materials:[]}});
  render(<LearningPages />);const input=await screen.findByLabelText("学习页名称");
  fireEvent.change(input,{target:{value:"合成课程"}});fireEvent.click(screen.getByRole("button",{name:"创建学习页"}));
  await screen.findByText(/未能确认保存或读取结果/);expect(input).toHaveValue("合成课程");
  expect(screen.getByRole("button",{name:"创建学习页"})).toBeEnabled();expect(router.push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"创建学习页"}));await waitFor(()=>expect(router.push).toHaveBeenCalledWith("/learning/p"));
  expect(vi.mocked(learningApi.create).mock.calls[1]).toEqual(vi.mocked(learningApi.create).mock.calls[0]);
});

it("releases the pending state when local request identity creation fails", async () => {
  vi.mocked(learningApi.list).mockResolvedValueOnce({pages:[]});
  vi.spyOn(crypto,"randomUUID").mockImplementationOnce(()=>{throw new Error("synthetic UUID failure");});
  render(<LearningPages />);fireEvent.change(await screen.findByLabelText("学习页名称"),{target:{value:"合成课程"}});
  fireEvent.click(screen.getByRole("button",{name:"创建学习页"}));
  await screen.findByText(/未能确认保存或读取结果/);expect(screen.getByRole("button",{name:"创建学习页"})).toBeEnabled();
  expect(learningApi.create).not.toHaveBeenCalled();expect(router.push).not.toHaveBeenCalled();
});

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LearningAgentTaskView } from "@/lib/client/learning-agent-api";
import { LearningAgentAdjustmentForm } from "./learning-agent-adjustment";

afterEach(cleanup);
const material = { id: "material-one", title: "[合成] 集合材料", kind: "text" as const, byteLength: 40, createdAt: "", filename: null, selected: true };
const task: LearningAgentTaskView = {
  id: "task-one", version: 1, goal: "解释交集的归属条件", status: "waiting", actions: [], wait: { kind: "feedback", message: "请核对目标与来源。" },
  scope: { materialIds: [material.id], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false },
  sourceAdjustment: { objectives: [{ id: "intersection", label: "理解同时属于的条件", currentSources: [{ materialId: material.id, paragraph: 1 }] }],
    sources: [{ materialId: material.id, paragraph: 1, title: material.title, text: "[合成] 本教材介绍集合。" },
      { materialId: material.id, paragraph: 3, title: material.title, text: "[合成] 交集中的元素必须同时属于两个集合。" }] },
};
function mount(value = task) {
  const onSubmit = vi.fn(), onClose = vi.fn(), onRefresh = vi.fn();
  const props = { task: value, materials: [material], chapters: [], disabled: false, onSubmit, onClose, onRefresh };
  return { ...render(<LearningAgentAdjustmentForm {...props} />), props, onSubmit };
}

it("requires opting into source correction, selecting actual text and confirming a before/after preview", () => {
  const { onSubmit } = mount();
  expect(screen.getByRole("checkbox", { name: "保持目标与检查要求，仅核对来源关联" })).not.toBeChecked();
  expect(screen.queryByRole("region", { name: "核对目标与来源" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "保持目标与检查要求，仅核对来源关联" }));
  expect(screen.getByLabelText("新的复习目标")).toHaveAttribute("readonly");
  fireEvent.click(screen.getByRole("checkbox", { name: "[合成] 集合材料 · 第 1 段" }));
  expect(screen.getByRole("button", { name: "预览本轮调整" })).toBeDisabled();
  fireEvent.click(screen.getByText("查看原文：[合成] 集合材料 · 第 3 段", { selector: "summary" }));
  expect(screen.getByText("[合成] 交集中的元素必须同时属于两个集合。")).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox", { name: "[合成] 集合材料 · 第 3 段" }));
  expect(screen.getByRole("checkbox", { name: "允许读取本范围的相关作答历史" })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "预览本轮调整" }));
  expect(within(screen.getByRole("region", { name: "调整前" })).getByText(/理解同时属于的条件.*第 1 段/)).toBeVisible();
  expect(within(screen.getByRole("region", { name: "调整后" })).getByText(/理解同时属于的条件.*第 3 段/)).toBeVisible();
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认调整本轮复习" }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ goal: task.goal, expectedVersion: 1, scope: task.scope,
    sourceCorrections: [{ objectiveId: "intersection", sources: [{ materialId: material.id, paragraph: 3 }] }] });
});

it("requires a separate explicit history permission to reassociate old responses", () => {
  const { onSubmit } = mount();
  fireEvent.click(screen.getByRole("checkbox", { name: "保持目标与检查要求，仅核对来源关联" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "允许读取本范围的相关作答历史" }));
  fireEvent.click(screen.getByRole("button", { name: "预览本轮调整" }));
  fireEvent.click(screen.getByRole("button", { name: "确认调整本轮复习" }));
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ scope: { includeHistory: true, includeNotes: false, includeSupplements: false } });
});

it("blocks a stale source draft and clears its corrections when the user compares the newer version", () => {
  const view = mount();
  fireEvent.click(screen.getByRole("checkbox", { name: "保持目标与检查要求，仅核对来源关联" }));
  fireEvent.click(screen.getByRole("button", { name: "预览本轮调整" }));
  view.rerender(<LearningAgentAdjustmentForm {...view.props} task={{ ...task, version: 2 }} />);
  expect(screen.getByRole("button", { name: "确认调整本轮复习" })).toBeDisabled();
  expect(view.onSubmit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "按最新内容重新比对" }));
  expect(screen.getByRole("checkbox", { name: "保持目标与检查要求，仅核对来源关联" })).not.toBeChecked();
  expect(screen.queryByRole("region", { name: "核对目标与来源" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认调整本轮复习" })).not.toBeInTheDocument();
});

it("keeps ordinary adjustments available when source correction is not authorized or not applicable", () => {
  const { onSubmit } = mount({ ...task, sourceAdjustment: undefined });
  expect(screen.queryByRole("checkbox", { name: "保持目标与检查要求，仅核对来源关联" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("新的复习目标"), { target: { value: "解释新的问题" } });
  fireEvent.click(screen.getByRole("button", { name: "预览本轮调整" }));
  fireEvent.click(screen.getByRole("button", { name: "确认调整本轮复习" }));
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ goal: "解释新的问题", expectedVersion: 1, scope: task.scope });
});

it("hides the previewed text and blocks an open correction when current source authorization becomes unavailable", () => {
  const view = mount();
  fireEvent.click(screen.getByRole("checkbox", { name: "保持目标与检查要求，仅核对来源关联" }));
  fireEvent.click(screen.getByText("查看原文：[合成] 集合材料 · 第 3 段", { selector: "summary" }));
  fireEvent.click(screen.getByRole("button", { name: "预览本轮调整" }));
  view.rerender(<LearningAgentAdjustmentForm {...view.props} task={{ ...task, sourceAdjustment: undefined }} />);
  expect(screen.queryByText("[合成] 交集中的元素必须同时属于两个集合。")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "核对目标与来源" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认调整本轮复习" })).toBeDisabled();
  expect(view.onSubmit).not.toHaveBeenCalled();
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InteractionVM, RecapItemVM } from "@/lib/domain/date-companion";

import { CompanionRecap } from "./companion-recap";

const interaction: InteractionVM = {
  id: "upload-1",
  uploadIds: ["upload-1"],
  recordingDate: "2026-08-03",
  fileName: "fixture.wav",
  title: "这次相处",
  status: "ready",
  transcript: [
    {
      id: "segment-1",
      uploadId: "upload-1",
      startSeconds: 1,
      endSeconds: 4,
      speakerId: "speaker_1",
      text: "这是一条可以核对的原话。"
    }
  ]
};

const items: RecapItemVM[] = [
  {
    id: "moment-1",
    kind: "moment",
    title: "值得记住",
    proposedText: "根据原话整理的内容",
    displayedText: "根据原话整理的内容",
    disposition: "pending",
    sources: [
      {
        id: "source-1",
        uploadId: "upload-1",
        segmentIds: ["segment-1"],
        recordingDate: "2026-08-03",
        startSeconds: 1,
        endSeconds: 4,
        speakerId: "speaker_1",
        quote: "这是一条可以核对的原话。",
        kind: "transcript",
        presentation: "direct_quote"
      }
    ]
  }
];

describe("CompanionRecap", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/date-companion/a/recap");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn()
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it("writes the real segment id into the URL and highlights the matching transcript line", async () => {
    render(<CompanionRecap interaction={interaction} items={items} />);

    fireEvent.click(screen.getByText("展开来源"));
    fireEvent.click(screen.getByRole("button", { name: "在文字稿中查看" }));

    expect(window.location.pathname).toBe("/date-companion/a/recap");
    expect(window.location.search).toBe("?segment=segment-1");
    expect(window.location.hash).toBe("#full-transcript");
    await waitFor(() =>
      expect(document.querySelector('[data-segment-id="segment-1"]')).toHaveAttribute("aria-current", "true")
    );
  });

  it("saves an explicit speaker role instead of inferring it from the transcript", async () => {
    const onSaveParticipants = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "draft", relationshipInteractionId: "interaction-1", version: 0 }}
        items={items}
        onSaveParticipants={onSaveParticipants}
        participants={[{
          speakerId: "speaker_1",
          displayLabel: "说话人 1",
          state: "confirmed",
          role: "unresolved",
          sampleQuotes: []
        }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "我" }));
    fireEvent.click(screen.getByRole("button", { name: "保存说话人判断" }));

    await waitFor(() => expect(onSaveParticipants).toHaveBeenCalledWith([
      { speakerId: "speaker_1", role: "self" }
    ]));
  });

  it("keeps edits and disposition decisions separate from final confirmation", async () => {
    const onSaveRecap = vi.fn().mockResolvedValue(undefined);
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const draftItem: RecapItemVM = { ...items[0], version: 3 };
    const draftInteraction: InteractionVM = {
      ...interaction,
      persistenceStatus: "draft",
      relationshipInteractionId: "interaction-1",
      version: 2
    };
    const { rerender } = render(
      <CompanionRecap
        interaction={draftInteraction}
        items={[draftItem]}
        onFinalize={onFinalize}
        onSaveRecap={onSaveRecap}
        participants={[{
          speakerId: "speaker_1",
          displayLabel: "说话人 1",
          state: "confirmed",
          role: "self",
          sampleQuotes: []
        }]}
      />
    );

    const finalButton = screen.getByRole("button", { name: /最终确认/u });
    expect(finalButton).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "编辑“这次值得记住”" }), {
      target: { value: "  我想留下的版本  " }
    });
    fireEvent.click(screen.getByRole("button", { name: "不留下" }));
    expect(screen.getByText("不会进入长期记录")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(screen.getByText("还没有决定")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "留下" }));
    fireEvent.click(screen.getByRole("button", { name: "保存本次修改" }));

    await waitFor(() => expect(onSaveRecap).toHaveBeenCalledWith([{
      id: "moment-1",
      version: 3,
      userText: "我想留下的版本",
      disposition: "kept"
    }]));
    expect(onFinalize).not.toHaveBeenCalled();

    rerender(
      <CompanionRecap
        interaction={{ ...draftInteraction, version: 3 }}
        items={[{
          ...draftItem,
          displayedText: "我想留下的版本",
          disposition: "kept",
          version: 4
        }]}
        onFinalize={onFinalize}
        onSaveRecap={onSaveRecap}
        participants={[{
          speakerId: "speaker_1",
          displayLabel: "说话人 1",
          state: "confirmed",
          role: "self",
          sampleQuotes: []
        }]}
      />
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /最终确认/u })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /最终确认/u }));
    await waitFor(() => expect(onFinalize).toHaveBeenCalledTimes(1));
  });

  it("shows evidence without creating a broken transcript link on a new device", () => {
    render(
      <CompanionRecap
        interaction={{ ...interaction, transcript: [], persistenceStatus: "confirmed" }}
        items={[{ ...items[0], disposition: "kept" }]}
      />
    );

    fireEvent.click(screen.getByText("展开来源"));
    expect(screen.getByText("已保留可核对原话")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在文字稿中查看" })).not.toBeInTheDocument();
    expect(screen.getByText(/这台设备没有完整文字稿/u)).toBeInTheDocument();
  });

  it("allows finalize when an unresolved speaker appears only in an excluded item", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const secondSource = {
      ...items[0].sources[0],
      id: "source-2",
      segmentIds: ["segment-2"],
      speakerId: "speaker_2",
      quote: "这条不会留下。"
    };
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 5,
          transcript: [
            ...interaction.transcript,
            { id: "segment-2", uploadId: "upload-1", startSeconds: 5, endSeconds: 8, speakerId: "speaker_2", text: "这条不会留下。" }
          ]
        }}
        items={[
          { ...items[0], disposition: "kept", version: 1 },
          { ...items[0], id: "mentioned-excluded", kind: "mentioned", disposition: "excluded", sources: [secondSource], version: 1 }
        ]}
        onFinalize={onFinalize}
        participants={[
          { speakerId: "speaker_1", displayLabel: "说话人 1", state: "confirmed", role: "self", sampleQuotes: [] },
          { speakerId: "speaker_2", displayLabel: "说话人 2", state: "unresolved", role: "unresolved", sampleQuotes: [] }
        ]}
      />
    );

    const finalButton = screen.getByRole("button", { name: /最终确认/u });
    expect(finalButton).toBeEnabled();
    fireEvent.click(finalButton);
    await waitFor(() => expect(onFinalize).toHaveBeenCalledTimes(1));
  });

  it("does not invent a participant for transcript lines without a speaker label", () => {
    const onSaveParticipants = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          transcript: [{ ...interaction.transcript[0], speakerId: undefined }]
        }}
        items={[]}
        onSaveParticipants={onSaveParticipants}
      />
    );

    expect(screen.getAllByText(/没有稳定的说话人标记/u)).toHaveLength(2);
    expect(screen.getByText("没有可核对的说话人")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存说话人判断" })).not.toBeInTheDocument();
    expect(onSaveParticipants).not.toHaveBeenCalled();
  });
});

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

  it("submits the explicitly selected role and automatic dispositions in one confirmation", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "draft", relationshipInteractionId: "interaction-1", version: 0 }}
        items={[{ ...items[0], version: 3 }]}
        onFinalize={onFinalize}
        participants={[{
          speakerId: "speaker_1",
          audioSpeakerId: "speaker_1",
          voiceEnrollmentEligible: true,
          displayLabel: "说话人 1",
          state: "confirmed",
          role: "unresolved",
          sampleQuotes: []
        }]}
      />
    );

    const audio = screen.getByLabelText("说话人 1的声音节选");
    expect(audio).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_1/audio"
    );
    expect(screen.queryByText(/Provider/u)).not.toBeInTheDocument();
    fireEvent.error(audio);
    expect(screen.getByText("声音节选暂不可用，请结合下面的原话判断。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂不确定" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "我" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [{ speakerId: "speaker_1", role: "self" }],
      [{ id: "moment-1", version: 3, disposition: "kept" }],
      []
    ));
  });

  it("shows a cross-recording suggestion as selected but still asks for review", () => {
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 0
        }}
        items={items}
        onFinalize={vi.fn().mockResolvedValue(undefined)}
        participants={[{
          speakerId: "speaker_1",
          audioSpeakerId: "speaker_1",
          voiceEnrollmentEligible: true,
          displayLabel: "说话人 1",
          state: "unresolved",
          role: "companion",
          roleSuggestion: {
            role: "companion",
            source: "previous_confirmation"
          },
          sampleQuotes: []
        }]}
      />
    );

    expect(screen.getByText("已按你上次的确认预选，请再听一次核对")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ta" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("radio", { name: /记住这段声音/u })).not.toBeInTheDocument();
  });

  it("does not offer voice enrollment when audio exists but the server eligibility gate is absent", () => {
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 0
        }}
        items={items}
        onFinalize={vi.fn().mockResolvedValue(undefined)}
        participants={[{
          speakerId: "speaker_1",
          audioSpeakerId: "speaker_1",
          displayLabel: "说话人 1",
          state: "unresolved",
          role: "unresolved",
          sampleQuotes: []
        }]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Ta" }));
    expect(screen.queryByRole("radio", { name: /记住这段声音/u })).not.toBeInTheDocument();
  });

  it("submits one explicit voice enrollment intent only after the user opts in", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 0
        }}
        items={[{ ...items[0], version: 2 }]}
        onFinalize={onFinalize}
        participants={[{
          speakerId: "review_same_voice",
          memberSpeakerIds: ["speaker_1", "speaker_chunk_2"],
          audioSpeakerId: "speaker_1",
          voiceEnrollmentEligible: true,
          displayLabel: "说话人 1",
          state: "unresolved",
          role: "unresolved",
          sampleQuotes: []
        }]}
      />
    );

    expect(screen.queryByRole("radio", { name: /记住这段声音/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ta" }));
    const enrollment = screen.getByRole("radio", { name: /记住这段声音/u });
    expect(enrollment).not.toBeChecked();
    fireEvent.click(enrollment);
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [
        { speakerId: "speaker_1", role: "companion" },
        { speakerId: "speaker_chunk_2", role: "companion" }
      ],
      [{ id: "moment-1", version: 2, disposition: "kept" }],
      [{ speakerIds: ["speaker_1", "speaker_chunk_2"] }]
    ));
  });

  it("offers multiple unproven Ta voice groups separately but submits only the one explicitly selected", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 0
        }}
        items={[{ ...items[0], version: 2 }]}
        onFinalize={onFinalize}
        participants={[
          {
            speakerId: "speaker_1",
            audioSpeakerId: "speaker_1",
            voiceEnrollmentEligible: true,
            displayLabel: "说话人 1",
            state: "unresolved",
            role: "unresolved",
            sampleQuotes: []
          },
          {
            speakerId: "speaker_2",
            audioSpeakerId: "speaker_2",
            voiceEnrollmentEligible: true,
            displayLabel: "说话人 2",
            state: "unresolved",
            role: "unresolved",
            sampleQuotes: []
          }
        ]}
      />
    );

    const companionChoices = screen.getAllByRole("button", { name: "Ta" });
    fireEvent.click(companionChoices[0]);
    fireEvent.click(companionChoices[1]);
    const enrollmentChoices = screen.getAllByRole("radio", { name: /记住这段声音/u });
    expect(enrollmentChoices).toHaveLength(2);
    expect(enrollmentChoices[0]).not.toBeChecked();
    expect(enrollmentChoices[1]).not.toBeChecked();

    fireEvent.click(enrollmentChoices[0]);
    expect(enrollmentChoices[0]).toBeChecked();
    fireEvent.click(enrollmentChoices[1]);
    expect(enrollmentChoices[0]).not.toBeChecked();
    expect(enrollmentChoices[1]).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [
        { speakerId: "speaker_1", role: "companion" },
        { speakerId: "speaker_2", role: "companion" }
      ],
      [{ id: "moment-1", version: 2, disposition: "kept" }],
      [{ speakerIds: ["speaker_2"] }]
    ));
  });

  it("confirms one reviewed voice group for every underlying chunk candidate", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 0
        }}
        items={[{ ...items[0], version: 2 }]}
        onFinalize={onFinalize}
        participants={[{
          speakerId: "review_same_voice",
          memberSpeakerIds: ["speaker_1", "speaker_chunk_2"],
          audioSpeakerId: "speaker_chunk_2",
          displayLabel: "说话人 1",
          state: "unresolved",
          role: "unresolved",
          sampleQuotes: []
        }]}
      />
    );

    expect(screen.getByLabelText("说话人 1的声音节选")).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_chunk_2/audio"
    );
    fireEvent.click(screen.getByRole("button", { name: "我" }));
    expect(screen.getByText("根据原话整理的内容").closest("[data-disposition]")).toHaveAttribute(
      "data-disposition",
      "kept"
    );
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [
        { speakerId: "speaker_1", role: "self" },
        { speakerId: "speaker_chunk_2", role: "self" }
      ],
      [{ id: "moment-1", version: 2, disposition: "kept" }],
      []
    ));
  });

  it("keeps per-item editing and exclusion optional while preserving automatic safety", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const mentioned: RecapItemVM = {
      ...items[0],
      id: "mentioned-1",
      kind: "mentioned",
      version: 4
    };
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          version: 2
        }}
        items={[{ ...items[0], version: 3 }, mentioned]}
        onFinalize={onFinalize}
        participants={[{
          speakerId: "speaker_1",
          displayLabel: "说话人 1",
          state: "confirmed",
          role: "self",
          sampleQuotes: []
        }]}
      />
    );

    expect(screen.getByRole("button", { name: "修改" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "这条不留下" })).toBeInTheDocument();
    expect(screen.getByText("未留下 1 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    const editor = screen.getByRole("textbox", { name: "修改这条：值得记住" });
    fireEvent.change(editor, { target: { value: "用户修改后的内容" } });
    fireEvent.click(screen.getByRole("button", { name: "应用修改" }));
    fireEvent.click(screen.getByRole("button", { name: "这条不留下" }));
    expect(screen.getAllByText("你选择不留下这条")).toHaveLength(1);
    fireEvent.click(screen.getAllByText("未留下 1 条")[0]);
    fireEvent.click(screen.getByRole("button", { name: "恢复这条" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));
    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [{ speakerId: "speaker_1", role: "self" }],
      [
        { id: "moment-1", version: 3, userText: "用户修改后的内容", disposition: "kept" },
        { id: "mentioned-1", version: 4, disposition: "excluded" }
      ],
      []
    ));
  });

  it("lets the speaker review collapse without changing its controls", () => {
    const { container } = render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "draft", relationshipInteractionId: "interaction-1" }}
        items={items}
        onFinalize={vi.fn()}
      />
    );

    const summary = screen.getByText("这次录音里的说话人").closest("summary");
    const details = summary?.closest("details");
    expect(details).toHaveAttribute("open");
    const selfChoice = screen.getByRole("button", { name: "我" });
    fireEvent.click(selfChoice);
    expect(selfChoice).toHaveAttribute("aria-pressed", "true");
    expect(summary).not.toBeNull();
    fireEvent.click(summary!);
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary!);
    expect(details).toHaveAttribute("open");
    expect(selfChoice).toHaveAttribute("aria-pressed", "true");
  });

  it("shows only five recap items until that group is expanded", () => {
    const manyMoments = Array.from({ length: 7 }, (_, index) => ({
      ...items[0],
      id: `moment-${index + 1}`,
      displayedText: `值得记住的内容 ${index + 1}`,
      proposedText: `值得记住的内容 ${index + 1}`
    }));
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "confirmed" }}
        items={manyMoments.map((item) => ({ ...item, disposition: "kept" }))}
      />
    );

    expect(screen.getByText("值得记住的内容 5")).toBeInTheDocument();
    expect(screen.queryByText("值得记住的内容 6")).not.toBeInTheDocument();
    const expand = screen.getByRole("button", { name: "展开其余 2 条" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expand);
    expect(screen.getByText("值得记住的内容 6")).toBeInTheDocument();
    expect(screen.getByText("值得记住的内容 7")).toBeInTheDocument();
    const collapse = screen.getByRole("button", { name: "收起，仅显示前 5 条" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(screen.queryByText("值得记住的内容 6")).not.toBeInTheDocument();
  });

  it("shows confirmed participant roles on the read-only recap", () => {
    render(
      <CompanionRecap
        interaction={{ ...interaction, persistenceStatus: "confirmed" }}
        items={[{ ...items[0], disposition: "kept" }]}
        participants={[{
          speakerId: "speaker_1",
          displayLabel: "说话人 1",
          state: "confirmed",
          role: "self",
          sampleQuotes: []
        }]}
      />
    );

    expect(screen.getByText("已确认：我")).toBeInTheDocument();
    expect(screen.queryByText("尚未核对")).not.toBeInTheDocument();
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

  it("uses the complete server participant set when this device has no transcript", async () => {
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const companionSource = {
      ...items[0].sources[0],
      id: "source-2",
      speakerId: "speaker_2",
      quote: "Ta 在服务端保留的原话。"
    };
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          transcript: [],
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1"
        }}
        items={[
          { ...items[0], version: 1 },
          { ...items[0], id: "mentioned-1", kind: "mentioned", sources: [companionSource], version: 2 }
        ]}
        onFinalize={onFinalize}
        participants={[
          {
            speakerId: "speaker_1",
            displayLabel: "第一段声音",
            state: "confirmed",
            role: "self",
            sampleQuotes: [items[0].sources[0]]
          },
          {
            speakerId: "speaker_2",
            displayLabel: "第二段声音",
            state: "confirmed",
            role: "companion",
            sampleQuotes: [companionSource]
          }
        ]}
      />
    );

    expect(screen.getByLabelText("第一段声音的声音节选")).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_1/audio"
    );
    expect(screen.getByLabelText("第二段声音的声音节选")).toHaveAttribute(
      "src",
      "/api/date-companion/interactions/interaction-1/participants/speaker_2/audio"
    );
    expect(screen.getAllByText("“Ta 在服务端保留的原话。”")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));

    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [
        { speakerId: "speaker_1", role: "self" },
        { speakerId: "speaker_2", role: "companion" }
      ],
      [
        { id: "moment-1", version: 1, disposition: "kept" },
        { id: "mentioned-1", version: 2, disposition: "kept" }
      ],
      []
    ));
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

    const finalButton = screen.getByRole("button", { name: "确认并留下这次相处" });
    expect(finalButton).toBeEnabled();
    fireEvent.click(finalButton);
    await waitFor(() => expect(onFinalize).toHaveBeenCalledWith(
      [
        { speakerId: "speaker_1", role: "self" },
        { speakerId: "speaker_2", role: "unresolved" }
      ],
      [
        { id: "moment-1", version: 1, disposition: "kept" },
        { id: "mentioned-excluded", version: 1, disposition: "excluded" }
      ],
      []
    ));
  });

  it("does not invent a participant for transcript lines without a speaker label", () => {
    render(
      <CompanionRecap
        interaction={{
          ...interaction,
          persistenceStatus: "draft",
          relationshipInteractionId: "interaction-1",
          transcript: [{ ...interaction.transcript[0], speakerId: undefined }]
        }}
        items={[]}
        onFinalize={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getAllByText(/没有稳定的说话人标记/u)).toHaveLength(2);
    expect(screen.getByText("没有可核对的说话人")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认并留下这次相处" })).toBeDisabled();
  });
});

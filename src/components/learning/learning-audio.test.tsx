import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LearningPage } from "@/lib/domain/learning";
import { learningApi, LearningApiError } from "@/lib/client/learning-api";
import { LearningAudio } from "./learning-audio";
vi.mock("@/lib/client/learning-api", async (original) => ({ ...await original<typeof import("@/lib/client/learning-api")>(), learningApi: { transcriptions: vi.fn(), transcribe: vi.fn(), get: vi.fn() } }));
const page: LearningPage = { id: "synthetic-page", title: "合成", createdAt: "", updatedAt: "", revision: 0, materialCount: 2,
  materials: ["a", "b"].map((id) => ({ id, title: `合成${id}`, kind: "audio", byteLength: 100, filename: "synthetic.wav", selected: true, createdAt: "",
    audio: { sha256: "synthetic", originalVersion: 1, mimeType: "audio/wav", durationSeconds: 1, transcription: "not_transcribed", completedChunks: 0, totalChunks: 0 } })) };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("does not transcribe on mount or selection, clears a definite no-config failure and accepts a new selected range", async () => {
  const updated = vi.fn(), saveSelection = vi.fn(async () => undefined);
  const props = { page, selected: ["a"], disabled: false, onUpdated: updated, saveSelection };
  const ui = render(<LearningAudio {...props} />); expect(learningApi.transcribe).not.toHaveBeenCalled();
  vi.mocked(learningApi.transcribe).mockRejectedValueOnce(new LearningApiError(503, "learning_asr_not_configured"));
  fireEvent.click(screen.getByRole("button", { name: "转写所选录音" }));
  await screen.findByRole("alert"); await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
  ui.rerender(<LearningAudio {...props} selected={["b"]} />);
  vi.mocked(learningApi.transcribe).mockResolvedValueOnce({ page }); fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(updated).toHaveBeenCalled());
  expect(vi.mocked(learningApi.transcribe).mock.calls.map((c) => c[2])).toEqual([["a"], ["b"]]);
  expect(saveSelection).toHaveBeenCalledTimes(2);
});
it("preserves the submission ID on unknown network outcomes instead of duplicating ASR", async () => {
  const props = { page, selected: ["a"], disabled: false, onUpdated: vi.fn(), saveSelection: vi.fn(async () => undefined) };
  render(<LearningAudio {...props} />); vi.mocked(learningApi.transcribe).mockRejectedValueOnce(new Error("network unknown"));
  fireEvent.click(screen.getByRole("button")); await screen.findByRole("alert");
  vi.mocked(learningApi.transcribe).mockResolvedValueOnce({ page }); fireEvent.click(screen.getByRole("button", { name: "核对本次转写" }));
  await waitFor(() => expect(props.onUpdated).toHaveBeenCalled());
  const calls = vi.mocked(learningApi.transcribe).mock.calls; expect(calls[0]).toEqual(calls[1]);
});

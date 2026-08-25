import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  snapshot: vi.fn()
}));

vi.mock("./return-source-repository", () => ({
  getDailyReflectionReturnSourceRepository: () => ({ snapshot: state.snapshot })
}));

import {
  getDailyReflectionMemory,
  listDailyReflectionMemories
} from "./memory-view";

function source(id: string, recordingDate: string) {
  return {
    memoryId: `memory_${id}`,
    cardId: `card_${id}`,
    reflectionId: `reflection_${id}`,
    recordingDate,
    memoryType: "decision" as const,
    cardKind: "decision" as const,
    actionClaimed: false,
    subjectPersonId: null,
    epistemicStatus: "explicit_user_statement" as const,
    epistemicCaution: null,
    riskFlags: [],
    title: `决定 ${id}`,
    content: `长期内容 ${id}`,
    importance: 0.8,
    evidence: [{
      reflectionId: `reflection_${id}`,
      cardId: `card_${id}`,
      recordingDate,
      sourceOrigin: "user_reflection" as const,
      sourceSegmentId: `segment_${id}`,
      startSeconds: 2,
      endSeconds: 8,
      snippet: `原话 ${id}`
    }]
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.snapshot.mockReturnValue({
    admitted: [source("older", "2026-08-12"), source("newer", "2026-08-24")],
    workingCards: [],
    emergingCards: [],
    relations: []
  });
});

describe("Daily Reflection memory view", () => {
  it("projects only the authoritative admitted snapshot for the requested account", () => {
    const result = listDailyReflectionMemories("account_1");

    expect(state.snapshot).toHaveBeenCalledWith("account_1", "0001-01-01", "9999-12-31");
    expect(result.memories.map((memory) => memory.id)).toEqual(["memory_newer", "memory_older"]);
    expect(result.memories[0]).toMatchObject({
      sourceCount: 1,
      epistemicStatus: "explicit_user_statement",
      content: "长期内容 newer"
    });
    expect(result).not.toHaveProperty("accountId");
  });

  it("returns no detail when the current account snapshot does not contain the id", () => {
    expect(getDailyReflectionMemory("account_2", "memory_missing")).toBeNull();
    expect(state.snapshot).toHaveBeenCalledWith("account_2", "0001-01-01", "9999-12-31");
  });
});

// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonStore } from "@/lib/server/storage/json-store";

import {
  VOICE_SESSION_COLLECTION,
  VoiceSessionAccessError,
  VoiceSessionClosedError,
  VoiceSessionExpiredError,
  VoiceSessionManager,
  VoiceSessionTransitionError
} from "./session-manager";

const USER_A = "user-a";
const USER_B = "user-b";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const TRACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STARTED_AT = Date.parse("2026-07-21T08:00:00.000Z");

let tempDir: string | undefined;
let store: JsonStore;
let nowMs: number;

function createManager(options: { ttlMs?: number; contextLimit?: number } = {}) {
  return new VoiceSessionManager({
    store,
    ttlMs: options.ttlMs ?? 60_000,
    conversationContextLimit: options.contextLimit ?? 8,
    now: () => new Date(nowMs)
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "voice-session-manager-"));
  store = new JsonStore(join(tempDir, "store"));
  nowMs = STARTED_AT;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("VoiceSessionManager", () => {
  it("creates, looks up, updates, and closes a session", async () => {
    const manager = createManager();
    const created = await manager.create({ sessionId: SESSION_A, userId: USER_A });

    expect(created).toMatchObject({
      sessionId: SESSION_A,
      userId: USER_A,
      state: "CREATED",
      recentTranscript: [],
      conversationContext: [],
      retrievedMemoryIds: []
    });

    nowMs += 1_000;
    await manager.transition(SESSION_A, "LISTENING", USER_A);
    nowMs += 1_000;
    await manager.transition(SESSION_A, "PROCESSING", USER_A);
    nowMs += 1_000;
    await manager.transition(SESSION_A, "RESPONDING", USER_A);
    nowMs += 1_000;
    const idle = await manager.transition(SESSION_A, "IDLE", USER_A);
    expect(idle.state).toBe("IDLE");
    expect(idle.lastActivityAt).toBe("2026-07-21T08:00:04.000Z");

    const closed = await manager.close(SESSION_A, USER_A);
    expect(closed.state).toBe("CLOSED");
    await expect(manager.update(SESSION_A, { currentTopic: "ignored" }, USER_A))
      .rejects.toBeInstanceOf(VoiceSessionClosedError);
  });

  it("rejects illegal lifecycle transitions", async () => {
    const manager = createManager();
    await manager.create({ sessionId: SESSION_A, userId: USER_A });

    await expect(manager.transition(SESSION_A, "RESPONDING", USER_A))
      .rejects.toBeInstanceOf(VoiceSessionTransitionError);
    expect((await manager.lookup(SESSION_A, USER_A))?.state).toBe("CREATED");
  });

  it("atomically allows only one request to claim the same idle session", async () => {
    const firstManager = createManager();
    const secondManager = createManager();
    await firstManager.create({ sessionId: SESSION_A, userId: USER_A, initialState: "IDLE" });

    const results = await Promise.allSettled([
      firstManager.claimTurn(SESSION_A, USER_A),
      secondManager.claimTurn(SESSION_A, USER_A)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(VoiceSessionTransitionError)
    });
    expect((await firstManager.lookup(SESSION_A, USER_A))?.state).toBe("LISTENING");
  });

  it("releases only the turn owned by the matching trace", async () => {
    const manager = createManager();
    await manager.create({ sessionId: SESSION_A, userId: USER_A, initialState: "IDLE" });
    await manager.claimTurn(SESSION_A, USER_A);
    await manager.attachTrace(SESSION_A, TRACE_A, USER_A);
    await manager.transition(SESSION_A, "PROCESSING", USER_A);

    const mismatched = await manager.releaseTurn(SESSION_A, TRACE_B, USER_A);
    expect(mismatched).toMatchObject({
      state: "PROCESSING",
      activeTraceId: TRACE_A
    });

    const released = await manager.releaseTurn(SESSION_A, TRACE_A, USER_A);
    expect(released.state).toBe("IDLE");
    expect(released.activeTraceId).toBeUndefined();
    await expect(
      manager.transitionTurn(SESSION_A, TRACE_A, "PROCESSING", USER_A)
    ).resolves.toMatchObject({ state: "IDLE" });
    await expect(manager.claimTurn(SESSION_A, USER_A)).resolves.toMatchObject({
      state: "LISTENING"
    });
    await manager.attachTrace(SESSION_A, TRACE_B, USER_A);
    await expect(
      manager.transitionTurn(SESSION_A, TRACE_A, "PROCESSING", USER_A)
    ).resolves.toMatchObject({
      state: "LISTENING",
      activeTraceId: TRACE_B
    });
  });

  it("clears the active trace on normal IDLE and CLOSED transitions", async () => {
    const manager = createManager();
    await manager.create({ sessionId: SESSION_A, userId: USER_A, initialState: "IDLE" });
    await manager.claimTurn(SESSION_A, USER_A);
    await manager.attachTrace(SESSION_A, TRACE_A, USER_A);
    const idle = await manager.transition(SESSION_A, "IDLE", USER_A);
    expect(idle.state).toBe("IDLE");
    expect(idle.activeTraceId).toBeUndefined();

    await manager.claimTurn(SESSION_A, USER_A);
    await manager.attachTrace(SESSION_A, TRACE_B, USER_A);
    const closed = await manager.close(SESSION_A, USER_A);
    expect(closed.state).toBe("CLOSED");
    expect(closed.activeTraceId).toBeUndefined();
  });

  it("keeps multiple sessions isolated", async () => {
    const manager = createManager();
    await manager.create({ sessionId: SESSION_A, userId: USER_A, initialState: "IDLE" });
    await manager.create({ sessionId: SESSION_B, userId: USER_A, initialState: "IDLE" });

    await manager.appendTurn(SESSION_A, {
      transcript: "I argued with my manager today.",
      response: "That sounds stressful.",
      currentTopic: "manager conversation",
      retrievedMemoryIds: ["memory-manager"]
    }, USER_A);
    await manager.appendTurn(SESSION_B, {
      transcript: "What time is dinner?",
      response: "The saved plan says seven.",
      currentTopic: "dinner plan",
      retrievedMemoryIds: ["memory-dinner"]
    }, USER_A);

    const first = await manager.lookup(SESSION_A, USER_A);
    const second = await manager.lookup(SESSION_B, USER_A);
    expect(first?.recentTranscript).toEqual(["I argued with my manager today."]);
    expect(first?.retrievedMemoryIds).toEqual(["memory-manager"]);
    expect(first?.currentTopic).toBe("manager conversation");
    expect(second?.recentTranscript).toEqual(["What time is dinner?"]);
    expect(second?.retrievedMemoryIds).toEqual(["memory-dinner"]);
    expect(second?.currentTopic).toBe("dinner plan");
  });

  it("persists bounded conversation context across manager instances", async () => {
    const manager = createManager({ contextLimit: 4 });
    await manager.create({ sessionId: SESSION_A, userId: USER_A, initialState: "IDLE" });
    await manager.appendTurn(SESSION_A, {
      transcript: "I argued with my manager today.",
      response: "That sounds stressful."
    }, USER_A);
    await manager.appendTurn(SESSION_A, {
      transcript: "Tomorrow I need to talk again.",
      response: "It sounds like the manager conversation is still on your mind."
    }, USER_A);

    const restartedManager = createManager({ contextLimit: 4 });
    const restored = await restartedManager.lookup(SESSION_A, USER_A);
    expect(restored?.conversationContext).toEqual([
      { role: "user", content: "I argued with my manager today." },
      { role: "assistant", content: "That sounds stressful." },
      { role: "user", content: "Tomorrow I need to talk again." },
      {
        role: "assistant",
        content: "It sounds like the manager conversation is still on your mind."
      }
    ]);
  });

  it("serializes concurrent turns without mixing users or losing context", async () => {
    const manager = createManager({ contextLimit: 20 });
    await manager.create({ sessionId: SESSION_A, userId: USER_A, initialState: "IDLE" });
    await manager.create({ sessionId: SESSION_B, userId: USER_B, initialState: "IDLE" });

    await Promise.all([
      ...Array.from({ length: 5 }, (_, index) => manager.appendTurn(SESSION_A, {
        transcript: `User A turn ${index}`,
        response: `Assistant A turn ${index}`
      }, USER_A)),
      ...Array.from({ length: 5 }, (_, index) => manager.appendTurn(SESSION_B, {
        transcript: `User B turn ${index}`,
        response: `Assistant B turn ${index}`
      }, USER_B))
    ]);

    const first = await manager.lookup(SESSION_A, USER_A);
    const second = await manager.lookup(SESSION_B, USER_B);
    expect(first?.conversationContext).toHaveLength(10);
    expect(second?.conversationContext).toHaveLength(10);
    expect(first?.conversationContext.every((message) => !message.content.includes("User B"))).toBe(true);
    expect(second?.conversationContext.every((message) => !message.content.includes("User A"))).toBe(true);
  });

  it("enforces user ownership on lookup and update", async () => {
    const manager = createManager();
    await manager.create({ sessionId: SESSION_A, userId: USER_A });

    await expect(manager.lookup(SESSION_A, USER_B)).rejects.toBeInstanceOf(VoiceSessionAccessError);
    await expect(manager.lookup(SESSION_A)).rejects.toBeInstanceOf(VoiceSessionAccessError);
    await expect(manager.touch(SESSION_A, USER_B)).rejects.toBeInstanceOf(VoiceSessionAccessError);
  });

  it("expires inactive sessions and removes only expired records during cleanup", async () => {
    const manager = createManager({ ttlMs: 1_000 });
    await manager.create({ sessionId: SESSION_A, userId: USER_A });
    nowMs += 500;
    await manager.create({ sessionId: SESSION_B, userId: USER_B });
    nowMs += 500;

    await expect(manager.lookup(SESSION_A, USER_A)).resolves.toBeNull();
    await expect(manager.lookup(SESSION_B, USER_B)).resolves.not.toBeNull();
    await expect(manager.touch(SESSION_A, USER_A)).rejects.toBeInstanceOf(VoiceSessionExpiredError);

    const cleanup = await manager.cleanupExpired();
    expect(cleanup).toEqual({
      scanned: 2,
      removed: 1,
      invalid: 0,
      removedSessionIds: [SESSION_A]
    });
    await expect(store.read(VOICE_SESSION_COLLECTION, SESSION_A)).resolves.toBeNull();
    await expect(store.read(VOICE_SESSION_COLLECTION, SESSION_B)).resolves.not.toBeNull();
  });
});

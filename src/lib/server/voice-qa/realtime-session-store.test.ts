// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  MemoryRealtimeVoiceSessionStore,
  RealtimeVoiceSessionStoreError,
  type RealtimeVoiceConnectionFence
} from "./realtime-session-store";

async function createClaimedStore(
  options: ConstructorParameters<typeof MemoryRealtimeVoiceSessionStore>[0] = {}
) {
  const store = new MemoryRealtimeVoiceSessionStore({
    idFactory: () => "session-1",
    ...options
  });
  await store.create({ userId: "user-1", scope: "all" });
  const claim = await store.claimConnection({
    sessionId: "session-1",
    userId: "user-1",
    connectionId: "connection-1"
  });
  return { store, fence: claim.fence };
}

describe("MemoryRealtimeVoiceSessionStore", () => {
  it("creates content-free owned sessions and returns defensive clones", async () => {
    const store = new MemoryRealtimeVoiceSessionStore({
      idFactory: () => "session-1",
      maxSessionsPerUser: 1
    });
    const created = await store.create({
      userId: "user-1",
      scope: "week",
      referenceDate: "2026-08-03",
      timestamps: { speechStart: 12 }
    });

    expect(created).toMatchObject({
      sessionId: "session-1",
      userId: "user-1",
      scope: "week",
      transportState: "disconnected",
      connectionEpoch: 0,
      audioEpoch: 1,
      audioAckSequence: 0,
      nextOutboundSequence: 1
    });
    (created.timestamps as Record<string, number>).speechStart = 999;
    expect((await store.get("session-1", "user-1"))?.timestamps).toEqual({
      speechStart: 12
    });
    await expect(store.get("session-1", "other-user")).rejects.toMatchObject({
      code: "owner_mismatch"
    });
    await expect(
      store.create({ userId: "user-1", scope: "all" })
    ).rejects.toMatchObject({ code: "session_limit" });
  });

  it("fences replaced connections and releases only the current owner", async () => {
    const { store, fence: firstFence } = await createClaimedStore();
    const resumed = await store.claimConnection({
      sessionId: "session-1",
      userId: "user-1",
      connectionId: "connection-1"
    });
    expect(resumed.claim).toBe("resumed");
    expect(resumed.fence.connectionEpoch).toBe(1);

    await expect(
      store.claimConnection({
        sessionId: "session-1",
        userId: "user-1",
        connectionId: "connection-2"
      })
    ).rejects.toMatchObject({ code: "connection_conflict" });

    const replaced = await store.claimConnection({
      sessionId: "session-1",
      userId: "user-1",
      connectionId: "connection-2",
      expectedConnectionEpoch: 1
    });
    expect(replaced).toMatchObject({
      claim: "replaced",
      replacedConnectionId: "connection-1",
      fence: { connectionEpoch: 2 }
    });
    await expect(
      store.acknowledgeAudio(firstFence, { audioEpoch: 1, sequence: 1 })
    ).rejects.toMatchObject({ code: "stale_connection" });

    const released = await store.releaseConnection(replaced.fence);
    expect(released).toMatchObject({ transportState: "disconnected" });
    expect(released.connectionId).toBeUndefined();
    await expect(store.releaseConnection(replaced.fence)).rejects.toMatchObject({
      code: "stale_connection"
    });
  });

  it("acknowledges only contiguous audio and treats retries idempotently", async () => {
    const { store, fence } = await createClaimedStore();

    await expect(
      store.acknowledgeAudio(fence, { audioEpoch: 1, sequence: 1 })
    ).resolves.toMatchObject({
      status: "accepted",
      acceptedThrough: 1,
      expectedSequence: 2
    });
    await expect(
      store.acknowledgeAudio(fence, { audioEpoch: 1, sequence: 1 })
    ).resolves.toMatchObject({ status: "duplicate", acceptedThrough: 1 });
    await expect(
      store.acknowledgeAudio(fence, { audioEpoch: 1, sequence: 3 })
    ).resolves.toMatchObject({
      status: "gap",
      acceptedThrough: 1,
      expectedSequence: 2
    });
    await expect(
      store.acknowledgeAudio(fence, { audioEpoch: 1, sequence: 2 })
    ).resolves.toMatchObject({ status: "accepted", acceptedThrough: 2 });
    await expect(
      store.acknowledgeAudio(fence, { audioEpoch: 2, sequence: 1 })
    ).resolves.toMatchObject({
      status: "epoch_mismatch",
      audioEpoch: 1,
      acceptedThrough: 2
    });
  });

  it("replays and cumulatively acknowledges ordered control and audio frames", async () => {
    const { store, fence } = await createClaimedStore();
    const mutableAudio = new Uint8Array([1, 2, 3]);
    await store.appendOutboundFrame(fence, {
      kind: "control",
      data: "ready"
    });
    await store.appendOutboundFrame(fence, {
      kind: "audio",
      data: mutableAudio
    });
    mutableAudio[0] = 9;

    const replay = await store.replayOutbound(fence, 0);
    expect(replay.status).toBe("ok");
    if (replay.status === "ok") {
      expect(replay.frames.map(({ sequence, kind }) => ({ sequence, kind }))).toEqual([
        { sequence: 1, kind: "control" },
        { sequence: 2, kind: "audio" }
      ]);
      expect([...replay.frames[1]!.data as Uint8Array]).toEqual([1, 2, 3]);
      (replay.frames[1]!.data as Uint8Array)[0] = 8;
    }
    const secondReplay = await store.replayOutbound(fence, 1);
    expect(secondReplay.status).toBe("ok");
    if (secondReplay.status === "ok") {
      expect([...secondReplay.frames[0]!.data as Uint8Array]).toEqual([1, 2, 3]);
    }

    await expect(store.acknowledgeOutbound(fence, 1)).resolves.toEqual({
      status: "advanced",
      acknowledgedThrough: 1
    });
    await expect(store.replayOutbound(fence, 0)).resolves.toMatchObject({
      status: "too_old",
      availableAfter: 1
    });
    await expect(store.acknowledgeOutbound(fence, 1)).resolves.toEqual({
      status: "duplicate",
      acknowledgedThrough: 1
    });
    await expect(store.acknowledgeOutbound(fence, 3)).rejects.toMatchObject({
      code: "cursor_ahead"
    });
  });

  it("bounds replay by count and rejects a frame larger than the byte budget", async () => {
    const { store, fence } = await createClaimedStore({
      maxReplayFrames: 2,
      maxReplayBytes: 8
    });
    for (const data of ["a", "b", "c"]) {
      await store.appendOutboundFrame(fence, { kind: "control", data });
    }

    await expect(store.replayOutbound(fence, 0)).resolves.toMatchObject({
      status: "too_old",
      availableAfter: 1
    });
    const replay = await store.replayOutbound(fence, 1);
    expect(replay.status).toBe("ok");
    if (replay.status === "ok") {
      expect(replay.frames.map((frame) => frame.sequence)).toEqual([2, 3]);
    }
    await expect(
      store.appendOutboundFrame(fence, {
        kind: "audio",
        data: new Uint8Array(9)
      })
    ).rejects.toMatchObject({ code: "frame_too_large" });
  });

  it("patches only content-free state and resets ACK on a new audio epoch", async () => {
    const { store, fence } = await createClaimedStore();
    await store.acknowledgeAudio(fence, { audioEpoch: 1, sequence: 1 });
    const patched = await store.patchState(fence, {
      status: "processing",
      providerSessionId: "provider-1",
      activeTurnSequence: 3,
      audioEpoch: 2,
      eventCursor: 10,
      timestamps: { asrFinal: 420 }
    });

    expect(patched).toMatchObject({
      status: "processing",
      providerSessionId: "provider-1",
      activeTurnSequence: 3,
      audioEpoch: 2,
      audioAckSequence: 0,
      eventCursor: 10,
      timestamps: { asrFinal: 420 }
    });
    await expect(
      store.patchState(fence, { audioEpoch: 1 })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("extends expiry on client activity, then expires and deletes sessions", async () => {
    let now = 1_000;
    const store = new MemoryRealtimeVoiceSessionStore({
      clock: () => now,
      idFactory: () => "session-1",
      ttlMs: 100
    });
    await store.create({ userId: "user-1", scope: "all" });
    now = 1_050;
    await store.claimConnection({
      sessionId: "session-1",
      userId: "user-1",
      connectionId: "connection-1"
    });
    now = 1_110;
    await store.keepAlive({
      sessionId: "session-1",
      userId: "user-1",
      connectionId: "connection-1",
      connectionEpoch: 1
    });
    now = 1_120;
    expect(await store.expire()).toEqual([]);
    now = 1_211;
    expect(await store.get("session-1", "user-1")).toBeUndefined();
    // A read observes expiry but does not silently remove the record; expire()
    // returns the ID so the gateway can close its matching runtime.
    expect(await store.expire()).toEqual(["session-1"]);
    expect(await store.get("session-1", "user-1")).toBeUndefined();

    const secondStore = new MemoryRealtimeVoiceSessionStore({
      idFactory: () => "session-2"
    });
    await secondStore.create({ userId: "user-1", scope: "all" });
    expect(await secondStore.delete("session-2", "user-1")).toBe(true);
    expect(await secondStore.delete("session-2", "user-1")).toBe(false);
  });

  it("rejects stale manually forged connection fences", async () => {
    const { store, fence } = await createClaimedStore();
    const forged: RealtimeVoiceConnectionFence = {
      ...fence,
      connectionEpoch: fence.connectionEpoch + 1
    };
    await expect(store.replayOutbound(forged, 0)).rejects.toBeInstanceOf(
      RealtimeVoiceSessionStoreError
    );
  });
});

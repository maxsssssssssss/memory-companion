import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceRefVM } from "@/lib/domain/date-companion";
import type { DateCompanionProactiveValueResponse } from "@/lib/domain/date-companion-proactive-value";

import {
  DATE_COMPANION_PROACTIVE_MAX_POLL_ATTEMPTS,
  DATE_COMPANION_PROACTIVE_POLL_INTERVAL_MS,
  createDateCompanionProactiveValueClient,
  dateCompanionProactiveSourceRevision,
  presentDateCompanionProactiveValue,
  useDateCompanionProactiveValue,
  type DateCompanionProactiveValueClient,
  type DateCompanionProactiveValueTarget
} from "./date-companion-proactive-value";

const DIGEST = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);

afterEach(() => {
  vi.useRealTimers();
});

function response(overrides: Partial<DateCompanionProactiveValueResponse> = {}): DateCompanionProactiveValueResponse {
  return {
    schemaVersion: 2,
    scope: "current_interaction",
    relationshipId: "relationship_1",
    interactionId: "interaction_1",
    mappingVersion: 3,
    status: "ready",
    sourceFingerprint: FINGERPRINT,
    cacheHit: false,
    value: {
      observation: "Ta 在谈到这件事时，更在意你有没有认真听完。",
      suggestedQuestions: ["Ta 之前还在哪些时刻提到过类似感受？"],
      reason: "有一段已确认原话与这个观察直接相关。",
      evidenceIds: ["dc_snapshot:evidence_1"],
      confidence: 0.72,
      caution: "这只是一次相处中的线索，可以继续听 Ta 自己怎么说。"
    },
    evidenceReferences: [{
      evidenceId: "dc_snapshot:evidence_1",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1",
      recordingDate: "2026-08-18",
      startSeconds: 10,
      endSeconds: 15,
      speakerId: "speaker_1",
      quote: "我希望你先听我说完。",
      contentDigest: DIGEST,
      origin: "direct_conversation",
      subject: "companion",
      subjectVersion: 2
    }],
    ...overrides
  };
}

function source(overrides: Partial<SourceRefVM> = {}): SourceRefVM {
  return {
    id: "evidence_1",
    uploadId: "upload_1",
    segmentIds: ["segment_1"],
    recordingDate: "2026-08-18",
    startSeconds: 10,
    endSeconds: 15,
    speakerId: "speaker_1",
    quote: "我希望你先听我说完。",
    contentDigest: DIGEST,
    kind: "transcript",
    presentation: "direct_quote",
    canOpenTranscript: true,
    ...overrides
  };
}

function processingResponse(
  overrides: Partial<DateCompanionProactiveValueResponse> = {}
): DateCompanionProactiveValueResponse {
  return {
    schemaVersion: 2,
    scope: "current_interaction",
    relationshipId: "relationship_1",
    interactionId: "interaction_1",
    mappingVersion: 3,
    status: "processing",
    cacheHit: true,
    evidenceReferences: [],
    failureCode: "generation_in_progress",
    ...overrides
  };
}

describe("Date Companion proactive-value client", () => {
  it("uses strict same-origin GET routes and rejects unexpected response fields", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response()), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...response(), provider: "hidden" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    const client = createDateCompanionProactiveValueClient(fetcher as typeof fetch);

    await expect(client.getCurrentInteraction("interaction_1")).resolves.toMatchObject({
      scope: "current_interaction",
      interactionId: "interaction_1"
    });
    expect(fetcher.mock.calls[0]).toEqual([
      "/api/date-companion/interactions/interaction_1/proactive-value",
      expect.objectContaining({ method: "GET", credentials: "same-origin" })
    ]);
    await expect(client.getCurrentInteraction("interaction_1")).rejects.toMatchObject({
      code: "invalid_response"
    });
  });

  it("calls the relationship scope without sending client-owned context", async () => {
    const relationshipResponse = response({
      scope: "person_relationship",
      interactionId: undefined,
      personId: "person_ta"
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(relationshipResponse), { status: 200 })
    );
    const client = createDateCompanionProactiveValueClient(fetcher as typeof fetch);

    await client.getPersonRelationship("relationship_1");

    expect(fetcher).toHaveBeenCalledWith(
      "/api/date-companion/relationships/relationship_1/proactive-value",
      expect.objectContaining({ method: "GET", credentials: "same-origin" })
    );
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty("body");
  });
});

describe("useDateCompanionProactiveValue", () => {
  it("aborts an old interaction request and never exposes its late result", async () => {
    const requests: Array<{
      interactionId: string;
      signal?: AbortSignal;
      resolve: (value: DateCompanionProactiveValueResponse) => void;
    }> = [];
    const client: DateCompanionProactiveValueClient = {
      getCurrentInteraction: (interactionId, signal) => new Promise((resolve) => {
        requests.push({ interactionId, signal, resolve });
      }),
      getPersonRelationship: vi.fn()
    };
    const first: DateCompanionProactiveValueTarget = {
      scope: "current_interaction",
      accountId: "account_1",
      relationshipId: "relationship_1",
      interactionId: "interaction_1",
      mappingVersion: 3,
      sourceRevision: "revision_1"
    };
    const { result, rerender } = renderHook(
      ({ target }) => useDateCompanionProactiveValue(target, client),
      { initialProps: { target: first } }
    );
    await waitFor(() => expect(requests).toHaveLength(1));

    const second = { ...first, interactionId: "interaction_2" };
    rerender({ target: second });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0].signal?.aborted).toBe(true);
    expect(result.current.status).toBe("loading");

    requests[0].resolve(response());
    requests[1].resolve(response({ interactionId: "interaction_2" }));
    await waitFor(() => expect(result.current).toMatchObject({
      status: "ready",
      response: { interactionId: "interaction_2" }
    }));
  });

  it("fails closed when person, mapping version, scope, or canonical references do not match", async () => {
    const target: DateCompanionProactiveValueTarget = {
      scope: "person_relationship",
      accountId: "account_1",
      relationshipId: "relationship_1",
      personId: "person_ta",
      mappingVersion: 4,
      sourceRevision: "revision_1"
    };
    const client: DateCompanionProactiveValueClient = {
      getCurrentInteraction: vi.fn(),
      getPersonRelationship: vi.fn(async () => response({
        scope: "person_relationship",
        interactionId: undefined,
        personId: "person_old",
        mappingVersion: 3
      }))
    };
    const { result } = renderHook(() => useDateCompanionProactiveValue(target, client));

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("aborts and refetches when canonical Evidence changes under the same target", async () => {
    const requests: Array<{
      signal?: AbortSignal;
      resolve: (value: DateCompanionProactiveValueResponse) => void;
    }> = [];
    const client: DateCompanionProactiveValueClient = {
      getCurrentInteraction: (_interactionId, signal) => new Promise((resolve) => {
        requests.push({ signal, resolve });
      }),
      getPersonRelationship: vi.fn()
    };
    const first: DateCompanionProactiveValueTarget = {
      scope: "current_interaction",
      accountId: "account_1",
      relationshipId: "relationship_1",
      interactionId: "interaction_1",
      mappingVersion: 3,
      sourceRevision: "revision_1"
    };
    const { result, rerender } = renderHook(
      ({ target }) => useDateCompanionProactiveValue(target, client),
      { initialProps: { target: first } }
    );
    await waitFor(() => expect(requests).toHaveLength(1));

    rerender({ target: { ...first, sourceRevision: "revision_2" } });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0].signal?.aborted).toBe(true);
    expect(result.current.status).toBe("loading");

    requests[0].resolve(response());
    requests[1].resolve(response({ sourceFingerprint: "c".repeat(64) }));
    await waitFor(() => expect(result.current).toMatchObject({
      status: "ready",
      response: { sourceFingerprint: "c".repeat(64) }
    }));
  });

  it("polls a processing cache with GET until the generated value is ready", async () => {
    vi.useFakeTimers();
    const getCurrentInteraction = vi
      .fn()
      .mockResolvedValueOnce(processingResponse())
      .mockResolvedValueOnce(response());
    const client: DateCompanionProactiveValueClient = {
      getCurrentInteraction,
      getPersonRelationship: vi.fn()
    };
    const target: DateCompanionProactiveValueTarget = {
      scope: "current_interaction",
      accountId: "account_1",
      relationshipId: "relationship_1",
      interactionId: "interaction_1",
      mappingVersion: 3,
      sourceRevision: "revision_1"
    };
    const { result } = renderHook(() => useDateCompanionProactiveValue(target, client));

    await act(async () => Promise.resolve());
    expect(getCurrentInteraction).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("loading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DATE_COMPANION_PROACTIVE_POLL_INTERVAL_MS);
    });
    expect(getCurrentInteraction).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ status: "ready" });
  });

  it("cancels a pending poll on unmount and stops after the bounded attempt budget", async () => {
    vi.useFakeTimers();
    const getCurrentInteraction = vi.fn(async () => processingResponse());
    const client: DateCompanionProactiveValueClient = {
      getCurrentInteraction,
      getPersonRelationship: vi.fn()
    };
    const target: DateCompanionProactiveValueTarget = {
      scope: "current_interaction",
      accountId: "account_1",
      relationshipId: "relationship_1",
      interactionId: "interaction_1",
      mappingVersion: 3,
      sourceRevision: "revision_1"
    };
    const cancelled = renderHook(() => useDateCompanionProactiveValue(target, client));
    await act(async () => Promise.resolve());
    cancelled.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DATE_COMPANION_PROACTIVE_POLL_INTERVAL_MS * 2);
    });
    expect(getCurrentInteraction).toHaveBeenCalledTimes(1);

    getCurrentInteraction.mockClear();
    const bounded = renderHook(() => useDateCompanionProactiveValue(target, client));
    await act(async () => Promise.resolve());
    for (let attempt = 0; attempt < DATE_COMPANION_PROACTIVE_MAX_POLL_ATTEMPTS; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DATE_COMPANION_PROACTIVE_POLL_INTERVAL_MS);
      });
    }
    expect(getCurrentInteraction).toHaveBeenCalledTimes(
      DATE_COMPANION_PROACTIVE_MAX_POLL_ATTEMPTS + 1
    );
    expect(bounded.result.current.status).toBe("unavailable");
    bounded.unmount();
  });
});

describe("dateCompanionProactiveSourceRevision", () => {
  it("is order-stable and changes with canonical Evidence or its subject", () => {
    const first = source();
    const second = source({
      id: "evidence_2",
      uploadId: "upload_2",
      segmentIds: ["segment_2"],
      quote: "我们下次一起去看展。",
      memorySubject: "both"
    });
    expect(dateCompanionProactiveSourceRevision([first, second], 3)).toBe(
      dateCompanionProactiveSourceRevision([second, first], 3)
    );
    expect(dateCompanionProactiveSourceRevision([first], 3)).not.toBe(
      dateCompanionProactiveSourceRevision([source({ quote: "原话已经更新。" })], 3)
    );
    expect(dateCompanionProactiveSourceRevision([second], 3)).not.toBe(
      dateCompanionProactiveSourceRevision([source({ ...second, memorySubject: "companion" })], 3)
    );
  });
});

describe("presentDateCompanionProactiveValue", () => {
  it("builds display data only from canonical references and omits internal fields", () => {
    const unrelated = source({ id: "other", uploadId: "upload_2", segmentIds: ["segment_2"], quote: "不应出现" });
    const presentation = presentDateCompanionProactiveValue(response(), [unrelated, source()]);

    expect(presentation).toMatchObject({
      observation: "Ta 在谈到这件事时，更在意你有没有认真听完。",
      caution: "这只是一次相处中的线索，可以继续听 Ta 自己怎么说。",
      suggestedQuestions: ["Ta 之前还在哪些时刻提到过类似感受？"],
      sources: [expect.objectContaining({ quote: "我希望你先听我说完。" })]
    });
    expect(presentation).not.toHaveProperty("reason");
    expect(presentation).not.toHaveProperty("confidence");
    expect(JSON.stringify(presentation)).not.toContain("不应出现");
  });

  it("hides the whole derived card when its canonical source cannot be resolved exactly", () => {
    expect(presentDateCompanionProactiveValue(response(), [source({ recordingDate: "2026-08-17" })])).toBeNull();
    expect(presentDateCompanionProactiveValue(response(), [source({ quote: "同一定位但原话已经变化。" })])).toBeNull();
    expect(presentDateCompanionProactiveValue(response(), [source({ contentDigest: "f".repeat(64) })])).toBeNull();
    expect(presentDateCompanionProactiveValue(response(), [
      source(),
      source({ id: "digest-conflict", contentDigest: "f".repeat(64) })
    ])).toBeNull();
    expect(presentDateCompanionProactiveValue(response(), [
      source(),
      source({ id: "conflict", quote: "同一片段出现了冲突原话。" })
    ])).toBeNull();
  });
});

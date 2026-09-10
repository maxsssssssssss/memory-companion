import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceRefVM } from "@/lib/domain/date-companion";
import type { DateCompanionProactiveValueResponse } from "@/lib/domain/date-companion-proactive-value";

import {
  DATE_COMPANION_PROACTIVE_MAX_POLL_ATTEMPTS,
  DATE_COMPANION_PROACTIVE_POLL_INTERVAL_MS,
  createDateCompanionProactiveValueClient,
  dateCompanionProactiveSourceRevision,
  homeAboutSuggestedQuestions,
  presentDateCompanionHomeContent,
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

function homeResponse(): DateCompanionProactiveValueResponse {
  const base = response();
  return {
    ...base,
    scope: "person_relationship",
    interactionId: undefined,
    personId: "person_ta",
    value: {
      home: {
        about: [{ kind: "preference", text: "Ta 希望交流时能先把话说完。", evidenceIds: ["dc_snapshot:evidence_1"] }],
        beforeMeeting: [{ kind: "follow_up", text: "可以问问考试准备得怎么样。", reason: "Ta 上次提到正在备考。", evidenceIds: ["dc_snapshot:evidence_2"] }]
      },
      evidenceIds: ["dc_snapshot:evidence_1", "dc_snapshot:evidence_2"]
    },
    evidenceReferences: [base.evidenceReferences[0], {
      ...base.evidenceReferences[0],
      evidenceId: "dc_snapshot:evidence_2",
      sourceSegmentId: "segment_2",
      quote: "最近都在准备考试。"
    }]
  };
}

function homeSources() {
  return [source({ memorySubject: "companion" }), source({
    id: "evidence_2", segmentIds: ["segment_2"], quote: "最近都在准备考试。", memorySubject: "companion"
  })];
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

  it("withdraws relationship content and rejects a late response after account or promise revision changes", async () => {
    const requests: Array<{ signal?: AbortSignal; resolve: (value: DateCompanionProactiveValueResponse) => void }> = [];
    const client: DateCompanionProactiveValueClient = {
      getCurrentInteraction: vi.fn(),
      getPersonRelationship: (_relationshipId, signal) => new Promise((resolve) => requests.push({ signal, resolve }))
    };
    const first: DateCompanionProactiveValueTarget = {
      scope: "person_relationship", accountId: "account_1", relationshipId: "relationship_1",
      personId: "person_ta", mappingVersion: 3, sourceRevision: "promise_1:open:1"
    };
    const { result, rerender } = renderHook(({ target }) => useDateCompanionProactiveValue(target, client), {
      initialProps: { target: first }
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0].resolve(homeResponse()));
    expect(result.current.status).toBe("ready");

    rerender({ target: { ...first, sourceRevision: "promise_1:done:2" } });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(result.current.status).toBe("loading");
    expect(requests[0].signal?.aborted).toBe(true);
    rerender({ target: { ...first, accountId: "account_2", sourceRevision: "promise_1:done:2" } });
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[1].signal?.aborted).toBe(true);
    await act(async () => requests[1].resolve(homeResponse()));
    expect(result.current.status).toBe("loading");
    await act(async () => requests[2].resolve(response({
      scope: "person_relationship", interactionId: undefined, personId: "person_ta", status: "unavailable",
      value: undefined, sourceFingerprint: undefined, evidenceReferences: []
    })));
    expect(result.current.status).toBe("unavailable");
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

describe("presentDateCompanionHomeContent", () => {
  it("resolves each generated item from its own canonical Evidence without replacing Evidence with generated text", () => {
    const presentation = presentDateCompanionHomeContent(homeResponse(), homeSources());
    expect(presentation?.about[0]).toMatchObject({
      text: "Ta 希望交流时能先把话说完。", sources: [{ quote: "我希望你先听我说完。", segmentIds: ["segment_1"] }]
    });
    expect(presentation?.beforeMeeting[0]).toMatchObject({
      text: "可以问问考试准备得怎么样。", sources: [{ quote: "最近都在准备考试。", segmentIds: ["segment_2"] }]
    });
    expect(presentDateCompanionProactiveValue(homeResponse(), homeSources())).toBeNull();
  });

  it("withdraws yesterday's relationship content at Shanghai midnight and refreshes once on a later focus", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T15:59:59.000Z"));
    const requests: Array<{ signal?: AbortSignal; resolve: (value: DateCompanionProactiveValueResponse) => void }> = [];
    const client: DateCompanionProactiveValueClient = {
      getCurrentInteraction: vi.fn(),
      getPersonRelationship: (_relationshipId, signal) => new Promise((resolve) => requests.push({ signal, resolve }))
    };
    const target: DateCompanionProactiveValueTarget = {
      scope: "person_relationship", accountId: "account_1", relationshipId: "relationship_1",
      personId: "person_ta", mappingVersion: 3, sourceRevision: "revision_1"
    };
    const { result, unmount } = renderHook(() => useDateCompanionProactiveValue(target, client));
    await act(async () => requests[0].resolve(homeResponse()));
    expect(result.current.status).toBe("ready");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
    expect(requests).toHaveLength(2);
    expect(requests[0].signal?.aborted).toBe(true);
    expect(result.current.status).toBe("loading");
    await act(async () => requests[1].resolve(homeResponse()));
    expect(result.current.status).toBe("ready");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(requests).toHaveLength(2);
    vi.setSystemTime(new Date("2026-09-09T16:05:00.000Z"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(requests).toHaveLength(3);
    expect(result.current.status).toBe("loading");
    unmount();
    expect(requests[2].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows an explicitly empty result and never promotes old observations or fallback output to home content", () => {
    expect(presentDateCompanionHomeContent({
      ...homeResponse(), value: { home: { about: [], beforeMeeting: [] }, evidenceIds: [] }, evidenceReferences: []
    }, [])).toMatchObject({ about: [], beforeMeeting: [] });
    expect(presentDateCompanionHomeContent(response(), homeSources())).toBeNull();
    expect(presentDateCompanionHomeContent({ ...homeResponse(), status: "fallback" }, homeSources())).toBeNull();
  });

  it.each([
    { quote: "原话已修改。" }, { recordingDate: "2026-08-17" }, { contentDigest: "f".repeat(64) },
    { memorySubject: "self" as const }, { memorySubject: undefined }, { speakerId: "speaker_other" }, { uploadId: "other_account_upload" }
  ])("hides home content on canonical source drift: %j", (changes) => {
    const sources = homeSources();
    sources[1] = { ...sources[1], ...changes };
    expect(presentDateCompanionHomeContent(homeResponse(), sources)).toBeNull();
  });

  it("rejects subject conflicts and malformed per-item references even when top-level Evidence exists", () => {
    expect(presentDateCompanionHomeContent(homeResponse(), [
      ...homeSources(), source({ id: "conflicting", memorySubject: "self" })
    ])).toBeNull();
    const invalid = homeResponse();
    if (invalid.value && "home" in invalid.value) invalid.value.home.beforeMeeting[0].evidenceIds = ["invented"];
    expect(presentDateCompanionHomeContent(invalid, homeSources())).toBeNull();
  });

  it("links only the referenced segment when a canonical source spans several segments", () => {
    const sources = homeSources();
    sources[1] = { ...sources[1], segmentIds: ["preceding_segment", "segment_2"] };
    const presentation = presentDateCompanionHomeContent(homeResponse(), sources);
    expect(presentation?.beforeMeeting[0].sources[0].segmentIds).toEqual(["segment_2"]);
  });

  it("allows a shared moment supported by both-subject and companion-subject Evidence together", () => {
    const current = homeResponse();
    if (current.value && "home" in current.value) {
      current.value.home.about = [{ kind: "shared_moment", text: "你们一起聊起了沟通和考试。", evidenceIds: current.value.evidenceIds }];
      current.value.home.beforeMeeting = [];
    }
    current.evidenceReferences[0].subject = "both";
    const sources = homeSources();
    sources[0].memorySubject = "both";
    expect(presentDateCompanionHomeContent(current, sources)?.about).toHaveLength(1);
  });

  it("derives record-checking questions from about items using only the Person QA allowlist", () => {
    const current = homeResponse();
    if (current.value && "home" in current.value) {
      current.value.home.beforeMeeting = [{
        kind: "open_promise", text: "查一下展览的开放时间。", reason: "你上次答应查好时间。",
        promiseId: "promise_1", evidenceIds: ["dc_snapshot:evidence_2"]
      }];
    }
    current.evidenceReferences[1].subject = "self";
    const personQaSources = [homeSources()[0]];
    expect(homeAboutSuggestedQuestions(current, personQaSources)).toEqual([
      "关于「Ta 希望交流时能先把话说完。」，当时具体说了什么？"
    ]);
    expect(homeAboutSuggestedQuestions(current, [])).toEqual([]);
    expect(homeAboutSuggestedQuestions(current, [source({ memorySubject: "companion", contentDigest: "f".repeat(64) })])).toEqual([]);
    expect(homeAboutSuggestedQuestions({ ...current, status: "fallback" }, personQaSources)).toEqual([]);
    expect(presentDateCompanionProactiveValue(current, personQaSources)).toBeNull();
  });
});

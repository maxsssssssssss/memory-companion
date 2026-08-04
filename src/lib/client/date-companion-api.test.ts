import { describe, expect, it, vi } from "vitest";

import {
  DateCompanionApiError,
  createDateCompanionApi,
  isRealDateCompanionUploadId
} from "./date-companion-api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function dayPayload(status: "processing" | "ready" = "ready") {
  return {
    upload: {
      id: "upload_1",
      originalName: "date.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 2048,
      recordingDate: "2026-08-04",
      createdAt: "2026-08-04T10:00:00.000Z",
      durationSeconds: 10,
      status
    },
    job: {
      id: "job_1",
      uploadId: "upload_1",
      status,
      progress: status === "ready" ? 100 : 35
    },
    segments: [],
    audioInsights: [],
    semanticSegments: [],
    semanticSegmentsAvailable: status === "ready",
    briefItems: [],
    relationshipSignals: [],
    relationshipSignalsAvailable: status === "ready",
    proactiveInsights: [],
    proactiveInsightsAvailable: status === "ready",
    speakerAliases: {},
    speakerAliasesByUploadId: { upload_1: {} }
  };
}

function relationshipView() {
  const evidence = {
    id: "evidence_1",
    recapItemId: "recap_1",
    uploadId: "upload_1",
    sourceSegmentId: "segment_1",
    startSeconds: 0,
    endSeconds: 3,
    speakerId: "speaker_1",
    quote: "下次可以去看展",
    createdAt: "2026-08-04T10:00:00.000Z"
  };
  return {
    relationship: {
      id: "relationship_1",
      displayName: "Ta",
      status: "active",
      version: 0,
      createdAt: "2026-08-04T10:00:00.000Z",
      updatedAt: "2026-08-04T10:00:00.000Z"
    },
    interactions: [
      {
        id: "interaction_1",
        relationshipId: "relationship_1",
        sourceUploadId: "upload_1",
        recordingDate: "2026-08-04",
        originalName: "date.m4a",
        durationSeconds: 10,
        status: "draft",
        sourceState: "available",
        version: 0,
        createdAt: "2026-08-04T10:00:00.000Z",
        updatedAt: "2026-08-04T10:00:00.000Z",
        participants: [{ speakerId: "speaker_1", role: "unresolved" }],
        recapItems: [
          {
            id: "recap_1",
            interactionId: "interaction_1",
            kind: "moment",
            proposedText: "下次可以去看展",
            displayedText: "下次可以去看展",
            disposition: "pending",
            version: 0,
            sortOrder: 0,
            evidence: [evidence]
          }
        ]
      }
    ],
    promises: []
  };
}

describe("date-companion API", () => {
  it("uses the real cookie session and treats auth 401 as anonymous", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "unauthenticated" }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ user: { id: "user_1", email: "user@example.com", name: "User" } })
      );
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(api.getCurrentUser()).resolves.toBeNull();
    await expect(api.login({ email: "user@example.com", password: "secret" })).resolves.toEqual({
      id: "user_1",
      email: "user@example.com",
      name: "User"
    });

    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin" });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "same-origin" });
  });

  it("uploads with browser-owned multipart headers and preserves the full queue receipt", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          uploadId: "upload_1",
          jobId: "job_1",
          status: "waiting",
          executionMode: "queue",
          queueJobId: "pipeline_upload_1",
          evaluationRetention: true
        },
        201
      )
    );
    const api = createDateCompanionApi(fetcher as typeof fetch);
    const file = new File(["audio"], "date.m4a", { type: "audio/mp4" });

    await expect(api.upload(file, "2026-08-04")).resolves.toEqual({
      uploadId: "upload_1",
      jobId: "job_1",
      status: "waiting",
      executionMode: "queue",
      queueJobId: "pipeline_upload_1",
      evaluationRetention: true
    });

    const request = fetcher.mock.calls[0][1] as RequestInit;
    expect(request.body).toBeInstanceOf(FormData);
    expect(new Headers(request.headers).has("Content-Type")).toBe(false);
    expect((request.body as FormData).get("recordingDate")).toBe("2026-08-04");
  });

  it("retains the failed queue upload identifiers on a 503 response", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: "pipeline_queue_unavailable",
          uploadId: "upload_1",
          jobId: "job_1",
          status: "failed"
        },
        503
      )
    );
    const api = createDateCompanionApi(fetcher as typeof fetch);

    const error = await api
      .upload(new File(["audio"], "date.m4a", { type: "audio/mp4" }), "2026-08-04")
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(DateCompanionApiError);
    expect((error as DateCompanionApiError).details).toMatchObject({
      uploadId: "upload_1",
      jobId: "job_1",
      status: "failed"
    });
  });

  it("polls the parsed Day payload until a real terminal status", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(dayPayload("processing")))
      .mockResolvedValueOnce(jsonResponse(dayPayload("ready")));
    const api = createDateCompanionApi(fetcher as typeof fetch);
    const updates: string[] = [];

    const result = await api.pollDay("upload_1", {
      intervalMs: 0,
      onPayload: (payload) => updates.push(payload.job?.status ?? payload.upload.status)
    });

    expect(result.job?.status).toBe("ready");
    expect(updates).toEqual(["processing", "ready"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never sends a virtual same-day aggregate ID to a single-recording endpoint", async () => {
    const fetcher = vi.fn();
    const api = createDateCompanionApi(fetcher as typeof fetch);

    expect(isRealDateCompanionUploadId("day_2026-08-04")).toBe(false);
    await expect(api.getDay("day_2026-08-04")).rejects.toMatchObject({ code: "invalid_upload_id" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("streams current-only QA with the fixed date preset and canonical context", async () => {
    const finalAnswer = {
      id: "answer_1",
      uploadId: "upload_1",
      question: "她提到了什么？",
      answer: "她提到了看展。",
      citedSegmentIds: ["segment_1"],
      citations: [
        {
          id: "E1",
          title: "看展",
          startSeconds: 0,
          endSeconds: 3,
          excerpt: "下次可以去看展",
          sourceSegmentIds: ["segment_1"]
        }
      ],
      createdAt: "2026-08-04T11:00:00.000Z"
    };
    const frames = [
      { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" },
      {
        type: "sentence",
        sequence: 1,
        text: "她提到了看展。",
        supportIds: ["segment_1"],
        citedSegmentIds: ["segment_1"],
        groundingValidated: true
      },
      { type: "final", answer: finalAnswer, source: "provider_stream" },
      { type: "complete", status: "completed" }
    ];
    const fetcher = vi.fn().mockResolvedValue(
      new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" }
      })
    );
    const api = createDateCompanionApi(fetcher as typeof fetch);
    const events = [];

    for await (const event of api.streamCurrentInteractionQa({
      uploadId: "upload_1",
      question: "她提到了什么？",
      segments: [
        {
          id: "segment_1",
          uploadId: "upload_1",
          startSeconds: 0,
          endSeconds: 3,
          text: "下次可以去看展",
          confidence: 0.9,
          sceneLabels: ["unknown"],
          valueLabels: []
        }
      ],
      audioInsights: [],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: []
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["meta", "sentence", "final", "complete"]);
    const request = fetcher.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(new Headers(request.headers).get("Accept")).toBe("application/x-ndjson");
    expect(body).toMatchObject({ uploadId: "upload_1", scope: "current", promptPresetId: "date" });
    expect(body).not.toHaveProperty("model");
  });

  it("reports a cleanup 409 without claiming the server copy was removed", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: "evaluation_retention_required" }, 409));
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(api.cleanupUpload("upload_1")).rejects.toMatchObject({
      status: 409,
      code: "evaluation_retention_required"
    });
    const request = fetcher.mock.calls[0][1] as RequestInit;
    expect(new Headers(request.headers).get("x-daily-brief-cleanup-mode")).toBe("browser-cache");
  });

  it("uses the explicit upload-delete contract after the user's second confirmation", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ deleted: true }));
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(api.deleteSourceUpload("upload_1", {
      interactionId: "interaction_1",
      expectedVersion: 3
    })).resolves.toBeUndefined();

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/uploads/upload_1");
    expect(init).toMatchObject({ method: "DELETE", credentials: "same-origin" });
    const headers = new Headers(init.headers);
    expect(headers.get("x-evaluation-delete-confirmed")).toBe("true");
    expect(headers.get("x-date-companion-interaction-id")).toBe("interaction_1");
    expect(headers.get("if-match")).toBe('"3"');
    expect(headers.has("x-daily-brief-cleanup-mode")).toBe(false);
  });

  it("uses the Stage 2 relationship contracts without sending user or provider fields", async () => {
    const view = relationshipView();
    const searchResult = {
      recapItemId: "recap_1",
      interactionId: "interaction_1",
      kind: "moment",
      text: "下次可以去看展",
      recordingDate: "2026-08-04",
      evidence: view.interactions[0].recapItems[0].evidence
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ relationships: [view.relationship] }))
      .mockResolvedValueOnce(jsonResponse({ relationship: view.relationship, reused: false }, 201))
      .mockResolvedValueOnce(jsonResponse({ view }))
      .mockResolvedValueOnce(jsonResponse({ interactionId: "interaction_1", reused: false, view }, 201))
      .mockResolvedValueOnce(jsonResponse({ view }))
      .mockResolvedValueOnce(jsonResponse({ view }))
      .mockResolvedValueOnce(jsonResponse({ view }))
      .mockResolvedValueOnce(jsonResponse({ results: [searchResult] }))
      .mockResolvedValueOnce(jsonResponse({ deleted: true }));
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(api.listRelationships()).resolves.toEqual([view.relationship]);
    await expect(api.createRelationship({ displayName: "Ta" })).resolves.toMatchObject({ reused: false });
    await expect(api.getRelationshipView("relationship_1")).resolves.toEqual(view);
    await expect(api.importInteraction("relationship_1", { uploadId: "upload_1" })).resolves.toMatchObject({
      interactionId: "interaction_1",
      reused: false
    });
    await api.updateParticipants("interaction_1", {
      version: 0,
      assignments: [{ speakerId: "speaker_1", role: "self" }]
    });
    await api.updateRecap("interaction_1", {
      version: 0,
      items: [{ id: "recap_1", version: 0, userText: "一起去看展", disposition: "kept" }],
      finalize: false
    });
    await api.patchPromise("promise_1", { version: 0, status: "done" });
    await expect(api.searchRelationship("relationship_1", " 看展 ")).resolves.toEqual([searchResult]);
    await expect(api.deleteInteraction("interaction_1", 3)).resolves.toBeUndefined();

    const calls = fetcher.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["GET", "/api/date-companion/relationships"],
      ["POST", "/api/date-companion/relationships"],
      ["GET", "/api/date-companion/relationships/relationship_1/view"],
      ["POST", "/api/date-companion/relationships/relationship_1/interactions/import"],
      ["PUT", "/api/date-companion/interactions/interaction_1/participants"],
      ["PUT", "/api/date-companion/interactions/interaction_1/recap"],
      ["PATCH", "/api/date-companion/promises/promise_1"],
      ["GET", "/api/date-companion/relationships/relationship_1/search?q=%E7%9C%8B%E5%B1%95"],
      ["DELETE", "/api/date-companion/interactions/interaction_1"]
    ]);
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ uploadId: "upload_1" });
    expect(JSON.parse(String(calls[4].init.body))).not.toHaveProperty("userId");
    expect(JSON.parse(String(calls[5].init.body))).not.toHaveProperty("provider");
    expect(new Headers(calls[8].init.headers).get("if-match")).toBe('"3"');
  });
});

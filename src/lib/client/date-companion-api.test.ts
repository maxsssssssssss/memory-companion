import { describe, expect, it, vi } from "vitest";

import {
  DateCompanionApiError,
  UploadReceiptSchema,
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

  it("registers through the real auth route with the strict current contract", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ user: { id: "user_new", email: "new@example.com", name: "小林" } }, 201)
    );
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(api.register({
      email: "new@example.com",
      password: "password-123",
      name: "小林",
      inviteCode: "invitation"
    })).resolves.toEqual({ id: "user_new", email: "new@example.com", name: "小林" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/auth/register");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({
        email: "new@example.com",
        password: "password-123",
        name: "小林",
        inviteCode: "invitation"
      })
    });
  });

  it("rejects invalid registration input before making a request", async () => {
    const fetcher = vi.fn();
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(api.register({
      email: "new@example.com",
      password: "short",
      inviteCode: "invitation"
    })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
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
    expect((request.body as FormData).get("uploadContext")).toBe("date-companion");
    expect((request.body as FormData).has("toyOperationKey")).toBe(false);
    expect((request.body as FormData).has("toyDestination")).toBe(false);
    expect((request.body as FormData).has("toyRelationshipId")).toBe(false);
    expect((request.body as FormData).has("toyGeneration")).toBe(false);
  });

  it("adds the complete Toy operation scope only for an explicit Toy upload", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ uploadId: "upload_1", jobId: "job_1", status: "uploaded" }, 201)
    );
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await api.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04",
      undefined,
      {
        operationKey: `toyop_v1_${"a".repeat(64)}`,
        destination: "date_companion",
        relationshipId: "relationship_1"
      }
    );

    const request = fetcher.mock.calls[0][1] as RequestInit;
    const body = request.body as FormData;
    expect(body.get("uploadContext")).toBe("date-companion");
    expect(body.get("toyOperationKey")).toBe(`toyop_v1_${"a".repeat(64)}`);
    expect(body.get("toyDestination")).toBe("date_companion");
    expect(body.get("toyRelationshipId")).toBe("relationship_1");
    expect(body.has("toyGeneration")).toBe(false);
  });

  it("parses an enforce ingestion receipt and looks it up by operation scope", async () => {
    const ingestionReceipt = {
      receiptId: "receipt_1",
      operationKey: `toyop_v1_${"a".repeat(64)}`,
      destination: "date_companion",
      relationshipId: "relationship_1",
      uploadId: "upload_1",
      jobId: "job_1",
      state: "accepted",
      decision: "accepted",
      recordingDate: "2026-08-04",
      serverAcceptedAt: "2026-08-04T10:00:00.000Z"
    } as const;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        uploadId: "upload_1",
        jobId: "job_1",
        status: "uploaded",
        ingestionReceipt
      }, 201))
      .mockResolvedValueOnce(jsonResponse({ ingestionReceipt }));
    const api = createDateCompanionApi(fetcher as typeof fetch);
    const request = {
      operationKey: ingestionReceipt.operationKey,
      destination: "date_companion" as const,
      relationshipId: "relationship_1"
    };

    await expect(api.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04",
      undefined,
      request
    )).resolves.toMatchObject({ ingestionReceipt });
    await expect(api.getToyIngestionReceipt(request)).resolves.toEqual(ingestionReceipt);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/api/uploads/toy-receipts?operationKey=${ingestionReceipt.operationKey}&destination=date_companion&relationshipId=relationship_1`
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
  });

  it("treats only an authenticated receipt 404 as not found", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      error: "toy_ingestion_receipt_not_found"
    }, 404));
    const api = createDateCompanionApi(fetcher as typeof fetch);
    await expect(api.getToyIngestionReceipt({
      operationKey: `toyop_v1_${"b".repeat(64)}`,
      destination: "date_companion",
      relationshipId: "relationship_1"
    })).resolves.toBeNull();
  });

  it("accepts an inline waiting envelope only for a pre-accept Toy receipt", async () => {
    const ingestionReceipt = {
      receiptId: "receipt_reserving",
      operationKey: `toyop_v1_${"c".repeat(64)}`,
      destination: "date_companion",
      relationshipId: "relationship_1",
      uploadId: "upload_reserving",
      jobId: "job_reserving",
      state: "reserving",
      decision: "accepted",
      recordingDate: "2026-08-04"
    } as const;
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      uploadId: ingestionReceipt.uploadId,
      jobId: ingestionReceipt.jobId,
      status: "waiting",
      executionMode: "inline",
      ingestionReceipt
    }, 202));
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(api.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04",
      undefined,
      {
        operationKey: ingestionReceipt.operationKey,
        destination: "date_companion",
        relationshipId: "relationship_1"
      }
    )).resolves.toMatchObject({
      status: "waiting",
      executionMode: "inline",
      ingestionReceipt
    });

    expect(UploadReceiptSchema.safeParse({
      uploadId: ingestionReceipt.uploadId,
      jobId: ingestionReceipt.jobId,
      status: "waiting",
      executionMode: "inline",
      ingestionReceipt: { ...ingestionReceipt, state: "failed", failedAt: "2026-08-04T10:01:00.000Z" }
    }).success).toBe(false);
    expect(UploadReceiptSchema.safeParse({
      uploadId: "upload_manual",
      jobId: "job_manual",
      status: "waiting",
      executionMode: "inline"
    }).success).toBe(false);
  });

  it("accepts a deferred queue receipt so the client can keep polling", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          uploadId: "upload_1",
          jobId: "job_1",
          status: "waiting",
          executionMode: "queue",
          queueJobId: "pipeline_upload_1",
          enqueueDeferred: true,
          warning: "pipeline_queue_unavailable"
        },
        202
      )
    );
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(
      api.upload(new File(["audio"], "date.m4a", { type: "audio/mp4" }), "2026-08-04")
    ).resolves.toEqual({
      uploadId: "upload_1",
      jobId: "job_1",
      status: "waiting",
      executionMode: "queue",
      queueJobId: "pipeline_upload_1",
      enqueueDeferred: true,
      warning: "pipeline_queue_unavailable"
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
    const [url, request] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/days/context/qa");
    const body = JSON.parse(String(request.body));
    expect(new Headers(request.headers).get("Accept")).toBe("application/x-ndjson");
    expect(body).toMatchObject({ uploadId: "upload_1", scope: "current", promptPresetId: "date" });
    for (const forbidden of ["personId", "mappingVersion", "model", "provider"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("streams relationship QA without sending browser Evidence", async () => {
    const finalAnswer = {
      id: "answer_relationship",
      uploadId: "relationship_1",
      question: "Ta 以前提过什么？",
      answer: "Ta 以前提过想去海边。",
      citedSegmentIds: ["segment_old"],
      citations: [{
        id: "E1",
        title: "2026-07-10 · Ta 提到的内容",
        startSeconds: 1,
        endSeconds: 3,
        excerpt: "想去海边",
        sourceSegmentIds: ["segment_old"]
      }],
      createdAt: "2026-08-07T10:00:00.000Z"
    };
    const frames = [
      { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" },
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

    for await (const event of api.streamRelationshipQa({
      relationshipId: "relationship_1",
      question: "Ta 以前提过什么？",
      conversation: [{ role: "user", content: "关于以前的相处" }]
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["meta", "final", "complete"]);
    const [url, request] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/date-companion/relationships/relationship_1/qa");
    expect(new Headers(request.headers).get("Accept")).toBe("application/x-ndjson");
    expect(JSON.parse(String(request.body))).toEqual({
      question: "Ta 以前提过什么？",
      conversation: [{ role: "user", content: "关于以前的相处" }]
    });
  });

  it("streams formal companion QA through the confirmed Person route with a minimal body", async () => {
    const frames = [
      { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" },
      {
        type: "final",
        answer: {
          id: "answer_person",
          uploadId: "person_ta",
          question: "Ta 以前提过什么？",
          answer: "没有找到足够证据确认这个信息。",
          citedSegmentIds: [],
          citations: [],
          createdAt: "2026-08-11T10:00:00.000Z"
        },
        source: "non_stream_fallback"
      },
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

    for await (const event of api.streamPersonQa({
      personId: "person_ta",
      question: "Ta 以前提过什么？",
      conversation: [{ role: "user", content: "关于以前的相处" }]
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["meta", "final", "complete"]);
    const [url, request] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/people/person_ta/qa");
    expect(new Headers(request.headers).get("Accept")).toBe("application/x-ndjson");
    const body = JSON.parse(String(request.body));
    expect(body).toEqual({
      question: "Ta 以前提过什么？",
      conversation: [{ role: "user", content: "关于以前的相处" }]
    });
    for (const forbidden of ["evidence", "segments", "memory", "provider", "model", "scope", "quote", "transcript"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
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
    await api.updateRecap("interaction_1", {
      version: 1,
      assignments: [{ speakerId: "speaker_1", role: "companion" }],
      items: [{ id: "recap_1", version: 1, disposition: "kept" }],
      voiceEnrollmentIntents: [{ speakerIds: ["speaker_1"] }],
      finalize: true
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
      ["PUT", "/api/date-companion/interactions/interaction_1/recap"],
      ["PATCH", "/api/date-companion/promises/promise_1"],
      ["GET", "/api/date-companion/relationships/relationship_1/search?q=%E7%9C%8B%E5%B1%95"],
      ["DELETE", "/api/date-companion/interactions/interaction_1"]
    ]);
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ uploadId: "upload_1" });
    expect(JSON.parse(String(calls[4].init.body))).not.toHaveProperty("userId");
    expect(JSON.parse(String(calls[5].init.body))).not.toHaveProperty("provider");
    expect(JSON.parse(String(calls[6].init.body))).toEqual({
      version: 1,
      assignments: [{ speakerId: "speaker_1", role: "companion" }],
      items: [{ id: "recap_1", version: 1, disposition: "kept" }],
      voiceEnrollmentIntents: [{ speakerIds: ["speaker_1"] }],
      finalize: true
    });
    expect(new Headers(calls[9].init.headers).get("if-match")).toBe('"3"');
  });

  it("validates the people and long-term retention contracts before exposing them to UI", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const contentDigest = "a".repeat(64);
    const setting = { enabled: true, version: 2, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null };
    const mapping = { id: "mapping_1", selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType: "partner", status: "confirmed", version: 3, confirmedAt: now, createdAt: now, updatedAt: now };
    const confirmed = { id: "person_self", displayName: "林澄", status: "confirmed", version: 2, explicitlyConfirmed: true, confirmedAt: now, createdAt: now, updatedAt: now };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ people: [confirmed] }))
      .mockResolvedValueOnce(jsonResponse({ selfBinding: { personId: "person_self", status: "active", version: 1, setAt: now, clearedAt: null, updatedAt: now } }))
      .mockResolvedValueOnce(jsonResponse({ review: { retention: setting, mapping, interactions: [{ interactionId: "interaction_1", sourceUploadId: "upload_1", recordingDate: "2026-08-10", sourceState: "server_cleaned", status: "needs_review", attemptCount: 1, selectionCount: 1, unknownCount: 0, updatedAt: now, review: { kind: "relationship_reconfirmation_required", canReconfirm: true, reason: "relationship_was_archived", nextAction: "reconfirm_archived_relationship" } }] } }))
      .mockResolvedValueOnce(jsonResponse({ memories: [{ subjectPersonIds: ["person_self", "person_ta"], evidenceLinks: [{ contentDigest, personEvidence: { uploadId: "upload_1", sourceSegmentId: "segment_1", quote: "下次一起看展" } }] }] }))
      .mockResolvedValueOnce(jsonResponse({ bridge: { status: "pending", attemptCount: 0, updatedAt: now, retryable: false, review: { kind: "relationship_reconfirmation_required", canReconfirm: true, reason: "relationship_was_archived", nextAction: "reconfirm_archived_relationship" } } }));
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(api.listConfirmedPeople()).resolves.toEqual([confirmed]);
    await expect(api.getSelfBinding()).resolves.toMatchObject({ personId: "person_self", status: "active" });
    await expect(api.getMemoryReview("relationship_1")).resolves.toMatchObject({
      retention: setting,
      mapping,
      interactions: [{ review: { kind: "relationship_reconfirmation_required", canReconfirm: true, reason: "relationship_was_archived", nextAction: "reconfirm_archived_relationship" } }]
    });
    await expect(api.getPersonRetainedSources("person_self")).resolves.toEqual([{ uploadId: "upload_1", sourceSegmentId: "segment_1", quote: "下次一起看展", contentDigest, subjectPersonIds: ["person_self", "person_ta"] }]);
    await expect(api.syncInteractionMemory("interaction_1", {
      mappingVersion: 3,
      subjectSuggestionConfirmation: {
        batchId: "batch_1",
        evidenceDigest: "a".repeat(64),
        proposalDigest: "b".repeat(64),
        confirmationFingerprint: "c".repeat(64),
        confirmedVisibleSuggestions: true
      },
      selections: [{ evidenceSnapshotId: "evidence_1", subject: "both" }],
      relationshipReconfirmation: {
        action: "reconfirm_archived_relationship",
        idempotencyKey: "stable-reconfirmation-key"
      }
    })).resolves.toMatchObject({
      status: "pending",
      review: { kind: "relationship_reconfirmation_required", canReconfirm: true, reason: "relationship_was_archived", nextAction: "reconfirm_archived_relationship" }
    });

    const syncRequest = fetcher.mock.calls[4][1] as RequestInit;
    expect(JSON.parse(String(syncRequest.body))).toEqual({
      mappingVersion: 3,
      subjectSuggestionConfirmation: {
        batchId: "batch_1",
        evidenceDigest: "a".repeat(64),
        proposalDigest: "b".repeat(64),
        confirmationFingerprint: "c".repeat(64),
        confirmedVisibleSuggestions: true
      },
      selections: [{ evidenceSnapshotId: "evidence_1", subject: "both" }],
      relationshipReconfirmation: {
        action: "reconfirm_archived_relationship",
        idempotencyKey: "stable-reconfirmation-key"
      }
    });
    expect(String(syncRequest.body)).not.toContain("quote");
    expect(String(syncRequest.body)).not.toContain("Transcript");
  });

  it("rejects non-allowlisted memory review reasons instead of exposing raw server errors", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({
      review: {
        retention: { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null },
        mapping: null,
        interactions: [{
          interactionId: "interaction_1",
          sourceUploadId: "upload_1",
          recordingDate: "2026-08-10",
          sourceState: "server_cleaned",
          status: "needs_review",
          attemptCount: 1,
          selectionCount: 1,
          unknownCount: 0,
          updatedAt: now,
          review: {
            kind: "relationship_reconfirmation_required",
            canReconfirm: true,
            reason: "raw_database_error",
            nextAction: "reconfirm_archived_relationship"
          }
        }]
      }
    }));
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(api.getMemoryReview("relationship_1")).rejects.toMatchObject({
      name: "DateCompanionApiError",
      code: "invalid_response"
    });
  });

  it("fails closed when retained Person evidence reuses a canonical key with conflicting digests", async () => {
    const source = {
      uploadId: "upload_1",
      sourceSegmentId: "segment_1",
      quote: "下次一起看展"
    };
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({
      memories: [
        {
          subjectPersonIds: ["person_ta"],
          evidenceLinks: [{ contentDigest: "a".repeat(64), personEvidence: source }]
        },
        {
          subjectPersonIds: ["person_ta"],
          evidenceLinks: [{ contentDigest: "b".repeat(64), personEvidence: source }]
        }
      ]
    }));
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(api.getPersonRetainedSources("person_ta")).resolves.toEqual([]);
  });

  it("strictly parses the server-owned Person source catalog without sending client evidence", async () => {
    const catalog = {
      relationshipId: "relationship_1",
      companionPersonId: "person_ta",
      mappingVersion: 3,
      status: "ready",
      sources: [{
        evidenceSnapshotId: "snapshot_1",
        interactionId: "interaction_1",
        uploadId: "upload_1",
        sourceSegmentId: "segment_1",
        recordingDate: "2026-08-11",
        startSeconds: 1,
        endSeconds: 4,
        speakerId: "speaker_ta",
        quote: "Ta 喜欢摄影",
        subject: "companion"
      }]
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse(catalog))
      .mockResolvedValueOnce(jsonResponse({ ...catalog, clientEvidence: [] }))
      .mockResolvedValueOnce(jsonResponse({ ...catalog, sources: [{ ...catalog.sources[0], subject: "self" }] }))
      .mockResolvedValueOnce(jsonResponse({ error: "date_companion_not_found" }, 404));
    const api = createDateCompanionApi(fetcher as typeof fetch);

    await expect(api.getPersonSourceCatalog("relationship_1")).resolves.toEqual(catalog);
    await expect(api.getPersonSourceCatalog("relationship_1")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(api.getPersonSourceCatalog("relationship_1")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(api.getPersonSourceCatalog("relationship_1")).rejects.toMatchObject({ status: 404 });

    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toBe("/api/date-companion/relationships/relationship_1/person-source-catalog");
      expect(init).toMatchObject({ method: "GET" });
      expect(init).not.toHaveProperty("body");
    }
  });

  it("fails closed instead of silently accepting a capped Person memory response", async () => {
    const memories = Array.from({ length: 200 }, (_, index) => ({
      subjectPersonIds: ["person_ta"],
      evidenceLinks: [{
        personEvidence: {
          uploadId: `upload_${index}`,
          sourceSegmentId: `segment_${index}`,
          quote: `原话 ${index}`
        }
      }]
    }));
    const api = createDateCompanionApi(vi.fn(async () => jsonResponse({ memories })) as typeof fetch);
    await expect(api.getPersonRetainedSources("person_ta")).rejects.toMatchObject({
      status: 409,
      code: "person_memory_source_limit_reached"
    });
  });

  it("rejects candidate or archived people returned by the selectable people endpoint", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ people: [{ id: "person_1", displayName: "候选人物", status: "candidate", version: 1, explicitlyConfirmed: false, confirmedAt: null, createdAt: now, updatedAt: now }] }))
      .mockResolvedValueOnce(jsonResponse({ people: [{ id: "person_2", displayName: "已归档人物", status: "archived", version: 2, explicitlyConfirmed: true, confirmedAt: now, createdAt: now, updatedAt: now }] }));
    const api = createDateCompanionApi(fetcher as typeof fetch);
    await expect(api.listConfirmedPeople()).rejects.toMatchObject({ code: "invalid_response" });
    await expect(api.listConfirmedPeople()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("does not present a failed retained-content purge as success", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: "retained_memory_purge_failed" }, 503));
    const api = createDateCompanionApi(fetcher as typeof fetch);
    await expect(api.purgeRetainedMemory("relationship_1")).rejects.toMatchObject({ status: 503 });
    expect(JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body))).toEqual({ confirmation: "purge_retained_memory" });
  });

  it("preserves all four supported relationship types and the actual mapping version", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)) as { relationshipType: "dating" | "partner" | "friend" | "other"; expectedVersion: number };
      return jsonResponse({ mapping: { id: "mapping_1", selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType: input.relationshipType, status: "confirmed", version: input.expectedVersion + 1, confirmedAt: now, createdAt: now, updatedAt: now } });
    });
    const api = createDateCompanionApi(fetcher as typeof fetch);
    for (const relationshipType of ["dating", "partner", "friend", "other"] as const) {
      await expect(api.updatePersonMapping("relationship_1", { selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType, expectedVersion: 7 })).resolves.toMatchObject({ relationshipType, version: 8 });
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const [, init] of fetcher.mock.calls) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ expectedVersion: 7 });
    }
  });
});

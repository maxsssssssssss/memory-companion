import { describe, expect, it, vi } from "vitest";

import {
  DailyReflectionApiError,
  DailyReflectionUploadSourceSchema,
  createDailyReflectionApi,
  type DailyReflectionBrowserRecordingInput,
  type DailyReflectionUploadInput
} from "./daily-reflection-api";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function reflection(status = "uploading") {
  return {
    id: "reflection_1",
    accountId: "user_1",
    uploadId: null,
    inputMethod: "file_upload",
    sourceOrigin: "user_reflection",
    processingProfile: "full_recording",
    ingestionContext: "daily_reflection",
    status,
    version: 0,
    idempotencyKey: "request_1",
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-08-13T08:00:00.000Z",
    updatedAt: "2026-08-13T08:00:00.000Z"
  };
}

function processingDetail(extra: Record<string, unknown> = {}) {
  return {
    reflection: reflection(),
    processingPlan: null,
    job: null,
    upload: null,
    segments: [],
    effectiveOrigin: null,
    candidates: [],
    ...extra
  };
}

function uploadInput(overrides: Partial<DailyReflectionUploadInput> = {}) {
  return {
    file: new File([new Uint8Array([1, 2, 3])], "reflection.wav", {
      type: "audio/wav"
    }),
    sourceOrigin: "user_reflection" as const,
    idempotencyKey: "upload_request_1",
    recordingDate: "2026-08-13",
    ...overrides
  };
}

function browserRecordingInput(
  overrides: Partial<DailyReflectionBrowserRecordingInput> = {}
) {
  return {
    file: new File([new Uint8Array([1, 2, 3])], "reflection.webm", {
      type: "audio/webm"
    }),
    idempotencyKey: "browser_request_1",
    recordingDate: "2026-08-13",
    clientReportedDurationMs: 61_250,
    ...overrides
  };
}

describe("createDailyReflectionApi", () => {
  it("exports the exact public file-upload source contract", () => {
    expect(DailyReflectionUploadSourceSchema.options).toEqual([
      "user_reflection",
      "direct_conversation",
      "unknown"
    ]);
  });

  it("uses the real auth endpoints with same-origin credentials", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        user: { id: "user_1", email: "person@example.com" }
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const api = createDailyReflectionApi(fetcher);

    await expect(api.getCurrentUser()).resolves.toEqual({
      id: "user_1",
      email: "person@example.com"
    });
    await expect(api.logout()).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/auth/me", {
      method: "GET",
      signal: undefined,
      credentials: "same-origin"
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/auth/logout", {
      method: "POST",
      signal: undefined,
      credentials: "same-origin"
    });
  });

  it("treats an auth check 401 as anonymous", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: "unauthenticated" }, 401)
    );

    await expect(createDailyReflectionApi(fetcher).getCurrentUser())
      .resolves.toBeNull();
  });

  it("posts the four required multipart fields without setting Content-Type", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      reflectionId: "reflection_1",
      uploadId: "upload_1",
      jobId: "job_1",
      status: "uploading",
      executionMode: "inline"
    }, 201));
    const input = uploadInput({ sourceOrigin: "direct_conversation" });

    await expect(createDailyReflectionApi(fetcher).upload(input)).resolves.toMatchObject({
      reflectionId: "reflection_1",
      status: "uploading"
    });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/daily-reflections");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(init?.body).toBeInstanceOf(FormData);
    expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
    const body = init?.body as FormData;
    expect(body.get("file")).toBe(input.file);
    expect(body.get("sourceOrigin")).toBe("direct_conversation");
    expect(body.get("idempotencyKey")).toBe("upload_request_1");
    expect(body.get("recordingDate")).toBe("2026-08-13");
    expect([...body.keys()].sort()).toEqual([
      "file",
      "idempotencyKey",
      "recordingDate",
      "sourceOrigin"
    ]);
  });

  it("posts a browser recording without client-selected provenance or profile", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      reflectionId: "reflection_browser_1",
      uploadId: "upload_browser_1",
      jobId: "job_browser_1",
      status: "uploading",
      executionMode: "inline"
    }, 201));
    const input = browserRecordingInput();

    await expect(createDailyReflectionApi(fetcher).uploadBrowserRecording(input))
      .resolves.toMatchObject({ reflectionId: "reflection_browser_1" });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/daily-reflections");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(init?.body).toBeInstanceOf(FormData);
    expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
    const body = init?.body as FormData;
    expect(body.get("file")).toBe(input.file);
    expect(body.get("inputMethod")).toBe("browser_recording");
    expect(body.get("idempotencyKey")).toBe("browser_request_1");
    expect(body.get("recordingDate")).toBe("2026-08-13");
    expect(body.get("clientReportedDurationMs")).toBe("61250");
    expect(body.has("sourceOrigin")).toBe(false);
    expect(body.has("processingProfile")).toBe(false);
    expect([...body.keys()].sort()).toEqual([
      "clientReportedDurationMs",
      "file",
      "idempotencyKey",
      "inputMethod",
      "recordingDate"
    ]);
  });

  it("omits optional browser duration and rejects forged create dimensions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      reflectionId: "reflection_browser_1",
      uploadId: "upload_browser_1",
      jobId: "job_browser_1",
      status: "uploading",
      executionMode: "inline"
    }, 201));
    const api = createDailyReflectionApi(fetcher);
    await api.uploadBrowserRecording(browserRecordingInput({
      clientReportedDurationMs: undefined
    }));
    const body = fetcher.mock.calls[0][1]?.body as FormData;
    expect(body.has("clientReportedDurationMs")).toBe(false);

    const forged = {
      ...browserRecordingInput(),
      sourceOrigin: "direct_conversation",
      processingProfile: "full_recording"
    } as unknown as DailyReflectionBrowserRecordingInput;
    await expect(api.uploadBrowserRecording(forged)).rejects.toMatchObject({
      status: 400,
      code: "invalid_upload_input"
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "manual_note",
    "ai_derived_observation",
    "legacy_unknown",
    "future_external_source"
  ])("rejects source value %s before sending an upload", async (sourceOrigin) => {
    const fetcher = vi.fn<typeof fetch>();
    const input = {
      ...uploadInput(),
      sourceOrigin
    } as unknown as DailyReflectionUploadInput;

    await expect(createDailyReflectionApi(fetcher).upload(input))
      .rejects.toMatchObject({
        name: "DailyReflectionApiError",
        status: 400,
        code: "invalid_upload_input"
      });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the detail and action URLs and credentials", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(processingDetail()))
      .mockResolvedValueOnce(jsonResponse({
        reflectionId: "reflection/1",
        status: "cancelled"
      }))
      .mockResolvedValueOnce(jsonResponse({
        reflectionId: "reflection/1",
        uploadId: "upload_1",
        jobId: "job_1",
        status: "transcribing",
        executionMode: "queue",
        queueJobId: "queue_1"
      }, 202))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createDailyReflectionApi(fetcher);

    await api.get("reflection/1");
    await api.cancel("reflection/1");
    await api.retry("reflection/1");
    await api.delete("reflection/1");

    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/daily-reflections/reflection%2F1", "GET"],
      ["/api/daily-reflections/reflection%2F1/cancel", "POST"],
      ["/api/daily-reflections/reflection%2F1/retry", "POST"],
      ["/api/daily-reflections/reflection%2F1", "DELETE"]
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.credentials).toBe("same-origin");
    }
  });

  it("marks a toy directory upload with the request adapter while reusing file upload", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      reflectionId: "reflection_toy_1",
      uploadId: "upload_toy_1",
      jobId: "job_toy_1",
      status: "uploading",
      executionMode: "inline"
    }, 201));
    const input = uploadInput({ inputAdapter: "toy_sync" });

    await createDailyReflectionApi(fetcher).upload(input);

    const body = fetcher.mock.calls[0][1]?.body as FormData;
    expect(body.get("inputAdapter")).toBe("toy_sync");
    expect(body.get("sourceOrigin")).toBe("user_reflection");
    expect(body.has("inputMethod")).toBe(false);
  });

  it("loads only strictly parsed confirmed people from the current account endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      people: [{
        id: "person_1",
        displayName: "林澄",
        status: "confirmed",
        version: 2,
        explicitlyConfirmed: true,
        confirmedAt: "2026-08-13T08:00:00.000Z",
        createdAt: "2026-08-13T08:00:00.000Z",
        updatedAt: "2026-08-13T08:00:00.000Z",
        accountId: "server-owned-extra"
      }]
    }));

    await expect(createDailyReflectionApi(fetcher).listConfirmedPeople()).resolves.toEqual([{
      id: "person_1",
      displayName: "林澄",
      status: "confirmed",
      version: 2,
      explicitlyConfirmed: true,
      confirmedAt: "2026-08-13T08:00:00.000Z",
      createdAt: "2026-08-13T08:00:00.000Z",
      updatedAt: "2026-08-13T08:00:00.000Z",
      accountId: "server-owned-extra"
    }]);
    expect(fetcher).toHaveBeenCalledWith("/api/people", {
      method: "GET",
      signal: undefined,
      credentials: "same-origin"
    });
  });

  it("loads a strict source-aware recent Reflection list without accepting extra fields", async () => {
    const historyItem = {
      id: "reflection_1",
      status: "completed",
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      recordingDate: "2026-08-13",
      sourceStatement: "你在 2026-08-13 的复盘中提到……",
      candidateCount: 2,
      pendingCount: 0,
      keptCount: 1,
      excludedCount: 1,
      rememberedCount: 1,
      notSavedCount: 1,
      subjectPersonIds: ["person_1"],
      transcriptAvailable: true,
      createdAt: "2026-08-13T08:00:00.000Z",
      updatedAt: "2026-08-13T08:05:00.000Z"
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ reflections: [historyItem] })
    );

    await expect(createDailyReflectionApi(fetcher).list()).resolves.toEqual([historyItem]);
    expect(fetcher).toHaveBeenCalledWith("/api/daily-reflections", {
      method: "GET",
      signal: undefined,
      credentials: "same-origin"
    });

    const invalid = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ reflections: [{ ...historyItem, privatePath: "C:/private" }] })
    );
    await expect(createDailyReflectionApi(invalid).list())
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("sends candidate decisions and final confirmation through their strict contracts", async () => {
    const reviewedReflection = { ...reflection("review_pending"), version: 4 };
    const candidate = {
      id: "candidate_1",
      reflectionId: "reflection_1",
      ordinal: 0,
      proposedText: "今天完成了重要决定。",
      userText: "今天完成了决定。",
      status: "kept",
      candidateType: "event",
      sourceSegmentIds: ["segment_1"],
      subjectPersonId: "person_1",
      subjectConfirmed: true,
      version: 1,
      createdAt: "2026-08-13T08:00:00.000Z",
      updatedAt: "2026-08-13T08:00:00.000Z"
    };
    const confirmation = {
      id: "confirmation_1",
      reflectionId: "reflection_1",
      accountId: "user_1",
      fingerprint: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      idempotencyKey: "finalize-key-1",
      sourceOrigin: "user_reflection",
      inputMethod: "file_upload",
      processingProfile: "full_recording",
      candidateSnapshots: [{
        candidateId: "candidate_1",
        proposedText: "今天完成了重要决定。",
        userText: "今天完成了决定。",
        finalText: "今天完成了决定。",
        status: "kept",
        candidateType: "event",
        sourceSegmentIds: ["segment_1"],
        evidenceSnapshots: [{
          sourceSegmentId: "segment_1",
          uploadId: "upload_1",
          startSeconds: 0,
          endSeconds: 5,
          text: "今天完成了一个重要决定。",
          effectiveOrigin: "user_reflection"
        }],
        subjectPersonId: "person_1"
      }],
      createdAt: "2026-08-13T08:00:00.000Z"
    };
    const operation = {
      id: "operation_1",
      reflectionId: "reflection_1",
      confirmationId: "confirmation_1",
      accountId: "user_1",
      status: "confirmation_ready",
      admittedCount: 0,
      rejectedCount: 0,
      excludedCount: 0,
      errorCode: null,
      createdAt: "2026-08-13T08:00:00.000Z",
      updatedAt: "2026-08-13T08:00:00.000Z",
      completedAt: null
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ reflection: reviewedReflection, candidates: [candidate] }))
      .mockResolvedValueOnce(jsonResponse({
        reflection: { ...reviewedReflection, status: "confirmation_ready", version: 5 },
        confirmation,
        admissionOperation: operation,
        admissionResults: [],
        reused: false
      }));
    const api = createDailyReflectionApi(fetcher);

    await api.updateCandidates("reflection/1", {
      expectedVersion: 3,
      candidates: [{
        candidateId: "candidate_1",
        status: "kept",
        userText: "  今天完成了决定。  ",
        subjectPersonId: "person_1"
      }]
    });
    await api.finalize("reflection/1", {
      expectedVersion: 4,
      idempotencyKey: "finalize-key-1"
    });

    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/daily-reflections/reflection%2F1/candidates", "PATCH"],
      ["/api/daily-reflections/reflection%2F1/finalize", "POST"]
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      expectedVersion: 3,
      candidates: [{
        candidateId: "candidate_1",
        status: "kept",
        userText: "今天完成了决定。",
        subjectPersonId: "person_1"
      }]
    });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      expectedVersion: 4,
      idempotencyKey: "finalize-key-1"
    });
  });

  it("revokes one saved candidate through a strict minimal contract", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      reflectionId: "reflection/1",
      candidateId: "candidate/1",
      reflectionStatus: "completed",
      reflectionVersion: 9,
      revocationStatus: "completed",
      outcome: "revoked",
      rememberedCount: 1,
      reused: false
    }));
    const api = createDailyReflectionApi(fetcher);

    await expect(api.revokeCandidate("reflection/1", "candidate/1", {
      expectedVersion: 8,
      idempotencyKey: "stable-revoke-key"
    })).resolves.toMatchObject({
      candidateId: "candidate/1",
      rememberedCount: 1
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/daily-reflections/reflection%2F1/candidates/candidate%2F1/revoke",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: 8,
          idempotencyKey: "stable-revoke-key"
        }),
        signal: undefined,
        credentials: "same-origin"
      }
    );
  });

  it("rejects invalid candidate revocation input and unsafe responses", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const api = createDailyReflectionApi(fetcher);
    await expect(api.revokeCandidate("reflection_1", "candidate_1", {
      expectedVersion: -1,
      idempotencyKey: ""
    })).rejects.toMatchObject({
      status: 400,
      code: "invalid_candidate_revocation_input"
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(api.revokeCandidate(
      "reflection_1",
      "candidate_1",
      {
        expectedVersion: 8,
        idempotencyKey: "stable-revoke-key",
        quote: "client-forged transcript"
      } as never
    )).rejects.toMatchObject({
      status: 400,
      code: "invalid_candidate_revocation_input"
    });
    expect(fetcher).not.toHaveBeenCalled();

    const unsafe = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      reflectionId: "reflection_1",
      candidateId: "candidate_1",
      reflectionStatus: "completed",
      reflectionVersion: 9,
      revocationStatus: "completed",
      outcome: "revoked",
      rememberedCount: 0,
      reused: false,
      internalReceipt: "private"
    }));
    await expect(createDailyReflectionApi(unsafe).revokeCandidate(
      "reflection_1",
      "candidate_1",
      { expectedVersion: 8, idempotencyKey: "stable-revoke-key" }
    )).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("bounds candidate revocation conflicts and retryable failures", async () => {
    const conflict = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: "version_conflict",
      currentVersion: 9,
      message: "private database detail"
    }, 409));
    const retryable = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: "daily_reflection_candidate_revocation_failed",
      retryable: true,
      message: "private storage path"
    }, 503));
    const input = { expectedVersion: 8, idempotencyKey: "stable-revoke-key" };

    const conflictError = await createDailyReflectionApi(conflict)
      .revokeCandidate("reflection_1", "candidate_1", input)
      .catch((error: unknown) => error);
    const retryableError = await createDailyReflectionApi(retryable)
      .revokeCandidate("reflection_1", "candidate_1", input)
      .catch((error: unknown) => error);

    expect(conflictError).toMatchObject({
      status: 409,
      code: "version_conflict",
      message: "这份复盘已经在其他页面更新，请重新加载最新内容。"
    });
    expect(retryableError).toMatchObject({
      status: 503,
      code: "daily_reflection_candidate_revocation_failed",
      message: "这条内容暂时没有撤销成功，请稍后重试。"
    });
    expect(String(conflictError)).not.toContain("private database detail");
    expect(String(retryableError)).not.toContain("private storage path");
  });

  it("normalizes blank candidate edits and bounds 409 conflict details", async () => {
    const conflict = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: "version_conflict",
      currentVersion: 3,
      message: "private repository state"
    }, 409));
    const api = createDailyReflectionApi(conflict);

    const error = await api.updateCandidates("reflection_1", {
      expectedVersion: 2,
      candidates: [{
        candidateId: "candidate_1",
        status: "excluded",
        userText: "   ",
        subjectPersonId: null
      }]
    }).catch((cause: unknown) => cause);

    expect(JSON.parse(String(conflict.mock.calls[0][1]?.body))).toMatchObject({
      candidates: [{ userText: null }]
    });
    expect(error).toMatchObject({
      status: 409,
      code: "version_conflict",
      message: "这份复盘已经在其他页面更新，请重新加载最新内容。"
    });
    expect(String(error)).not.toContain("private repository state");
  });

  it("strictly parses detail and action responses", async () => {
    const detailFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(processingDetail({ unexpected: true }))
    );
    const receiptFetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      reflectionId: "reflection_1",
      uploadId: "upload_1",
      jobId: "job_1",
      status: "uploading",
      executionMode: "inline",
      unexpected: true
    }, 201));

    await expect(createDailyReflectionApi(detailFetcher).get("reflection_1"))
      .rejects.toMatchObject({ code: "invalid_response" });
    await expect(createDailyReflectionApi(receiptFetcher).upload(uploadInput()))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("maps 401 and known failures to bounded user-facing errors", async () => {
    const unauthorized = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: "unauthenticated",
      message: "sensitive server detail"
    }, 401));
    const tooLarge = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: "file_too_large",
      message: "private path and stack trace"
    }, 400));

    const authError = await createDailyReflectionApi(unauthorized)
      .get("reflection_1")
      .catch((error: unknown) => error);
    const uploadError = await createDailyReflectionApi(tooLarge)
      .upload(uploadInput())
      .catch((error: unknown) => error);

    expect(authError).toBeInstanceOf(DailyReflectionApiError);
    expect(authError).toMatchObject({
      status: 401,
      code: "unauthenticated",
      message: "登录已失效，请重新登录。"
    });
    expect(uploadError).toMatchObject({
      status: 400,
      code: "file_too_large",
      message: "音频文件不能超过 300MB。"
    });
    expect(String(uploadError)).not.toContain("private path");
  });

  it("preserves abort errors while bounding other transport failures", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = vi.fn<typeof fetch>().mockRejectedValue(
      new DOMException("aborted", "AbortError")
    );
    const offline = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError("internal network diagnostics")
    );

    await expect(createDailyReflectionApi(aborted).get("reflection_1", controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    await expect(createDailyReflectionApi(offline).get("reflection_1"))
      .rejects.toMatchObject({
        name: "DailyReflectionApiError",
        status: 0,
        code: "network_error",
        message: "网络连接失败，请检查网络后重试。"
      });
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readDateCompanionPersonArchive, useDateCompanionPersonArchive } from "./date-companion-people";

const responseBody = {
  person: {
    id: "person_1",
    accountId: "account_private",
    displayName: "林澄",
    status: "confirmed",
    explicitlyConfirmed: true,
    confirmedAt: "2026-08-01T10:00:00.000Z",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:00.000Z",
    version: 2
  },
  timeline: [{
    date: "2026-08-03",
    memory: {
      id: "memory_1",
      userId: "account_private",
      type: "preference",
      title: "喜欢临海散步",
      summary: "林澄明确提到海边散步让她放松。",
      importanceScore: 0.99,
      importanceReasons: ["internal_reason"],
      status: "active",
      date: "2026-08-03",
      createdAt: "2026-08-03T10:00:00.000Z",
      updatedAt: "2026-08-04T10:00:00.000Z"
    },
    evidenceLinks: [{
      memoryEvidence: { date: "2026-08-03", internal: "hidden" },
      personEvidence: {
        id: "person_evidence_1",
        accountId: "account_private",
        uploadId: "upload_1",
        sourceSegmentId: "segment_1",
        quote: "我很喜欢傍晚去海边走一走。",
        createdAt: "2026-08-03T10:00:00.000Z"
      }
    }],
    sourceAttribution: {
      origin: "direct_conversation",
      statement: "在 2026 年 8 月 3 日的交流中提到",
      date: "2026-08-03",
      internalCode: "hidden"
    },
    subjectPersonIds: ["person_1"],
    shared: false
  }]
};

describe("date-companion people client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the account-scoped timeline with no-store and exposes only the UI allowlist", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }));
    const archive = await readDateCompanionPersonArchive("person_1", { fetchImpl: fetchImpl as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledWith("/api/people/person_1/timeline?limit=50", {
      method: "GET",
      cache: "no-store",
      signal: undefined
    });
    expect(archive).toEqual({
      person: {
        id: "person_1",
        displayName: "林澄",
        confirmedAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-11T10:00:00.000Z"
      },
      entries: [{
        id: "memory_1",
        type: "preference",
        status: "active",
        title: "喜欢临海散步",
        summary: "林澄明确提到海边散步让她放松。",
        date: "2026-08-03",
        updatedAt: "2026-08-04T10:00:00.000Z",
        sourceStatement: "在 2026 年 8 月 3 日的交流中提到",
        sourceOrigin: "direct_conversation",
        shared: false,
        sources: [{
          id: "person_evidence_1",
          uploadId: "upload_1",
          sourceSegmentId: "segment_1",
          quote: "我很喜欢傍晚去海边走一走。",
          date: "2026-08-03"
        }]
      }]
    });
    expect(JSON.stringify(archive)).not.toMatch(/account_private|importanceScore|internal_reason/u);
  });

  it("fails closed on cross-object, unconfirmed, or malformed responses", async () => {
    const crossObject = vi.fn(async () => new Response(JSON.stringify({
      ...responseBody,
      person: { ...responseBody.person, id: "person_2" }
    }), { status: 200 }));
    await expect(readDateCompanionPersonArchive("person_1", { fetchImpl: crossObject as typeof fetch })).rejects.toThrow("invalid_person_archive");

    const crossPersonTimeline = vi.fn(async () => new Response(JSON.stringify({
      ...responseBody,
      timeline: responseBody.timeline.map((entry) => ({ ...entry, subjectPersonIds: ["person_2"] }))
    }), { status: 200 }));
    await expect(readDateCompanionPersonArchive("person_1", { fetchImpl: crossPersonTimeline as typeof fetch })).rejects.toThrow("invalid_person_archive");

    const candidate = vi.fn(async () => new Response(JSON.stringify({
      ...responseBody,
      person: { ...responseBody.person, status: "candidate", explicitlyConfirmed: false }
    }), { status: 200 }));
    await expect(readDateCompanionPersonArchive("person_1", { fetchImpl: candidate as typeof fetch })).rejects.toThrow("invalid_person_archive");
  });

  it("preserves 404 and authentication boundaries without exposing response bodies", async () => {
    const notFound = vi.fn(async () => new Response(JSON.stringify({ error: "private details" }), { status: 404 }));
    await expect(readDateCompanionPersonArchive("person_missing", { fetchImpl: notFound as typeof fetch })).rejects.toThrow("person_not_found");

    const unauthorized = vi.fn(async () => new Response(JSON.stringify({ error: "private details" }), { status: 401 }));
    await expect(readDateCompanionPersonArchive("person_1", { fetchImpl: unauthorized as typeof fetch })).rejects.toThrow("unauthenticated");
  });

  it("clears the previous Person immediately and ignores a late aborted response", async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>((input) => new Promise<Response>((resolve) => {
      if (String(input).includes("person_1")) resolveFirst = resolve;
      else resolveSecond = resolve;
    }));
    vi.stubGlobal("fetch", fetchImpl);

    const { result, rerender } = renderHook(
      ({ personId }) => useDateCompanionPersonArchive(personId),
      { initialProps: { personId: "person_1" } }
    );
    await waitFor(() => expect(result.current.status).toBe("loading"));

    rerender({ personId: "person_2" });
    expect(result.current.status).toBe("loading");

    await act(async () => {
      resolveFirst(new Response(JSON.stringify(responseBody), { status: 200 }));
      await Promise.resolve();
    });
    expect(result.current.status).toBe("loading");

    const secondBody = {
      ...responseBody,
      person: { ...responseBody.person, id: "person_2", displayName: "周岚" },
      timeline: responseBody.timeline.map((entry) => ({ ...entry, subjectPersonIds: ["person_2"] }))
    };
    await act(async () => {
      resolveSecond(new Response(JSON.stringify(secondBody), { status: 200 }));
    });
    await waitFor(() => expect(result.current).toMatchObject({
      status: "ready",
      archive: { person: { id: "person_2", displayName: "周岚" } }
    }));
  });
});

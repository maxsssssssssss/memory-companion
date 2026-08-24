import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DailyReflectionMemoryProposal } from
  "@/lib/domain/daily-reflection-memory-proposal";
import {
  requireAuthContext,
  type AuthContext
} from "@/lib/server/auth/request-context";

const state = vi.hoisted(() => ({
  accountId: "account_1",
  service: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    evaluate: vi.fn(),
    admit: vi.fn(),
    provenance: vi.fn()
  }
}));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/auth/request-context")>()),
  requireAuthContext: vi.fn(async () => ({
    user: { id: state.accountId, email: `${state.accountId}@example.com` }
  }) as AuthContext)
}));

vi.mock("@/lib/server/daily-reflection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/daily-reflection")>()),
  getDailyReflectionMemoryProposalService: () => state.service
}));

import {
  DailyReflectionConflictError,
  DailyReflectionNotFoundError
} from "@/lib/server/daily-reflection";
import { POST as createProposal } from
  "../cards/[cardId]/memory-proposals/route";
import { GET as listProposals } from "./route";
import { GET as getProposal } from "./[proposalId]/route";
import { POST as evaluateProposal } from "./[proposalId]/evaluate/route";
import { POST as admitProposal } from "./[proposalId]/admit/route";

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

function proposal(overrides: Partial<DailyReflectionMemoryProposal> = {}) {
  return {
    id: "proposal_1",
    accountId: "account_1",
    cardId: "card_1",
    reflectionId: "reflection_1",
    title: "长期偏好",
    cardKind: "insight",
    actionClaimed: false,
    memoryType: "preference",
    content: "我平时更喜欢安静的位置。",
    evidenceIds: ["segment_1"],
    evidenceSnapshots: [{
      sourceSegmentId: "segment_1",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 8,
      effectiveOrigin: "user_reflection"
    }],
    riskFlags: [],
    subjectPersonId: null,
    importance: 0.9,
    durability: 0.9,
    novelty: 0.8,
    sensitivity: 0.1,
    epistemicStatus: "explicit_user_statement",
    epistemicCaution: null,
    status: "pending",
    policyVersion: "unassessed",
    score: 0,
    reasons: [],
    operationKey: "daily-reflection-card:card_1",
    requestFingerprint: "a".repeat(64),
    memoryId: null,
    sourceOrigin: "user_reflection",
    inputAdapter: "file_picker",
    capturePurpose: "inspiration_capture",
    recordingDate: "2026-08-24",
    createdBy: "user",
    admissionMethod: "daily_reflection_memory_proposal_v1",
    cardVersion: 1,
    version: 0,
    createdAt: "2026-08-24T08:00:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
    admittedAt: null,
    ...overrides
  } satisfies DailyReflectionMemoryProposal;
}

function expectPublicProposal(payload: Record<string, unknown>) {
  expect(payload).not.toHaveProperty("accountId");
  expect(payload).not.toHaveProperty("operationKey");
  expect(payload).not.toHaveProperty("requestFingerprint");
  expect(payload).not.toHaveProperty("createdBy");
  expect(payload).not.toHaveProperty("admissionMethod");
  expect(payload).not.toHaveProperty("cardVersion");
  expect(payload).not.toHaveProperty("inputAdapter");
  expect(payload).not.toHaveProperty("capturePurpose");
}

beforeEach(() => {
  process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
  state.accountId = "account_1";
  vi.clearAllMocks();
  const pending = proposal();
  const approved = proposal({
    status: "approved",
    version: 1,
    policyVersion: "daily_reflection_memory_proposal_policy_v1",
    score: 0.8,
    reasons: ["policy_threshold_met"]
  });
  const admitted = proposal({
    status: "admitted",
    version: 3,
    policyVersion: "daily_reflection_memory_proposal_policy_v1",
    score: 0.8,
    reasons: ["policy_threshold_met"],
    memoryId: "memory_1",
    admittedAt: "2026-08-24T08:01:00.000Z"
  });
  state.service.create.mockReturnValue({ proposal: pending, reused: false });
  state.service.get.mockReturnValue(pending);
  state.service.list.mockReturnValue({ proposals: [pending], total: 1, limit: 24, offset: 0 });
  state.service.evaluate.mockReturnValue({
    proposal: approved,
    decision: {
      status: "approved",
      score: 0.8,
      reasons: ["policy_threshold_met"],
      policyVersion: "daily_reflection_memory_proposal_policy_v1"
    },
    reused: false
  });
  state.service.admit.mockResolvedValue({
    status: "admitted",
    proposal: admitted,
    memoryId: "memory_1",
    reasons: ["policy_threshold_met"]
  });
  state.service.provenance.mockReturnValue({
    proposal: admitted,
    publicationId: "publication_1",
    publicationStatus: "published",
    memoryId: "memory_1",
    revoked: false,
    evidence: [{
      memoryEvidenceId: "memory_evidence_1",
      sourceSegmentId: "segment_1",
      uploadId: "upload_1",
      effectiveOrigin: "user_reflection",
      contentDigest: "b".repeat(64),
      createdAt: "2026-08-24T08:01:00.000Z"
    }]
  });
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("Daily Reflection Memory Proposal routes", () => {
  it("creates an account-scoped Proposal from a versioned Working Card", async () => {
    const response = await createProposal(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ expectedCardVersion: 1, memoryType: "preference" })
    }), { params: Promise.resolve({ cardId: "card_1" }) });

    expect(response.status).toBe(201);
    expect(state.service.create).toHaveBeenCalledWith({
      accountId: "account_1",
      cardId: "card_1",
      expectedCardVersion: 1,
      memoryType: "preference"
    });
    const payload = await response.json();
    expectPublicProposal(payload.proposal);
    expect(payload.proposal).not.toHaveProperty("evidenceSegments");
  });

  it("lists, evaluates, and admits only strict public DTOs", async () => {
    const listed = await listProposals(new Request(
      "http://localhost/api/daily-reflections/memory-proposals?status=pending&limit=24&offset=0"
    ));
    expect(listed.status).toBe(200);
    expect(state.service.list).toHaveBeenCalledWith({
      accountId: "account_1",
      status: "pending",
      limit: 24,
      offset: 0
    });
    expectPublicProposal((await listed.json()).proposals[0]);

    const evaluated = await evaluateProposal(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 0 })
    }), { params: Promise.resolve({ proposalId: "proposal_1" }) });
    expect(evaluated.status).toBe(200);
    expect(state.service.evaluate).toHaveBeenCalledWith({
      accountId: "account_1",
      proposalId: "proposal_1",
      expectedVersion: 0
    });

    const admitted = await admitProposal(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1 })
    }), { params: Promise.resolve({ proposalId: "proposal_1" }) });
    expect(admitted.status).toBe(200);
    const admittedPayload = await admitted.json();
    expect(admittedPayload).toMatchObject({ status: "admitted", memoryId: "memory_1" });
    expectPublicProposal(admittedPayload.proposal);
  });

  it("returns provenance metadata without Transcript text", async () => {
    const response = await getProposal(new Request(
      "http://localhost/api/daily-reflections/memory-proposals/proposal_1?include=provenance"
    ), { params: Promise.resolve({ proposalId: "proposal_1" }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      publicationId: "publication_1",
      publicationStatus: "published",
      memoryId: "memory_1"
    });
    expectPublicProposal(payload.proposal);
    expect(payload.evidence[0]).not.toHaveProperty("text");
    expect(payload.evidence[0]).not.toHaveProperty("quote");
  });

  it("fails closed for invalid bodies and cross-account targets", async () => {
    const invalid = await createProposal(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ expectedCardVersion: 1, memoryType: "summary" })
    }), { params: Promise.resolve({ cardId: "card_1" }) });
    expect(invalid.status).toBe(400);

    state.accountId = "account_2";
    state.service.get.mockImplementationOnce(() => {
      throw new DailyReflectionNotFoundError();
    });
    const missing = await getProposal(new Request("http://localhost"), {
      params: Promise.resolve({ proposalId: "proposal_1" })
    });
    expect(missing.status).toBe(404);
  });

  it("rejects unknown or repeated query parameters", async () => {
    const unknown = await listProposals(new Request(
      "http://localhost/api/daily-reflections/memory-proposals?debug=true"
    ));
    expect(unknown.status).toBe(400);
    const repeated = await listProposals(new Request(
      "http://localhost/api/daily-reflections/memory-proposals?limit=1&limit=2"
    ));
    expect(repeated.status).toBe(400);
    const invalidDetail = await getProposal(new Request(
      "http://localhost/api/daily-reflections/memory-proposals/proposal_1?include=raw"
    ), { params: Promise.resolve({ proposalId: "proposal_1" }) });
    expect(invalidDetail.status).toBe(400);
    expect(state.service.list).not.toHaveBeenCalled();
    expect(state.service.get).not.toHaveBeenCalled();
  });

  it("keeps create, evaluate, admit, provenance, and list account scoped", async () => {
    state.accountId = "account_2";
    state.service.create.mockImplementationOnce(() => {
      throw new DailyReflectionNotFoundError();
    });
    state.service.evaluate.mockImplementationOnce(() => {
      throw new DailyReflectionNotFoundError();
    });
    state.service.admit.mockRejectedValueOnce(new DailyReflectionNotFoundError());
    state.service.provenance.mockImplementationOnce(() => {
      throw new DailyReflectionNotFoundError();
    });
    state.service.list.mockReturnValueOnce({ proposals: [], total: 0, limit: 24, offset: 0 });

    const create = await createProposal(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ expectedCardVersion: 1, memoryType: "preference" })
    }), { params: Promise.resolve({ cardId: "card_1" }) });
    const evaluate = await evaluateProposal(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 0 })
    }), { params: Promise.resolve({ proposalId: "proposal_1" }) });
    const admit = await admitProposal(new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1 })
    }), { params: Promise.resolve({ proposalId: "proposal_1" }) });
    const provenance = await getProposal(new Request(
      "http://localhost/api/daily-reflections/memory-proposals/proposal_1?include=provenance"
    ), { params: Promise.resolve({ proposalId: "proposal_1" }) });
    const list = await listProposals(new Request(
      "http://localhost/api/daily-reflections/memory-proposals"
    ));

    expect([create.status, evaluate.status, admit.status, provenance.status]).toEqual([
      404, 404, 404, 404
    ]);
    expect(list.status).toBe(200);
    expect(state.service.list).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_2"
    }));
  });

  it("returns 401 before calling the service", async () => {
    vi.mocked(requireAuthContext).mockRejectedValueOnce(new Error("unauthenticated"));
    const response = await listProposals(new Request(
      "http://localhost/api/daily-reflections/memory-proposals"
    ));
    expect(response.status).toBe(401);
    expect(state.service.list).not.toHaveBeenCalled();
  });

  it("does not echo unsafe internal conflict identifiers", async () => {
    state.service.get.mockImplementationOnce(() => {
      throw new DailyReflectionConflictError("A".repeat(64));
    });
    const response = await getProposal(new Request(
      "http://localhost/api/daily-reflections/memory-proposals/proposal_1"
    ), { params: Promise.resolve({ proposalId: "proposal_1" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "daily_reflection_memory_proposal_conflict"
    });
  });
});

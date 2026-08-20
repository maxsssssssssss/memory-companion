import { describe, expect, it } from "vitest";

import type {
  DcInteractionDetail,
  DcRelationshipView
} from "@/lib/domain/date-companion-stage2";

import {
  buildDateCompanionRelationshipQaContext,
  buildDateCompanionRelationshipQaInput
} from "./relationship-qa";
import { retrieveQaEvidence } from "@/lib/server/retrieval/ai-qa";

function interaction(input: {
  id: string;
  uploadId: string;
  date: string;
  quote: string;
  segmentId: string;
  status?: "draft" | "confirmed";
  sourceState?: "available" | "server_cleaned" | "explicitly_deleted";
  disposition?: "pending" | "kept" | "excluded";
  speakerId?: string;
  participantRole?: "self" | "companion" | "unresolved";
  participantConfirmed?: boolean;
  relationshipId?: string;
}): DcInteractionDetail {
  const status = input.status ?? "confirmed";
  const participantRole = input.participantRole ?? "companion";
  const participantConfirmed = input.participantConfirmed ?? true;
  return {
    id: input.id,
    relationshipId: input.relationshipId ?? "relationship_1",
    sourceUploadId: input.uploadId,
    recordingDate: input.date,
    originalName: `${input.uploadId}.m4a`,
    status,
    sourceState: input.sourceState ?? "available",
    version: 1,
    createdAt: `${input.date}T09:00:00.000Z`,
    updatedAt: `${input.date}T10:00:00.000Z`,
    ...(status === "confirmed" ? { confirmedAt: `${input.date}T10:00:00.000Z` } : {}),
    participants: [{
      speakerId: input.speakerId ?? "speaker_ta",
      role: participantRole,
      ...(participantConfirmed ? { confirmedAt: `${input.date}T10:00:00.000Z` } : {})
    }],
    recapItems: [{
      id: `recap_${input.id}`,
      interactionId: input.id,
      kind: "moment",
      proposedText: input.quote,
      displayedText: input.quote,
      disposition: input.disposition ?? "kept",
      version: 1,
      sortOrder: 0,
      evidence: [{
        id: `evidence_${input.id}`,
        recapItemId: `recap_${input.id}`,
        uploadId: input.uploadId,
        sourceSegmentId: input.segmentId,
        startSeconds: 1,
        endSeconds: 3,
        ...(input.speakerId === "" ? {} : { speakerId: input.speakerId ?? "speaker_ta" }),
        quote: input.quote,
        createdAt: `${input.date}T10:00:00.000Z`
      }]
    }]
  };
}

function view(interactions: DcInteractionDetail[]): DcRelationshipView {
  return {
    relationship: {
      id: "relationship_1",
      displayName: "Ta",
      status: "active",
      version: 1,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z"
    },
    interactions,
    promises: []
  };
}

describe("Date Companion relationship QA Evidence allowlist", () => {
  it("includes an older confirmed interaction even when the latest interaction is different", () => {
    const context = buildDateCompanionRelationshipQaContext(view([
      interaction({
        id: "old",
        uploadId: "upload_old",
        date: "2026-07-10",
        segmentId: "segment_old",
        quote: "我小时候最喜欢去海边"
      }),
      interaction({
        id: "latest",
        uploadId: "upload_latest",
        date: "2026-08-06",
        segmentId: "segment_latest",
        quote: "今天吃了晚饭"
      })
    ]));

    expect(context.eligibleSourceSegmentIds).toEqual(["segment_old", "segment_latest"]);
    expect(context.segments.find((item) => item.id === "segment_old")?.text).toContain("我小时候最喜欢去海边");
    expect(context.segments.find((item) => item.id === "segment_old")?.text).toContain("2026-07-10");
  });

  it("excludes drafts, excluded recaps, unresolved or source-less evidence, deleted sources, and another relationship", () => {
    const context = buildDateCompanionRelationshipQaContext(view([
      interaction({ id: "ok", uploadId: "upload_ok", date: "2026-08-01", segmentId: "segment_ok", quote: "允许进入" }),
      interaction({ id: "draft", uploadId: "upload_draft", date: "2026-08-02", segmentId: "segment_draft", quote: "草稿秘密", status: "draft" }),
      interaction({ id: "excluded", uploadId: "upload_excluded", date: "2026-08-03", segmentId: "segment_excluded", quote: "排除秘密", disposition: "excluded" }),
      interaction({ id: "unresolved", uploadId: "upload_unresolved", date: "2026-08-04", segmentId: "segment_unresolved", quote: "未确认说话人", participantRole: "unresolved" }),
      interaction({ id: "unconfirmed", uploadId: "upload_unconfirmed", date: "2026-08-04", segmentId: "segment_unconfirmed", quote: "未最终确认说话人", participantConfirmed: false }),
      interaction({ id: "no_source", uploadId: "upload_no_source", date: "2026-08-04", segmentId: "segment_no_source", quote: "没有说话人来源", speakerId: "" }),
      interaction({ id: "deleted", uploadId: "upload_deleted", date: "2026-08-05", segmentId: "segment_deleted", quote: "删除秘密", sourceState: "explicitly_deleted" }),
      interaction({ id: "other_relationship", uploadId: "upload_other", date: "2026-08-06", segmentId: "segment_other", quote: "其他关系秘密", relationshipId: "relationship_2" })
    ]));

    expect(context.eligibleSourceSegmentIds).toEqual(["segment_ok"]);
    const serialized = JSON.stringify(context);
    expect(serialized).not.toMatch(/草稿秘密|排除秘密|未确认说话人|未最终确认说话人|没有说话人来源|删除秘密|其他关系秘密/u);
  });

  it("drops a source id that is ambiguous across different uploads", () => {
    const context = buildDateCompanionRelationshipQaContext(view([
      interaction({ id: "first", uploadId: "upload_first", date: "2026-08-01", segmentId: "shared_segment", quote: "第一条" }),
      interaction({ id: "second", uploadId: "upload_second", date: "2026-08-02", segmentId: "shared_segment", quote: "第二条" })
    ]));

    expect(context.eligibleSourceSegmentIds).toEqual([]);
    expect(context.briefItems).toEqual([]);
  });

  it("builds a canonical relationship input without Memory, Relationship Signals, or Hybrid", () => {
    const qaInput = buildDateCompanionRelationshipQaInput({
      userId: "user_1",
      relationshipId: "relationship_1",
      question: "Ta 以前说过什么？",
      conversation: [],
      settingsStore: {} as never,
      view: view([interaction({ id: "old", uploadId: "upload_old", date: "2026-07-10", segmentId: "segment_old", quote: "旧证据" })])
    });

    expect(qaInput).toMatchObject({
      userId: "user_1",
      uploadId: "relationship_1",
      relationshipScope: true,
      disableHybridRetrieval: true,
      failClosedOnModelProviderMismatch: true,
      relationshipSignals: [],
      audioInsights: [],
      semanticSegments: []
    });
    expect(qaInput.memoryContext).toBeUndefined();
    expect(qaInput.segments.map((item) => item.id)).toEqual(["segment_old"]);
  });

  it("lets canonical lexical retrieval select a fact that exists only in the older interaction", () => {
    const qaInput = buildDateCompanionRelationshipQaInput({
      userId: "user_1",
      relationshipId: "relationship_1",
      question: "我小时候最喜欢去海边",
      conversation: [],
      settingsStore: {} as never,
      view: view([
        interaction({
          id: "old",
          uploadId: "upload_old",
          date: "2026-07-10",
          segmentId: "segment_old",
          quote: "我小时候最喜欢去海边"
        }),
        interaction({
          id: "latest",
          uploadId: "upload_latest",
          date: "2026-08-06",
          segmentId: "segment_latest",
          quote: "今天吃了晚饭"
        })
      ])
    });

    const evidence = retrieveQaEvidence(qaInput);
    expect(evidence[0].sourceSegmentIds).toContain("segment_old");
    expect(evidence[0].text).toContain("我小时候最喜欢去海边");
  });
});

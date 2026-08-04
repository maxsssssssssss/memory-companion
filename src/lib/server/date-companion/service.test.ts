import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseDayPayload } from "@/lib/domain/day-payload";
import { JsonStore } from "@/lib/server/storage/json-store";

import { openDateCompanionDatabase } from "./db";
import { DateCompanionRepository } from "./repository";
import { buildDateCompanionImportCandidates, DateCompanionService } from "./service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DateCompanionService import", () => {
  it("does not invent a participant or long-term candidate for speaker-less evidence", () => {
    const payload = parseDayPayload({
      upload: {
        id: "upload_speakerless",
        originalName: "speakerless.wav",
        mimeType: "audio/wav",
        sizeBytes: 128,
        recordingDate: "2026-08-04",
        status: "ready"
      },
      job: {
        id: "job_speakerless",
        uploadId: "upload_speakerless",
        status: "ready",
        progress: 100
      },
      segments: [{
        id: "segment_speakerless",
        uploadId: "upload_speakerless",
        startSeconds: 0,
        endSeconds: 3,
        text: "没有可靠说话人标签的原话",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: ["commitment"]
      }],
      audioInsights: [],
      semanticSegments: [],
      semanticSegmentsAvailable: true,
      briefItems: [{
        id: "brief_speakerless",
        uploadId: "upload_speakerless",
        category: "commitment",
        title: "约定",
        body: "我来预订",
        priority: "high",
        confidence: 0.9,
        status: "candidate",
        sourceSegmentIds: ["segment_speakerless"],
        sourceTimeRange: { startSeconds: 0, endSeconds: 3 },
        transcriptExcerpt: "没有可靠说话人标签的原话",
        people: [],
        topics: []
      }],
      relationshipSignals: [],
      relationshipSignalsAvailable: true,
      proactiveInsights: [],
      proactiveInsightsAvailable: false,
      speakerAliases: {},
      speakerAliasesByUploadId: { upload_speakerless: {} }
    });

    expect(buildDateCompanionImportCandidates(payload)).toEqual([]);
  });

  it("reads a real user JsonStore, snapshots transcript evidence, and reuses after source cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-service-"));
    roots.push(root);
    const store = new JsonStore(root);
    await store.write("uploads", "upload_1", {
      id: "upload_1",
      originalName: "fixture.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-08-04",
      status: "ready"
    });
    await store.write("jobs-by-upload", "upload_1", {
      id: "job_1",
      uploadId: "upload_1",
      status: "ready",
      progress: 100
    });
    await store.write("segments", "upload_1", [{
      id: "segment_1",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 5,
      speaker: "speaker_0",
      text: "这是服务端保存的真实原话",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: ["commitment"]
    }]);
    await store.write("audio-insights", "upload_1", []);
    await store.write("semantic-segments", "upload_1", []);
    await store.write("brief-items", "upload_1", [{
      id: "brief_1",
      uploadId: "upload_1",
      category: "commitment",
      title: "约定",
      body: "客户端可见的摘要",
      priority: "high",
      confidence: 0.9,
      status: "candidate",
      sourceSegmentIds: ["segment_1"],
      sourceTimeRange: { startSeconds: 0, endSeconds: 5 },
      transcriptExcerpt: "伪造的客户端引用",
      people: [],
      topics: []
    }]);
    await store.write("relationship-signals", "upload_1", []);

    const database = openDateCompanionDatabase({ filePath: ":memory:" });
    try {
      const repository = new DateCompanionRepository(database);
      const relationship = repository.createOrGetRelationship("user_a").relationship;
      const service = new DateCompanionService(repository);
      const first = await service.importInteraction({
        store,
        userId: "user_a",
        relationshipId: relationship.id,
        uploadId: "upload_1"
      });
      expect(first.reused).toBe(false);
      expect(first.view.interactions[0].recapItems[0].evidence[0]).toMatchObject({
        uploadId: "upload_1",
        sourceSegmentId: "segment_1",
        quote: "这是服务端保存的真实原话"
      });
      expect(first.view.interactions[0].recapItems[0].evidence[0].quote).not.toContain("伪造");

      await store.delete("uploads", "upload_1");
      await store.delete("segments", "upload_1");
      expect(repository.markUploadSourceState("user_a", "upload_1", "server_cleaned")).toBe(true);
      const retained = repository.getRelationshipView("user_a", relationship.id).interactions[0];
      expect(retained.sourceState).toBe("server_cleaned");
      expect(retained.recapItems[0].evidence[0]).toMatchObject({
        uploadId: "upload_1",
        sourceSegmentId: "segment_1",
        quote: "这是服务端保存的真实原话"
      });
      const second = await service.importInteraction({
        store,
        userId: "user_a",
        relationshipId: relationship.id,
        uploadId: "upload_1"
      });
      expect(second.reused).toBe(true);
      expect(second.interactionId).toBe(first.interactionId);
    } finally {
      database.close();
    }
  });
});

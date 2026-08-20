import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { TranscriptSegmentSchema, type TranscriptSegment, type ValueLabel } from "@/lib/domain/types";

import {
  FixtureExpectedResultsSchema,
  FixtureManifestSchema,
  type FixtureDataset,
  type FixtureSession
} from "./types";

const SECONDS_PER_HAN_CHARACTER = 0.23;
const MIN_UTTERANCE_SECONDS = 3.2;
const INTER_UTTERANCE_GAPS = [0.9, 1.1, 1, 1.3, 0.8, 1.2] as const;

function roundMillis(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function assertInsideDataset(rootDir: string, candidate: string) {
  const relativePath = relative(rootDir, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Fixture path escapes dataset root: ${candidate}`);
  }
  return candidate;
}

export function resolveFixturePath(rootDir: string, relativePath: string) {
  return assertInsideDataset(rootDir, resolve(rootDir, relativePath));
}

export function fixtureUploadId(sessionId: string) {
  return `fixture_${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function fixtureSegmentId(sessionId: string, index: number) {
  return `${fixtureUploadId(sessionId)}_seg_${String(index + 1).padStart(2, "0")}`;
}

function classifyValueLabels(text: string): ValueLabel[] {
  const labels = new Set<ValueLabel>();
  if (/明确答应|答应你|最晚|之前把|会提前|给你明确答复|会按住|会在.{0,20}(?:给|发|确认)|负责确认/u.test(text)) {
    labels.add("commitment");
  }
  if (/我来|我先|我负责|需要继续|再确认|核对|列清单/u.test(text)) {
    labels.add("task");
  }
  if (/已经.{0,12}(?:做完|完成|交付|落实)|改到|改期|先取消|计划算是落实/u.test(text)) {
    labels.add("decision");
  }
  if (/还没|没有达成|不确定|回答不了|想确认|能不能|是否|还是.{0,16}还是|\?/u.test(text)) {
    labels.add("open_question");
  }
  if (/耽误|延迟|空等|含糊|临时取消|来不及|冲突/u.test(text)) {
    labels.add("risk");
  }
  return [...labels];
}

function parseTranscriptLines(text: string, session: FixtureSession) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 8 || lines.length > 14) {
    throw new Error(`${session.transcriptFile} must contain 8-14 utterances`);
  }
  return lines.map((line, index) => {
    const match = /^([AB]):\s*(.+)$/u.exec(line);
    if (!match) {
      throw new Error(`${session.transcriptFile}:${index + 1} must use A: or B:`);
    }
    if (index > 0 && match[1] === /^([AB]):/u.exec(lines[index - 1])?.[1]) {
      throw new Error(`${session.transcriptFile}:${index + 1} must alternate speakers`);
    }
    return { speaker: match[1], text: match[2] };
  });
}

export async function loadFixtureDataset(datasetPath: string): Promise<FixtureDataset> {
  const rootDir = resolve(datasetPath);
  const manifest = FixtureManifestSchema.parse(
    JSON.parse(await readFile(resolveFixturePath(rootDir, "manifest.json"), "utf8"))
  );
  const expected = FixtureExpectedResultsSchema.parse(
    JSON.parse(await readFile(resolveFixturePath(rootDir, "expected-results.json"), "utf8"))
  );
  if (manifest.datasetVersion !== expected.datasetVersion) {
    throw new Error("Fixture manifest and expected-results versions differ");
  }
  const sessionIds = new Set<string>();
  for (const session of manifest.sessions) {
    if (session.datasetVersion !== manifest.datasetVersion) {
      throw new Error(`${session.sessionId} has a mismatched dataset version`);
    }
    if (sessionIds.has(session.sessionId)) {
      throw new Error(`Duplicate fixture session: ${session.sessionId}`);
    }
    sessionIds.add(session.sessionId);
    resolveFixturePath(rootDir, session.transcriptFile);
  }
  return { rootDir, manifest, expected };
}

export async function buildFixtureTranscriptSegments(input: {
  dataset: FixtureDataset;
  session: FixtureSession;
}): Promise<TranscriptSegment[]> {
  const text = await readFile(
    resolveFixturePath(input.dataset.rootDir, input.session.transcriptFile),
    "utf8"
  );
  const utterances = parseTranscriptLines(text, input.session);
  const uploadId = fixtureUploadId(input.session.sessionId);
  let cursor = 0;

  return utterances.map((utterance, index) => {
    const visibleLength = utterance.text.replace(/\s+/gu, "").length;
    const duration = Math.max(MIN_UTTERANCE_SECONDS, visibleLength * SECONDS_PER_HAN_CHARACTER);
    const startSeconds = roundMillis(cursor);
    const endSeconds = roundMillis(startSeconds + duration);
    cursor = endSeconds + INTER_UTTERANCE_GAPS[index % INTER_UTTERANCE_GAPS.length];
    const providerVerifiedGlobalSpeakerId =
      input.dataset.manifest.providerVerifiedSpeakerIdentities?.[utterance.speaker];
    const manualGlobalSpeakerId =
      input.dataset.manifest.manualSpeakerIdentities?.[utterance.speaker];
    const globalSpeakerId =
      providerVerifiedGlobalSpeakerId ?? manualGlobalSpeakerId;

    return TranscriptSegmentSchema.parse({
      id: fixtureSegmentId(input.session.sessionId, index),
      uploadId,
      startSeconds,
      endSeconds,
      speaker: utterance.speaker,
      ...(globalSpeakerId ? {
        identity: providerVerifiedGlobalSpeakerId
          ? {
              globalSpeakerId,
              identityType: "known_contact" as const,
              confidence: null,
              source: "provider_speaker_result" as const,
              evidence: {
                type: "provider_label" as const,
                provider: "company_voiceprint" as const,
                providerLabel: utterance.speaker
              }
            }
          : {
              globalSpeakerId,
              identityType: "known_contact" as const,
              confidence: 1,
              source: "manual_mapping" as const
            }
      } : {}),
      text: utterance.text,
      confidence: 1,
      sceneLabels: ["self_reflection"],
      valueLabels: classifyValueLabels(utterance.text)
    });
  });
}

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TranscriptSegment } from "@/lib/domain/types";
import { dateCompanionParticipantKey } from "@/lib/domain/date-companion-speaker";
import { getFfmpegExecutable } from "@/lib/server/ffmpeg";

import type { DcParticipantAudioSample } from "./types";

const MAX_SPEAKERS = 16;
const MAX_RANGES_PER_SPEAKER = 3;
const MAX_RANGE_MILLISECONDS = 5_000;
const TARGET_SAMPLE_MILLISECONDS = 12_000;
const MIN_RANGE_MILLISECONDS = 400;
const MAX_SAMPLE_BYTES = 2 * 1024 * 1024;
const FFMPEG_TIMEOUT_MILLISECONDS = 30_000;

export type ParticipantAudioRange = {
  startMilliseconds: number;
  endMilliseconds: number;
};

export type GeneratedParticipantAudioSample = DcParticipantAudioSample & {
  sourceRanges: ParticipantAudioRange[];
};

export type ParticipantAudioFfmpegRunner = (input: {
  sourceFilePath: string;
  outputFilePath: string;
  ranges: ParticipantAudioRange[];
}) => Promise<void>;

function candidateRange(segment: TranscriptSegment): ParticipantAudioRange | null {
  const startMilliseconds = Math.max(0, Math.round(segment.startSeconds * 1_000));
  const rawEndMilliseconds = Math.max(0, Math.round(segment.endSeconds * 1_000));
  if (rawEndMilliseconds - startMilliseconds < MIN_RANGE_MILLISECONDS) return null;
  const boundaryTrim = rawEndMilliseconds - startMilliseconds >= 800 ? 100 : 0;
  const start = startMilliseconds + boundaryTrim;
  const end = Math.min(rawEndMilliseconds - boundaryTrim, start + MAX_RANGE_MILLISECONDS);
  return end - start >= MIN_RANGE_MILLISECONDS
    ? { startMilliseconds: start, endMilliseconds: end }
    : null;
}

function sampleRanges(segments: TranscriptSegment[]) {
  const candidates = segments
    .flatMap((segment) => {
      const range = candidateRange(segment);
      return range ? [{ segment, range }] : [];
    })
    .sort((left, right) =>
      (right.range.endMilliseconds - right.range.startMilliseconds)
      - (left.range.endMilliseconds - left.range.startMilliseconds)
      || left.segment.startSeconds - right.segment.startSeconds
      || left.segment.id.localeCompare(right.segment.id)
    );
  const selected: ParticipantAudioRange[] = [];
  let durationMilliseconds = 0;
  for (const candidate of candidates) {
    if (selected.length >= MAX_RANGES_PER_SPEAKER || durationMilliseconds >= TARGET_SAMPLE_MILLISECONDS) break;
    selected.push(candidate.range);
    durationMilliseconds += candidate.range.endMilliseconds - candidate.range.startMilliseconds;
  }
  return {
    ranges: selected.sort((left, right) => left.startMilliseconds - right.startMilliseconds),
    durationMilliseconds
  };
}

function ffmpegFilter(ranges: ParticipantAudioRange[]) {
  const inputs = ranges.map((_range, index) => `[${index}:a]asetpts=PTS-STARTPTS[a${index}]`);
  const streams = ranges.map((_range, index) => `[a${index}]`).join("");
  return `${inputs.join(";")};${streams}concat=n=${ranges.length}:v=0:a=1[out]`;
}

export function participantAudioFfmpegArgs(input: {
  sourceFilePath: string;
  outputFilePath: string;
  ranges: ParticipantAudioRange[];
}) {
  const inputs = input.ranges.flatMap((range) => [
    "-ss",
    (range.startMilliseconds / 1_000).toFixed(3),
    "-t",
    ((range.endMilliseconds - range.startMilliseconds) / 1_000).toFixed(3),
    "-i",
    input.sourceFilePath
  ]);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputs,
    "-filter_complex",
    ffmpegFilter(input.ranges),
    "-map",
    "[out]",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "32k",
    input.outputFilePath
  ];
}

export const runParticipantAudioFfmpeg: ParticipantAudioFfmpegRunner = async (input) => {
  if (input.ranges.length === 0) throw new Error("participant audio requires at least one range");
  const args = participantAudioFfmpegArgs(input);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(getFfmpegExecutable(), args, {
      windowsHide: true,
      timeout: FFMPEG_TIMEOUT_MILLISECONDS,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(
        `participant audio ffmpeg failed with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
      ));
    });
  });
};

export async function buildParticipantAudioSamples(input: {
  uploadId: string;
  sourceFilePath: string;
  segments: TranscriptSegment[];
  participantKey?: (segment: TranscriptSegment) => string | undefined;
  selectionGroupKey?: (segment: TranscriptSegment) => string | undefined;
  runFfmpeg?: ParticipantAudioFfmpegRunner;
}): Promise<GeneratedParticipantAudioSample[]> {
  const groups = new Map<string, TranscriptSegment[]>();
  for (const segment of input.segments) {
    const speakerId = input.participantKey
      ? input.participantKey(segment)
      : dateCompanionParticipantKey(segment);
    if (!speakerId) continue;
    const current = groups.get(speakerId) ?? [];
    current.push(segment);
    groups.set(speakerId, current);
  }
  const representativesBySelectionGroup = new Map<
    string,
    { speakerId: string; segments: TranscriptSegment[] }
  >();
  for (const [speakerId, segments] of [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const selectionKeys = segments.map((segment) => input.selectionGroupKey?.(segment));
    const uniqueSelectionKeys = new Set(selectionKeys.filter(
      (key): key is string => Boolean(key)
    ));
    const selectionGroupKey = selectionKeys.every(Boolean) && uniqueSelectionKeys.size === 1
      ? [...uniqueSelectionKeys][0]
      : speakerId;
    if (!representativesBySelectionGroup.has(selectionGroupKey)) {
      representativesBySelectionGroup.set(selectionGroupKey, { speakerId, segments });
    }
  }
  const selectedGroups = [...representativesBySelectionGroup.values()]
    .slice(0, MAX_SPEAKERS)
    .flatMap(({ speakerId, segments }) => {
      const selected = sampleRanges(segments);
      return selected.ranges.length > 0 ? [{ speakerId, ...selected }] : [];
    });
  if (selectedGroups.length === 0) return [];

  const temporaryRoot = await mkdtemp(join(tmpdir(), "date-companion-audio-"));
  const runFfmpeg = input.runFfmpeg ?? runParticipantAudioFfmpeg;
  const samples: GeneratedParticipantAudioSample[] = [];
  console.info(`[date-companion-audio] progress upload_id=${input.uploadId} completed=0 total=${selectedGroups.length}`);
  try {
    for (const [index, group] of selectedGroups.entries()) {
      const outputFilePath = join(temporaryRoot, `speaker_${index + 1}.mp3`);
      await runFfmpeg({
        sourceFilePath: input.sourceFilePath,
        outputFilePath,
        ranges: group.ranges
      });
      const output = await stat(outputFilePath);
      if (!output.isFile() || output.size <= 0 || output.size > MAX_SAMPLE_BYTES) {
        throw new Error("participant audio output is missing or exceeds the size limit");
      }
      samples.push({
        speakerId: group.speakerId,
        mimeType: "audio/mpeg",
        durationMilliseconds: group.durationMilliseconds,
        audio: new Uint8Array(await readFile(outputFilePath)),
        sourceRanges: group.ranges.map((range) => ({ ...range }))
      });
      console.info(
        `[date-companion-audio] progress upload_id=${input.uploadId} completed=${index + 1} total=${selectedGroups.length}`
      );
    }
    return samples;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export const participantAudioLimits = {
  maxSpeakers: MAX_SPEAKERS,
  maxRangesPerSpeaker: MAX_RANGES_PER_SPEAKER,
  targetSampleMilliseconds: TARGET_SAMPLE_MILLISECONDS,
  maxSampleBytes: MAX_SAMPLE_BYTES,
  ffmpegTimeoutMilliseconds: FFMPEG_TIMEOUT_MILLISECONDS
} as const;

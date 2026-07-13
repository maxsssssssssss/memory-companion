import { execFile } from "child_process";

import {
  classifyPauseFromSilenceRatio,
  classifyVolumeFromDb,
  hasOverlappingSpeech,
  type AcousticSegmentFeature
} from "@/lib/processing/acoustic-features";

import type { TranscriptSegment } from "@/lib/domain/types";
import { getFfmpegExecutable } from "@/lib/server/ffmpeg";

const SILENCE_THRESHOLD_DB = -35;
const MIN_SILENCE_SECONDS = 0.4;

type SilenceInterval = {
  startSeconds: number;
  endSeconds: number;
};

type RmsWindow = {
  startSeconds: number;
  endSeconds: number;
  rmsDb: number;
};

function parseSilenceIntervals(stderr: string, fallbackEndSeconds: number): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  let activeStart: number | null = null;

  stderr.split(/\r?\n/).forEach((line) => {
    const startMatch = /silence_start:\s*(\d+(?:\.\d+)?)/.exec(line);
    if (startMatch) {
      activeStart = Number.parseFloat(startMatch[1]);
    }

    const endMatch = /silence_end:\s*(\d+(?:\.\d+)?)/.exec(line);
    if (endMatch && activeStart !== null) {
      const endSeconds = Number.parseFloat(endMatch[1]);
      if (Number.isFinite(activeStart) && Number.isFinite(endSeconds) && endSeconds > activeStart) {
        intervals.push({ startSeconds: activeStart, endSeconds });
      }
      activeStart = null;
    }
  });

  if (activeStart !== null && fallbackEndSeconds > activeStart) {
    intervals.push({ startSeconds: activeStart, endSeconds: fallbackEndSeconds });
  }

  return intervals;
}

function overlapSeconds(left: SilenceInterval, right: { startSeconds: number; endSeconds: number }) {
  return Math.max(0, Math.min(left.endSeconds, right.endSeconds) - Math.max(left.startSeconds, right.startSeconds));
}

function silenceRatioForSegment(segment: TranscriptSegment, intervals: SilenceInterval[]) {
  const durationSeconds = Math.max(0.1, segment.endSeconds - segment.startSeconds);
  const silentSeconds = intervals.reduce((sum, interval) => sum + overlapSeconds(interval, segment), 0);

  return Math.min(1, silentSeconds / durationSeconds);
}

function parseRmsValue(value: string) {
  const normalizedValue = value.toLowerCase();
  if (normalizedValue === "-inf" || normalizedValue === "-infinity") {
    return -100;
  }
  if (normalizedValue === "inf" || normalizedValue === "infinity" || normalizedValue === "nan") {
    return undefined;
  }

  const rmsDb = Number.parseFloat(value);
  return Number.isFinite(rmsDb) ? rmsDb : undefined;
}

function parseRmsWindows(stderr: string): RmsWindow[] {
  const windows: RmsWindow[] = [];
  let activeStartSeconds: number | null = null;

  stderr.split(/\r?\n/).forEach((line) => {
    const timeMatch = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (timeMatch) {
      activeStartSeconds = Number.parseFloat(timeMatch[1]);
      return;
    }

    const rmsMatch = /lavfi\.astats\.Overall\.RMS_level=(-?(?:\d+(?:\.\d+)?|inf|infinity)|nan)/i.exec(line);
    if (!rmsMatch || activeStartSeconds === null || !Number.isFinite(activeStartSeconds)) {
      return;
    }

    const rmsDb = parseRmsValue(rmsMatch[1]);
    if (rmsDb !== undefined) {
      windows.push({
        startSeconds: activeStartSeconds,
        endSeconds: activeStartSeconds + 1,
        rmsDb
      });
    }
    activeStartSeconds = null;
  });

  return windows;
}

function meanRmsDbForSegment(segment: TranscriptSegment, windows: RmsWindow[]) {
  let totalSeconds = 0;
  let weightedPower = 0;

  windows.forEach((window) => {
    const seconds = overlapSeconds(window, segment);
    if (seconds <= 0) {
      return;
    }

    weightedPower += Math.pow(10, window.rmsDb / 10) * seconds;
    totalSeconds += seconds;
  });

  if (totalSeconds <= 0 || weightedPower <= 0) {
    return undefined;
  }

  return 10 * Math.log10(weightedPower / totalSeconds);
}

function rounded(value: number) {
  return Math.round(value * 10) / 10;
}

function volumeLabel(volume: ReturnType<typeof classifyVolumeFromDb>) {
  if (volume === "high") return "音量更高";
  if (volume === "low") return "音量偏低";
  if (volume === "normal") return "音量正常";
  return "";
}

function pauseLabel(pause: ReturnType<typeof classifyPauseFromSilenceRatio>) {
  if (pause === "many") return "停顿变多";
  if (pause === "few") return "停顿较少";
  if (pause === "normal") return "停顿正常";
  return "";
}

function overlappingSpeakerIds(segment: TranscriptSegment, segments: TranscriptSegment[]) {
  if (!segment.speaker) {
    return [];
  }

  return [
    ...new Set(
      segments
        .filter(
          (other) =>
            other.id !== segment.id &&
            Boolean(other.speaker) &&
            other.speaker !== segment.speaker &&
            other.startSeconds < segment.endSeconds &&
            other.endSeconds > segment.startSeconds
        )
        .map((other) => other.speaker)
        .filter((speaker): speaker is string => Boolean(speaker))
    )
  ];
}

function explanationsForSegment(input: {
  segment: TranscriptSegment;
  segments: TranscriptSegment[];
  meanRmsDb?: number;
  silenceRatio: number;
  confidence: number;
}) {
  const explanations: AcousticSegmentFeature["explanations"] = [];
  const volume = classifyVolumeFromDb(input.meanRmsDb);
  const pause = classifyPauseFromSilenceRatio(input.silenceRatio);

  if (input.meanRmsDb !== undefined && volume !== "unknown") {
    explanations.push({
      kind: "volume",
      label: volumeLabel(volume),
      detail: `这一段平均音量约 ${rounded(input.meanRmsDb)} dBFS，系统因此标记为「${volumeLabel(volume)}」。`,
      confidence: input.confidence
    });
  }

  if (pause !== "unknown") {
    explanations.push({
      kind: "pause",
      label: pauseLabel(pause),
      detail: `静音和停顿占比约 ${Math.round(input.silenceRatio * 100)}%，系统因此标记为「${pauseLabel(pause)}」。`,
      confidence: input.confidence
    });
  }

  const overlapSpeakers = overlappingSpeakerIds(input.segment, input.segments);
  if (overlapSpeakers.length > 0) {
    explanations.push({
      kind: "overlap",
      label: "多人重叠",
      detail: `${input.segment.speaker} 与 ${overlapSpeakers.join("、")} 的转写时间发生重叠。`,
      confidence: input.confidence
    });
  }

  return explanations.filter((explanation) => explanation.label.length > 0);
}

function runFfmpegForAudioStats(filePath: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      getFfmpegExecutable(),
      [
        "-hide_banner",
        "-nostats",
        "-i",
        filePath,
        "-af",
        `silencedetect=n=${SILENCE_THRESHOLD_DB}dB:d=${MIN_SILENCE_SECONDS},aresample=16000,asetnsamples=n=16000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`,
        "-f",
        "null",
        "-"
      ],
      {
        maxBuffer: 1024 * 1024 * 32
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

export async function extractFfmpegAcousticFeatures(input: {
  filePath: string;
  segments: TranscriptSegment[];
}): Promise<AcousticSegmentFeature[]> {
  if (input.segments.length === 0) {
    return [];
  }

  const fallbackEndSeconds = Math.max(...input.segments.map((segment) => segment.endSeconds));
  const { stderr } = await runFfmpegForAudioStats(input.filePath);
  const silenceIntervals = parseSilenceIntervals(stderr, fallbackEndSeconds);
  const rmsWindows = parseRmsWindows(stderr);

  return input.segments.map((segment) => {
    const meanRmsDb = meanRmsDbForSegment(segment, rmsWindows);
    const volume = classifyVolumeFromDb(meanRmsDb);
    const silenceRatio = silenceRatioForSegment(segment, silenceIntervals);
    const confidence = volume === "unknown" && silenceIntervals.length === 0 ? 0.45 : 0.72;

    return {
      segmentId: segment.id,
      volume,
      pause: classifyPauseFromSilenceRatio(silenceRatio),
      overlap: hasOverlappingSpeech(segment, input.segments),
      confidence,
      explanations: explanationsForSegment({
        segment,
        segments: input.segments,
        meanRmsDb,
        silenceRatio,
        confidence
      })
    };
  });
}

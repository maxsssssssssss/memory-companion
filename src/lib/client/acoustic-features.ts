import type { TranscriptSegment } from "@/lib/domain/types";
import {
  classifyPauseFromSilenceRatio,
  classifyVolumeFromDb,
  hasOverlappingSpeech,
  type AcousticSegmentFeature
} from "@/lib/processing/acoustic-features";

const SILENCE_THRESHOLD_DB = -45;
const WINDOW_SECONDS = 0.03;

type DecodeableAudioBuffer = {
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
};

type BrowserAudioContext = {
  decodeAudioData(buffer: ArrayBuffer): Promise<DecodeableAudioBuffer>;
  close?: () => Promise<void> | void;
};

type BrowserAudioContextConstructor = new () => BrowserAudioContext;

function bytesToArrayBuffer(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function audioContextConstructor() {
  const scope = globalThis as typeof globalThis & {
    AudioContext?: BrowserAudioContextConstructor;
    webkitAudioContext?: BrowserAudioContextConstructor;
  };

  return scope.AudioContext ?? scope.webkitAudioContext;
}

function sampleRange(segment: TranscriptSegment, sampleRate: number, totalSamples: number) {
  const startIndex = Math.max(0, Math.min(totalSamples, Math.floor(segment.startSeconds * sampleRate)));
  const endIndex = Math.max(startIndex + 1, Math.min(totalSamples, Math.ceil(segment.endSeconds * sampleRate)));

  return { startIndex, endIndex };
}

function rmsDbForRange(channels: Float32Array[], startIndex: number, endIndex: number) {
  let sumSquares = 0;
  let sampleCount = 0;

  for (let index = startIndex; index < endIndex; index += 1) {
    let mixedSample = 0;
    for (const channel of channels) {
      mixedSample += channel[index] ?? 0;
    }

    mixedSample /= Math.max(1, channels.length);
    sumSquares += mixedSample * mixedSample;
    sampleCount += 1;
  }

  if (sampleCount === 0 || sumSquares === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const rms = Math.sqrt(sumSquares / sampleCount);
  return 20 * Math.log10(Math.max(rms, Number.EPSILON));
}

function silenceRatioForRange(channels: Float32Array[], startIndex: number, endIndex: number, sampleRate: number) {
  const windowSamples = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS));
  let silentSamples = 0;
  let totalSamples = 0;

  for (let windowStart = startIndex; windowStart < endIndex; windowStart += windowSamples) {
    const windowEnd = Math.min(endIndex, windowStart + windowSamples);
    const windowLength = windowEnd - windowStart;
    const windowDb = rmsDbForRange(channels, windowStart, windowEnd);

    if (windowDb <= SILENCE_THRESHOLD_DB) {
      silentSamples += windowLength;
    }
    totalSamples += windowLength;
  }

  return totalSamples > 0 ? silentSamples / totalSamples : undefined;
}

export async function extractBrowserAcousticFeatures(input: {
  bytes: Uint8Array;
  segments: TranscriptSegment[];
}): Promise<AcousticSegmentFeature[]> {
  if (input.segments.length === 0) {
    return [];
  }

  const AudioContextConstructor = audioContextConstructor();
  if (!AudioContextConstructor) {
    return [];
  }

  const audioContext = new AudioContextConstructor();

  try {
    const audioBuffer = await audioContext.decodeAudioData(bytesToArrayBuffer(input.bytes));
    const channelCount = Math.max(1, audioBuffer.numberOfChannels);
    const channels = Array.from({ length: channelCount }, (_item, channelIndex) =>
      audioBuffer.getChannelData(channelIndex)
    );
    const totalSamples = channels[0]?.length ?? Math.round(audioBuffer.duration * audioBuffer.sampleRate);

    return input.segments.map((segment) => {
      const { startIndex, endIndex } = sampleRange(segment, audioBuffer.sampleRate, totalSamples);
      const meanVolumeDb = rmsDbForRange(channels, startIndex, endIndex);
      const silenceRatio = silenceRatioForRange(channels, startIndex, endIndex, audioBuffer.sampleRate);

      return {
        segmentId: segment.id,
        volume: classifyVolumeFromDb(meanVolumeDb),
        pause: classifyPauseFromSilenceRatio(silenceRatio),
        overlap: hasOverlappingSpeech(segment, input.segments),
        confidence: 0.74
      };
    });
  } finally {
    await audioContext.close?.();
  }
}

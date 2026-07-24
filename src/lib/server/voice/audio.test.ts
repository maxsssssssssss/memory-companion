import { describe, expect, it } from "vitest";

import {
  DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT,
  getPcm16DurationMs,
  wrapPcm16LeAsWav
} from "./audio";

function ascii(bytes: Buffer, start: number, length: number) {
  return bytes.subarray(start, start + length).toString("ascii");
}

describe("voice PCM audio helpers", () => {
  it("uses the Volcengine demo default of 24 kHz mono PCM16LE", () => {
    expect(DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT).toEqual({
      encoding: "pcm_s16le",
      sampleRate: 24_000,
      channels: 1
    });
  });

  it("wraps PCM16LE bytes in a standard 44-byte WAV header", () => {
    const pcm = Buffer.from([0x00, 0x00, 0xff, 0x7f]);
    const wav = wrapPcm16LeAsWav(pcm, { sampleRate: 24_000, channels: 1 });

    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.byteLength);
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(28)).toBe(48_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(ascii(wav, 36, 4)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.byteLength);
    expect(wav).toHaveLength(44 + pcm.byteLength);
  });

  it("preserves every raw PCM byte including zero and 0xff values", () => {
    const pcm = Buffer.from([0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0xff]);
    const before = Buffer.from(pcm);
    const wav = wrapPcm16LeAsWav(pcm, { sampleRate: 24_000, channels: 1 });

    expect(wav.subarray(44)).toEqual(before);
    expect(pcm).toEqual(before);
  });

  it("calculates PCM16 duration from bytes, sample rate, and channels", () => {
    const oneSecondMono = Buffer.alloc(24_000 * 2);
    const quarterSecondStereo = Buffer.alloc(12_000 * 2 * 2);

    expect(getPcm16DurationMs(oneSecondMono, { sampleRate: 24_000, channels: 1 })).toBe(1_000);
    expect(getPcm16DurationMs(quarterSecondStereo, { sampleRate: 48_000, channels: 2 })).toBe(250);
  });

  it.each([
    ["an empty payload", Buffer.alloc(0), { sampleRate: 24_000, channels: 1 }, /must not be empty/i],
    ["a zero sample rate", Buffer.alloc(2), { sampleRate: 0, channels: 1 }, /sampleRate/i],
    ["a fractional sample rate", Buffer.alloc(2), { sampleRate: 24_000.5, channels: 1 }, /sampleRate/i],
    ["zero channels", Buffer.alloc(2), { sampleRate: 24_000, channels: 0 }, /channels/i],
    ["fractional channels", Buffer.alloc(2), { sampleRate: 24_000, channels: 1.5 }, /channels/i],
    ["a partial mono sample", Buffer.alloc(3), { sampleRate: 24_000, channels: 1 }, /aligned/i],
    ["a partial stereo frame", Buffer.alloc(6), { sampleRate: 24_000, channels: 2 }, /aligned/i]
  ])("rejects %s", (_caseName, pcm, format, expectedError) => {
    expect(() => wrapPcm16LeAsWav(pcm, format)).toThrow(expectedError);
    expect(() => getPcm16DurationMs(pcm, format)).toThrow(expectedError);
  });

  it("rejects non-Buffer PCM input", () => {
    const bytes = new Uint8Array([0x00, 0x00]);

    expect(() => wrapPcm16LeAsWav(bytes as unknown as Buffer, { sampleRate: 24_000, channels: 1 })).toThrow(
      /Buffer/i
    );
  });
});

import { describe, expect, it } from "vitest";

import { isSupportedAudioUpload, normalizeAudioForTranscription } from "./compat";

function text(bytes: Uint8Array, start: number, length: number) {
  return new TextDecoder().decode(bytes.subarray(start, start + length));
}

function makeDeviceOpusBytes() {
  const packet = new Uint8Array(80);
  packet[0] = 0x4b;
  packet[1] = 0x41;
  const frame = new Uint8Array(8 + packet.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, packet.byteLength, false);
  view.setUint32(4, 0, false);
  frame.set(packet, 8);
  return frame;
}

describe("audio compatibility helpers", () => {
  it("accepts recorder opus and pcm extensions even when the browser sends no useful MIME type", () => {
    expect(isSupportedAudioUpload({ name: "Note-20000105224639.opus", type: "application/octet-stream" })).toBe(true);
    expect(isSupportedAudioUpload({ name: "Note-20000105224639.pcm", type: "" })).toBe(true);
  });

  it("wraps raw 16-bit pcm recorder files as wav", () => {
    const normalized = normalizeAudioForTranscription({
      name: "Note-20000105224639.pcm",
      type: "",
      bytes: new Uint8Array([0x01, 0x00, 0xff, 0x7f])
    });

    expect(normalized.name).toBe("Note-20000105224639.wav");
    expect(normalized.mimeType).toBe("audio/wav");
    expect(normalized.convertedFrom).toBe("raw-pcm");
    expect(text(normalized.bytes, 0, 4)).toBe("RIFF");
    expect(text(normalized.bytes, 8, 4)).toBe("WAVE");
    expect(text(normalized.bytes, 36, 4)).toBe("data");
    expect(new DataView(normalized.bytes.buffer, normalized.bytes.byteOffset, normalized.bytes.byteLength).getUint32(24, true)).toBe(16000);
  });

  it("rewraps device opus packets as standard ogg opus", () => {
    const normalized = normalizeAudioForTranscription({
      name: "Note-20000105224639.opus",
      type: "application/octet-stream",
      bytes: makeDeviceOpusBytes()
    });

    expect(normalized.name).toBe("Note-20000105224639.ogg");
    expect(normalized.mimeType).toBe("audio/ogg");
    expect(normalized.convertedFrom).toBe("device-opus");
    expect(text(normalized.bytes, 0, 4)).toBe("OggS");
    expect(text(normalized.bytes, 28, 8)).toBe("OpusHead");
    expect(text(normalized.bytes, 47, 4)).toBe("OggS");
  });
});

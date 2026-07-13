import { describe, expect, it } from "vitest";
import { validateAudioUpload } from "./validation";

function expectRejected(result: ReturnType<typeof validateAudioUpload>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected upload validation to reject the file.");
  }
  return result;
}

describe("validateAudioUpload", () => {
  function withDefaultMaxUploadBytes(testFn: () => void) {
    const previousMaxUploadBytes = process.env.MAX_UPLOAD_BYTES;
    delete process.env.MAX_UPLOAD_BYTES;

    try {
      testFn();
    } finally {
      if (previousMaxUploadBytes === undefined) {
        delete process.env.MAX_UPLOAD_BYTES;
      } else {
        process.env.MAX_UPLOAD_BYTES = previousMaxUploadBytes;
      }
    }
  }

  it("accepts supported audio under the MVP file limit", () => {
    const result = validateAudioUpload({
      name: "customer-call.m4a",
      type: "audio/mp4",
      size: 1024 * 1024
    });

    expect(result.ok).toBe(true);
  });

  it("accepts recorder opus and pcm files by extension", () => {
    expect(
      validateAudioUpload({
        name: "Note-20000105224639.opus",
        type: "application/octet-stream",
        size: 22 * 1024
      }).ok
    ).toBe(true);
    expect(
      validateAudioUpload({
        name: "Note-20000105224639.pcm",
        type: "",
        size: 645 * 1024
      }).ok
    ).toBe(true);
  });

  it("accepts long recordings over 20 MB by default", () => {
    withDefaultMaxUploadBytes(() => {
      const result = validateAudioUpload({
        name: "two-hour-meeting.mp3",
        type: "audio/mpeg",
        size: 60 * 1024 * 1024
      });

      expect(result.ok).toBe(true);
    });
  });

  it("rejects files over 300 MB by default", () => {
    withDefaultMaxUploadBytes(() => {
      const result = validateAudioUpload({
        name: "all-day.wav",
        type: "audio/wav",
        size: 301 * 1024 * 1024
      });

      expect(expectRejected(result).errorCode).toBe("file_too_large");
    });
  });

  it("rejects empty files", () => {
    const result = validateAudioUpload({
      name: "empty.wav",
      type: "audio/wav",
      size: 0
    });

    expect(expectRejected(result).errorCode).toBe("empty_file");
  });

  it("rejects unsupported MIME types", () => {
    const result = validateAudioUpload({
      name: "notes.txt",
      type: "text/plain",
      size: 1024
    });

    expect(expectRejected(result).errorCode).toBe("unsupported_audio_format");
  });

  it("uses MAX_UPLOAD_BYTES when it is a positive value", () => {
    const previousMaxUploadBytes = process.env.MAX_UPLOAD_BYTES;
    process.env.MAX_UPLOAD_BYTES = String(512);

    try {
      const result = validateAudioUpload({
        name: "short-call.wav",
        type: "audio/wav",
        size: 1024
      });

      expect(expectRejected(result).errorCode).toBe("file_too_large");
    } finally {
      if (previousMaxUploadBytes === undefined) {
        delete process.env.MAX_UPLOAD_BYTES;
      } else {
        process.env.MAX_UPLOAD_BYTES = previousMaxUploadBytes;
      }
    }
  });
});

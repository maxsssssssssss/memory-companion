import { describe, expect, it, vi } from "vitest";
import { createPipelineChildLogForwarder } from "./pipeline-child-log.mjs";

describe("pipeline child log forwarder", () => {
  it("forwards allowlisted pipeline stage lines, including lines split across chunks", () => {
    const write = vi.fn();
    const forwarder = createPipelineChildLogForwarder({ stream: { write } });

    forwarder.push("Next.js ready\n[extrac");
    forwarder.push(
        "tion] chunk started chunk=1/4\n" +
        "[pipeline] brief stored items=7\n" +
        "[audio-insight] provider=deepseek model=deepseek-v4-flash completed=true elapsed_ms=20 fallback=false\n" +
        "[audio-insights] completed count=22 elapsed_ms=15\n" +
        "[ffmpeg-features] completed count=22 elapsed_ms=20\n" +
        "[semantic-segments] completed count=4 elapsed_ms=2\n" +
        "GET / 200\n"
    );

    expect(write.mock.calls.map(([line]) => line)).toEqual([
      "[extraction] chunk started chunk=1/4\n",
      "[pipeline] brief stored items=7\n",
      "[audio-insight] provider=deepseek model=deepseek-v4-flash completed=true elapsed_ms=20 fallback=false\n",
      "[audio-insights] completed count=22 elapsed_ms=15\n",
      "[ffmpeg-features] completed count=22 elapsed_ms=20\n",
      "[semantic-segments] completed count=4 elapsed_ms=2\n"
    ]);
  });

  it("redacts tokens before forwarding an allowlisted line", () => {
    const write = vi.fn();
    const forwarder = createPipelineChildLogForwarder({ stream: { write } });

    forwarder.push("[extraction] failed url=https://example.test/audio?token=secret-token-value\n");

    expect(write).toHaveBeenCalledWith(
      "[extraction] failed url=https://example.test/audio?token=****\n"
    );
  });

  it("redacts access tokens, passwords, and secrets in allowlisted lines", () => {
    const write = vi.fn();
    const forwarder = createPipelineChildLogForwarder({ stream: { write } });

    forwarder.push(
      "[pipeline] auth access_token=access-token-value password=long-password-value secret=long-secret-value\n"
    );

    expect(write).toHaveBeenCalledWith(
      "[pipeline] auth access_token=**** password=**** secret=****\n"
    );
  });
});

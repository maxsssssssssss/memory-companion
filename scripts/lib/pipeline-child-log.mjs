import { redactSensitiveUrl } from "./pipeline-validation.mjs";

const allowedPrefixes = [
  "[pipeline]",
  "[transcription]",
  "[asr-chunks]",
  "[transcript-merge]",
  "[analysis-chunks]",
  "[analysis-parallel]",
  "[audio-insights]",
  "[audio-insight]",
  "[audio insight provider fallback]",
  "[ffmpeg-features]",
  "[emotion-signals]",
  "[semantic-segments]",
  "[extraction]",
  "[relationship-signals]",
  "[relationship signal provider fallback]",
  "[extraction provider fallback]",
  "[memory-index]",
  "[memory-relevance]",
  "[proactive-insights]"
];

function forwardLine(stream, line) {
  const cleanLine = line.replace(/\r$/, "");
  if (!allowedPrefixes.some((prefix) => cleanLine.startsWith(prefix))) {
    return;
  }
  stream.write(`${redactSensitiveUrl(cleanLine)}\n`);
}

export function createPipelineChildLogForwarder({ stream = process.stderr } = {}) {
  let pending = "";

  return {
    push(chunk) {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach((line) => forwardLine(stream, line));
    },
    flush() {
      if (pending) {
        forwardLine(stream, pending);
        pending = "";
      }
    }
  };
}

import { redactSensitiveUrl } from "./pipeline-validation.mjs";

function formatElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatValue(value) {
  return redactSensitiveUrl(String(value));
}

export function formatStageLog({ message, startedAt, now = Date.now(), details = {} }) {
  const elapsed = formatElapsed(now - startedAt);
  const detailText = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");

  return `[validate ${elapsed}] ${message}${detailText ? ` ${detailText}` : ""}`;
}

export function createStageLogger({ stream = process.stderr, startedAt = Date.now(), now = () => Date.now() } = {}) {
  return {
    log(message, details) {
      stream.write(`${formatStageLog({ message, details, startedAt, now: now() })}\n`);
    }
  };
}

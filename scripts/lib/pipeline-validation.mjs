import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const tunnelUrlPattern =
  /https:\/\/[a-z0-9-]+(?:\.trycloudflare\.com|\.ngrok-free\.app|\.ngrok\.app|\.loca\.lt)/i;

export function parseTunnelUrlFromText(text) {
  return text.match(tunnelUrlPattern)?.[0] ?? null;
}

export function redactSensitiveUrl(value) {
  return String(value)
    .replace(/([?&](?:token|access_token|auth_token)=)[^&\s"]+/gi, "$1****")
    .replace(/(Authorization["'\s:=]+)(Bearer\s+)?[A-Za-z0-9._-]{12,}/gi, "$1$2****")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["'\s:=]+)[^\s"',;&]+/gi,
      "$1****"
    );
}

export function loadEnvFile(filePath = path.join(repoRoot, ".env.local")) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) {
          return [];
        }
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return [[match[1], value]];
      })
  );
}

export function firstInviteCode(envValues = loadEnvFile()) {
  return (envValues.DAILY_BRIEF_INVITE_CODES ?? "")
    .split(/[,\n]/)
    .map((code) => code.trim())
    .filter(Boolean)[0];
}

export function unique(items) {
  return [...new Set(items)];
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function summarizeDayPayload(dayPayload) {
  const segments = list(dayPayload?.segments);
  const cards = list(dayPayload?.relationshipSignals);
  const speakers = unique(segments.flatMap((segment) => (segment?.speaker ? [segment.speaker] : [])));

  return {
    uploadStatus: dayPayload?.upload?.status ?? null,
    jobStatus: dayPayload?.job?.status ?? dayPayload?.upload?.status ?? null,
    transcriptSegments: segments.length,
    speakers: speakers.length,
    speakerIds: speakers,
    audioInsights: list(dayPayload?.audioInsights).length,
    semanticSegments: list(dayPayload?.semanticSegments).length,
    briefItems: list(dayPayload?.briefItems).length,
    relationshipSignals: cards.length,
    relationshipSignalsAvailable: Boolean(dayPayload?.relationshipSignalsAvailable),
    cards: cards.map((card) => ({
      signalType: card.signalType,
      signalCategory: card.signalCategory,
      severity: card.severity,
      confidence: card.confidence,
      summary: card.summary,
      caution: card.caution,
      evidence: list(card.evidenceSegments).map((segment) => ({
        segmentId: segment.segmentId,
        speaker: segment.speaker,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        text: segment.text
      }))
    }))
  };
}

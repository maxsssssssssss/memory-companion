import { NextResponse } from "next/server";
import { z } from "zod";

import { DcIdSchema } from "@/lib/domain/date-companion-stage2";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import { dateCompanionAuth } from "@/lib/server/date-companion/http";

export const runtime = "nodejs";

const SpeakerIdSchema = z.string().min(1).max(512);
const SENSITIVE_AUDIO_CACHE_CONTROL = "private, no-store";

type ByteRange = { start: number; end: number };

function parseByteRange(value: string, fileSize: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, fileSize - suffixLength), end: fileSize - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= fileSize
    || requestedEnd < start
  ) return null;
  return { start, end: Math.min(requestedEnd, fileSize - 1) };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ interactionId: string; speakerId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) {
    auth.response.headers.set("Cache-Control", SENSITIVE_AUDIO_CACHE_CONTROL);
    return auth.response;
  }
  const rawParams = await params;
  const interactionId = DcIdSchema.safeParse(rawParams.interactionId);
  const speakerId = SpeakerIdSchema.safeParse(rawParams.speakerId);
  if (!interactionId.success || !speakerId.success) {
    return NextResponse.json(
      { error: "invalid_participant_audio_request" },
      { status: 400, headers: { "Cache-Control": SENSITIVE_AUDIO_CACHE_CONTROL } }
    );
  }
  const sample = getDateCompanionRepository().getParticipantAudioSample(
    auth.authContext.user.id,
    interactionId.data,
    speakerId.data
  );
  if (!sample || sample.audio.byteLength === 0) {
    return NextResponse.json(
      { error: "participant_audio_not_found" },
      { status: 404, headers: { "Cache-Control": SENSITIVE_AUDIO_CACHE_CONTROL } }
    );
  }
  const commonHeaders = {
    "Content-Type": sample.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": SENSITIVE_AUDIO_CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff"
  };
  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, sample.audio.byteLength);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { ...commonHeaders, "Content-Range": `bytes */${sample.audio.byteLength}` }
      });
    }
    const audio = sample.audio.slice(range.start, range.end + 1);
    return new Response(audio, {
      status: 206,
      headers: {
        ...commonHeaders,
        "Content-Length": String(audio.byteLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${sample.audio.byteLength}`
      }
    });
  }
  return new Response(sample.audio, {
    headers: { ...commonHeaders, "Content-Length": String(sample.audio.byteLength) }
  });
}

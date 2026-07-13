import { NextResponse } from "next/server";
import type { AudioInsight, AudioUpload, BriefItem, ProcessingJob, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import {
  ProactiveInsightCacheDocumentSchema,
  proactiveInsightCacheIdForUpload
} from "@/lib/domain/proactive-insights";
import { applyAudioInsightCorrections, type StoredAudioInsightCorrections } from "@/lib/domain/audio-insight-corrections";
import { sanitizeSpeakerAliases, type StoredSpeakerAliases } from "@/lib/domain/speaker-aliases";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";

type StoredUpload = AudioUpload & {
  filePath?: string;
};

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function GET(_request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await params;

  if (!STORE_KEY_PATTERN.test(uploadId)) {
    return NextResponse.json({ error: "invalid_upload_id" }, { status: 400 });
  }

  let authContext;
  try {
    authContext = await requireAuthContext(_request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  const upload = await authContext.store.read<StoredUpload>("uploads", uploadId);
  if (!upload) {
    return NextResponse.json({ error: "upload_not_found" }, { status: 404 });
  }

  const { filePath: _filePath, ...safeUpload } = upload;
  const job = await authContext.store.read<ProcessingJob>("jobs-by-upload", uploadId);
  const segments = (await authContext.store.read<TranscriptSegment[]>("segments", uploadId)) ?? [];
  const storedAudioInsights = (await authContext.store.read<AudioInsight[]>("audio-insights", uploadId)) ?? [];
  const storedAudioInsightCorrections = await authContext.store.read<StoredAudioInsightCorrections>("audio-insight-corrections", uploadId);
  const audioInsights = applyAudioInsightCorrections(storedAudioInsights, storedAudioInsightCorrections?.corrections ?? {});
  const storedSemanticSegments = await authContext.store.read<SemanticSegment[]>("semantic-segments", uploadId);
  const semanticSegments = storedSemanticSegments ?? [];
  const briefItems = (await authContext.store.read<BriefItem[]>("brief-items", uploadId)) ?? [];
  const storedRelationshipSignals = await authContext.store.read<RelationshipSignalCard[]>("relationship-signals", uploadId);
  const relationshipSignals = storedRelationshipSignals ?? [];
  const storedProactiveInsightCache = await authContext.store.read<unknown>(
    "proactive-insights",
    proactiveInsightCacheIdForUpload(uploadId)
  );
  const parsedProactiveInsightCache = ProactiveInsightCacheDocumentSchema.safeParse(storedProactiveInsightCache);
  const proactiveInsights = parsedProactiveInsightCache.success ? parsedProactiveInsightCache.data.items : [];
  const storedSpeakerAliases = await authContext.store.read<StoredSpeakerAliases>("speaker-aliases", uploadId);
  const speakerAliases = sanitizeSpeakerAliases(storedSpeakerAliases?.aliases ?? {});

  return NextResponse.json({
    upload: safeUpload,
    job,
    segments,
    audioInsights,
    semanticSegments,
    semanticSegmentsAvailable: storedSemanticSegments !== null,
    briefItems,
    relationshipSignals,
    relationshipSignalsAvailable: storedRelationshipSignals !== null,
    proactiveInsights,
    proactiveInsightsAvailable: parsedProactiveInsightCache.success,
    speakerAliases,
    speakerAliasesByUploadId: {
      [uploadId]: speakerAliases
    }
  });
}

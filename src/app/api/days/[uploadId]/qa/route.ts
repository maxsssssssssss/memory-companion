import { NextResponse } from "next/server";
import type {
  AudioInsight,
  AudioUpload,
  BriefItem,
  QuestionAnswer,
  RelationshipSignalCard,
  SemanticSegment,
  TranscriptSegment
} from "@/lib/domain/types";
import { applySpeakerAliasesToPayload, sanitizeSpeakerAliases, type StoredSpeakerAliases } from "@/lib/domain/speaker-aliases";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";
import {
  answerQuestionWithAI,
  normalizeQaConversation,
  type AnswerQuestionWithAIInput
} from "@/lib/server/retrieval/ai-qa";
import { qaPromptInstructionFromBody } from "@/lib/server/retrieval/qa-prompt-override";
import {
  acceptsQaBrowserStream,
  createTextQaBrowserStream,
  textQaNdjsonResponse
} from "@/lib/server/retrieval/text-qa-stream";

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

  const answers = (await authContext.store.read<QuestionAnswer[]>("answers-by-upload", uploadId)) ?? [];

  return NextResponse.json({ answers });
}

export async function POST(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await params;

  if (!STORE_KEY_PATTERN.test(uploadId)) {
    return NextResponse.json({ error: "invalid_upload_id" }, { status: 400 });
  }

  let body: { question?: unknown; conversation?: unknown; promptPresetId?: unknown; customPrompt?: unknown };
  try {
    body = (await request.json()) as { question?: unknown; conversation?: unknown; promptPresetId?: unknown; customPrompt?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.question !== "string" || body.question.trim().length === 0) {
    return NextResponse.json({ error: "missing_question" }, { status: 400 });
  }

  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  const upload = await authContext.store.read<AudioUpload>("uploads", uploadId);
  if (!upload) {
    return NextResponse.json({ error: "upload_not_found" }, { status: 404 });
  }
  if (upload.status !== "ready") {
    return NextResponse.json({ error: "upload_not_ready" }, { status: 409 });
  }

  const segments = (await authContext.store.read<TranscriptSegment[]>("segments", uploadId)) ?? [];
  const audioInsights = (await authContext.store.read<AudioInsight[]>("audio-insights", uploadId)) ?? [];
  const semanticSegments = (await authContext.store.read<SemanticSegment[]>("semantic-segments", uploadId)) ?? [];
  const briefItems = (await authContext.store.read<BriefItem[]>("brief-items", uploadId)) ?? [];
  const relationshipSignals =
    (await authContext.store.read<RelationshipSignalCard[]>("relationship-signals", uploadId)) ?? [];
  const storedSpeakerAliases = await authContext.store.read<StoredSpeakerAliases>("speaker-aliases", uploadId);
  const speakerAliases = sanitizeSpeakerAliases(storedSpeakerAliases?.aliases ?? {});
  const aliasedPayload = applySpeakerAliasesToPayload(
    {
      segments,
      audioInsights,
      semanticSegments,
      briefItems
    },
    speakerAliases
  );
  const conversation = normalizeQaConversation(body.conversation);
  const qaPromptInstruction = qaPromptInstructionFromBody(body);
  const qaInput: AnswerQuestionWithAIInput = {
    uploadId,
    question: body.question.trim(),
    scope: "current",
    segments: aliasedPayload.segments,
    audioInsights: aliasedPayload.audioInsights ?? [],
    semanticSegments: aliasedPayload.semanticSegments ?? [],
    briefItems: aliasedPayload.briefItems,
    relationshipSignals,
    settingsStore: authContext.store,
    ...(qaPromptInstruction ? { qaPromptInstruction } : {}),
    ...(conversation.length > 0 ? { conversation } : {})
  };
  const persistAnswer = async (answer: QuestionAnswer) => {
    const answers =
      (await authContext.store.read<QuestionAnswer[]>("answers-by-upload", uploadId)) ?? [];

    await authContext.store.write("answers", answer.id, answer);
    try {
      await authContext.store.write("answers-by-upload", uploadId, [...answers, answer]);
    } catch (error) {
      await authContext.store.delete("answers", answer.id).catch(() => undefined);
      throw error;
    }
  };

  if (acceptsQaBrowserStream(request)) {
    return textQaNdjsonResponse(
      createTextQaBrowserStream({
        input: qaInput,
        onFinal: async (event) => {
          await persistAnswer(event.answer);
        }
      })
    );
  }

  const answer = await answerQuestionWithAI(qaInput);
  await persistAnswer(answer);

  return NextResponse.json(answer);
}

import { NextResponse } from "next/server";
import type { QuestionAnswer } from "@/lib/domain/types";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";
import { answerMemoryScopeQuestion, currentWeekRange, dateFromKey, formatDateKey, isUploadInRange } from "@/lib/server/retrieval/memory-scope-qa";
import { normalizeQaConversation } from "@/lib/server/retrieval/ai-qa";
import { qaPromptInstructionFromBody } from "@/lib/server/retrieval/qa-prompt-override";

async function parseQaBody(request: Request) {
  try {
    const body = (await request.json()) as {
      question?: unknown;
      conversation?: unknown;
      referenceDate?: unknown;
      promptPresetId?: unknown;
      customPrompt?: unknown;
    };
    return {
      question: typeof body.question === "string" ? body.question.trim() : "",
      conversation: normalizeQaConversation(body.conversation),
      referenceDate: body.referenceDate,
      qaPromptInstruction: qaPromptInstructionFromBody(body)
    };
  } catch {
    return null;
  }
}

function parseReferenceDate(request?: Request, bodyReferenceDate?: unknown) {
  const queryReferenceDate = request ? new URL(request.url).searchParams.get("referenceDate") : null;
  const rawReferenceDate = queryReferenceDate ?? (typeof bodyReferenceDate === "string" ? bodyReferenceDate : "");
  const referenceDate = rawReferenceDate.trim();

  if (!referenceDate) {
    return { date: undefined, invalid: false };
  }

  const parsedDate = dateFromKey(referenceDate);
  if (!parsedDate || formatDateKey(parsedDate) !== referenceDate) {
    return { date: undefined, invalid: true };
  }

  return { date: parsedDate, invalid: false };
}

export async function POST(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  const parsed = await parseQaBody(request);

  if (parsed === null) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!parsed.question) {
    return NextResponse.json({ error: "missing_question" }, { status: 400 });
  }

  const referenceDate = parseReferenceDate(request, parsed.referenceDate);
  if (referenceDate.invalid) {
    return NextResponse.json({ error: "invalid_reference_date" }, { status: 400 });
  }

  const weekRange = currentWeekRange(referenceDate.date);
  const answer = await answerMemoryScopeQuestion({
    scopeId: weekRange.scopeId,
    question: parsed.question,
    qaScope: "week",
    userId: authContext.user.id,
    shadowDateRange: { startDate: weekRange.startKey, endDate: weekRange.endKey },
    store: authContext.store,
    ...(parsed.qaPromptInstruction ? { qaPromptInstruction: parsed.qaPromptInstruction } : {}),
    includeUpload: (upload) => isUploadInRange(upload, weekRange.start, weekRange.end),
    ...(parsed.conversation.length > 0 ? { conversation: parsed.conversation } : {})
  });

  if (!answer) {
    return NextResponse.json({ error: "week_memory_not_found" }, { status: 404 });
  }

  return NextResponse.json(answer);
}

export async function GET(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  const referenceDate = parseReferenceDate(request);
  if (referenceDate.invalid) {
    return NextResponse.json({ error: "invalid_reference_date" }, { status: 400 });
  }

  const weekRange = currentWeekRange(referenceDate.date);
  const answers = await authContext.store.read<QuestionAnswer[]>("answers-by-scope", weekRange.scopeId);

  return NextResponse.json({ answers: answers ?? [] });
}

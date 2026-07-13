import { NextResponse } from "next/server";
import type { QuestionAnswer } from "@/lib/domain/types";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";
import { answerMemoryScopeQuestion } from "@/lib/server/retrieval/memory-scope-qa";
import { normalizeQaConversation } from "@/lib/server/retrieval/ai-qa";
import { qaPromptInstructionFromBody } from "@/lib/server/retrieval/qa-prompt-override";

const ALL_MEMORY_SCOPE_ID = "all_memory";

async function parseQaBody(request: Request) {
  try {
    const body = (await request.json()) as { question?: unknown; conversation?: unknown; promptPresetId?: unknown; customPrompt?: unknown };
    return {
      question: typeof body.question === "string" ? body.question.trim() : "",
      conversation: normalizeQaConversation(body.conversation),
      qaPromptInstruction: qaPromptInstructionFromBody(body)
    };
  } catch {
    return null;
  }
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

  const answer = await answerMemoryScopeQuestion({
    scopeId: ALL_MEMORY_SCOPE_ID,
    question: parsed.question,
    qaScope: "all",
    userId: authContext.user.id,
    store: authContext.store,
    ...(parsed.qaPromptInstruction ? { qaPromptInstruction: parsed.qaPromptInstruction } : {}),
    ...(parsed.conversation.length > 0 ? { conversation: parsed.conversation } : {})
  });

  if (!answer) {
    return NextResponse.json({ error: "all_memory_not_found" }, { status: 404 });
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

  const answers = await authContext.store.read<QuestionAnswer[]>("answers-by-scope", ALL_MEMORY_SCOPE_ID);

  return NextResponse.json({ answers: answers ?? [] });
}

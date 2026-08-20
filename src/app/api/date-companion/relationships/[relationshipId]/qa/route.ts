import { NextResponse } from "next/server";
import { z } from "zod";

import { DcIdSchema } from "@/lib/domain/date-companion-stage2";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse,
  readJson
} from "@/lib/server/date-companion/http";
import { buildDateCompanionRelationshipQaInput } from "@/lib/server/date-companion/relationship-qa";
import {
  answerQuestionWithAI,
  normalizeQaConversation
} from "@/lib/server/retrieval/ai-qa";
import {
  acceptsQaBrowserStream,
  createTextQaBrowserStream,
  textQaNdjsonResponse
} from "@/lib/server/retrieval/text-qa-stream";

export const runtime = "nodejs";

const RelationshipQaRequestSchema = z.object({
  question: z.string().trim().min(1).max(4_000),
  conversation: z.unknown().optional()
}).strict();

function privateNoStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ relationshipId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return auth.response;

  const relationshipId = DcIdSchema.safeParse((await params).relationshipId);
  if (!relationshipId.success) {
    return NextResponse.json({ error: "invalid_relationship_id" }, { status: 400 });
  }

  const body = await readJson(request);
  if ("response" in body) return body.response;
  const parsedBody = RelationshipQaRequestSchema.safeParse(body.value);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "invalid_relationship_qa_request" }, { status: 400 });
  }

  try {
    const repository = getDateCompanionRepository();
    const view = repository.getRelationshipView(
      auth.authContext.user.id,
      relationshipId.data
    );
    const qaInput = buildDateCompanionRelationshipQaInput({
      userId: auth.authContext.user.id,
      relationshipId: relationshipId.data,
      question: parsedBody.data.question,
      conversation: normalizeQaConversation(parsedBody.data.conversation),
      settingsStore: auth.authContext.store,
      view
    });

    if (acceptsQaBrowserStream(request)) {
      return privateNoStore(textQaNdjsonResponse(
        createTextQaBrowserStream({ input: qaInput })
      ));
    }

    return privateNoStore(NextResponse.json(await answerQuestionWithAI(qaInput)));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateNoStore(response);
    throw error;
  }
}

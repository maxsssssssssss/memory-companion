import { NextResponse } from "next/server";
import { z } from "zod";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getRelationshipContextBuilder,
  PersonRepositoryError
} from "@/lib/server/person";
import {
  answerPersonRelationshipQuestion,
  answerPersonRelationshipQuestionStream,
  buildPersonRelationshipQaInput,
  personRelationshipQaSafeUncertaintyAnswer,
  personRelationshipQaSafeUncertaintyStream
} from "@/lib/server/person/person-relationship-qa";
import { resolveProductionTrustedPersonQaEvidence } from "@/lib/server/person/person-relationship-qa-evidence-resolver";
import { normalizeQaConversation } from "@/lib/server/retrieval/ai-qa";
import { DcIdSchema } from "@/lib/domain/date-companion-stage2";
import { openDateCompanionPersonQaScope } from "@/lib/server/date-companion/person-qa-scope";
import { PriorCitationsSchema, verifiedPriorSources } from "@/lib/server/date-companion/qa-prior-sources";
import { QaTurnError } from "@/lib/server/retrieval/qa-provider";
import {
  acceptsQaBrowserStream,
  createTextQaBrowserStream,
  textQaNdjsonResponse
} from "@/lib/server/retrieval/text-qa-stream";

export const runtime = "nodejs";

const PersonIdSchema = z.string().trim().min(1).max(512).regex(/^[^\s]+$/u);
const PersonQaRequestSchema = z.object({
  question: z.string().trim().min(1).max(4_000),
  conversation: z.unknown().optional(),
  scope: z.object({
    type: z.literal("date_companion_relationship"),
    relationshipId: DcIdSchema,
    mappingVersion: z.number().int().positive(),
    withdrawalVersion: z.string().uuid().optional()
  }).strict().optional(),
  priorCitations: PriorCitationsSchema.optional()
}).strict();

function privateNoStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function json(body: unknown, init?: ResponseInit) {
  return privateNoStore(NextResponse.json(body, init));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ personId: string }> }
) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return privateNoStore(unauthorizedResponse());
    }
    throw error;
  }

  const personId = PersonIdSchema.safeParse((await params).personId);
  if (!personId.success) {
    return json({ error: "invalid_person_id" }, { status: 400 });
  }

  let sourceContext;
  try {
    sourceContext = getRelationshipContextBuilder().buildRelationshipContext({
      accountId: authContext.user.id,
      personId: personId.data
    });
  } catch (error) {
    if (error instanceof PersonRepositoryError) {
      return json({ error: "invalid_person_id" }, { status: 400 });
    }
    throw error;
  }
  if (!sourceContext.person) {
    return json({ error: "person_not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_person_qa_request" }, { status: 400 });
  }
  const parsedBody = PersonQaRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return json({ error: "invalid_person_qa_request" }, { status: 400 });
  }

  let scope;
  if (parsedBody.data.scope) {
    try {
      scope = openDateCompanionPersonQaScope({
        ...parsedBody.data.scope, accountId: authContext.user.id, personId: personId.data
      });
    } catch (error) {
      if (error instanceof QaTurnError) return json({ error: error.code }, { status: 409 });
      throw error;
    }
  }
  const qaInput = await buildPersonRelationshipQaInput({
    userId: authContext.user.id,
    personId: personId.data,
    question: parsedBody.data.question,
    conversation: scope ? [] : normalizeQaConversation(parsedBody.data.conversation),
    ...(scope ? { admitsEvidence: scope.includes } : {}),
    settingsStore: authContext.store,
    sourceContext,
    trustedEvidenceResolver: input => resolveProductionTrustedPersonQaEvidence({
      ...input, relationshipId: parsedBody.data.scope?.relationshipId
    })
  });

  const acceptsStream = acceptsQaBrowserStream(request);
  const eligibleSourceSegmentIds = qaInput.segments.map((segment) => segment.id);
  if (scope) {
    const grant = scope;
    qaInput.conversation = verifiedPriorSources(qaInput.segments, parsedBody.data.priorCitations ?? [], grant.matchesRevision, grant.requiresRevision);
    qaInput.assertSourceScope = () => grant.assertCurrent(eligibleSourceSegmentIds);
    qaInput.disableHybridRetrieval = true;
    qaInput.includeCitationKind = true;
    qaInput.requireExplicitRetry = true;
    qaInput.signal = request.signal;
    try {
      qaInput.assertSourceScope();
    } catch (error) {
      if (error instanceof QaTurnError) return json({ error: error.code }, { status: 409 });
      throw error;
    }
  }
  if (qaInput.segments.length === 0) {
    if (acceptsStream) {
      return privateNoStore(textQaNdjsonResponse(
        createTextQaBrowserStream({
          input: qaInput,
          dependencies: {
            answerQuestionStream: personRelationshipQaSafeUncertaintyStream
          }
        })
      ));
    }
    return json(personRelationshipQaSafeUncertaintyAnswer(qaInput));
  }

  if (acceptsStream) {
    return privateNoStore(textQaNdjsonResponse(
      createTextQaBrowserStream({
        input: qaInput,
        dependencies: {
          answerQuestionStream: (input) => answerPersonRelationshipQuestionStream(
            input,
            eligibleSourceSegmentIds
          )
        }
      })
    ));
  }

  try {
    const answer = await answerPersonRelationshipQuestion(qaInput, eligibleSourceSegmentIds);
    qaInput.assertSourceScope?.();
    return json(answer);
  } catch (error) {
    if (error instanceof QaTurnError && error.code === "qa_scope_changed") return json({ error: error.code }, { status: 409 });
    if (scope) return json({ error: "qa_provider_failed" }, { status: 502 });
    throw error;
  }
}

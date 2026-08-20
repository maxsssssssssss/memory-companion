import { DcIdSchema } from "@/lib/domain/date-companion-stage2";
import {
  createDateCompanionMemoryBridgeRepository,
  getDateCompanionDatabase,
  validateMemoryBridgePersonMapping
} from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse,
  readJson
} from "@/lib/server/date-companion/http";
import {
  DateCompanionPersonMappingRequestSchema,
  privateMemoryJson,
  privateMemoryResponse
} from "@/lib/server/date-companion/memory-bridge-api";
import { getMemoryDatabase } from "@/lib/server/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function relationshipId(params: Promise<{ relationshipId: string }>) {
  return DcIdSchema.safeParse((await params).relationshipId);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ relationshipId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return privateMemoryResponse(auth.response);
  const id = await relationshipId(params);
  if (!id.success) return privateMemoryJson({ error: "invalid_relationship_id" }, 400);
  try {
    const mapping = createDateCompanionMemoryBridgeRepository(getDateCompanionDatabase())
      .getPersonMapping(auth.authContext.user.id, id.data);
    return privateMemoryJson({ mapping });
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateMemoryResponse(response);
    throw error;
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ relationshipId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return privateMemoryResponse(auth.response);
  const id = await relationshipId(params);
  if (!id.success) return privateMemoryJson({ error: "invalid_relationship_id" }, 400);
  const raw = await readJson(request);
  if ("response" in raw && raw.response) return privateMemoryResponse(raw.response);
  const body = DateCompanionPersonMappingRequestSchema.safeParse(raw.value);
  if (!body.success) return privateMemoryJson({ error: "invalid_person_mapping_request" }, 400);
  try {
    validateMemoryBridgePersonMapping({
      memoryDatabase: getMemoryDatabase(),
      accountId: auth.authContext.user.id,
      selfPersonId: body.data.selfPersonId,
      companionPersonId: body.data.companionPersonId
    });
    const mapping = createDateCompanionMemoryBridgeRepository(getDateCompanionDatabase())
      .putPersonMapping({
        userId: auth.authContext.user.id,
        relationshipId: id.data,
        ...body.data
      });
    return privateMemoryJson({ mapping });
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateMemoryResponse(response);
    throw error;
  }
}

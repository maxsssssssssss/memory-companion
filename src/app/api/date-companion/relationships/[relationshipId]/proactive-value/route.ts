import {
  DateCompanionProactiveValueResponseSchema
} from "@/lib/domain/date-companion-proactive-value";
import { DcIdSchema } from "@/lib/domain/date-companion-stage2";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse
} from "@/lib/server/date-companion/http";
import {
  privateMemoryJson,
  privateMemoryResponse
} from "@/lib/server/date-companion/memory-bridge-api";
import { getDateCompanionProactiveValueService } from "@/lib/server/date-companion/proactive-value";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ relationshipId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return privateMemoryResponse(auth.response);
  const relationshipId = DcIdSchema.safeParse((await params).relationshipId);
  if (!relationshipId.success) return privateMemoryJson({ error: "invalid_relationship_id" }, 400);
  try {
    const value = await getDateCompanionProactiveValueService().getPersonRelationship({
      accountId: auth.authContext.user.id,
      relationshipId: relationshipId.data
    });
    return privateMemoryJson(DateCompanionProactiveValueResponseSchema.parse(value));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateMemoryResponse(response);
    throw error;
  }
}

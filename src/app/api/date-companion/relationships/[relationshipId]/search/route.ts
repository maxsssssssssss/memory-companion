import { z } from "zod";

import {
  DcIdSchema,
  DcSearchResponseSchema
} from "@/lib/domain/date-companion-stage2";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse
} from "@/lib/server/date-companion/http";
import {
  privateMemoryJson,
  privateMemoryResponse
} from "@/lib/server/date-companion/memory-bridge-api";
import { resolveProductionDateCompanionPersonSourceCatalog } from "@/lib/server/date-companion/person-source-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const QuerySchema = z.string().trim().min(1).max(120);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ relationshipId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return privateMemoryResponse(auth.response);
  const relationshipId = DcIdSchema.safeParse((await params).relationshipId);
  const query = QuerySchema.safeParse(new URL(request.url).searchParams.get("q"));
  if (!relationshipId.success || !query.success) {
    return privateMemoryJson({ error: "invalid_search_request" }, 400);
  }
  try {
    const catalog = resolveProductionDateCompanionPersonSourceCatalog({
      accountId: auth.authContext.user.id,
      relationshipId: relationshipId.data
    });
    const results = catalog.status === "ready"
      && catalog.mappingVersion !== null
      && catalog.companionPersonId !== null
      ? getDateCompanionRepository().searchPersonProjection(
          auth.authContext.user.id,
          relationshipId.data,
          query.data,
          catalog.sources.map((source) => source.evidenceSnapshotId),
          {
            version: catalog.mappingVersion,
            companionPersonId: catalog.companionPersonId
          }
        )
      : [];
    return privateMemoryJson(DcSearchResponseSchema.parse({ results }));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateMemoryResponse(response);
    throw error;
  }
}

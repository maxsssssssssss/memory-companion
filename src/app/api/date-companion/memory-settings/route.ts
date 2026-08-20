import {
  createDateCompanionMemoryBridgeRepository,
  getDateCompanionDatabase
} from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse,
  readJson
} from "@/lib/server/date-companion/http";
import {
  DateCompanionMemorySettingRequestSchema,
  privateMemoryJson,
  privateMemoryResponse
} from "@/lib/server/date-companion/memory-bridge-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return privateMemoryResponse(auth.response);
  const setting = createDateCompanionMemoryBridgeRepository(getDateCompanionDatabase())
    .getRetentionSetting(auth.authContext.user.id);
  return privateMemoryJson({ setting });
}

export async function PUT(request: Request) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return privateMemoryResponse(auth.response);
  const raw = await readJson(request);
  if ("response" in raw && raw.response) return privateMemoryResponse(raw.response);
  const body = DateCompanionMemorySettingRequestSchema.safeParse(raw.value);
  if (!body.success) return privateMemoryJson({ error: "invalid_memory_setting_request" }, 400);
  try {
    const setting = createDateCompanionMemoryBridgeRepository(getDateCompanionDatabase())
      .putRetentionSetting({ userId: auth.authContext.user.id, ...body.data });
    return privateMemoryJson({ setting });
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateMemoryResponse(response);
    throw error;
  }
}

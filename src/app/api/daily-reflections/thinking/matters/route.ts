import { getThinkingAgentService } from "@/lib/server/daily-reflection/thinking-agent-service";
import { thinkingJson, thinkingRequest } from "./http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return thinkingRequest(request, async accountId => thinkingJson({ matters: await getThinkingAgentService().list(accountId) }));
}
export async function POST(request: Request) {
  return thinkingRequest(request, async accountId => {
    const service = getThinkingAgentService(), created = service.create(accountId, await request.json());
    return thinkingJson(await service.get(accountId, created.matter.id), 201);
  });
}

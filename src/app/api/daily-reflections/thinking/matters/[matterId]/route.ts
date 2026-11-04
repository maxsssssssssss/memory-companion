import { z } from "zod";
import { ThinkingMatterPublicTurnSchema, ThinkingMatterPublicMutationSchema, ThinkingMatterLinkCardSchema, ThinkingMatterUnlinkCardSchema } from "@/lib/server/daily-reflection/thinking-agent";
import { getThinkingAgentService } from "@/lib/server/daily-reflection/thinking-agent-service";
import { thinkingJson, thinkingRequest } from "../http";

export const runtime = "nodejs";
const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u);
type Context = { params: Promise<{ matterId: string }> };
// task IDs, derived feedback transitions and generation bindings are server-owned.
export async function GET(request: Request, context: Context) {
  return thinkingRequest(request, async accountId => {
    const id = Id.parse((await context.params).matterId), service = getThinkingAgentService();
    return thinkingJson({ ...await service.get(accountId, id), task: service.task(accountId, id) });
  });
}
export async function POST(request: Request, context: Context) {
  return thinkingRequest(request, async accountId => {
    const id = Id.parse((await context.params).matterId);
    const payload = z.object({ action: z.enum(["turn", "mutate", "recover", "link_card", "unlink_card"]) }).passthrough().parse(await request.json());
    const { action, ...body } = payload;
    const service = getThinkingAgentService();
    if (action === "turn") await service.turn(accountId, id, ThinkingMatterPublicTurnSchema.parse(body), request.signal);
    else if (action === "link_card") service.linkCard(accountId, id, ThinkingMatterLinkCardSchema.parse(body));
    else if (action === "unlink_card") service.unlinkCard(accountId, id, ThinkingMatterUnlinkCardSchema.parse(body));
    else if (action === "recover") {
      const input = z.object({ operationKey: z.string().trim().min(1).max(512) }).strict().parse(body);
      await service.recover(accountId, id, input.operationKey);
    }
    else service.mutate(accountId, id, ThinkingMatterPublicMutationSchema.parse(body));
    return thinkingJson({ ...await service.get(accountId, id), task: service.task(accountId, id) });
  });
}

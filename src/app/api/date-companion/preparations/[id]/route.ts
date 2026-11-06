import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AgentFailure } from "@/lib/server/agent/types";
import { dateCompanionAuth, dateCompanionErrorResponse, readJson } from "@/lib/server/date-companion/http";
import { getPreparationAgentService } from "@/lib/server/date-companion/preparation-service";
export const runtime = "nodejs";
const json = (value: unknown) => NextResponse.json(value, { headers: { "Cache-Control": "private, no-store" } });
function failure(error: unknown) {
  if (error instanceof ZodError)
    return NextResponse.json({ error: "invalid_preparation_request" }, { status: 400 });
  if (error instanceof AgentFailure)
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.code === "forbidden" ? 403 : 409 });
  return dateCompanionErrorResponse(error) ?? NextResponse.json({ error: "preparation_unavailable" }, { status: 500 });
}
type Context = {
  params: Promise<{
    id: string;
  }>;
};
export async function GET(request: Request, context: Context) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth)
    return auth.response;
  try {
    return json({ view: getPreparationAgentService().get(auth.authContext.user.id, (await context.params).id) });
  }
  catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request, context: Context) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth)
    return auth.response;
  const raw = await readJson(request);
  if ("response" in raw && raw.response)
    return raw.response;
  try {
    return json({ view: getPreparationAgentService().mutate(auth.authContext.user.id, (await context.params).id, raw.value) });
  }
  catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth)
    return auth.response;
  const raw = await readJson(request);
  if ("response" in raw && raw.response)
    return raw.response;
  try {
    getPreparationAgentService().delete(auth.authContext.user.id, (await context.params).id, raw.value);
    return json({ deleted: true });
  }
  catch (error) {
    return failure(error);
  }
}

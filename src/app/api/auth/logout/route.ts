import { NextResponse } from "next/server";
import { clearSessionCookieHeader, deleteSessionForRequest } from "@/lib/server/auth/session";

export async function POST(request: Request) {
  await deleteSessionForRequest(request);
  const response = NextResponse.json({ ok: true });
  response.headers.append("set-cookie", clearSessionCookieHeader());
  return response;
}

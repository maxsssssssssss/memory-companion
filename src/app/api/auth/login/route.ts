import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateUser, createAuthenticatedSession, sessionCookieHeader } from "@/lib/server/auth/session";

const LoginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsedBody = LoginBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "invalid_login_input" }, { status: 400 });
  }

  try {
    const user = await authenticateUser(parsedBody.data);
    const session = await createAuthenticatedSession(user.id);
    const response = NextResponse.json({ user });
    response.headers.append("set-cookie", sessionCookieHeader(session.token));
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_credentials") {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    throw error;
  }
}

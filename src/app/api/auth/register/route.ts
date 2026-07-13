import { NextResponse } from "next/server";
import { z } from "zod";
import { createAuthenticatedSession, createUser, sessionCookieHeader } from "@/lib/server/auth/session";

const RegisterBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().trim().max(80).optional(),
  inviteCode: z.string().trim().max(200).optional()
});

function configuredInviteCodes() {
  return (process.env.DAILY_BRIEF_INVITE_CODES ?? "")
    .split(/[\n,]/)
    .map((code) => code.trim())
    .filter(Boolean);
}

function isValidInviteCode(inviteCode: string | undefined) {
  const inviteCodes = configuredInviteCodes();

  if (inviteCodes.length === 0) {
    return { ok: false as const, error: "invite_not_configured" };
  }

  if (!inviteCode || !inviteCodes.includes(inviteCode.trim())) {
    return { ok: false as const, error: "invalid_invite_code" };
  }

  return { ok: true as const };
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsedBody = RegisterBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "invalid_register_input" }, { status: 400 });
  }

  const inviteValidation = isValidInviteCode(parsedBody.data.inviteCode);
  if (!inviteValidation.ok) {
    return NextResponse.json(
      { error: inviteValidation.error },
      { status: inviteValidation.error === "invite_not_configured" ? 503 : 403 }
    );
  }

  try {
    const user = await createUser({
      email: parsedBody.data.email,
      password: parsedBody.data.password,
      ...(parsedBody.data.name ? { name: parsedBody.data.name } : {})
    });
    const session = await createAuthenticatedSession(user.id);
    const response = NextResponse.json({ user }, { status: 201 });
    response.headers.append("set-cookie", sessionCookieHeader(session.token));
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "user_exists") {
      return NextResponse.json({ error: "user_exists" }, { status: 409 });
    }

    throw error;
  }
}

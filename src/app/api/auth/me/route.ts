import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/server/auth/session";

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  return NextResponse.json({ user });
}

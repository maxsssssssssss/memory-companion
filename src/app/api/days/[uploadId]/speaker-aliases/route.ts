import { NextResponse } from "next/server";

import { sanitizeSpeakerAliases, type StoredSpeakerAliases } from "@/lib/domain/speaker-aliases";
import type { AudioUpload } from "@/lib/domain/types";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse, type AuthContext } from "@/lib/server/auth/request-context";

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

async function requireUploadScopedStore(request: Request, uploadId: string): Promise<{ authContext: AuthContext } | { response: Response }> {
  if (!STORE_KEY_PATTERN.test(uploadId)) {
    return { response: NextResponse.json({ error: "invalid_upload_id" }, { status: 400 }) };
  }

  try {
    const authContext = await requireAuthContext(request);
    const upload = await authContext.store.read<AudioUpload>("uploads", uploadId);

    if (!upload) {
      return { response: NextResponse.json({ error: "upload_not_found" }, { status: 404 }) };
    }

    return { authContext };
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return { response: unauthorizedResponse() };
    }
    throw error;
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await params;
  const result = await requireUploadScopedStore(request, uploadId);

  if ("response" in result) {
    return result.response;
  }

  const storedAliases = await result.authContext.store.read<StoredSpeakerAliases>("speaker-aliases", uploadId);

  return NextResponse.json({ aliases: sanitizeSpeakerAliases(storedAliases?.aliases ?? {}) });
}

export async function PUT(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await params;
  const result = await requireUploadScopedStore(request, uploadId);

  if ("response" in result) {
    return result.response;
  }

  let body: { aliases?: unknown };
  try {
    body = (await request.json()) as { aliases?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const aliases = sanitizeSpeakerAliases(body.aliases ?? {});

  await result.authContext.store.write("speaker-aliases", uploadId, {
    aliases,
    updatedAt: new Date().toISOString()
  });

  return NextResponse.json({ aliases });
}

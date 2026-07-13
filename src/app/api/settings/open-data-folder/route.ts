import { execFile } from "child_process";
import { mkdir } from "fs/promises";
import { resolve } from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";
import { getProviderSettingsView } from "@/lib/server/settings/provider-config";

const execFileAsync = promisify(execFile);

export async function POST(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  const dataDirectory = resolve(authContext.dataRootDir);
  const settings = await getProviderSettingsView(authContext.store, {
    dataDirectory,
    uploadsDirectory: resolve(authContext.uploadsRootDir),
    apiKeyStoragePath: resolve(authContext.dataRootDir, "settings", "provider-config.json")
  });
  if (!settings.canOpenDataFolder) {
    return NextResponse.json({ error: "open_data_folder_unavailable" }, { status: 400 });
  }

  await mkdir(dataDirectory, { recursive: true });
  await execFileAsync("open", [dataDirectory]);

  return NextResponse.json({
    opened: true,
    dataDirectory
  });
}

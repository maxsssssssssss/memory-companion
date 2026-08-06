import { isAbsolute, join, resolve } from "path";

export type StorageMode = "local" | "server";

const DEFAULT_DATA_DIR = ".data";

function normalizeEnvString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getDataRootDir(
  env: Record<string, string | undefined> = process.env
) {
  return normalizeEnvString(env.APP_DATA_DIR) ?? normalizeEnvString(env.DATA_DIR) ?? DEFAULT_DATA_DIR;
}

export function getUploadsRootDir() {
  return join(getDataRootDir(), "uploads");
}

export function getStorageMode(
  env: Record<string, string | undefined> = process.env
): StorageMode {
  return env.APP_STORAGE_MODE === "server" ? "server" : "local";
}

/**
 * Queue mode crosses the Web/Worker process boundary. It must never silently
 * fall back to a process-local relative `.data` directory.
 */
export function requireQueueStorageConfiguration(
  env: Record<string, string | undefined> = process.env
) {
  const configuredDataDirectory = normalizeEnvString(env.APP_DATA_DIR);
  if (!configuredDataDirectory || !isAbsolute(configuredDataDirectory)) {
    throw new Error("Queue mode requires APP_DATA_DIR to be an absolute path");
  }
  if (env.APP_STORAGE_MODE?.trim().toLowerCase() !== "server") {
    throw new Error("Queue mode requires APP_STORAGE_MODE=server");
  }
  return {
    dataDirectory: resolve(configuredDataDirectory),
    storageMode: "server" as const
  };
}

export function getResolvedStoragePaths() {
  const dataDirectory = resolve(getDataRootDir());

  return {
    dataDirectory,
    uploadsDirectory: resolve(dataDirectory, "uploads"),
    apiKeyStoragePath: resolve(dataDirectory, "settings", "provider-config.json")
  };
}

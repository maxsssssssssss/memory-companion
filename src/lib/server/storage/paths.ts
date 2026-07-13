import { join, resolve } from "path";

export type StorageMode = "local" | "server";

const DEFAULT_DATA_DIR = ".data";

function normalizeEnvString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getDataRootDir() {
  return normalizeEnvString(process.env.APP_DATA_DIR) ?? normalizeEnvString(process.env.DATA_DIR) ?? DEFAULT_DATA_DIR;
}

export function getUploadsRootDir() {
  return join(getDataRootDir(), "uploads");
}

export function getStorageMode(): StorageMode {
  return process.env.APP_STORAGE_MODE === "server" ? "server" : "local";
}

export function getResolvedStoragePaths() {
  const dataDirectory = resolve(getDataRootDir());

  return {
    dataDirectory,
    uploadsDirectory: resolve(dataDirectory, "uploads"),
    apiKeyStoragePath: resolve(dataDirectory, "settings", "provider-config.json")
  };
}

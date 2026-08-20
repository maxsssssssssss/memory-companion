import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { setTimeout as wait } from "node:timers/promises";
import { getDataRootDir } from "@/lib/server/storage/paths";

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const TRANSIENT_RENAME_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const TRANSIENT_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80] as const;
const pathWriteQueues = new Map<string, Promise<void>>();

type RenameWithRetryOptions = {
  renameFile?: (sourcePath: string, destinationPath: string) => Promise<void>;
  retryDelaysMs?: readonly number[];
  waitForRetry?: (delayMs: number) => Promise<void>;
};

function isTransientRenameError(error: unknown) {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    TRANSIENT_RENAME_ERROR_CODES.has(error.code);
}

export async function renameWithTransientRetry(
  sourcePath: string,
  destinationPath: string,
  options: RenameWithRetryOptions = {}
) {
  const renameFile = options.renameFile ?? rename;
  const retryDelaysMs = options.retryDelaysMs ?? TRANSIENT_RENAME_RETRY_DELAYS_MS;
  const waitForRetry = options.waitForRetry ?? ((delayMs: number) => wait(delayMs));

  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(sourcePath, destinationPath);
      return;
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs === undefined || !isTransientRenameError(error)) {
        throw error;
      }
      await waitForRetry(retryDelayMs);
    }
  }
}

async function serializePathWrite(filePath: string, write: () => Promise<void>) {
  const key = resolve(filePath);
  const previous = pathWriteQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(write);
  pathWriteQueues.set(key, current);
  try {
    await current;
  } finally {
    if (pathWriteQueues.get(key) === current) {
      pathWriteQueues.delete(key);
    }
  }
}

export class JsonStore {
  constructor(private readonly rootDir = ".data") {}

  async write<T>(collection: string, id: string, value: T): Promise<void> {
    const filePath = this.pathFor(collection, id);
    await serializePathWrite(filePath, async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
        await renameWithTransientRetry(temporaryPath, filePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    });
  }

  async read<T>(collection: string, id: string): Promise<T | null> {
    try {
      const raw = await readFile(this.pathFor(collection, id), "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async list<T>(collection: string): Promise<Array<{ id: string; value: T }>> {
    this.validateKey(collection);
    const collectionPath = join(this.rootDir, collection);

    try {
      const fileNames = await readdir(collectionPath);
      const jsonFileNames = fileNames.filter((fileName) => fileName.endsWith(".json")).sort();

      return await Promise.all(
        jsonFileNames.map(async (fileName) => {
          const id = fileName.slice(0, -".json".length);
          this.validateKey(id);
          const raw = await readFile(join(collectionPath, fileName), "utf8");
          return { id, value: JSON.parse(raw) as T };
        })
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async listIds(collection: string): Promise<string[]> {
    this.validateKey(collection);
    const collectionPath = join(this.rootDir, collection);
    try {
      return (await readdir(collectionPath))
        .filter((fileName) => fileName.endsWith(".json"))
        .map((fileName) => fileName.slice(0, -".json".length))
        .filter((id) => STORE_KEY_PATTERN.test(id))
        .sort();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async delete(collection: string, id: string): Promise<void> {
    await rm(this.pathFor(collection, id), { force: true });
  }

  private pathFor(collection: string, id: string) {
    this.validateKey(collection);
    this.validateKey(id);
    return join(this.rootDir, collection, `${id}.json`);
  }

  private validateKey(value: string) {
    if (!STORE_KEY_PATTERN.test(value)) {
      throw new Error(`Invalid store key: ${value}`);
    }
  }
}

export const appStore = new JsonStore(getDataRootDir());

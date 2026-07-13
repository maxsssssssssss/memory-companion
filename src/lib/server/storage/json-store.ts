import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getDataRootDir } from "@/lib/server/storage/paths";

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export class JsonStore {
  constructor(private readonly rootDir = ".data") {}

  async write<T>(collection: string, id: string, value: T): Promise<void> {
    const filePath = this.pathFor(collection, id);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
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

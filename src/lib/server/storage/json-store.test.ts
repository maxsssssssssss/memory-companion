import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonStore, renameWithTransientRetry } from "./json-store";

let tempDir: string | undefined;

async function createTempStore() {
  tempDir = await mkdtemp(join(tmpdir(), "brief-store-"));
  return new JsonStore(join(tempDir, "store"));
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("JsonStore", () => {
  it("writes and reads records by collection", async () => {
    const store = await createTempStore();

    await store.write("uploads", "upload_1", { id: "upload_1", title: "Demo" });
    const record = await store.read<{ id: string; title: string }>("uploads", "upload_1");

    expect(record?.title).toBe("Demo");
  });

  it("deletes records by collection", async () => {
    const store = await createTempStore();

    await store.write("uploads", "upload_1", { id: "upload_1", title: "Demo" });
    await store.delete("uploads", "upload_1");

    await expect(store.read("uploads", "upload_1")).resolves.toBeNull();
  });

  it("lists records in a collection with their ids", async () => {
    const store = await createTempStore();

    await store.write("uploads", "upload_2", { title: "Second" });
    await store.write("uploads", "upload_1", { title: "First" });

    await expect(store.list<{ title: string }>("uploads")).resolves.toEqual([
      { id: "upload_1", value: { title: "First" } },
      { id: "upload_2", value: { title: "Second" } }
    ]);
  });

  it("serializes concurrent atomic writes to the same record", async () => {
    const store = await createTempStore();
    const secondStore = new JsonStore(join(tempDir!, "store"));

    await Promise.all(Array.from({ length: 20 }, (_, value) =>
      (value % 2 === 0 ? store : secondStore).write("jobs", "job_1", { value })
    ));

    const record = await store.read<{ value: number }>("jobs", "job_1");
    expect(record).toEqual({ value: 19 });
    expect(await readdir(join(tempDir!, "store", "jobs"))).toEqual(["job_1.json"]);
  });

  it("writes atomically when the Windows-compatible root path contains spaces, Unicode, and brackets", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief 存储 [atomic]-"));
    const store = new JsonStore(join(tempDir, "nested store"));

    await store.write("jobs", "job_1", { value: "initial" });
    await store.write("jobs", "job_1", { value: "complete" });

    await expect(store.read("jobs", "job_1")).resolves.toEqual({ value: "complete" });
    expect(await readdir(join(tempDir, "nested store", "jobs"))).toEqual(["job_1.json"]);
  });

  it("preserves the previous record and removes the temporary file when serialization fails", async () => {
    const store = await createTempStore();
    await store.write("jobs", "job_1", { value: "previous" });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    await expect(store.write("jobs", "job_1", cyclic)).rejects.toThrow();

    await expect(store.read("jobs", "job_1")).resolves.toEqual({ value: "previous" });
    expect(await readdir(join(tempDir!, "store", "jobs"))).toEqual(["job_1.json"]);
  });

  it.each(["EACCES", "EBUSY", "EPERM"])(
    "retries a transient %s atomic rename with the same source and destination",
    async (code) => {
      const transientError = Object.assign(new Error(`transient ${code}`), { code });
      const renameFile = vi.fn()
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce(undefined);
      const waitForRetry = vi.fn().mockResolvedValue(undefined);

      await renameWithTransientRetry("record.tmp", "record.json", {
        renameFile,
        retryDelaysMs: [10],
        waitForRetry
      });

      expect(renameFile).toHaveBeenCalledTimes(2);
      expect(renameFile).toHaveBeenNthCalledWith(1, "record.tmp", "record.json");
      expect(renameFile).toHaveBeenNthCalledWith(2, "record.tmp", "record.json");
      expect(waitForRetry).toHaveBeenCalledWith(10);
    }
  );

  it("rethrows a persistent transient rename error after the bounded retries", async () => {
    const persistentError = Object.assign(new Error("still locked"), { code: "EPERM" });
    const renameFile = vi.fn().mockRejectedValue(persistentError);
    const waitForRetry = vi.fn().mockResolvedValue(undefined);

    await expect(renameWithTransientRetry("record.tmp", "record.json", {
      renameFile,
      waitForRetry
    })).rejects.toBe(persistentError);

    expect(renameFile).toHaveBeenCalledTimes(5);
    expect(waitForRetry.mock.calls).toEqual([[10], [20], [40], [80]]);
  });

  it("does not replace the formal record when an atomic rename never succeeds", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-store-rename-"));
    const temporaryPath = join(tempDir, "record.json.test.tmp");
    const destinationPath = join(tempDir, "record.json");
    await writeFile(temporaryPath, "new", "utf8");
    await writeFile(destinationPath, "previous", "utf8");
    const persistentError = Object.assign(new Error("still locked"), { code: "EPERM" });

    await expect(renameWithTransientRetry(temporaryPath, destinationPath, {
      renameFile: vi.fn().mockRejectedValue(persistentError),
      retryDelaysMs: []
    })).rejects.toBe(persistentError);

    await expect(readFile(destinationPath, "utf8")).resolves.toBe("previous");
    await expect(readFile(temporaryPath, "utf8")).resolves.toBe("new");
  });

  it("does not retry a non-transient atomic rename error", async () => {
    const permanentError = Object.assign(new Error("missing directory"), { code: "ENOENT" });
    const renameFile = vi.fn().mockRejectedValue(permanentError);
    const waitForRetry = vi.fn().mockResolvedValue(undefined);

    await expect(renameWithTransientRetry("record.tmp", "record.json", {
      renameFile,
      waitForRetry
    })).rejects.toBe(permanentError);

    expect(renameFile).toHaveBeenCalledTimes(1);
    expect(waitForRetry).not.toHaveBeenCalled();
  });

  it("rejects unsafe collection keys for all operations", async () => {
    const store = await createTempStore();
    const unsafeKeys = ["", "..", "../uploads", "uploads/evil", "uploads\\evil", join(tempDir!, "absolute-key")];

    for (const unsafeKey of unsafeKeys) {
      await expect(store.read(unsafeKey, "upload_1")).rejects.toThrow(`Invalid store key: ${unsafeKey}`);
      await expect(store.write(unsafeKey, "upload_1", { id: "upload_1" })).rejects.toThrow(
        `Invalid store key: ${unsafeKey}`
      );
      await expect(store.delete(unsafeKey, "upload_1")).rejects.toThrow(`Invalid store key: ${unsafeKey}`);
    }
  });

  it("rejects unsafe id keys for all operations", async () => {
    const store = await createTempStore();
    const unsafeKeys = ["", "..", "../uploads", "uploads/evil", "uploads\\evil", join(tempDir!, "absolute-key")];

    for (const unsafeKey of unsafeKeys) {
      await expect(store.read("uploads", unsafeKey)).rejects.toThrow(`Invalid store key: ${unsafeKey}`);
      await expect(store.write("uploads", unsafeKey, { id: "upload_1" })).rejects.toThrow(
        `Invalid store key: ${unsafeKey}`
      );
      await expect(store.delete("uploads", unsafeKey)).rejects.toThrow(`Invalid store key: ${unsafeKey}`);
    }
  });
});

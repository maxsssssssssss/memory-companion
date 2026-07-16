import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./json-store";

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

    await Promise.all(Array.from({ length: 20 }, (_, value) =>
      store.write("jobs", "job_1", { value })
    ));

    const record = await store.read<{ value: number }>("jobs", "job_1");
    expect(record?.value).toBeGreaterThanOrEqual(0);
    expect(record?.value).toBeLessThan(20);
    expect(await readdir(join(tempDir!, "store", "jobs"))).toEqual(["job_1.json"]);
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

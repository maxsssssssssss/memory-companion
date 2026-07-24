// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLocalWorkerLease } from "./local-worker-lease";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local Pipeline Worker lease", () => {
  it("prevents a supervisor and plain Worker from running together", async () => {
    const root = await mkdtemp(join(tmpdir(), "daily-brief-local-worker-lease-"));
    temporaryRoots.push(root);
    const filePath = join(root, "worker-local.lock");
    const supervisor = await acquireLocalWorkerLease({ filePath, role: "supervisor" });

    await expect(
      acquireLocalWorkerLease({ filePath, role: "worker" })
    ).rejects.toThrow("another local Pipeline Worker");

    await supervisor.release();
    const worker = await acquireLocalWorkerLease({ filePath, role: "worker" });
    await worker.release();
  });

  it("atomically recovers a stale owner and removes its own lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "daily-brief-local-worker-lease-"));
    temporaryRoots.push(root);
    const filePath = join(root, "worker-local.lock");
    await writeFile(
      filePath,
      JSON.stringify({ pid: 2_147_483_647, role: "worker", ownerToken: "stale" }),
      "utf8"
    );

    const lease = await acquireLocalWorkerLease({ filePath, role: "supervisor" });
    await lease.release();

    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is disabled for production callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "daily-brief-local-worker-lease-"));
    temporaryRoots.push(root);
    const filePath = join(root, "worker-local.lock");
    const first = await acquireLocalWorkerLease({ enabled: false, filePath, role: "worker" });
    const second = await acquireLocalWorkerLease({ enabled: false, filePath, role: "supervisor" });
    await first.release();
    await second.release();
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

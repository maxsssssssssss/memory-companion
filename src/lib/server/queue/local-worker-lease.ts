import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type LocalWorkerRole = "supervisor" | "worker";

export type LocalWorkerLease = {
  release(): Promise<void>;
};

export type AcquireLocalWorkerLeaseOptions = {
  enabled?: boolean;
  filePath?: string;
  role: LocalWorkerRole;
};

export function localWorkerLeasePath(dataDirectory: string) {
  return resolve(dataDirectory, "local-worker", "worker-local.lock");
}

export const defaultLocalWorkerLeasePath = localWorkerLeasePath(
  resolve(process.cwd(), ".data")
);

function isProcessRunning(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function noOpLease(): LocalWorkerLease {
  return { release: async () => undefined };
}

export async function acquireLocalWorkerLease(
  options: AcquireLocalWorkerLeaseOptions
): Promise<LocalWorkerLease> {
  const enabled = options.enabled ?? true;
  if (!enabled) {
    return noOpLease();
  }

  const filePath = options.filePath ?? defaultLocalWorkerLeasePath;
  await mkdir(dirname(filePath), { recursive: true });
  const ownerToken = randomUUID();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            ownerToken,
            pid: process.pid,
            role: options.role,
            startedAt: new Date().toISOString()
          }),
          "utf8"
        );
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(filePath, { force: true });
        throw error;
      }

      let released = false;
      return {
        async release() {
          if (released) {
            return;
          }
          released = true;
          await handle.close().catch(() => undefined);
          try {
            const current = JSON.parse(await readFile(filePath, "utf8")) as {
              ownerToken?: string;
            };
            if (current.ownerToken === ownerToken) {
              await rm(filePath, { force: true });
            }
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
              throw error;
            }
          }
        }
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }

      let ownerPid: number | undefined;
      let ownerRole: string | undefined;
      try {
        const owner = JSON.parse(await readFile(filePath, "utf8")) as {
          pid?: number;
          role?: string;
        };
        ownerPid = owner.pid;
        ownerRole = owner.role;
      } catch {
        ownerPid = undefined;
      }
      if (ownerPid && isProcessRunning(ownerPid)) {
        throw new Error(
          `another local Pipeline Worker is running with pid ${ownerPid} role=${ownerRole ?? "unknown"}`
        );
      }

      const stalePath = `${filePath}.stale.${process.pid}.${randomUUID()}`;
      try {
        await rename(filePath, stalePath);
      } catch (renameError) {
        if (
          renameError instanceof Error &&
          "code" in renameError &&
          renameError.code === "ENOENT"
        ) {
          continue;
        }
        throw renameError;
      }
      await rm(stalePath, { force: true });
    }
  }

  throw new Error("unable to acquire local Pipeline Worker lease");
}

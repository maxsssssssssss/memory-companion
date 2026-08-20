// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  createToySyncDuplicateKey,
  serializeToySyncState,
  type ToySyncEntryStatus,
  type ToySyncState
} from "./daily-reflection-toy-sync";
import {
  createBrowserToySyncRuntime,
  createIndexedDbToySyncPersistence,
  createToySyncOperationKey,
  createToySyncUploadIdempotencyKey,
  type ToySyncPermissionDirectoryHandle
} from "./daily-reflection-toy-sync-storage";

type MemoryStore = {
  keyPath: string | readonly string[];
  rows: Map<string, unknown>;
};

function keyToken(key: IDBValidKey): string {
  return JSON.stringify(key);
}

function requestWithResult<T>(
  result: T,
  onSuccess: () => void = () => undefined
): IDBRequest<T> {
  const request = new EventTarget() as EventTarget & {
    result: T;
    error: DOMException | null;
  };
  request.result = result;
  request.error = null;
  queueMicrotask(() => {
    request.dispatchEvent(new Event("success"));
    onSuccess();
  });
  return request as unknown as IDBRequest<T>;
}

function keyFromValue(store: MemoryStore, value: unknown): IDBValidKey {
  const record = value as Record<string, IDBValidKey>;
  if (typeof store.keyPath === "string") return record[store.keyPath];
  return store.keyPath.map((part) => record[part]);
}

function memoryIdbFactory(options: {
  legacyAccountId?: string;
  legacyState?: ToySyncState;
} = {}): IDBFactory {
  const stores = new Map<string, MemoryStore>();
  let databaseVersion = options.legacyState ? 1 : 0;
  if (options.legacyState && options.legacyAccountId) {
    stores.set("directories", { keyPath: "accountId", rows: new Map() });
    stores.set("states", {
      keyPath: "accountId",
      rows: new Map([[
        keyToken(options.legacyAccountId),
        {
          accountId: options.legacyAccountId,
          state: serializeToySyncState(options.legacyState)
        }
      ]])
    });
  }

  const objectStoreNames = {
    contains: (name: string) => stores.has(name)
  } as DOMStringList;
  const database = {
    objectStoreNames,
    createObjectStore(name: string, storeOptions?: IDBObjectStoreParameters) {
      stores.set(name, {
        keyPath: Array.isArray(storeOptions?.keyPath)
          ? storeOptions.keyPath
          : storeOptions?.keyPath ?? "",
        rows: new Map()
      });
      return {} as IDBObjectStore;
    },
    transaction(name: string) {
      const store = stores.get(name);
      if (!store) throw new DOMException("Missing object store", "NotFoundError");
      const transaction = new EventTarget() as EventTarget & {
        error: DOMException | null;
        objectStore(storeName: string): IDBObjectStore;
      };
      transaction.error = null;
      const complete = () => queueMicrotask(() => {
        transaction.dispatchEvent(new Event("complete"));
      });
      transaction.objectStore = (storeName) => {
        if (storeName !== name) throw new DOMException("Missing object store", "NotFoundError");
        return {
          get(key: IDBValidKey) {
            return requestWithResult(store.rows.get(keyToken(key)), complete);
          },
          put(value: unknown) {
            store.rows.set(keyToken(keyFromValue(store, value)), value);
            return requestWithResult(undefined, complete);
          },
          delete(key: IDBValidKey) {
            store.rows.delete(keyToken(key));
            return requestWithResult(undefined, complete);
          }
        } as unknown as IDBObjectStore;
      };
      return transaction as unknown as IDBTransaction;
    },
    close() {
      // Each persistence operation closes its connection; memory remains durable.
    }
  } as unknown as IDBDatabase;

  return {
    open(_name: string, requestedVersion = 1) {
      const request = new EventTarget() as EventTarget & {
        result: IDBDatabase;
        error: DOMException | null;
      };
      request.result = database;
      request.error = null;
      queueMicrotask(() => {
        if (requestedVersion > databaseVersion) {
          databaseVersion = requestedVersion;
          request.dispatchEvent(new Event("upgradeneeded"));
        }
        request.dispatchEvent(new Event("success"));
      });
      return request as unknown as IDBOpenDBRequest;
    }
  } as IDBFactory;
}

function stateWithStatus(status: ToySyncEntryStatus): ToySyncState {
  const filename = "shared.wav";
  const fileSize = 5;
  const lastModified = 1_723_000_000_123;
  return {
    version: 1,
    records: [{
      duplicateKey: createToySyncDuplicateKey({ filename, fileSize, lastModified }),
      filename,
      fileSize,
      lastModified,
      status,
      updatedAt: "2026-08-18T08:00:00.000Z"
    }]
  };
}

describe("daily reflection toy sync upload identity", () => {
  it("derives a stable bounded upload idempotency key from the duplicate key", async () => {
    const first = await createToySyncUploadIdempotencyKey(
      "toy-sync:v1:note.wav:1024:1723000000123"
    );
    const second = await createToySyncUploadIdempotencyKey(
      "toy-sync:v1:note.wav:1024:1723000000123"
    );
    const other = await createToySyncUploadIdempotencyKey(
      "toy-sync:v1:other.wav:1024:1723000000123"
    );

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^daily-reflection-toy-v1-[a-f0-9]{64}$/u);
    expect(first.length).toBeLessThan(512);
  });

  it("derives a stable bounded operation key from account, destination and relationship", async () => {
    const input = {
      accountId: "account-secret",
      destination: "date_companion" as const,
      relationshipId: "relationship_1",
      duplicateKey: "toy-sync:v1:private-name.wav:1024:1723000000123"
    };
    const first = await createToySyncOperationKey(input);
    const replay = await createToySyncOperationKey(input);
    const otherRelationship = await createToySyncOperationKey({
      ...input,
      relationshipId: "relationship_2"
    });

    expect(first).toBe(replay);
    expect(first).not.toBe(otherRelationship);
    expect(first).toMatch(/^toyop_v1_[a-f0-9]{64}$/u);
    expect(first).not.toContain("account-secret");
    expect(first).not.toContain("private-name");
    expect(first.length).toBeLessThanOrEqual(128);
  });

  it("does not invoke the directory picker while constructing or checking support", async () => {
    const handle = { kind: "directory", name: "recordings" } as ToySyncPermissionDirectoryHandle;
    const showDirectoryPicker = vi.fn(async () => handle);
    const runtime = createBrowserToySyncRuntime(
      { showDirectoryPicker } as never,
      {} as IDBFactory
    );

    expect(runtime.isSupported()).toBe(true);
    expect(showDirectoryPicker).not.toHaveBeenCalled();
    await expect(runtime.pickDirectory()).resolves.toBe(handle);
    expect(showDirectoryPicker).toHaveBeenCalledTimes(1);
    expect(showDirectoryPicker).toHaveBeenCalledWith({ mode: "read" });
  });

  it("degrades safely when browser persistence is unavailable", async () => {
    const showDirectoryPicker = vi.fn();
    const runtime = createBrowserToySyncRuntime(
      { showDirectoryPicker } as never,
      null
    );

    expect(runtime.isSupported()).toBe(false);
    await expect(runtime.persistence.loadDirectory("account-1")).resolves.toBeNull();
    await expect(runtime.persistence.loadState("account-1")).resolves.toEqual({
      version: 1,
      records: []
    });
    expect(showDirectoryPicker).not.toHaveBeenCalled();
  });

  it("shares one account directory while isolating state for each destination", async () => {
    const persistence = createIndexedDbToySyncPersistence(memoryIdbFactory());
    const handle = {
      kind: "directory",
      name: "recordings",
      async *entries() {
        // Directory contents are irrelevant to persistence identity.
      }
    } as ToySyncPermissionDirectoryHandle;
    const dailyReflectionState = stateWithStatus("uploaded");
    const dateCompanionState = stateWithStatus("ignored");

    await persistence.saveDirectory("account-1", handle);
    await persistence.saveState("account-1", dailyReflectionState);

    await expect(persistence.loadDirectory("account-1")).resolves.toBe(handle);
    await expect(persistence.loadState("account-1", "daily_reflection"))
      .resolves.toEqual(dailyReflectionState);
    await expect(persistence.loadState("account-1", "date_companion"))
      .resolves.toEqual({ version: 1, records: [] });

    await persistence.saveState("account-1", dateCompanionState, "date_companion");

    await expect(persistence.loadState("account-1"))
      .resolves.toEqual(dailyReflectionState);
    await expect(persistence.loadState("account-1", "date_companion"))
      .resolves.toEqual(dateCompanionState);
    await expect(persistence.loadDirectory("account-1")).resolves.toBe(handle);
  });

  it("uses a v1 account state only for the default Daily Reflection destination", async () => {
    const legacyState = stateWithStatus("uploaded");
    const persistence = createIndexedDbToySyncPersistence(memoryIdbFactory({
      legacyAccountId: "account-legacy",
      legacyState
    }));

    await expect(persistence.loadState("account-legacy"))
      .resolves.toEqual(legacyState);
    await expect(persistence.loadState("account-legacy", "daily_reflection"))
      .resolves.toEqual(legacyState);
    await expect(persistence.loadState("account-legacy", "date_companion"))
      .resolves.toEqual({ version: 1, records: [] });

    const dateCompanionState = stateWithStatus("ignored");
    await persistence.saveState(
      "account-legacy",
      dateCompanionState,
      "date_companion"
    );
    await expect(persistence.loadState("account-legacy"))
      .resolves.toEqual(legacyState);
    await expect(persistence.loadState("account-legacy", "date_companion"))
      .resolves.toEqual(dateCompanionState);
  });

  it("keeps the same destination isolated between accounts", async () => {
    const persistence = createIndexedDbToySyncPersistence(memoryIdbFactory());
    const firstAccountState = stateWithStatus("uploaded");
    const secondAccountState = stateWithStatus("new");

    await persistence.saveState(
      "account-1",
      firstAccountState,
      "date_companion"
    );
    await persistence.saveState(
      "account-2",
      secondAccountState,
      "date_companion"
    );

    await expect(persistence.loadState("account-1", "date_companion"))
      .resolves.toEqual(firstAccountState);
    await expect(persistence.loadState("account-2", "date_companion"))
      .resolves.toEqual(secondAccountState);
    await expect(persistence.loadState("account-2", "daily_reflection"))
      .resolves.toEqual({ version: 1, records: [] });
    await expect(persistence.loadDirectory("account-2")).resolves.toBeNull();
  });
});

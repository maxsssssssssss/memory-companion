"use client";

import {
  DEFAULT_TOY_SYNC_DESTINATION,
  createEmptyToySyncState,
  isToySyncDestination,
  parseToySyncState,
  serializeToySyncState,
  type ToySyncDirectoryHandle,
  type ToySyncDestination,
  type ToySyncState
} from "./daily-reflection-toy-sync";

export type ToySyncPermissionState = "granted" | "denied" | "prompt";

export type ToySyncPermissionDirectoryHandle = ToySyncDirectoryHandle & Readonly<{
  queryPermission?(descriptor?: { mode?: "read" }): Promise<ToySyncPermissionState>;
  requestPermission?(descriptor?: { mode?: "read" }): Promise<ToySyncPermissionState>;
}>;

export interface ToySyncPersistence {
  loadDirectory(accountId: string): Promise<ToySyncPermissionDirectoryHandle | null>;
  saveDirectory(
    accountId: string,
    handle: ToySyncPermissionDirectoryHandle
  ): Promise<void>;
  clearDirectory(accountId: string): Promise<void>;
  loadState(
    accountId: string,
    destination?: ToySyncDestination
  ): Promise<ToySyncState>;
  saveState(
    accountId: string,
    state: ToySyncState,
    destination?: ToySyncDestination
  ): Promise<void>;
}

/** @deprecated Prefer the destination-neutral ToySyncPersistence name. */
export type DailyReflectionToySyncPersistence = ToySyncPersistence;

export interface ToySyncRuntime {
  isSupported(): boolean;
  pickDirectory(): Promise<ToySyncPermissionDirectoryHandle>;
  queryPermission(
    handle: ToySyncPermissionDirectoryHandle
  ): Promise<ToySyncPermissionState>;
  requestPermission(
    handle: ToySyncPermissionDirectoryHandle
  ): Promise<ToySyncPermissionState>;
  persistence: ToySyncPersistence;
}

/** @deprecated Prefer the destination-neutral ToySyncRuntime name. */
export type DailyReflectionToySyncRuntime = ToySyncRuntime;

type DirectoryRow = Readonly<{
  accountId: string;
  handle: ToySyncPermissionDirectoryHandle;
}>;

type StateRow = Readonly<{
  accountId: string;
  state: string;
}>;

type DestinationStateRow = Readonly<{
  accountId: string;
  destination: ToySyncDestination;
  state: string;
}>;

const DATABASE_NAME = "daily-brief-toy-sync";
const DATABASE_VERSION = 2;
const DIRECTORY_STORE = "directories";
const LEGACY_STATE_STORE = "states";
const DESTINATION_STATE_STORE = "destination-states";

function requireDestination(
  destination: ToySyncDestination = DEFAULT_TOY_SYNC_DESTINATION
): ToySyncDestination {
  if (!isToySyncDestination(destination)) {
    throw new Error("toy_sync_invalid_destination");
  }
  return destination;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(
      request.error ?? new Error("toy_sync_indexed_db_request_failed")
    ), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(
      transaction.error ?? new Error("toy_sync_indexed_db_transaction_aborted")
    ), { once: true });
    transaction.addEventListener("error", () => reject(
      transaction.error ?? new Error("toy_sync_indexed_db_transaction_failed")
    ), { once: true });
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DIRECTORY_STORE)) {
        database.createObjectStore(DIRECTORY_STORE, { keyPath: "accountId" });
      }
      // Preserve the v1 account-only store. It is a compatibility source for
      // Daily Reflection only and must never affect another destination.
      if (!database.objectStoreNames.contains(LEGACY_STATE_STORE)) {
        database.createObjectStore(LEGACY_STATE_STORE, { keyPath: "accountId" });
      }
      if (!database.objectStoreNames.contains(DESTINATION_STATE_STORE)) {
        database.createObjectStore(DESTINATION_STATE_STORE, {
          keyPath: ["accountId", "destination"]
        });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(
      request.error ?? new Error("toy_sync_indexed_db_open_failed")
    ), { once: true });
  });
}

function isDirectoryHandle(value: unknown): value is ToySyncPermissionDirectoryHandle {
  if (!value || typeof value !== "object") return false;
  const handle = value as Partial<ToySyncPermissionDirectoryHandle>;
  return handle.kind === "directory"
    && typeof handle.name === "string"
    && typeof handle.entries === "function";
}

export function createIndexedDbToySyncPersistence(
  factory: IDBFactory
): ToySyncPersistence {
  const withDatabase = async <T>(work: (database: IDBDatabase) => Promise<T>) => {
    const database = await openDatabase(factory);
    try {
      return await work(database);
    } finally {
      database.close();
    }
  };

  const readRow = async <T>(
    database: IDBDatabase,
    storeName: string,
    key: IDBValidKey
  ): Promise<T | undefined> => {
    const transaction = database.transaction(storeName, "readonly");
    const done = transactionDone(transaction);
    const row = await requestResult(transaction.objectStore(storeName).get(key)) as T | undefined;
    await done;
    return row;
  };

  return {
    async loadDirectory(accountId) {
      return withDatabase(async (database) => {
        const transaction = database.transaction(DIRECTORY_STORE, "readonly");
        const done = transactionDone(transaction);
        const row = await requestResult(
          transaction.objectStore(DIRECTORY_STORE).get(accountId)
        ) as DirectoryRow | undefined;
        await done;
        return isDirectoryHandle(row?.handle) ? row.handle : null;
      });
    },

    async saveDirectory(accountId, handle) {
      await withDatabase(async (database) => {
        const transaction = database.transaction(DIRECTORY_STORE, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(DIRECTORY_STORE).put({ accountId, handle } satisfies DirectoryRow);
        await done;
      });
    },

    async clearDirectory(accountId) {
      await withDatabase(async (database) => {
        const transaction = database.transaction(DIRECTORY_STORE, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(DIRECTORY_STORE).delete(accountId);
        await done;
      });
    },

    async loadState(accountId, requestedDestination = DEFAULT_TOY_SYNC_DESTINATION) {
      const destination = requireDestination(requestedDestination);
      return withDatabase(async (database) => {
        const destinationRow = await readRow<DestinationStateRow>(
          database,
          DESTINATION_STATE_STORE,
          [accountId, destination]
        );
        if (destinationRow) {
          return parseToySyncState(
            typeof destinationRow.state === "string" ? destinationRow.state : null
          ) ?? createEmptyToySyncState();
        }
        if (destination !== DEFAULT_TOY_SYNC_DESTINATION) {
          return createEmptyToySyncState();
        }
        const legacyRow = await readRow<StateRow>(database, LEGACY_STATE_STORE, accountId);
        return parseToySyncState(
          typeof legacyRow?.state === "string" ? legacyRow.state : null
        ) ?? createEmptyToySyncState();
      });
    },

    async saveState(
      accountId,
      state,
      requestedDestination = DEFAULT_TOY_SYNC_DESTINATION
    ) {
      const destination = requireDestination(requestedDestination);
      await withDatabase(async (database) => {
        const transaction = database.transaction(DESTINATION_STATE_STORE, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(DESTINATION_STATE_STORE).put({
          accountId,
          destination,
          state: serializeToySyncState(state)
        } satisfies DestinationStateRow);
        await done;
      });
    }
  };
}

type ToySyncWindow = Window & typeof globalThis & {
  showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<FileSystemDirectoryHandle>;
};

function createUnavailableToySyncPersistence(): ToySyncPersistence {
  const unavailable = async (): Promise<never> => {
    throw new Error("toy_sync_indexed_db_unavailable");
  };
  return {
    loadDirectory: async () => null,
    saveDirectory: unavailable,
    clearDirectory: unavailable,
    loadState: async (_accountId, destination = DEFAULT_TOY_SYNC_DESTINATION) => {
      requireDestination(destination);
      return createEmptyToySyncState();
    },
    saveState: unavailable
  };
}

export function createBrowserToySyncRuntime(
  browserWindow: ToySyncWindow | null = typeof window === "undefined"
    ? null
    : window as ToySyncWindow,
  indexedDbFactory: IDBFactory | null = typeof indexedDB === "undefined"
    ? null
    : indexedDB
): ToySyncRuntime {
  return {
    isSupported: () => typeof browserWindow?.showDirectoryPicker === "function"
      && Boolean(indexedDbFactory),
    async pickDirectory() {
      if (typeof browserWindow?.showDirectoryPicker !== "function") {
        throw new DOMException("Directory selection is unavailable", "NotSupportedError");
      }
      return (await browserWindow.showDirectoryPicker({ mode: "read" })) as unknown as ToySyncPermissionDirectoryHandle;
    },
    async queryPermission(handle) {
      return typeof handle.queryPermission === "function"
        ? handle.queryPermission({ mode: "read" })
        : "prompt";
    },
    async requestPermission(handle) {
      return typeof handle.requestPermission === "function"
        ? handle.requestPermission({ mode: "read" })
        : "prompt";
    },
    persistence: indexedDbFactory
      ? createIndexedDbToySyncPersistence(indexedDbFactory)
      : createUnavailableToySyncPersistence()
  };
}

export async function createToySyncUploadIdempotencyKey(
  duplicateKey: string,
  cryptoImpl: Crypto = globalThis.crypto
): Promise<string> {
  if (!cryptoImpl?.subtle) throw new Error("toy_sync_crypto_unavailable");
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(duplicateKey)
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `daily-reflection-toy-v1-${hex}`;
}

export async function createToySyncOperationKey(
  input: Readonly<{
    accountId: string;
    destination: ToySyncDestination;
    relationshipId: string;
    duplicateKey: string;
  }>,
  cryptoImpl: Crypto = globalThis.crypto
): Promise<string> {
  if (!cryptoImpl?.subtle) throw new Error("toy_sync_crypto_unavailable");
  const destination = requireDestination(input.destination);
  const accountId = input.accountId.normalize("NFKC").trim();
  const relationshipId = input.relationshipId.normalize("NFKC").trim();
  const duplicateKey = input.duplicateKey.trim();
  if (!accountId || !relationshipId || !duplicateKey) {
    throw new Error("toy_sync_operation_scope_required");
  }
  const digest = await cryptoImpl.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({
      accountId,
      destination,
      relationshipId,
      duplicateKey
    }))
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `toyop_v1_${hex}`;
}

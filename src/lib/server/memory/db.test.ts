// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "./db";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("memory database", () => {
  it("creates the v1.5 schema with management columns and relations", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-db-"));
    const database = openMemoryDatabase({ filePath: join(tempDir, "memory.sqlite") });

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const migration = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const itemColumns = database.prepare("PRAGMA table_info(memory_items)").all() as Array<{ name: string }>;
    const relationIndexes = database.prepare("PRAGMA index_list(memory_relations)").all() as Array<{
      name: string;
      unique: number;
    }>;

    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(["memory_evidence", "memory_items", "memory_relations", "schema_migrations"])
    );
    expect(itemColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "importance_score",
        "importance_reason",
        "status",
        "occurrence_count",
        "first_seen_date",
        "last_seen_date",
        "access_count",
        "last_accessed_at"
      ])
    );
    expect(relationIndexes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "idx_memory_relations_unique", unique: 1 })])
    );
    expect(migration).toEqual([{ version: 1 }, { version: 2 }]);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);

    database.close();
  });
});

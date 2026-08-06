import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import {
  assertEmbeddingVector,
  type EmbeddingModelConfig
} from "./embedding-provider";

export type EmbeddingObjectType = "evidence" | "memory";

export type EmbeddingIndexEntry = {
  id: string;
  objectType: EmbeddingObjectType;
  objectId: string;
  sourceUploadId: string | null;
  modelName: string;
  modelVersion: string;
  dimension: number;
  contentHash: string;
  vector: number[];
  createdAt: string;
};

export type EmbeddingIndexMetadata = Omit<EmbeddingIndexEntry, "vector">;

export type EmbeddingIndexUpsert = {
  objectType: EmbeddingObjectType;
  objectId: string;
  sourceUploadId: string;
  contentHash: string;
  vector: readonly number[];
};

export type SqliteEmbeddingIndexOptions = {
  readonly?: boolean;
};

type EmbeddingRow = {
  id: string;
  object_type: EmbeddingObjectType;
  object_id: string;
  source_upload_id: string | null;
  model_name: string;
  model_version: string;
  dimension: number;
  content_hash: string;
  vector: Buffer;
  created_at: string;
};

type EmbeddingMetadataRow = Omit<EmbeddingRow, "vector">;

function stableId(input: {
  objectType: EmbeddingObjectType;
  objectId: string;
  model: EmbeddingModelConfig;
}) {
  return createHash("sha256")
    .update([
      input.objectType,
      input.objectId,
      input.model.modelName,
      input.model.modelVersion,
      String(input.model.dimension)
    ].join("\0"))
    .digest("hex");
}

export function embeddingContentHash(text: string) {
  return createHash("sha256").update(text.normalize("NFKC"), "utf8").digest("hex");
}

function vectorBuffer(vector: readonly number[]) {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT));
  return buffer;
}

function vectorFromBuffer(buffer: Buffer, dimension: number) {
  if (buffer.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("embedding sidecar vector byte length does not match its dimension");
  }
  return Array.from({ length: dimension }, (_, index) =>
    buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT)
  );
}

function fromRow(row: EmbeddingRow): EmbeddingIndexEntry {
  return {
    id: row.id,
    objectType: row.object_type,
    objectId: row.object_id,
    sourceUploadId: row.source_upload_id,
    modelName: row.model_name,
    modelVersion: row.model_version,
    dimension: row.dimension,
    contentHash: row.content_hash,
    vector: vectorFromBuffer(row.vector, row.dimension),
    createdAt: row.created_at
  };
}

function metadataFromRow(row: EmbeddingMetadataRow): EmbeddingIndexMetadata {
  return {
    id: row.id,
    objectType: row.object_type,
    objectId: row.object_id,
    sourceUploadId: row.source_upload_id,
    modelName: row.model_name,
    modelVersion: row.model_version,
    dimension: row.dimension,
    contentHash: row.content_hash,
    createdAt: row.created_at
  };
}

export class SqliteEmbeddingIndex {
  private readonly database: Database.Database;
  private readonly readOnly: boolean;

  constructor(
    databasePath: string,
    readonly model: EmbeddingModelConfig,
    options: SqliteEmbeddingIndexOptions = {}
  ) {
    const resolvedPath = resolve(databasePath);
    this.readOnly = options.readonly === true;
    if (!this.readOnly) {
      mkdirSync(dirname(resolvedPath), { recursive: true });
    }
    this.database = new Database(
      resolvedPath,
      this.readOnly ? { readonly: true, fileMustExist: true } : undefined
    );
    if (this.readOnly) {
      this.database.pragma("query_only = ON");
    } else {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("secure_delete = ON");
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS embedding_index (
        id TEXT PRIMARY KEY,
        object_type TEXT NOT NULL CHECK (object_type IN ('evidence', 'memory')),
        object_id TEXT NOT NULL,
        source_upload_id TEXT,
        model_name TEXT NOT NULL,
        model_version TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (object_type, object_id, model_name, model_version, dimension)
      );
      CREATE INDEX IF NOT EXISTS idx_embedding_index_lookup
        ON embedding_index (object_type, model_name, model_version, dimension);
      `);
      const columns = this.database.pragma(
        "table_info(embedding_index)"
      ) as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "source_upload_id")) {
        this.database.exec(
          "ALTER TABLE embedding_index ADD COLUMN source_upload_id TEXT"
        );
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS idx_embedding_index_source_upload
          ON embedding_index (source_upload_id);
      `);
    }
  }

  private assertWritable() {
    if (this.readOnly) {
      throw new Error("embedding sidecar is open in read-only mode");
    }
  }

  private runUpsert(input: EmbeddingIndexUpsert) {
    assertEmbeddingVector(input.vector, this.model.dimension);
    const id = stableId({
      objectType: input.objectType,
      objectId: input.objectId,
      model: this.model
    });
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO embedding_index (
        id, object_type, object_id, source_upload_id, model_name, model_version,
        dimension, content_hash, vector, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (object_type, object_id, model_name, model_version, dimension)
      DO UPDATE SET
        content_hash = excluded.content_hash,
        source_upload_id = excluded.source_upload_id,
        vector = excluded.vector,
        created_at = excluded.created_at
    `).run(
      id,
      input.objectType,
      input.objectId,
      input.sourceUploadId,
      this.model.modelName,
      this.model.modelVersion,
      this.model.dimension,
      input.contentHash,
      vectorBuffer(input.vector),
      createdAt
    );
    return id;
  }

  upsert(input: EmbeddingIndexUpsert) {
    this.assertWritable();
    return this.runUpsert(input);
  }

  get(objectType: EmbeddingObjectType, objectId: string) {
    const row = this.database.prepare(`
      SELECT * FROM embedding_index
      WHERE object_type = ? AND object_id = ?
        AND model_name = ? AND model_version = ? AND dimension = ?
    `).get(
      objectType,
      objectId,
      this.model.modelName,
      this.model.modelVersion,
      this.model.dimension
    ) as EmbeddingRow | undefined;
    return row ? fromRow(row) : null;
  }

  list(objectType: EmbeddingObjectType) {
    const rows = this.database.prepare(`
      SELECT * FROM embedding_index
      WHERE object_type = ?
        AND model_name = ? AND model_version = ? AND dimension = ?
      ORDER BY object_id ASC
    `).all(
      objectType,
      this.model.modelName,
      this.model.modelVersion,
      this.model.dimension
    ) as EmbeddingRow[];
    return rows.map(fromRow);
  }

  listMetadata(objectType: EmbeddingObjectType) {
    const rows = this.database.prepare(`
      SELECT id, object_type, object_id, source_upload_id, model_name, model_version,
             dimension, content_hash, created_at
      FROM embedding_index
      WHERE object_type = ?
        AND model_name = ? AND model_version = ? AND dimension = ?
      ORDER BY object_id ASC
    `).all(
      objectType,
      this.model.modelName,
      this.model.modelVersion,
      this.model.dimension
    ) as EmbeddingMetadataRow[];
    return rows.map(metadataFromRow);
  }

  listAllMetadata() {
    const rows = this.database.prepare(`
      SELECT id, object_type, object_id, source_upload_id, model_name,
             model_version, dimension, content_hash, created_at
      FROM embedding_index
      ORDER BY model_name, model_version, dimension, object_type, object_id
    `).all() as EmbeddingMetadataRow[];
    return rows.map(metadataFromRow);
  }

  getMany(objectType: EmbeddingObjectType, objectIds: readonly string[]) {
    const uniqueIds = [...new Set(objectIds)];
    const rows: EmbeddingRow[] = [];
    const maximumIdsPerQuery = 900;
    for (let offset = 0; offset < uniqueIds.length; offset += maximumIdsPerQuery) {
      const batch = uniqueIds.slice(offset, offset + maximumIdsPerQuery);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(", ");
      rows.push(...this.database.prepare(`
        SELECT * FROM embedding_index
        WHERE object_type = ?
          AND model_name = ? AND model_version = ? AND dimension = ?
          AND object_id IN (${placeholders})
        ORDER BY object_id ASC
      `).all(
        objectType,
        this.model.modelName,
        this.model.modelVersion,
        this.model.dimension,
        ...batch
      ) as EmbeddingRow[]);
    }
    return rows.map(fromRow);
  }

  removeMissing(objectType: EmbeddingObjectType, retainedObjectIds: ReadonlySet<string>) {
    this.assertWritable();
    const rows = this.list(objectType);
    const remove = this.database.prepare("DELETE FROM embedding_index WHERE id = ?");
    const transaction = this.database.transaction(() => {
      for (const row of rows) {
        if (!retainedObjectIds.has(row.objectId)) remove.run(row.id);
      }
    });
    transaction();
    return rows.filter((row) => !retainedObjectIds.has(row.objectId)).length;
  }

  applySnapshot(input: {
    objectType: EmbeddingObjectType;
    retainedObjectIds: ReadonlySet<string>;
    upserts: readonly EmbeddingIndexUpsert[];
  }) {
    this.assertWritable();
    const rows = this.list(input.objectType);
    const remove = this.database.prepare("DELETE FROM embedding_index WHERE id = ?");
    const transaction = this.database.transaction(() => {
      for (const entry of input.upserts) {
        if (entry.objectType !== input.objectType) {
          throw new Error("embedding snapshot contains a mismatched object type");
        }
        this.runUpsert(entry);
      }
      for (const row of rows) {
        if (!input.retainedObjectIds.has(row.objectId)) remove.run(row.id);
      }
    });
    transaction();
    const removed = rows.filter((row) => !input.retainedObjectIds.has(row.objectId)).length;
    if (removed > 0) {
      this.database.pragma("wal_checkpoint(TRUNCATE)");
    }
    return {
      upserted: input.upserts.length,
      removed
    };
  }

  deleteExact(input: {
    objectType: EmbeddingObjectType;
    expectedContentHashes: ReadonlyMap<string, string>;
  }) {
    this.assertWritable();
    const expected = new Map(input.expectedContentHashes);
    const rows = this.listMetadata(input.objectType)
      .filter((row) => expected.has(row.objectId));
    for (const row of rows) {
      if (expected.get(row.objectId) !== row.contentHash) {
        throw new Error(
          `embedding deletion content hash mismatch for ${row.objectId}`
        );
      }
    }
    const remove = this.database.prepare("DELETE FROM embedding_index WHERE id = ?");
    this.database.transaction(() => {
      for (const row of rows) remove.run(row.id);
    })();
    // Always checkpoint before acknowledging a privacy deletion. A retry after
    // a crash can legitimately find zero rows while an older WAL still exists.
    this.database.pragma("wal_checkpoint(TRUNCATE)");
    return {
      requested: expected.size,
      removed: rows.length,
      alreadyMissing: expected.size - rows.length
    };
  }

  /**
   * A retained manifest is the only content-free record that can safely
   * recover ownership for a pre-source_upload_id row after the source upload
   * has been browser-cached away. Every claimed row must already match the
   * manifest's object id and content hash in this exact model partition.
   */
  claimLegacyOwnership(input: {
    objectType: EmbeddingObjectType;
    sourceUploadId: string;
    expectedContentHashes: ReadonlyMap<string, string>;
  }) {
    this.assertWritable();
    const expected = new Map(input.expectedContentHashes);
    const rowsByObjectId = new Map(
      this.listMetadata(input.objectType).map((row) => [row.objectId, row])
    );
    for (const [objectId, contentHash] of expected) {
      const row = rowsByObjectId.get(objectId);
      if (!row) {
        throw new Error(`retained embedding row is missing for ${objectId}`);
      }
      if (row.contentHash !== contentHash) {
        throw new Error(`retained embedding content hash mismatch for ${objectId}`);
      }
      if (
        row.sourceUploadId !== null &&
        row.sourceUploadId !== input.sourceUploadId
      ) {
        throw new Error(`retained embedding ownership mismatch for ${objectId}`);
      }
    }
    const claim = this.database.prepare(`
      UPDATE embedding_index
      SET source_upload_id = ?
      WHERE id = ? AND source_upload_id IS NULL AND content_hash = ?
    `);
    let claimed = 0;
    this.database.transaction(() => {
      for (const [objectId, contentHash] of expected) {
        const row = rowsByObjectId.get(objectId)!;
        if (row.sourceUploadId === null) {
          claimed += claim.run(input.sourceUploadId, row.id, contentHash).changes;
        }
      }
    })();
    const verified = new Map(
      this.getMany(input.objectType, [...expected.keys()])
        .map((row) => [row.objectId, row])
    );
    for (const [objectId, contentHash] of expected) {
      const row = verified.get(objectId);
      if (
        !row ||
        row.contentHash !== contentHash ||
        row.sourceUploadId !== input.sourceUploadId
      ) {
        throw new Error(`retained embedding ownership claim failed for ${objectId}`);
      }
    }
    return {
      requested: expected.size,
      claimed,
      alreadyOwned: expected.size - claimed
    };
  }

  deleteUpload(input: {
    sourceUploadId: string;
    expectedContentHashes: ReadonlyMap<string, string>;
  }) {
    this.assertWritable();
    const expected = new Map(input.expectedContentHashes);
    const rows = this.listAllMetadata();
    for (const row of rows) {
      const expectedHash = expected.get(row.objectId);
      if (
        expectedHash &&
        row.sourceUploadId &&
        row.sourceUploadId !== input.sourceUploadId
      ) {
        throw new Error(
          `embedding deletion ownership mismatch for ${row.objectId}`
        );
      }
      if (
        expectedHash &&
        row.sourceUploadId === null &&
        row.contentHash !== expectedHash
      ) {
        throw new Error(
          `embedding deletion content hash mismatch for ${row.objectId}`
        );
      }
    }
    const ambiguousLegacyRows = rows.filter((row) =>
      row.sourceUploadId === null &&
      (
        row.objectType !== "evidence" ||
        !expected.has(row.objectId)
      )
    );
    if (ambiguousLegacyRows.length > 0) {
      throw new Error(
        "embedding upload deletion cannot prove ownership while unowned legacy rows remain"
      );
    }
    const candidates = rows.filter((row) =>
      row.sourceUploadId === input.sourceUploadId ||
      (
        row.objectType === "evidence" &&
        row.sourceUploadId === null &&
        expected.has(row.objectId)
      )
    );
    const remove = this.database.prepare("DELETE FROM embedding_index WHERE id = ?");
    this.database.transaction(() => {
      for (const row of candidates) remove.run(row.id);
    })();
    this.database.pragma("wal_checkpoint(TRUNCATE)");
    const remaining = this.listAllMetadata().filter((row) =>
      row.sourceUploadId === input.sourceUploadId || row.sourceUploadId === null
    );
    if (remaining.length > 0) {
      throw new Error("embedding upload deletion left owned rows behind");
    }
    return {
      requested: expected.size,
      removed: candidates.length,
      alreadyMissing: Math.max(0, expected.size - candidates.length)
    };
  }

  close() {
    this.database.close();
  }
}

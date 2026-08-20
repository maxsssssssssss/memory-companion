// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDateCompanionDatabase } from "./db";
import { createDateCompanionMemoryBridgeRepository } from "./memory-bridge-repository";

const openDatabases: ReturnType<typeof openDateCompanionDatabase>[] = [];
const temporaryDirectories: string[] = [];

function insertClaimFixture(input: {
  database: ReturnType<typeof openDateCompanionDatabase>;
  sourceState: "available" | "server_cleaned";
}) {
  const now = "2026-08-11T00:00:00.000Z";
  input.database.prepare(`
    INSERT INTO dc_relationships (
      id, user_id, display_name, status, version, created_at, updated_at
    ) VALUES ('relationship_1', 'user_1', 'Ta', 'active', 0, ?, ?)
  `).run(now, now);
  input.database.prepare(`
    INSERT INTO dc_interactions (
      id, user_id, relationship_id, source_upload_id, recording_date,
      original_name, duration_seconds, status, source_state, version,
      created_at, updated_at, confirmed_at
    ) VALUES (
      'interaction_1', 'user_1', 'relationship_1', 'upload_1', '2026-08-11',
      'fixture.wav', 1, 'confirmed', ?, 0, ?, ?, ?
    )
  `).run(input.sourceState, now, now, now);
  const payload = {
    version: 1,
    userId: "user_1",
    relationshipId: "relationship_1",
    interactionId: "interaction_1",
    sourceUploadId: "upload_1",
    sourceVersion: 0,
    confirmationFingerprint: "fixture-confirmation",
    mapping: null,
    selections: []
  };
  input.database.prepare(`
    INSERT INTO dc_memory_bridge_outbox (
      id, user_id, relationship_id, interaction_id, idempotency_key,
      payload_digest, payload_json, mapping_version, source_version,
      confirmation_fingerprint, status, attempt_count, claim_token,
      lease_expires_at, last_error_code, requested_at, updated_at, completed_at
    ) VALUES (
      'outbox_1', 'user_1', 'relationship_1', 'interaction_1', 'bridge-fixture',
      'fixture-digest', ?, NULL, 0, 'fixture-confirmation', 'pending', 0,
      NULL, NULL, NULL, ?, ?, NULL
    )
  `).run(JSON.stringify(payload), now, now);
}

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close();
  }
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("Date Companion Memory bridge lease recovery", () => {
  it("allows only one claimant and recovers the same item after lease expiry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memory-bridge-lease-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "date-companion.sqlite");
    const firstDatabase = openDateCompanionDatabase({ filePath: path });
    const secondDatabase = openDateCompanionDatabase({ filePath: path });
    openDatabases.push(firstDatabase, secondDatabase);
    insertClaimFixture({ database: firstDatabase, sourceState: "server_cleaned" });
    const firstWorker = createDateCompanionMemoryBridgeRepository(firstDatabase);
    const secondWorker = createDateCompanionMemoryBridgeRepository(secondDatabase);

    const firstClaim = firstWorker.claimNext({
      now: "2026-08-11T00:00:00.000Z",
      leaseMs: 1_000
    });
    expect(firstClaim).not.toBeNull();
    expect(secondWorker.claimNext({
      now: "2026-08-11T00:00:00.000Z",
      leaseMs: 1_000
    })).toBeNull();

    const recovered = secondWorker.claimNext({
      now: "2026-08-11T00:00:01.001Z",
      leaseMs: 1_000
    });
    expect(recovered).not.toBeNull();
    expect(recovered?.claimToken).not.toBe(firstClaim?.claimToken);
    expect(secondDatabase.prepare(`
      SELECT status, attempt_count FROM dc_memory_bridge_outbox WHERE id = 'outbox_1'
    `).get()).toEqual({ status: "processing", attempt_count: 2 });
  });

  it("keeps available-source work waiting without consuming an attempt", () => {
    const database = openDateCompanionDatabase({ filePath: ":memory:" });
    openDatabases.push(database);
    insertClaimFixture({ database, sourceState: "available" });
    const repository = createDateCompanionMemoryBridgeRepository(database);

    expect(repository.claimNext({
      now: "2026-08-11T00:00:00.000Z",
      leaseMs: 1_000
    })).toBeNull();
    expect(database.prepare(`
      SELECT status, attempt_count FROM dc_memory_bridge_outbox WHERE id = 'outbox_1'
    `).get()).toEqual({ status: "pending", attempt_count: 0 });
  });
});

const { join } = require("node:path");
const assert = require("node:assert/strict");
const { openDateCompanionDatabase } = require("@/lib/server/date-companion/db");
const { openMemoryDatabase } = require("@/lib/server/memory/db");
const { migrateAndInspectDateCompanionMemoryBridge } = require("@/lib/server/date-companion/memory-bridge-preflight");
const { getDateCompanionWithdrawalPreview, purgeDateCompanionRetainedMemory } = require("@/lib/server/date-companion/memory-bridge-purge");

const [directory, operation] = process.argv.slice(2);
if (operation === "migrate") {
  const report = migrateAndInspectDateCompanionMemoryBridge({ dataDirectory: directory });
  assert.equal(report.ok, true, JSON.stringify(report));
  console.log(JSON.stringify(report));
} else {
  assert.ok(["withdraw", "interrupt-cleanup", "resume-cleanup", "inspect-pending"].includes(operation));
  const dateCompanionDatabase = openDateCompanionDatabase({ filePath: join(directory, "date-companion.sqlite") });
  const memoryDatabase = openMemoryDatabase({ filePath: join(directory, "memory.sqlite") });
  try {
    const scope = { dateCompanionDatabase, memoryDatabase, userId: "test_account",
      relationshipId: dateCompanionDatabase.prepare("SELECT id FROM dc_relationships WHERE user_id=?").get("test_account").id };
    const current = getDateCompanionWithdrawalPreview(scope);
    const { preview } = current;
    if (operation === "inspect-pending") {
      const legacy = dateCompanionDatabase.prepare("SELECT id,status FROM dc_retained_memory_purges").all();
      assert.equal(legacy.length, 1);
      assert.equal(legacy[0].status, "retryable_failed");
      console.log(JSON.stringify({ legacy, current }));
    } else if (operation === "interrupt-cleanup") {
      assert.equal(preview.retainedCount, 1);
      memoryDatabase.exec(`CREATE TEMP TRIGGER simulate_cleanup_interruption BEFORE DELETE ON dc_memory_bridge_receipts
        BEGIN SELECT RAISE(ABORT, 'synthetic_receipt_cleanup_failure'); END`);
      const receipt = purgeDateCompanionRetainedMemory({ ...scope, previewVersion: preview.version });
      assert.equal(receipt.status, "retryable_failed");
      assert.equal(receipt.usageStopped, true);
      console.log(JSON.stringify({ preview, receipt }));
    } else {
      if (operation === "withdraw") assert.equal(preview.retainedCount, 1);
      const previewVersion = operation === "resume-cleanup" ? current.pendingCleanup.previewVersion : preview.version;
      const receipt = purgeDateCompanionRetainedMemory({ ...scope, previewVersion });
      assert.equal(receipt.status, "completed");
      const replay = purgeDateCompanionRetainedMemory({ ...scope, previewVersion });
      assert.deepEqual(replay, receipt);
      console.log(JSON.stringify({ preview, receipt, replay }));
    }
  } finally {
    dateCompanionDatabase.close();
    memoryDatabase.close();
  }
}

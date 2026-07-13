import { migrateLegacyMemoryIndex } from "../src/lib/server/memory/migration";

const result = await migrateLegacyMemoryIndex();

console.info(
  `[memory:migrate] users=${result.usersScanned} uploads=${result.uploadsScanned} indexed=${result.uploadsIndexed} skipped=${result.uploadsSkipped} failed=${result.uploadsFailed} memories=${result.memoriesIndexed}`
);

if (result.uploadsFailed > 0) {
  process.exitCode = 1;
}

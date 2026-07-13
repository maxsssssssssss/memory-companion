import { upgradeMemoryIndex } from "../src/lib/server/memory/upgrade";

const result = await upgradeMemoryIndex();

console.info(
  `[memory:upgrade] users=${result.usersProcessed} before=${result.memoriesBefore} after=${result.memoriesAfter} merged=${result.duplicatesMerged} relations=${result.relations} failures=${result.failures}`
);

if (result.failures > 0) {
  process.exitCode = 1;
}

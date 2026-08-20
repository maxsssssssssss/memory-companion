import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import {
  DateCompanionMemoryBridgePreflightConfigurationError,
  inspectDateCompanionMemoryBridgePreflight,
  migrateAndInspectDateCompanionMemoryBridge,
  resolveDateCompanionMemoryBridgePreflightDataDirectory
} from "@/lib/server/date-companion/memory-bridge-preflight";

export type DateCompanionMemoryBridgePreflightCliOptions = {
  help: boolean;
  migrate: boolean;
};

export function parseDateCompanionMemoryBridgePreflightArgs(
  argv: string[]
): DateCompanionMemoryBridgePreflightCliOptions {
  const options: DateCompanionMemoryBridgePreflightCliOptions = {
    help: false,
    migrate: false
  };
  for (const argument of argv) {
    if (argument === "--help") {
      options.help = true;
    } else if (argument === "--migrate") {
      options.migrate = true;
    } else {
      throw new DateCompanionMemoryBridgePreflightConfigurationError(
        "preflight_argument_invalid"
      );
    }
  }
  return options;
}

function printHelp() {
  console.info(`Usage: npx --no-install tsx scripts/date-companion-memory-bridge-preflight.ts [--migrate]

Default mode is strictly read-only. It verifies APP_DATA_DIR storage, exact
Date Companion/Memory schema sequences, foreign keys, and SQLite integrity.

--migrate  Explicitly apply the existing schema migrations, then run the same
           read-only verification. Both database files must already exist.`);
}

function failureCode(error: unknown) {
  return error instanceof DateCompanionMemoryBridgePreflightConfigurationError
    ? error.code
    : "preflight_unexpected_error";
}

export function runDateCompanionMemoryBridgePreflightCli(input: {
  argv: string[];
  env?: Readonly<Record<string, string | undefined>>;
}) {
  const options = parseDateCompanionMemoryBridgePreflightArgs(input.argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const dataDirectory = resolveDateCompanionMemoryBridgePreflightDataDirectory(
    input.env ?? process.env
  );
  const report = options.migrate
    ? migrateAndInspectDateCompanionMemoryBridge({ dataDirectory })
    : inspectDateCompanionMemoryBridgePreflight({ dataDirectory });
  console.info(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    loadRuntimeEnv();
    process.exitCode = runDateCompanionMemoryBridgePreflightCli({
      argv: process.argv.slice(2)
    });
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      errorCodes: [failureCode(error)]
    }));
    process.exitCode = 1;
  }
}

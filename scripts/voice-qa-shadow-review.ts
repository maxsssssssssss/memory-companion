import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import { getUserScopedStore } from "@/lib/server/auth/session";
import {
  exportVoiceQaShadowReviewReports
} from "@/lib/server/evaluation/voice-qa-shadow-review-export";
import {
  attachVoiceQaShadowQuestionInputs,
  buildVoiceQaShadowGoldTemplate,
  generateVoiceQaShadowBlindReview,
  importVoiceQaShadowBlindReview,
  importVoiceQaShadowFaultRuns,
  importVoiceQaShadowGold,
  replayVoiceQaShadowReviewCases,
  voiceQaShadowReviewStatus
} from "@/lib/server/evaluation/voice-qa-shadow-review-operations";
import {
  VoiceQaShadowReviewRepository
} from "@/lib/server/evaluation/voice-qa-shadow-review-repository";

export type VoiceQaShadowReviewCommand =
  | "status"
  | "attach-question"
  | "replay"
  | "gold-template"
  | "gold-import"
  | "blind-generate"
  | "blind-review-import"
  | "fault-import"
  | "export";

export type VoiceQaShadowReviewCliOptions = {
  command: VoiceQaShadowReviewCommand;
  userId: string;
  dataRoot?: string;
  inputPath?: string;
  outputDirectory?: string;
  caseIds: string[];
};

const COMMANDS = new Set<VoiceQaShadowReviewCommand>([
  "status",
  "attach-question",
  "replay",
  "gold-template",
  "gold-import",
  "blind-generate",
  "blind-review-import",
  "fault-import",
  "export"
]);

const IMPORT_COMMANDS = new Set<VoiceQaShadowReviewCommand>([
  "attach-question",
  "gold-import",
  "blind-review-import",
  "fault-import"
]);

export function voiceQaShadowReviewCliHelp() {
  return `Usage:
  npm run voice-qa:shadow-review -- <command> --user <user-id> [options]

Commands:
  status
  attach-question --input <private-json>
  replay [--case <case-id>]...
  gold-template [--case <case-id>]... [--output <private-json-path>]
  gold-import --input <private-json>
  blind-generate [--case <case-id>]...
  blind-review-import --input <private-json>
  fault-import --input <private-json>
  export [--output <ignored-evaluation-directory>]

Options:
  --data-root <path>  Defaults to APP_DATA_DIR or .data.

Normal output contains only case IDs, hashes, counts, statuses, and field names.
`;
}

function requiredValue(argv: readonly string[], index: number, argument: string) {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${argument}`);
  }
  return value;
}

export function parseVoiceQaShadowReviewArgs(
  argv: readonly string[]
): VoiceQaShadowReviewCliOptions {
  const command = argv[0] as VoiceQaShadowReviewCommand | undefined;
  if (!command || !COMMANDS.has(command)) {
    throw new Error(voiceQaShadowReviewCliHelp());
  }
  let userId: string | undefined;
  let dataRoot: string | undefined;
  let inputPath: string | undefined;
  let outputDirectory: string | undefined;
  const caseIds: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = requiredValue(argv, index, argument);
    index += 1;
    if (argument === "--user") userId = value;
    else if (argument === "--data-root") dataRoot = resolve(value);
    else if (argument === "--input") inputPath = resolve(value);
    else if (argument === "--output") outputDirectory = resolve(value);
    else if (argument === "--case") caseIds.push(value);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!userId) throw new Error("--user is required");
  if (!/^[A-Za-z0-9_-]+$/u.test(userId)) {
    throw new Error("Invalid --user");
  }
  if (IMPORT_COMMANDS.has(command) && !inputPath) {
    throw new Error(`--input is required for ${command}`);
  }
  if (!IMPORT_COMMANDS.has(command) && inputPath) {
    throw new Error(`--input is not supported for ${command}`);
  }
  if (
    command !== "export" &&
    command !== "gold-template" &&
    command !== "blind-generate" &&
    outputDirectory
  ) {
    throw new Error(`--output is not supported for ${command}`);
  }
  if (
    command !== "replay" &&
    command !== "gold-template" &&
    command !== "blind-generate" &&
    caseIds.length > 0
  ) {
    throw new Error(`--case is not supported for ${command}`);
  }
  return {
    command,
    userId,
    ...(dataRoot ? { dataRoot } : {}),
    ...(inputPath ? { inputPath } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    caseIds
  };
}

async function readPrivateJson(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Private JSON could not be read: ${
        error instanceof SyntaxError ? "invalid_json" : "read_failed"
      }`
    );
  }
}

export async function runVoiceQaShadowReviewCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
) {
  const options = parseVoiceQaShadowReviewArgs(argv);
  if (options.dataRoot) environment.APP_DATA_DIR = options.dataRoot;
  loadRuntimeEnv();
  const repository = new VoiceQaShadowReviewRepository({
    userId: options.userId,
    ...(options.dataRoot ? { dataRoot: options.dataRoot } : {})
  });
  try {
    if (options.command === "status") {
      const status = voiceQaShadowReviewStatus(repository);
      console.info(JSON.stringify(status));
      return status;
    }
    if (options.command === "replay") {
      const result = await replayVoiceQaShadowReviewCases(repository, {
        userId: options.userId,
        ...(options.caseIds.length > 0 ? { caseIds: options.caseIds } : {}),
        onProgress(progress) {
          console.info(
            `[voice-qa-shadow-review] replay=${progress.completed}/${progress.total} ` +
            `case_id=${progress.caseId} status=${progress.status}`
          );
        }
      });
      console.info(JSON.stringify(result));
      if (result.failedCount > 0) process.exitCode = 2;
      return result;
    }
    if (options.command === "blind-generate") {
      if (repository.filePath === ":memory:") {
        throw new Error("Blind generation requires a file-backed private database");
      }
      const result = await generateVoiceQaShadowBlindReview(repository, {
        userId: options.userId,
        settingsStore: getUserScopedStore(
          options.userId,
          options.dataRoot
        ),
        ...(options.caseIds.length > 0 ? { caseIds: options.caseIds } : {}),
        onProgress(progress) {
          console.info(
            `[voice-qa-shadow-review] blind_generate=` +
            `${progress.completed}/${progress.total} ` +
            `case_id=${progress.caseId} status=${progress.status}`
          );
        }
      });
      let outputPath: string | null = null;
      let fileHash: string | null = null;
      if (result.template && result.completedCount > 0) {
        const privateDirectory = resolve(
          dirname(repository.filePath),
          "voice-qa-shadow-review-v1"
        );
        outputPath = resolve(
          options.outputDirectory ??
          join(
            privateDirectory,
            `blind-review-template-${Date.now().toString(36)}.json`
          )
        );
        const relativeOutput = relative(privateDirectory, outputPath);
        if (
          relativeOutput.startsWith("..") ||
          resolve(privateDirectory, relativeOutput) !== outputPath
        ) {
          throw new Error(
            "Blind review output must stay in the user-private review directory"
          );
        }
        const content = `${JSON.stringify(result.template, null, 2)}\n`;
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, {
          encoding: "utf8",
          flag: "wx"
        });
        fileHash = createHash("sha256").update(content).digest("hex");
      }
      const summary = {
        totalCount: result.totalCount,
        completedCount: result.completedCount,
        failedCount: result.failedCount,
        providerCallCount: result.providerCallCount,
        generatedSystemCount: result.generatedSystemCount ?? 0,
        generationPerformed: result.generationPerformed,
        failures: result.failures,
        outputPath,
        fileHash
      };
      console.info(JSON.stringify(summary));
      if (result.failedCount > 0) process.exitCode = 2;
      return summary;
    }
    if (options.command === "gold-template") {
      if (repository.filePath === ":memory:") {
        throw new Error("Gold template requires a file-backed private database");
      }
      const privateDirectory = resolve(
        dirname(repository.filePath),
        "voice-qa-shadow-review-v1"
      );
      const outputPath = resolve(
        options.outputDirectory ??
        join(
          privateDirectory,
          `gold-template-${Date.now().toString(36)}.json`
        )
      );
      const relativeOutput = relative(privateDirectory, outputPath);
      if (
        relativeOutput.startsWith("..") ||
        resolve(privateDirectory, relativeOutput) !== outputPath
      ) {
        throw new Error(
          "Gold template output must stay in the user-private review directory"
        );
      }
      const template = buildVoiceQaShadowGoldTemplate(repository, {
        ...(options.caseIds.length > 0 ? { caseIds: options.caseIds } : {})
      });
      const content = `${JSON.stringify(template, null, 2)}\n`;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, content, { encoding: "utf8", flag: "wx" });
      const result = {
        caseCount: template.caseCount,
        outputPath,
        fileHash: createHash("sha256").update(content).digest("hex")
      };
      console.info(JSON.stringify(result));
      return result;
    }
    if (options.command === "export") {
      const result = await exportVoiceQaShadowReviewReports(repository, {
        ...(options.outputDirectory
          ? { outputDirectory: options.outputDirectory }
          : {}),
        ...(options.dataRoot ? { dataRoot: options.dataRoot } : {})
      });
      console.info(JSON.stringify({
        reviewStatus: result.reviewStatus,
        outputDirectory: result.outputDirectory,
        fileCount: Object.keys(result.files).length
      }));
      return result;
    }

    const privateInput = await readPrivateJson(options.inputPath!);
    const result =
      options.command === "attach-question"
        ? attachVoiceQaShadowQuestionInputs(repository, privateInput)
        : options.command === "gold-import"
          ? importVoiceQaShadowGold(repository, privateInput)
          : options.command === "blind-review-import"
            ? importVoiceQaShadowBlindReview(repository, privateInput)
            : importVoiceQaShadowFaultRuns(repository, privateInput);
    console.info(JSON.stringify(result));
    return result;
  } finally {
    repository.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runVoiceQaShadowReviewCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `[voice-qa-shadow-review] status=failed ` +
      `error_name=${error instanceof Error ? error.name : "unknown"} ` +
      `message=${error instanceof Error ? error.message : "unknown"}`
    );
    process.exitCode = 1;
  });
}

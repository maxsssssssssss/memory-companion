import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  evaluateSpeakerIdentityArtifacts,
  loadSpeakerIdentityEvaluationArtifacts
} from "@/lib/server/speaker-identity/evaluation";

export type SpeakerIdentityEvaluationCliOptions = {
  dataDir: string;
  uploadId: string;
  reportPath: string;
};

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseSpeakerIdentityEvaluationArgs(argv: string[]): SpeakerIdentityEvaluationCliOptions {
  const options: Partial<SpeakerIdentityEvaluationCliOptions> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--data-dir", "--upload-id", "--report"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}. This evaluator is offline-only.`);
    }
    const value = requiredValue(argv, index, argument);
    index += 1;
    if (argument === "--data-dir") options.dataDir = value;
    else if (argument === "--upload-id") options.uploadId = value;
    else options.reportPath = value;
  }
  const missing = [
    !options.dataDir ? "--data-dir" : null,
    !options.uploadId ? "--upload-id" : null,
    !options.reportPath ? "--report" : null
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) throw new Error(`Missing required arguments: ${missing.join(", ")}`);
  return options as SpeakerIdentityEvaluationCliOptions;
}

function isInside(parent: string, candidate: string) {
  const path = relative(parent, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export async function runSpeakerIdentityEvaluationCli(argv: string[]) {
  const options = parseSpeakerIdentityEvaluationArgs(argv);
  const artifacts = await loadSpeakerIdentityEvaluationArtifacts({
    dataDir: options.dataDir,
    uploadId: options.uploadId
  });
  const reportPath = resolve(options.reportPath);
  if (isInside(artifacts.dataDir, reportPath)) {
    throw new Error("--report must be outside the retained runtime data root");
  }
  const report = await evaluateSpeakerIdentityArtifacts({ artifacts });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        reportPath,
        uploadId: report.uploadId,
        actual: report.actual.summary,
        simulated: report.simulated.summary,
        simulatedOracle: report.simulated.oracle
      },
      null,
      2
    )}\n`
  );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runSpeakerIdentityEvaluationCli(process.argv.slice(2));
}

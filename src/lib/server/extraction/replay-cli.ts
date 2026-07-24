export type DailyBriefReplayCliEnvironment = Record<string, string | undefined>;

export type DailyBriefReplayCliOptions = {
  uploadId: string;
  dataDir: string;
  reportPath: string;
  remote: boolean;
  userId?: string;
};

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseDailyBriefReplayArgs(
  argv: string[],
  environment: DailyBriefReplayCliEnvironment = process.env
): DailyBriefReplayCliOptions {
  const options: Partial<DailyBriefReplayCliOptions> = { remote: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--remote") {
      options.remote = true;
      continue;
    }
    if (!["--upload-id", "--data-dir", "--report", "--user-id"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const value = requiredValue(argv, index, argument);
    index += 1;
    if (argument === "--upload-id") options.uploadId = value;
    else if (argument === "--data-dir") options.dataDir = value;
    else if (argument === "--report") options.reportPath = value;
    else if (argument === "--user-id") options.userId = value;
  }

  const missing = [
    !options.uploadId ? "--upload-id" : null,
    !options.dataDir ? "--data-dir" : null,
    !options.reportPath ? "--report" : null
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) {
    throw new Error(`Missing required arguments: ${missing.join(", ")}`);
  }
  if (options.remote && environment.RUN_DAILY_BRIEF_REMOTE_VERIFY !== "1") {
    throw new Error("--remote requires RUN_DAILY_BRIEF_REMOTE_VERIFY=1");
  }

  return options as DailyBriefReplayCliOptions;
}

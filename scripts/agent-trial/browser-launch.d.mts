export function chromiumLaunchOptions(env?: Record<string, string | undefined>, platform?: NodeJS.Platform): {
  headless: boolean;
  executablePath?: string;
  args?: string[];
};

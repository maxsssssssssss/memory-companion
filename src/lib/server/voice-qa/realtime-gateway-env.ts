import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

export type RealtimeGatewayEnvironmentLoadResult = {
  loaded: boolean;
  explicit: boolean;
};

/**
 * Loads the standalone development gateway environment without printing file
 * contents or resolved secrets. Existing shell variables retain Node's normal
 * precedence over values from the env file.
 */
export function loadRealtimeGatewayEnvironment(input: {
  environment?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  fileExists?: (path: string) => boolean;
  loadFile?: (path: string) => void;
} = {}): RealtimeGatewayEnvironmentLoadResult {
  const environment = input.environment ?? process.env;
  const configured = environment.VOICE_REALTIME_GATEWAY_ENV_FILE?.trim();
  const explicit = Boolean(configured);
  const path = resolve(input.cwd ?? process.cwd(), configured || ".env.local");
  const fileExists = input.fileExists ?? existsSync;
  if (!fileExists(path)) {
    if (explicit) {
      throw new Error("VOICE_REALTIME_GATEWAY_ENV_FILE does not exist");
    }
    return { loaded: false, explicit: false };
  }
  (input.loadFile ?? loadEnvFile)(path);
  return { loaded: true, explicit };
}

export async function loadRealtimeGatewayDependenciesAfterEnvironment<T>(
  loadDependencies: () => Promise<T>,
  input: Parameters<typeof loadRealtimeGatewayEnvironment>[0] = {}
) {
  loadRealtimeGatewayEnvironment(input);
  return await loadDependencies();
}

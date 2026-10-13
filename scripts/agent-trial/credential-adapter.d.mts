export function trialCredentialEnvironment(input: Readonly<Record<string, string | undefined>>, options?: {
  real?: boolean; credentialEnv?: string;
}): { OPENAI_API_KEY: string; LEARNING_AGENT_API_KEY: string };
export function credentialSelection(args: readonly string[]): string | undefined;

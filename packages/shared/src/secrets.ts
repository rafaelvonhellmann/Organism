// Secrets loading — environment variables ONLY.
// Never load secrets from disk. Set them in your shell or .env file
// (loaded by your process manager / dotenv, NOT read by this module).
//
// Each agent's CLAUDE.md declares its required secrets in a ## Required Secrets section.
// scripts/health-check.ts verifies all declared secrets are present before any agent starts.

export function getSecret(key: string): string {
  const value = process.env[key];
  if (value) return value;

  throw new Error(
    `Secret '${key}' not found. Set it as an environment variable. ` +
    `Error code: E202 (SECRET_MISSING)`
  );
}

export function getSecretOrNull(key: string): string | null {
  return process.env[key] ?? null;
}

// Verify a list of required secrets exist — called by health-check.ts before any agent starts
export function requireSecrets(keys: string[]): void {
  const missing: string[] = [];
  for (const key of keys) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets: ${missing.join(', ')}. ` +
      `Add them as environment variables before running agents.`
    );
  }
}

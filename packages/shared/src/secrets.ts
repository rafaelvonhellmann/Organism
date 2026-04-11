// Secrets loading — environment variables first, with local runtime bootstrap
// support for `.secrets.json` in the workspace root. This keeps the CLI,
// daemon, and health checks consistent on Rafael's machine while still
// preferring explicit environment variables.
//
// Each agent's CLAUDE.md declares its required secrets in a ## Required Secrets
// section. scripts/health-check.ts verifies all declared secrets are present
// before any agent starts.

import { bootstrapRuntimeEnv } from './runtime-env.js';

export function getSecret(key: string): string {
  bootstrapRuntimeEnv();
  const value = process.env[key];
  if (value) return value;

  throw new Error(
    `Secret '${key}' not found. Set it as an environment variable. ` +
    `Error code: E202 (SECRET_MISSING)`
  );
}

export function getSecretOrNull(key: string): string | null {
  bootstrapRuntimeEnv();
  return process.env[key] ?? null;
}

// Verify a list of required secrets exist — called by health-check.ts before any agent starts
export function requireSecrets(keys: string[]): void {
  bootstrapRuntimeEnv();
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

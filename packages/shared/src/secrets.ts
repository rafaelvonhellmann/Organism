import * as fs from 'fs';
import * as path from 'path';

// Secrets loading order:
// 1. Environment variables
// 2. Local .secrets.json (git-ignored, age-encrypted in practice)
// 3. HashiCorp Vault (when deployed to VPS)
//
// Each agent's CLAUDE.md declares its required secrets in a ## Required Secrets section.
// scripts/health-check.ts verifies all declared secrets are present before any agent starts.

interface SecretsFile {
  [key: string]: string;
}

let _cache: SecretsFile | null = null;

function loadSecretsFile(): SecretsFile {
  if (_cache) return _cache;
  const p = path.resolve(process.cwd(), '.secrets.json');
  if (fs.existsSync(p)) {
    try {
      _cache = JSON.parse(fs.readFileSync(p, 'utf8')) as SecretsFile;
      return _cache;
    } catch {
      // Malformed secrets file — fail loudly
      throw new Error('Failed to parse .secrets.json');
    }
  }
  _cache = {};
  return _cache;
}

export function getSecret(key: string): string {
  // 1. Environment variable
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;

  // 2. Local secrets file
  const file = loadSecretsFile();
  if (file[key]) return file[key];

  throw new Error(
    `Secret '${key}' not found. Set it as an environment variable or add it to .secrets.json. ` +
    `Error code: E202 (SECRET_MISSING)`
  );
}

export function getSecretOrNull(key: string): string | null {
  try { return getSecret(key); } catch { return null; }
}

// Verify a list of required secrets exist — called by health-check.ts before any agent starts
export function requireSecrets(keys: string[]): void {
  const missing: string[] = [];
  for (const key of keys) {
    try { getSecret(key); } catch { missing.push(key); }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets: ${missing.join(', ')}. ` +
      `Add them to environment variables or .secrets.json before running agents.`
    );
  }
}

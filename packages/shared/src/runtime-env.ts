import * as fs from 'fs';
import * as path from 'path';

export interface RuntimeEnvBootstrapResult {
  loaded: boolean;
  source: 'environment' | 'secrets-json' | 'missing';
  keysLoaded: string[];
}

let cachedResult: RuntimeEnvBootstrapResult | null = null;

const RUNTIME_DEFAULTS: Record<string, string> = {
  ORGANISM_MODEL_BACKEND: 'codex-first',
  ORGANISM_CODE_EXECUTOR: 'codex-first',
};

function candidatePaths(root: string): string[] {
  return [
    path.resolve(root, '.secrets.json'),
  ];
}

export function bootstrapRuntimeEnv(root = process.cwd()): RuntimeEnvBootstrapResult {
  if (cachedResult) {
    return cachedResult;
  }

  for (const candidate of candidatePaths(root)) {
    if (!fs.existsSync(candidate)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      const keysLoaded: string[] = [];
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'string' || process.env[key]) continue;
        process.env[key] = value;
        keysLoaded.push(key);
      }

      cachedResult = {
        loaded: true,
        source: 'secrets-json',
        keysLoaded,
      };
      for (const [key, value] of Object.entries(RUNTIME_DEFAULTS)) {
        if (!process.env[key] || process.env[key] === 'auto') {
          process.env[key] = value;
        }
      }
      return cachedResult;
    } catch {
      cachedResult = {
        loaded: false,
        source: 'missing',
        keysLoaded: [],
      };
      return cachedResult;
    }
  }

  cachedResult = {
    loaded: true,
    source: 'environment',
    keysLoaded: [],
  };
  for (const [key, value] of Object.entries(RUNTIME_DEFAULTS)) {
    if (!process.env[key] || process.env[key] === 'auto') {
      process.env[key] = value;
    }
  }
  return cachedResult;
}

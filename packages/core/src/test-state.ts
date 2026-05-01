import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export function configureTestState(metaUrl: string): string {
  const suitePath = fileURLToPath(metaUrl);
  const suiteName = path
    .relative(process.cwd(), suitePath)
    .replace(path.extname(suitePath), '')
    .replace(/[^a-zA-Z0-9._-]+/g, '__');
  const stateDir = path.resolve(process.cwd(), '.tmp', 'organism-test-state', suiteName, String(process.pid));
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  process.env.ORGANISM_STATE_DIR = stateDir;
  process.env.ORGANISM_DB_PATH = path.join(stateDir, 'tasks.db');
  return stateDir;
}

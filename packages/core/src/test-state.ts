import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export function configureTestState(metaUrl: string): string {
  const fileName = path.basename(fileURLToPath(metaUrl), path.extname(fileURLToPath(metaUrl)));
  const suiteName = fileName.replace(/\.test$/, '');
  const stateDir = path.resolve(process.cwd(), '.tmp', 'organism-test-state', suiteName, String(process.pid));
  fs.mkdirSync(stateDir, { recursive: true });
  process.env.ORGANISM_STATE_DIR = stateDir;
  process.env.ORGANISM_DB_PATH = path.join(stateDir, 'tasks.db');
  return stateDir;
}

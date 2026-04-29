import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const buildDir = resolve(import.meta.dirname, '..', '.next');

try {
  rmSync(buildDir, { recursive: true, force: true });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[dashboard-v2] Could not clean generated Next build output: ${message}`);
}

/**
 * Canonical state directory — lives OUTSIDE OneDrive to prevent SQLite corruption.
 * OneDrive + SQLite WAL = known corruption risk.
 *
 * All scripts must import this instead of hardcoding 'state/' paths.
 */
import * as path from 'path';

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '.';
const TEST_STATE_ROOT = path.join(process.cwd(), '.tmp', 'organism-test-state');

function isTestRuntime(): boolean {
  return process.argv.includes('--test') || process.env.NODE_ENV === 'test';
}

export const STATE_DIR = process.env.ORGANISM_STATE_DIR
  ?? (isTestRuntime() ? path.join(TEST_STATE_ROOT, String(process.pid)) : undefined)
  ?? path.resolve(HOME, '.organism', 'state');

export const DB_PATH = path.join(STATE_DIR, 'tasks.db');
export const PIDS_DIR = path.join(STATE_DIR, 'pids');
export const RUNS_DIR = path.join(STATE_DIR, 'runs');
export const EVENTS_DIR = path.join(STATE_DIR, 'events');
export const RUNTIME_EVENTS_LOG = path.join(EVENTS_DIR, 'runtime-events.jsonl');

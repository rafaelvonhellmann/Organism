/**
 * Runs SQLite migrations by initializing the database.
 * getDb() in task-queue.ts runs all migrations on first connection.
 */

import { getDb } from '../packages/core/src/task-queue.js';

const db = getDb();
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).all() as Array<{ name: string }>;

console.log('Database initialized. Tables:');
for (const t of tables) {
  console.log(`  - ${t.name}`);
}
console.log('\nMigration complete.');

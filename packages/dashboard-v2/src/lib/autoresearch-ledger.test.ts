import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { readAutoresearchLedgerFromFile, redactLedgerText } from './autoresearch-ledger';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), 'organism-autoresearch-'));
  tempDirs.push(dir);
  return join(dir, 'results.tsv');
}

test('missing autoresearch ledger returns an empty snapshot', () => {
  const snapshot = readAutoresearchLedgerFromFile(join(tmpdir(), 'missing-organism-ledger.tsv'));

  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.totalRuns, 0);
  assert.equal(snapshot.latest, null);
  assert.deepEqual(snapshot.entries, []);
});

test('parses newest ledger rows first with aggregate status counts', () => {
  const ledgerPath = tempLedger();
  writeFileSync(
    ledgerPath,
    [
      'timestamp\ttag\tprofile\tbranch\tcommit\tstatus\tscore\tduration_ms\tchanged_files\tchecks\tnotes',
      '2026-04-29T15:00:00.000Z\tfirst\tquick\tagent/test\tabc123\tneeds_rework\t0.750\t1000\t4\tTypeScript:pass; Build:fail:bad cache\tfirst row',
      '2026-04-29T16:00:00.000Z\tsecond\tfull\tagent/test\tdef456\tkeep_candidate\t1.000\t2000\t5\tTypeScript:pass; Build:pass\tsecond row',
    ].join('\n'),
    'utf8',
  );

  const snapshot = readAutoresearchLedgerFromFile(ledgerPath, { limit: 1 });

  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.totalRuns, 2);
  assert.equal(snapshot.keepCandidates, 1);
  assert.equal(snapshot.needsRework, 1);
  assert.equal(snapshot.averageScore, 0.875);
  assert.equal(snapshot.latest?.tag, 'second');
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].checks[1].status, 'pass');
});

test('redacts common secret-looking tokens from notes and check details', () => {
  const fakeOpenAiKey = `sk-${'1234567890abcdefghijklmnop'}`;
  const redacted = redactLedgerText(`failed with Bearer abcdefghijklmnopqrstuvwxyz and ${fakeOpenAiKey}`);

  assert.equal(redacted.includes('abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(redacted.includes(fakeOpenAiKey), false);
  assert.equal(redacted.includes('[redacted]'), true);
});

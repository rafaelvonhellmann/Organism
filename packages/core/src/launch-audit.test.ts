import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { clearLaunchAuditCache, getProjectLaunchAudit } from './launch-audit.js';

const originalCwd = process.cwd();
let tempDir = '';

describe('launch-audit', () => {
  beforeEach(() => {
    clearLaunchAuditCache();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organism-launch-audit-'));
    process.chdir(tempDir);
    fs.mkdirSync(path.join(tempDir, 'knowledge', 'projects', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'repo', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'knowledge', 'projects', 'demo', 'config.json'),
      JSON.stringify({
        id: 'demo',
        name: 'Demo',
        phase: 'BUILD',
        description: 'Demo project',
        techStack: ['next'],
        qualityStandards: [],
        riskOverrides: {},
        agents: { generalist: ['engineering'], specialist: [] },
        repoPath: path.join(tempDir, 'repo'),
        commands: {},
      }, null, 2),
      'utf8',
    );
  });

  afterEach(() => {
    clearLaunchAuditCache();
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('flags hardcoded secrets while still recognizing TypeScript and indexing', () => {
    fs.writeFileSync(path.join(tempDir, 'repo', 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }), 'utf8');
    fs.writeFileSync(
      path.join(tempDir, 'repo', 'src', 'db.sql'),
      'CREATE TABLE demo(id integer primary key);\nCREATE INDEX idx_demo_id ON demo(id);\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'repo', 'src', 'secrets.ts'),
      "export const apiKey = 'HARDCODED_PRODUCTION_API_KEY_1234567890';\n",
      'utf8',
    );

    const report = getProjectLaunchAudit('demo');
    const secrets = report.items.find((item) => item.id === 'no_hardcoded_api_keys');
    const typescript = report.items.find((item) => item.id === 'typescript');
    const indexing = report.items.find((item) => item.id === 'db_indexing');

    assert.equal(secrets?.status, 'fail');
    assert.equal(typescript?.status, 'pass');
    assert.equal(indexing?.status, 'pass');
  });

  it('does not treat generic session storage as token storage and detects env validation from env.ts', () => {
    fs.mkdirSync(path.join(tempDir, 'repo', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'repo', 'contexts'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'repo', 'docs'), { recursive: true });

    fs.writeFileSync(path.join(tempDir, 'repo', 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }), 'utf8');
    fs.writeFileSync(
      path.join(tempDir, 'repo', 'lib', 'env.ts'),
      [
        'function required(name: string): string {',
        '  const value = process.env[name];',
        '  if (!value) throw new Error(`Missing required environment variable: ${name}`);',
        '  return value;',
        '}',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'repo', 'contexts', 'ArkiContext.tsx'),
      [
        'const startedAt = sessionStorage.getItem("arki-session-started");',
        'sessionStorage.removeItem("arki-session-id");',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'repo', 'docs', 'billing.md'),
      'Stripe webhook verification should exist later.',
      'utf8',
    );

    const report = getProjectLaunchAudit('demo');
    const tokenStorage = report.items.find((item) => item.id === 'no_tokens_in_local_storage');
    const envValidation = report.items.find((item) => item.id === 'env_validation');
    const stripeVerification = report.items.find((item) => item.id === 'stripe_webhook_verification');

    assert.equal(tokenStorage?.status, 'pass');
    assert.equal(envValidation?.status, 'pass');
    assert.equal(stripeVerification?.status, 'na');
  });
});

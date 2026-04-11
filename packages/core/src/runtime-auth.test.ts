import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHubPullRequest,
  getPrAuthStatus,
  getVercelAuthStatus,
  parseGitHubRemote,
  resetRuntimeAuthCaches,
} from './runtime-auth.js';

const ORIGINAL_GH_TOKEN = process.env.GH_TOKEN;
const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORIGINAL_VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const ORIGINAL_VERCEL_ACCESS_TOKEN = process.env.VERCEL_ACCESS_TOKEN;

afterEach(() => {
  resetRuntimeAuthCaches();

  if (ORIGINAL_GH_TOKEN === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = ORIGINAL_GH_TOKEN;

  if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;

  if (ORIGINAL_VERCEL_TOKEN === undefined) delete process.env.VERCEL_TOKEN;
  else process.env.VERCEL_TOKEN = ORIGINAL_VERCEL_TOKEN;

  if (ORIGINAL_VERCEL_ACCESS_TOKEN === undefined) delete process.env.VERCEL_ACCESS_TOKEN;
  else process.env.VERCEL_ACCESS_TOKEN = ORIGINAL_VERCEL_ACCESS_TOKEN;
});

describe('runtime-auth', () => {
  it('parses GitHub https remotes cleanly', () => {
    const remote = parseGitHubRemote('https://github.com/rafaelvonhellmann/Organism.git');
    assert.deepEqual(remote, {
      owner: 'rafaelvonhellmann',
      repo: 'Organism',
      remoteUrl: 'https://github.com/rafaelvonhellmann/Organism.git',
    });
  });

  it('treats git credential manager as valid PR auth', () => {
    const status = getPrAuthStatus(
      'C:/repo',
      'https://github.com/rafaelvonhellmann/Organism.git',
      {
        commandExists: () => false,
        runSync: (command, args) => {
          if (command === 'git' && args[0] === 'credential') {
            return {
              status: 0,
              stdout: 'protocol=https\nhost=github.com\nusername=rafael\npassword=token\n',
              stderr: '',
            };
          }
          return { status: 1, stdout: '', stderr: 'unsupported' };
        },
        now: () => 0,
      },
    );

    assert.equal(status.ready, true);
    assert.equal(status.mode, 'git-credentials');
    assert.equal(status.credentialReady, true);
  });

  it('accepts an existing Vercel session when no token is present', () => {
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_ACCESS_TOKEN;

    const status = getVercelAuthStatus({
      commandExists: (command) => command === 'npx',
      runSync: (command, args) => {
        if (command === 'npx' && args.join(' ') === '--yes vercel@latest whoami') {
          return { status: 0, stdout: 'rafaelvonhellmann', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'unsupported' };
      },
      now: () => 0,
    });

    assert.equal(status.ready, true);
    assert.equal(status.mode, 'session');
    assert.equal(status.account, 'rafaelvonhellmann');
  });

  it('creates pull requests through the GitHub API when token auth is available', async () => {
    process.env.GH_TOKEN = 'test-token';

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await createGitHubPullRequest(
      {
        repoPath: 'C:/repo',
        branchName: 'agent/engineering/abcd1234/test',
        baseBranch: 'main',
        title: '[agent] agent/engineering/abcd1234/test',
        body: 'Autonomous change from Organism v2 controller',
      },
      {
        getPrAuthStatus: () => ({
          ready: true,
          mode: 'token',
          ghCliAvailable: false,
          ghAuthReady: false,
          tokenPresent: true,
          credentialReady: false,
          remote: {
            owner: 'rafaelvonhellmann',
            repo: 'Organism',
            remoteUrl: 'https://github.com/rafaelvonhellmann/Organism.git',
          },
          reason: null,
        }),
        fetchFn: async (url, init) => {
          requests.push({ url: String(url), init });
          if (String(url).includes('/pulls?')) {
            return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(
            JSON.stringify({ number: 42, html_url: 'https://github.com/rafaelvonhellmann/Organism/pull/42' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    );

    assert.equal(result.created, true);
    assert.equal(result.number, 42);
    assert.equal(result.mode, 'token');
    assert.equal(requests.length, 2);
    assert.match(String((requests[1].init?.headers as Record<string, string>).Authorization), /^Bearer /);
  });
});

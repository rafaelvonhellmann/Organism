import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export type CodeExecutorKind = 'claude' | 'codex';
export type CodeExecutorPreference = CodeExecutorKind | 'auto';

export interface CodeExecutorStatus {
  preferred: CodeExecutorPreference;
  selected: CodeExecutorKind;
  available: Record<CodeExecutorKind, boolean>;
}

export interface CodeExecutionParams {
  cwd: string;
  prompt: string;
  maxTurns?: number;
  preference?: CodeExecutorPreference;
}

export interface CodeExecutionResult {
  executor: CodeExecutorKind;
  text: string;
  rawOutput: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

function commandExists(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function availableExecutors(): Record<CodeExecutorKind, boolean> {
  return {
    claude: commandExists('claude'),
    codex: commandExists('codex'),
  };
}

export function resolveCodeExecutor(preference?: CodeExecutorPreference, available = availableExecutors()): CodeExecutorStatus {
  const requested = preference ?? (process.env.ORGANISM_CODE_EXECUTOR as CodeExecutorPreference | undefined) ?? 'auto';

  if (requested === 'claude' || requested === 'codex') {
    if (!available[requested]) {
      throw new Error(`Requested code executor "${requested}" is not available on PATH`);
    }
    return { preferred: requested, selected: requested, available };
  }

  if (available.claude) {
    return { preferred: 'auto', selected: 'claude', available };
  }
  if (available.codex) {
    return { preferred: 'auto', selected: 'codex', available };
  }

  throw new Error('No supported code executor found. Install Claude Code or Codex CLI, or set ORGANISM_CODE_EXECUTOR explicitly.');
}

function runClaudeExec(params: CodeExecutionParams): Promise<CodeExecutionResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--no-session-persistence',
      '--max-turns', String(params.maxTurns ?? 15),
    ];

    const child = spawn('claude', args, {
      cwd: params.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
      env: { ...process.env, CLAUDE_AUTO_ACCEPT: '1' },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude code executor timed out after 15 minutes'));
    }, 15 * 60 * 1000);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const rawOutput = `${stdout}${stderr}`.trim();

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude executor exited ${code}: ${stderr}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as { result?: string; text?: string; is_error?: boolean };
        if (parsed.is_error) {
          reject(new Error(parsed.result ?? 'Claude executor returned an error'));
          return;
        }
        resolve({
          executor: 'claude',
          text: parsed.result ?? parsed.text ?? stdout.trim(),
          rawOutput,
        });
      } catch {
        resolve({
          executor: 'claude',
          text: stdout.trim(),
          rawOutput,
        });
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`claude executor spawn error: ${error.message}`));
    });

    child.stdin.write(params.prompt);
    child.stdin.end();
  });
}

function runCodexExec(params: CodeExecutionParams): Promise<CodeExecutionResult> {
  return new Promise((resolve, reject) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'organism-codex-'));
    const outputFile = join(tempDir, 'last-message.txt');
    const args = [
      'exec',
      '-C', params.cwd,
      '--sandbox', 'workspace-write',
      '--ephemeral',
      '-o', outputFile,
      '-',
    ];

    const child = spawn('codex', args, {
      cwd: params.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
      env: { ...process.env },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('codex executor timed out after 15 minutes'));
    }, 15 * 60 * 1000);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const rawOutput = `${stdout}${stderr}`.trim();
        const outputExists = existsSync(outputFile);
        const text = outputExists ? readFileSync(outputFile, 'utf8').trim() : '';

        if (code !== 0 && !text) {
          reject(new Error(`codex executor exited ${code}: ${rawOutput}`));
          return;
        }
        resolve({
          executor: 'codex',
          text,
          rawOutput,
        });
      } catch (error) {
        reject(new Error(`codex executor failed to read output: ${error instanceof Error ? error.message : String(error)}`));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      rmSync(tempDir, { recursive: true, force: true });
      reject(new Error(`codex executor spawn error: ${error.message}`));
    });

    child.stdin.write(params.prompt);
    child.stdin.end();
  });
}

export function shouldFallbackFromClaudeExecutor(error: unknown): boolean {
  const message = errorMessage(error);
  return /credit balance is too low|rate limit|429|529|overloaded|RATE_LIMITED/i.test(message);
}

export function shouldFallbackFromCodexExecutor(error: unknown): boolean {
  const message = errorMessage(error);
  return /rate limit|429|403|401|unauthorized|login|quota|billing|credit|usage limit|insufficient/i.test(message);
}

export async function runCodeExecutor(params: CodeExecutionParams): Promise<CodeExecutionResult> {
  const executor = resolveCodeExecutor(params.preference);
  if (executor.preferred !== 'auto') {
    return executor.selected === 'codex' ? runCodexExec(params) : runClaudeExec(params);
  }

  if (executor.selected === 'claude') {
    try {
      return await runClaudeExec(params);
    } catch (error) {
      if (executor.available.codex && shouldFallbackFromClaudeExecutor(error)) {
        console.warn(`[CodeExecutor] Claude failed (${errorMessage(error)}). Falling back to Codex.`);
        return runCodexExec(params);
      }
      throw error;
    }
  }

  try {
    return await runCodexExec(params);
  } catch (error) {
    if (executor.available.claude && shouldFallbackFromCodexExecutor(error)) {
      console.warn(`[CodeExecutor] Codex failed (${errorMessage(error)}). Falling back to Claude.`);
      return runClaudeExec(params);
    }
    throw error;
  }
}

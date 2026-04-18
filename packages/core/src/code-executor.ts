import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { resolveOpenAiModelSpec } from '../../../agents/_base/mcp-client.js';

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
  description?: string;
  workflowKind?: string;
  timeoutMs?: number;
  onHeartbeat?: (heartbeat: { executor: CodeExecutorKind; elapsedMs: number }) => void;
}

export interface CodeExecutionResult {
  executor: CodeExecutorKind;
  text: string;
  rawOutput: string;
}

type ExecutorFailureClass = 'credit' | 'rate_limit' | 'transport' | 'auth' | 'timeout' | 'generic';

const EXECUTOR_HEALTH_PATH = join(homedir(), '.organism', 'state', 'code-executor-health.json');
const executorCooldownUntil = new Map<CodeExecutorKind, number>();

function allowLegacyClaudeExecutorFallback(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ORGANISM_ALLOW_LEGACY_ANTHROPIC_FALLBACK ?? '');
}

function resolveCodexExecutorModel(): string {
  return process.env.ORGANISM_OPENAI_ENGINEERING_MODEL
    ?? process.env.ORGANISM_OPENAI_DEFAULT_MODEL
    ?? resolveOpenAiModelSpec('sonnet').cliModel;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

const MIN_EXECUTOR_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_EXECUTOR_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_EXECUTOR_TIMEOUT_MS = 45 * 60 * 1000;

function clampTimeoutMs(timeoutMs: number): number {
  return Math.min(MAX_EXECUTOR_TIMEOUT_MS, Math.max(MIN_EXECUTOR_TIMEOUT_MS, timeoutMs));
}

function formatTimeoutLabel(timeoutMs: number): string {
  const totalMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
  return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
}

export function resolveAdaptiveExecutorTimeout(params: Pick<CodeExecutionParams, 'description' | 'prompt' | 'workflowKind' | 'maxTurns' | 'timeoutMs'>): number {
  if (typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)) {
    return clampTimeoutMs(params.timeoutMs);
  }

  let timeoutMs = DEFAULT_EXECUTOR_TIMEOUT_MS;
  switch (params.workflowKind) {
    case 'review':
    case 'validate':
      timeoutMs = 15 * 60 * 1000;
      break;
    case 'plan':
      timeoutMs = 20 * 60 * 1000;
      break;
    case 'implement':
      timeoutMs = 25 * 60 * 1000;
      break;
    case 'recover':
      timeoutMs = 35 * 60 * 1000;
      break;
    default:
      timeoutMs = DEFAULT_EXECUTOR_TIMEOUT_MS;
      break;
  }

  const combinedContext = `${params.description ?? ''}\n${params.prompt}`.toLowerCase();
  if (
    combinedContext.includes('inspect the workspace')
    || combinedContext.includes('rerun the implementation')
    || combinedContext.includes('repo-review-brief')
    || combinedContext.includes('preserved worktree')
  ) {
    timeoutMs += 10 * 60 * 1000;
  }
  if ((params.prompt?.length ?? 0) > 8_000) {
    timeoutMs += 5 * 60 * 1000;
  }
  if ((params.maxTurns ?? 15) >= 20) {
    timeoutMs += 5 * 60 * 1000;
  }

  return clampTimeoutMs(timeoutMs);
}

function commandExists(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function resolveCommandPath(command: string): string {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Command "${command}" is not available on PATH`);
  }
  const candidates = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidates.length === 0) {
    throw new Error(`Unable to resolve command path for "${command}"`);
  }
  if (process.platform === 'win32') {
    const preferred = candidates.find((candidate) => /\.(cmd|bat|exe)$/i.test(candidate));
    if (preferred) return preferred;
  }
  return candidates[0]!;
}

function resolveWindowsShimCommand(resolved: string, args: string[]): { command: string; args: string[] } | null {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(resolved)) return null;

  try {
    const shim = readFileSync(resolved, 'utf8');
    const relativeTargets = [...shim.matchAll(/"%dp0%\\([^"]+)"/gi)]
      .map((match) => match[1]?.trim())
      .filter((target): target is string => Boolean(target));
    const target = relativeTargets.at(-1);
    if (!target) return null;

    const absoluteTarget = join(dirname(resolved), ...target.split('\\'));
    if (!existsSync(absoluteTarget)) return null;

    if (/\.js$/i.test(absoluteTarget)) {
      return {
        command: process.execPath,
        args: [absoluteTarget, ...args],
      };
    }

    if (/\.(exe|cmd|bat)$/i.test(absoluteTarget)) {
      return {
        command: absoluteTarget,
        args,
      };
    }
  } catch {
    // Fall back to the cmd.exe wrapper if the shim is not a recognizable npm launcher.
  }

  return null;
}

function spawnResolved(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const resolved = resolveCommandPath(command);
  const isWindowsCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  if (isWindowsCmd) {
    const shimTarget = resolveWindowsShimCommand(resolved, args);
    if (shimTarget) {
      return spawn(shimTarget.command, shimTarget.args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env,
      });
    }

    return spawn('cmd.exe', ['/d', '/s', '/c', resolved, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env,
    });
  }

  return spawn(resolved, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    env,
  });
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignore kill failures on already-closed processes.
    }
  }
}

function availableExecutors(): Record<CodeExecutorKind, boolean> {
  return {
    claude: commandExists('claude'),
    codex: commandExists('codex'),
  };
}

function loadExecutorCooldowns(): void {
  if (executorCooldownUntil.size > 0) return;
  if (!existsSync(EXECUTOR_HEALTH_PATH)) return;
  try {
    const raw = JSON.parse(readFileSync(EXECUTOR_HEALTH_PATH, 'utf8')) as Partial<Record<CodeExecutorKind, number>>;
    for (const executor of ['claude', 'codex'] as const) {
      const until = raw[executor];
      if (typeof until === 'number' && Number.isFinite(until) && until > Date.now()) {
        executorCooldownUntil.set(executor, until);
      }
    }
  } catch {
    // Ignore corrupted cooldown files and rebuild them on the next write.
  }
}

function persistExecutorCooldowns(): void {
  mkdirSync(join(homedir(), '.organism', 'state'), { recursive: true });
  const payload: Partial<Record<CodeExecutorKind, number>> = {};
  for (const [executor, until] of executorCooldownUntil.entries()) {
    if (until > Date.now()) {
      payload[executor] = until;
    }
  }
  writeFileSync(EXECUTOR_HEALTH_PATH, JSON.stringify(payload, null, 2));
}

function executorOnCooldown(executor: CodeExecutorKind): boolean {
  loadExecutorCooldowns();
  const until = executorCooldownUntil.get(executor);
  if (!until) return false;
  if (until <= Date.now()) {
    executorCooldownUntil.delete(executor);
    persistExecutorCooldowns();
    return false;
  }
  return true;
}

function clearExecutorCooldown(executor: CodeExecutorKind): void {
  loadExecutorCooldowns();
  if (!executorCooldownUntil.has(executor)) return;
  executorCooldownUntil.delete(executor);
  persistExecutorCooldowns();
}

function classifyExecutorFailure(error: unknown): ExecutorFailureClass {
  const message = errorMessage(error).toLowerCase();
  if (message.includes('credit balance is too low') || message.includes('insufficient') || message.includes('quota') || message.includes('billing')) {
    return 'credit';
  }
  if (message.includes('rate limit') || message.includes('429') || message.includes('529') || message.includes('usage limit')) {
    return 'rate_limit';
  }
  if (message.includes('unauthorized') || message.includes('401') || message.includes('403') || message.includes('login')) {
    return 'auth';
  }
  if (message.includes('timed out') || message.includes('timeout')) {
    return 'timeout';
  }
  if (message.includes('connection error') || message.includes('fetch failed') || message.includes('network error') || message.includes('spawn error')) {
    return 'transport';
  }
  return 'generic';
}

function executorCooldownMs(executor: CodeExecutorKind, failure: ExecutorFailureClass): number {
  switch (failure) {
    case 'credit':
      return executor === 'claude' ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000;
    case 'rate_limit':
      return 30 * 60 * 1000;
    case 'auth':
      return 60 * 60 * 1000;
    case 'timeout':
      return 20 * 60 * 1000;
    case 'transport':
      return 15 * 60 * 1000;
    default:
      return 10 * 60 * 1000;
  }
}

function markExecutorCooldown(executor: CodeExecutorKind, error: unknown): void {
  loadExecutorCooldowns();
  executorCooldownUntil.set(executor, Date.now() + executorCooldownMs(executor, classifyExecutorFailure(error)));
  persistExecutorCooldowns();
}

export function resolveCodeExecutor(preference?: CodeExecutorPreference, available = availableExecutors()): CodeExecutorStatus {
  const requested = preference ?? (process.env.ORGANISM_CODE_EXECUTOR as CodeExecutorPreference | undefined) ?? 'auto';

  if (requested === 'claude' || requested === 'codex') {
    if (!available[requested]) {
      throw new Error(`Requested code executor "${requested}" is not available on PATH`);
    }
    return { preferred: requested, selected: requested, available };
  }

  if (available.codex && !executorOnCooldown('codex')) {
    return { preferred: 'auto', selected: 'codex', available };
  }

  if (allowLegacyClaudeExecutorFallback()) {
    if (available.claude && !executorOnCooldown('claude')) {
      return { preferred: 'auto', selected: 'claude', available };
    }
  }

  if (available.codex) {
    return { preferred: 'auto', selected: 'codex', available };
  }

  if (allowLegacyClaudeExecutorFallback() && available.claude) {
    return { preferred: 'auto', selected: 'claude', available };
  }

  throw new Error(
    allowLegacyClaudeExecutorFallback()
      ? 'No supported code executor found. Install Codex CLI or explicitly enable a legacy Claude executor.'
      : 'No supported OpenAI code executor found. Install Codex CLI or set ORGANISM_CODE_EXECUTOR explicitly. Legacy Claude fallback is disabled.',
  );
}

function runClaudeExec(params: CodeExecutionParams): Promise<CodeExecutionResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--no-session-persistence',
      '--max-turns', String(params.maxTurns ?? 15),
    ];

    const child = spawnResolved('claude', args, params.cwd, { ...process.env, CLAUDE_AUTO_ACCEPT: '1' });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const startedAt = Date.now();
    const timeoutMs = resolveAdaptiveExecutorTimeout(params);
    const heartbeat = params.onHeartbeat
      ? setInterval(() => params.onHeartbeat?.({ executor: 'claude', elapsedMs: Date.now() - startedAt }), 15_000)
      : null;

    const timer = setTimeout(() => {
      if (heartbeat) clearInterval(heartbeat);
      killProcessTree(child.pid);
      reject(new Error(`claude code executor timed out after ${formatTimeoutLabel(timeoutMs)}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
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
      if (heartbeat) clearInterval(heartbeat);
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
    const codexModel = resolveCodexExecutorModel();
    const args = [
      'exec',
      '-C', params.cwd,
      '--sandbox', 'workspace-write',
      '--ephemeral',
      '--model', codexModel,
      '-o', outputFile,
      '-',
    ];

    const child = spawnResolved('codex', args, params.cwd, { ...process.env });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const startedAt = Date.now();
    const timeoutMs = resolveAdaptiveExecutorTimeout(params);
    const heartbeat = params.onHeartbeat
      ? setInterval(() => params.onHeartbeat?.({ executor: 'codex', elapsedMs: Date.now() - startedAt }), 15_000)
      : null;

    const timer = setTimeout(() => {
      if (heartbeat) clearInterval(heartbeat);
      killProcessTree(child.pid);
      reject(new Error(`codex executor timed out after ${formatTimeoutLabel(timeoutMs)}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
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
      if (heartbeat) clearInterval(heartbeat);
      rmSync(tempDir, { recursive: true, force: true });
      reject(new Error(`codex executor spawn error: ${error.message}`));
    });

    child.stdin.write(params.prompt);
    child.stdin.end();
  });
}

export function shouldFallbackFromClaudeExecutor(error: unknown): boolean {
  const message = errorMessage(error);
  return /credit balance is too low|rate limit|429|529|overloaded|RATE_LIMITED|spawn error|connection error|fetch failed|network error|timed out|timeout/i.test(message);
}

export function shouldFallbackFromCodexExecutor(error: unknown): boolean {
  const message = errorMessage(error);
  return /rate limit|429|403|401|unauthorized|login|quota|billing|credit|usage limit|insufficient|spawn error|connection error|fetch failed|network error|timed out|timeout/i.test(message);
}

export async function runCodeExecutor(params: CodeExecutionParams): Promise<CodeExecutionResult> {
  const executor = resolveCodeExecutor(params.preference);
  if (executor.preferred !== 'auto') {
    return executor.selected === 'codex' ? runCodexExec(params) : runClaudeExec(params);
  }

  if (executor.selected === 'claude') {
    try {
      const result = await runClaudeExec(params);
      clearExecutorCooldown('claude');
      return result;
    } catch (error) {
      if (executor.available.codex && shouldFallbackFromClaudeExecutor(error)) {
        markExecutorCooldown('claude', error);
        console.warn(`[CodeExecutor] Claude failed (${errorMessage(error)}). Falling back to Codex.`);
        const fallback = await runCodexExec(params);
        clearExecutorCooldown('codex');
        return fallback;
      }
      throw error;
    }
  }

  try {
    const result = await runCodexExec(params);
    clearExecutorCooldown('codex');
    return result;
  } catch (error) {
    if (allowLegacyClaudeExecutorFallback() && executor.available.claude && shouldFallbackFromCodexExecutor(error)) {
      markExecutorCooldown('codex', error);
      console.warn(`[CodeExecutor] Codex failed (${errorMessage(error)}). Falling back to Claude.`);
      const fallback = await runClaudeExec(params);
      clearExecutorCooldown('claude');
      return fallback;
    }
    throw error;
  }
}

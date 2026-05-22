/**
 * Sandboxed Python runner.
 *
 * Trust model: this is NOT a container/jail isolation primitive. It is a
 * `spawn('python3')` with a deliberately stripped environment so that LLM-
 * authored Python cannot read secrets out of process.env. Filesystem and
 * network are NOT isolated — the assumption is that the calling Discord
 * guild is a trusted boundary (mirroring the existing coding-agent risk
 * posture). See AGENTS.md / docs for the trust model.
 *
 * What this DOES protect against:
 *   - LLM reads EVENTBRITE_PRIVATE_TOKEN, GITHUB_APP_PRIVATE_KEY_PATH,
 *     DISCORD_TOKEN, GEMINI_API_KEY, etc. via os.environ → blocked
 *     (those env vars are not passed in)
 *
 * What this does NOT protect against:
 *   - Filesystem reads outside the working dir (e.g. /etc, ~/.ssh)
 *   - Network egress (open sockets to anywhere)
 *   - Resource exhaustion beyond the wall-clock timeout
 *
 * If you ever need real isolation, swap the spawn for `docker run --rm
 * --network=none --read-only --env-file /dev/null -v ...:ro python:3.12`
 * and the rest of this module stays the same.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunPythonOptions {
  /** Python source to execute. Passed via `-c`. */
  code: string;
  /** Hard wall-clock timeout in ms. Default 60s. */
  timeoutMs?: number;
  /** Cap on bytes captured per stream (stdout + stderr). Default 64 KB each. */
  maxBytes?: number;
  /** Additional environment variables to expose to the script (use sparingly). */
  env?: Record<string, string>;
}

export interface RunPythonResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Build the minimal env passed to the child. Only PATH/HOME/locale + caller
 * additions. Critically, all secrets in process.env are excluded.
 */
function buildSandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const [k, v] of Object.entries(extra)) {
    env[k] = v;
  }
  return env;
}

export async function runPython(opts: RunPythonOptions): Promise<RunPythonResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const cwd = await mkdtemp(join(tmpdir(), 'moomie-py-'));
  const t0 = Date.now();

  try {
    const child = spawn('python3', ['-I', '-c', opts.code], {
      cwd,
      env: buildSandboxEnv(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxBytes) {
        stdoutTruncated = true;
        return;
      }
      const room = maxBytes - stdoutBytes;
      if (chunk.length > room) {
        stdoutChunks.push(chunk.subarray(0, room));
        stdoutBytes += room;
        stdoutTruncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxBytes) {
        stderrTruncated = true;
        return;
      }
      const room = maxBytes - stderrBytes;
      if (chunk.length > room) {
        stderrChunks.push(chunk.subarray(0, room));
        stderrBytes += room;
        stderrTruncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    }).finally(() => clearTimeout(timer));

    return {
      exit_code: exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      duration_ms: Date.now() - t0,
      timed_out: timedOut,
      stdout_truncated: stdoutTruncated,
      stderr_truncated: stderrTruncated,
    };
  } finally {
    // Best-effort cleanup of scratch dir.
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

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
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

export interface RunPythonOptions {
  /** Python source to execute. Passed via `-c`. */
  code: string;
  /** Hard wall-clock timeout in ms. Default 60s. */
  timeoutMs?: number;
  /** Cap on bytes captured per stream (stdout + stderr). Default 64 KB each. */
  maxBytes?: number;
  /** Additional environment variables to expose to the script (use sparingly). */
  env?: Record<string, string>;
  /**
   * If set, scan the working directory after the script exits and return any
   * files whose extension matches. Used to surface CSV exports / chart PNGs
   * authored by the script back to the caller before the tmpdir is destroyed.
   */
  collectFiles?: {
    /** Lowercased extensions including the leading dot, e.g. ['.csv', '.png']. */
    extensions: string[];
    /** Max bytes per individual file. Defaults to 5 MB. Files larger than this are skipped. */
    maxBytesPerFile?: number;
    /** Max number of files returned. Defaults to 5. Extras are dropped. */
    maxFiles?: number;
  };
}

export interface CollectedFile {
  name: string;
  data: Buffer;
}

export interface RunPythonResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  /** Files matching `collectFiles.extensions` found in cwd after exit. */
  files?: CollectedFile[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_COLLECT_MAX_BYTES_PER_FILE = 5 * 1024 * 1024;
const DEFAULT_COLLECT_MAX_FILES = 5;

const TMP_PREFIX = 'moomie-py-';
/** Reap stale sandbox dirs older than this (1 hour). */
const STALE_REAP_AGE_MS = 60 * 60 * 1000;

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
    // Non-interactive matplotlib backend so scripts can savefig() without a display.
    MPLBACKEND: 'Agg',
  };
  for (const [k, v] of Object.entries(extra)) {
    env[k] = v;
  }
  return env;
}

/**
 * Reap any `moomie-py-*` scratch dirs left over in $TMPDIR from prior process
 * crashes (the normal path cleans up in a `finally`, but a SIGKILL or hard
 * crash mid-run could leak). Safe to call at startup; fire-and-forget.
 *
 * Only removes dirs older than STALE_REAP_AGE_MS so an in-flight sibling
 * runner is never touched.
 */
export async function reapStaleSandboxes(): Promise<{ reaped: number; bytesFreed: number }> {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { reaped: 0, bytesFreed: 0 };
  }
  const cutoff = Date.now() - STALE_REAP_AGE_MS;
  let reaped = 0;
  let bytesFreed = 0;
  for (const name of entries) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const full = join(root, name);
    try {
      const st = await stat(full);
      if (!st.isDirectory()) continue;
      if (st.mtimeMs > cutoff) continue;
      // Roughly account size before removal so we can log how much was freed.
      bytesFreed += await dirSize(full).catch(() => 0);
      await rm(full, { recursive: true, force: true });
      reaped++;
    } catch {
      // ignore — best-effort
    }
  }
  return { reaped, bytesFreed };
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir).catch(() => []);
  for (const e of entries) {
    const full = join(dir, e);
    const st = await stat(full).catch(() => null);
    if (!st) continue;
    if (st.isFile()) total += st.size;
    else if (st.isDirectory()) total += await dirSize(full);
  }
  return total;
}

export async function runPython(opts: RunPythonOptions): Promise<RunPythonResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const cwd = await mkdtemp(join(tmpdir(), TMP_PREFIX));
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

    const files = opts.collectFiles
      ? await collectFilesFromCwd(cwd, opts.collectFiles)
      : undefined;

    return {
      exit_code: exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      duration_ms: Date.now() - t0,
      timed_out: timedOut,
      stdout_truncated: stdoutTruncated,
      stderr_truncated: stderrTruncated,
      files,
    };
  } finally {
    // Best-effort cleanup of scratch dir.
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function collectFilesFromCwd(
  cwd: string,
  opts: NonNullable<RunPythonOptions['collectFiles']>,
): Promise<CollectedFile[]> {
  const wantExts = new Set(opts.extensions.map((e) => e.toLowerCase()));
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_COLLECT_MAX_BYTES_PER_FILE;
  const maxFiles = opts.maxFiles ?? DEFAULT_COLLECT_MAX_FILES;

  let entries: string[];
  try {
    entries = await readdir(cwd);
  } catch {
    return [];
  }

  const collected: CollectedFile[] = [];
  for (const name of entries) {
    if (collected.length >= maxFiles) break;
    if (!wantExts.has(extname(name).toLowerCase())) continue;
    const full = join(cwd, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      if (st.size > maxBytes) continue;
      collected.push({ name, data: await readFile(full) });
    } catch {
      // entry vanished or unreadable; skip
    }
  }
  return collected;
}

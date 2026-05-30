import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodingAgent, AgentTask, AgentResult, CodingProgress, ProgressCallback } from './agent-types.js';

const POLICY_PATH = path.resolve('policies', 'agent-sandbox.toml');

// Resolve the gemini binary from node_modules rather than relying on PATH
const require = createRequire(import.meta.url);
const GEMINI_BIN = path.resolve(path.dirname(require.resolve('@google/gemini-cli/package.json')), 'bundle', 'gemini.js');

// Gemini CLI writes a per-session transcript here. Long-running tool calls
// (e.g. `npx tsc` cold-installing typescript) don't produce stdout/stderr to
// the parent, but they DO append to this file between turns. Polling its mtime
// lets us distinguish "agent is hung" from "agent is mid-progress."
//
// We poll instead of using fs.watch({recursive:true}) because Gemini creates a
// per-project subdir (e.g. .../tmp/<project-hash>/chats/) on first run, and
// Linux inotify-based recursive watching doesn't reliably emit events for files
// inside subdirectories that were created AFTER the watcher was registered.
const GEMINI_TMP_DIR = path.join(os.homedir(), '.gemini', 'tmp');
const SESSION_POLL_INTERVAL = 15 * 1000;
// How often to tail the transcript for new progress (thoughts/tool calls).
// Faster than the idle poll so relayed updates feel live; the consumer is
// responsible for its own rate-limiting (e.g. GitHub comment edits).
const PROGRESS_POLL_INTERVAL = 5 * 1000;

function latestSessionMtime(): number {
  let latest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const m = fs.statSync(full).mtimeMs;
          if (m > latest) latest = m;
        }
      } catch {
        // entry vanished between readdir and stat; ignore
      }
    }
  };
  walk(GEMINI_TMP_DIR);
  return latest;
}

/** Path of the most-recently-modified `session-*.jsonl` transcript, if any. */
function latestSessionFile(): string | null {
  let latestPath: string | null = null;
  let latestMtime = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const m = fs.statSync(full).mtimeMs;
          if (m > latestMtime) {
            latestMtime = m;
            latestPath = full;
          }
        }
      } catch {
        // entry vanished between readdir and stat; ignore
      }
    }
  };
  walk(GEMINI_TMP_DIR);
  return latestPath;
}

/**
 * Map a parsed transcript record to a progress signal, or null if it carries
 * nothing worth relaying.
 *
 * Gemini CLI writes the session transcript as JSONL. The records we care about
 * have `type: "gemini"` and carry `thoughts` (`{subject, description}[]`) and/or
 * `toolCalls` (`{name, args:{title, summary}}[]`). We prefer the latest thought
 * subject (a tidy headline) and fall back to the latest tool-call title/name.
 * The parser is deliberately defensive: gemini-cli may change this shape on
 * upgrade, and a malformed record must never throw into the agent run.
 */
function recordToProgress(rec: unknown, startedAt: number): CodingProgress | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  if (r.type !== 'gemini') return null;
  const elapsedMs = Date.now() - startedAt;

  if (Array.isArray(r.thoughts) && r.thoughts.length > 0) {
    const t = r.thoughts[r.thoughts.length - 1] as Record<string, unknown> | undefined;
    if (t && typeof t.subject === 'string' && t.subject.trim()) {
      return {
        headline: t.subject.trim().slice(0, 200),
        detail: typeof t.description === 'string' ? t.description.trim().slice(0, 500) : undefined,
        elapsedMs,
      };
    }
  }

  if (Array.isArray(r.toolCalls) && r.toolCalls.length > 0) {
    const c = r.toolCalls[r.toolCalls.length - 1] as Record<string, unknown> | undefined;
    const args = (c?.args ?? {}) as Record<string, unknown>;
    const title = (typeof args.title === 'string' && args.title) || (typeof c?.name === 'string' && c.name) || '';
    if (title) {
      return {
        headline: String(title).trim().slice(0, 200),
        toolName: typeof c?.name === 'string' ? c.name : undefined,
        elapsedMs,
      };
    }
  }

  return null;
}

interface TranscriptTailer {
  /** Read any newly-appended records and emit progress for each. */
  poll(): void;
}

/**
 * Follows the newest gemini session transcript, emitting a {@link CodingProgress}
 * for each new `gemini` record. Tracks a byte offset so each poll only parses
 * freshly-appended bytes, and buffers a trailing partial line across polls.
 */
function createTranscriptTailer(startedAt: number, onProgress: ProgressCallback): TranscriptTailer {
  let currentFile: string | null = null;
  let offset = 0;
  let partial = '';

  return {
    poll(): void {
      const file = latestSessionFile();
      if (!file) return;
      if (file !== currentFile) {
        // A new session started — reset and read it from the top.
        currentFile = file;
        offset = 0;
        partial = '';
      }

      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        return;
      }
      if (size <= offset) return;

      let chunk: string;
      try {
        const fd = fs.openSync(file, 'r');
        const len = size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        fs.closeSync(fd);
        chunk = buf.toString('utf8');
        offset = size;
      } catch {
        return;
      }

      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? ''; // last element is an incomplete line (or '')
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // ignore malformed/partial records
        }
        const progress = recordToProgress(parsed, startedAt);
        if (progress) {
          try { onProgress(progress); } catch { /* consumer errors must not break the run */ }
        }
      }
    },
  };
}

export class GeminiAgent implements CodingAgent {
  name = 'Gemini CLI';

  async execute(task: AgentTask, workingDir: string, onProgress?: ProgressCallback): Promise<AgentResult> {
    const prompt = this.buildPrompt(task);

    try {
      const output = await this.runGemini(prompt, workingDir, onProgress);
      return {
        success: true,
        summary: output.slice(0, 2000) || 'Changes applied by Gemini CLI.',
      };
    } catch (err) {
      return {
        success: false,
        summary: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildPrompt(task: AgentTask): string {
    let prompt = task.prompt;
    prompt += '\n\nMake the necessary code changes directly. Do not ask questions — just implement the task.';
    return prompt;
  }

  private static IDLE_TIMEOUT = 5 * 60 * 1000;  // 5 min no output → kill
  private static MAX_TIMEOUT = 30 * 60 * 1000;  // 30 min hard cap

  private runGemini(prompt: string, cwd: string, onProgress?: ProgressCallback): Promise<string> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const model = process.env.GEMINI_MODEL;
      const args = ['--yolo', '--skip-trust', '--policy', POLICY_PATH, '-p', '-'];
      if (model) args.push('-m', model);

      const child = spawn(process.execPath, [GEMINI_BIN, ...args], {
        cwd,
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Write prompt via stdin to avoid shell quoting issues
      child.stdin.write(prompt);
      child.stdin.end();

      let stdout = '';
      let stderr = '';
      let settled = false;

      // Poll the gemini-cli session-transcript dir so writes to session-*.jsonl
      // count as progress, even when the agent's stdio is silent (e.g. blocked
      // on a slow `npx` install). fs.watch(recursive) is unreliable on Linux
      // for subdirs created after registration, so we poll mtimes instead.
      try { fs.mkdirSync(GEMINI_TMP_DIR, { recursive: true }); } catch { /* noop */ }
      let lastSessionMtime = latestSessionMtime();
      const sessionPoll = setInterval(() => {
        const m = latestSessionMtime();
        if (m > lastSessionMtime) {
          lastSessionMtime = m;
          resetIdle();
        }
      }, SESSION_POLL_INTERVAL);
      sessionPoll.unref();

      // When a caller wants live progress, tail the transcript content (not just
      // its mtime) and relay each new thought/tool step. Runs on a faster cadence
      // than the idle poll; the consumer rate-limits its own deliveries.
      let progressPoll: NodeJS.Timeout | undefined;
      if (onProgress) {
        const tailer = createTranscriptTailer(startedAt, onProgress);
        progressPoll = setInterval(() => tailer.poll(), PROGRESS_POLL_INTERVAL);
        progressPoll.unref();
      }

      const cleanupTimers = () => {
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
        clearInterval(sessionPoll);
        if (progressPoll) clearInterval(progressPoll);
      };

      const kill = (reason: string) => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
        reject(new Error(reason));
      };

      // Idle timeout — resets on stdout/stderr OR session-file activity
      let idleTimer = setTimeout(() => kill('Gemini CLI timed out (no output for 5 minutes)'), GeminiAgent.IDLE_TIMEOUT);
      const resetIdle = () => {
        if (settled) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => kill('Gemini CLI timed out (no output for 5 minutes)'), GeminiAgent.IDLE_TIMEOUT);
      };

      // Hard max timeout
      const maxTimer = setTimeout(() => kill('Gemini CLI timed out (30 minute maximum exceeded)'), GeminiAgent.MAX_TIMEOUT);

      child.stdout.on('data', (data) => { stdout += data.toString(); resetIdle(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); resetIdle(); });

      child.on('close', (code) => {
        cleanupTimers();
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Gemini CLI exited with code ${code}: ${stderr || stdout}`));
        }
      });

      child.on('error', (err) => {
        cleanupTimers();
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to spawn Gemini CLI: ${err.message}`));
      });
    });
  }
}

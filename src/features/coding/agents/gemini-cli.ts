import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodingAgent, AgentTask, AgentResult } from './agent-types.js';

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

export class GeminiAgent implements CodingAgent {
  name = 'Gemini CLI';

  async execute(task: AgentTask, workingDir: string): Promise<AgentResult> {
    const prompt = this.buildPrompt(task);

    try {
      const output = await this.runGemini(prompt, workingDir);
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

  private runGemini(prompt: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
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

      const cleanupTimers = () => {
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
        clearInterval(sessionPoll);
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

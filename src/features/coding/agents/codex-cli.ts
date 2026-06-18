import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { CodingAgent, AgentTask, AgentResult, CodingProgress, ProgressCallback } from './agent-types.js';

// Resolve the codex launcher from node_modules rather than relying on PATH.
// bin/codex.js is a Node ESM shim that selects the platform-native binary from
// the matching @openai/codex-<platform> optional dependency, so we run it with
// the current Node executable exactly like the Gemini agent does.
const require = createRequire(import.meta.url);
const CODEX_BIN = path.resolve(path.dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');

/**
 * Pull a usable progress signal out of a single codex `item.*` payload, or null
 * if the item carries nothing worth surfacing. The parser is deliberately
 * defensive: codex may evolve its event shapes between versions, and a
 * malformed/unknown item must never throw into the agent run.
 *
 * Codex `--json` item types include: command_execution, reasoning,
 * agent_message, file_change/patch, mcp_tool_call, web_search, todo_list.
 */
function itemToProgress(item: Record<string, unknown>, elapsedMs: number): CodingProgress | null {
  const firstLine = (v: unknown): string =>
    typeof v === 'string' ? v.split('\n').find((l) => l.trim())?.trim() ?? '' : '';

  switch (item.type) {
    case 'command_execution': {
      const cmd = typeof item.command === 'string' ? item.command.trim() : '';
      return cmd ? { headline: `$ ${cmd}`.slice(0, 200), toolName: 'shell', elapsedMs } : null;
    }
    case 'reasoning': {
      const text = firstLine(item.text);
      return text ? { headline: text.slice(0, 200), elapsedMs } : null;
    }
    case 'agent_message': {
      const text = firstLine(item.text);
      return text ? { headline: text.slice(0, 200), elapsedMs } : null;
    }
    case 'file_change':
    case 'patch': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>).path : undefined))
        .filter((p): p is string => typeof p === 'string');
      const headline = paths.length ? `Editing ${paths.slice(0, 3).join(', ')}` : 'Applying file changes';
      return { headline: headline.slice(0, 200), toolName: 'edit', elapsedMs };
    }
    case 'mcp_tool_call': {
      const name = item.tool ?? item.name ?? item.server;
      return name ? { headline: `Tool: ${String(name)}`.slice(0, 200), toolName: String(name), elapsedMs } : null;
    }
    case 'web_search': {
      const q = typeof item.query === 'string' ? item.query : '';
      return { headline: (q ? `Search: ${q}` : 'Web search').slice(0, 200), toolName: 'web_search', elapsedMs };
    }
    case 'todo_list': {
      const items = Array.isArray(item.items) ? item.items : [];
      const next = items
        .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>) : null))
        .find((t) => t && t.completed !== true);
      const text = next && typeof next.text === 'string' ? next.text : '';
      return text ? { headline: `Plan: ${text}`.slice(0, 200), toolName: 'plan', elapsedMs } : null;
    }
    default:
      return null;
  }
}

interface StreamState {
  /** Latest assistant message text — becomes the run summary. */
  lastAgentMessage: string;
  /** Captured error from a turn.failed / error event, if any. */
  turnError: string | null;
}

/**
 * Parses codex's JSONL stdout stream incrementally. Buffers a trailing partial
 * line across chunks, emits a {@link CodingProgress} for actionable items, and
 * records the final assistant message + any error into `state`.
 */
function createEventParser(startedAt: number, state: StreamState, onProgress?: ProgressCallback) {
  let partial = '';

  const handle = (ev: Record<string, unknown>): void => {
    const elapsedMs = Date.now() - startedAt;
    const item = (ev.item && typeof ev.item === 'object' ? ev.item : null) as Record<string, unknown> | null;

    switch (ev.type) {
      case 'item.started': {
        // Surface actions as they begin (command runs, searches, tool calls, plan).
        if (item && ['command_execution', 'web_search', 'mcp_tool_call', 'todo_list'].includes(String(item.type))) {
          const p = itemToProgress(item, elapsedMs);
          if (p && onProgress) try { onProgress(p); } catch { /* consumer errors must not break the run */ }
        }
        break;
      }
      case 'item.updated':
      case 'item.completed': {
        if (!item) break;
        // Text-bearing items only have their content once completed.
        if (['reasoning', 'agent_message', 'file_change', 'patch'].includes(String(item.type))) {
          const p = itemToProgress(item, elapsedMs);
          if (p && onProgress) try { onProgress(p); } catch { /* ignore consumer errors */ }
        }
        if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
          state.lastAgentMessage = item.text.trim();
        }
        break;
      }
      case 'turn.failed': {
        const err = ev.error;
        state.turnError = typeof err === 'string'
          ? err
          : err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string'
            ? String((err as Record<string, unknown>).message)
            : 'Codex turn failed';
        break;
      }
      case 'error': {
        state.turnError = typeof ev.message === 'string' ? ev.message : 'Codex reported an error';
        break;
      }
      default:
        break;
    }
  };

  return {
    push(chunk: string): void {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // ignore non-JSON lines (codex may interleave plain text)
        }
        if (parsed && typeof parsed === 'object') handle(parsed as Record<string, unknown>);
      }
    },
  };
}

export class CodexAgent implements CodingAgent {
  name = 'Codex CLI';

  async execute(task: AgentTask, workingDir: string, onProgress?: ProgressCallback): Promise<AgentResult> {
    const prompt = this.buildPrompt(task);
    try {
      const summary = await this.runCodex(prompt, workingDir, onProgress);
      return {
        success: true,
        summary: summary.slice(0, 2000) || 'Changes applied by Codex CLI.',
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
    return `${task.prompt}\n\nMake the necessary code changes directly. Do not ask questions — just implement the task.`;
  }

  private static IDLE_TIMEOUT = 5 * 60 * 1000;  // 5 min no output → kill
  private static MAX_TIMEOUT = 30 * 60 * 1000;  // 30 min hard cap

  private runCodex(prompt: string, cwd: string, onProgress?: ProgressCallback): Promise<string> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const model = process.env.CODEX_MODEL;
      const sandbox = process.env.CODEX_SANDBOX || 'workspace-write';

      // `exec -` reads the prompt from stdin (no shell-quoting issues); `--json`
      // streams JSONL events to stdout; `--ephemeral` skips session files;
      // `--ignore-user-config` keeps runs hermetic on dev/server boxes.
      const args = [
        CODEX_BIN, 'exec', '-',
        '--json',
        '--sandbox', sandbox,
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        '--color', 'never',
        '-C', cwd,
      ];
      if (model) args.push('-m', model);

      const child = spawn(process.execPath, args, {
        cwd,
        // Codex authenticates from CODEX_API_KEY for a single exec run; map it to
        // the bot's existing OPENAI_API_KEY so no separate login is required.
        env: { ...process.env, CODEX_API_KEY: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin.write(prompt);
      child.stdin.end();

      const state: StreamState = { lastAgentMessage: '', turnError: null };
      const parser = createEventParser(startedAt, state, onProgress);
      let stderr = '';
      let settled = false;

      const cleanupTimers = () => {
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
      };

      const kill = (reason: string) => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
        reject(new Error(reason));
      };

      let idleTimer = setTimeout(() => kill('Codex CLI timed out (no output for 5 minutes)'), CodexAgent.IDLE_TIMEOUT);
      const resetIdle = () => {
        if (settled) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => kill('Codex CLI timed out (no output for 5 minutes)'), CodexAgent.IDLE_TIMEOUT);
      };
      const maxTimer = setTimeout(() => kill('Codex CLI timed out (30 minute maximum exceeded)'), CodexAgent.MAX_TIMEOUT);

      child.stdout.on('data', (data) => { parser.push(data.toString()); resetIdle(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); resetIdle(); });

      child.on('close', (code) => {
        cleanupTimers();
        if (settled) return;
        settled = true;
        if (code === 0 && !state.turnError) {
          resolve(state.lastAgentMessage);
        } else {
          const detail = state.turnError || stderr.trim() || state.lastAgentMessage || `exit code ${code}`;
          reject(new Error(`Codex CLI failed: ${detail}`.slice(0, 1500)));
        }
      });

      child.on('error', (err) => {
        cleanupTimers();
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
      });
    });
  }
}

/**
 * Render a `ChatProgress` snapshot as Markdown for inline edit-in-place
 * display in Discord. Two surfaces:
 *
 *  - `renderLive(snap)`: the placeholder message during the turn.
 *    Shows the current thought + tool status. Replaced on each round.
 *
 *  - `renderTrail(snap)`: a post-completion spoiler block summarising the
 *    reasoning. Only attached for "interesting" turns (>=2 rounds, any tool
 *    call, or >5s elapsed) so cheap "hi" replies stay clean.
 */

import type { ChatProgress, RoundSnap, ToolCallSnap } from './handle-message.js';

/** Discord per-message hard limit is 2000. Leave a little headroom so the
 *  tail-marker and any trailing space don't push us over. */
const LIVE_MAX_CHARS = 1950;

/** True when the turn is worth showing a reasoning trail for. */
export function isInteresting(snap: ChatProgress): boolean {
  if (snap.rounds.length >= 2) return true;
  if (snap.rounds.some((r) => r.toolCalls.length > 0)) return true;
  if (snap.elapsedMs > 5000) return true;
  return false;
}

/** Render the live placeholder message during the turn. Thoughts are shown
 *  in full; if the running message exceeds Discord's per-message cap, we tail
 *  it so the most recent reasoning stays visible. The thread (posted at the
 *  end) holds the complete history. */
export function renderLive(snap: ChatProgress): string {
  if (snap.rounds.length === 0) {
    return '💭 _Thinking…_';
  }
  const lines: string[] = [];
  for (const r of snap.rounds) {
    if (r.thought) {
      lines.push(`💭 _${italicizeMultiline(r.thought)}_`);
    }
    if (r.text) {
      lines.push(r.text);
    }
    for (const tc of r.toolCalls) {
      lines.push(renderToolLine(tc));
    }
  }
  const body = lines.join('\n\n');
  if (body.length <= LIVE_MAX_CHARS) return body;
  // Tail: keep the last LIVE_MAX_CHARS, snap forward to the next newline so
  // we don't start mid-sentence, and prefix an ellipsis marker so the user
  // knows earlier content scrolled off (it's in the thread).
  const tailStart = body.length - LIVE_MAX_CHARS;
  const snapTo = body.indexOf('\n', tailStart);
  const start = snapTo > -1 && snapTo - tailStart < 200 ? snapTo + 1 : tailStart;
  return `_…earlier rounds in thread_\n\n${body.slice(start)}`;
}

/** Render the reasoning trail posted after the final reply (in a thread, or
 *  in DMs as a follow-up message). No spoiler wrapping — callers control
 *  presentation context. */
export function renderTrail(snap: ChatProgress): string {
  const rounds = snap.rounds.length;
  const sec = (snap.elapsedMs / 1000).toFixed(1);
  const lines: string[] = [`💭 **Reasoning** · ${rounds} round${rounds === 1 ? '' : 's'} · ${sec}s`];
  for (const r of snap.rounds) {
    lines.push('');
    lines.push(`**Round ${r.n}**`);
    if (r.thought) {
      lines.push(blockquote(r.thought));
    }
    if (r.text) {
      lines.push(blockquote(r.text));
    }
    for (const tc of r.toolCalls) {
      lines.push(renderToolLine(tc));
    }
  }
  return lines.join('\n');
}

function renderToolLine(tc: ToolCallSnap): string {
  const icon = tc.status === 'running' ? '⏳' : tc.status === 'done' ? '✓' : '❌';
  const time = tc.ms != null ? ` (${(tc.ms / 1000).toFixed(1)}s)` : '';
  const files = tc.filesProduced?.length ? ` · 📎 ${tc.filesProduced.join(', ')}` : '';
  // Inline-code the tool name; show first key arg as a hint (often a question/query).
  const hint = renderArgsHint(tc.args);
  return `🔧 \`${tc.name}\`${hint} ${icon}${time}${files}`;
}

function renderArgsHint(args: Record<string, unknown>): string {
  // Surface the most-useful single field for our existing tools.
  const candidate = (args.question ?? args.query ?? args.q ?? args.message) as unknown;
  if (typeof candidate !== 'string' || candidate.length === 0) return '';
  const short = truncate(candidate, 80).replace(/\s+/g, ' ');
  return ` _${short}_`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Italicise multi-line text by re-wrapping each paragraph in underscores. */
function italicizeMultiline(s: string): string {
  // `_…_` markdown breaks across newlines, so split on blank lines and italicise each chunk.
  return s
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => para.replace(/_/g, '\\_'))
    .join('_\n\n_');
}

function blockquote(s: string): string {
  return s.split('\n').map((l) => `> ${l}`).join('\n');
}

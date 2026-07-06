import { streamText, stepCountIs } from 'ai';
import { loadPrompt } from '../../prompts/load-prompt.js';
import { buildChatTools, type ChatFile } from './tools.js';
import { modelFor } from '../../config.js';
import { getModel, hasLlmKey } from '../../llm.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Chat');

const MAX_TOOL_ROUNDS = 12;

interface ChatMessage {
  userId: string;
  userName: string;
  channelId: string;
  channelName: string;
  content: string;
}

export interface ChatReply {
  text: string;
  /** Optional binary attachments produced by tools (e.g. analyze_eventbrite CSV/PNG outputs). */
  files?: ChatFile[];
  /** Diagnostic snapshot of the LLM trace — populated for every reply, used by callers that want to render a reasoning trail. */
  progress?: ChatProgress;
}

/** Per-tool-call state inside a round. */
export interface ToolCallSnap {
  toolCallId?: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  ms?: number;
  resultSummary?: string;
  filesProduced?: string[];
}

/** Snapshot of one tool-loop round. */
export interface RoundSnap {
  n: number;
  /** Joined text from any `thought: true` parts emitted in this round. */
  thought?: string;
  /** Non-thought, non-final narration text (rare but happens). */
  text?: string;
  toolCalls: ToolCallSnap[];
}

/** Progress payload passed to `onProgress`. */
export interface ChatProgress {
  rounds: RoundSnap[];
  /** Total elapsed ms since handleChatMessage started. */
  elapsedMs: number;
  done: boolean;
  /** Final text reply (only set when done). */
  finalText?: string;
  /** Error message if the turn ended in failure. */
  error?: string;
}

/** Callback the adapter passes in to receive live updates. */
export type OnChatProgress = (snap: ChatProgress) => void | Promise<void>;

/**
 * Handle a natural language message directed at Moomie.
 * Sends to the configured LLM with tool declarations, looping on tool calls
 * until a text response.
 */
export async function handleChatMessage(
  message: ChatMessage,
  onProgress?: OnChatProgress,
): Promise<ChatReply> {
  const startedAt = Date.now();
  const rounds: RoundSnap[] = [];
  let activeRound: RoundSnap | undefined;

  const ensureActiveRound = (): RoundSnap => {
    if (!activeRound) {
      activeRound = { n: rounds.length + 1, toolCalls: [] };
      rounds.push(activeRound);
    }
    return activeRound;
  };

  const emit = async (done: boolean, finalText?: string, error?: string): Promise<void> => {
    if (!onProgress) return;
    try {
      await onProgress({
        rounds,
        elapsedMs: Date.now() - startedAt,
        done,
        finalText,
        error,
      });
    } catch (err) {
      log.warn('onProgress callback threw:', err);
    }
  };
  if (!hasLlmKey()) {
    log.audit({
      type: 'chat',
      channel_id: message.channelId,
      channel_name: message.channelName,
      model: modelFor('chat'),
      input_summary: message.content.slice(0, 500),
      result: 'missing API key',
    });
    return { text: "I can't think right now — my API key is missing. 🐄" };
  }

  const today = new Date().toISOString().split('T')[0];
  const systemPrompt = loadPrompt('chat-system.md', {
    TODAY: today,
    USER_NAME: message.userName,
    USER_ID: message.userId,
    CHANNEL_NAME: message.channelName,
    CHANNEL_ID: message.channelId,
  });

  // Request-scoped file collector — tools push attachments here.
  const collectedFiles: ChatFile[] = [];
  const toolCtx = {
    userId: message.userId,
    channelId: message.channelId,
    userName: message.userName,
    files: collectedFiles,
  };

  const wrap = (text: string): ChatReply =>
    collectedFiles.length ? { text, files: collectedFiles } : { text };

  // Track cumulative token usage across tool-call steps so the final audit reflects the whole exchange
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  const toolsUsed: string[] = [];

  const auditChat = (result: string): void => {
    log.audit({
      type: 'chat',
      channel_id: message.channelId,
      channel_name: message.channelName,
      model: modelFor('chat'),
      input_summary: message.content.slice(0, 500),
      result,
      tokens_in: totalTokensIn || undefined,
      tokens_out: totalTokensOut || undefined,
    });
  };

  try {
    const result = streamText({
      model: getModel('chat'),
      system: systemPrompt,
      prompt: message.content,
      tools: buildChatTools(toolCtx),
      stopWhen: stepCountIs(MAX_TOOL_ROUNDS),
      // Surface the model's reasoning as a live "thinking…" trail where the
      // provider supports it (Gemini-only option; ignored by other providers).
      // Budget caps worst-case cost.
      providerOptions: {
        google: { thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 } },
      },
      onChunk: async ({ chunk }) => {
        const snap = ensureActiveRound();
        if (chunk.type === 'reasoning-delta') {
          snap.thought = (snap.thought ?? '') + chunk.text;
          await emit(false);
        } else if (chunk.type === 'text-delta') {
          snap.text = (snap.text ?? '') + chunk.text;
          await emit(false);
        } else if (chunk.type === 'tool-call') {
          upsertToolCall(snap, chunk.toolCallId, {
            toolCallId: chunk.toolCallId,
            name: chunk.toolName,
            args: (chunk.input ?? {}) as Record<string, unknown>,
            status: 'running',
          });
          await emit(false);
        } else if (chunk.type === 'tool-result') {
          upsertToolCall(snap, chunk.toolCallId, {
            toolCallId: chunk.toolCallId,
            name: chunk.toolName,
            args: (chunk.input ?? {}) as Record<string, unknown>,
            status: 'done',
            resultSummary: summarizeResult(chunk.output),
          });
          await emit(false);
        }
      },
      onStepFinish: async (step) => {
        totalTokensIn += step.usage?.inputTokens ?? 0;
        totalTokensOut += step.usage?.outputTokens ?? 0;
        for (const tc of step.toolCalls) toolsUsed.push(tc.toolName);
        const snap = ensureActiveRound();
        snap.thought = snap.thought?.trim() || step.reasoningText?.trim() || undefined;
        snap.text = snap.text?.trim() || (step.toolCalls.length > 0 && step.text ? step.text.trim() : undefined);
        snap.toolCalls = step.toolCalls.map((tc) => {
          const tr = step.toolResults.find((r) => r.toolCallId === tc.toolCallId);
          return {
            toolCallId: tc.toolCallId,
            name: tc.toolName,
            args: (tc.input ?? {}) as Record<string, unknown>,
            status: tr ? ('done' as const) : ('running' as const),
            resultSummary: tr ? summarizeResult(tr.output) : undefined,
          };
        });
        activeRound = undefined;
        await emit(false);
      },
      onError: ({ error }) => {
        log.error('Chat LLM stream error:', error);
      },
    });

    const reply = (await result.text).trim() || 'Moo.';
    const toolSummary = toolsUsed.length > 0 ? ` [tools: ${toolsUsed.join(', ')}]` : '';
    const fileSummary = collectedFiles.length > 0 ? ` [files: ${collectedFiles.map((f) => f.name).join(', ')}]` : '';
    auditChat(reply.slice(0, 500) + toolSummary + fileSummary);
    await emit(true, reply);
    const out = wrap(reply);
    out.progress = { rounds, elapsedMs: Date.now() - startedAt, done: true, finalText: reply };
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Chat LLM call failed:', err);
    auditChat(`API error: ${msg}`);
    await emit(true, undefined, `API error: ${msg}`);
    return wrap('Something went wrong talking to my brain. Try again? 🐄');
  }
}

/** Short, audit-friendly stringification of a tool result. */
function summarizeResult(result: unknown): string {
  try {
    const s = typeof result === 'string' ? result : JSON.stringify(result);
    return s.length > 500 ? s.slice(0, 500) + '…' : s;
  } catch {
    return String(result).slice(0, 500);
  }
}

function upsertToolCall(snap: RoundSnap, toolCallId: string, update: ToolCallSnap): void {
  const existing = snap.toolCalls.find((tc) => tc.toolCallId === toolCallId);
  if (existing) {
    Object.assign(existing, update);
  } else {
    snap.toolCalls.push(update);
  }
}

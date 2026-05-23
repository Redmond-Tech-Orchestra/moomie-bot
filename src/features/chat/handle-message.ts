import { loadPrompt } from '../../prompts/load-prompt.js';
import { toolDeclarations, executeTool, type ChatFile } from './tools.js';
import { MODEL_CHAT, geminiUrl } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Chat');

const MAX_TOOL_ROUNDS = 8;

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
 * Sends to Gemini with tool declarations, loops on function calls until a text response.
 */
export async function handleChatMessage(
  message: ChatMessage,
  onProgress?: OnChatProgress,
): Promise<ChatReply> {
  const startedAt = Date.now();
  const rounds: RoundSnap[] = [];

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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log.audit({
      type: 'chat',
      channel_id: message.channelId,
      channel_name: message.channelName,
      model: MODEL_CHAT,
      input_summary: message.content.slice(0, 500),
      result: 'missing GEMINI_API_KEY',
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

  // Build initial conversation
  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [
    { role: 'user', parts: [{ text: message.content }] },
  ];

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

  // Track cumulative token usage across tool-call rounds so the final audit reflects the whole exchange
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  const toolsUsed: string[] = [];

  const auditChat = (result: string): void => {
    log.audit({
      type: 'chat',
      channel_id: message.channelId,
      channel_name: message.channelName,
      model: MODEL_CHAT,
      input_summary: message.content.slice(0, 500),
      result,
      tokens_in: totalTokensIn || undefined,
      tokens_out: totalTokensOut || undefined,
    });
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callGemini(apiKey, systemPrompt, contents);

    if ('error' in response) {
      auditChat(`API error: ${response.error}`);
      await emit(true, undefined, `API error: ${response.error}`);
      return wrap("Something went wrong talking to my brain. Try again? 🐄");
    }

    totalTokensIn += response.data.usageMetadata?.promptTokenCount ?? 0;
    totalTokensOut += response.data.usageMetadata?.candidatesTokenCount ?? 0;

    const parts = response.data.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      auditChat('empty response (no parts)');
      await emit(true, undefined, 'empty response');
      return wrap("I got nothing back. Moo. 🐄");
    }

    // Split parts into thoughts / narration text / tool calls.
    const thoughtParts = parts.filter((p) => p.thought === true && typeof p.text === 'string');
    const textParts = parts.filter((p) => p.thought !== true && typeof p.text === 'string');
    const functionCalls = parts.filter((p) => p.functionCall);

    const snap: RoundSnap = {
      n: round + 1,
      thought: thoughtParts.length
        ? thoughtParts.map((p) => (p.text as string).trim()).join('\n\n')
        : undefined,
      text: functionCalls.length > 0 && textParts.length > 0
        ? textParts.map((p) => (p.text as string).trim()).join('\n\n')
        : undefined,
      toolCalls: functionCalls.map((p) => {
        const fc = p.functionCall as { name: string; args?: Record<string, unknown> };
        return { name: fc.name, args: fc.args || {}, status: 'running' as const };
      }),
    };
    rounds.push(snap);

    if (functionCalls.length === 0) {
      // Text response — we're done
      const textPart = parts.find((p) => p.thought !== true && typeof p.text === 'string');
      const reply = (textPart?.text as string) || "Moo.";
      const toolSummary = toolsUsed.length > 0 ? ` [tools: ${toolsUsed.join(', ')}]` : '';
      const fileSummary = collectedFiles.length > 0 ? ` [files: ${collectedFiles.map((f) => f.name).join(', ')}]` : '';
      auditChat(reply.slice(0, 500) + toolSummary + fileSummary);
      await emit(true, reply);
      const out = wrap(reply);
      out.progress = { rounds, elapsedMs: Date.now() - startedAt, done: true, finalText: reply };
      return out;
    }

    // Emit snapshot now so the adapter can show "thinking + running tool" while we wait.
    await emit(false);

    // Add model's response to conversation (verbatim — preserves thoughtSignature).
    contents.push({ role: 'model', parts });

    // Execute each function call and add results, updating snap as we go.
    const functionResponses: Array<Record<string, unknown>> = [];
    for (let i = 0; i < functionCalls.length; i++) {
      const part = functionCalls[i];
      const { name, args } = part.functionCall as { name: string; args: Record<string, unknown> };
      toolsUsed.push(name);
      const tStart = Date.now();
      let result: unknown;
      let ok = true;
      try {
        result = await executeTool(name, args || {}, toolCtx);
      } catch (err) {
        ok = false;
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      const ms = Date.now() - tStart;
      const filesBefore = snap.toolCalls[i].filesProduced?.length ?? 0;
      const newFiles = collectedFiles.slice(filesBefore).map((f) => f.name);
      snap.toolCalls[i] = {
        ...snap.toolCalls[i],
        status: ok ? 'done' : 'error',
        ms,
        resultSummary: summarizeResult(result),
        filesProduced: newFiles.length > 0 ? newFiles : undefined,
      };
      await emit(false);
      functionResponses.push({
        functionResponse: { name, response: { result } },
      });
    }

    contents.push({ role: 'user', parts: functionResponses });
  }

  auditChat(`tool loop limit reached (${MAX_TOOL_ROUNDS} rounds)${toolsUsed.length > 0 ? ` [tools: ${toolsUsed.join(', ')}]` : ''}`);
  await emit(true, undefined, `loop limit reached after ${MAX_TOOL_ROUNDS} rounds`);
  return wrap("I got stuck in a loop trying to figure that out. Can you rephrase? 🐄");
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

async function callGemini(
  apiKey: string,
  systemPrompt: string,
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
): Promise<{ data: GeminiResponse } | { error: string }> {
  try {
    const res = await fetch(`${geminiUrl(MODEL_CHAT)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: [{ functionDeclarations: toolDeclarations }],
        generationConfig: {
          // Surface the model's reasoning as `thought: true` parts so we can
          // render a live "thinking…" trail. Budget caps worst-case cost.
          thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      log.error(`Gemini API error ${res.status}:`, body);
      return { error: `${res.status} ${res.statusText}` };
    }

    return { data: await res.json() as GeminiResponse };
  } catch (err) {
    log.error('Gemini call failed:', err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<GeminiPart>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

interface GeminiPart {
  text?: string;
  /** Set to true on parts that are reasoning summaries (requires `includeThoughts`). */
  thought?: boolean;
  /** Opaque blob the model uses to maintain reasoning continuity; echoed back unchanged. */
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  [k: string]: unknown;
}

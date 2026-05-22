import { loadPrompt } from '../../prompts/load-prompt.js';
import { toolDeclarations, executeTool } from './tools.js';
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

/**
 * Handle a natural language message directed at Moomie.
 * Sends to Gemini with tool declarations, loops on function calls until a text response.
 */
export async function handleChatMessage(message: ChatMessage): Promise<string> {
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
    return "I can't think right now — my API key is missing. 🐄";
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

  const toolCtx = {
    userId: message.userId,
    channelId: message.channelId,
    userName: message.userName,
  };

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
      return "Something went wrong talking to my brain. Try again? 🐄";
    }

    totalTokensIn += response.data.usageMetadata?.promptTokenCount ?? 0;
    totalTokensOut += response.data.usageMetadata?.candidatesTokenCount ?? 0;

    const parts = response.data.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      auditChat('empty response (no parts)');
      return "I got nothing back. Moo. 🐄";
    }

    // Check for function calls
    const functionCalls = parts.filter((p: Record<string, unknown>) => p.functionCall);

    if (functionCalls.length === 0) {
      // Text response — we're done
      const textPart = parts.find((p: Record<string, unknown>) => p.text);
      const reply = (textPart?.text as string) || "Moo.";
      const toolSummary = toolsUsed.length > 0 ? ` [tools: ${toolsUsed.join(', ')}]` : '';
      auditChat(reply.slice(0, 500) + toolSummary);
      return reply;
    }

    // Add model's response to conversation
    contents.push({ role: 'model', parts });

    // Execute each function call and add results
    const functionResponses: Array<Record<string, unknown>> = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall as { name: string; args: Record<string, unknown> };
      toolsUsed.push(name);
      const result = await executeTool(name, args || {}, toolCtx);
      functionResponses.push({
        functionResponse: {
          name,
          response: { result },
        },
      });
    }

    contents.push({ role: 'user', parts: functionResponses });
  }

  auditChat(`tool loop limit reached (${MAX_TOOL_ROUNDS} rounds)${toolsUsed.length > 0 ? ` [tools: ${toolsUsed.join(', ')}]` : ''}`);
  return "I got stuck in a loop trying to figure that out. Can you rephrase? 🐄";
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
      parts?: Array<Record<string, unknown>>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

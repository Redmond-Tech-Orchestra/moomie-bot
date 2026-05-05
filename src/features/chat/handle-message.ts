import { loadPrompt } from '../../prompts/load-prompt.js';
import { toolDeclarations, executeTool } from './tools.js';
import { MODEL_CHAT, geminiUrl } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Chat');

const MAX_TOOL_ROUNDS = 5;

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
  if (!apiKey) return "I can't think right now — my API key is missing. 🐄";

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

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callGemini(apiKey, systemPrompt, contents);

    if (!response) return "Something went wrong talking to my brain. Try again? 🐄";

    const parts = response.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) return "I got nothing back. Moo. 🐄";

    // Check for function calls
    const functionCalls = parts.filter((p: Record<string, unknown>) => p.functionCall);

    if (functionCalls.length === 0) {
      // Text response — we're done
      const textPart = parts.find((p: Record<string, unknown>) => p.text);
      const reply = (textPart?.text as string) || "Moo.";
      log.audit({
        type: 'chat',
        channel_id: message.channelId,
        channel_name: message.channelName,
        model: MODEL_CHAT,
        input_summary: message.content.slice(0, 500),
        result: reply.slice(0, 500),
        tokens_in: response.usageMetadata?.promptTokenCount,
        tokens_out: response.usageMetadata?.candidatesTokenCount,
      });
      return reply;
    }

    // Add model's response to conversation
    contents.push({ role: 'model', parts });

    // Execute each function call and add results
    const functionResponses: Array<Record<string, unknown>> = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall as { name: string; args: Record<string, unknown> };
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

  return "I got stuck in a loop trying to figure that out. Can you rephrase? 🐄";
}

async function callGemini(
  apiKey: string,
  systemPrompt: string,
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
): Promise<GeminiResponse | null> {
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
      return null;
    }

    return await res.json() as GeminiResponse;
  } catch (err) {
    log.error('Gemini call failed:', err);
    return null;
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

/**
 * Provider-agnostic LLM access via the Vercel AI SDK.
 *
 * Selects a concrete model based on LLM_PROVIDER (config) and the logical role
 * (chat/extract/dedup). Each provider authenticates with a plain API key from
 * env — no OAuth/login flows:
 *   - gemini → GEMINI_API_KEY
 *   - openai → OPENAI_API_KEY
 */
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, type LanguageModel } from 'ai';
import { LLM_PROVIDER, modelFor, type LlmRole } from './config.js';

// Custom provider instances so we read the bot's existing env var names. The
// default @ai-sdk/google provider reads GOOGLE_GENERATIVE_AI_API_KEY; we map it
// to GEMINI_API_KEY to keep one key name across the codebase.
const googleProvider = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});
const openaiProvider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/** True when the API key for the selected provider is present in env. */
export function hasLlmKey(): boolean {
  switch (LLM_PROVIDER) {
    case 'openai':
      return !!process.env.OPENAI_API_KEY;
    case 'gemini':
      return !!process.env.GEMINI_API_KEY;
    default:
      return false;
  }
}

export function getModel(role: LlmRole): LanguageModel {
  const name = modelFor(role);
  switch (LLM_PROVIDER) {
    case 'openai':
      return openaiProvider(name);
    case 'gemini':
      return googleProvider(name);
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${LLM_PROVIDER}`);
  }
}

export interface LlmTextResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * One-shot text generation that works across providers. When `json` is set,
 * Gemini is pinned to JSON output via responseMimeType; for other providers the
 * prompt is expected to instruct JSON and the caller parses with parseJsonLoose.
 */
export async function generateLlmText(opts: {
  role: LlmRole;
  prompt: string;
  system?: string;
  json?: boolean;
}): Promise<LlmTextResult> {
  const { text, usage } = await generateText({
    model: getModel(opts.role),
    system: opts.system,
    prompt: opts.prompt,
    providerOptions: opts.json
      ? { google: { responseMimeType: 'application/json' } }
      : undefined,
  });
  return {
    text: text.trim(),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

/**
 * Parse a JSON payload from an LLM response, tolerating ```json code fences
 * that some providers wrap around structured output.
 */
export function parseJsonLoose<T>(text: string): T {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  return JSON.parse(s) as T;
}


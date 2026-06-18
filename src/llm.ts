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
import { generateObject, generateText, type LanguageModel } from 'ai';
import type { z } from 'zod';
import { LLM_PROVIDER, modelFor, type LlmRole } from './config.js';

// Custom provider instances so we read the bot's existing env var names. The
// default @ai-sdk/google provider reads GOOGLE_GENERATIVE_AI_API_KEY; we map it
// to GEMINI_API_KEY to keep one key name across the codebase.
const googleProvider = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});
const openaiProvider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // Optional override for OpenAI-compatible gateways (e.g. GitHub Models,
  // Azure OpenAI, a local Ollama). Leave unset to hit api.openai.com.
  baseURL: process.env.OPENAI_BASE_URL || undefined,
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
      // The AI SDK's OpenAI provider defaults to the proprietary Responses
      // API. OpenAI-compatible gateways (GitHub Models, Azure, Ollama, …) only
      // implement Chat Completions, so force that path when a custom baseURL
      // is configured.
      return process.env.OPENAI_BASE_URL
        ? openaiProvider.chat(name)
        : openaiProvider(name);
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

/** One-shot plain-text generation that works across providers. */
export async function generateLlmText(opts: {
  role: LlmRole;
  prompt: string;
  system?: string;
}): Promise<LlmTextResult> {
  const { text, usage } = await generateText({
    model: getModel(opts.role),
    system: opts.system,
    prompt: opts.prompt,
  });
  return {
    text: text.trim(),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

export interface LlmObjectResult<T> {
  object: T;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * One-shot structured generation that works across providers. Uses the SDK's
 * `generateObject` so JSON output is enforced and validated against `schema`
 * regardless of provider (no hand-rolled JSON parsing or provider-specific
 * response-format flags).
 */
export async function generateLlmObject<T>(opts: {
  role: LlmRole;
  prompt: string;
  system?: string;
  schema: z.ZodType<T>;
}): Promise<LlmObjectResult<T>> {
  const { object, usage } = await generateObject({
    model: getModel(opts.role),
    system: opts.system,
    prompt: opts.prompt,
    schema: opts.schema,
  });
  return {
    object,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}


// Ad-hoc smoke test for the provider-agnostic LLM layer.
//
// Loads .env first, then drives the compiled dist/llm.js. Two modes:
//   node scripts/smoke-llm.mjs            → real OpenAI (api.openai.com) from .env
//   node scripts/smoke-llm.mjs gh-models  → GitHub Models gateway (free; needs a
//                                           GitHub token in GH_MODELS_TOKEN)
//
// Env is set BEFORE importing the module because llm.ts captures the provider
// key/baseURL at module-init time.
import 'dotenv/config';
import { z } from 'zod';

const mode = process.argv[2] ?? 'openai';
process.env.LLM_PROVIDER = 'openai';

if (mode === 'gh-models') {
  process.env.OPENAI_BASE_URL = 'https://models.github.ai/inference';
  process.env.OPENAI_API_KEY = process.env.GH_MODELS_TOKEN || process.env.OPENAI_API_KEY;
  const m = process.env.SMOKE_MODEL || 'openai/gpt-4o-mini';
  process.env.OPENAI_MODEL_CHAT = m;
  process.env.OPENAI_MODEL_EXTRACT = m;
  process.env.OPENAI_MODEL_DEDUP = m;
} else {
  // Real OpenAI: ensure no gateway override leaks in from .env.
  delete process.env.OPENAI_BASE_URL;
  if (process.env.SMOKE_MODEL) {
    process.env.OPENAI_MODEL_CHAT = process.env.SMOKE_MODEL;
    process.env.OPENAI_MODEL_EXTRACT = process.env.SMOKE_MODEL;
    process.env.OPENAI_MODEL_DEDUP = process.env.SMOKE_MODEL;
  }
}

const { hasLlmKey, generateLlmText, generateLlmObject } = await import('../dist/llm.js');
const { modelFor, LLM_PROVIDER } = await import('../dist/config.js');

console.log(`mode=${mode} provider=${LLM_PROVIDER} baseURL=${process.env.OPENAI_BASE_URL ?? '(default api.openai.com)'}`);
console.log(`hasLlmKey=${hasLlmKey()} model(chat)=${modelFor('chat')} model(extract)=${modelFor('extract')}`);

// 1) plain text generation
const t = await generateLlmText({
  role: 'chat',
  system: 'You are terse.',
  prompt: 'In one short sentence, what does a conductor do?',
});
console.log('\n[text] ->', t.text);
console.log(`[text] tokens in=${t.inputTokens} out=${t.outputTokens}`);

// 2) structured generation with a Zod schema (the generateObject JSON path)
const schema = z.object({
  items: z.array(z.object({
    description: z.string(),
    owner: z.string().nullable(),
  })),
});
const o = await generateLlmObject({
  role: 'extract',
  system: 'Extract action items from the message as JSON.',
  prompt: 'Alice will book the hall by Friday. Someone needs to print programs.',
  schema,
});
console.log('\n[object] ->', JSON.stringify(o.object, null, 2));
console.log(`[object] tokens in=${o.inputTokens} out=${o.outputTokens}`);

console.log('\nOK: both paths succeeded.');

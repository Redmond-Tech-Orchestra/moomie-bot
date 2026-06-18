/**
 * Tracked configuration constants for the Redmond Tech Orchestra bot.
 * All values can be overridden via environment variables.
 * Secrets (tokens, keys) stay in .env and are read directly via process.env.
 */

// Discord
export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1500636126275440740';
export const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1198739951458717716';

// Tracker — Discord category snowflake IDs
export const PERFORMANCES_CATEGORY_ID = process.env.PERFORMANCES_CATEGORY_ID || '1314829117249687574';
export const ARCHIVED_CATEGORY_ID = process.env.ARCHIVED_CATEGORY_ID || '1314827819175378994';

// Dedicated text channel where Moomie opens a per-job thread to stream her live
// "thinking" trail. Leave empty to fall back to an inline trail in the origin
// surface (also used automatically for DM-originated jobs).
export const THINKING_CHANNEL_ID = process.env.THINKING_CHANNEL_ID || '1510218806146891876';

// GitHub
export const GITHUB_OWNER = process.env.GITHUB_OWNER || 'Redmond-Tech-Orchestra';
export const GITHUB_REPO = process.env.GITHUB_REPO || 'redmond-tech-orchestra.github.io';
export const GITHUB_BOT_REPO = process.env.GITHUB_BOT_REPO || 'moomie-bot';
export const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '3591863';
export const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || '129284193';

// Server
export const PORT = process.env.PORT || '3000';

// Bot permissions
export const BOT_OWNER_ID = process.env.BOT_OWNER_ID || '127287481077989377';
export const MUSIC_ADMIN_ROLE = process.env.MUSIC_ADMIN_ROLE || 'Librarian';
// Discord role allowed to approve+merge PRs from inside Discord threads.
// Can be a role name or a snowflake ID.
export const WEB_APPROVER_ROLE = process.env.WEB_APPROVER_ROLE || 'moomie:web-approvers';

// Coding agent
export const CODING_AGENT = process.env.CODING_AGENT || 'gemini';
export const AGENT_WORKSPACE = process.env.AGENT_WORKSPACE || './workspace';

// Eventbrite
export const EVENTBRITE_ORG_ID = process.env.EVENTBRITE_ORG_ID || '2020393260733';
export const EVENTBRITE_DATA_DIR = process.env.EVENTBRITE_DATA_DIR || './data/eventbrite';

// LLM provider selection. 'gemini' (default) or 'openai'. Each provider needs
// its own API key in env (GEMINI_API_KEY / OPENAI_API_KEY).
export const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();

// Role → model mapping per provider. Roles: chat (cheap/fast), extract
// (nuanced), dedup (cheap/fast). Override any value via env.
export type LlmRole = 'chat' | 'extract' | 'dedup';

const MODELS: Record<string, Record<LlmRole, string>> = {
  gemini: {
    chat: process.env.MODEL_CHAT || 'gemini-flash-latest',
    extract: process.env.MODEL_EXTRACT || 'gemini-pro-latest',
    dedup: process.env.MODEL_DEDUP || 'gemini-flash-latest',
  },
  openai: {
    chat: process.env.OPENAI_MODEL_CHAT || 'gpt-5.4-mini',
    extract: process.env.OPENAI_MODEL_EXTRACT || 'gpt-5.5',
    dedup: process.env.OPENAI_MODEL_DEDUP || 'gpt-5.4-mini',
  },
};

export function modelFor(role: LlmRole): string {
  const provider = MODELS[LLM_PROVIDER] ?? MODELS.gemini;
  return provider[role];
}

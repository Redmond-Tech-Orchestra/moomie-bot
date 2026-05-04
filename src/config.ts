/**
 * Tracked configuration constants for the Microsoft Open Orchestra bot.
 * All values can be overridden via environment variables.
 * Secrets (tokens, keys) stay in .env and are read directly via process.env.
 */

// Discord
export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1500636126275440740';
export const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1198739951458717716';

// Tracker — Discord category snowflake IDs
export const PERFORMANCES_CATEGORY_ID = process.env.PERFORMANCES_CATEGORY_ID || '1314829117249687574';
export const ARCHIVED_CATEGORY_ID = process.env.ARCHIVED_CATEGORY_ID || '1314827819175378994';

// GitHub
export const GITHUB_OWNER = process.env.GITHUB_OWNER || 'Redmond-Tech-Orchestra';
export const GITHUB_REPO = process.env.GITHUB_REPO || 'redmond-tech-orchestra.github.io';
export const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '3591863';
export const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || '129284193';

// Server
export const PORT = process.env.PORT || '3000';

// Bot permissions
export const BOT_OWNER_ID = process.env.BOT_OWNER_ID || '127287481077989377';
export const MUSIC_ADMIN_ROLE = process.env.MUSIC_ADMIN_ROLE || 'Librarian';

// Coding agent
export const CODING_AGENT = process.env.CODING_AGENT || 'gemini';
export const AGENT_WORKSPACE = process.env.AGENT_WORKSPACE || './workspace';

import 'dotenv/config';
import { startDiscord, client } from './adapters/discord.js';
import { startServer } from './webhook-server.js';
import { warmupRepo, forceResetQueue } from './features/coding/job-runner.js';
import { getDb } from './db.js';

// ─── Validate required env vars (secrets only — non-secrets have defaults in config.ts) ──
const required = ['DISCORD_TOKEN', 'GITHUB_APP_PRIVATE_KEY_PATH'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[Startup] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

if (!process.env.GITHUB_WEBHOOK_SECRET) {
  console.warn('[Startup] GITHUB_WEBHOOK_SECRET not set — webhook signature verification disabled');
}

// ─── Start services ──────────────────────────────────────────────────────────
await startDiscord();
startServer(client);
warmupRepo();

console.log('Moomie bot is running.');

// ─── Graceful shutdown ───────────────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`[Shutdown] Received ${signal}, cleaning up...`);
  client.destroy();
  try { getDb().close(); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGUSR1', () => {
  const { drained } = forceResetQueue();
  console.log(`[Admin] SIGUSR1 received — queue reset, ${drained} job(s) drained`);
});

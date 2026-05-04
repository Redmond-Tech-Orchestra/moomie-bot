# Moomie Bot

Discord + Teams bot for the Redmond Tech Orchestra. Automates website maintenance using AI agents, manages reminders, and shares sheet music links.

When a user runs `/website <task>`, Moomie creates a GitHub issue, triggers a Gemini CLI agent to implement the changes, pushes a PR, and pings the user back — all hands-free.

## Commands

| Command | Description |
|---------|-------------|
| `/website <task>` | Creates a GitHub issue, triggers AI agent to code changes, opens a PR |
| `/remind <text>` | Natural language reminder — supports `@user`, `#channel`, relative/absolute times |
| `/music [link]` | Get or set the shared sheet music folder link |

Attachments on `/website` are saved locally and copied into the workspace for the AI agent to use (e.g., PDFs, images to update on the site).

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Adapters (src/adapters/)                                  │
│  ├── discord.ts       Input: slash commands, DMs           │
│  ├── teams.ts         Input: text commands, proactive msg  │
│  ├── notify.ts        Output: platform-routed notifications│
│  └── index.ts         Barrel — the ONLY export for features│
├────────────────────────────────────────────────────────────┤
│  Features (src/features/)                                  │
│  ├── website/         AI agent pipeline                    │
│  ├── remind/          Timer-based reminders                │
│  └── music/           Sheet music link store               │
├────────────────────────────────────────────────────────────┤
│  Infrastructure                                            │
│  ├── webhook-server.ts   Express: GitHub webhooks + admin  │
│  ├── db.ts               SQLite (WAL mode, auto-migrate)   │
│  └── index.ts            Entry point + graceful shutdown    │
└────────────────────────────────────────────────────────────┘
```

**Key rule:** Features import platform I/O only through `src/adapters/index.ts`. Direct imports of `discord.js` or `botbuilder` from feature code are blocked by ESLint.

## Website Pipeline (end-to-end)

```
Discord/Teams user → /website "update spring concert program" + attaches PDF
    ↓
Bot saves attachment locally, creates GitHub issue with moomie-bot label
    ↓
GitHub webhook fires → bot verifies org membership
    ↓
Job runner: clone repo → create branch → copy attachments → spawn Gemini CLI
    ↓
Gemini makes changes (sandboxed by policies/agent-sandbox.toml)
    ↓
Git commit + push → open PR (references issue with "Fixes #N")
    ↓
Bot pings user back on the SAME platform they initiated from
```

## Prerequisites

- Node.js 22+
- A Discord Application with bot token
- A GitHub App (recommended) or fine-grained PAT
- Gemini CLI installed (`npm i -g @anthropic/gemini-cli` or equivalent)
- Optional: Docker for containerized deployment

## Local Development

```bash
cp .env.example .env   # Fill in values (see Environment Variables below)
npm install
npm run deploy-commands   # Register slash commands with Discord (once)
npm run dev               # Starts bot with hot reload (tsx --watch)
```

For webhook testing, use [smee.io](https://smee.io) to proxy GitHub webhooks to localhost:

```bash
npx smee -u https://smee.io/YOUR_CHANNEL -t http://localhost:3000/webhook
```

## Docker

```bash
# Development (hot reload, source mounted)
docker compose --profile dev up bot-dev

# Production
docker compose up -d bot
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application ID for registering slash commands |
| `GITHUB_OWNER` | GitHub org/user (e.g., `Redmond-Tech-Orchestra`) |
| `GITHUB_REPO` | Target repo for website issues and PRs |

### GitHub Authentication (pick one)

**GitHub App (recommended for production):**

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to `.pem` private key |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID for the org |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_WEBHOOK_SECRET` | — | Secret for webhook signature verification |
| `PORT` | `3000` | HTTP server port |
| `DB_PATH` | `./data/moomie.db` | SQLite database path |
| `BOT_OWNER_ID` | — | Discord user ID with admin permissions |
| `MUSIC_ADMIN_ROLE` | `Librarian` | Discord role allowed to set music link |
| `DISCORD_GUILD_ID` | — | Scope commands to a guild (instant, for testing) |
| `CODING_AGENT` | `gemini` | Agent backend: `gemini` \| `claude` \| `codex` |
| `GEMINI_API_KEY` | — | Google AI API key (for title generation) |
| `GEMINI_MODEL` | — | Override Gemini model (leave unset for default) |
| `AGENT_WORKSPACE` | `./workspace` | Directory for cloned repos |
| `TEAMS_APP_ID` | — | Microsoft Bot Framework app ID |
| `TEAMS_APP_PASSWORD` | — | Microsoft Bot Framework password |

## Webhook Setup

1. GitHub repo → Settings → Webhooks → Add webhook
2. Payload URL: `https://your-host:3000/webhook`
3. Content type: `application/json`
4. Secret: match `GITHUB_WEBHOOK_SECRET`
5. Events: **Issues**, **Pull requests**

The bot triggers on the `moomie-bot` label being added to an issue. Only org members can trigger the agent.

## Admin

Queue health is available locally:

```bash
curl http://localhost:3000/status
```

To force-reset a stuck queue, send `SIGUSR1` to the process:

```bash
kill -USR1 $(pidof node)
```

This drains all queued jobs immediately. The currently running job will still finish (or hit its 35-min timeout).

## Queue System

- Max 5 jobs queued at a time
- 35-minute hard timeout per job
- 5-minute idle timeout (no agent output)
- Jobs waiting >1 hour are auto-discarded
- Attachments cleaned up after every job (success or failure)
- `GET /status` to check queue health; `kill -USR1` to unstick

## Security

- **Webhook signatures** — HMAC-SHA256 timing-safe verification
- **Org membership gate** — Only org members can trigger the AI agent
- **Agent sandbox** — `policies/agent-sandbox.toml` blocks destructive commands, network access, env/secret file reads
- **No shell injection** — All git/agent commands use `execFileSync` with array args
- **Adapter isolation** — ESLint prevents features from bypassing platform abstractions

## Project Structure

```
src/
├── adapters/       Platform I/O (Discord, Teams, notifications)
├── commands/       Slash command definitions + registry
├── features/       Business logic (website, remind, music)
│   └── website/agents/   Pluggable AI agent implementations
├── index.ts        Entry point
├── webhook-server.ts   Express server + GitHub webhooks
├── db.ts           SQLite + migrations
└── types.ts        Shared interfaces
```

Features never import platform libraries directly — they go through `src/adapters/index.ts`.

## Adding a New Command

1. Create a slash command definition in `src/commands/mycommand.ts`:

```ts
import { SlashCommandBuilder } from 'discord.js';
export const data = new SlashCommandBuilder()
  .setName('mycommand')
  .setDescription('Does something')
  .addStringOption(opt => opt.setName('text').setDescription('Input').setRequired(true));
```

2. Create a feature handler in `src/features/myfeature/handle-command.ts`:

```ts
import type { CommandContext } from '../../types.js';

export const name = 'mycommand';
export const description = 'Does something';

export async function execute(ctx: CommandContext, args: string): Promise<void> {
  await ctx.reply(`You said: ${args}`);
}
```

3. Register in `src/commands/command-registry.ts`
4. Run `npm run deploy-commands`

## Adding a New Platform

1. Create `src/adapters/newplatform.ts` with message handling
2. Build a `CommandContext` with `platform: 'newplatform'` (add to union type in `types.ts`)
3. Add a case to the `switch` in `src/adapters/notify.ts`
4. TypeScript's exhaustiveness check will catch any missed cases

## Data Persistence

SQLite database lives in `./data/moomie.db` (or Docker volume `bot-data`).

```bash
# Backup from container
docker cp moomie-bot:/app/data/moomie.db ./backup.db
```

Tables auto-create via the migration system in `src/db.ts`. Delete the DB file to reset.

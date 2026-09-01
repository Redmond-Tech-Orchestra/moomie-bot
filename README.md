# Moomie Bot

Discord + Teams bot for the Redmond Tech Orchestra. Manages project tracking, automates website maintenance using AI agents, generates activity digests, and handles reminders.

For how this bot fits into the broader orchestra infrastructure (server, nginx,
backups, deploy flows, request diagrams), see the
[infra repo](https://github.com/Redmond-Tech-Orchestra/infra).

## Commands

| Command | Description |
|---------|-------------|
| `/board [event]` | Consolidated action board — open items, overdue, by event or opted-in channel swimlane. Uses AI to merge duplicates and group related tasks |
| `/events` | List upcoming events with T-minus countdowns |
| `/digest [window]` | AI-generated summary of recent server activity (default: 1 week) |
| `/website <task>` | Creates a GitHub issue, triggers AI agent to code changes, opens a PR |
| `/remind <text>` | Natural language reminder — supports `@user`, `#channel`, relative/absolute times |
| `/music [link]` | Get or set the shared sheet music folder link |

## Automatic Features

**Conversation Watcher** — Monitors all text channels. After 2 hours of silence, extracts action items, detects completions, and nudges stalled discussions via the configured LLM (`LLM_PROVIDER`: OpenAI by default, Gemini optional). Posts findings with ✅/❌ for human confirmation. Includes insert-time dedup to prevent cross-channel duplicates.

**Event Watcher** — Auto-detects new channels in the "Performances" category, parses event names/dates, and tracks each performance channel as its own board swimlane. Categories listed in `TRACKER_SWIMLANE_CATEGORY_IDS` are tracked as aggregate ongoing swimlanes; by default these are Logistics, Marketing, Technology, and Librarians. `TRACKER_IGNORED_CHANNEL_IDS` excludes channels such as moomie-thinking and bots from category-lane attribution. Archives events when channels move to "Archived."

**Website Agent** — When `/website` is used, the full pipeline runs: issue creation → coding agent (`CODING_AGENT`: Codex by default, Gemini optional) → branch + PR → user notification.

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
│  ├── tracker/         Event & action item tracking (AI)    │
│  ├── digest/          AI-powered activity summaries        │
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
Job runner: clone repo → create branch → copy attachments → spawn coding agent
    ↓
The agent makes changes (sandboxed by policies/agent-sandbox.toml)
    ↓
Git commit + push → open PR (references issue with "Fixes #N")
    ↓
Bot pings user back on the SAME platform they initiated from
```

## Prerequisites

- Node.js 22+
- A Discord Application with bot token
- A GitHub App (recommended) or fine-grained PAT
- A coding-agent CLI (bundled as a dependency): Codex (`@openai/codex`, default) or
  Gemini (`@google/gemini-cli`); select via `CODING_AGENT`
- Optional: Docker for containerized deployment

## Local Development

```bash
cp .env.example .env   # Each var documents where its value comes from
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

## Deployment

```bash
npm run deploy          # Syncs files to server, rebuilds Docker container
npm run deploy-commands # Registers slash commands with Discord (run after adding/changing commands)
```

The deploy script (`deploy.ps1`) SCPs project files to the production server and runs `docker compose up -d --build`.

The shared deploy script builds before draining, waits for coding jobs and chat
turns, tags the running image as `moomie-bot-bot:rollback`, recreates the
container, and restores that image automatically if the health check fails.
After a successful health check it removes the temporary rollback image so the
previous release does not consume disk between deployments.

Production lives at `/opt/moomie-bot` on `schemes.me`. The nginx vhost,
TLS, daily backup cron, and broader server config are tracked in the
[infra repo](https://github.com/Redmond-Tech-Orchestra/infra).

## Environment variables

The canonical list — with "where to get this value" notes for every secret —
is [`.env.example`](.env.example). Non-secret defaults (Discord IDs, GitHub
repo names, port, etc.) live in [`src/config.ts`](src/config.ts) and only need
to be set in `.env` if you want to override them for local dev.

### Workspace and cache retention

`/app/data` and `/app/uploads` are persistent named volumes and are never
examined or deleted by storage maintenance. `/app/workspace`, npm cache,
Playwright browsers, and allowlisted Codex/Gemini temporary caches are
rebuildable container storage. Maintenance runs before repository warmup and
every six hours; failures are logged and do not stop the bot.

The default warmed repository checkout is always retained. A usage marker is
updated around warmup and every coding job. Inactive `node_modules` and `dist`
directories are pruned before whole Git checkouts. Active workspace leases are
reference-counted; while any coding agent is active its checkout is excluded
and all shared tool-cache cleanup is skipped. Python scratch directories have
their own prefix-limited crash reaper in `src/features/sandbox/python-runner.ts`.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `STORAGE_MAINTENANCE_ENABLED` | `true` | Set to `false` to disable automatic deletion |
| `STORAGE_MAINTENANCE_INTERVAL_HOURS` | `6` | Interval between bounded maintenance passes |
| `WORKSPACE_MAX_GB` | `3` | Total workspace budget |
| `WORKSPACE_RETENTION_DAYS` | `30` | Age before an inactive, non-default checkout is removed |
| `REBUILDABLE_RETENTION_DAYS` | `7` | Age before inactive `node_modules`/`dist` are removed |
| `TOOL_CACHE_MAX_GB` | `2` | Shared budget across managed tool-cache roots |
| `TOOL_CACHE_RETENTION_DAYS` | `30` | Maximum age of managed cache entries |

`npm run storage:dry-run` reports candidate paths and estimated bytes without
deleting anything. It deliberately has no apply option: live deletion runs in
the bot process, where active workspace leases are authoritative.

### Production storage rollout

Run these from `/opt/moomie-bot` on `schemes.me`. Do not display `.env` or key
contents.

```bash
# 1. Back up host config and persistent data metadata/content.
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "backups/storage-rollout-$stamp"
cp -a docker-compose.yml Dockerfile .env "backups/storage-rollout-$stamp/"
docker exec moomie-bot node -e "const D=require('better-sqlite3');new D('/app/data/moomie.db',{readonly:true}).backup('/app/data/pre-storage-rollout-$stamp.db').then(()=>process.exit(0),()=>process.exit(1))"
docker volume inspect moomie-bot_bot-data moomie-bot_bot-uploads > "backups/storage-rollout-$stamp/volume-inspect.json"

# 2. Build without replacing the running container, then copy only the
# dry-run program into that container so it can inspect the current layer.
docker inspect --format '{{.Image}}' moomie-bot | xargs -I{} docker tag {} moomie-bot-bot:rollback
docker compose build bot
candidate=$(docker create moomie-bot-bot:latest)
mkdir -p /tmp/moomie-maintenance/features/coding
docker cp "$candidate:/app/dist/storage-maintenance-command.js" /tmp/moomie-maintenance/
docker cp "$candidate:/app/dist/features/coding/storage-maintenance.js" /tmp/moomie-maintenance/features/coding/
docker rm "$candidate"
docker cp /tmp/moomie-maintenance/. moomie-bot:/app/.maintenance-preview/
docker exec moomie-bot node /app/.maintenance-preview/storage-maintenance-command.js
```

Review that output before continuing. It must not include `/app/data`,
`/app/uploads`, or the warmed default checkout itself. The copied dry-run
process cannot see the bot process's in-memory active leases, so an active
checkout may appear as an estimate; actual in-process cleanup excludes it.

```bash
# 3. Drain, swap, and wait for the scripted health check/automatic rollback.
bash scripts/safe-deploy.sh

# 4. Smoke-check runtime, persistence, and disk use.
curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/status
docker inspect moomie-bot --format '{{.State.Health.Status}} {{.RestartCount}}'
docker exec moomie-bot test -s /app/data/moomie.db
docker exec moomie-bot test -d /app/uploads
docker inspect --size moomie-bot --format 'writable={{.SizeRw}} rootfs={{.SizeRootFs}}'
docker system df
df -h /
rm -rf /tmp/moomie-maintenance
```

If a later smoke check fails after the temporary rollback image was removed,
check out the prior Git revision and run the normal guarded deployment again:

```bash
git log --oneline -5
git checkout <prior-commit>
bash scripts/safe-deploy.sh
curl -fsS http://localhost:3000/health
```

The previous writable layer is disposable and is not restored by image
rollback. Database and uploads remain in their named volumes. Restore the
timestamped SQLite backup only if an explicit database verification fails, and
return the checkout to the intended branch after recovery.

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
├── features/       Business logic
│   ├── tracker/    Event detection, conversation watcher, action board
│   ├── digest/     AI activity summaries
│   ├── website/    AI coding agent pipeline
│   │   └── agents/ Pluggable AI agent implementations
│   ├── remind/     Timer-based reminders
│   └── music/      Sheet music link store
├── prompts/        LLM prompt templates (.md) + loader
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

## Backups

Production runs [`backup.sh`](backup.sh) daily at 11:00 UTC via cron (the
entry is tracked in [`infra/cron/peter`](https://github.com/Redmond-Tech-Orchestra/infra/blob/main/cron/peter)).
Retention is tiered:

- **Daily** — last 7 days
- **Weekly** — last 5 weeks
- **Monthly** — last 12 months

Backups land in `/opt/moomie-bot/backups/`. To restore, stop the container,
copy the chosen `.db` file over `data/moomie.db`, and start the container.

# Moomie Bot

Discord bot for the Redmond Tech Orchestra. Creates GitHub issues, assigns Copilot, and pings you when the PR is ready. Also handles reminders.

## Commands

| Command | Description |
|---------|-------------|
| `/website <task>` | Creates a GitHub issue and assigns Copilot to work on it |
| `/remind <text>` | Natural language reminder — supports `@user`, `#channel`, relative/absolute times |

## Prerequisites

- Node.js 22+
- Docker (for containerized deploy)
- A Discord Application with bot token
- A GitHub PAT (fine-grained) with `issues:write` on target repo

## Local Development

```bash
cp .env.example .env
# Fill in .env values

npm install
npm run deploy-commands   # Register slash commands with Discord (once)
npm run dev               # Starts bot with hot reload
```

SQLite database is stored at `./data/moomie.db` (created automatically).

## Docker Development

```bash
docker compose --profile dev up bot-dev
```

Source is mounted into the container with hot reload via `tsx --watch`.

## Production Deployment

### Build and run

```bash
docker compose up -d bot
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Yes | Application ID for registering slash commands |
| `GITHUB_TOKEN` | Yes | Fine-grained PAT with `issues:write` |
| `GITHUB_OWNER` | Yes | GitHub org/user (default: `Redmond-Tech-Orchestra`) |
| `GITHUB_REPO` | Yes | Target repo for `/website` issues |
| `GITHUB_WEBHOOK_SECRET` | No | Secret for verifying GitHub webhook payloads |
| `PORT` | No | Webhook server port (default: `3000`) |
| `DB_PATH` | No | SQLite database path (default: `./data/moomie.db`) |

### Webhook setup

For the bot to notify you when Copilot opens a PR:

1. In your GitHub repo → Settings → Webhooks → Add webhook
2. Payload URL: `https://your-host:3000/webhook`
3. Content type: `application/json`
4. Secret: match your `GITHUB_WEBHOOK_SECRET` env var
5. Events: select **Pull requests**

### Data persistence

SQLite database lives in a Docker volume (`bot-data`). To back up:

```bash
docker compose exec bot cp /app/data/moomie.db /app/data/moomie.db.bak
docker cp moomie-bot:/app/data/moomie.db ./backup.db
```

### Registering commands

Slash commands need to be registered once (or after changes):

```bash
# Local
npm run deploy-commands

# In container
docker compose exec bot node dist/deploy-commands.js
```

Global commands can take up to 1 hour to propagate. For instant testing, scope to a guild by modifying `deploy-commands.ts` to use `Routes.applicationGuildCommands(clientId, guildId)`.

## Project Structure

```
src/
├── index.ts              Entry point
├── bot.ts                Discord client setup, dynamic loader
├── types.ts              Shared TypeScript interfaces
├── db.ts                 SQLite connection + migrations
├── github.ts             GitHub API (issue creation)
├── tracker.ts            Issue → Discord channel mapping (SQLite)
├── scheduler.ts          Reminder engine (SQLite)
├── server.ts             Express webhook listener
├── deploy-commands.ts    Registers slash commands with Discord
├── commands/
│   ├── index.ts          Auto-discovers command files
│   ├── website.ts        /website command
│   └── remind.ts         /remind command
└── events/
    ├── ready.ts          Bot ready handler
    └── interactionCreate.ts  Routes interactions to commands
```

## Adding a new command

Drop a file in `src/commands/` exporting:

```ts
export const data = new SlashCommandBuilder().setName('mycommand')...;
export async function execute(interaction: ChatInputCommandInteraction) { ... }
```

Then run `npm run deploy-commands` to register it.

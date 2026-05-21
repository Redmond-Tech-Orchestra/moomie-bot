# Google Sheets setup for roster

This doc covers the **out-of-code** Google side of the roster feature: a
service account in Google Cloud, sharing the roster spreadsheet with it, and
the env vars the bot reads.

For the broader feature design (schema, source-of-truth rules, command
surface), see [roster-design.md](roster-design.md). For Microsoft Teams /
Entra setup, see [teams-roster-setup.md](teams-roster-setup.md).

## Why this exists

The roster spreadsheet is the **source of truth for per-event signups** —
one tab per concert, edited by the board, historically archived. The bot
needs to:

- **Read** every active event's tab to populate `event_signups` cache.
- **Write** new entries when section leaders submit rosters via Teams
  @-mentions, when board members run Discord slash commands, etc.

Both happen via the Google Sheets API. The bot needs an identity that can
read/write a single spreadsheet — nothing else.

## Why a service account, not an API key

Google Cloud offers a few credential types. **Service account is the right
one** for this use case:

| Type | Works for our case? |
|------|--------------------|
| **Service account** | ✅ Recommended. Unattended access, exact-file scoping via Drive sharing, no interactive login |
| API key | ❌ Only works for *public* sheets (anyone-with-link readable). Our sheet is private. 403s on private content |
| OAuth (user) | ⚠️ Possible but awkward — bakes one user's identity into the bot, refresh tokens can be revoked, audit log shows that user as the editor |

The setup below is for service account.

## Setup steps

### 1. Create a Google Cloud project

1. <https://console.cloud.google.com> → **Select a project → New project**
   - Name: `moomie-bot` (or reuse an existing one if you have it)
   - Organization: leave at default
   - **No billing account needed** — Sheets API is free under quota.
2. Once created, make sure it's selected in the project picker at the top.

### 2. Enable the Sheets API

1. **APIs & Services → Library**.
2. Search **Google Sheets API** → **Enable**.
3. Optional: also enable **Google Drive API** if you want the bot to be able
   to list, create, or copy spreadsheets (the roster importer/writer doesn't
   strictly need it; just direct cell reads/writes by sheet ID).

### 3. Create the service account

1. **IAM & Admin → Service Accounts → Create service account**.
   - Name: `moomie-bot-roster`
   - Account ID: auto-fills (e.g. `moomie-bot-roster`); copy the resulting
     email — looks like
     `moomie-bot-roster@<project-id>.iam.gserviceaccount.com`. You'll use
     this in step 5.
2. **Skip role assignment** — service accounts don't need any project-level
   IAM role to call the Sheets API. The grant happens via Drive sharing.
3. **Skip user access grants** — no users need to impersonate this account.
4. **Done**.

### 4. Generate a key

1. Click into the new service account → **Keys → Add key → Create new key
   → JSON**.
2. A `.json` file downloads. **This is the only copy of the private key** —
   if lost, you generate a new one and revoke the old.
3. Treat it like a password. Don't commit it. Don't share it. Don't paste
   into chat.

The JSON looks like:

```jsonc
{
  "type": "service_account",
  "project_id": "...",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "moomie-bot-roster@.....iam.gserviceaccount.com",
  "client_id": "...",
  "token_uri": "https://oauth2.googleapis.com/token"
}
```

Move it to the server:

```powershell
scp .\moomie-bot-...json peter@schemes.me:/tmp/google-sa.json
ssh -t peter@schemes.me "sudo mv /tmp/google-sa.json /opt/moomie-bot/secrets/google-sa.json && sudo chown root:docker /opt/moomie-bot/secrets/google-sa.json && sudo chmod 640 /opt/moomie-bot/secrets/google-sa.json"
```

(Adjust paths to match the existing secrets convention; if `/opt/moomie-bot/secrets/`
doesn't exist yet, create it first.)

### 5. Share the spreadsheet with the service account

This is **the actual permission grant** — there's no "API permissions" page
to configure. The sheet is shared with the service account's email exactly
as if it were a person.

1. Open the roster spreadsheet in Google Sheets.
2. **Share** → paste the service account email (`moomie-bot-roster@...
   .iam.gserviceaccount.com`).
3. **Editor** access (the bot needs to write back, per roster-design.md
   Option A).
4. **Uncheck "Notify people"** — the service account has no inbox.
5. **Send / Share**.

Verify by clicking **Share** again — the SA should appear in the people
list with Editor.

> **If you only want read access for now** (e.g. to start with import-only
> and add write-back later), grant **Viewer** instead. Easy to bump up
> later.

### 6. Set env vars

In `/opt/moomie-bot/.env`:

```
GOOGLE_SHEETS_CREDS_PATH=/opt/moomie-bot/secrets/google-sa.json
ROSTER_SHEET_ID=1V6hqh8af4c_XzdENvt4xDxqLjs9beTVjidFpeX7v858
```

The sheet ID is the long token in the spreadsheet URL between `/d/` and
`/edit`. The same ID belongs to all tabs in that workbook.

Restart the container:

```powershell
ssh -t peter@schemes.me "cd /opt/moomie-bot && sudo docker compose restart"
```

> **Mounting the JSON into the container.** The Docker setup needs to bind
> `/opt/moomie-bot/secrets` into the container (read-only). If
> [docker-compose.yml](../docker-compose.yml) doesn't already mount it, add:
> ```yaml
>   volumes:
>     - ./secrets:/opt/moomie-bot/secrets:ro
> ```
> and adjust `GOOGLE_SHEETS_CREDS_PATH` to the in-container path.

### 7. Smoke test

Once code lands, simplest verification:

```js
// node -e "..." with env loaded
const { google } = require('googleapis');
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SHEETS_CREDS_PATH,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
const r = await sheets.spreadsheets.get({ spreadsheetId: process.env.ROSTER_SHEET_ID });
console.log(r.data.sheets.map(s => s.properties.title));
```

Should print the list of tab names. If it 404s, the SA doesn't have access
(re-check sharing). If it 403s, the API isn't enabled (re-check step 2).

## Pre-flight checklist

Before merging Sheets code:

- [ ] Google Cloud project exists; Sheets API enabled.
- [ ] Service account created; JSON key downloaded; key file at
      `/opt/moomie-bot/secrets/google-sa.json` with `0640` perms.
- [ ] Spreadsheet shared with the SA email (Editor for write-back, Viewer
      if read-only).
- [ ] `GOOGLE_SHEETS_CREDS_PATH` and `ROSTER_SHEET_ID` set in
      `/opt/moomie-bot/.env`.
- [ ] Docker volume mounts the secrets directory read-only.
- [ ] Smoke test from above lists the workbook's tabs.

## Things to watch out for

- **Service account keys never expire by default**, but they *can* be
  revoked at any time (and Google will sometimes auto-revoke on suspected
  exposure). Generate a new one and re-deploy if revoked.
- **Quota.** Sheets API allows 300 read requests / 60 write requests per
  minute per project. Roster traffic is nowhere near that, but if a bug
  causes the bot to loop on a write, you'll hit it fast and start getting
  429s. Build retry-with-backoff into the writer.
- **Service account email != the one who edited the cell.** Sheet revision
  history will attribute changes to `moomie-bot-roster@...iam.gserviceaccount.com`,
  which looks ugly in the version-history sidebar. Acceptable; just be aware
  the board won't see "edited by Jane via bot" — they'll see "edited by
  moomie-bot-roster". The bot's audit log (in `/opt/moomie-bot/data/`)
  records the actual human author.
- **Scopes matter.** Use `https://www.googleapis.com/auth/spreadsheets`
  (read+write to specific shared sheets), not the broader
  `.../auth/drive` unless you need to create new spreadsheets.
- **Sharing is per-file, not per-folder for service accounts.** If the
  spreadsheet is moved into a shared drive later, sharing usually carries
  through, but worth verifying after any reorganization.
- **Don't paste the JSON into chat.** It's the entire credential. If
  exposed, immediately go to **Service Accounts → Keys → Disable** the old
  key and generate a new one.

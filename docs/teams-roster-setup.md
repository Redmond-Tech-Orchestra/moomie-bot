# Teams / Entra setup for roster sync

This doc covers the **out-of-code** Microsoft side of the roster feature:
Entra app registration, Microsoft Graph permissions, Teams app manifest, and
team installation.

For the broader feature design (schema, source-of-truth rules, command
surface), see [roster-design.md](roster-design.md). For Google Sheets setup,
see [google-sheets-setup.md](google-sheets-setup.md).

## Surface split — read this first

The two chat surfaces serve different audiences:

| Surface | Audience | Bot's role |
|---------|----------|------------|
| **Discord** | Orchestra **board** (small group) | Logistics, tracker, admin overrides, oversight |
| **Teams** | **Musicians** (full ~40+ roster) | Roster submissions, signups, "who's playing?" queries |

Implications relevant to this doc:

- The source of truth for *who is a musician* is **Teams team membership**.
  Reading that membership is what the Microsoft setup below exists to enable.
- Sign-ups and roster submissions arrive primarily as **Teams @-mentions**;
  see [roster-design.md](roster-design.md) for the parse pipeline.
- Discord-side identity (`discord_id`) is **not** in the schema. Board
  permissions are gated on Discord roles, not a `members` lookup.

## What this setup gives you

The existing bot already has a **Bot Framework** registration for chat
(`TEAMS_APP_ID` / `TEAMS_APP_PASSWORD` in
[src/adapters/teams.ts](../src/adapters/teams.ts)). That handles the bot
*receiving and sending messages* in Teams. It does **not** grant Microsoft
Graph access for reading team membership.

The setup below adds the **Graph** capability on top, via Resource-Specific
Consent (RSC). The bot ends up able to:

1. Receive @-mentions in the orchestra Team (already works today).
2. Read the Team's full member list, including `aadObjectId` for each
   member, so that mentions resolve to known `members` rows.

## Why RSC, not tenant-wide Graph permissions

> **Microsoft corpnet note.** The orchestra's team lives in the Microsoft
> corpnet tenant, where tenant-wide Graph application permissions
> (`GroupMember.Read.All`, `User.Read.All`, etc.) are gated behind a hard
> approval process and almost certainly won't be granted for a hobby bot.
> RSC is the realistic path.

RSC is Microsoft's mechanism for "I want a Teams app to read *just this team*
without bothering the tenant admin." A **team owner** installs the app and
consents to its scoped permissions themselves — no tenant-wide grant needed.

What you get from the relevant RSC permissions:

| Permission | Returns |
|------------|---------|
| `TeamMember.Read.Group` | List of `aadUserConversationMember` entries: `userId` (Entra object ID), `email`, `displayName`, `roles[]` (`owner` / `guest` / empty=member) |
| `TeamSettings.Read.Group` | Team display name, description (optional, useful for sanity-display) |

`TeamMember.Read.Group` is the headline permission. The
`aadUserConversationMember` payload includes `displayName` and `email` for
every member including guests — no separate `User.Read.All` call needed.

The same `aadObjectId` returned here is what arrives in mention entities on
incoming messages, so mention → member resolution is an exact ID lookup with
no fuzzy matching. (See [roster-design.md](roster-design.md) for how this
plays out in the input pipeline.)

## Setup steps

### 1. Entra app registration

You need an Entra app registration to hold the client ID + secret used for
client-credentials auth. **No tenant-wide Graph permissions on it** — RSC is
declared in the Teams manifest, not the Entra app.

1. <https://entra.microsoft.com> → **App registrations → New registration**
   - Name: `moomie-bot-roster`
   - Account types: *Accounts in this organizational directory only*
   - Redirect URI: blank
2. Capture the **Application (client) ID** and **Directory (tenant) ID** from
   Overview.
3. **Certificates & secrets → New client secret**.
   - Description: `graph-roster`
   - Expiry: 12 or 24 months — **calendar a reminder**; expired secrets are
     the #1 cause of "the bot stopped syncing."
   - Copy the **Value** (not the Secret ID) immediately; only shown once.
4. Save to `/opt/moomie-bot/.env`:
   ```
   GRAPH_TENANT_ID=<directory tenant id>
   GRAPH_CLIENT_ID=<application client id>
   GRAPH_CLIENT_SECRET=<secret value>
   ```
5. **API permissions → leave empty.** RSC perms live in the manifest.

This step needs *no* admin approval — any developer can register an app in
their own dev tenant.

> **Corpnet sub-case.** App registration in the corp tenant itself may be
> locked down. If so, register the app in a personal/dev Entra tenant you
> own. The team owner can still install the resulting Teams app pointing at
> *your* tenant's client ID. This is the most likely viable path.

### 2. Teams app manifest declaring RSC perms

Minimum manifest fields for an RSC bot (no tab, no message extension):

```jsonc
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "<a fresh GUID, NOT the client ID>",
  "packageName": "org.redmondtechorchestra.moomie",
  "developer": {
    "name": "Redmond Tech Orchestra",
    "websiteUrl": "https://www.redmondtechorchestra.org",
    "privacyUrl": "https://www.redmondtechorchestra.org/privacy",
    "termsOfUseUrl": "https://www.redmondtechorchestra.org/terms"
  },
  "name": { "short": "Moomie", "full": "Moomie Orchestra Bot" },
  "description": {
    "short": "Roster and event helper for the orchestra.",
    "full": "Tracks event signups and section rosters for the Redmond Tech Orchestra."
  },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "accentColor": "#5b2a86",
  "bots": [
    {
      "botId": "<GRAPH_CLIENT_ID>",
      "scopes": ["team", "groupChat"],
      "supportsFiles": false,
      "isNotificationOnly": false
    }
  ],
  "validDomains": [],
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "TeamMember.Read.Group",   "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" }
      ]
    }
  }
}
```

Notes:

- `id` is a manifest GUID, distinct from `botId` / `GRAPH_CLIENT_ID`.
  Generate once and keep stable across versions.
- `bots[]` is required even if you don't use the bot for chat — RSC perms
  are tied to a bot definition. The same `botId` ties to the existing chat
  handler in [src/adapters/teams.ts](../src/adapters/teams.ts).
- `validDomains` only matters if you add tabs/iframes later.
- Privacy/terms URLs must resolve — corpnet's manifest validator is strict.
  Stub pages on the website are fine.

Zip the manifest + two icons (`color.png` 192×192, `outline.png` 32×32 white
on transparent) as `manifest.zip`.

### 3. Team owner installs the app

1. In the orchestra Team: **Manage team → Apps → Upload a custom app →
   Upload for this team**.
2. Owner is prompted with the consent dialog listing the requested RSC
   perms. They click **Add**.
3. Done — RSC grant is live. Token acquisition (next step) will succeed.

### 4. Set the team ID

Find the orchestra team's group ID (Teams admin centre, or Graph Explorer
`GET /me/joinedTeams`), and add to `.env`:

```
ROSTER_TEAM_ID=<team group id>
```

This is the only team the bot will ever query. Calling `/users` or any other
team's `/members` will 403 — that's RSC working as intended.

## Corpnet sideload restrictions

Microsoft corpnet typically disables custom-app sideloading by default. If
the team owner sees "Upload a custom app" greyed out or routed to admin
approval:

1. **Get a Teams admin to enable custom app upload for the orchestra team
   only**, via an [app setup policy](https://learn.microsoft.com/microsoftteams/teams-custom-app-policies-and-settings).
   Single-team scope is a much smaller ask than tenant-wide Graph perms.
2. **Submit to the tenant's app catalog** for review. More process, but
   persistent.
3. **Publish to the public Teams Store.** Overkill for an internal bot.

If none of those fly, RSC is off the table. Fallback: skip Graph entirely,
manage `members` rows manually via Discord-side commands. Roster
submissions still work via the spreadsheet (see
[roster-design.md](roster-design.md)).

## Runtime behavior (reference)

What the bot does at runtime, for sanity-check:

1. Acquire a token via **client credentials**:
   `POST https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token`
   with `client_id`, `client_secret`, `grant_type=client_credentials`,
   `scope=https://graph.microsoft.com/.default`.
2. `GET https://graph.microsoft.com/v1.0/teams/{ROSTER_TEAM_ID}/members`
   (paginate via `@odata.nextLink`).
3. Upsert each `aadUserConversationMember` into `members`:
   - `teams_id` ← `userId`
   - `teams_username` ← `email`
   - `display_name` ← `displayName` **only if the row is new**; never
     overwrite (preserves manual overrides).
   - `status` ← `'guest'` if `roles` includes `"guest"`, else `'active'`.

The MSAL Node SDK (`@azure/msal-node`) handles step 1 and token caching;
the Microsoft Graph JS client (`@microsoft/microsoft-graph-client`) handles
step 2. Neither is installed yet.

## Pre-flight checklist

Before merging any Graph code:

- [ ] Entra app registration exists; `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
      `GRAPH_CLIENT_SECRET` set in `/opt/moomie-bot/.env`.
- [ ] Teams app manifest built, zipped, **installed in the orchestra team**
      by an owner; consent dialog showed `TeamMember.Read.Group`.
- [ ] `ROSTER_TEAM_ID` set in `.env`.
- [ ] Secret expiry on someone's calendar.
- [ ] Test call: from a Node REPL with env vars loaded, acquire a token and
      `GET /teams/{ROSTER_TEAM_ID}/members` returns the expected list with
      `displayName` populated.

## Things to watch out for

- **Bot Framework ≠ Graph.** `TEAMS_APP_PASSWORD` does not authenticate
  Graph calls even though both can live on the same app registration. The
  Entra app reg above needs its own client secret for the
  client-credentials request.
- **RSC perms only activate after install.** Granting permissions in the
  manifest is necessary but not sufficient — the team owner must install
  the app. Until then, token requests succeed but every Graph call 403s.
- **RSC is per-team.** Adding a second team later is a second installation,
  not a config change.
- **Guest `email`** in `aadUserConversationMember` is the guest's real
  email, not the mangled `someone_gmail.com#EXT#@…` UPN. One reason to
  prefer the Teams endpoint over the Groups one.
- **Don't sync display names destructively.** Member's preferred written
  name (especially for programs) is canonical. Sync fills it on first
  creation; never overwrites.
- **Manifest version drift.** Microsoft bumps the schema every few months.
  If install starts failing later, regenerate from the latest schema URL.
- **The single biggest "this whole plan doesn't work" risk** is custom-app
  sideloading being disabled in corpnet with no exception process. Confirm
  team owner can install custom apps *before* committing to this approach.

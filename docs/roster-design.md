# Roster design

End-to-end design for moomie-bot's roster feature: tracking which musicians
are signed up for which events, with what role, on which instrument.

For the platform setup that this design depends on, see
[teams-roster-setup.md](teams-roster-setup.md) (Microsoft side) and
[google-sheets-setup.md](google-sheets-setup.md) (Google side).

---

## 1. Surface split

Two chat surfaces, two audiences, two roles for the bot:

| Surface | Audience | What the bot does there |
|---------|----------|------------------------|
| **Discord** | Orchestra **board** (small group, runs logistics) | Tracker, digests, admin overrides, board-only queries |
| **Teams** | **Musicians** (full ~40+ roster) | Roster submissions via @-mention, signup queries |
| **Google Sheets** | Board (bulk editing) + bot (read+write) | Source of truth for per-event signups |

The board overlaps with musicians but is a small fraction. The bot does not
maintain a `discord_id` column on `members` and does not gate board
permissions on a DB lookup — that's a Discord-role check.

---

## 2. Sources of truth

| Concern | Source of truth | Why |
|---|---|---|
| Who is a musician (identity) | **Bot DB `members`**, seeded from Teams RSC sync | Stable IDs, deduplication, validation |
| Sections, role vocabulary, sort orders | Bot DB lookup tables (code-controlled) | Small, stable, easy to PR-review changes |
| Per-event signups (who plays what at concert X) | **Google Sheet** (one tab per event) | Spreadsheet ergonomics for bulk entry; survives the bot |
| Events themselves (id, name, date) | Existing bot DB `events` table from tracker | Already wired |

Bot DB has a **cached, derived** copy of per-event signups. It's
authoritative for queries (so the bot can answer fast and offline-of-Sheets),
but the sheet wins on conflict — re-imports overwrite the cache.

**Write-back model: Option A.** When the bot accepts a signup via Teams or
Discord, it writes back to the spreadsheet in the appropriate cell. The sheet
remains the single source of truth. The bot is just an alternate input
method, never a parallel store.

---

## 3. Schema

All new tables. Follow the existing `registerMigration` pattern in
[src/db.ts](../src/db.ts); put them in a new `src/features/roster/store.ts`.

### `members`

The roster of humans, seeded from Teams.

```sql
CREATE TABLE members (
  id                  INTEGER PRIMARY KEY,
  teams_id            TEXT UNIQUE,           -- Entra object ID; null for off-Teams musicians
  teams_username      TEXT,                  -- email/UPN; null for off-Teams musicians
  display_name        TEXT NOT NULL,         -- canonical "what we call them"
  primary_section_id  INTEGER REFERENCES sections(id),
  status              TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'guest' | 'inactive'
  source              TEXT NOT NULL,         -- 'teams' | 'manual' | 'sheet'
  notes               TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now'))
);
```

Notes:

- **Only `display_name` is required.** All external IDs are independently
  nullable. Off-Teams musicians have just `display_name` + `source='manual'`.
- **Single `display_name` column** — no separate "preferred name" /
  "Teams name" / "guest override." If the Teams `displayName` doesn't match
  what we want in print, edit the row. Sync never overwrites this column on
  existing rows.
- **`primary_section_id` is a hint, not authority.** Used to default the
  section in `/signup` commands and bias autocomplete. Doubling is per-event
  and lives in `event_signups`.
- **No `is_board` flag, no `discord_id` column.** Board status is a Discord
  concern, gated on Discord roles.

### `sections`

Lookup of instrument sections, with print order.

```sql
CREATE TABLE sections (
  id           INTEGER PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,    -- 'violin1', 'violin2', 'flute', 'piccolo', …
  label        TEXT NOT NULL,           -- 'Violin I', 'Violin II', …
  family       TEXT NOT NULL,           -- 'strings' | 'winds' | 'brass' | 'perc' | 'keys' | 'other'
  print_order  INTEGER NOT NULL         -- ascending: lower prints first
);
```

Seed values follow the column ordering observed in concert programs:
strings (Violin I, II, Viola, Cello, Bass) → winds (Flute, Piccolo, Oboe,
E♭ Clarinet, Clarinet, Bass Clarinet, Bassoon, Contrabassoon) → brass (Horn,
Trumpet, Trombone, Euphonium, Tuba) → percussion (Timpani, Percussion) →
keys (Keyboard, Harp). Use big gaps in `print_order` (10, 20, 30, …) to
allow inserts.

### `section_roles`

Lookup of titled roles with explicit print ordering.

```sql
CREATE TABLE section_roles (
  key         TEXT PRIMARY KEY,         -- 'concertmaster', 'principal', …
  label       TEXT NOT NULL,            -- 'Concertmaster' (printed)
  sort_order  INTEGER NOT NULL,         -- ascending; lower prints first
  scope       TEXT NOT NULL             -- 'concertmaster' | 'principal'
);
```

Seed values:

| key | label | sort_order | scope |
|---|---|---|---|
| `concertmaster` | Concertmaster | 10 | concertmaster |
| `asst_concertmaster` | Asst. Concertmaster | 20 | concertmaster |
| `assoc_concertmaster` | Associate Concertmaster | 30 | concertmaster |
| `principal` | Principal | 100 | principal |
| `co_principal` | Co-Principal | 110 | principal |
| `asst_principal` | Asst. Principal | 120 | principal |
| `interim_principal` | Interim Principal | 200 | principal |

Notes:
- Big gaps (10/20, 100/110/120) leave room to insert new titles without
  renumbering.
- **Interim Principal** lives way down the order on purpose — it's
  "covering this concert because the actual principal can't be there,"
  semantically lower than a real principal. Where a section has *only* an
  interim and no full principal, the interim still appears at the top of
  the section because nothing else is above sort_order 200.
- `scope` separates concertmaster-tier (Violin I only) from principal-tier
  (every section). Lets the writer reject "Concertmaster of Tuba."

### `section_leaders`

Optional: who to ping for section-level roster requests.

```sql
CREATE TABLE section_leaders (
  section_id  INTEGER NOT NULL REFERENCES sections(id),
  member_id   INTEGER NOT NULL REFERENCES members(id),
  PRIMARY KEY (section_id, member_id)
);
```

Multiple leaders per section is fine (covers vacation handoffs); one person
leading multiple sections is fine. Standing position, not per-event.

### `event_signups`

The cached per-event roster, mirrored from the spreadsheet.

```sql
CREATE TABLE event_signups (
  event_id    INTEGER NOT NULL REFERENCES events(id),
  member_id   INTEGER NOT NULL REFERENCES members(id),
  section_id  INTEGER NOT NULL REFERENCES sections(id),
  role        TEXT REFERENCES section_roles(key),  -- NULL = section player
  source_row  INTEGER,                              -- which sheet row; debugging
  imported_at TEXT,
  PRIMARY KEY (event_id, member_id, section_id)
);
```

Notes:
- **No `is_doubling` column.** A doubler is a member with two rows for the
  same event in different sections. The asterisk in printed programs is
  computed at export time:
  ```sql
  COUNT(*) OVER (PARTITION BY event_id, member_id) > 1
  ```
- **No `status` column** (yes/no/maybe). The sheet doesn't track those —
  presence in a cell means "playing." If RSVP states are added later,
  they live in a separate `pending_signups` table merged into the sheet
  on confirmation.
- **Co-principals** are just multiple `co_principal` rows in the same
  section at the same event. The PK doesn't constrain how many.
- **Imports are idempotent.** Re-running on the same tab is
  `DELETE FROM event_signups WHERE event_id = ?; INSERT …` in a
  transaction. Loses nothing — sheet is the truth.

### `member_aliases`

Small table for fuzzy fallback when names arrive without an Entra mention.

```sql
CREATE TABLE member_aliases (
  alias       TEXT PRIMARY KEY COLLATE NOCASE,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  created_at  TEXT DEFAULT (datetime('now'))
);
```

Auto-populated when a typed name is successfully resolved (manually or via a
matching `display_name`). Most input arrives with mention entities so this
table stays small; primary use is off-Teams musicians and edge cases (typos,
nicknames). Edge cases that don't resolve are handled by the board manually
updating the spreadsheet — see "Edge cases" below.

---

## 4. Input pipeline

Three input methods, all converging on the same spreadsheet writer.

### A. Teams @-mention with structured user mentions (primary)

```
@Moomie Violin 1 for Shakespeare:
@Isabel (cm) @Mirabai (asst cm) @Audra (interim) @Bonnie @Bryan @Eveline @Ian
```

Bot's flow:

1. **Mention handler** (existing in [src/adapters/teams.ts](../src/adapters/teams.ts))
   receives the activity. Extract all mention entities — each has `aadObjectId`.
2. **Resolve event** from text after stripping mentions. "Shakespeare" → fuzzy
   match against upcoming events. If ambiguous, reply with adaptive card
   picker.
3. **Resolve section** from text. Small fixed vocabulary — string match over
   `sections.label` and `sections.key` plus common variants ("Vln I", "1st
   violin", "violin 1").
4. **Resolve members** by `aadObjectId` → exact match against
   `members.teams_id`. **Zero fuzziness** for the people part.
5. **Parse role hints** in text adjacent to each mention: `(cm)`,
   `(asst)`, `(interim)`, `(principal)`, `(co)`. Small vocabulary; regex.
6. **Reply with confirmation adaptive card** showing the parsed result
   ("About to add 7 musicians to Violin I for April Shakespeare") with
   Confirm / Edit / Cancel buttons.
7. **On confirm:** writer pushes to the spreadsheet, importer-style code
   refreshes `event_signups` cache.

### B. Adaptive card with people picker (deliberate path)

For section leaders who prefer clicking. Bot exposes
`@Moomie new roster` (or a slash-command suggestion in the manifest) →
replies with an empty card containing event dropdown, section dropdown
defaulted from caller's primary, and a multi-people-picker (Entra-resolved).
Submit → same writer + cache refresh as path A.

### C. Discord slash commands (board path)

```
/roster signup event:April section:violin1 member:<autocomplete> [role:asst_concertmaster]
/roster remove event:April member:<autocomplete> [section:violin1]
/roster show event:April [section:violin1]
/roster ask-leaders event:April [sections:winds,brass]
```

Standard Discord slash commands with parameter autocomplete (typed args,
choice menus, etc.). Gated on Discord board role for write commands; read
commands open to anyone in board channels.

### D. Free-text fallback (LLM parse, low-priority)

For Teams messages that mention `@Moomie` but contain no structured user
mentions ("here's the roster: Isabel, Mirabai, Audra…"), the bot falls back
to LLM-parse using the existing Gemini integration. Lower confidence; the
confirmation card is mandatory before any sheet write.

If a name doesn't resolve via mentions, `display_name`, or `member_aliases`,
the bot replies with an "I couldn't match these names: …" message and asks
the submitter to either re-tag with a mention or update the spreadsheet
directly. **No silent guessing.**

---

## 5. Spreadsheet write contract

Both the importer (sheet → DB) and the writer (DB → sheet) share one
parser. Document the sheet's structural conventions once and stick to them:

- **Tab naming:** `YYYY-MM Concert Name` (or whatever the existing
  convention is — check before coding). Importer matches `event.date` to
  the relevant tab.
- **Section detection:** First row contains section header text; subsequent
  rows contain musician names. Specifics depend on actual sheet layout —
  inspect a few CSV exports before finalizing.
- **Asterisks for doubling:** Writer appends `*` automatically when the
  same member is being placed in another section for this event. Importer
  recognizes them, but `event_signups` doesn't store the flag — derived at
  export time.
- **Principal markers:** TBD based on sheet inspection. If the sheet
  encodes role separately (column, italics, suffix), parse/write it. If
  not, role is bot-DB-only metadata that gets stripped at sheet level.
- **Empty cells:** `NULL`, ignored. Removing a signup = clearing the cell.

Build the parser once, **integration-test it against real exported tabs**
before going live. Sheet layout drift is the single biggest fragility risk.

---

## 6. Sync & reconciliation

- **Pull on demand.** `/roster sync event:<x>` (board, Discord) re-imports
  one tab. Simple, explicit, debuggable.
- **Pull after every bot write.** Writer round-trips: write the cell, read
  the affected range back, refresh `event_signups`. Cheap and keeps cache
  honest.
- **Optional scheduled pull.** Cron-style hourly background pull for active
  events. Add only if drift becomes a real problem; on-demand may suffice.

Conflict model: **the sheet always wins.** If a board member edits the
sheet while the bot is mid-flight, the next pull restores their edit. Bot
overlay rows do not exist (we're not in Option C of the earlier design
discussion).

---

## 7. Side-event flow

Small ad-hoc events (chamber gigs, brunches, weddings) lean on the same
infrastructure with one extra command:

```
/roster ask-section event:May30Brunch section:flute count:1
```

Bot:
1. DMs (or @-mentions in the team channel) the section's `section_leaders`.
2. Tracks responses; nudges the leader after N days if no movement.
3. When the leader replies (Teams @-mention path A or card path B), bot
   writes to the sheet's brunch tab same as for a full concert.

Side events get their own tab in the sheet — no special-casing in the
schema. They're just `events` rows like any other.

---

## 8. Export / publishing

The bot can render the roster in the print-program format on demand:

```
/program export event:April2026 format:md|csv|pdf
```

Sort within each section by:

```sql
ORDER BY
  COALESCE(r.sort_order, 999999),  -- titled roles first, by rank
  m.display_name COLLATE NOCASE    -- then alpha (first-name based,
                                   --  since display_name = "Isabel Milewski")
```

Asterisks for doublers via the window-function trick from §3. Section
columns laid out per `sections.print_order`.

---

## 9. Edge cases

- **Off-Teams musicians.** Manually added via `/roster member add` (board
  Discord command). `teams_id` and `teams_username` null; addressable by
  `display_name` only. Submitter has to type the name (no @-mention
  available); resolves via `display_name` exact match, then
  `member_aliases`, then "I couldn't match this name" reply.
- **Members renamed in Entra.** Sync touches `display_name` only on first
  insert, never updates. If the human wants the new name in print, they
  edit the row.
- **Two musicians with the same display name.** Disambiguate at insert
  time (board has to give one a distinguishing suffix). Mention-based
  signup handles this naturally — `aadObjectId` is unique.
- **Co-principals with non-trivial precedence.** Print as alphabetical
  among co-principals (sort_order 110). If a real "1st co" / "2nd co"
  distinction matters someday, add `co_principal_1` / `co_principal_2`
  rows with sort_order 110/115.
- **Sheet structure drifts.** Writer rejects writes when it can't find
  the expected anchor cells. Importer flags rows it couldn't parse.
  Don't paper over.
- **Anything truly weird (one-off ensembles, special section like
  off-stage brass, doubling on something not in `sections`).** Board
  edits the spreadsheet directly. The bot doesn't need to handle every
  concert layout perfectly; it needs to handle the common case well and
  stay out of the way for outliers.

---

## 10. Build order

Suggested sequencing:

1. **Schema migration.** `members`, `sections`, `section_roles`,
   `section_leaders`, `event_signups`, `member_aliases`. Seed `sections`
   and `section_roles` with the values above.
2. **Teams RSC sync** (per [teams-roster-setup.md](teams-roster-setup.md)).
   Populate `members` from `GET /teams/{id}/members`.
3. **Google Sheets adapter** (per [google-sheets-setup.md](google-sheets-setup.md)).
   Read-only first: list tabs, dump rows.
4. **Importer.** One-time bulk: parse historical tabs into `event_signups`
   for archive value (and to validate the parser against real layouts).
5. **Read commands.** `/roster show`, `/roster history`,
   `/program export`. Bot is useful at this point even with no write path.
6. **Writer.** Sheet-write code path. Add to a feature flag while testing.
7. **Discord slash commands** for board (`/roster signup`, `/roster remove`,
   `/roster ask-leaders`). Use the writer.
8. **Teams @-mention pipeline** (path A). Mention handler + parse +
   confirmation card + writer.
9. **Adaptive card path B.** Card scaffold + Submit handler + writer.
10. **Side-event nudges & scheduled pulls** if needed.

Each step is independently shippable. Stop at any point and the bot is
still useful.

---

## 11. What's deliberately out of scope

- **Two-way merge of conflicting concurrent edits.** Sheet always wins.
- **Self-service signup state machines** (yes/no/maybe with deadlines).
  Add later if real demand emerges; not in v1.
- **Per-event section requirements** ("we need exactly 4 violins for this
  brunch"). Implicit for now — leaders fill what they fill, board reviews
  at the sheet.
- **Stable historical record beyond the sheet.** The sheet *is* the
  history. Bot's `event_signups` cache is rebuildable from it.
- **Discord ↔ Teams identity linking.** No `discord_id`, no `/link`.
- **Calendar integration / Outlook RSVPs.** Possible future; not in this
  design.

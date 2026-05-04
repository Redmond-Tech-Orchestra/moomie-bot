# Moomie Project Manager — Implementation Plan

## Overview

Moomie acts as a lightweight project coordinator for a 21-person volunteer orchestra that operates on **event-driven timelines**, not sprints. Work revolves around upcoming concerts with T-minus countdowns, cross-functional collaboration (same people wear logistics, marketing, and librarian hats), and decisions made conversationally in Discord.

The tool should feel like a helpful stage manager — not an agile coach.

---

## How This Team Actually Works

**Observations from server activity:**

- **Event-driven, not sprint-driven** — work orbits upcoming events (7/16 Shakespeare, 8/1 Concerto, 9/5 Redmond Park). Each event has its own channel and T-minus timeline.
2. **3-4 people drive everything** — Peter (conductor/lead), Jada (admin/logistics), Nandhini (marketing/admin), Rachel (venues). Decisions happen fast in conversation.
3. **Cross-functional by necessity** — Jada is admin + logistics + marketing. Ethan is finances + librarian. People don't think in "swim lanes."
4. **Commitments are made conversationally** — "I'll ask Joshua about November dates" or "I'm doing group strings first week of May." These aren't tracked anywhere.
- **Phases, not sprints** — event prep follows: venue lock → music selection → rehearsal scheduling → marketing ramp → ticket sales → day-of logistics.
6. **Volunteers, not employees** — no daily standups, no velocity metrics. People contribute when they can. The risk is things falling through cracks, not "low throughput."
7. **Archival = done** — past events get archived as channels. No formal close-out.

---

## What Moomie Should Actually Do

### Core Problem
Things people said they'd do get lost in chat. No one has a single view of "what still needs to happen for the July event?" The conductor (Peter) ends up being the human tracking system.

### Design Principles
- **Zero-effort tracking** — the board populates itself from conversation; nobody "files" anything
- **Concert-centric**, not project-board-centric
- **Extract commitments from conversation**, don't ask people to file tickets
- **Surface what's falling through cracks**, don't generate busywork
- **Respect volunteer time** — no nagging, no daily rituals

---

## Commands

### `/digest [window]`

*(Already built, enhance with event context)*

Summarize server activity, but organize by **upcoming event** rather than just chronologically.

**Output structure:**
```
## 🎭 Shakespeare Concert (Jul 16) — T-7 weeks

### Progress
- MSFT Theatre Troupe interested, will do monologues (#7-1618-shakespeare)
- Venue confirmed: [location] (#concert-venue)

### Commitments Made
- Peter: group strings first week of May, individual sectionals in June (#rehearsals)
- Rachel: asking Joshua about November dates for fall concert (#concert-venue)

### Needs Follow-up
- Catering for 7/16 not yet planned (mentioned 4/30, no update) (#general)
- Flute/brass/percussion coaching — waiting on Vicky (mentioned 4/19) (#rehearsals)

## 🎵 Concerto Competition (Aug 1)
...

## 🌳 Redmond Park (Sep 5)
- Date changed from 9/22 to 9/5 (Justine, 4/19)
- No other activity yet

## 🔧 Org-wide
- Board roles being formalized — Jada looking for designers (#general)
- Squarespace cancelled, new website live (#website)
- Newsletter emails: keeping export, not using Squarespace tool (#website)
```

### `/board`

Show an event-centric status view — what's tracked, what's overdue, what needs an owner.

**Interaction:** The `event` option uses Discord's autocomplete — as the user types, Moomie suggests active events (those with `date >= today`). This avoids showing archived events and lets users quickly pick which event they care about.

```
/board event:Shakespeare
/board event:Concerto Competition
```

If no event is specified, shows a brief overview of all active events (just counts: X open, Y overdue) with a hint to pick one for details.

**Not a GitHub Projects board view.** Instead, Moomie maintains its own lightweight tracker (SQLite) populated **automatically** from:
1. Commitments extracted from conversation (burst detection) — the primary source
2. Event milestones auto-generated when a new Performances channel appears

**Output:**
```
## 🎭 Shakespeare (Jul 16) — T-7 weeks

✅ Venue confirmed
✅ Theatre troupe collaboration initiated
⏳ Sectional coaching (waiting on Vicky) — Peter
⏳ Catering plan — unowned
⬜ Marketing launch (target: T-6 = Jun 4)
⬜ Tickets available (target: T-8 = May 21... OVERDUE)
⬜ Concert program draft — librarians

## 🎵 Concerto Competition (Aug 1) — T-12 weeks
⬜ Venue confirmed (Redmond Senior Center) — Jada
⬜ Soloist applications open
...
```

### `/events`

List upcoming events with dates and T-minus:
```
🎭 Shakespeare — Jul 16 (T-7 weeks)
🎵 Concerto Competition — Aug 1 (T-12 weeks)
🌳 Redmond Park — Sep 5 (T-17 weeks)
```

---

## Passive Conversation Watching (Burst Detection)

Moomie listens to all messages and surfaces action items **only when it detects something worth tracking** — otherwise stays silent.

### How It Works

1. **Buffer**: Moomie listens to `messageCreate` and buffers messages in memory, grouped by channel
2. **Trigger**: When a channel goes **quiet for 10 minutes** after a burst of **5+ non-bot messages**, the batch is sent to Gemini
3. **Classify**: Gemini determines if there are commitments, decisions, or follow-ups worth tracking
4. **De-dupe**: Check extracted items against existing tracker (see [Item De-duplication](#item-de-duplication) below). Already-tracked items are silently dropped; near-matches are flagged.
5. **Surface (only if actionable)**: Moomie posts a brief message in the channel with what it found **and any clarifying questions**:
   ```
   📋 I noticed some action items from this conversation:

   1. @rachel — ask Joshua about November dates (for which event?)
   2. Catering for 7/16 — needs planning (owner: @jada? or unassigned?)
   3. Peter — group strings first week of May ✓ (→ Shakespeare)

   Questions:
   • #1: Is this for a fall concert or something else?
   • #2: Jada, is this yours?

   Reply to confirm/correct, or react ❌ to dismiss all.
   ```
5. **If nothing actionable** → Moomie says nothing. No one knows it processed anything.

### On Confirmation

Moomie waits for replies to resolve ambiguity before committing items to the tracker:

- **Direct reply** → Moomie updates the item (e.g. "1 is for the fall concert", "2 yes that's me")
- **✅ reaction on Moomie's message** → all items confirmed as-is, questions treated as "best guess is fine"
- **❌ reaction** → dismissed, nothing tracked
- **No response after 24 hours** → items with no ambiguity are auto-tracked; ambiguous items are dropped with a quiet note: "I wasn't sure about #1 and #2, so I didn't track them. Use `/track` if needed."

### What Counts as Ambiguous

Gemini is instructed to flag uncertainty:
- **Event unclear**: commitment made in a cross-cutting channel, multiple events are active
- **Owner unclear**: "we need to do X" — who is "we"?
- **Deadline unclear**: "soon" or "before the concert" — which concert?
- **Scope unclear**: "handle the marketing" — what specifically?

Moomie asks **at most 2-3 questions** per extraction. If everything is ambiguous, it's probably not concrete enough to track.

### Cost & Noise Controls

| Rule | Purpose |
|------|---------|
| Minimum 5 non-bot messages to trigger | Skip casual one-liners |
| 10-minute quiet gap | Don't interrupt active conversations |
| Max 1 extraction per channel per hour | Prevent spam during extended activity |
| Skip Archived category channels | No point processing old channels |
| Max 50 messages in buffer (oldest roll off) | Memory bound |
| Buffer discarded if <5 messages when quiet triggers | Skip low-signal chatter |

### System Prompt for Burst Classification

```
You are observing a conversation in a Discord server for a volunteer orchestra.
Your job: identify concrete action items, commitments, or decisions that should be tracked.

Known upcoming events:
${JSON.stringify(activeEvents)}

Rules:
- Only flag CONCRETE commitments ("I'll do X by Y") or decisions ("let's go with X")
- Do NOT flag casual discussion, brainstorming, or vague intentions
- Do NOT flag things that are clearly already done in the conversation
- If someone asks a question but no one commits to action, that's not an action item
- Return empty array if nothing is worth tracking

For each item, assess confidence:
- "confident": event, owner, and action are all clear from context
- "needs_clarification": something is ambiguous — specify WHAT is unclear

Return JSON:
{
  "items": [
    {
      "description": "...",
      "owner": "display name or null",
      "event": "event name or null",
      "deadline": "YYYY-MM-DD or null",
      "confidence": "confident" | "needs_clarification",
      "question": "What is unclear (only if needs_clarification)"
    }
  ],
  "completions": [
    {
      "description": "what was completed (match to existing tracker item)",
      "owner": "display name",
      "evidence": "quote or paraphrase from conversation"
    }
  ]
}

If nothing actionable, return: { "items": [], "completions": [] }
```

### Implementation

```
src/features/tracker/conversation-watcher.ts
```

- In-memory `Map<channelId, { messages: [], lastActivity: Date, timer: NodeJS.Timeout }>`
- On each message: push to buffer, reset the 10-min quiet timer
- When timer fires: check buffer length ≥ 5, check rate limit, call Gemini, post if actionable
- On bot startup: register `messageCreate` listener (only for guild text channels, non-bot)

---

## Automatic Completion Detection

The same burst detection pipeline that finds new commitments also detects when tracked items are **done**. Moomie watches for completion signals in conversation and marks items accordingly — no manual check-in required.

### Completion Signals

Gemini looks for phrases that indicate a tracked item is resolved:
- **Explicit done**: "venue is booked", "tickets are live", "I sent the newsletter"
- **Confirmed by others**: "got your email, looks good" (confirms someone completed a delivery)
- **Outcome reported**: "Joshua said November 12 works" (resolves "ask Joshua about dates")
- **Moved past**: scheduling a rehearsal confirms "publish rehearsal schedule"

### How It Works

1. When a burst is processed, Gemini receives both the conversation AND the list of open items for relevant events
2. Gemini returns `completions[]` alongside new `items[]`
3. For each completion, Moomie fuzzy-matches against open tracker items (same event + similar description + matching owner)
4. **Confident matches** → auto-marked as done, brief confirmation posted:
   ```
   ✅ Marked done: "Ask Joshua about November dates" (@rachel)
   Evidence: "Joshua confirmed Nov 12 works" (just now in #concert-venue)
   ```
5. **Uncertain matches** → Moomie asks: "Did this resolve 'Ask Joshua about dates'? ✅/❌"

### System Prompt Addition

Added to the burst classification prompt:
```
Also check if any of these OPEN tracked items have been completed based on the conversation:
${JSON.stringify(openItemsForRelevantEvents)}

Look for:
- Someone saying they finished something
- Outcomes that resolve a pending question/task
- Actions that make a tracked item redundant

Return completions with evidence (a quote or paraphrase proving it's done).
```

### Staleness Detection

Items that haven't been mentioned or updated in a configurable window (default: 14 days) are marked `stale`. This feeds into `/nudge` — stale items are the primary candidates for nudging.

---

## Item De-duplication

Whenever a work item is about to be added — whether from burst extraction, `/digest` commitments, `/track`, or milestone templates — Moomie checks for duplicates against existing open items for the same event.

### Matching Strategy

1. **Exact match** — same owner + same description (normalized: lowercase, trimmed) → silently skip
2. **LLM match** — Gemini receives the new item + list of open items for the same event and determines if it's a duplicate. Cheaper than semantic embeddings and handles paraphrasing naturally ("handle catering" vs "plan catering for dinner break").

### When a Potential Duplicate Is Detected

Moomie asks before adding:
```
⚠️ This looks similar to something already tracked:

New: "Plan catering for dinner break" (@jada, Shakespeare)
Existing: "Catering for 7/16 needs planning" (@jada, Shakespeare) — open since Apr 30

Same item? Reply "same" to skip, or "new" to track separately.
```

- **"same"** → new item is dropped (optionally updates the existing item's description if the new one is more specific)
- **"new"** → added as a separate item
- **No response after 24 hours** → treated as "same" (safe default — avoids clutter)

### Where This Runs

| Source | De-dupe behavior |
|--------|-----------------|
| Burst extraction | Part of the same Gemini call — open items are in context, so Gemini avoids re-extracting them |

| Milestone templates | Exact-match on description + event_id (idempotent on restart) |
| `/digest` extraction | Same as burst extraction |

---

## Slash Command Autocomplete

All commands with an `event` option use Discord's autocomplete API. When the user starts typing:

1. Moomie queries `SELECT id, name, date FROM events WHERE date >= date('now') ORDER BY date`
2. Returns up to 25 choices as `{ name: "Shakespeare (Jul 16)", value: "<id>" }`
3. If the user has typed partial text, filters with `LIKE '%input%'`

This keeps archived/past events out of the way while allowing quick selection when planning overlaps (e.g. working on Shakespeare + Concerto Competition simultaneously).

**Implementation:** One shared `autocompleteEvent(interaction)` handler registered on the `interactionCreate` event, checking `interaction.isAutocomplete()` and `interaction.options.getFocused(true).name === 'event'`.

---

### No GitHub Projects Board

After seeing how this team works, a GitHub Projects board adds friction. Volunteers won't go update cards. Instead, Moomie maintains its own tracker in SQLite, populated automatically from conversation extraction and channel structure.

If you want GitHub integration later, Moomie can sync items → GitHub Issues for visibility on the org page, but the source of truth stays in Discord.

---

## Automatic Event Detection

Events are **never manually created**. Moomie watches the **Performances** category for new channels.

### How It Works

1. On startup, Moomie scans the Performances category and syncs channels → `events` table
2. At runtime, Moomie listens for `channelCreate` events — if a new channel appears under Performances, a new event is created automatically
3. When a channel is moved to the **Archived** category, the event is marked as `archived`

### Channel Name → Event Data

Performances channels follow the naming pattern: `<month>-<dates>-<name>`

**Examples:**
- `7-1618-shakespeare` → July, dates 16+18 (multi-day), "Shakespeare"
- `8-1-concerto` → August 1, "Concerto"
- `9-5-redmond-park` → September 5, "Redmond Park"

**Parsing rules:**
1. Split on first `-` → month number
2. Second segment: if all digits, parse as date(s)
   - Single date: `1` → day 1
   - Multi-date: `1618` → split into valid day pairs: 16, 18 (try 2-digit chunks left to right)
   - Ambiguous: `112` → could be 1+12 or 11+2 — ask for clarification
3. Remaining segments joined → event name (hyphen → space, title case)
4. **Year**: infer as the next occurrence of that month from today. If month has already passed this year, assume next year.

**When ambiguous or unparseable**, Moomie asks in the channel instead of guessing wrong:

```
📅 New performance channel detected!

I see: #7-1618-shakespeare
My best guess: **Shakespeare** on **Jul 16–18, 2026** (multi-day event)

Is this right? Reply with corrections if not:
• Event name?
• Date(s)? (e.g. "Jul 16 and Jul 18" or "Jul 16-18")
```

Moomie **waits for a reply** (with a 48-hour timeout) before creating milestones. This prevents wrong dates from generating bad milestone deadlines.

**Multi-day events:** stored with the first date as `date` and an optional `end_date` field:
```sql
ALTER TABLE events ADD COLUMN end_date TEXT; -- NULL for single-day events
```

### Startup Sync

```
for each channel in Performances category:
  if not in events table → create event (parse name/date from channel name)
  if in events table but channel moved to Archived → mark event archived
```

Env config:
```
PERFORMANCES_CATEGORY_ID=<category snowflake>
ARCHIVED_CATEGORY_ID=<category snowflake>
```

### SQLite Tables

```sql
-- Upcoming events (the anchors for all work)
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,           -- "Shakespeare"
  date TEXT NOT NULL,           -- "2026-07-16"
  end_date TEXT,               -- "2026-07-18" (NULL for single-day events)
  channel TEXT,                 -- "7-1618-shakespeare"
  confirmed INTEGER DEFAULT 0, -- 0 = awaiting confirmation, 1 = confirmed
  archived INTEGER DEFAULT 0,  -- 1 when channel moves to Archived category
  created_at TEXT DEFAULT (datetime('now'))
);

-- Tracked items (commitments, tasks, milestones)
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  event_id INTEGER REFERENCES events(id),
  description TEXT NOT NULL,
  owner_id TEXT,               -- Discord user ID
  owner_name TEXT,             -- Display name
  status TEXT DEFAULT 'open',  -- open | done | stale
  target_date TEXT,            -- Specific date (e.g. "2026-05-21")
  source TEXT,                 -- "extracted" | "manual" | "template"
  source_channel TEXT,         -- Where it was mentioned
  source_date TEXT,            -- When it was mentioned
  last_mentioned TEXT,         -- Last time this item came up in conversation
  created_at TEXT DEFAULT (datetime('now'))
);

-- Status updates / check-in log
CREATE TABLE updates (
  id INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES items(id),
  user_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Event milestone templates (auto-applied when an event is created)
-- target_date is computed at creation time: event.date - offset_days
CREATE TABLE milestone_templates (
  id INTEGER PRIMARY KEY,
  description TEXT NOT NULL,       -- "Tickets available"
  offset_days INTEGER NOT NULL,    -- Days before event (e.g. 56 = 8 weeks)
  default_role TEXT               -- "marketing", "logistics", etc.
);
```

When an event is created, Moomie generates items from templates with concrete `target_date` values (event date minus `offset_days`). T-minus is always computed at display time from `target_date` relative to today.

### Milestone Templates

Pre-populated based on observed concert planning pattern:

| Offset | Milestone | Default owner role |
|--------|-----------|-------------------|
| 112 days (16 wk) | Venue confirmed | logistics |
| 84 days (12 wk) | Music selected / scores distributed | librarian |
| 70 days (10 wk) | Rehearsal schedule published | logistics |
| 56 days (8 wk) | Tickets available | marketing |
| 42 days (6 wk) | Marketing in full swing | marketing |
| 28 days (4 wk) | Concert program draft | librarian |
| 14 days (2 wk) | Day-of logistics finalized | logistics |
| 7 days (1 wk) | Final rehearsal | — |
| 0 days | Event day | — |

When a new event is added, Moomie computes `target_date = event.date - offset_days` for each template and creates concrete items.

---

## Intelligent Conversation → Event Mapping

When `/digest` or commitment extraction runs, Moomie needs to figure out which event a conversation belongs to. This is done automatically:

### Mapping Rules (in priority order)

1. **Channel is an event channel** — messages in `#7-1618-shakespeare` → Shakespeare event (direct match via `events.channel`)
2. **Channel mentions an event** — messages in `#concert-venue` that reference "Shakespeare" or "7/16" → mapped by Gemini
3. **Cross-cutting channels** — `#rehearsals`, `#ticket-sales`, `#marketing`, etc. may reference multiple events. Gemini classifies each conversation thread to the relevant event(s), or "Org-wide" if no specific event.

### How Gemini Does It

When processing channel history, the system prompt includes:
```
Known upcoming events:
- Shakespeare (Jul 16, 2026) — channel: #7-1618-shakespeare
- Concerto Competition (Aug 1, 2026) — channel: #8-1-concerto
- Redmond Park (Sep 5, 2026) — channel: #9-5-redmond-park

For each conversation segment, identify which event it relates to.
If a message doesn't relate to a specific event, classify it as "org-wide".
Messages can relate to multiple events.
```

This means conversations in `#rehearsals` about "first week of May strings" get mapped to Shakespeare (the next upcoming event needing rehearsals), and messages in `#concert-venue` about "November dates" get flagged as a future event not yet created.

---

When `/digest` runs, Gemini also extracts commitments in structured form:

**System prompt addition:**
```
Also extract any commitments or action items as structured data:
- WHO said they would do WHAT
- Any mentioned deadlines or timeframes
- Which concert it relates to (if apparent)

Return these as a JSON array in an ```actions``` code block:
[{"who": "Peter", "what": "group strings first week of May", "concert": "shakespeare", "deadline": "2026-05-07", "channel": "rehearsals"}]
```

Moomie then:
1. Fuzzy-matches "who" against server members
2. Matches "concert" against known events
3. Creates/updates items in the tracker
4. Flags new extractions for confirmation: "I found 3 new commitments — want me to track them?"

---

## Dual Processing: Moomie (Discord) + VS Code (Claude)

The extraction logic is shared as **prompts** so you can run the same analysis two ways:

| Surface | Model | Use case |
|---------|-------|----------|
| Moomie in Discord | Gemini Flash | Routine: burst detection, `/digest`, automatic extraction |
| VS Code `/digest` prompt | Claude (or any Copilot model) | Deep analysis: review Moomie's extractions, process complex conversations, strategic planning |

### Files

| File | Scope | Purpose |
|------|-------|---------|
| `.github/instructions/orchestra-context.instructions.md` | Workspace | Domain knowledge auto-loaded when editing moomie-bot |
| `.github/prompts/digest.prompt.md` | Workspace | Full digest analysis — paste conversation, get structured output |
| `.github/prompts/review-extractions.prompt.md` | Workspace | Review/correct Moomie's automated extractions |
| `~/.../prompts/orchestra-digest.prompt.md` | User (roaming) | Available in any workspace for quick analysis |

### Workflow

1. Moomie runs routine extraction in Discord (Gemini, cheap, automated)
2. When you want deeper review or Moomie's output seems off:
   - Open VS Code, type `/digest` in chat
   - Paste the conversation or Moomie's extraction
   - Claude (Opus/Sonnet) processes with the same domain knowledge but more reasoning power
3. Use `/review-extractions` to validate Moomie's automated output before confirming

This keeps the prompts as the **single source of truth** for extraction logic — Moomie's Gemini prompts and the VS Code prompts encode the same rules.

---

## Build Order

| Phase | What | Effort |
|-------|------|--------|
| 1 | Auto event detection (channel watcher + startup sync) | Medium |
| 2 | Event + item tables, `/events` command | Small |
| 3 | Conversation burst watcher + Gemini extraction | Medium |
| 4 | `/board` command (event-centric view) | Medium |
| 5 | Milestone templates + auto-generation on event confirm | Small |
| 6 | Enhance `/digest` with event mapping + commitment extraction | Medium |

---

## Open Questions

1. ~~**Concert channel naming**~~ — Resolved: auto-detect from Performances category, parse date from channel name, confirm in-channel before committing
2. ~~**Commitment extraction confidence**~~ — Resolved: Moomie asks clarifying questions for ambiguous items, auto-tracks confident ones after ✅ or 24hr timeout
3. **Archive trigger** — when a channel moves to Archived category, auto-mark event + items as done?
5. **Future events mentioned in chat** — if someone mentions "November concert" but no channel exists yet, should Moomie flag it as "planned but not yet created"?


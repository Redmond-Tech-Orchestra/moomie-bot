# Ideas backlog

Punted ideas from the May 22 2026 session. Each item has a sketch of the
implementation, files to touch, rough effort, and dependencies on other
items so you can pick something coherent to spend a day on.

## At-a-glance

| # | Idea | Effort | Depends on | Value |
|---|---|---|---|---|
| 1 | Auto-include scoped recent context (thread / reply-chain / bot-involvement) | S | — | High — kills "those 3?" ambiguity without channel pollution |
| 2 | File attachments out of chat (CSV) | M | — | High — unlocks data export |
| 3 | Chart PNGs from the analyze sandbox | S | #2 | High — same plumbing as #2 |
| 4 | Persist full LLM trace to `audit_log.output_json` | S | — | Medium — observability |
| 5 | Live LLM-turn thread in Discord | M | #4 (nice-to-have) | Medium — live debugging |
| 6 | Per-conversation sliding-window memory | M | partially subsumed by #1 | Medium — mostly relevant in DMs |
| 7 | Deploy blackout mitigation (announce / catch-up) | S–M | — | Low–Medium — reliability |
| 8 | Pronoun-aware auto-history-fetch | — | fully subsumed by #1 | drop |
| 9 | Tool-error resilience & failure visibility | S | enables #5 | High — one bad tool currently kills the whole turn |
| 10 | Consolidate `moomie-bot` / `feedback` label flow (rich-prompt rehydration on retry) | S | — | Medium — kills the swap-labels-to-retry workaround |
| 11 | Coding agent's SIGTERM doesn't actually stop gemini-cli (orphan keeps running, no failure comment on the issue) | S–M | — | Medium — wastes API quota, hides outcome, can race with retry |

S = ~half day. M = ~one day. L = multi-day.

**Shipped from this session (May 22–23 2026):**
- Coding agent: pre-install `npm ci` in `cloneOrPull` (PR #32) — ~5 min saved per cold job.
- Coding agent: replace `fs.watch` with mtime-polling watchdog (PR #32) — idle timer no longer kills live agents during long tool calls.

---

## 1. Auto-include scoped recent context

**Problem.** [`handle-message.ts`](../src/features/chat/handle-message.ts) builds `contents` with only the
current user message. If the user references prior turns ("those 3 events",
"the one you mentioned before"), Pro either guesses or defensively calls
`read_channel_messages` — which we saw cause the loop bug.

**Naive approach (rejected).** "Just include the last N channel messages."
This pollutes context in busy channels (#general, social) with completely
unrelated chatter. A user asking Moomie about ticket sales would have
their prompt padded with someone else's pun thread from 30 seconds ago.

**Better approach: scoped retrieval.** Only include messages that are
demonstrably part of the conversation the user is having *with Moomie*.
Apply these filters, in order:

1. **Thread-first.** If the user's message is in a Discord thread, fetch
   the last ~6 messages from that thread and nothing else. Threads are
   already topically scoped by design — this case is the win and
   probably covers 60%+ of legitimate "context needed" turns.
2. **Reply chain.** If the user's message is a reply to a Moomie message,
   walk the reply chain backwards up to ~3 hops (each Moomie reply might
   have been a reply to another Moomie message in a back-and-forth). The
   existing referenced-message fetch in [`discord.ts`](../src/adapters/discord.ts#L233)
   already does one hop — extend to N.
3. **Bot-involvement filter for plain channels.** When neither of the
   above applies (top-level @mention in a normal channel), fetch the
   last ~20 messages, keep **only**:
   - messages authored by the bot
   - messages that @mention the bot
   - messages from the requesting user that are *replies to* the bot
   - messages from the requesting user within a small time window
     (~2 min) of a bot message
   Then take the most recent ~4 of those. This isolates the user↔Moomie
   thread of conversation even inside a noisy channel.
4. **Time cap.** Drop anything older than 10 minutes regardless of the
   above filters. Older context is rarely what "that" refers to and
   usually hurts more than helps.
5. **Per-message truncation.** Cap each retained message at ~400 chars.
6. **Hard upper bound.** Never more than ~2 KB of total context regardless
   of filters. Cheap insurance against pathological cases.

**Sketch.**

```ts
// new helper, src/features/chat/recent-context.ts
export async function fetchScopedContext(
  message: Message,
  client: Client,
): Promise<Array<{ role: 'user' | 'model'; parts: [{ text: string }] }>> {
  if (message.channel.isThread()) {
    return fromThread(message, 6);
  }
  if (message.reference?.messageId) {
    return walkReplyChain(message, 3);
  }
  return botInvolvementFilter(message, client.user!.id, 4);
}

// in handle-message.ts, before the loop
const priorTurns = await fetchScopedContext(message, client);
const contents = [
  ...priorTurns,
  { role: 'user', parts: [{ text: message.content }] },
];
```

**Files.**
- `src/features/chat/recent-context.ts` — new scoped-retrieval helper
- `src/adapters/discord.ts` — wire it in before the `handleChatMessage`
  call (and pass the resulting array through to `handleChatMessage` as a
  new optional parameter)
- `src/features/chat/handle-message.ts` — accept the prior-turns array,
  prepend to `contents`
- `src/prompts/chat-system.md` — note that recent scoped context is
  pre-loaded so Pro shouldn't reach for `read_channel_messages` to
  reconstruct the current conversation

**Cost in busy channels.** With the bot-involvement filter, even in
#general the typical addition is 1–2 short messages (Moomie's prior
reply + maybe a one-line user clarification) = ~200 tokens. Negligible
both in price and in attention dilution.

**Risk.** The bot-involvement filter has edge cases:
- Multiple users talking to Moomie in quick succession could get their
  contexts crossed. Mitigation: also filter by `author.id == requesting
  user OR bot`.
- A user mentioning Moomie and then asking a follow-up *without*
  mentioning them again (relying on threading) won't be captured unless
  they're using Discord replies. Acceptable — that's already a UX they
  have to learn for normal channels.

**Effort.** Half day for the helper + wiring + a couple of test runs in
different channel types.

**Subsumes #8** entirely. Removes most of the motivation for #6 too,
though #6 still adds value for rapid back-and-forth in DMs.

---

## 2. File attachments out of chat (CSV)

**Problem.** `handleChatMessage` returns a `string`. Pro can produce CSV
text but it gets chunked and rendered as a code block, which is unreadable
for non-trivial exports.

**Sketch.**

1. Change return type:
   ```ts
   export interface ChatReply {
     text: string;
     files?: Array<{ name: string; data: Buffer; description?: string }>;
   }
   export async function handleChatMessage(msg: ChatMessage): Promise<ChatReply>;
   ```

2. Add a tool that takes a filename and contents and emits a file handle.
   Either generic (`attach_file`) or specific
   (`export_eventbrite_attendees`). Suggest **specific** for safety —
   makes the data flow auditable and prevents Pro from inventing weird
   exports.

3. The tool loop collects any files produced into a request-scoped array;
   the final `ChatReply` includes them alongside the text.

4. Discord adapter passes them via `discord.js`'s `AttachmentBuilder`:
   ```ts
   const files = reply.files?.map((f) => new AttachmentBuilder(f.data, { name: f.name }));
   await message.reply({ content: chunks[0], files });
   ```

5. Add a system-prompt nudge: "When the user asks for raw data, an export,
   or a CSV, prefer the export tool over inlining CSV text."

**Files.**
- `src/features/chat/handle-message.ts` — return-type change + collect files
- `src/features/chat/tools.ts` — new export tool(s)
- `src/features/eventbrite/analyze.ts` — extend the sandbox protocol to
  let Python write a file the chat handler can pick up (write to a known
  working dir, scan for `*.csv` after execution)
- `src/adapters/discord.ts` — pass `files:` to `message.reply`
- `src/prompts/chat-system.md` — nudge
- `src/features/sandbox/python-runner.ts` — already creates a tmpdir
  per run; expose its path so the caller can read files out of it before
  cleanup

**Caveats.**
- Discord bot file upload limit on a free server is 25 MB; way more than
  any plausible CSV.
- The sandbox tmpdir is currently cleaned up at the end of the run; need
  to make the caller pull files out *before* the cleanup happens, or
  return them inline as base64 in the run result.

**Effort.** One full day. Most of it is the protocol decision for how the
sandbox surfaces files (inline base64 in the result blob vs. handle to a
caller-owned tmpdir).

---

## 3. Chart PNGs from the analyze sandbox

**Problem.** Bar charts and trends communicate better than tabular text
for the analytics Pro is producing.

**Sketch.** Once #2 is done, charts ride the same plumbing:

1. Decide on charting library. We landed on: **`pandas.plot()` is fine.**
   Add `python3-matplotlib` to the [Dockerfile](../Dockerfile) (matplotlib
   is already a transitive dep of pandas via the apt package, but verify;
   may already be present).
2. Pro saves with `df.plot.bar(...); plt.savefig('chart.png', dpi=150,
   bbox_inches='tight')`.
3. Sandbox scans tmpdir for `*.png` post-run and passes them through the
   same file-attachment plumbing as CSV.
4. System-prompt nudge in `analyze.ts` SCHEMA_DOC: "When a chart would
   communicate the answer better than prose, save it as `chart.png`."

**Optional polish.**
- One line at sandbox boot: `plt.style.use('seaborn-v0_8-whitegrid')` so
  defaults don't look like a 2008 paper.
- If grouped charts ever look bad, install `python3-seaborn` (apt) and
  add a one-line note in SCHEMA_DOC.

**Files.**
- `Dockerfile` — ensure matplotlib is installed (probably one apt line)
- `src/features/eventbrite/analyze.ts` — SCHEMA_DOC nudge + chart file
  pickup
- All the file-plumbing files from #2

**Effort.** Half day on top of #2. Mostly bundle them as one work item.

---

## 4. Persist full LLM trace to `audit_log.output_json`

**Problem.** The
[`audit_log.output_json`](../src/features/admin/audit-store.ts) column
exists but is only populated by tracker / event-watcher flows. For chat,
we only persist `input_summary` (500 chars of the user message) and a
500-char `result`. Diagnosing why Pro made a weird call is impossible
after the fact.

**Sketch.** In [`handle-message.ts`](../src/features/chat/handle-message.ts), accumulate a
structured trace alongside `contents`:

```ts
const trace: Array<{
  round: number;
  role: 'model' | 'tool_result';
  toolCalls?: Array<{ name: string; args: unknown }>;
  toolResults?: Array<{ name: string; result: unknown }>;
  text?: string;
}> = [];
```

Populate inside the existing loop. At `auditChat()` time, stringify and
truncate to ~50 KB (SQLite handles much larger but we don't need pathology).

Add a small admin slash command (or extend an existing one) to fetch the
last trace for a given user / channel: `/admin trace last 5`.

**Files.**
- `src/features/chat/handle-message.ts` — build trace, pass to audit
- `src/features/admin/audit-store.ts` — already supports `output_json`,
  no schema change
- `src/commands/` — new or extended admin command to read traces

**Effort.** Half day. The harder part is the read-side UX (paginating
big traces, redacting any user PII).

**Synergy with #9.** Today, when a tool throws unhandled, no audit row
is written at all — the throw escapes `handleChatMessage` before
`auditChat()` runs. #9 (wrap `executeTool` in try/catch + flush partial
trace in the outer catch) is what makes #4 actually cover failure modes.
Without #9, `audit_log` will keep being silently empty for the most
interesting class of bugs.

---

## 5. Live LLM-turn thread in Discord

**Problem.** When Pro takes 20 seconds to answer, there's no visibility
into why — is it stuck on a slow tool? Looping? Hung?

**Sketch.** When `handleChatMessage` runs, the Discord adapter optionally
opens a thread on the user's message and posts a short summary after each
tool round:

```
🔧 round 1: query_events({ channel_id: "..." }) — 8 results
🔧 round 2: analyze_eventbrite({ question: "..." }) — 12.4s
✅ round 3: text response (1,847 chars)
```

Implementation requires a callback mechanism since `handleChatMessage` is
currently fire-and-forget. Cleanest approach:

```ts
export async function handleChatMessage(
  msg: ChatMessage,
  onRound?: (event: RoundEvent) => Promise<void>,
): Promise<ChatReply>;
```

The Discord adapter passes a callback that posts into the thread; other
callers (Teams, webhooks) pass nothing.

Gate behind a per-user or per-server flag — most users don't want a
thread on every reply. Suggest: only thread when the user has the
`bot-debug` role, or only when execution takes >5 seconds.

**Files.**
- `src/features/chat/handle-message.ts` — add `onRound` parameter
- `src/adapters/discord.ts` — open a thread, wire the callback
- New helper to format `RoundEvent` → markdown
- Possibly an opt-in flag (per-user setting or role check)

**Effort.** One day. Most of it is making the thread UX not annoying.

**Synergy with #4.** If you do #4 first, the live thread can just stream
the same trace data structurally — half the work is shared.

**Synergy with #9.** Without #9, the thread silently dies mid-turn on
any tool throw — you'd see `🔧 round 1: …` and then nothing, because
the callback for the failing round never fires. #9 turns tool throws
into normal `RoundEvent`s of kind `'error'`, so the thread can render
`🔧 round 1: read_channel_messages(…) — ❌ Missing Access` and keep
going into the recovery round.

---

## 6. Per-conversation sliding-window memory

**Problem.** Even with #1 (last N channel messages), if the conversation
goes back-and-forth quickly the LLM still treats each turn as standalone
because the new user message arrives before the previous Moomie reply has
context.

**Sketch.** Keyed on `(userId, channelId)`. After each chat exchange,
store the last 4–6 turns of structured `contents` in memory (or SQLite).
On the next chat from the same user in the same channel within 10
minutes, prepend those turns.

```ts
const key = `${msg.userId}:${msg.channelId}`;
const prior = conversationMemory.get(key, { maxAgeMs: 10 * 60_000 });
const contents = [...prior, { role: 'user', parts: [...] }];
// ...after the loop:
conversationMemory.set(key, [...prior, { role: 'user', ... }, { role: 'model', ...finalReply }].slice(-6));
```

In-memory is fine to start (process restart = memory loss = acceptable
for ~5min conversations). Move to SQLite if you want it to survive
restarts.

**Files.**
- New `src/features/chat/conversation-memory.ts` — tiny LRU keyed on
  `(user, channel)` with TTL
- `src/features/chat/handle-message.ts` — read/write the memory
- Possibly `src/prompts/chat-system.md` — note that recent turns from the
  same conversation are included

**Caveats.**
- DM and channel context can leak — a user in #general and DMing should
  be separate keys.
- Token cost grows by the size of the kept window per turn.

**Overlap with #1.** They solve different problems: #1 is about ambient
channel context, #6 is about same-user back-and-forth continuity. Do #1
first since it's strictly cheaper.

**Effort.** One day including a small in-memory LRU implementation and
careful keying.

---

## 7. Deploy blackout mitigation

**Problem.** During `npm run deploy` the container restarts; Discord
drops MESSAGE_CREATE events that arrive during the ~30-second window
because the gateway session is new on reconnect.

**Sketch — option A: pre-deploy announce.** [`deploy.ps1`](../deploy.ps1)
posts "🐄 Brief outage incoming, redeploying" to a fixed channel via the
Discord webhook before `docker compose up`. Cheap, doesn't catch dropped
messages but at least users know.

**Sketch — option B: startup catch-up.** On bot startup, query each
channel Pro is in for messages since the last `audit_log.timestamp`
that mention the bot or are DMs. Replay them through `handleChatMessage`.
Risk: double-processing if a message was handled but the audit write
failed; mitigate with a dedup table on Discord message ID.

**Sketch — option C: both.** A is trivial and reduces user surprise; B
is the real fix.

**Files.**
- A: `deploy.ps1` + a webhook URL env var
- B: `src/adapters/discord.ts` (`ready` handler) + new dedup table in
  `audit-store.ts`

**Effort.** A is half-day. B is full-day. Recommend A first; B only if
the dropped-messages problem keeps happening in practice.

---

## 8. Pronoun-aware auto-history-fetch

**Problem.** User says "tell me more about that" — Pro has no context.

**Sketch.** A regex (`/\b(those|that|it|them|the previous|the last)\b/i`)
detected in the user message triggers an auto `read_channel_messages`
before the LLM round.

**Verdict.** Mostly subsumed by #1. If you do #1, this becomes
unnecessary — channel context already includes the referent. Skip unless
#1 turns out insufficient in practice.

---

## 9. Tool-error resilience & failure visibility

**Problem.** A single unhandled throw inside a tool call kills the
entire chat turn with a generic "Something went wrong. Moo. 🐄" — no
audit row, no partial trace, no chance for Gemini to pivot to a
different tool.

**Observed example.** 2026-05-22, user asked Moomie to "check logs for
why ADA Seating free and paid got combined." Gemini interpreted "logs"
as Discord channel history and called `read_channel_messages` against
a channel the bot can't view. Discord returned
`DiscordAPIError[50001] Missing Access`, which propagated:

```
GuildMessageManager._fetchMany
  → readChannelMessages (tools.ts:276)
  → handleChatMessage   (handle-message.ts:87, awaits executeTool unguarded)
  → messageCreate catch (discord.ts:312)
```

The failure was invisible in `audit_log` (the audit row is written
*after* the loop, never reached); it only surfaced as a `Discord error`
row in the `logs` table.

**Sketch.** Five small, independent edits:

1. **Wrap `executeTool` in the chat loop.** In
   [`handle-message.ts`](../src/features/chat/handle-message.ts) around
   line 105, replace the bare `await executeTool(...)` with a
   try/catch that returns `JSON.stringify({ error: ... })` as the
   tool result. Gemini sees the failure as a normal function response
   and can pivot (e.g. fall back to `submit_feedback`).

2. **Catch DiscordAPIError inside the Discord-touching tools.**
   [`readChannelMessages`](../src/features/chat/tools.ts) and
   `listChannels` currently do `messages.fetch` / cache lookups
   without guarding. Catch `DiscordAPIError` and map 50001 / 10003 /
   50013 to descriptive error strings — Gemini learns "no access"
   vs "channel doesn't exist" instead of just "threw."

3. **Pre-check channel permissions in `read_channel_messages`.**
   Before calling `messages.fetch`, check
   `channel.permissionsFor(client.user)` for `ViewChannel` and
   `ReadMessageHistory`. Return a structured error *before* hitting
   the Discord API — same UX, cheaper, no rate-limit risk.

4. **Defensive `generateIssueTitle` in `executeFeedback`.** The LLM
   title-generation call in
   [`handle-command.ts`](../src/features/feedback/handle-command.ts)
   happens *before* `issues.create`. Wrap it and fall back to a
   deterministic title (`"Feedback from <user>: <first 60 chars>…"`)
   so a quota / network blip doesn't block issue filing.

5. **Flush a chat audit row in the outer catch.** The catch at
   [`discord.ts:312`](../src/adapters/discord.ts) only logs. Have it
   also write a `type: 'chat'`, `result: 'unhandled error: …'` row so
   `query_audit_log` becomes the single source of truth for chat
   outcomes. Trivial once #4 has the trace structure.

6. **Distinguish Gemini finish reasons.** The "no parts" branch in
   `handleChatMessage` lumps SAFETY / RECITATION / MAX_TOKENS / actual
   empty into one bucket. Surface the `finishReason` in the audit row
   (and optionally a user-facing hint).

**Files.**
- `src/features/chat/handle-message.ts` — items 1, 5, 6
- `src/features/chat/tools.ts` — items 2, 3
- `src/features/feedback/handle-command.ts` — item 4
- `src/adapters/discord.ts` — item 5

**Effort.** Half day total. Items 1, 2, 3, 4 are each ~10-line
additions. Item 5 is one DB write. Item 6 is a switch on a string.

**Synergy with #4 and #5.** #9 is the failure-mode plumbing that lets
#4 (audit trace) and #5 (live thread) actually cover the interesting
cases. Recommended order: #4 → #9 → #5, because #4 defines the
`RoundEvent` data shape, #9 emits error events into it, and #5 streams
the whole thing into a Discord thread.

**Bonus.** Once #9 ships, prompts like the original "check logs and
open a PR" still won't work in chat (no `query_logs` tool exposed
there), but they'll fail *gracefully* — Gemini retries with
`submit_feedback` after seeing the tool error, and the coding agent
picks up the investigation. The chat path no longer produces dead-end
"Something went wrong. Moo. 🐄" replies for recoverable tool errors.

---

## 10. Consolidate `moomie-bot` / `feedback` label flow

**Problem.** Today there are two parallel entry points that both end at
`runCodingTask` but capture different context:

- `/feedback <text>` (Discord/Teams slash command) — creates the issue,
  labels it `feedback`, calls `trackIssue()` to save channel/user/
  conversation refs, queues a coding task with a **rich** prompt that
  includes the MCP self-investigation tool catalog.
- `moomie-bot` label added to an existing GitHub issue — webhook handler
  queues a task with a **minimal** prompt (just `title + body`).

The `feedback` label is enforced as a hard skip in the `moomie-bot`
label handler ([`webhook-server.ts:160`](../src/webhook-server.ts#L160))
to prevent double-firing. Side effect: **re-triggering a feedback issue
requires swapping the label** (`feedback` → `moomie-bot`), which makes
the retry lose the rich MCP investigation prompt. Hit this in practice
retrying issue #30 on 2026-05-23.

**Sketch.** Drop the early-return on `feedback` in
`handleIssueLabelAdded`. When the handler sees a `moomie-bot` label on
an issue that *also* has `feedback`, look up the saved `tracked_issue`
row and rebuild the rich prompt from those stored fields (channel,
user, referenced-message). Factor the prompt construction out of
`executeFeedback` into a shared `buildFeedbackPrompt(issue, tracked)`
helper so both call sites use the same template.

**Files.**
- `src/features/feedback/handle-command.ts` — extract
  `buildFeedbackPrompt()`
- `src/webhook-server.ts` — drop the `feedback` skip; on feedback
  issues, call `getTrackedIssue()` + `buildFeedbackPrompt()` instead of
  the plain `title + body` path

**Caveat.** If the tracked-issue row was dropped (e.g. issue is old,
bot lost state), the rich prompt can't be rebuilt; fall back to the
minimal prompt with a logged warning.

**Effort.** Half day. Mostly refactoring; no new data flow.

---

## 11. Coding agent's SIGTERM doesn't actually stop gemini-cli

**Problem.** When the idle/max watchdog fires in
[`gemini-cli.ts`](../src/features/coding/agents/gemini-cli.ts), it calls
`child.kill('SIGTERM')` then `SIGKILL` after 5s. Observed on
2026-05-22 #30 timeout: the session jsonl at
`/home/node/.gemini/tmp/<hash>/chats/session-*.jsonl` **kept growing
for 7+ minutes after the kill** — gemini-cli ignored / outlived the
signal. The bot's promise was already rejected, the job marked failed,
but the subprocess (and its API spend) ran on.

Secondary problem: when a job fails, we notify the original reporter
via `notifyUser` but we **don't comment on the GitHub issue itself**.
Someone looking at issue #30 in the GitHub UI sees no record of the
attempt, the partial edits sitting in `/app/workspace/<repo>/`, or
why it failed.

**Sketch.**

1. **Kill the process group, not just the child.** Spawn with
   `detached: true` and call `process.kill(-child.pid, 'SIGTERM')` to
   signal the whole process group. gemini-cli likely fork-exec's the
   model client and the parent's signal isn't propagated.
2. **Track and reap orphans.** On bot startup and on each job
   completion, scan for `gemini` / `node bundle/gemini.js` processes
   under the container and kill any that don't belong to an active
   job. Cheap belt-and-suspenders.
3. **Post a failure comment on the issue.** In `runCodingTask`'s
   failure path (whether timeout, exit code, or unhandled throw),
   `octokit.issues.createComment()` with the error class, last
   ~500 chars of stderr, and a hint about checking
   `/app/workspace/<repo>/` for salvageable edits.
4. **Surface uncommitted edits.** When a job fails after the agent
   wrote files, `git diff` the workspace and attach the patch to the
   issue comment (truncated to a sensible size). Lets you cherry-pick
   what the agent got right before the hang.
5. **Idempotency guard on retry.** If a `moomie-bot` label is re-added
   while a previous job for the same `issueNumber + repo` is still
   alive (subprocess still in `ps`, or job not in terminal state),
   refuse the new trigger with a comment ("previous attempt still
   running, kill it first with X").

**Files.**
- `src/features/coding/agents/gemini-cli.ts` — items 1, 2
- `src/features/coding/job-runner.ts` — items 3, 4, 5
- `src/features/coding/github-client.ts` — wrapper for the issue
  comment helper if one doesn't already exist

**Effort.** Half day for items 1 + 3 (the highest-value pair). Add 4
and 5 as polish if the hang recurs.

**Synergy with #10.** Idempotency guard (#11.5) is much easier to
implement after #10 unifies the label/feedback flow into a single
handler with a single "is this issue already being worked on?" check.

---

## Recommended bundling for tomorrow

Two coherent half-to-full-day units:

**Bundle A — "Context awareness" (#1 + maybe #6)**
The revised #1 (scoped retrieval via thread / reply-chain / bot-involvement
filter) covers most cases without polluting context. #6 (sliding-window
memory) is still useful for DMs and rapid back-and-forth, but lower
priority once #1 lands. Net effect: Pro stops needing
`read_channel_messages` for most context questions, and conversations
feel coherent without contaminating prompts in busy channels.

**Bundle B — "Better outputs" (#2 + #3)**
Same plumbing. CSV export is the harder protocol decision; chart PNGs
ride on top for almost free. Net effect: Pro can deliver analytics as
files attached to its replies, not as 4000-char dumps of code-block CSV.

**Bundle C — "Observability" (#4 + #9, optionally #5)**
#4 defines the trace shape, #9 emits error events into it (and stops
one bad tool from killing the whole turn), #5 streams the result into
a Discord thread. Doing #4 + #9 alone is already a big resilience
win without needing the thread UX work. Net effect: failures become
visible in `audit_log` instead of disappearing into a generic
"Something went wrong. Moo. 🐄" reply.

If picking one and only one for tomorrow: **Bundle B**. The analytics
work that just shipped is half-presented if every answer has to fit in a
Discord message body. But **#9 on its own is a strong half-day**
standalone pick if the current failure mode is biting in practice — it
doesn't depend on anything else and immediately fixes the
"unhandled-throw kills the turn" class of bug.

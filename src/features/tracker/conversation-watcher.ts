import type { Client, Message, TextChannel } from 'discord.js';
import { ChannelType, MessageFlags } from 'discord.js';
import { loadPrompt } from '../../prompts/load-prompt.js';
import { ARCHIVED_CATEGORY_ID, MODEL_EXTRACT, MODEL_DEDUP, geminiUrl } from '../../config.js';
import { logAudit } from '../admin/audit-store.js';
import {
  getActiveEvents,
  getOpenItemsForEvent,
  getEventByChannelId,
  getAllOpenItems,
  createItem,
  markItemDone,
  updateItemDescription,
  type TrackerEvent,
  type TrackerItem,
} from './store.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const QUIET_GAP_MS = 2 * 60 * 60 * 1000;          // 2 hours of silence triggers extraction
const MIN_MESSAGES = 1;                        // Process any non-empty burst
const MAX_BUFFER = 50;                         // Oldest messages roll off past this
const RATE_LIMIT_MS = 60 * 60 * 1000;         // Max 1 extraction per channel per hour
const CONFIRMATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours to respond

// ─── In-Memory Buffers ──────────────────────────────────────────────────────

interface BufferedMessage {
  authorName: string;
  authorId: string;
  content: string;
  timestamp: Date;
  replyTo: string | null; // display name of the author being replied to
}

interface ChannelBuffer {
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  lastExtraction: number; // timestamp of last extraction
}

const buffers = new Map<string, ChannelBuffer>();

// Track pending extractions awaiting confirmation
interface PendingExtraction {
  messageId: string;
  channelId: string;
  items: ExtractedItem[];
  completions: ExtractedCompletion[];
  matchedCompletions: { completion: ExtractedCompletion; item: TrackerItem }[];
  timer: ReturnType<typeof setTimeout>;
}

const pendingExtractions = new Map<string, PendingExtraction>(); // keyed by bot message ID

let discordClient: Client;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExtractedItem {
  description: string;
  owner: string | null;
  owner_id: string | null;
  event: string | null;
  deadline: string | null;
  confidence: 'confident' | 'needs_clarification';
  question: string | null;
}

interface ExtractedCompletion {
  description: string;
  item_id: number | null;
  owner: string | null;
  evidence: string;
}

interface ExtractedNudge {
  type: 'decision_needed' | 'needs_owner' | 'stalled_question' | 'rehashed_topic' | 'deadline_approaching';
  message: string;
  mentions: string[];
  event: string | null;
}

interface ExtractionResult {
  items: ExtractedItem[];
  completions: ExtractedCompletion[];
  nudges: ExtractedNudge[];
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function registerConversationWatcher(client: Client): void {
  discordClient = client;

  client.on('messageCreate', (message) => {
    if (!shouldBuffer(message)) return;
    bufferMessage(message);
  });

  // Handle reactions on extraction messages
  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    // Fetch partial reactions
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }

    const pending = pendingExtractions.get(reaction.message.id);
    if (!pending) return;

    const emoji = reaction.emoji.name;
    if (emoji === '✅') {
      await confirmExtraction(pending, client);
    } else if (emoji === '❌') {
      await dismissExtraction(pending, client);
    }
  });

  // Handle replies to extraction messages
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.reference?.messageId) return;

    const pending = pendingExtractions.get(message.reference.messageId);
    if (!pending) return;

    await handleReply(pending, message, client);
  });

  console.log('[Tracker] Conversation watcher registered');
}

// ─── Message Buffering ──────────────────────────────────────────────────────

function shouldBuffer(message: Message): boolean {
  if (message.author.bot) return false;
  if (!message.guild) return false;
  if (message.channel.type !== ChannelType.GuildText) return false;

  // Skip archived category
  const parent = (message.channel as TextChannel).parentId;
  if (parent && parent === ARCHIVED_CATEGORY_ID) return false;

  return true;
}

function bufferMessage(message: Message): void {
  const channelId = message.channelId;

  if (!buffers.has(channelId)) {
    buffers.set(channelId, { messages: [], timer: null, lastExtraction: 0 });
  }

  const buf = buffers.get(channelId)!;

  // Resolve reply target name if this message is a reply
  let replyTo: string | null = null;
  if (message.reference?.messageId) {
    const ref = message.mentions.repliedUser;
    if (ref) {
      const member = message.guild?.members.cache.get(ref.id);
      replyTo = member?.displayName ?? ref.username;
    }
  }

  buf.messages.push({
    authorName: message.member?.displayName ?? message.author.username,
    authorId: message.author.id,
    content: message.content,
    timestamp: message.createdAt,
    replyTo,
  });

  // Roll off oldest messages
  if (buf.messages.length > MAX_BUFFER) {
    buf.messages = buf.messages.slice(-MAX_BUFFER);
  }

  // Reset the quiet timer
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => onQuiet(channelId), QUIET_GAP_MS);
}

// ─── Quiet Trigger ──────────────────────────────────────────────────────────

async function onQuiet(channelId: string): Promise<void> {
  const buf = buffers.get(channelId);
  if (!buf) return;

  // Clear buffer regardless — we'll process or skip
  const messages = buf.messages;
  buf.messages = [];
  buf.timer = null;

  // Not enough messages
  if (messages.length < MIN_MESSAGES) return;

  // Rate limit
  if (Date.now() - buf.lastExtraction < RATE_LIMIT_MS) return;

  buf.lastExtraction = Date.now();

  try {
    await processConversation(channelId, messages);
  } catch (err) {
    console.error(`[Tracker] Extraction failed for channel ${channelId}:`, err);
  }
}

/** Midnight–8am Seattle time → send messages silently (no notifications). */
function isDuringQuietHours(): boolean {
  const seattle = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const hour = seattle.getHours();
  return hour >= 0 && hour < 8;
}

function sendFlags(): number | undefined {
  return isDuringQuietHours() ? MessageFlags.SuppressNotifications : undefined;
}

// ─── Extraction Pipeline ────────────────────────────────────────────────────

async function processConversation(channelId: string, messages: BufferedMessage[]): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  // Build context
  const events = getActiveEvents();
  const eventsContext = buildEventsContext(events);
  const openItemsContext = buildOpenItemsContext(events);

  // Build transcript
  const transcript = messages.map((m) => {
    const replyTag = m.replyTo ? ` [reply to ${m.replyTo}]` : '';
    return `[${m.timestamp.toISOString()}] ${m.authorName}${replyTag}: ${m.content}`;
  }).join('\n');

  // Resolve channel name for audit context
  const cachedChannel = discordClient.channels.cache.get(channelId) as TextChannel | undefined;
  const channelName = cachedChannel?.name;

  // Call Gemini
  const result = await callGemini(apiKey, transcript, eventsContext, openItemsContext, channelId, channelName);
  if (!result) return;

  // Nothing actionable at all
  if (result.items.length === 0 && result.completions.length === 0 && (!result.nudges || result.nudges.length === 0)) return;

  // Resolve owner IDs from display names in messages
  const nameToId = new Map<string, string>();
  for (const m of messages) {
    nameToId.set(m.authorName.toLowerCase(), m.authorId);
  }
  for (const item of result.items) {
    if (item.owner) {
      item.owner_id = nameToId.get(item.owner.toLowerCase()) ?? null;
    }
  }

  // Match completions to existing tracked items
  const matchedCompletions: { completion: ExtractedCompletion; item: TrackerItem }[] = [];
  for (const completion of result.completions) {
    const match = findCompletionMatch(completion, events);
    if (match) {
      matchedCompletions.push({ completion, item: match });
    }
  }

  const channel = await discordClient.channels.fetch(channelId) as TextChannel | null;
  if (!channel) return;

  const nudges = result.nudges ?? [];
  const hasTrackableContent = result.items.length > 0 || matchedCompletions.length > 0;

  // If we only have nudges (no items/completions), just post the nudge — no reactions needed
  if (!hasTrackableContent && nudges.length > 0) {
    const nudgeMessage = formatNudges(nudges, nameToId);
    if (nudgeMessage) {
      try { await channel.send({ content: nudgeMessage, flags: sendFlags() }); } catch { /* best effort */ }
    }

    // Create unassigned tracked items for needs_owner nudges so they appear on the board
    for (const nudge of nudges) {
      if (nudge.type === 'needs_owner') {
        const event = resolveEvent(nudge.event, events);
        createItem({
          event_id: event?.id ?? null,
          description: nudge.message,
          source: 'nudge',
          source_channel: channelId,
          source_date: new Date().toISOString().slice(0, 10),
        });
      }
    }
    return;
  }

  // Build the full extraction message (items + completions + nudges)
  const extractionMessage = formatExtraction(result.items, matchedCompletions, nudges, nameToId);
  if (!extractionMessage) return;

  try {
    const sent = await channel.send({ content: extractionMessage, flags: sendFlags() });
    await sent.react('✅');
    await sent.react('❌');

    // Set up timeout for auto-resolution
    const timer = setTimeout(() => autoResolve(sent.id), CONFIRMATION_TIMEOUT_MS);

    pendingExtractions.set(sent.id, {
      messageId: sent.id,
      channelId,
      items: result.items,
      completions: result.completions,
      matchedCompletions,
      timer,
    });
  } catch (err) {
    console.error(`[Tracker] Failed to post extraction in ${channelId}:`, err);
  }
}

function buildEventsContext(events: TrackerEvent[]): string {
  if (events.length === 0) return 'No upcoming events currently tracked.';
  return 'Known upcoming events:\n' + events.map((e) => {
    const dateStr = new Date(e.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `- ${e.name} — ${dateStr}${e.channel_name ? ` (channel: #${e.channel_name})` : ''}`;
  }).join('\n');
}

function buildOpenItemsContext(events: TrackerEvent[]): string {
  const sections: string[] = [];

  // Include org-wide items (no event association)
  const orgItems = getAllOpenItems().filter(i => !i.event_id);
  if (orgItems.length > 0) {
    sections.push('Org-wide open items:\n' + orgItems.map((i) =>
      `- [#${i.id}] ${i.description}${i.owner_name ? ` (owner: ${i.owner_name})` : ''}`
    ).join('\n'));
  }

  for (const event of events) {
    const items = getOpenItemsForEvent(event.id);
    if (items.length === 0) continue;
    sections.push(`Open items for ${event.name}:\n` + items.map((i) =>
      `- [#${i.id}] ${i.description}${i.owner_name ? ` (owner: ${i.owner_name})` : ''}`
    ).join('\n'));
  }
  return sections.length > 0 ? sections.join('\n\n') : 'No open items currently tracked.';
}

async function callGemini(
  apiKey: string,
  transcript: string,
  eventsContext: string,
  openItemsContext: string,
  channelId: string,
  channelName?: string,
): Promise<ExtractionResult | null> {
  const systemPrompt = loadPrompt('burst-extraction.md', {
    EVENTS_CONTEXT: eventsContext,
    OPEN_ITEMS_CONTEXT: openItemsContext,
  });

  // Truncate transcript for audit log (keep first 500 chars)
  const inputSummary = transcript.length > 500
    ? transcript.slice(0, 500) + `... (${transcript.length} chars total)`
    : transcript;

  try {
    const res = await fetch(`${geminiUrl(MODEL_EXTRACT)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: transcript }] }],
        generationConfig: {
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[Tracker] Gemini API error ${res.status}:`, body);
      logAudit({ type: 'extraction', channel_id: channelId, channel_name: channelName, model: MODEL_EXTRACT, input_summary: inputSummary, result: `API error ${res.status}` });
      return null;
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return null;

    const parsed = JSON.parse(text) as ExtractionResult;

    // Audit log the extraction
    const itemCount = parsed.items?.length ?? 0;
    const completionCount = parsed.completions?.length ?? 0;
    const nudgeCount = parsed.nudges?.length ?? 0;
    logAudit({
      type: 'extraction',
      channel_id: channelId,
      channel_name: channelName,
      model: MODEL_EXTRACT,
      input_summary: inputSummary,
      output_json: text,
      result: `${itemCount} items, ${completionCount} completions, ${nudgeCount} nudges`,
      tokens_in: data.usageMetadata?.promptTokenCount,
      tokens_out: data.usageMetadata?.candidatesTokenCount,
    });

    return parsed;
  } catch (err) {
    console.error('[Tracker] Gemini extraction call failed:', err);
    return null;
  }
}

// ─── Insert-Time Dedup ──────────────────────────────────────────────────────

interface DedupResult {
  new_index: number;
  verdict: 'new' | 'duplicate' | 'update';
  existing_id: number | null;
  merged_description: string | null;
}

/**
 * Check a batch of extracted items against existing open items via LLM.
 * Returns verdict per item: new (insert), duplicate (skip), or update (merge).
 */
async function dedupItems(
  newItems: ExtractedItem[],
): Promise<DedupResult[]> {
  if (newItems.length === 0) return [];

  const existingItems = getAllOpenItems();
  if (existingItems.length === 0) {
    // Nothing to dedup against — all are new
    return newItems.map((_, i) => ({ new_index: i, verdict: 'new' as const, existing_id: null, merged_description: null }));
  }

  const existingText = existingItems.map((i) =>
    `[#${i.id}] ${i.description}${i.owner_name ? ` (owner: ${i.owner_name})` : ''}${i.event_id ? ` (event_id: ${i.event_id})` : ''}`
  ).join('\n');

  const newText = newItems.map((item, idx) =>
    `[${idx}] ${item.description}${item.owner ? ` (owner: ${item.owner})` : ''}${item.event ? ` (event: ${item.event})` : ''}`
  ).join('\n');

  const systemPrompt = loadPrompt('dedup-check.md', {
    EXISTING_ITEMS: existingText,
    NEW_ITEMS: newText,
  }, true); // skip persona for utility call

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[Tracker] No GEMINI_API_KEY — skipping dedup, treating all as new');
    return newItems.map((_, i) => ({ new_index: i, verdict: 'new' as const, existing_id: null, merged_description: null }));
  }

  try {
    const res = await fetch(`${geminiUrl(MODEL_DEDUP)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: 'Check these items for duplicates.' }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });

    if (!res.ok) {
      console.error(`[Tracker] Dedup API error ${res.status}`);
      return newItems.map((_, i) => ({ new_index: i, verdict: 'new' as const, existing_id: null, merged_description: null }));
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) {
      return newItems.map((_, i) => ({ new_index: i, verdict: 'new' as const, existing_id: null, merged_description: null }));
    }

    const parsed = JSON.parse(text) as { results: DedupResult[] };

    // Audit log the dedup call
    const dupes = parsed.results.filter(r => r.verdict === 'duplicate').length;
    const updates = parsed.results.filter(r => r.verdict === 'update').length;
    logAudit({
      type: 'dedup',
      model: MODEL_DEDUP,
      input_summary: `${newItems.length} new vs ${existingItems.length} existing`,
      output_json: text,
      result: `${dupes} dupes, ${updates} updates, ${parsed.results.length - dupes - updates} new`,
      tokens_in: data.usageMetadata?.promptTokenCount,
      tokens_out: data.usageMetadata?.candidatesTokenCount,
    });

    return parsed.results;
  } catch (err) {
    console.error('[Tracker] Dedup call failed:', err);
    return newItems.map((_, i) => ({ new_index: i, verdict: 'new' as const, existing_id: null, merged_description: null }));
  }
}

/**
 * Save items with dedup — skips duplicates, merges updates, inserts new.
 */
async function saveItemsWithDedup(
  items: ExtractedItem[],
  events: TrackerEvent[],
  channelId: string,
): Promise<{ inserted: number; skipped: number; updated: number }> {
  const results = await dedupItems(items);
  let inserted = 0, skipped = 0, updated = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const result = results.find((r) => r.new_index === i);
    const verdict = result?.verdict ?? 'new';

    if (verdict === 'duplicate') {
      skipped++;
      continue;
    }

    if (verdict === 'update' && result?.existing_id && result.merged_description) {
      updateItemDescription(result.existing_id, result.merged_description);
      updated++;
      continue;
    }

    // verdict === 'new' or fallback
    const event = resolveEvent(item.event, events);
    createItem({
      event_id: event?.id ?? null,
      description: item.description,
      owner_id: item.owner_id ?? undefined,
      owner_name: item.owner ?? undefined,
      target_date: item.deadline ?? undefined,
      source: 'extracted',
      source_channel: channelId,
      source_date: new Date().toISOString().slice(0, 10),
    });
    inserted++;
  }

  return { inserted, skipped, updated };
}

// ─── Item Matching ──────────────────────────────────────────────────────────

function findCompletionMatch(
  completion: ExtractedCompletion,
  events: TrackerEvent[],
): TrackerItem | null {
  // If Gemini returned a tracker item ID, use it directly
  if (completion.item_id) {
    for (const event of events) {
      const items = getOpenItemsForEvent(event.id);
      const direct = items.find((i) => i.id === completion.item_id);
      if (direct) return direct;
    }
  }

  // Fallback: keyword matching
  const completionWords = new Set(
    completion.description.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
  );

  let bestMatch: TrackerItem | null = null;
  let bestScore = 0;

  for (const event of events) {
    const items = getOpenItemsForEvent(event.id);
    for (const item of items) {
      const itemWords = item.description.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const overlap = itemWords.filter((w) => completionWords.has(w)).length;
      const score = itemWords.length > 0 ? overlap / itemWords.length : 0;

      const ownerMatch = completion.owner && item.owner_name &&
        completion.owner.toLowerCase() === item.owner_name.toLowerCase();

      const finalScore = score + (ownerMatch ? 0.3 : 0);

      if (finalScore > bestScore && finalScore >= 0.4) {
        bestScore = finalScore;
        bestMatch = item;
      }
    }
  }

  return bestMatch;
}

// ─── Message Formatting ─────────────────────────────────────────────────────

function formatExtraction(
  items: ExtractedItem[],
  matchedCompletions: { completion: ExtractedCompletion; item: TrackerItem }[],
  nudges: ExtractedNudge[],
  nameToId: Map<string, string>,
): string | null {
  const parts: string[] = [];

  if (items.length > 0) {
    parts.push('📋 I noticed some action items from this conversation:\n');
    items.forEach((item, i) => {
      const owner = item.owner ? `@${item.owner}` : 'unassigned';
      const event = item.event ? ` → ${item.event}` : '';
      const marker = item.confidence === 'confident' ? '✓' : '?';
      parts.push(`${i + 1}. ${item.description} (${owner}${event}) ${marker}`);
    });

    const questions = items
      .filter((item) => item.confidence === 'needs_clarification' && item.question)
      .map((_item) => `• #${items.indexOf(_item) + 1}: ${_item.question}`);

    if (questions.length > 0) {
      parts.push('\nQuestions:');
      parts.push(...questions);
    }
  }

  if (matchedCompletions.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('✅ These tracked items look completed:\n');
    matchedCompletions.forEach(({ completion, item }) => {
      parts.push(`• "${item.description}" — ${completion.evidence}`);
    });
  }

  if (nudges.length > 0) {
    if (parts.length > 0) parts.push('');
    for (const nudge of nudges) {
      const mentions = resolveMentions(nudge.mentions, nameToId);
      parts.push(`💬 ${nudge.message}${mentions}`);
    }
  }

  if (parts.length === 0) return null;

  if (items.length > 0 || matchedCompletions.length > 0) {
    parts.push('\nReact ✅ to confirm all, ❌ to dismiss, or reply to correct.');
  }
  return parts.join('\n');
}

function formatNudges(nudges: ExtractedNudge[], nameToId: Map<string, string>): string | null {
  if (nudges.length === 0) return null;

  const parts: string[] = [];
  for (const nudge of nudges) {
    const mentions = resolveMentions(nudge.mentions, nameToId);
    parts.push(`💬 ${nudge.message}${mentions}`);
  }
  return parts.join('\n');
}

function resolveMentions(names: string[] | null | undefined, nameToId: Map<string, string>): string {
  if (!names || names.length === 0) return '';
  const resolved = names
    .filter(Boolean)
    .map((name) => {
      const id = nameToId.get(name.toLowerCase());
      return id ? `<@${id}>` : `@${name}`;
    });
  return resolved.length > 0 ? ' ' + resolved.join(' ') : '';
}

// ─── Confirmation Handling ──────────────────────────────────────────────────

function resolveEvent(eventName: string | null, events: TrackerEvent[]): TrackerEvent | null {
  if (!eventName) return null;
  const lower = eventName.toLowerCase();
  return events.find((e) => e.name.toLowerCase().includes(lower)) ?? null;
}

async function confirmExtraction(pending: PendingExtraction, _client: Client): Promise<void> {
  clearTimeout(pending.timer);
  const events = getActiveEvents();

  // Save items with dedup check
  const { inserted, skipped, updated } = await saveItemsWithDedup(pending.items, events, pending.channelId);

  // Mark completions as done
  for (const { item } of pending.matchedCompletions) {
    markItemDone(item.id);
  }

  // Edit the message to show confirmed
  try {
    const channel = await _client.channels.fetch(pending.channelId) as TextChannel | null;
    if (channel) {
      const msg = await channel.messages.fetch(pending.messageId);
      let note = '\n\n*✅ Confirmed and tracked.';
      if (skipped > 0 || updated > 0) {
        note += ` (${inserted} new, ${skipped} dupes skipped, ${updated} updated)`;
      }
      note += '*';
      await msg.edit(msg.content + note);
    }
  } catch { /* best effort */ }

  pendingExtractions.delete(pending.messageId);
  console.log(`[Tracker] Extraction confirmed: ${inserted} inserted, ${skipped} skipped, ${updated} updated, ${pending.matchedCompletions.length} completions`);
}

async function dismissExtraction(pending: PendingExtraction, _client: Client): Promise<void> {
  clearTimeout(pending.timer);

  try {
    const channel = await _client.channels.fetch(pending.channelId) as TextChannel | null;
    if (channel) {
      const msg = await channel.messages.fetch(pending.messageId);
      await msg.edit(msg.content + '\n\n*❌ Dismissed.*');
    }
  } catch { /* best effort */ }

  pendingExtractions.delete(pending.messageId);
  console.log(`[Tracker] Extraction dismissed`);
}

async function handleReply(pending: PendingExtraction, reply: Message, _client: Client): Promise<void> {
  // For now, treat any reply as acknowledgment — user can correct inline
  // Future: parse corrections like "1 is for fall concert", "2 yes that's me"
  const content = reply.content.toLowerCase().trim();

  if (content === 'dismiss' || content === 'cancel' || content === 'no') {
    await dismissExtraction(pending, _client);
    return;
  }

  // Otherwise treat as confirmation
  await confirmExtraction(pending, _client);
}

async function autoResolve(messageId: string): Promise<void> {
  const pending = pendingExtractions.get(messageId);
  if (!pending) return;

  const events = getActiveEvents();

  // Auto-track only confident items, with dedup
  const confidentItems = pending.items.filter((i) => i.confidence === 'confident');
  const { inserted, skipped, updated } = await saveItemsWithDedup(confidentItems, events, pending.channelId);

  // Auto-mark confident completions
  for (const { item } of pending.matchedCompletions) {
    markItemDone(item.id);
  }

  // Edit message
  try {
    const channel = await discordClient.channels.fetch(pending.channelId) as TextChannel | null;
    if (channel) {
      const msg = await channel.messages.fetch(pending.messageId);
      const ambiguousCount = pending.items.filter((i) => i.confidence === 'needs_clarification').length;
      let note = `\n\n*Auto-tracked ${inserted} confident item(s) after 24h.`;
      if (skipped > 0) note += ` ${skipped} dupe(s) skipped.`;
      if (updated > 0) note += ` ${updated} updated.`;
      if (ambiguousCount > 0) note += ` ${ambiguousCount} ambiguous item(s) dropped.`;
      note += '*';
      await msg.edit(msg.content + note);
    }
  } catch { /* best effort */ }

  pendingExtractions.delete(messageId);
  console.log(`[Tracker] Auto-resolved: ${inserted} inserted, ${skipped} skipped, ${updated} updated, ${confidentItems.length - inserted - skipped - updated} dropped`);
}

import type { CommandContext } from '../../types.js';
import { loadPrompt } from '../../prompts/load-prompt.js';
import { MODEL_CHAT, geminiUrl } from '../../config.js';
import { getActiveEvents, getItemsForEvent, getAllOpenItems, getOrphanItems, type TrackerEvent, type TrackerItem } from './store.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Board');

export const name = 'board';
export const description = 'Event-centric status board';

export async function execute(ctx: CommandContext, args: string): Promise<void> {
  const events = getActiveEvents();
  if (events.length === 0) {
    await ctx.reply('No upcoming events tracked yet. Events are auto-detected from Performances channels.');
    return;
  }

  // If an event ID was passed (from autocomplete), show detail for that event
  const eventId = parseInt(args, 10);
  if (!isNaN(eventId)) {
    // Special case: 0 = org-wide items
    if (eventId === 0) {
      await sendChunked(ctx, formatOrgBoard(), { defer: false });
      return;
    }
    const event = events.find((e) => e.id === eventId);
    if (!event) {
      await ctx.reply('Event not found.');
      return;
    }
    await sendChunked(ctx, formatEventBoard(event), { defer: false });
    return;
  }

  // No event specified — show consolidated overview via LLM
  await ctx.deferReply();

  const consolidated = await getConsolidatedBoard(events);
  const text = consolidated ?? formatFallbackOverview(events);
  await sendChunked(ctx, text, { defer: true });
}

// ─── Chunking ──────────────────────────────────────────────────────────────

/**
 * Discord caps a single message at 2000 chars. Split on blank-line section
 * boundaries when possible, falling back to line boundaries; never break in
 * the middle of a line. Sends the first chunk via reply/editReply and any
 * remaining chunks via followUp.
 */
async function sendChunked(ctx: CommandContext, text: string, opts: { defer: boolean }): Promise<void> {
  const MAX = 1900; // leave headroom under Discord's 2000-char limit
  const chunks = chunkText(text, MAX);
  const first = chunks[0] ?? '(empty)';

  if (opts.defer) {
    await ctx.editReply(first);
  } else {
    await ctx.reply(first);
  }
  for (let i = 1; i < chunks.length; i++) {
    await ctx.followUp(chunks[i]);
  }
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  // Prefer splitting on blank-line section boundaries
  const sections = text.split(/\n\n+/);
  let current = '';
  const flush = () => {
    if (current.length > 0) { chunks.push(current); current = ''; }
  };
  for (const section of sections) {
    const candidate = current ? `${current}\n\n${section}` : section;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    flush();
    if (section.length <= max) {
      current = section;
    } else {
      // Section itself exceeds max — split by lines, then hard-wrap if a line is still too long
      for (const line of section.split('\n')) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length <= max) { current = next; continue; }
        flush();
        if (line.length <= max) { current = line; continue; }
        // Pathologically long single line — hard split
        for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      }
    }
  }
  flush();
  return chunks;
}

// ─── LLM Consolidation ─────────────────────────────────────────────────────

interface ConsolidatedItem {
  source_ids: number[];
  description: string;
  owner: string | null;
  target_date: string | null;
  urgency: 'overdue' | 'upcoming' | 'normal' | 'stale';
}

interface ConsolidatedSection {
  title: string;
  event_id: number | null;
  items: ConsolidatedItem[];
}

async function getConsolidatedBoard(events: TrackerEvent[]): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const allItems = getAllOpenItems();
  const orphans = getOrphanItems();
  const allOpenItems = [...allItems, ...orphans.filter((o) => !allItems.some((a) => a.id === o.id))];

  if (allOpenItems.length === 0) return null;
  // If few enough items, skip LLM — no need to consolidate 5 items
  if (allOpenItems.length <= 8) return null;

  const rawItemsText = allOpenItems.map((i) => {
    const eventName = i.event_id ? events.find((e) => e.id === i.event_id)?.name ?? `event_id:${i.event_id}` : 'org-wide';
    return `[#${i.id}] ${i.description} | owner: ${i.owner_name ?? 'unassigned'} | event: ${eventName} | target: ${i.target_date ?? 'none'} | status: ${i.status}`;
  }).join('\n');

  const eventsContext = events.map((e) => {
    const dateStr = e.date
      ? new Date(e.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'date TBD';
    return `- ${e.name} (id: ${e.id}) — ${dateStr}`;
  }).join('\n');

  const systemPrompt = loadPrompt('board-consolidation.md', {
    RAW_ITEMS: rawItemsText,
    EVENTS_CONTEXT: eventsContext,
  }, true);

  try {
    const res = await fetch(`${geminiUrl(MODEL_CHAT)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: 'Generate the consolidated board.' }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });

    if (!res.ok) {
      log.error(`Consolidation API error ${res.status}`);
      return null;
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return null;

    const parsed = JSON.parse(text) as { sections: ConsolidatedSection[] };
    return formatConsolidatedBoard(parsed.sections, events);
  } catch (err) {
    log.error('Consolidation failed:', err);
    return null;
  }
}

function formatConsolidatedBoard(sections: ConsolidatedSection[], events: TrackerEvent[]): string {
  const lines: string[] = ['📋 **MOO Action Board**\n'];

  for (const section of sections) {
    const event = section.event_id ? events.find((e) => e.id === section.event_id) : null;
    const tMinus = event?.date ? ` — ${formatTMinus(event.date)}` : '';
    lines.push(`**${section.title}**${tMinus}`);

    for (const item of section.items) {
      const icon = item.urgency === 'overdue' ? '🔴'
        : item.urgency === 'stale' ? '⏸️'
        : item.urgency === 'upcoming' ? '🟡'
        : '⬜';
      const owner = item.owner ? ` — ${item.owner}` : '';
      const target = item.target_date ? ` (${formatDate(item.target_date)})` : '';
      lines.push(`${icon} ${item.description}${owner}${target}`);
    }
    lines.push('');
  }

  lines.push('*Use `/board event:<name>` for raw details. `/done <id>` to complete.*');
  return lines.join('\n');
}

function formatFallbackOverview(events: TrackerEvent[]): string {
  const lines: string[] = [];

  for (const event of events) {
    const items = getItemsForEvent(event.id);
    const open = items.filter((i) => i.status === 'open').length;
    const done = items.filter((i) => i.status === 'done').length;
    const overdue = items.filter((i) => i.status === 'open' && isOverdue(i)).length;

    const dateStr = event.date ? formatDate(event.date) : 'TBD';
    const tMinus = event.date ? formatTMinus(event.date) : 'date TBD';
    const overdueStr = overdue > 0 ? ` ⚠️ ${overdue} overdue` : '';

    lines.push(`🎵 **${event.name}** (${dateStr}, ${tMinus}) — ${done} done, ${open} open${overdueStr}`);
  }

  const orphans = getOrphanItems();
  if (orphans.length > 0) {
    lines.push(`\n🔧 **Org-wide** — ${orphans.length} open`);
  }

  lines.push('\n*Use `/board event:<name>` for details on a specific event.*');
  return lines.join('\n');
}

function formatOrgBoard(): string {
  const items = getOrphanItems();
  const lines: string[] = ['## 🔧 Org-wide Items\n'];

  if (items.length === 0) {
    lines.push('No org-wide items tracked.');
    return lines.join('\n');
  }

  const open = items.filter((i) => i.status === 'open');
  const stale = items.filter((i) => i.status === 'stale');

  if (stale.length > 0) {
    lines.push('**🔕 Stale:**');
    for (const item of stale) lines.push(formatItem(item, '⏸️'));
    lines.push('');
  }

  if (open.length > 0) {
    lines.push('**⏳ Open:**');
    for (const item of open) lines.push(formatItem(item, '⬜'));
  }

  return lines.join('\n');
}

function formatEventBoard(event: TrackerEvent): string {
  const items = getItemsForEvent(event.id);
  const dateStr = event.date ? formatDate(event.date) : 'TBD';
  const tMinus = event.date ? formatTMinus(event.date) : 'date TBD';

  const lines: string[] = [`## 🎵 ${event.name} (${dateStr}) — ${tMinus}\n`];

  if (items.length === 0) {
    lines.push('No items tracked yet.');
    return lines.join('\n');
  }

  // Group by status
  const done = items.filter((i) => i.status === 'done');
  const open = items.filter((i) => i.status === 'open');
  const stale = items.filter((i) => i.status === 'stale');

  // Show overdue items first
  const overdue = open.filter((i) => isOverdue(i));
  const onTrack = open.filter((i) => !isOverdue(i));

  if (overdue.length > 0) {
    lines.push('**⚠️ Overdue:**');
    for (const item of overdue) {
      lines.push(formatItem(item, '🔴'));
    }
    lines.push('');
  }

  if (stale.length > 0) {
    lines.push('**🔕 Stale (no activity 14+ days):**');
    for (const item of stale) {
      lines.push(formatItem(item, '⏸️'));
    }
    lines.push('');
  }

  if (onTrack.length > 0) {
    lines.push('**⏳ Open:**');
    for (const item of onTrack) {
      lines.push(formatItem(item, '⬜'));
    }
    lines.push('');
  }

  if (done.length > 0) {
    lines.push(`**✅ Done (${done.length}):**`);
    // Only show last few completed to avoid clutter
    const recent = done.slice(-5);
    for (const item of recent) {
      lines.push(formatItem(item, '✅'));
    }
    if (done.length > 5) {
      lines.push(`  ...and ${done.length - 5} more`);
    }
  }

  return lines.join('\n');
}

function formatItem(item: TrackerItem, icon: string): string {
  const owner = item.owner_name ? ` — ${item.owner_name}` : ' — *unowned*';
  const target = item.target_date ? ` (target: ${formatDate(item.target_date)})` : '';
  return `${icon} ${item.description}${owner}${target}`;
}

function isOverdue(item: TrackerItem): boolean {
  if (!item.target_date) return false;
  const target = new Date(item.target_date + 'T00:00:00');
  return target < new Date();
}

function formatDate(isoDate: string): string {
  return new Date(isoDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTMinus(isoDate: string): string {
  const eventDate = new Date(isoDate + 'T00:00:00');
  const now = new Date();
  const diffMs = eventDate.getTime() - now.getTime();
  const diffWeeks = Math.ceil(diffMs / (1000 * 60 * 60 * 24 * 7));
  if (diffWeeks > 0) return `T-${diffWeeks} weeks`;
  if (diffWeeks === 0) return 'This week';
  return 'Past';
}

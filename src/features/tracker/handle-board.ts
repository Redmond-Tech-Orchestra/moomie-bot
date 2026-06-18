import { z } from 'zod';
import type { CommandContext } from '../../types.js';
import { loadPrompt } from '../../prompts/load-prompt.js';
import { generateLlmObject, hasLlmKey } from '../../llm.js';
import { getActiveEvents, getItemsForEvent, getAllOpenItems, getOrphanItems, type TrackerEvent, type TrackerItem } from './store.js';
import { buildBoardActionRows } from './board-interactions.js';
import { createLogger } from '../../logger.js';
import { chunkText, DISCORD_CHUNK_MAX } from '../../adapters/chunk.js';

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
      const items = getOrphanItems();
      const { components, footer } = buildActionRow(items);
      await sendChunked(ctx, formatOrgBoard() + footer, { defer: false, components });
      return;
    }
    const event = events.find((e) => e.id === eventId);
    if (!event) {
      await ctx.reply('Event not found.');
      return;
    }
    const items = getItemsForEvent(event.id).filter((i) => i.status !== 'done');
    const { components, footer } = buildActionRow(items);
    await sendChunked(ctx, formatEventBoard(event) + footer, { defer: false, components });
    return;
  }

  // No event specified — show consolidated overview via LLM
  await ctx.deferReply();

  const consolidated = await getConsolidatedBoard(events);

  // Fallback path: LLM unavailable. Single message + flat dropdown.
  if (!consolidated) {
    const allOpen = [...getAllOpenItems(), ...getOrphanItems().filter((o) => o.status !== 'done')];
    const seen = new Set<number>();
    const unique = allOpen.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
    const { components, footer } = buildActionRow(unique);
    await sendChunked(ctx, formatFallbackOverview(events) + footer, { defer: true, components });
    return;
  }

  // Consolidated path: one message per section, each with its own dropdown.
  const allOpen = [...getAllOpenItems(), ...getOrphanItems().filter((o) => o.status !== 'done')];
  const openSeen = new Set<number>();
  const allOpenUnique = allOpen.filter((i) => (openSeen.has(i.id) ? false : (openSeen.add(i.id), true)));
  const openById = new Map(allOpenUnique.map((i) => [i.id, i]));
  const groups = buildGroupsMap(consolidated, allOpenUnique);

  // Map primary id → LLM's consolidated description / owner so the dropdown
  // label matches the board text (rather than the raw #primary item text).
  const overrides = new Map<number, { description: string; owner: string | null }>();
  for (const section of consolidated) {
    for (const ci of section.items) {
      const ids = ci.source_ids.filter((id) => openById.has(id));
      if (ids.length === 0) continue;
      overrides.set(ids[0], { description: ci.description, owner: ci.owner });
    }
  }

  let isFirst = true;
  for (const section of consolidated) {
    // Resolve this section's primary items (one per LLM-merged group, ordered by id ASC).
    const sectionPrimaries: TrackerItem[] = [];
    const seenPrimaries = new Set<number>();
    for (const ci of section.items) {
      const ids = ci.source_ids.filter((id) => openById.has(id));
      if (ids.length === 0) continue;
      const primary = ids[0];
      if (seenPrimaries.has(primary)) continue;
      seenPrimaries.add(primary);
      sectionPrimaries.push(openById.get(primary)!);
    }
    if (sectionPrimaries.length === 0) continue; // skip empty sections

    sectionPrimaries.sort((a, b) => a.id - b.id);

    const sectionText = formatConsolidatedSection(section, events);
    const { components, footer } = buildActionRow(sectionPrimaries, groups, overrides);
    const header = isFirst ? '📋 **MOO Action Board**\n\n' : '';
    const body = header + sectionText + footer;

    if (isFirst) {
      await sendChunked(ctx, body, { defer: true, components });
      isFirst = false;
    } else {
      await sendChunked(ctx, body, { defer: false, components, useFollowUp: true });
    }
  }

  if (isFirst) {
    // Edge case: every section was empty (shouldn't happen if we got here, but be safe).
    await ctx.editReply('No open items.');
  }
}

/**
 * From the LLM's consolidated sections, build a Map<primaryId, allSourceIds>.
 * The "primary" is the first id in source_ids; non-primary members will be
 * hidden from the dropdown (closing the primary closes them all). Only ids
 * that correspond to open items are included.
 */
function buildGroupsMap(sections: ConsolidatedSection[], openItems: TrackerItem[]): Map<number, number[]> {
  const openIds = new Set(openItems.map((i) => i.id));
  const groups = new Map<number, number[]>();
  for (const section of sections) {
    for (const item of section.items) {
      const ids = item.source_ids.filter((id) => openIds.has(id));
      if (ids.length <= 1) continue; // single-id "groups" are uninteresting
      const primary = ids[0];
      groups.set(primary, ids);
    }
  }
  return groups;
}

// ─── Action-row attachment ─────────────────────────────────────────────────

/**
 * Build the multi-select dropdown for closing items, plus a footer string
 * (empty unless we had to truncate to the top 25 actionable items). Returns
 * empty components when there are no open items.
 *
 * Optional `groups` maps a primary item id → all merged source ids (from LLM
 * consolidation). When present, only primary items appear in the dropdown
 * and selecting one closes all merged ids together.
 */
function buildActionRow(
  items: TrackerItem[],
  groups: Map<number, number[]> = new Map(),
  overrides: Map<number, { description: string; owner: string | null }> = new Map(),
): { components: unknown[]; footer: string } {
  const open = items.filter((i) => i.status !== 'done');
  if (open.length === 0) return { components: [], footer: '' };

  // Hide non-primary members of any group — they'll be closed via their primary.
  const nonPrimaryIds = new Set<number>();
  for (const [primary, ids] of groups) {
    for (const id of ids) if (id !== primary) nonPrimaryIds.add(id);
  }
  const visible = open.filter((i) => !nonPrimaryIds.has(i.id));

  // Numerical (id ASC) order — consistent across all board paths.
  const ordered = [...visible].sort((a, b) => a.id - b.id);
  const top = ordered.slice(0, 25);
  const components = buildBoardActionRows(top, groups, overrides);
  if (components.length === 0) return { components: [], footer: '' };

  const footer = visible.length > top.length
    ? `\n\n*(dropdown shows ${top.length} of ${visible.length} open — re-run \`/board\` after closing some to see the rest)*`
    : '';
  return { components, footer };
}

// ─── Chunking ──────────────────────────────────────────────────────────────

/**
 * Discord caps a single message at 2000 chars. Split on blank-line section
 * boundaries when possible, falling back to line boundaries; never break in
 * the middle of a line. Sends the first chunk via reply/editReply (or
 * followUp when `useFollowUp` is set) and any remaining chunks via followUp.
 * Optional `components` are attached to the final chunk (so a dropdown lands
 * on the same message as the tail of the content).
 */
async function sendChunked(
  ctx: CommandContext,
  text: string,
  opts: { defer: boolean; components?: unknown[]; useFollowUp?: boolean },
): Promise<void> {
  const chunks = chunkText(text, DISCORD_CHUNK_MAX);
  const first = chunks[0] ?? '(empty)';
  const components = opts.components ?? [];
  const lastIdx = chunks.length - 1;

  if (opts.useFollowUp) {
    await ctx.followUp(first, lastIdx === 0 ? components : undefined);
  } else if (opts.defer) {
    await ctx.editReply(first, lastIdx === 0 ? components : undefined);
  } else {
    await ctx.reply(first, lastIdx === 0 ? components : undefined);
  }
  for (let i = 1; i < chunks.length; i++) {
    await ctx.followUp(chunks[i], i === lastIdx ? components : undefined);
  }
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

const consolidatedItemSchema = z.object({
  source_ids: z.array(z.number()),
  description: z.string(),
  owner: z.string().nullable(),
  target_date: z.string().nullable(),
  urgency: z.enum(['overdue', 'upcoming', 'normal', 'stale']),
}) satisfies z.ZodType<ConsolidatedItem>;

const consolidatedSectionSchema = z.object({
  title: z.string(),
  event_id: z.number().nullable(),
  items: z.array(consolidatedItemSchema),
}) satisfies z.ZodType<ConsolidatedSection>;

const consolidatedBoardSchema = z.object({
  sections: z.array(consolidatedSectionSchema),
});

async function getConsolidatedBoard(events: TrackerEvent[]): Promise<ConsolidatedSection[] | null> {
  if (!hasLlmKey()) return null;

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
    const { object: parsed } = await generateLlmObject({
      role: 'chat',
      system: systemPrompt,
      prompt: 'Generate the consolidated board.',
      schema: consolidatedBoardSchema,
    });
    return parsed.sections;
  } catch (err) {
    log.error('Consolidation failed:', err);
    return null;
  }
}

function formatConsolidatedSection(section: ConsolidatedSection, events: TrackerEvent[]): string {
  const event = section.event_id ? events.find((e) => e.id === section.event_id) : null;
  const tMinus = event?.date ? ` — ${formatTMinus(event.date)}` : '';
  const lines: string[] = [`**${section.title}**${tMinus}`];

  for (const item of section.items) {
    const icon = item.urgency === 'overdue' ? '🔴'
      : item.urgency === 'stale' ? '⏸️'
      : item.urgency === 'upcoming' ? '🟡'
      : '⬜';
    const idTag = item.source_ids.length > 0 ? ` \`#${item.source_ids.join(',#')}\`` : '';
    const owner = item.owner ? ` — ${item.owner}` : '';
    const target = item.target_date ? ` (${formatDate(item.target_date)})` : '';
    lines.push(`${icon}${idTag} ${item.description}${owner}${target}`);
  }
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
  return `${icon} \`#${item.id}\` ${item.description}${owner}${target}`;
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

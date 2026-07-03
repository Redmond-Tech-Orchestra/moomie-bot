import type { CommandContext } from '../../types.js';
import { getActiveEvents, getItemsForEvent, getOrphanItems, type TrackerEvent, type TrackerItem } from './store.js';
import { buildBoardActionRows } from './board-interactions.js';
import { chunkText, DISCORD_CHUNK_MAX } from '../../adapters/chunk.js';

export const name = 'board';
export const description = 'Swimlane-centric status board';

export async function execute(ctx: CommandContext, args: string): Promise<void> {
  const events = getActiveEvents();
  if (events.length === 0) {
    await ctx.reply('No board swimlanes tracked yet. Events are auto-detected from Performances channels; other channels can be opted in with TRACKER_SWIMLANE_CHANNEL_IDS.');
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

  // No event specified — show actual item sections.
  await ctx.deferReply();
  await sendUnconsolidatedBoard(ctx, events);
}

async function sendUnconsolidatedBoard(ctx: CommandContext, events: TrackerEvent[]): Promise<void> {
  let sentAny = false;

  const orgItems = getOrphanItems().filter((i) => i.status !== 'done');
  if (orgItems.length > 0) {
    const { components, footer } = buildActionRow(orgItems);
    await sendChunked(ctx, '📋 **MOO Action Board**\n\n' + formatOrgBoard() + footer, { defer: true, components });
    sentAny = true;
  }

  for (const event of events) {
    const items = getItemsForEvent(event.id).filter((i) => i.status !== 'done');
    if (items.length === 0) continue;
    const { components, footer } = buildActionRow(items);
    await sendChunked(ctx, formatEventBoard(event) + footer, {
      defer: !sentAny,
      useFollowUp: sentAny,
      components,
    });
    sentAny = true;
  }

  if (!sentAny) {
    await ctx.editReply('No open items.');
  }
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
): { components: unknown[]; footer: string } {
  const open = items.filter((i) => i.status !== 'done');
  if (open.length === 0) return { components: [], footer: '' };

  // Numerical (id ASC) order — consistent across all board paths.
  const ordered = [...open].sort((a, b) => a.id - b.id);
  const top = ordered.slice(0, 25);
  const components = buildBoardActionRows(top);
  if (components.length === 0) return { components: [], footer: '' };

  const footer = open.length > top.length
    ? `\n\n*(dropdown shows ${top.length} of ${open.length} open — re-run \`/board\` after closing some to see the rest)*`
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
  const items = getItemsForEvent(event.id).filter((i) => i.status !== 'done');
  const heading = event.date
    ? `## 🎵 ${event.name} (${formatDate(event.date)}) — ${formatTMinus(event.date)}\n`
    : `## 📌 ${event.name}\n`;

  const lines: string[] = [heading];

  if (items.length === 0) {
    lines.push('No open items.');
    return lines.join('\n');
  }

  // Group by status
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

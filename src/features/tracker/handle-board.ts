import type { CommandContext } from '../../types.js';
import { getActiveEvents, getItemsForEvent, type TrackerEvent, type TrackerItem } from './store.js';

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
    const event = events.find((e) => e.id === eventId);
    if (!event) {
      await ctx.reply('Event not found.');
      return;
    }
    const output = formatEventBoard(event);
    await ctx.reply(output);
    return;
  }

  // No event specified — show overview of all active events
  await ctx.deferReply();
  const lines: string[] = [];

  for (const event of events) {
    const items = getItemsForEvent(event.id);
    const open = items.filter((i) => i.status === 'open').length;
    const done = items.filter((i) => i.status === 'done').length;
    const overdue = items.filter((i) => i.status === 'open' && isOverdue(i)).length;

    const dateStr = formatDate(event.date);
    const tMinus = formatTMinus(event.date);
    const overdueStr = overdue > 0 ? ` ⚠️ ${overdue} overdue` : '';

    lines.push(`🎵 **${event.name}** (${dateStr}, ${tMinus}) — ${done} done, ${open} open${overdueStr}`);
  }

  lines.push('\n*Use `/board event:<name>` for details on a specific event.*');
  await ctx.editReply(lines.join('\n'));
}

function formatEventBoard(event: TrackerEvent): string {
  const items = getItemsForEvent(event.id);
  const dateStr = formatDate(event.date);
  const tMinus = formatTMinus(event.date);

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

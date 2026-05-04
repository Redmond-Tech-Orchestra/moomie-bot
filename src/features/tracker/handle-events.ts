import type { CommandContext } from '../../types.js';
import { getActiveEvents } from './store.js';

export const name = 'events';
export const description = 'List upcoming orchestra events';

export async function execute(ctx: CommandContext, _args: string): Promise<void> {
  const events = getActiveEvents();

  if (events.length === 0) {
    await ctx.reply('No upcoming events tracked yet.');
    return;
  }

  const now = new Date();
  const lines = events.map((e) => {
    const eventDate = new Date(e.date + 'T00:00:00');
    const diffMs = eventDate.getTime() - now.getTime();
    const diffWeeks = Math.ceil(diffMs / (1000 * 60 * 60 * 24 * 7));
    const tMinus = diffWeeks > 0 ? `T-${diffWeeks} weeks` : diffWeeks === 0 ? 'This week' : 'Past';

    const dateStr = eventDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endStr = e.end_date
      ? `–${new Date(e.end_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';

    const status = e.confirmed ? '' : ' *(unconfirmed)*';
    return `🎵 **${e.name}** — ${dateStr}${endStr} (${tMinus})${status}`;
  });

  await ctx.reply(lines.join('\n'));
}

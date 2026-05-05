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
    const eventDate = e.date ? new Date(e.date + 'T00:00:00') : null;
    let countdown: string;
    let dateStr: string;
    if (eventDate) {
      const diffMs = eventDate.getTime() - now.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      const diffWeeks = Math.ceil(diffDays / 7);
      countdown = diffDays <= 0 ? 'past' : diffDays < 7 ? `${diffDays}d away` : `${diffWeeks}w away`;
      dateStr = eventDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    } else {
      countdown = 'date TBD';
      dateStr = 'TBD';
    }
    const endStr = e.end_date
      ? ` – ${new Date(e.end_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
      : '';

    const status = e.confirmed ? '' : ' *(unconfirmed)*';
    return `🎵 **${e.name}** — ${dateStr}${endStr} (${countdown})${status}`;
  });

  await ctx.reply(lines.join('\n'));
}

import type { AutocompleteInteraction } from 'discord.js';
import { getActiveEvents } from './store.js';

/**
 * Shared autocomplete handler for the 'event' option used across /board, /track, /nudge, etc.
 */
export async function autocompleteEvent(interaction: AutocompleteInteraction): Promise<void> {
  try {
    const focused = interaction.options.getFocused();
    const events = getActiveEvents();

    const filtered = events
      .filter((e) => {
        if (!focused) return true;
        const lower = focused.toLowerCase();
        return e.name.toLowerCase().includes(lower) || e.date.includes(lower);
      })
      .slice(0, 25);

    const choices = filtered.map((e) => {
      const dateStr = new Date(e.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return { name: `${e.name} (${dateStr})`, value: e.id };
    });

    await interaction.respond(choices);
  } catch (err) {
    console.error('[Tracker] Autocomplete error:', err);
    await interaction.respond([]).catch(() => {});
  }
}

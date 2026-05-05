import type { AutocompleteInteraction } from 'discord.js';
import { getActiveEvents, getOrphanItems } from './store.js';

/**
 * Shared autocomplete handler for the 'event' option used across /board, etc.
 */
export async function autocompleteEvent(interaction: AutocompleteInteraction): Promise<void> {
  try {
    const focused = interaction.options.getFocused();
    const events = getActiveEvents();

    const choices: { name: string; value: number }[] = [];

    // Add org-wide option if there are orphan items
    const orphans = getOrphanItems();
    if (orphans.length > 0) {
      const show = !focused || 'org-wide'.includes(focused.toLowerCase());
      if (show) choices.push({ name: `Org-wide (${orphans.length} items)`, value: 0 });
    }

    const filtered = events
      .filter((e) => {
        if (!focused) return true;
        const lower = focused.toLowerCase();
        return e.name.toLowerCase().includes(lower) || (e.date?.includes(lower) ?? false);
      })
      .slice(0, 24);

    for (const e of filtered) {
      const dateStr = e.date
        ? new Date(e.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : 'TBD';
      choices.push({ name: `${e.name} (${dateStr})`, value: e.id });
    }

    await interaction.respond(choices.slice(0, 25));
  } catch (err) {
    console.error('[Tracker] Autocomplete error:', err);
    await interaction.respond([]).catch(() => {});
  }
}

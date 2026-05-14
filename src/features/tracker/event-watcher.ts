import type { Client, TextChannel, CategoryChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import { parseChannelName, computeEventDates } from './parse-channel.js';
import {
  getEventByChannelId,
  getEventById,
  createEvent,
  confirmEvent,
  archiveEvent,
  updateEvent,
  getAllEvents,
  getOrphanItems,
  reassignItems,
} from './store.js';
import { PERFORMANCES_CATEGORY_ID, ARCHIVED_CATEGORY_ID, DISCORD_GUILD_ID, MODEL_DEDUP, geminiUrl } from '../../config.js';
import { loadPrompt } from '../../prompts/load-prompt.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Tracker');

/**
 * Register a reaction listener that confirms events when ✅ is added
 * to a bot confirmation message in a Performances channel.
 */
export function registerEventConfirmationListener(client: Client): void {
  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { return; }
    }

    if (reaction.emoji.name !== '✅') return;

    const message = reaction.message;
    if (message.author?.id !== client.user?.id) return;

    // Only handle messages in Performances category channels
    const channel = message.channel;
    if (!('parentId' in channel) || channel.parentId !== PERFORMANCES_CATEGORY_ID) return;

    const event = getEventByChannelId(channel.id);
    if (!event || event.confirmed) return;

    confirmEvent(event.id);
    log.info(`Event confirmed via reaction: ${event.name} (id=${event.id})`);

    try {
      await (channel as TextChannel).send(
        `✅ **${event.name}** confirmed! I'll keep an eye on action items for this event.`
      );
    } catch { /* best effort */ }
  });
}

/**
 * Run on startup: sync all channels in the Performances category to the events table.
 */
export async function syncEvents(client: Client): Promise<void> {
  if (!PERFORMANCES_CATEGORY_ID) {
    log.warn('PERFORMANCES_CATEGORY_ID not set — skipping event sync');
    return;
  }

  const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
  if (!guild) return;

  // Fetch to avoid empty-cache race on startup
  const category = guild.channels.cache.get(PERFORMANCES_CATEGORY_ID)
    ?? await guild.channels.fetch(PERFORMANCES_CATEGORY_ID).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    log.warn('Performances category not found');
    return;
  }

  const channels = (category as CategoryChannel).children.cache.filter(
    (ch) => ch.type === ChannelType.GuildText
  );

  let synced = 0;
  for (const [, channel] of channels) {
    const existing = getEventByChannelId(channel.id);
    if (existing) continue;

    const parsed = parseChannelName(channel.name);
    if (!parsed) {
      log.info(`Could not parse channel name: #${channel.name}`);
      continue;
    }

    if (parsed.ambiguous || parsed.days.length === 0) {
      // Dateless or ambiguous — create with null date, ask for details
      const newId = createEvent({
        name: parsed.name,
        channel_id: channel.id,
        channel_name: channel.name,
        confirmed: false,
      });
      await askForConfirmation(channel as TextChannel, parsed);
      await attributeOrphansToEvent(newId);
      continue;
    }

    const { date, end_date } = computeEventDates(parsed);
    const eventId = createEvent({
      name: parsed.name,
      date,
      end_date: end_date ?? undefined,
      channel_id: channel.id,
      channel_name: channel.name,
      confirmed: false,
    });

    // Post confirmation request in the channel
    await askForConfirmation(channel as TextChannel, parsed, eventId);
    await attributeOrphansToEvent(eventId);
    synced++;
  }

  // Check for archived channels
  if (ARCHIVED_CATEGORY_ID) {
    const allEvents = getAllEvents();
    for (const event of allEvents) {
      if (!event.channel_id || event.archived) continue;
      const ch = guild.channels.cache.get(event.channel_id);
      if (ch && ch.parentId === ARCHIVED_CATEGORY_ID) {
        archiveEvent(event.id);
        log.info(`Archived event: ${event.name}`);
      }
    }
  }

  if (synced > 0) {
    log.info(`Synced ${synced} new event(s) from Performances category`);
  }
}

/**
 * Register runtime listeners for channel creation and updates.
 */
export function registerChannelWatcher(client: Client): void {
  if (!PERFORMANCES_CATEGORY_ID) return;

  client.on('channelCreate', async (channel) => {
    if (channel.type !== ChannelType.GuildText) return;
    if (channel.parentId !== PERFORMANCES_CATEGORY_ID) return;

    const existing = getEventByChannelId(channel.id);
    if (existing) return;

    const parsed = parseChannelName(channel.name);
    if (!parsed) {
      log.info(`New channel could not be parsed: #${channel.name}`);
      return;
    }

    if (parsed.ambiguous || parsed.days.length === 0) {
      const newId = createEvent({
        name: parsed.name,
        channel_id: channel.id,
        channel_name: channel.name,
        confirmed: false,
      });
      await askForConfirmation(channel as TextChannel, parsed);
      attributeOrphansToEvent(newId).catch(() => {});
      return;
    }

    const { date, end_date } = computeEventDates(parsed);
    const eventId = createEvent({
      name: parsed.name,
      date,
      end_date: end_date ?? undefined,
      channel_id: channel.id,
      channel_name: channel.name,
      confirmed: false,
    });

    await askForConfirmation(channel as TextChannel, parsed, eventId);
    attributeOrphansToEvent(eventId).catch(() => {});
    log.info(`New event detected: ${parsed.name} (${date})`);
  });

  // Watch for channel moves (to Archived category) and renames
  client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (newChannel.type !== ChannelType.GuildText) return;

    // Archive detection
    if (ARCHIVED_CATEGORY_ID) {
      const oldParent = 'parentId' in oldChannel ? oldChannel.parentId : null;
      const newParent = 'parentId' in newChannel ? newChannel.parentId : null;

      if (oldParent !== ARCHIVED_CATEGORY_ID && newParent === ARCHIVED_CATEGORY_ID) {
        const event = getEventByChannelId(newChannel.id);
        if (event && !event.archived) {
          archiveEvent(event.id);
          log.info(`Event archived: ${event.name}`);
        }
      }
    }

    // Rename detection — only for Performances channels
    if (newChannel.parentId !== PERFORMANCES_CATEGORY_ID) return;
    const oldName = 'name' in oldChannel ? oldChannel.name : null;
    if (!oldName || oldName === newChannel.name) return;

    const event = getEventByChannelId(newChannel.id);
    if (!event) return;

    const parsed = parseChannelName(newChannel.name);
    if (!parsed) {
      log.info(`Renamed channel could not be parsed: #${newChannel.name}`);
      return;
    }

    // Compute updated fields
    const fields: { name?: string; date?: string | null; end_date?: string | null; channel_name?: string } = {
      name: parsed.name,
      channel_name: newChannel.name,
    };

    if (parsed.days.length > 0 && !parsed.ambiguous) {
      const { date, end_date } = computeEventDates(parsed);
      fields.date = date;
      fields.end_date = end_date;
    }

    updateEvent(event.id, fields);
    log.info(`Event updated from channel rename: #${oldName} → #${newChannel.name} (id=${event.id}, name=${parsed.name}${fields.date ? `, date=${fields.date}` : ''})`);
  });
}

/**
 * Post a confirmation message in the channel asking about event details.
 */
async function askForConfirmation(channel: TextChannel, parsed: ReturnType<typeof parseChannelName> & {}, eventId?: number): Promise<void> {
  try {
    if (parsed.ambiguous) {
      await channel.send(
        `📅 **New performance channel detected!**\n\n` +
        `I see: #${parsed.raw}\n` +
        `I couldn't figure out the dates from the channel name.\n\n` +
        `Can someone tell me:\n` +
        `• Event name?\n` +
        `• Date(s)? (e.g. "Jul 16 and Jul 18" or "Jul 16-18")`
      );
      return;
    }

    if (parsed.days.length === 0) {
      await channel.send(
        `📅 **New performance channel detected!**\n\n` +
        `I see: #${parsed.raw}\n` +
        `Looks like **${parsed.name}** — no specific date yet.\n\n` +
        `When you know the date, rename the channel (e.g. \`11-6-${parsed.name}\`) and I'll pick it up.\n` +
        `Or tell me here and react ✅ to confirm.`
      );
      return;
    }

  const { date, end_date } = computeEventDates(parsed);
  const dateStr = end_date
    ? `**${formatDisplayDate(date)}–${formatDisplayDate(end_date)}** (multi-day event)`
    : `**${formatDisplayDate(date)}**`;

  await channel.send(
    `📅 **New performance channel detected!**\n\n` +
    `I see: #${parsed.raw}\n` +
    `My best guess: **${parsed.name}** on ${dateStr}\n\n` +
    `Is this right? Reply with corrections if not:\n` +
    `• Event name?\n` +
    `• Date(s)? (e.g. "Jul 16 and Jul 18" or "Jul 16-18")\n\n` +
    `React ✅ to confirm and I'll start tracking action items for it.`
  );
  } catch (err) {
    log.error(`Could not send confirmation to #${channel.name}:`, err);
  }
}

function formatDisplayDate(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Orphan Item Attribution ─────────────────────────────────────────────────

/**
 * When a new event is created, check if any unassigned ("org-wide") items
 * should be attributed to it. Uses an LLM to match based on description.
 */
async function attributeOrphansToEvent(eventId: number): Promise<void> {
  const orphans = getOrphanItems();
  if (orphans.length === 0) return;

  const event = getEventById(eventId);
  if (!event) return;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  const orphanList = orphans.map((i) => {
    const owner = i.owner_name ? ` (owner: ${i.owner_name})` : '';
    const date = i.source_date ? ` [${i.source_date}]` : '';
    return `- [#${i.id}] ${i.description}${owner}${date}`;
  }).join('\n');

  const prompt = loadPrompt('orphan-attribution.md', {
    EVENT_NAME: event.name,
    CHANNEL_NAME: event.channel_name ?? event.name,
    EVENT_DATE: event.date ?? 'TBD',
    ORPHAN_ITEMS: orphanList,
  }, true); // skip persona — this is a mechanical task

  try {
    const res = await fetch(`${geminiUrl(MODEL_DEDUP)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });

    if (!res.ok) {
      log.error(`Orphan attribution API error ${res.status}`);
      return;
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return;

    const result = JSON.parse(text) as { attributions: { item_id: number; reason: string }[] };
    if (!result.attributions?.length) return;

    // Validate IDs — only reassign items that are actually orphans
    const orphanIds = new Set(orphans.map((i) => i.id));
    const validIds = result.attributions
      .filter((a) => orphanIds.has(a.item_id))
      .map((a) => a.item_id);

    if (validIds.length === 0) return;

    reassignItems(validIds, eventId);

    const reasons = result.attributions
      .filter((a) => orphanIds.has(a.item_id))
      .map((a) => `#${a.item_id}: ${a.reason}`)
      .join('; ');
    log.info(`Attributed ${validIds.length} orphan(s) to "${event.name}": ${reasons}`);

    log.audit({
      type: 'attribution',
      channel_id: event.channel_id ?? undefined,
      channel_name: event.channel_name ?? undefined,
      model: MODEL_DEDUP,
      input_summary: `${orphans.length} orphans, event: ${event.name}`,
      output_json: text,
      result: `${validIds.length} attributed`,
      tokens_in: data.usageMetadata?.promptTokenCount,
      tokens_out: data.usageMetadata?.candidatesTokenCount,
    });
  } catch (err) {
    log.error('Orphan attribution failed:', err);
  }
}

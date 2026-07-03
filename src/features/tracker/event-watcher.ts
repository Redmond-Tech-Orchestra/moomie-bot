import type { Client, TextChannel, CategoryChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import { z } from 'zod';
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
import {
  PERFORMANCES_CATEGORY_ID,
  ARCHIVED_CATEGORY_ID,
  DISCORD_GUILD_ID,
  TRACKER_SWIMLANE_CATEGORY_IDS,
  TRACKER_SWIMLANE_CHANNEL_IDS,
  TRACKER_IGNORED_CHANNEL_IDS,
  modelFor,
} from '../../config.js';
import { generateLlmObject, hasLlmKey } from '../../llm.js';
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
  const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
  if (!guild) return;

  if (PERFORMANCES_CATEGORY_ID) {
    // Fetch to avoid empty-cache race on startup
    const category = guild.channels.cache.get(PERFORMANCES_CATEGORY_ID)
      ?? await guild.channels.fetch(PERFORMANCES_CATEGORY_ID).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      log.warn('Performances category not found');
    } else {
      const channels = (category as CategoryChannel).children.cache.filter(
        (ch) => ch.type === ChannelType.GuildText
      );

      let synced = 0;
      for (const [, channel] of channels) {
        if (await syncPerformanceChannel(channel as TextChannel)) synced++;
      }

      if (synced > 0) {
        log.info(`Synced ${synced} new event(s) from Performances category`);
      }
    }
  } else {
    log.warn('PERFORMANCES_CATEGORY_ID not set — skipping performance event sync');
  }

  const categorySwimlaneSynced = await syncSwimlaneCategories(client);
  if (categorySwimlaneSynced > 0) {
    log.info(`Synced ${categorySwimlaneSynced} tracker category swimlane(s)`);
  }

  const swimlaneSynced = await syncSwimlaneChannels(client);
  if (swimlaneSynced > 0) {
    log.info(`Synced ${swimlaneSynced} tracker channel swimlane(s)`);
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

}

/**
 * Register runtime listeners for channel creation and updates.
 */
export function registerChannelWatcher(client: Client): void {
  if (!PERFORMANCES_CATEGORY_ID && TRACKER_SWIMLANE_CATEGORY_IDS.length === 0 && TRACKER_SWIMLANE_CHANNEL_IDS.length === 0) return;

  client.on('channelCreate', async (channel) => {
    if (channel.type !== ChannelType.GuildText) return;
    if (TRACKER_IGNORED_CHANNEL_IDS.includes(channel.id)) return;

    if (TRACKER_SWIMLANE_CHANNEL_IDS.includes(channel.id)) {
      syncSwimlaneChannel(channel as TextChannel);
      return;
    }

    if (channel.parentId && TRACKER_SWIMLANE_CATEGORY_IDS.includes(channel.parentId)) {
      const category = channel.parent;
      if (category?.type === ChannelType.GuildCategory) syncSwimlaneCategory(category as CategoryChannel);
      return;
    }

    if (channel.parentId !== PERFORMANCES_CATEGORY_ID) return;

    await syncPerformanceChannel(channel as TextChannel, true);
  });

  // Watch for channel moves (to Archived category) and renames
  client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (newChannel.type === ChannelType.GuildCategory && TRACKER_SWIMLANE_CATEGORY_IDS.includes(newChannel.id)) {
      const event = getEventByChannelId(newChannel.id);
      if (event) {
        updateEvent(event.id, { name: displayNameFromChannel(newChannel.name), channel_name: newChannel.name });
        log.info(`Tracker category swimlane updated from category rename: ${newChannel.name} (id=${event.id})`);
      }
      return;
    }

    if (newChannel.type !== ChannelType.GuildText) return;
    if (TRACKER_IGNORED_CHANNEL_IDS.includes(newChannel.id)) return;

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

    const oldName = 'name' in oldChannel ? oldChannel.name : null;
    if (!oldName || oldName === newChannel.name) return;

    const event = getEventByChannelId(newChannel.id);
    if (!event) return;

    if (TRACKER_SWIMLANE_CHANNEL_IDS.includes(newChannel.id)) {
      updateEvent(event.id, { name: displayNameFromChannel(newChannel.name), channel_name: newChannel.name });
      log.info(`Tracker swimlane updated from channel rename: #${oldName} → #${newChannel.name} (id=${event.id})`);
      return;
    }

    // Rename detection — only for Performances channels
    if (newChannel.parentId !== PERFORMANCES_CATEGORY_ID) return;

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

async function syncPerformanceChannel(channel: TextChannel, logNew: boolean = false): Promise<boolean> {
  const existing = getEventByChannelId(channel.id);
  if (existing) return false;

  const parsed = parseChannelName(channel.name);
  if (!parsed) {
    log.info(`${logNew ? 'New channel' : 'Channel'} could not be parsed: #${channel.name}`);
    return false;
  }

  if (parsed.ambiguous || parsed.days.length === 0) {
    const newId = createEvent({
      name: parsed.name,
      channel_id: channel.id,
      channel_name: channel.name,
      confirmed: false,
    });
    await askForConfirmation(channel, parsed);
    attributeOrphansToEvent(newId).catch(() => {});
    return true;
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

  await askForConfirmation(channel, parsed, eventId);
  attributeOrphansToEvent(eventId).catch(() => {});
  if (logNew) log.info(`New event detected: ${parsed.name} (${date})`);
  return true;
}

async function syncSwimlaneChannels(client: Client): Promise<number> {
  let synced = 0;
  for (const channelId of TRACKER_SWIMLANE_CHANNEL_IDS) {
    if (TRACKER_IGNORED_CHANNEL_IDS.includes(channelId)) continue;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      log.warn(`Tracker swimlane channel not found or not text: ${channelId}`);
      continue;
    }
    if (syncSwimlaneChannel(channel as TextChannel)) synced++;
  }
  return synced;
}

async function syncSwimlaneCategories(client: Client): Promise<number> {
  let synced = 0;
  for (const categoryId of TRACKER_SWIMLANE_CATEGORY_IDS) {
    const channel = await client.channels.fetch(categoryId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildCategory) {
      log.warn(`Tracker swimlane category not found: ${categoryId}`);
      continue;
    }
    if (syncSwimlaneCategory(channel as CategoryChannel)) synced++;
  }
  return synced;
}

function syncSwimlaneCategory(category: CategoryChannel): boolean {
  const existing = getEventByChannelId(category.id);
  if (existing) {
    updateEvent(existing.id, { name: displayNameFromChannel(category.name), channel_name: category.name });
    return false;
  }

  createEvent({
    name: displayNameFromChannel(category.name),
    channel_id: category.id,
    channel_name: category.name,
    confirmed: true,
  });
  return true;
}

function syncSwimlaneChannel(channel: TextChannel): boolean {
  const existing = getEventByChannelId(channel.id);
  if (existing) {
    updateEvent(existing.id, { name: displayNameFromChannel(channel.name), channel_name: channel.name });
    return false;
  }

  createEvent({
    name: displayNameFromChannel(channel.name),
    channel_id: channel.id,
    channel_name: channel.name,
    confirmed: true,
  });
  return true;
}

function displayNameFromChannel(channelName: string): string {
  return channelName
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
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

const attributionSchema = z.object({
  attributions: z.array(z.object({
    item_id: z.number(),
    reason: z.string(),
  })),
});

/**
 * When a new event is created, check if any unassigned ("org-wide") items
 * should be attributed to it. Uses an LLM to match based on description.
 */
async function attributeOrphansToEvent(eventId: number): Promise<void> {
  const orphans = getOrphanItems();
  if (orphans.length === 0) return;

  const event = getEventById(eventId);
  if (!event) return;

  if (!hasLlmKey()) return;

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
    const { object: result, inputTokens, outputTokens } = await generateLlmObject({
      role: 'dedup',
      prompt,
      schema: attributionSchema,
    });
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
      model: modelFor('dedup'),
      input_summary: `${orphans.length} orphans, event: ${event.name}`,
      output_json: JSON.stringify(result),
      result: `${validIds.length} attributed`,
      tokens_in: inputTokens,
      tokens_out: outputTokens,
    });
  } catch (err) {
    log.error('Orphan attribution failed:', err);
  }
}

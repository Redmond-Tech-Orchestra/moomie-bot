import type { Client, TextChannel, CategoryChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import { parseChannelName, computeEventDates } from './parse-channel.js';
import {
  getEventByChannelId,
  createEvent,
  confirmEvent,
  archiveEvent,
  getAllEvents,
} from './store.js';
import { PERFORMANCES_CATEGORY_ID, ARCHIVED_CATEGORY_ID } from '../../config.js';

/**
 * Run on startup: sync all channels in the Performances category to the events table.
 */
export async function syncEvents(client: Client): Promise<void> {
  if (!PERFORMANCES_CATEGORY_ID) {
    console.warn('[Tracker] PERFORMANCES_CATEGORY_ID not set — skipping event sync');
    return;
  }

  const guild = client.guilds.cache.first();
  if (!guild) return;

  const category = guild.channels.cache.get(PERFORMANCES_CATEGORY_ID);
  if (!category || category.type !== ChannelType.GuildCategory) {
    console.warn('[Tracker] Performances category not found');
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
      console.log(`[Tracker] Could not parse channel name: #${channel.name}`);
      continue;
    }

    if (parsed.ambiguous) {
      // Create event with placeholder date — will be updated on confirmation
      createEvent({
        name: parsed.name,
        date: '1970-01-01',
        channel_id: channel.id,
        channel_name: channel.name,
        confirmed: false,
      });
      await askForConfirmation(channel as TextChannel, parsed);
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
        console.log(`[Tracker] Archived event: ${event.name}`);
      }
    }
  }

  if (synced > 0) {
    console.log(`[Tracker] Synced ${synced} new event(s) from Performances category`);
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
      console.log(`[Tracker] New channel could not be parsed: #${channel.name}`);
      return;
    }

    if (parsed.ambiguous) {
      createEvent({
        name: parsed.name,
        date: '1970-01-01',
        channel_id: channel.id,
        channel_name: channel.name,
        confirmed: false,
      });
      await askForConfirmation(channel as TextChannel, parsed);
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
    console.log(`[Tracker] New event detected: ${parsed.name} (${date})`);
  });

  // Watch for channel moves (to Archived category)
  client.on('channelUpdate', (oldChannel, newChannel) => {
    if (newChannel.type !== ChannelType.GuildText) return;
    if (!ARCHIVED_CATEGORY_ID) return;

    const oldParent = 'parentId' in oldChannel ? oldChannel.parentId : null;
    const newParent = 'parentId' in newChannel ? newChannel.parentId : null;

    if (oldParent !== ARCHIVED_CATEGORY_ID && newParent === ARCHIVED_CATEGORY_ID) {
      const event = getEventByChannelId(newChannel.id);
      if (event && !event.archived) {
        archiveEvent(event.id);
        console.log(`[Tracker] Event archived: ${event.name}`);
      }
    }
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
    `React ✅ to confirm and I'll set up milestone tracking.`
  );
  } catch (err) {
    console.error(`[Tracker] Could not send confirmation to #${channel.name}:`, err);
  }
}

function formatDisplayDate(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Handle a ✅ reaction on a confirmation message to finalize the event.
 * Called from the reaction collector setup (to be wired in later phase).
 */
export function onEventConfirmed(eventId: number, _eventDate: string): void {
  confirmEvent(eventId);
  console.log(`[Tracker] Event ${eventId} confirmed`);
}

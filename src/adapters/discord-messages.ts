import { client } from './discord.js';
import { ChannelType } from 'discord.js';
import type { TextChannel, Collection, Message, Snowflake } from 'discord.js';

export interface ChannelMessages {
  channel: string;
  messages: { author: string; content: string; timestamp: Date }[];
}

const MAX_MESSAGES_PER_CHANNEL = 500;

/**
 * Fetch recent messages from all readable text channels in the guild.
 * Paginates backward until hitting the `since` boundary or the per-channel cap.
 */
export async function getRecentMessages(guildId: string, since: Date): Promise<ChannelMessages[]> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return [];

  const channels = guild.channels.cache.filter(
    (ch) => ch.type === ChannelType.GuildText && ch.viewable
  );

  const results: ChannelMessages[] = [];

  for (const [, channel] of channels) {
    if (channel.type !== ChannelType.GuildText) continue;

    try {
      const messages = await fetchUntil(channel as TextChannel, since);
      if (messages.length > 0) {
        results.push({ channel: channel.name, messages });
      }
    } catch {
      // Skip channels we can't read
    }
  }

  return results;
}

async function fetchUntil(
  channel: TextChannel,
  since: Date,
): Promise<{ author: string; content: string; timestamp: Date }[]> {
  const all: { author: string; content: string; timestamp: Date }[] = [];
  let before: string | undefined;
  let done = false;

  while (!done && all.length < MAX_MESSAGES_PER_CHANNEL) {
    const batch: Collection<Snowflake, Message> = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });

    if (batch.size === 0) break;

    for (const [, m] of batch) {
      if (m.createdAt < since) {
        done = true;
        break;
      }
      if (!m.author.bot) {
        all.push({
          author: m.member?.displayName ?? m.author.displayName ?? m.author.username,
          content: m.content || (m.attachments.size > 0 ? '[attachment]' : '[embed]'),
          timestamp: m.createdAt,
        });
      }
    }

    before = batch.last()?.id;
  }

  // Return in chronological order
  return all.reverse();
}

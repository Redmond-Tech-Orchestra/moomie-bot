import type { CommandContext } from '../../types.js';
import { getRecentMessages } from '../../adapters/index.js';
import type { ChannelMessages } from '../../adapters/index.js';
import { loadPrompt } from '../../prompts/load-prompt.js';
import { getActiveEvents, getOpenItemsForEvent } from '../tracker/store.js';
import { DISCORD_GUILD_ID } from '../../config.js';
import { generateLlmText, hasLlmKey } from '../../llm.js';
import * as chrono from 'chrono-node';
import { createLogger } from '../../logger.js';

const log = createLogger('Digest');

export const name = 'digest';
export const description = 'Structured summary of recent server activity';

const DEFAULT_WINDOW = '1 week ago';
const MAX_CONTEXT_CHARS = 80_000; // Stay well under the model's context window

export async function execute(ctx: CommandContext, args: string): Promise<void> {
  const window = args.trim() || DEFAULT_WINDOW;
  const since = parseWindow(window);
  if (!since) {
    await ctx.reply(`Couldn't understand \`${window}\`. Try "3 days", "last week", "since monday", or "2w".`);
    return;
  }

  await ctx.deferReply();

  const guildId = DISCORD_GUILD_ID;
  if (!guildId) {
    await ctx.editReply('DISCORD_GUILD_ID is not configured.');
    return;
  }

  const channelData = await getRecentMessages(guildId, since);
  if (channelData.length === 0) {
    await ctx.editReply(`No activity found in the last ${window}.`);
    return;
  }

  const transcript = formatTranscript(channelData);
  const digest = await generateDigest(transcript, window);

  // Discord has a 2000-char message limit; split if needed
  if (digest.length <= 2000) {
    await ctx.editReply(digest);
  } else {
    const chunks = splitMessage(digest, 2000);
    await ctx.editReply(chunks[0]);
    // Additional chunks sent as follow-ups aren't possible with editReply,
    // so truncate with a note
    if (chunks.length > 1) {
      await ctx.editReply(chunks[0] + '\n\n*(...truncated — try a shorter time window)*');
    }
  }
}

function parseWindow(input: string): Date | null {
  // Support shorthand like "4h", "1d", "2w", "3m"
  const shorthand = input.match(/^(\d+)\s*(h|d|w|m)$/i);
  if (shorthand) {
    const amount = parseInt(shorthand[1], 10);
    const unit = shorthand[2].toLowerCase();
    const now = Date.now();
    switch (unit) {
      case 'h': return new Date(now - amount * 60 * 60 * 1000);
      case 'd': return new Date(now - amount * 24 * 60 * 60 * 1000);
      case 'w': return new Date(now - amount * 7 * 24 * 60 * 60 * 1000);
      case 'm': return new Date(now - amount * 30 * 24 * 60 * 60 * 1000);
    }
  }

  // Natural language: "last week", "3 days ago", "since monday", "past 2 weeks"
  const results = chrono.parse(input);
  if (results.length > 0) {
    return results[0].start.date();
  }

  return null;
}

function formatTranscript(channels: ChannelMessages[]): string {
  let result = '';
  for (const ch of channels) {
    result += `\n## #${ch.channel}\n`;
    for (const msg of ch.messages) {
      const time = msg.timestamp.toISOString().slice(0, 16).replace('T', ' ');
      result += `[${time}] ${msg.author}: ${msg.content}\n`;
    }
  }
  // Truncate if too long
  if (result.length > MAX_CONTEXT_CHARS) {
    result = result.slice(-MAX_CONTEXT_CHARS);
  }
  return result;
}

async function generateDigest(transcript: string, window: string): Promise<string> {
  if (!hasLlmKey()) return '*LLM API key not configured.*';

  const events = getActiveEvents();
  const eventsContext = events.length > 0
    ? 'Known upcoming events:\n' + events.map((e) => {
        const dateStr = e.date
          ? new Date(e.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : 'date TBD';
        return `- ${e.name} — ${dateStr}${e.channel_name ? ` (channel: #${e.channel_name})` : ''}`;
      }).join('\n')
    : 'No upcoming events currently tracked.';

  const openItemsSections: string[] = [];
  for (const e of events) {
    const items = getOpenItemsForEvent(e.id);
    if (items.length === 0) continue;
    openItemsSections.push(`Open items for ${e.name}:\n` + items.map((i) =>
      `- ${i.description}${i.owner_name ? ` (owner: ${i.owner_name})` : ''}${i.status === 'stale' ? ' [STALE]' : ''}`
    ).join('\n'));
  }
  const openItemsContext = openItemsSections.length > 0
    ? openItemsSections.join('\n\n')
    : 'No open items currently tracked.';

  const systemPrompt = loadPrompt('digest-system.md', {
    EVENTS_CONTEXT: eventsContext,
    OPEN_ITEMS_CONTEXT: openItemsContext,
  });

  try {
    const { text } = await generateLlmText({
      role: 'chat',
      system: systemPrompt,
      prompt: transcript,
    });
    return text || '*No response from model.*';
  } catch (err) {
    log.error('Digest LLM call failed:', err);
    return '*Failed to generate digest.*';
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Try to split at a newline near the limit
    const cut = remaining.lastIndexOf('\n', maxLen);
    const splitAt = cut > maxLen * 0.5 ? cut : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

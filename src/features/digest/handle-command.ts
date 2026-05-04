import type { CommandContext } from '../../types.js';
import { getRecentMessages } from '../../adapters/index.js';
import type { ChannelMessages } from '../../adapters/index.js';
import { loadPrompt } from '../../prompts/load-prompt.js';
import { getActiveEvents } from '../tracker/store.js';
import * as chrono from 'chrono-node';

export const name = 'digest';
export const description = 'Structured summary of recent server activity';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const DEFAULT_WINDOW = '1 week ago';
const MAX_CONTEXT_CHARS = 80_000; // Stay well under Gemini's context window

export async function execute(ctx: CommandContext, args: string): Promise<void> {
  const window = args.trim() || DEFAULT_WINDOW;
  const since = parseWindow(window);
  if (!since) {
    await ctx.reply(`Couldn't understand \`${window}\`. Try "3 days", "last week", "since monday", or "2w".`);
    return;
  }

  await ctx.deferReply();

  const guildId = process.env.DISCORD_GUILD_ID;
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
  const digest = await callGemini(transcript, window);

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

async function callGemini(transcript: string, window: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return '*GEMINI_API_KEY not configured.*';

  const events = getActiveEvents();
  const eventsContext = events.length > 0
    ? 'Known upcoming events:\n' + events.map((e) => {
        const dateStr = new Date(e.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return `- ${e.name} — ${dateStr}${e.channel_name ? ` (channel: #${e.channel_name})` : ''}`;
      }).join('\n')
    : 'No upcoming events currently tracked.';

  const systemPrompt = loadPrompt('digest-system.md', {
    EVENTS_CONTEXT: eventsContext,
  });

  try {
    const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: transcript }] }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[Digest] Gemini API error ${res.status}:`, body);
      return `*Failed to generate digest (API ${res.status}).*`;
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      || '*No response from model.*';
  } catch (err) {
    console.error('[Digest] Gemini call failed:', err);
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

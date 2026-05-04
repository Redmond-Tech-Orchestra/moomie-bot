import type { CommandContext } from '../../types.js';
import { getRecentMessages } from '../../adapters/index.js';
import type { ChannelMessages } from '../../adapters/index.js';

export const name = 'digest';
export const description = 'Structured summary of recent server activity';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const DEFAULT_WINDOW = '1w';
const MAX_CONTEXT_CHARS = 80_000; // Stay well under Gemini's context window

export async function execute(ctx: CommandContext, args: string): Promise<void> {
  const window = args.trim() || DEFAULT_WINDOW;
  const since = parseWindow(window);
  if (!since) {
    await ctx.reply(`Invalid time window: \`${window}\`. Use formats like \`4h\`, \`1d\`, \`2w\`, \`3m\`.`);
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
  const match = input.match(/^(\d+)\s*(h|d|w|m)$/i);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const now = Date.now();

  switch (unit) {
    case 'h': return new Date(now - amount * 60 * 60 * 1000);
    case 'd': return new Date(now - amount * 24 * 60 * 60 * 1000);
    case 'w': return new Date(now - amount * 7 * 24 * 60 * 60 * 1000);
    case 'm': return new Date(now - amount * 30 * 24 * 60 * 60 * 1000);
    default: return null;
  }
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

  const systemPrompt = `You are a project assistant for a community orchestra's Discord server. Analyze the following conversation transcript from the last ${window} across all channels.

Produce a structured digest in this exact format:

## Status & Progress
- What's actively being worked on, by whom, and current state

## Decisions Made
- Any agreements, choices, or conclusions reached

## Action Items & Follow-ups
- Things that need to happen next, who's responsible (if mentioned), and any deadlines

## Notable Discussions
- Important topics that don't fit above but are worth noting

Rules:
- Be concise. Use bullet points.
- If a section has nothing, write "None."
- Reference channel names with # prefix
- Use people's display names as written in the transcript
- Focus on substance, skip greetings and small talk`;

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

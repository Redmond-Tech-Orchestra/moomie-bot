import { ChannelType } from 'discord.js';
import type { TextChannel } from 'discord.js';
import { client } from '../../adapters/discord.js';
import { getDb } from '../../db.js';
import { DISCORD_GUILD_ID } from '../../config.js';
import {
  getAllOpenItems,
  getOpenItemsForEvent,
  getActiveEvents,
  getAllEvents,
  getEventById,
  getItemsForEvent,
  createItem,
  markItemDone,
  updateItemDescription,
  type TrackerItem,
  type TrackerEvent,
} from '../tracker/store.js';
import { addReminder, parseReminder } from '../remind/scheduler.js';
import { executeFeedback } from '../feedback/handle-command.js';
import { syncArchive } from '../eventbrite/sync.js';
import { getLiveSales } from '../eventbrite/live.js';
import { analyze as analyzeEventbrite } from '../eventbrite/analyze.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Chat');

// ─── Tool Definitions (Gemini function calling schema) ───────────────────────

export const toolDeclarations = [
  {
    name: 'query_items',
    description: 'Search tracked action items. Returns open items, optionally filtered by event or keyword.',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'number', description: 'Filter by event ID' },
        keyword: { type: 'string', description: 'Filter items whose description contains this keyword (case-insensitive)' },
        status: { type: 'string', enum: ['open', 'done', 'stale'], description: 'Filter by status. Defaults to open.' },
      },
    },
  },
  {
    name: 'resolve_item',
    description: 'Mark an action item as done/resolved.',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'number', description: 'The ID of the item to resolve' },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'update_item',
    description: 'Update an action item\'s description, owner, or target date.',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'number', description: 'The ID of the item to update' },
        description: { type: 'string', description: 'New description' },
        owner_name: { type: 'string', description: 'New owner display name' },
        owner_id: { type: 'string', description: 'New owner Discord user ID' },
        target_date: { type: 'string', description: 'New target date (YYYY-MM-DD)' },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'create_item',
    description: 'Create a new tracked action item.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What needs to be done' },
        event_id: { type: 'number', description: 'Associated event ID (null if general)' },
        owner_name: { type: 'string', description: 'Who is responsible' },
        owner_id: { type: 'string', description: 'Discord user ID of owner' },
        target_date: { type: 'string', description: 'Deadline (YYYY-MM-DD)' },
      },
      required: ['description'],
    },
  },
  {
    name: 'query_events',
    description: 'List orchestra events/concerts. Returns upcoming events by default.',
    parameters: {
      type: 'object',
      properties: {
        include_past: { type: 'boolean', description: 'Include past events. Default false.' },
      },
    },
  },
  {
    name: 'read_channel_messages',
    description: 'Read recent messages from a Discord channel. Use this to get conversation context.',
    parameters: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The Discord channel ID to read from' },
        limit: { type: 'number', description: 'Max messages to fetch (default 50, max 100)' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'list_channels',
    description: 'List text channels in the server. Use to discover channel names/IDs.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category name (case-insensitive)' },
      },
    },
  },
  {
    name: 'create_reminder',
    description: 'Set a reminder for a user. Parses natural language time expressions.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The reminder message' },
        time: { type: 'string', description: 'When to remind, e.g. "in 2 hours", "tomorrow at 3pm", "next monday"' },
        user_id: { type: 'string', description: 'Discord user ID to remind. Defaults to the requesting user.' },
        channel_id: { type: 'string', description: 'Channel to send reminder in. Defaults to current channel.' },
      },
      required: ['message', 'time'],
    },
  },
  {
    name: 'submit_feedback',
    description: 'Submit feedback about something Moomie did wrong. Use this when a user says Moomie made a mistake, gave a wrong answer, misunderstood something, or needs to be corrected. Moomie will file a GitHub issue and attempt to self-patch. Include the message being corrected if the user is replying to one.',
    parameters: {
      type: 'object',
      properties: {
        feedback: { type: 'string', description: 'What Moomie got wrong, described clearly' },
        referenced_message: { type: 'string', description: 'The Moomie message being corrected, if available' },
      },
      required: ['feedback'],
    },
  },
  {
    name: 'sync_eventbrite_archive',
    description: 'Bring the local Eventbrite archive up to date. Lists all past org events, snapshots any that are missing or within the late-check-in window (24h after event end). Use when asked about past events to ensure data is available, or when the user explicitly asks to sync/refresh archives. Cheap if everything is already frozen. Returns a report of what was added/refreshed/skipped.',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Re-snapshot every past event even if already frozen. Defaults to false.' },
      },
    },
  },
  {
    name: 'get_eventbrite_live_sales',
    description: 'Get current ticket sales for active (non-ended) Eventbrite events. Returns gross, net, attendee count, and per-ticket-class breakdown with remaining capacity. Cached for 60s. Use for questions about how an upcoming concert is selling.',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Eventbrite event ID. Omit to get all active events.' },
      },
    },
  },
  {
    name: 'analyze_eventbrite',
    description: 'Hand off a data-analysis question about the Eventbrite archive to a stronger model that will write and run Python (pandas/numpy) against the archived JSON. Use for questions that require joining/aggregating data across events, computing statistics, comparing campaigns, or anything beyond a simple lookup. Make sure the archive is up to date first via sync_eventbrite_archive. Returns the final answer plus the code that was run.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The analytical question, in plain English.' },
        context: { type: 'string', description: 'Optional extra context from the conversation that the analyst should know (e.g. specific event IDs or filters the user mentioned).' },
      },
      required: ['question'],
    },
  },
];

// ─── Tool Execution ──────────────────────────────────────────────────────────

interface ToolCallContext {
  userId: string;
  channelId: string;
  userName: string;
}

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
  switch (name) {
    case 'query_items': return queryItems(args);
    case 'resolve_item': return resolveItem(args, ctx);
    case 'update_item': return updateItem(args, ctx);
    case 'create_item': return createItemTool(args, ctx);
    case 'query_events': return queryEvents(args);
    case 'read_channel_messages': return readChannelMessages(args);
    case 'list_channels': return listChannels(args);
    case 'create_reminder': return createReminderTool(args, ctx);
    case 'submit_feedback': return submitFeedbackTool(args, ctx);
    case 'sync_eventbrite_archive': return syncEventbriteArchiveTool(args);
    case 'get_eventbrite_live_sales': return getEventbriteLiveSalesTool(args);
    case 'analyze_eventbrite': return analyzeEventbriteTool(args);
    default: return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ─── Tool Implementations ────────────────────────────────────────────────────

function queryItems(args: Record<string, unknown>): string {
  const eventId = args.event_id as number | undefined;
  const keyword = args.keyword as string | undefined;
  const status = (args.status as string) || 'open';

  let items: TrackerItem[];
  if (eventId) {
    items = status === 'open' ? getOpenItemsForEvent(eventId) : getItemsForEvent(eventId);
  } else {
    items = getAllOpenItems();
    if (status !== 'open') {
      items = getDb()
        .prepare(`SELECT * FROM items WHERE status = ? ORDER BY event_id, created_at`)
        .all(status) as TrackerItem[];
    }
  }

  if (keyword) {
    const lower = keyword.toLowerCase();
    items = items.filter((i) => i.description.toLowerCase().includes(lower));
  }

  if (items.length === 0) return JSON.stringify({ items: [], message: 'No items found.' });

  return JSON.stringify({
    items: items.map((i) => ({
      id: i.id,
      description: i.description,
      owner: i.owner_name,
      status: i.status,
      event_id: i.event_id,
      target_date: i.target_date,
    })),
  });
}

function resolveItem(args: Record<string, unknown>, ctx: ToolCallContext): string {
  const id = args.item_id as number;
  if (!id) return JSON.stringify({ error: 'item_id is required' });

  markItemDone(id);
  return JSON.stringify({ success: true, message: `Item #${id} marked as done.` });
}

function updateItem(args: Record<string, unknown>, ctx: ToolCallContext): string {
  const id = args.item_id as number;
  if (!id) return JSON.stringify({ error: 'item_id is required' });

  const db = getDb();

  if (args.description) {
    updateItemDescription(id, args.description as string);
  }
  if (args.owner_name !== undefined || args.owner_id !== undefined) {
    db.prepare(`UPDATE items SET owner_name = COALESCE(?, owner_name), owner_id = COALESCE(?, owner_id) WHERE id = ?`)
      .run(args.owner_name ?? null, args.owner_id ?? null, id);
  }
  if (args.target_date !== undefined) {
    db.prepare(`UPDATE items SET target_date = ? WHERE id = ?`)
      .run(args.target_date, id);
  }

  return JSON.stringify({ success: true, message: `Item #${id} updated.` });
}

function createItemTool(args: Record<string, unknown>, ctx: ToolCallContext): string {
  const description = args.description as string;
  if (!description) return JSON.stringify({ error: 'description is required' });

  const id = createItem({
    event_id: (args.event_id as number) ?? null,
    description,
    owner_id: (args.owner_id as string) ?? undefined,
    owner_name: (args.owner_name as string) ?? undefined,
    target_date: (args.target_date as string) ?? undefined,
    source: `chat:${ctx.userName}`,
    source_channel: ctx.channelId,
    source_date: new Date().toISOString().split('T')[0],
  });

  return JSON.stringify({ success: true, item_id: id, message: `Created item #${id}: "${description}"` });
}

function queryEvents(args: Record<string, unknown>): string {
  const includePast = args.include_past as boolean;
  const events = includePast ? getAllEvents() : getActiveEvents();

  if (events.length === 0) return JSON.stringify({ events: [], message: 'No upcoming events.' });

  return JSON.stringify({
    events: events.map((e) => ({
      id: e.id,
      name: e.name,
      date: e.date,
      end_date: e.end_date,
      channel_name: e.channel_name,
    })),
  });
}

async function readChannelMessages(args: Record<string, unknown>): Promise<string> {
  const channelId = args.channel_id as string;
  const limit = Math.min((args.limit as number) || 50, 100);

  const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
  if (!guild) return JSON.stringify({ error: 'Guild not found' });

  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    return JSON.stringify({ error: 'Channel not found or not a text channel' });
  }

  const messages = await (channel as TextChannel).messages.fetch({ limit });
  const formatted = [...messages.values()]
    .reverse()
    .filter((m) => !m.author.bot)
    .map((m) => ({
      author: m.member?.displayName ?? m.author.displayName ?? m.author.username,
      content: m.content || (m.attachments.size > 0 ? '[attachment]' : '[embed]'),
      timestamp: m.createdAt.toISOString(),
    }));

  return JSON.stringify({ channel: (channel as TextChannel).name, messages: formatted });
}

function listChannels(args: Record<string, unknown>): string {
  const categoryFilter = (args.category as string)?.toLowerCase();

  const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
  if (!guild) return JSON.stringify({ error: 'Guild not found' });

  const channels = guild.channels.cache
    .filter((ch) => ch.type === ChannelType.GuildText)
    .map((ch) => {
      const tc = ch as TextChannel;
      return {
        id: tc.id,
        name: tc.name,
        category: tc.parent?.name ?? null,
      };
    })
    .filter((ch) => !categoryFilter || ch.category?.toLowerCase().includes(categoryFilter));

  return JSON.stringify({ channels });
}

function createReminderTool(args: Record<string, unknown>, ctx: ToolCallContext): string {
  const message = args.message as string;
  const time = args.time as string;
  if (!message || !time) return JSON.stringify({ error: 'message and time are required' });

  const parsed = parseReminder(`${time} ${message}`);
  if (!parsed) {
    return JSON.stringify({ error: `Could not parse time from: "${time}"` });
  }

  addReminder({
    userId: (args.user_id as string) || ctx.userId,
    channelId: (args.channel_id as string) || ctx.channelId,
    platform: 'discord',
    message: parsed.message || message,
    triggerAt: parsed.date.getTime(),
  });

  return JSON.stringify({
    success: true,
    message: `Reminder set for ${parsed.date.toISOString()}: "${message}"`,
  });
}

async function submitFeedbackTool(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
  const feedback = args.feedback as string;
  if (!feedback) return JSON.stringify({ error: 'feedback is required' });

  const referencedMessage = args.referenced_message as string | undefined;

  try {
    const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
    const channel = guild?.channels.cache.get(ctx.channelId);
    const channelName = (channel && 'name' in channel) ? (channel as TextChannel).name : ctx.channelId;

    const issueUrl = await executeFeedback({
      feedback,
      channelId: ctx.channelId,
      channelName,
      userId: ctx.userId,
      userName: ctx.userName,
      platform: 'discord',
      referencedMessage,
    });

    return JSON.stringify({
      success: true,
      issue_url: issueUrl,
      message: `Feedback filed and self-investigation started. Issue: ${issueUrl}`,
    });
  } catch (err) {
    log.error('Feedback tool call failed:', err);
    return JSON.stringify({ error: 'Failed to submit feedback. Try /feedback instead.' });
  }
}

async function syncEventbriteArchiveTool(args: Record<string, unknown>): Promise<string> {
  try {
    const report = await syncArchive({ force: args.force as boolean | undefined });
    return JSON.stringify(report);
  } catch (err) {
    log.error('sync_eventbrite_archive failed:', err);
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function getEventbriteLiveSalesTool(args: Record<string, unknown>): Promise<string> {
  try {
    const results = await getLiveSales(args.event_id as string | undefined);
    return JSON.stringify({ events: results });
  } catch (err) {
    log.error('get_eventbrite_live_sales failed:', err);
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function analyzeEventbriteTool(args: Record<string, unknown>): Promise<string> {
  const question = args.question as string;
  if (!question) return JSON.stringify({ error: 'question is required' });
  const context = args.context as string | undefined;
  try {
    const result = await analyzeEventbrite(question, context);
    return JSON.stringify({
      answer: result.answer,
      summary: result.summary,
      iterations_used: result.iterations_used,
      total_duration_ms: result.total_duration_ms,
      // Surface the code that ran so the chat LLM (and audit log) can see exactly what was executed.
      transcript: result.transcript.map((t) => ({
        iteration: t.iteration,
        reason: t.reason,
        code: t.code,
        exit_code: t.exit_code,
        // Keep stdout/stderr in the response so the chat LLM can reason about evidence, capped via runner's maxBytes.
        stdout: t.stdout,
        stderr: t.stderr,
        duration_ms: t.duration_ms,
        timed_out: t.timed_out,
      })),
      error: result.error,
    });
  } catch (err) {
    log.error('analyze_eventbrite failed:', err);
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

import { ChannelType } from 'discord.js';
import type { Guild, GuildMember, TextChannel } from 'discord.js';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
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
  getOwnersForItemIds,
  setItemOwners,
  type TrackerItem,
} from '../tracker/store.js';
import { addReminder, parseReminder } from '../remind/scheduler.js';
import { executeFeedback } from '../feedback/handle-command.js';
import { syncArchive } from '../eventbrite/sync.js';
import { getLiveSales } from '../eventbrite/live.js';
import { analyze as analyzeEventbrite } from '../eventbrite/analyze.js';
import { executeWebsiteUpdate } from '../website/handle-command.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Chat');

// ─── Tool Definitions (JSON Schema for descriptions/params) ──────────────────

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
    description: 'Create a new tracked action item. Only description is required; owner and event fields are optional.',
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
    name: 'ingest_items',
    description: 'Bulk import pasted action items. Resolves owner names to Discord IDs from the configured guild, dedupes against open items, validates event IDs, and returns a partial-success report.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Parsed action items from the pasted list.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Action item text without trailing owner parentheses.' },
              owner_names: { type: 'array', items: { type: 'string' }, description: 'Owner display names parsed from parentheses or text.' },
              owners: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    id: { type: 'string' },
                  },
                },
              },
              event_id: { type: 'number', description: 'Optional existing board event ID. Leave unset for org-wide items.' },
              target_date: { type: 'string', description: 'Optional deadline (YYYY-MM-DD).' },
            },
            required: ['description'],
          },
        },
        dedupe: { type: 'boolean', description: 'Whether to check open items for likely duplicates. Defaults to true.' },
        update_duplicates: { type: 'boolean', description: 'Whether likely duplicates should be updated with provided owner/target fields. Defaults to false.' },
      },
      required: ['items'],
    },
  },
  {
    name: 'lookup_guild_members',
    description: 'Look up Discord guild members by user ID or display/username. Works from DMs by using the configured orchestra guild ID.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Exact Discord user ID to fetch.' },
        query: { type: 'string', description: 'Display name, nickname, or username search text.' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 20).' },
      },
    },
  },
  {
    name: 'query_events',
    description: 'List orchestra board/calendar events (rehearsals, sectionals, social events tracked on the Discord event board). NOT for Eventbrite ticketed concerts — for those use analyze_eventbrite, get_eventbrite_live_sales, or sync_eventbrite_archive.',
    parameters: {
      type: 'object',
      properties: {
        include_past: { type: 'boolean', description: 'Include past events. Default false.' },
      },
    },
  },
  {
    name: 'read_channel_messages',
    description: 'Read recent messages from a Discord channel. Use only when you need quoted conversation history you do not already have in the current message thread. Do NOT call this just to gather generic context — the current user message plus the system prompt are usually sufficient.',
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
    name: 'request_website_update',
    description: 'Request a change or update to the orchestra website. Use this for adding content, fixing typos, updating concert descriptions, or any other website-related task. Moomie will create a GitHub issue and start working on it automatically.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Clear description of the website change needed.' },
      },
      required: ['task'],
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
    description: 'Hand off a data-analysis question about Eventbrite data to a stronger model that will write and run Python (pandas/numpy) against archived JSON plus freshly captured read-only snapshots of active events. Use for: per-ticket-class breakdowns, affiliate/source analysis, registration pace by day, check-in / no-show rates, registration vs attendance comparisons, refund rates, revenue trends, growth over time, multi-event aggregates, ranking events by any metric, or anything beyond a one-shot lookup. Prefer this over scrolling Discord channels when the question is about concerts, tickets, attendees, sources, affiliates, or sales. Use sync_eventbrite_archive first when asking about past events that may not be archived yet. Returns the final answer plus the code that was run.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The analytical question, in plain English.' },
        context: { type: 'string', description: 'Optional extra context from the conversation that the analyst should know (e.g. specific event IDs or filters the user mentioned).' },
        playbook: { type: 'string', enum: ['sales_health_check', 'traffic_conversion_analysis', 'source_gap_analysis', 'capacity_projection', 'weekday_venue_hypothesis_analysis'], description: 'Optional analysis playbook to steer common Eventbrite analyses.' },
      },
      required: ['question'],
    },
  },
];

// ─── Tool Execution ──────────────────────────────────────────────────────────

/** Binary attachment a tool wants to surface back through the chat reply. */
export interface ChatFile {
  name: string;
  data: Buffer;
  description?: string;
}

interface ToolCallContext {
  userId: string;
  channelId: string;
  userName: string;
  /** Mutable per-request collector; tools push attachments here. */
  files: ChatFile[];
}

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
  switch (name) {
    case 'query_items': return queryItems(args);
    case 'resolve_item': return resolveItem(args, ctx);
    case 'update_item': return updateItem(args, ctx);
    case 'create_item': return createItemTool(args, ctx);
    case 'ingest_items': return ingestItemsTool(args, ctx);
    case 'lookup_guild_members': return lookupGuildMembersTool(args);
    case 'query_events': return queryEvents(args);
    case 'read_channel_messages': return readChannelMessages(args);
    case 'list_channels': return listChannels(args);
    case 'create_reminder': return createReminderTool(args, ctx);
    case 'request_website_update': return requestWebsiteUpdateTool(args, ctx);
    case 'submit_feedback': return submitFeedbackTool(args, ctx);
    case 'sync_eventbrite_archive': return syncEventbriteArchiveTool(args);
    case 'get_eventbrite_live_sales': return getEventbriteLiveSalesTool(args);
    case 'analyze_eventbrite': return analyzeEventbriteTool(args, ctx);
    default: return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ─── AI SDK Tool Adapters ────────────────────────────────────────────────────
// Zod input schemas mirroring the tool declarations above. Each tool
// delegates to executeTool() so the provider-agnostic AI SDK loop can drive the
// same implementations.

const toolSchemas: Record<string, z.ZodTypeAny> = {
  query_items: z.object({
    event_id: z.number().optional().describe('Filter by event ID'),
    keyword: z.string().optional().describe('Filter items whose description contains this keyword (case-insensitive)'),
    status: z.enum(['open', 'done', 'stale']).optional().describe('Filter by status. Defaults to open.'),
  }),
  resolve_item: z.object({
    item_id: z.number().describe('The ID of the item to resolve'),
  }),
  update_item: z.object({
    item_id: z.number().describe('The ID of the item to update'),
    description: z.string().optional().describe('New description'),
    owner_name: z.string().optional().describe('New owner display name'),
    owner_id: z.string().optional().describe('New owner Discord user ID'),
    target_date: z.string().optional().describe('New target date (YYYY-MM-DD)'),
  }),
  create_item: z.object({
    description: z.string().describe('What needs to be done'),
    event_id: z.number().optional().describe('Associated event ID (null if general)'),
    owner_name: z.string().optional().describe('Who is responsible'),
    owner_id: z.string().optional().describe('Discord user ID of owner'),
    target_date: z.string().optional().describe('Deadline (YYYY-MM-DD)'),
  }),
  ingest_items: z.object({
    items: z.array(z.object({
      description: z.string().describe('Action item text without trailing owner parentheses'),
      owner_names: z.array(z.string()).optional().describe('Owner display names parsed from parentheses or text'),
      owners: z.array(z.object({
        name: z.string().optional(),
        id: z.string().optional(),
      })).optional().describe('Owner names and/or Discord IDs'),
      event_id: z.number().optional().describe('Optional existing board event ID. Leave unset for org-wide items.'),
      target_date: z.string().optional().describe('Optional deadline (YYYY-MM-DD)'),
    })).max(50).describe('Parsed action items from the pasted list'),
    dedupe: z.boolean().optional().describe('Whether to check open items for likely duplicates. Defaults to true.'),
    update_duplicates: z.boolean().optional().describe('Whether likely duplicates should be updated with provided owner/target fields. Defaults to false.'),
  }),
  lookup_guild_members: z.object({
    user_id: z.string().optional().describe('Exact Discord user ID to fetch'),
    query: z.string().optional().describe('Display name, nickname, or username search text'),
    limit: z.number().optional().describe('Maximum matches to return (default 10, max 20)'),
  }),
  query_events: z.object({
    include_past: z.boolean().optional().describe('Include past events. Default false.'),
  }),
  read_channel_messages: z.object({
    channel_id: z.string().describe('The Discord channel ID to read from'),
    limit: z.number().optional().describe('Max messages to fetch (default 50, max 100)'),
  }),
  list_channels: z.object({
    category: z.string().optional().describe('Filter by category name (case-insensitive)'),
  }),
  create_reminder: z.object({
    message: z.string().describe('The reminder message'),
    time: z.string().describe('When to remind, e.g. "in 2 hours", "tomorrow at 3pm", "next monday"'),
    user_id: z.string().optional().describe('Discord user ID to remind. Defaults to the requesting user.'),
    channel_id: z.string().optional().describe('Channel to send reminder in. Defaults to current channel.'),
  }),
  request_website_update: z.object({
    task: z.string().describe('Clear description of the website change needed.'),
  }),
  submit_feedback: z.object({
    feedback: z.string().describe('What Moomie got wrong, described clearly'),
    referenced_message: z.string().optional().describe('The Moomie message being corrected, if available'),
  }),
  sync_eventbrite_archive: z.object({
    force: z.boolean().optional().describe('Re-snapshot every past event even if already frozen. Defaults to false.'),
  }),
  get_eventbrite_live_sales: z.object({
    event_id: z.string().optional().describe('Eventbrite event ID. Omit to get all active events.'),
  }),
  analyze_eventbrite: z.object({
    question: z.string().describe('The analytical question, in plain English.'),
    context: z.string().optional().describe('Optional extra context from the conversation that the analyst should know (e.g. specific event IDs or filters the user mentioned).'),
    playbook: z.enum(['sales_health_check', 'traffic_conversion_analysis', 'source_gap_analysis', 'capacity_projection', 'weekday_venue_hypothesis_analysis']).optional().describe('Optional analysis playbook to steer common Eventbrite analyses.'),
  }),
};

const INGEST_SUMMARY_ITEM_LIMIT = 8;

/**
 * Build the AI SDK tool set for one chat turn, bound to a request-scoped
 * context. Descriptions are reused from `toolDeclarations`; execution delegates
 * to `executeTool`.
 */
export function buildChatTools(ctx: ToolCallContext): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const decl of toolDeclarations) {
    tools[decl.name] = tool({
      description: decl.description,
      inputSchema: toolSchemas[decl.name] as z.ZodType<Record<string, unknown>>,
      execute: async (args) => executeTool(decl.name, args, ctx),
    });
  }
  return tools;
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

  const ownersByItem = getOwnersForItemIds(items.map((item) => item.id));

  return JSON.stringify({
    items: items.map((i) => ({
      id: i.id,
      description: i.description,
      owner: i.owner_name,
      owner_id: i.owner_id,
      owners: ownersByItem.get(i.id)?.map((owner) => ({
        name: owner.owner_name,
        id: owner.owner_id,
      })) ?? [],
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
    if (args.owner_name) {
      setItemOwners(id, [{ owner_name: args.owner_name as string, owner_id: (args.owner_id as string | undefined) ?? null }]);
    }
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

  const eventId = args.event_id as number | undefined;
  if (eventId !== undefined && !getEventById(eventId)) {
    return JSON.stringify({ error: `event_id ${eventId} does not exist. Omit event_id for a general item or call query_events first.` });
  }

  const id = createItem({
    event_id: eventId ?? null,
    description,
    owner_id: (args.owner_id as string) ?? undefined,
    owner_name: (args.owner_name as string) ?? undefined,
    target_date: (args.target_date as string) ?? undefined,
    source: `chat:${ctx.userName}`,
    source_channel: ctx.channelId,
    source_date: new Date().toISOString().split('T')[0],
  });

  if (args.owner_name) {
    setItemOwners(id, [{ owner_name: args.owner_name as string, owner_id: (args.owner_id as string | undefined) ?? null }]);
  }

  return JSON.stringify({ success: true, item_id: id, message: `Created item #${id}: "${description}"` });
}

interface OwnerInput {
  name?: string;
  id?: string;
}

interface ResolvedOwner {
  owner_name: string;
  owner_id: string | null;
  status: 'matched' | 'provided' | 'ambiguous' | 'unmatched';
  candidates?: MemberSummary[];
}

interface IngestInputItem {
  description: string;
  owner_names?: string[];
  owners?: OwnerInput[];
  event_id?: number;
  target_date?: string;
}

interface MemberSummary {
  id: string;
  display_name: string;
  username: string;
  global_name: string | null;
}

async function ingestItemsTool(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
  const items = (args.items as IngestInputItem[] | undefined) ?? [];
  if (items.length === 0) return JSON.stringify({ error: 'items is required' });

  const dedupe = args.dedupe !== false;
  const updateDuplicates = args.update_duplicates === true;
  const existing = getAllOpenItems();
  const db = getDb();

  const report = {
    created: [] as Array<{ item_id: number; description: string; owners: ResolvedOwner[]; event_id: number | null }>,
    updated_duplicates: [] as Array<{ item_id: number; description: string; matched_description: string; score: number; owners: ResolvedOwner[] }>,
    skipped_duplicates: [] as Array<{ item_id: number; description: string; matched_description: string; score: number }>,
    failed: [] as Array<{ description: string; error: string }>,
    warnings: [] as string[],
  };

  for (const item of items) {
    const description = item.description?.trim();
    if (!description) {
      report.failed.push({ description: '', error: 'description is required' });
      continue;
    }

    let eventId = item.event_id ?? null;
    if (eventId !== null && !getEventById(eventId)) {
      report.warnings.push(`Item "${description.slice(0, 80)}" used unknown event_id ${eventId}; created/updated as org-wide instead.`);
      eventId = null;
    }

    try {
      const owners = await resolveOwners(item);
      const ownerRows = owners.map((owner) => ({ owner_name: owner.owner_name, owner_id: owner.owner_id }));
      const match = dedupe ? findBestDuplicate(description, eventId, existing) : null;

      if (match && updateDuplicates) {
        if (item.target_date) {
          db.prepare(`UPDATE items SET target_date = COALESCE(target_date, ?) WHERE id = ?`).run(item.target_date, match.item.id);
        }
        if (ownerRows.length > 0) {
          setItemOwners(match.item.id, ownerRows);
        }
        report.updated_duplicates.push({
          item_id: match.item.id,
          description,
          matched_description: match.item.description,
          score: Number(match.score.toFixed(2)),
          owners,
        });
        continue;
      }

      if (match) {
        report.skipped_duplicates.push({
          item_id: match.item.id,
          description,
          matched_description: match.item.description,
          score: Number(match.score.toFixed(2)),
        });
        continue;
      }

      const firstOwner = ownerRows[0];
      const itemId = createItem({
        event_id: eventId,
        description,
        owner_id: firstOwner?.owner_id ?? undefined,
        owner_name: ownerRows.map((owner) => owner.owner_name).join(', ') || undefined,
        target_date: item.target_date,
        source: `chat:${ctx.userName}:bulk`,
        source_channel: ctx.channelId,
        source_date: new Date().toISOString().split('T')[0],
      });
      if (ownerRows.length > 0) setItemOwners(itemId, ownerRows);

      existing.push({
        id: itemId,
        event_id: eventId,
        description,
        owner_id: firstOwner?.owner_id ?? null,
        owner_name: ownerRows.map((owner) => owner.owner_name).join(', ') || null,
        status: 'open',
        target_date: item.target_date ?? null,
        source: `chat:${ctx.userName}:bulk`,
        source_channel: ctx.channelId,
        source_date: new Date().toISOString().split('T')[0],
        last_mentioned: null,
        created_at: new Date().toISOString(),
      });

      report.created.push({ item_id: itemId, description, owners, event_id: eventId });
    } catch (err) {
      report.failed.push({ description, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return JSON.stringify({
    success: report.failed.length === 0,
    counts: {
      created: report.created.length,
      updated_duplicates: report.updated_duplicates.length,
      skipped_duplicates: report.skipped_duplicates.length,
      failed: report.failed.length,
      warnings: report.warnings.length,
    },
    summary: formatIngestSummary(report),
    ...report,
  });
}

function formatIngestSummary(report: {
  created: Array<{ item_id: number; description: string; owners: ResolvedOwner[] }>;
  updated_duplicates: Array<{ item_id: number; description: string; matched_description: string; score: number; owners: ResolvedOwner[] }>;
  skipped_duplicates: Array<{ item_id: number; description: string; matched_description: string; score: number }>;
  failed: Array<{ description: string; error: string }>;
  warnings: string[];
}): string {
  const lines = [
    `Batch import: ${report.created.length} created, ${report.updated_duplicates.length} updated, ${report.skipped_duplicates.length} skipped as duplicates, ${report.failed.length} failed.`,
  ];

  if (report.created.length > 0) {
    lines.push('', '**Created:**');
    for (const item of report.created.slice(0, INGEST_SUMMARY_ITEM_LIMIT)) {
      lines.push(`- #${item.item_id}: ${item.description}${formatOwnerSummary(item.owners)}`);
    }
    appendRemainder(lines, report.created.length, INGEST_SUMMARY_ITEM_LIMIT, 'created item');
  }

  if (report.updated_duplicates.length > 0) {
    lines.push('', '**Updated existing:**');
    for (const item of report.updated_duplicates.slice(0, INGEST_SUMMARY_ITEM_LIMIT)) {
      lines.push(`- #${item.item_id}: ${item.description}${formatOwnerSummary(item.owners)} (matched existing: ${item.matched_description})`);
    }
    appendRemainder(lines, report.updated_duplicates.length, INGEST_SUMMARY_ITEM_LIMIT, 'updated item');
  }

  if (report.skipped_duplicates.length > 0) {
    lines.push('', '**Skipped likely duplicates:**');
    for (const item of report.skipped_duplicates.slice(0, INGEST_SUMMARY_ITEM_LIMIT)) {
      lines.push(`- ${item.description} (matched #${item.item_id}: ${item.matched_description})`);
    }
    appendRemainder(lines, report.skipped_duplicates.length, INGEST_SUMMARY_ITEM_LIMIT, 'skipped duplicate');
  }

  if (report.failed.length > 0) {
    lines.push('', '**Failed:**');
    for (const item of report.failed.slice(0, INGEST_SUMMARY_ITEM_LIMIT)) {
      lines.push(`- ${item.description || '(blank item)'}: ${item.error}`);
    }
    appendRemainder(lines, report.failed.length, INGEST_SUMMARY_ITEM_LIMIT, 'failed item');
  }

  if (report.warnings.length > 0) {
    lines.push('', '**Warnings:**');
    for (const warning of report.warnings.slice(0, INGEST_SUMMARY_ITEM_LIMIT)) lines.push(`- ${warning}`);
    appendRemainder(lines, report.warnings.length, INGEST_SUMMARY_ITEM_LIMIT, 'warning');
  }

  const unresolvedOwners = [
    ...report.created.flatMap((item) => item.owners),
    ...report.updated_duplicates.flatMap((item) => item.owners),
  ].filter((owner) => owner.status === 'ambiguous' || owner.status === 'unmatched');
  if (unresolvedOwners.length > 0) {
    lines.push('', '**Owner follow-up:**');
    for (const owner of unresolvedOwners.slice(0, INGEST_SUMMARY_ITEM_LIMIT)) {
      const candidates = owner.candidates?.map((candidate) => `${candidate.display_name} (${candidate.id})`).join(', ');
      lines.push(`- ${owner.owner_name}: ${owner.status}${candidates ? `; candidates: ${candidates}` : ''}`);
    }
    appendRemainder(lines, unresolvedOwners.length, INGEST_SUMMARY_ITEM_LIMIT, 'owner needing follow-up');
  }

  return lines.join('\n');
}

function formatOwnerSummary(owners: ResolvedOwner[]): string {
  if (owners.length === 0) return '';
  const names = owners.map((owner) => owner.owner_id ? `${owner.owner_name} <@${owner.owner_id}>` : owner.owner_name);
  return ` — owners: ${names.join(', ')}`;
}

function appendRemainder(lines: string[], total: number, limit: number, label: string): void {
  const remaining = total - limit;
  if (remaining > 0) lines.push(`- ...and ${remaining} more ${label}${remaining === 1 ? '' : 's'}.`);
}

async function resolveOwners(item: IngestInputItem): Promise<ResolvedOwner[]> {
  const inputs: OwnerInput[] = [
    ...(item.owners ?? []),
    ...((item.owner_names ?? []).map((name) => ({ name }))),
  ];

  const seen = new Set<string>();
  const owners: ResolvedOwner[] = [];

  for (const input of inputs) {
    const resolved = await resolveOwner(input);
    const key = (resolved.owner_id ?? resolved.owner_name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    owners.push(resolved);
  }

  return owners;
}

async function resolveOwner(input: OwnerInput): Promise<ResolvedOwner> {
  const id = input.id?.trim();
  const name = input.name?.trim();

  if (id) {
    const member = await fetchMemberById(id);
    if (member) {
      return { owner_id: member.id, owner_name: member.display_name, status: 'matched' };
    }
    return { owner_id: id, owner_name: name || id, status: 'provided' };
  }

  if (!name) return { owner_id: null, owner_name: 'Unknown', status: 'unmatched' };

  const matches = await searchGuildMembers(name, 5);
  const lower = name.toLowerCase();
  const exact = matches.filter((member) =>
    [member.display_name, member.username, member.global_name].some((candidate) => candidate?.toLowerCase() === lower)
  );
  const usable = exact.length > 0 ? exact : matches;

  if (usable.length === 1) {
    return { owner_id: usable[0].id, owner_name: usable[0].display_name, status: 'matched' };
  }

  if (usable.length > 1) {
    return { owner_id: null, owner_name: name, status: 'ambiguous', candidates: usable };
  }

  return { owner_id: null, owner_name: name, status: 'unmatched' };
}

function findBestDuplicate(description: string, eventId: number | null, items: TrackerItem[]): { item: TrackerItem; score: number } | null {
  let best: { item: TrackerItem; score: number } | null = null;
  for (const item of items) {
    if ((item.event_id ?? null) !== eventId) continue;
    const score = itemSimilarity(description, item.description);
    if (!best || score > best.score) best = { item, score };
  }
  return best && best.score >= 0.82 ? best : null;
}

function itemSimilarity(a: string, b: string): number {
  const aNorm = normalizeItemText(a);
  const bNorm = normalizeItemText(b);
  if (aNorm === bNorm) return 1;
  if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) return 0.9;

  const aTokens = new Set(aNorm.split(' ').filter(Boolean));
  const bTokens = new Set(bNorm.split(' ').filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return intersection / union;
}

function normalizeItemText(text: string): string {
  const stopWords = new Set(['a', 'an', 'and', 'for', 'if', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !stopWords.has(token))
    .join(' ');
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

async function lookupGuildMembersTool(args: Record<string, unknown>): Promise<string> {
  const userId = (args.user_id as string | undefined)?.trim();
  const query = (args.query as string | undefined)?.trim();
  const limit = Math.min(Math.max((args.limit as number | undefined) ?? 10, 1), 20);

  if (!userId && !query) return JSON.stringify({ error: 'user_id or query is required' });

  try {
    const guild = await getConfiguredGuild();
    if (!guild) return JSON.stringify({ error: `Configured guild ${DISCORD_GUILD_ID} is unavailable.` });

    if (userId) {
      const member = await fetchMemberById(userId, guild);
      return JSON.stringify({ members: member ? [member] : [] });
    }

    return JSON.stringify({ members: await searchGuildMembers(query!, limit, guild) });
  } catch (err) {
    log.error('lookup_guild_members failed:', err);
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function getConfiguredGuild(): Promise<Guild | null> {
  return client.guilds.cache.get(DISCORD_GUILD_ID) ?? await client.guilds.fetch(DISCORD_GUILD_ID).catch(() => null);
}

async function fetchMemberById(userId: string, guild?: Guild): Promise<MemberSummary | null> {
  guild ??= await getConfiguredGuild() ?? undefined;
  if (!guild) return null;
  const member = await guild.members.fetch(userId).catch(() => null);
  return member ? summarizeMember(member) : null;
}

async function searchGuildMembers(query: string, limit: number, guild?: Guild): Promise<MemberSummary[]> {
  guild ??= await getConfiguredGuild() ?? undefined;
  if (!guild) return [];

  const found = new Map<string, GuildMember>();
  const fetched = await guild.members.fetch({ query, limit }).catch(() => null);
  fetched?.forEach((member) => found.set(member.id, member));

  const lower = query.toLowerCase();
  guild.members.cache
    .filter((member) => [member.displayName, member.user.username, member.user.globalName]
      .some((candidate) => candidate?.toLowerCase().includes(lower)))
    .first(limit)
    .forEach((member) => found.set(member.id, member));

  return [...found.values()].slice(0, limit).map(summarizeMember);
}

function summarizeMember(member: GuildMember): MemberSummary {
  return {
    id: member.id,
    display_name: member.displayName,
    username: member.user.username,
    global_name: member.user.globalName,
  };
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

async function analyzeEventbriteTool(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
  const question = args.question as string;
  if (!question) return JSON.stringify({ error: 'question is required' });
  const context = args.context as string | undefined;
  const playbook = args.playbook as string | undefined;
  try {
    const result = await analyzeEventbrite(question, context, playbook);
    // Surface any artifacts (CSV exports, chart PNGs) up to the chat layer so
    // they get attached to the Discord reply.
    const filesProduced: string[] = [];
    for (const f of result.files ?? []) {
      ctx.files.push({ name: f.name, data: f.data });
      filesProduced.push(f.name);
    }
    return JSON.stringify({
      answer: result.answer,
      summary: result.summary,
      iterations_used: result.iterations_used,
      total_duration_ms: result.total_duration_ms,
      files_attached: filesProduced.length ? filesProduced : undefined,
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
        files_produced: t.files_produced,
      })),
      error: result.error,
    });
  } catch (err) {
    log.error('analyze_eventbrite failed:', err);
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function requestWebsiteUpdateTool(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
  const task = args.task as string;
  if (!task) return JSON.stringify({ error: 'task is required' });

  try {
    const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
    const channel = guild?.channels.cache.get(ctx.channelId);

    const startThread = async (title: string) => {
      if (channel?.type === ChannelType.GuildText) {
        const thread = await (channel as TextChannel).threads.create({
          name: title.slice(0, 100),
          autoArchiveDuration: 1440,
        });
        return thread.id;
      }
      return undefined;
    };

    const { issueUrl, threadId } = await (executeWebsiteUpdate as any)({
      task,
      platform: 'discord',
      userId: ctx.userId,
      userName: ctx.userName,
      channelId: ctx.channelId,
      startThread,
    });

    return JSON.stringify({
      success: true,
      issue_url: issueUrl,
      thread_id: threadId,
      message: `Website update requested. Issue: ${issueUrl}${threadId ? ` (Thread: <#${threadId}>)` : ''}`,
    });
  } catch (err) {
    log.error('request_website_update failed:', err);
    return JSON.stringify({ error: 'Failed to request website update.' });
  }
}

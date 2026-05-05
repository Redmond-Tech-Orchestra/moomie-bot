import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  getActiveEvents,
  getAllEvents,
  getOpenItemsForEvent,
  getAllOpenItems,
  getStaleItems,
  getOrphanItems,
  getItemsForEvent,
} from '../tracker/store.js';
import {
  getRecentAudit,
  getAuditStats,
} from './audit-store.js';

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'moomie-observer',
    version: '1.0.0',
  });

  // ─── Tools ───────────────────────────────────────────────────────────────

  server.registerTool('get_events', {
    description: 'List all events. Use active_only=true (default) for upcoming events, or false for all.',
    inputSchema: {
      active_only: z.boolean().default(true).describe('Only show upcoming non-archived events'),
    },
  }, async ({ active_only }) => {
    const events = active_only ? getActiveEvents() : getAllEvents();
    return {
      content: [{ type: 'text', text: JSON.stringify(events, null, 2) }],
    };
  });

  server.registerTool('query_items', {
    description: 'Query tracked items. Filter by event_id, status, or get stale/orphan items.',
    inputSchema: {
      event_id: z.number().optional().describe('Filter by event ID'),
      status: z.enum(['open', 'done', 'stale', 'all']).default('open').describe('Item status filter'),
      stale_days: z.number().optional().describe('If set, return items not mentioned in this many days'),
      orphans_only: z.boolean().default(false).describe('Only show items without an event'),
    },
  }, async ({ event_id, status, stale_days, orphans_only }) => {
    let items;
    if (orphans_only) {
      items = getOrphanItems();
    } else if (stale_days) {
      items = getStaleItems(stale_days);
    } else if (event_id) {
      items = status === 'all' ? getItemsForEvent(event_id) : getOpenItemsForEvent(event_id);
    } else {
      items = getAllOpenItems();
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
    };
  });

  server.registerTool('query_audit_log', {
    description: 'Query the audit log of LLM calls (extraction, dedup, chat). Returns recent entries.',
    inputSchema: {
      hours: z.number().default(24).describe('How many hours back to look'),
      type: z.enum(['extraction', 'dedup', 'chat']).optional().describe('Filter by audit type'),
    },
  }, async ({ hours, type }) => {
    const entries = getRecentAudit(hours, type);
    return {
      content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
    };
  });

  server.registerTool('get_stats', {
    description: 'Get aggregate statistics: LLM call counts, token usage, broken down by type and model.',
    inputSchema: {
      days: z.number().default(7).describe('How many days back to aggregate'),
    },
  }, async ({ days }) => {
    const stats = getAuditStats(days);
    return {
      content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
    };
  });

  return server;
}

/**
 * Mount MCP Streamable HTTP endpoint on an existing Express app.
 * Stateless mode — each request gets its own transport.
 */
export function mountMcp(app: Express): void {
  app.post('/mcp', async (req: Request, res: Response) => {
    const mcpServer = createMcpServer();
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        mcpServer.close();
      });
    } catch (error) {
      console.error('[MCP] Error handling request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Reject unsupported methods
  app.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  app.delete('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  console.log('[MCP] Streamable HTTP endpoint mounted at /mcp');
}

import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
  ActivityTypes,
} from 'botbuilder';
import { handlers } from '../commands/handlers.js';
import type { CommandContext } from '../types.js';

const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication({
  MicrosoftAppId: process.env.TEAMS_APP_ID || '',
  MicrosoftAppPassword: process.env.TEAMS_APP_PASSWORD || '',
});

export const adapter = new CloudAdapter(botFrameworkAuth);

// Error handler
adapter.onTurnError = async (context, error) => {
  console.error('[Teams] Unhandled error:', error);
  await context.sendActivity('Something went wrong. Please try again.');
};

/**
 * Parse Teams mentions from activity.
 * Teams provides structured mention entities alongside <at>Name</at> in text.
 */
function parseMentions(turnContext: TurnContext): { targetUserId?: string; targetChannelId?: string } {
  const entities = turnContext.activity.entities || [];
  let targetUserId: string | undefined;

  // Find mentioned users that aren't the bot itself
  for (const entity of entities) {
    if (entity.type === 'mention' && entity.mentioned?.id !== turnContext.activity.recipient.id) {
      targetUserId = entity.mentioned?.id;
      break;
    }
  }

  // Teams doesn't have inline channel mentions like Discord;
  // channel context is the conversation itself
  return { targetUserId };
}

function stripMentions(text: string): string {
  // Remove all <at>...</at> tags
  return text.replace(/<at[^>]*>.*?<\/at>/gi, '').trim();
}

function buildContext(turnContext: TurnContext, overrides?: { targetUserId?: string; targetChannelId?: string }): CommandContext {
  let typingSent = false;

  return {
    userId: turnContext.activity.from.id,
    channelId: turnContext.activity.conversation.id,
    userName: turnContext.activity.from.name || 'Unknown',
    platform: 'teams',
    targetUserId: overrides?.targetUserId,
    targetChannelId: overrides?.targetChannelId,
    reply: async (text: string) => {
      await turnContext.sendActivity(text);
    },
    deferReply: async () => {
      if (!typingSent) {
        typingSent = true;
        await turnContext.sendActivity({ type: ActivityTypes.Typing });
      }
    },
    editReply: async (text: string) => {
      await turnContext.sendActivity(text);
    },
  };
}

function parseCommand(text: string): { command: string; args: string } | null {
  const match = text.match(/^(\w+)\s*(.*)/s);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[2].trim() };
}

async function handleMessage(turnContext: TurnContext): Promise<void> {
  if (turnContext.activity.type !== ActivityTypes.Message) return;

  const text = turnContext.activity.text || '';

  // Strip all mentions (bot + targets) to get clean text
  const cleaned = stripMentions(text);
  const parsed = parseCommand(cleaned);

  if (!parsed) {
    await turnContext.sendActivity(
      "I didn't understand that. Try `website <task>` or `remind <when> <what>`."
    );
    return;
  }

  const handler = handlers.get(parsed.command);
  if (!handler) {
    const available = Array.from(handlers.keys()).join(', ');
    await turnContext.sendActivity(
      `Unknown command: \`${parsed.command}\`. Available commands: ${available}`
    );
    return;
  }

  // Parse targeted mentions from structured entities
  const { targetUserId, targetChannelId } = parseMentions(turnContext);
  const ctx = buildContext(turnContext, { targetUserId, targetChannelId });
  await handler.execute(ctx, parsed.args);
}

export async function startTeams(app: import('express').Express): Promise<void> {
  app.post('/api/messages', async (req, res) => {
    await adapter.process(req, res, async (turnContext) => {
      await handleMessage(turnContext);
    });
  });

  console.log('[Teams] Bot endpoint registered at /api/messages');
}

import type { Client } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { sendTeamsProactiveMessage } from './teams.js';
import { createLogger } from '../logger.js';

const log = createLogger('Notify');

export interface NotificationTarget {
  platform: 'discord' | 'teams';
  channelId: string;
  userId: string;
  conversationRef?: string;
}

/**
 * Optional Discord-only action attached to a notification. Currently only used
 * for "Approve & Merge" / "Request changes" buttons on PR-ready messages.
 * Teams notifications silently drop these.
 */
export interface PRActionRef {
  kind: 'pr-actions';
  repo: string;
  prNumber: number;
}

let discordClient: Client | null = null;

export function initNotifications(client: Client): void {
  discordClient = client;
}

/**
 * Send a message to a user on whichever platform they originated from.
 * This is the ONLY path for deferred/async notifications.
 */
export async function notifyUser(
  target: NotificationTarget,
  message: string,
  actions?: PRActionRef,
): Promise<void> {
  switch (target.platform) {
    case 'teams': {
      if (!target.conversationRef) {
        log.error('Teams target has no conversationRef — cannot notify');
        return;
      }
      await sendTeamsProactiveMessage(target.conversationRef, message);
      break;
    }
    case 'discord': {
      if (!discordClient) {
        log.error('Discord client not initialized');
        return;
      }
      const channel = await discordClient.channels.fetch(target.channelId);
      if (channel && 'send' in channel) {
        const discordMsg = `<@${target.userId}> ${message}`;
        const components = actions ? buildDiscordComponents(actions) : undefined;
        await channel.send({
          content: discordMsg.slice(0, 2000),
          ...(components ? { components } : {}),
        });
      }
      break;
    }
    default: {
      const _exhaustive: never = target.platform;
      log.error(`Unknown platform: ${_exhaustive}`);
    }
  }
}

/**
 * Build the discord.js component row for PR actions.
 */
function buildDiscordComponents(actions: PRActionRef): ActionRowBuilder<ButtonBuilder>[] {
  const tag = `${actions.repo}:${actions.prNumber}`;
  const approve = new ButtonBuilder()
    .setCustomId(`pr:approve:${tag}`)
    .setLabel('Approve & Merge')
    .setStyle(ButtonStyle.Success);
  const revise = new ButtonBuilder()
    .setCustomId(`pr:revise:${tag}`)
    .setLabel('Request changes')
    .setStyle(ButtonStyle.Secondary);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(approve, revise);
  return [row];
}

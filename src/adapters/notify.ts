import type { Client } from 'discord.js';
import { sendTeamsProactiveMessage } from './teams.js';
import { createLogger } from '../logger.js';

const log = createLogger('Notify');

export interface NotificationTarget {
  platform: 'discord' | 'teams';
  channelId: string;
  userId: string;
  conversationRef?: string;
}

let discordClient: Client | null = null;

export function initNotifications(client: Client): void {
  discordClient = client;
}

/**
 * Send a message to a user on whichever platform they originated from.
 * This is the ONLY path for deferred/async notifications.
 */
export async function notifyUser(target: NotificationTarget, message: string): Promise<void> {
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
        await channel.send(discordMsg.slice(0, 2000));
      }
      break;
    }
    default: {
      const _exhaustive: never = target.platform;
      log.error(`Unknown platform: ${_exhaustive}`);
    }
  }
}

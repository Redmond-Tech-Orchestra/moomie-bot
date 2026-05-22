import type { SlashCommandBuilder, Collection } from 'discord.js';

// Discord slash command definition (used for registration only)
export interface CommandDefinition {
  data: SlashCommandBuilder;
}

export type CommandDefinitionCollection = Collection<string, CommandDefinition>;

export interface Attachment {
  name: string;
  url: string;
  contentType?: string;
  size?: number;
}

// Platform-agnostic command context
export interface CommandContext {
  userId: string;
  channelId: string;
  userName: string;
  platform: 'discord' | 'teams';
  // Optional target overrides (parsed from mentions by each adapter)
  targetUserId?: string;
  targetChannelId?: string;
  attachments?: Attachment[];
  // Teams proactive messaging reference (serialized JSON)
  conversationRef?: string;
  // Permissions
  hasRole?: (roleNameOrId: string) => boolean;
  reply: (text: string, components?: unknown[]) => Promise<void>;
  deferReply: () => Promise<void>;
  editReply: (text: string, components?: unknown[]) => Promise<void>;
  /**
   * Send an additional message after the initial reply (used for chunked
   * output that exceeds platform message limits). Optionally carries
   * interactive UI components (buttons, select menus, etc); platforms that
   * don't support components should fall back to text only.
   */
  followUp: (text: string, components?: unknown[]) => Promise<void>;
  /**
   * Start a thread off the current reply so all follow-up work (issue
   * updates, PR notifications, revision results) can be grouped together.
   * Returns the new thread's channel id, or `undefined` if threads are not
   * supported in this context (DMs, Teams, etc).
   */
  startThread?: (name: string) => Promise<string | undefined>;
}

// Platform-agnostic command handler
export interface CommandHandler {
  name: string;
  description: string;
  execute: (ctx: CommandContext, args: string) => Promise<void>;
}

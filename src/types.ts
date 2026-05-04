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
  // Permissions
  hasRole?: (roleNameOrId: string) => boolean;
  reply: (text: string) => Promise<void>;
  deferReply: () => Promise<void>;
  editReply: (text: string) => Promise<void>;
}

// Platform-agnostic command handler
export interface CommandHandler {
  name: string;
  description: string;
  execute: (ctx: CommandContext, args: string) => Promise<void>;
}

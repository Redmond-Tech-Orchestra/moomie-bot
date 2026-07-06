/**
 * Adapters barrel — the ONLY import path for platform I/O.
 *
 * Features must import from '@adapters' (this file), never from
 * discord.js, botbuilder, or individual adapter files directly.
 */

export { notifyUser, initNotifications } from './notify.js';
export type { NotificationTarget, PRActionRef } from './notify.js';
export { initActivity, resolveActivity, nullActivitySession } from './activity.js';
export type { ActivityTarget, ActivityAction, ActivityResult, ActivitySession } from './activity.js';
export { getRecentMessages } from './discord-messages.js';
export type { ChannelMessages } from './discord-messages.js';
export { client } from './discord.js';
export {
  ActionRowBuilder,
  ChannelType,
  ComponentType,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
export type {
  APIMessageComponentEmoji,
  APISelectMenuOption,
  AutocompleteInteraction,
  CategoryChannel,
  Client,
  Guild,
  GuildMember,
  Message,
  StringSelectMenuComponent,
  StringSelectMenuInteraction,
  TextChannel,
} from 'discord.js';

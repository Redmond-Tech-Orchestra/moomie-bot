/**
 * Adapters barrel — the ONLY import path for platform I/O.
 *
 * Features must import from '@adapters' (this file), never from
 * discord.js, botbuilder, or individual adapter files directly.
 */

export { notifyUser, initNotifications } from './notify.js';
export type { NotificationTarget } from './notify.js';
export { getRecentMessages } from './messages.js';
export type { ChannelMessages } from './messages.js';

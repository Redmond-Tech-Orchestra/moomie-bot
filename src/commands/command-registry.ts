import type { CommandHandler } from '../types.js';
import * as website from '../features/website/handle-command.js';
import * as remind from '../features/remind/handle-command.js';
import * as music from '../features/music/handle-command.js';
import * as digest from '../features/digest/handle-command.js';

export const handlers: Map<string, CommandHandler> = new Map();

handlers.set(website.name, website);
handlers.set(remind.name, remind);
handlers.set(music.name, music);
handlers.set(digest.name, digest);

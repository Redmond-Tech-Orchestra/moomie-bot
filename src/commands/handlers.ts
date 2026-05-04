import type { CommandHandler } from '../types.js';
import * as website from '../features/website/command.js';
import * as remind from '../features/remind/command.js';
import * as music from '../features/music/command.js';

export const handlers: Map<string, CommandHandler> = new Map();

handlers.set(website.name, website);
handlers.set(remind.name, remind);
handlers.set(music.name, music);

import type { CommandHandler } from '../types.js';
import * as website from '../features/website/handle-command.js';
import * as remind from '../features/remind/handle-command.js';
import * as music from '../features/music/handle-command.js';
import * as digest from '../features/digest/handle-command.js';
import * as events from '../features/tracker/handle-events.js';
import * as board from '../features/tracker/handle-board.js';
import * as feedback from '../features/feedback/handle-command.js';

export const handlers: Map<string, CommandHandler> = new Map();

handlers.set(website.name, website);
handlers.set(remind.name, remind);
handlers.set(music.name, music);
handlers.set(digest.name, digest);
handlers.set(events.name, events);
handlers.set(board.name, board);
handlers.set(feedback.name, feedback);

import * as chrono from 'chrono-node';
import type { Client } from 'discord.js';
import { getDb, registerMigration } from '../../db.js';

registerMigration((db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message TEXT NOT NULL,
      trigger_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_at);
  `);
});

interface Reminder {
  userId: string;
  channelId: string;
  message: string;
  triggerAt: number;
}

interface ParsedReminder {
  date: Date;
  message: string;
}

let nextTimer: ReturnType<typeof setTimeout> | null = null;
let discordClient: Client | null = null;

export function initScheduler(client: Client): void {
  discordClient = client;
  scheduleNext();
}

export function addReminder(reminder: Reminder): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO reminders (user_id, channel_id, message, trigger_at) VALUES (?, ?, ?, ?)`
  ).run(reminder.userId, reminder.channelId, reminder.message, reminder.triggerAt);
  scheduleNext();
}

function getNextReminder(): (Reminder & { id: number }) | undefined {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, user_id, channel_id, message, trigger_at FROM reminders ORDER BY trigger_at ASC LIMIT 1`
  ).get() as { id: number; user_id: string; channel_id: string; message: string; trigger_at: number } | undefined;

  if (!row) return undefined;
  return { id: row.id, userId: row.user_id, channelId: row.channel_id, message: row.message, triggerAt: row.trigger_at };
}

function deleteReminder(id: number): void {
  const db = getDb();
  db.prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
}

function scheduleNext(): void {
  if (nextTimer) clearTimeout(nextTimer);

  const next = getNextReminder();
  if (!next) return;

  const delay = Math.max(0, next.triggerAt - Date.now());

  nextTimer = setTimeout(async () => {
    deleteReminder(next.id);
    await fire(next);
    scheduleNext();
  }, delay);
}

async function fire(reminder: Reminder): Promise<void> {
  try {
    const channel = await discordClient!.channels.fetch(reminder.channelId);
    if (channel && 'send' in channel) {
      await channel.send(`<@${reminder.userId}> Reminder: ${reminder.message}`);
    }
  } catch (err) {
    console.error('Failed to send reminder:', err);
  }
}

/**
 * Parse natural language text into { date, message }.
 * Uses chrono-node for flexible parsing.
 */
export function parseReminder(input: string): ParsedReminder | null {
  const results = chrono.parse(input);
  if (results.length === 0) return null;

  const parsed = results[0];
  const date = parsed.date();

  if (!date || date.getTime() <= Date.now()) return null;

  let message = input
    .replace(parsed.text, '')
    .replace(/^\s*(to|that|:)\s*/i, '')
    .replace(/\s*(to|that|:)\s*$/i, '')
    .trim();

  if (!message) message = input;

  return { date, message };
}

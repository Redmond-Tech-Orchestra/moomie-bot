import type { Client, Message, ThreadChannel, TextChannel } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from 'discord.js';
import type { CodingProgress } from '../features/coding/agents/index.js';
import { THINKING_CHANNEL_ID } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Activity');

/**
 * Where an async job should report back to. Derived from the persisted
 * tracker rows (tracked_issues / tracked_prs), so it survives restarts.
 */
export interface ActivityTarget {
  platform: 'discord' | 'teams';
  channelId: string;
  userId: string;
  conversationRef?: string;
  /** Message that triggered the job, when one exists (for emoji acks). */
  triggerMessageId?: string;
  /** Short human label for the job, used to name the live-thinking thread. */
  label?: string;
}

/** A platform-agnostic action attached to a terminal message (PR buttons). */
export interface ActivityAction {
  kind: 'pr-actions';
  repo: string;
  prNumber: number;
}

/** Payload for a successful terminal state. */
export interface ActivityResult {
  /** One-line summary, e.g. "Opened PR #41: <url>". */
  headline: string;
  actions?: ActivityAction;
}

/**
 * The user-facing lifecycle of an async job, in four modes:
 *
 *  - `ack()`   — acknowledge receipt: react + post a single status message we
 *                then evolve in place (one ping, no message spam).
 *  - `work()`  — relay live progress (throttled by the implementation).
 *  - `done()`  — terminal success.
 *  - `fail()`  — terminal failure.
 *
 * The job-runner drives these; each platform decides how to deliver them. A
 * no-op session is used when there's no live surface (unsupported platform,
 * untracked job). `delivered` lets callers skip duplicate fallback
 * notifications once a live surface has shown the user the result.
 */
export interface ActivitySession {
  ack(): Promise<void>;
  work(progress: CodingProgress): void;
  done(result: ActivityResult): Promise<void>;
  fail(reason: string): Promise<void>;
  readonly delivered: boolean;
}

/** Drops everything on the floor — for jobs with no live surface. */
export const nullActivitySession: ActivitySession = {
  async ack() { /* no-op */ },
  work() { /* no-op */ },
  async done() { /* no-op */ },
  async fail() { /* no-op */ },
  delivered: false,
};

let discordClient: Client | null = null;

export function initActivity(client: Client): void {
  discordClient = client;
}

/**
 * Pick the right session for a target. Returns a no-op session when there's no
 * live surface (no target, Discord client not ready, or a platform we can't
 * stream to yet — e.g. Teams). The interface stays identical, so a
 * `TeamsActivitySession` can drop in here later with zero caller changes.
 */
export function resolveActivity(target?: ActivityTarget): ActivitySession {
  if (target?.platform === 'discord' && discordClient) {
    return new DiscordActivitySession(discordClient, target);
  }
  return nullActivitySession;
}

// Minimum spacing between live status-message edits. Coding runs are minutes
// long, so a slow cadence keeps us well clear of Discord's rate limits.
const WORK_EDIT_INTERVAL_MS = 8 * 1000;

// How many of the most recent thoughts to show in the live trail card.
const TRAIL_WINDOW = 12;

/**
 * Delivers a job's lifecycle to Discord with two surfaces:
 *
 *  - A compact **summary** message in the origin surface (channel/thread/DM):
 *      🐄 On it… → watch live ↗   →   ✅ <result> + action buttons.
 *  - A live **trail** the user can expand for the play-by-play:
 *      • Guild origins: a per-job thread in the configured thinking channel
 *        (the thread is Discord's native collapsible, and it lives in Moomie's
 *        own channel so the no-nested-threads rule never bites).
 *      • DM origins (or no thinking channel): an inline rolling trail rendered
 *        in the origin message itself — the summary *is* the trail card.
 *
 * Edits don't re-ping, so the user gets one notification and then watches it
 * update. Every Discord call is best-effort: failures degrade to no live
 * status but never break the job.
 */
class DiscordActivitySession implements ActivitySession {
  /** Message in the origin surface; becomes the terminal result + buttons. */
  private summary: Message | null = null;
  /** Live trail card. In inline mode this is the same object as `summary`. */
  private card: Message | null = null;
  /** Per-job thinking thread (guild mode only). */
  private thread: ThreadChannel | null = null;
  /** Mention prefix for the origin/result message ('' in DMs). */
  private prefix = '';
  /** Accumulated thoughts; the card renders a rolling window of these. */
  private readonly trail: string[] = [];
  private lastEditAt = 0;
  private lastRendered = '';
  private editInFlight = false;
  delivered = false;

  constructor(private readonly client: Client, private readonly target: ActivityTarget) {}

  private async getChannel() {
    const ch = await this.client.channels.fetch(this.target.channelId).catch(() => null);
    return ch && ch.isTextBased() && 'send' in ch ? ch : null;
  }

  async ack(): Promise<void> {
    const ch = await this.getChannel();
    if (!ch) return;

    // React on the triggering message when there is one (message-based flows).
    if (this.target.triggerMessageId && 'messages' in ch) {
      try {
        const trigger = await ch.messages.fetch(this.target.triggerMessageId);
        await trigger.react('🐄');
      } catch (err) {
        log.warn('Failed to react to trigger message:', err);
      }
    }

    const isDM = ch.isDMBased();
    this.prefix = isDM ? '' : `<@${this.target.userId}> `;

    // Guild origin with a configured thinking channel → thread mode.
    if (!isDM && THINKING_CHANNEL_ID) {
      const thread = await this.openThread();
      if (thread) {
        this.thread = thread;
        try {
          this.card = await thread.send('🐄 _On it…_');
        } catch (err) {
          log.warn('Failed to post thread card:', err);
        }
        const link = `https://discord.com/channels/${thread.guildId}/${thread.id}`;
        try {
          this.summary = await ch.send(`${this.prefix}🐄 _On it…_ — [watch live ↗](${link})`);
          this.delivered = true;
        } catch (err) {
          log.warn('Failed to post origin summary:', err);
        }
        return;
      }
    }

    // Inline fallback (DM, no thinking channel, or thread creation failed):
    // the origin message doubles as the live trail card.
    try {
      this.summary = await ch.send(`${this.prefix}🐄 _On it…_`);
      this.card = this.summary;
      this.delivered = true;
    } catch (err) {
      log.warn('Failed to post initial status message:', err);
    }
  }

  /** Open a per-job thread in the configured thinking channel. */
  private async openThread(): Promise<ThreadChannel | null> {
    try {
      const tc = await this.client.channels.fetch(THINKING_CHANNEL_ID).catch(() => null);
      if (!tc || tc.type !== ChannelType.GuildText) return null;
      const name = (this.target.label || 'Coding job').slice(0, 90);
      return await (tc as TextChannel).threads.create({
        name,
        autoArchiveDuration: 1440,
        type: ChannelType.PublicThread,
        reason: 'Moomie coding job live log',
      });
    } catch (err) {
      log.warn('Failed to open thinking thread:', err);
      return null;
    }
  }

  work(progress: CodingProgress): void {
    this.trail.push(progress.headline);
    if (!this.card) return;
    const now = Date.now();
    if (this.editInFlight || now - this.lastEditAt < WORK_EDIT_INTERVAL_MS) return;
    const next = this.renderWork(progress);
    if (next === this.lastRendered) return;
    this.lastEditAt = now;
    this.lastRendered = next;
    this.editInFlight = true;
    this.card.edit(next)
      .catch((err) => log.warn('Status edit failed:', err))
      .finally(() => { this.editInFlight = false; });
  }

  async done(result: ActivityResult): Promise<void> {
    await this.finalize(`✅ ${result.headline}`, result.actions);
  }

  async fail(reason: string): Promise<void> {
    await this.finalize(`⚠️ ${reason}`);
  }

  private async finalize(body: string, actions?: ActivityAction): Promise<void> {
    const content = `${this.prefix}${body}`.slice(0, 2000);
    const components = actions ? buildActionRow(actions) : [];
    try {
      // Origin summary → terminal result + buttons (the actionable surface).
      if (this.summary) {
        await this.summary.edit({ content, components });
      } else {
        const ch = await this.getChannel();
        if (ch) {
          this.summary = await ch.send({ content, ...(components.length ? { components } : {}) });
          this.delivered = true;
        }
      }
      // Thread mode: close out the trail card and archive the thread.
      if (this.thread && this.card && this.card !== this.summary) {
        await this.card.edit(body.slice(0, 2000)).catch(() => { /* best effort */ });
        await this.thread.setArchived(true).catch(() => { /* best effort */ });
      }
    } catch (err) {
      log.warn('Failed to finalize status message:', err);
    }
  }

  private renderWork(p: CodingProgress): string {
    const mins = Math.floor(p.elapsedMs / 60000);
    const elapsed = mins >= 1 ? ` (${mins}m in)` : '';
    const header = `🛠️ _Working…${elapsed}_`;
    const window = this.trail.slice(-TRAIL_WINDOW).map((t) => `• ${t}`).join('\n');
    return `${header}\n\n${window}`.slice(0, 2000);
  }
}

/** Build the Approve / Request-changes button row for a PR. */
function buildActionRow(actions: ActivityAction): ActionRowBuilder<ButtonBuilder>[] {
  const tag = `${actions.repo}:${actions.prNumber}`;
  const approve = new ButtonBuilder()
    .setCustomId(`pr:approve:${tag}`)
    .setLabel('Approve & Merge')
    .setStyle(ButtonStyle.Success);
  const revise = new ButtonBuilder()
    .setCustomId(`pr:revise:${tag}`)
    .setLabel('Request changes')
    .setStyle(ButtonStyle.Secondary);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(approve, revise)];
}

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { ChatInputCommandInteraction, ButtonInteraction, ModalSubmitInteraction, GuildMemberRoleManager, ThreadChannel } from 'discord.js';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { loadCommands } from '../commands/slash-commands.js';
import { handlers } from '../commands/command-registry.js';
import { initScheduler } from '../features/remind/scheduler.js';
import { syncEvents, registerChannelWatcher, registerEventConfirmationListener } from '../features/tracker/event-watcher.js';
import { autocompleteEvent } from '../features/tracker/autocomplete.js';
import { registerConversationWatcher } from '../features/tracker/conversation-watcher.js';
import { isBoardSelect, handleBoardSelect } from '../features/tracker/board-interactions.js';
import { handleChatMessage } from '../features/chat/handle-message.js';
import type { ChatProgress } from '../features/chat/handle-message.js';
import { renderLive, renderTrail, isInteresting } from '../features/chat/progress-render.js';
import { chunkText, DISCORD_CHUNK_MAX } from './chunk.js';
import { commentOnPR } from '../features/coding/github-client.js';
import { trackPR } from '../features/coding/issue-tracker.js';
import { approveAndMerge } from '../features/coding/pr-actions.js';
import { runRevisionTask } from '../features/coding/job-runner.js';
import { notifyOnRevisionComplete } from '../features/coding/revision-notifier.js';
import { GITHUB_OWNER, GITHUB_REPO, GITHUB_BOT_REPO, WEB_APPROVER_ROLE, THINKING_CHANNEL_ID } from '../config.js';
import type { CommandContext } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('Discord');

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

/**
 * Parse Discord mentions from raw input and return cleaned text + overrides.
 */
function parseMentions(raw: string): { cleaned: string; targetUserId?: string; targetChannelId?: string } {
  const userMatch = raw.match(/<@!?(\d+)>/);
  const channelMatch = raw.match(/<#(\d+)>/);

  const cleaned = raw
    .replace(/<@!?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .trim();

  return {
    cleaned,
    targetUserId: userMatch?.[1],
    targetChannelId: channelMatch?.[1],
  };
}

function buildContext(interaction: ChatInputCommandInteraction, overrides?: { targetUserId?: string; targetChannelId?: string }): CommandContext {
  let deferred = false;

  return {
    userId: interaction.user.id,
    channelId: interaction.channelId,
    userName: interaction.user.username,
    platform: 'discord',
    targetUserId: overrides?.targetUserId,
    targetChannelId: overrides?.targetChannelId,
    hasRole: (roleNameOrId: string) => {
      const member = interaction.member;
      if (!member || !('roles' in member)) return false;
      const roles = member.roles;
      if (Array.isArray(roles)) return roles.includes(roleNameOrId);
      return roles.cache.some((r) => r.name === roleNameOrId || r.id === roleNameOrId);
    },
    reply: async (text: string, components?: unknown[]) => {
      await interaction.reply({ content: text, components: (components ?? []) as never });
    },
    deferReply: async () => {
      deferred = true;
      await interaction.deferReply();
    },
    editReply: async (text: string, components?: unknown[]) => {
      const payload = { content: text, components: (components ?? []) as never };
      if (deferred) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
    },
    followUp: async (text: string, components?: unknown[]) => {
      await interaction.followUp({ content: text, components: (components ?? []) as never });
    },
    startThread: async (name: string) => {
      try {
        // The reply message is the natural anchor for the thread, so callers
        // see the original prompt + thread together in the channel.
        const replyMsg = deferred || interaction.replied
          ? await interaction.fetchReply()
          : null;
        if (!replyMsg || typeof (replyMsg as { startThread?: unknown }).startThread !== 'function') {
          return undefined;
        }
        // Threads can't be started inside other threads, and DMs can't have
        // threads at all. Bail quietly if so — callers will fall back to the
        // parent channel.
        const parent = interaction.channel;
        if (!parent || parent.isThread() || parent.isDMBased()) return undefined;

        // Discord caps thread names at 100 chars.
        const trimmed = name.slice(0, 100);
        const thread = await (replyMsg as { startThread: (opts: { name: string; autoArchiveDuration: number }) => Promise<{ id: string }> })
          .startThread({ name: trimmed, autoArchiveDuration: 10080 });
        return thread.id;
      } catch (err) {
        log.warn(`Failed to start thread "${name}":`, err);
        return undefined;
      }
    },
  };
}

export async function startDiscord(): Promise<void> {
  // Load command definitions (for validation that commands are registered)
  await loadCommands();

  client.once('ready', async () => {
    log.info(`Logged in as ${client.user!.tag}`);
    initScheduler();
    registerChannelWatcher(client);
    registerEventConfirmationListener(client);
    registerConversationWatcher(client);
    await syncEvents(client);
  });

  client.on('interactionCreate', async (interaction) => {
    // Handle autocomplete for the 'event' option
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      if (focused.name === 'event') {
        await autocompleteEvent(interaction);
      }
      return;
    }

    // Route component interactions (select menus, buttons) to their owners.
    if (interaction.isStringSelectMenu()) {
      if (isBoardSelect(interaction.customId)) {
        try {
          await handleBoardSelect(interaction);
        } catch (err) {
          log.error('Board select handler failed:', err);
          if (!interaction.replied) {
            await interaction.reply({ content: 'Something went wrong applying that change.', ephemeral: true });
          }
        }
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('pr:')) {
      try {
        await handlePRButton(interaction);
      } catch (err) {
        log.error('PR button handler failed:', err);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Something went wrong handling that action.', ephemeral: true });
        }
      }
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('pr:revise:')) {
      try {
        await handlePRReviseModal(interaction);
      } catch (err) {
        log.error('PR revise modal handler failed:', err);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Something went wrong sending that revision.', ephemeral: true });
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const handler = handlers.get(interaction.commandName);
    if (!handler) {
      await interaction.reply('Moo.');
      return;
    }

    try {
      // Extract raw args from the first string option
      const rawArgs = interaction.options.getString('text')
        || interaction.options.getString('task')
        || interaction.options.getString('link')
        || interaction.options.getString('window')
        || interaction.options.getInteger('event')?.toString()
        || '';

      // Collect attachments from known option names
      const attachments = ['file1', 'file2', 'file3']
        .map((name) => interaction.options.getAttachment(name))
        .filter(Boolean)
        .map((a) => ({ name: a!.name, url: a!.url, contentType: a!.contentType ?? undefined, size: a!.size }));

      // Parse mentions out of the input
      const { cleaned, targetUserId, targetChannelId } = parseMentions(rawArgs);
      const ctx = buildContext(interaction, { targetUserId, targetChannelId });
      if (attachments.length > 0) ctx.attachments = attachments;

      await handler.execute(ctx, cleaned);
    } catch (err) {
      log.error(`Error executing /${interaction.commandName}:`, err);
      const reply = { content: 'Something went wrong running that command.', ephemeral: true as const };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  });

  // Respond to DMs and mentions with natural language chat
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const isDM = !message.guild;
    const isMentioned = message.mentions.has(client.user!, {
      ignoreEveryone: true,
      ignoreRoles: true,
      ignoreRepliedUser: true,
    });

    // Check if replying to a Moomie message (fetch once, reuse below)
    let referencedBotContent: string | null = null;
    if (message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        if (refMsg.author.id === client.user!.id) {
          referencedBotContent = refMsg.content;
        }
      } catch { /* referenced message may be deleted */ }
    }

    // Respond to: DMs, @mentions, or direct replies to Moomie.
    // For replies, only trigger if the user isn't @mentioning other people
    // (they're probably talking to someone else and just quoting Moomie).
    const isDirectReplyToBot = referencedBotContent !== null
      && message.mentions.users.filter((u) => !u.bot).size === 0;

    // A plain message in one of Moomie's own task threads (the per-job thread
    // opened off a /website or /feedback reply) counts as talking to her — no
    // @mention needed. Exclude the thinking channel's threads: those are her
    // reasoning logs, not conversation surfaces.
    const ch = message.channel;
    const inMoomieThread = !isDM
      && ch.isThread()
      && ch.ownerId === client.user!.id
      && ch.parentId !== THINKING_CHANNEL_ID;

    if (!isDM && !isMentioned && !isDirectReplyToBot && !inMoomieThread) return;

    // Strip the bot mention from the message content
    let content = message.content
      .replace(new RegExp(`<@!?${client.user!.id}>`, 'g'), '')
      .trim();

    // PR-revision relay: if the user is replying to a Moomie message that
    // contains a PR URL, treat the reply as feedback on that PR. We forward
    // it to the GitHub API as a PR comment tagging @moomie-bot, which then
    // fires the same webhook path as in-PR mentions — single source of truth.
    if (referencedBotContent && content) {
      const prMatch = referencedBotContent.match(
        new RegExp(`https://github\\.com/${GITHUB_OWNER}/([\\w.-]+)/pull/(\\d+)`),
      );
      if (prMatch) {
        const [, repo, prStr] = prMatch;
        const prNumber = parseInt(prStr, 10);
        try {
          const userName = message.member?.displayName ?? message.author.displayName ?? message.author.username;
          await commentOnPR(repo, prNumber, `@moomie-bot ${content}\n\n_(via Discord reply from ${userName})_`);
          // Record the originating channel so the revision-complete webhook
          // can notify back to Discord (the PR comment alone is invisible there).
          trackPR(prNumber, repo, {
            channelId: message.channelId,
            userId: message.author.id,
            platform: 'discord',
          });
          await message.react('👀');
        } catch (err) {
          log.error(`Failed to relay Discord reply to ${repo}/PR${prNumber}:`, err);
          await message.reply("Couldn't forward that to the PR. Sorry. 🐄");
        }
        return;
      }
    }

    // Conversation-thread relay: a plain message in one of Moomie's task threads
    // is feedback on that thread's PR — no need to quote the link. Scan the
    // thread for the PR she announced and forward it as a revision, reusing the
    // same @moomie-bot → webhook path as the reply relay above.
    if (inMoomieThread && content) {
      const pr = await findThreadPR(ch as ThreadChannel, client.user!.id);
      if (pr) {
        try {
          const userName = message.member?.displayName ?? message.author.displayName ?? message.author.username;
          await commentOnPR(pr.repo, pr.prNumber, `@moomie-bot ${content}\n\n_(via Discord thread reply from ${userName})_`);
          trackPR(pr.prNumber, pr.repo, {
            channelId: message.channelId,
            userId: message.author.id,
            platform: 'discord',
          });
          await message.react('👀');
        } catch (err) {
          log.error(`Failed to relay thread reply to ${pr.repo}/PR${pr.prNumber}:`, err);
          await message.reply("Couldn't forward that to the PR. Sorry. 🐄");
        }
        return;
      }
      // No PR announced yet (job still running) — fall through to normal chat so
      // questions still get answered.
    }

    if (!content) {
      await message.reply('Moo! 🐄');
      return;
    }

    // If replying to a Moomie message, include it as context so the LLM
    // can see what's being referenced (useful for feedback/corrections)
    if (referencedBotContent) {
      content = `[Replying to Moomie's message: "${referencedBotContent.slice(0, 1000)}"]\n\n${content}`;
    }

    try {
      await message.channel.sendTyping();

      // Send a placeholder reply we'll edit-in-place as the model thinks.
      // Edits don't notify in Discord, so the user gets a single ping and
      // then sees the message evolve.
      const placeholder = await message.reply('💭 _Thinking…_');

      // Debounced editor so a burst of round updates doesn't hammer Discord.
      let lastEditAt = 0;
      let lastRendered = '';
      const MIN_EDIT_INTERVAL_MS = 600;
      const onProgress = async (snap: ChatProgress): Promise<void> => {
        if (snap.done) return; // final state is handled below
        const now = Date.now();
        if (now - lastEditAt < MIN_EDIT_INTERVAL_MS) return;
        const next = renderLive(snap);
        if (next === lastRendered) return;
        lastEditAt = now;
        lastRendered = next;
        try {
          await placeholder.edit(next);
        } catch (err) {
          log.warn('Failed to edit placeholder:', err);
        }
      };

      let response;
      try {
        response = await handleChatMessage({
          userId: message.author.id,
          userName: message.member?.displayName ?? message.author.displayName ?? message.author.username,
          channelId: message.channelId,
          channelName: message.channel.isDMBased()
            ? 'DM'
            : (('name' in message.channel && message.channel.name) || 'unknown'),
          content,
        }, onProgress);
      } catch (innerErr) {
        log.error('handleChatMessage threw:', innerErr);
        await placeholder.edit('Something went wrong. Moo. 🐄').catch(() => undefined);
        return;
      }

      const chunks = chunkText(response.text, DISCORD_CHUNK_MAX);
      const attachments = response.files?.map(
        (f) => new AttachmentBuilder(f.data, { name: f.name, description: f.description }),
      );
      // Replace the placeholder with the first chunk + any attachments.
      try {
        await placeholder.edit(
          attachments && attachments.length > 0
            ? { content: chunks[0], files: attachments }
            : { content: chunks[0] },
        );
      } catch (err) {
        log.warn('Failed to edit final reply, sending as new message:', err);
        await message.reply(
          attachments && attachments.length > 0
            ? { content: chunks[0], files: attachments }
            : chunks[0],
        );
      }
      for (let i = 1; i < chunks.length; i++) {
        await message.channel.send(chunks[i]);
      }
      // Post a reasoning trail for non-trivial turns.
      //  - In a text channel: open a thread on the reply and put the trail
      //    there. Channel view stays clean; the thread is one click away.
      //  - In a DM or an existing thread: post inline as a follow-up message.
      if (response.progress && isInteresting(response.progress)) {
        const trail = renderTrail(response.progress);
        const canThread = !message.channel.isDMBased() && !message.channel.isThread();
        if (canThread) {
          try {
            const thread = await placeholder.startThread({
              name: '💭 reasoning',
              autoArchiveDuration: 60,
            });
            for (const tc of chunkText(trail, DISCORD_CHUNK_MAX)) {
              await thread.send(tc);
            }
          } catch (err) {
            log.warn('Failed to create reasoning thread, posting inline:', err);
            for (const tc of chunkText(trail, DISCORD_CHUNK_MAX)) {
              await message.channel.send(tc);
            }
          }
        } else {
          for (const tc of chunkText(trail, DISCORD_CHUNK_MAX)) {
            await message.channel.send(tc);
          }
        }
      }
    } catch (err) {
      log.error('Error handling message:', err);
      await message.reply('Something went wrong. Moo. 🐄');
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
}

/**
 * Find the PR Moomie announced in one of her task threads by scanning recent
 * messages for the GitHub PR URL she posts on completion. Returns the most
 * recent match (so a follow-up PR supersedes an earlier one), or null.
 */
async function findThreadPR(thread: ThreadChannel, botId: string): Promise<{ repo: string; prNumber: number } | null> {
  try {
    const msgs = await thread.messages.fetch({ limit: 50 });
    const re = new RegExp(`https://github\\.com/${GITHUB_OWNER}/([\\w.-]+)/pull/(\\d+)`);
    for (const m of msgs.values()) {
      if (m.author.id !== botId) continue;
      const match = m.content.match(re);
      if (match) return { repo: match[1], prNumber: parseInt(match[2], 10) };
    }
  } catch (err) {
    log.warn('Failed to scan task thread for a PR:', err);
  }
  return null;
}

// ─── PR Action Buttons ──────────────────────────────────────────────────────

/**
 * Parse `pr:<action>:<repo>:<prNumber>` custom IDs. Returns null on malformed
 * input or on a repo outside our allow-list, so foreign or spoofed buttons
 * are dropped before any GitHub call.
 */
const ALLOWED_PR_REPOS = new Set([GITHUB_REPO, GITHUB_BOT_REPO]);

function parsePRCustomId(customId: string): { action: string; repo: string; prNumber: number } | null {
  const parts = customId.split(':');
  if (parts.length !== 4 || parts[0] !== 'pr') return null;
  const prNumber = parseInt(parts[3], 10);
  if (!Number.isFinite(prNumber)) return null;
  if (!ALLOWED_PR_REPOS.has(parts[2])) return null;
  return { action: parts[1], repo: parts[2], prNumber };
}

/**
 * Permission gate for PR-action buttons. `WEB_APPROVER_ROLE` may hold a role
 * name OR a snowflake ID. The cached-member path (the common case) accepts
 * either. The raw string[] fallback only carries role IDs, so it can only
 * match when the env var is a snowflake.
 */
function memberHasApproverRole(roles: GuildMemberRoleManager | string[] | undefined): boolean {
  if (!roles) return false;
  if (Array.isArray(roles)) {
    // Raw API path: array holds role IDs only. Names can't be compared here.
    if (!/^\d+$/.test(WEB_APPROVER_ROLE)) return false;
    return roles.includes(WEB_APPROVER_ROLE);
  }
  return roles.cache.some((r) => r.id === WEB_APPROVER_ROLE || r.name === WEB_APPROVER_ROLE);
}

async function handlePRButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parsePRCustomId(interaction.customId);
  if (!parsed) return;

  // Roles only resolve in guild context — DMs can't carry server roles.
  const member = interaction.member;
  const roles = member && 'roles' in member ? member.roles as GuildMemberRoleManager : undefined;
  if (!memberHasApproverRole(roles)) {
    await interaction.reply({
      content: `You need the **${WEB_APPROVER_ROLE}** role to do that.`,
      ephemeral: true,
    });
    return;
  }

  const actorName = interaction.member && 'displayName' in interaction.member
    ? (interaction.member.displayName as string)
    : interaction.user.username;

  if (parsed.action === 'approve') {
    // Acknowledge fast — merge can take a second or two.
    await interaction.deferReply();
    const result = await approveAndMerge({
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      requestedBy: actorName,
      auditActor: { id: interaction.user.id, username: interaction.user.username },
    });
    await interaction.editReply(result.message);
    // Disable buttons after a successful merge so nobody double-clicks them.
    if (result.success && interaction.message.editable) {
      try {
        await interaction.message.edit({ components: [] });
      } catch (err) {
        log.warn('Failed to clear PR action buttons after merge:', err);
      }
    }
    return;
  }

  if (parsed.action === 'revise') {
    // Open a modal so the user can type the requested change. Modals must be
    // shown synchronously (no defer first).
    const modal = new ModalBuilder()
      .setCustomId(`pr:revise:${parsed.repo}:${parsed.prNumber}`)
      .setTitle(`Request changes on PR #${parsed.prNumber}`);
    const input = new TextInputBuilder()
      .setCustomId('feedback')
      .setLabel('What should Moomie change?')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(2000);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }
}

async function handlePRReviseModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parsed = parsePRCustomId(interaction.customId);
  if (!parsed) return;

  // Re-check the role here too — Discord delivers the modal submission
  // separately from the button click, so we can't assume the earlier gate held.
  const member = interaction.member;
  const roles = member && 'roles' in member ? member.roles as GuildMemberRoleManager : undefined;
  if (!memberHasApproverRole(roles)) {
    await interaction.reply({
      content: `You need the **${WEB_APPROVER_ROLE}** role to do that.`,
      ephemeral: true,
    });
    return;
  }

  const feedback = interaction.fields.getTextInputValue('feedback').trim();
  if (!feedback) {
    await interaction.reply({ content: 'No feedback provided — nothing to do.', ephemeral: true });
    return;
  }

  const actorName = interaction.member && 'displayName' in interaction.member
    ? (interaction.member.displayName as string)
    : interaction.user.username;

  // Post the request as a PR comment so the GitHub side carries the trail.
  // This intentionally does NOT include the @moomie-bot trigger token, since
  // we drive the revision directly below — otherwise the webhook would fire
  // a duplicate revision job.
  try {
    await commentOnPR(
      parsed.repo,
      parsed.prNumber,
      `Revision requested via Discord by **${actorName}**:\n\n${feedback}`,
    );
  } catch (err) {
    log.warn(`Failed to mirror Discord revision to ${GITHUB_OWNER}/${parsed.repo} PR #${parsed.prNumber}:`, err);
  }

  // Remember where to deliver the "revision complete" notification.
  trackPR(parsed.prNumber, parsed.repo, {
    channelId: interaction.channelId ?? '',
    userId: interaction.user.id,
    platform: 'discord',
  });

  // Kick off the revision and bridge its outcome back to this channel/thread.
  // Without this notifier, the modal path would go silent on completion.
  notifyOnRevisionComplete(
    parsed.repo,
    parsed.prNumber,
    runRevisionTask({
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      feedback,
      requestedBy: actorName,
    }),
  );

  await interaction.reply({
    content: `On it — applying the requested changes to PR #${parsed.prNumber}.`,
  });
}

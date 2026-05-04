import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { loadCommands } from '../commands/slash-commands.js';
import { handlers } from '../commands/command-registry.js';
import { initScheduler } from '../features/remind/scheduler.js';
import { syncEvents, registerChannelWatcher, registerEventConfirmationListener } from '../features/tracker/event-watcher.js';
import { autocompleteEvent } from '../features/tracker/autocomplete.js';
import { registerConversationWatcher } from '../features/tracker/conversation-watcher.js';
import { handleChatMessage } from '../features/chat/handle-message.js';
import type { CommandContext } from '../types.js';

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
    reply: async (text: string) => {
      await interaction.reply(text);
    },
    deferReply: async () => {
      deferred = true;
      await interaction.deferReply();
    },
    editReply: async (text: string) => {
      if (deferred) {
        await interaction.editReply(text);
      } else {
        await interaction.reply(text);
      }
    },
  };
}

export async function startDiscord(): Promise<void> {
  // Load command definitions (for validation that commands are registered)
  await loadCommands();

  client.once('ready', async () => {
    console.log(`[Discord] Logged in as ${client.user!.tag}`);
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
      console.error(`[Discord] Error executing /${interaction.commandName}:`, err);
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
    const isMentioned = message.mentions.has(client.user!);

    if (!isDM && !isMentioned) return;

    // Strip the bot mention from the message content
    const content = message.content
      .replace(new RegExp(`<@!?${client.user!.id}>`, 'g'), '')
      .trim();

    if (!content) {
      await message.reply('Moo! 🐄');
      return;
    }

    try {
      await message.channel.sendTyping();
      const response = await handleChatMessage({
        userId: message.author.id,
        userName: message.member?.displayName ?? message.author.displayName ?? message.author.username,
        channelId: message.channelId,
        channelName: (message.channel as TextChannel).name ?? 'DM',
        content,
      });
      await message.reply(response);
    } catch (err) {
      console.error('[Chat] Error handling message:', err);
      await message.reply('Something went wrong. Moo. 🐄');
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
}

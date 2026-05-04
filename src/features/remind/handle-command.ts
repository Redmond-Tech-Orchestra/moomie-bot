import type { CommandContext } from '../../types.js';
import { addReminder, parseReminder } from './scheduler.js';

export const name = 'remind';
export const description = 'Set a reminder (natural language with @user and #channel)';

export async function execute(ctx: CommandContext, args: string): Promise<void> {
  if (!args) {
    await ctx.reply('Please include a reminder description with a time.');
    return;
  }

  const result = parseReminder(args);
  if (!result) {
    await ctx.reply(
      `Couldn't parse that. Try something like "in 2 hours to check the PR" or "tomorrow at 3pm review notes".`
    );
    return;
  }

  const remindUserId = ctx.targetUserId ?? ctx.userId;
  const remindChannelId = ctx.targetChannelId ?? ctx.channelId;

  addReminder({
    userId: remindUserId,
    channelId: remindChannelId,
    platform: ctx.platform,
    conversationRef: ctx.conversationRef,
    message: result.message,
    triggerAt: result.date.getTime(),
  });

  const timestamp = Math.floor(result.date.getTime() / 1000);
  const isSelf = remindUserId === ctx.userId;

  if (ctx.platform === 'discord') {
    const who = isSelf ? 'you' : `<@${remindUserId}>`;
    const where = ctx.targetChannelId ? ` in <#${remindChannelId}>` : '';
    await ctx.reply(`Got it — I'll remind ${who} <t:${timestamp}:R>${where}: "${result.message}"`);
  } else {
    const dateStr = result.date.toLocaleString();
    const who = isSelf ? 'you' : `@${ctx.targetUserId}`;
    await ctx.reply(`Got it — I'll remind ${who} at ${dateStr}: "${result.message}"`);
  }
}

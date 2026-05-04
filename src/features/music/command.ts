import type { CommandContext } from '../../types.js';
import { getMusicLink, setMusicLink } from './store.js';

export const name = 'music';
export const description = 'Get or set the link to the shared sheet music folder';

const ALLOWED_ROLE = process.env.MUSIC_ADMIN_ROLE || 'Librarian';
const OWNER_ID = process.env.BOT_OWNER_ID || '';

export async function execute(ctx: CommandContext, args: string): Promise<void> {
  // If args provided, treat as "set" operation
  if (args) {
    const isOwner = OWNER_ID && ctx.userId === OWNER_ID;
    const hasRole = ctx.hasRole && ctx.hasRole(ALLOWED_ROLE);
    if (!isOwner && !hasRole) {
      await ctx.reply(`Only members with the **${ALLOWED_ROLE}** role can update the music link.`);
      return;
    }
    setMusicLink(args);
    await ctx.reply(`Sheet music link updated: ${args}`);
    return;
  }

  // Otherwise, get the stored link
  const link = getMusicLink();
  if (link) {
    await ctx.reply(`Sheet music folder: ${link}`);
  } else {
    await ctx.reply('No sheet music link set yet. Use `/music <url>` to set one.');
  }
}

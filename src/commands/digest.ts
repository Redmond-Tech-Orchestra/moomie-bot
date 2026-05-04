import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('digest')
  .setDescription('Get a structured summary of recent server activity — status, decisions, and follow-ups')
  .addStringOption((option) =>
    option
      .setName('window')
      .setDescription('How far back to look (e.g. 4h, 1d, 2w, 3m). Default: 1w')
      .setRequired(false)
  );

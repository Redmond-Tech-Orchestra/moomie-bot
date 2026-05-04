import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('remind')
  .setDescription('Set a reminder (e.g. "in 2 hours @Sarah to check the PR")')
  .addStringOption((option) =>
    option
      .setName('text')
      .setDescription('e.g. "@Sarah in 2 hours to check the PR" or "#general tomorrow at 3pm meeting"')
      .setRequired(true)
  );


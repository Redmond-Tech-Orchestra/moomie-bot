import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('feedback')
  .setDescription('Report something Moomie got wrong — she will investigate and try to fix herself')
  .addStringOption((option) =>
    option
      .setName('text')
      .setDescription('Describe what went wrong')
      .setRequired(true)
  );

import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('music')
  .setDescription('Get or set the link to the shared sheet music folder')
  .addStringOption((option) =>
    option
      .setName('link')
      .setDescription('Set a new sheet music folder URL (leave empty to get current link)')
      .setRequired(false)
  );

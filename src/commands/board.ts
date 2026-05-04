import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('board')
  .setDescription('Show event-centric status view — tracked items, overdue, unowned')
  .addIntegerOption((option) =>
    option
      .setName('event')
      .setDescription('Which event to show (uses autocomplete)')
      .setRequired(false)
      .setAutocomplete(true)
  );

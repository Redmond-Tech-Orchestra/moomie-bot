import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('board')
  .setDescription('Show swimlane status view — tracked items, overdue, unowned')
  .addIntegerOption((option) =>
    option
      .setName('event')
      .setDescription('Which event or swimlane to show (uses autocomplete)')
      .setRequired(false)
      .setAutocomplete(true)
  );

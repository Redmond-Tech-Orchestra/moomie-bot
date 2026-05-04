import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('events')
  .setDescription('List upcoming orchestra events with dates and T-minus countdowns');

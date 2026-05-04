import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('website')
  .setDescription('Create a website issue and have Moomie work on it')
  .addStringOption((option) =>
    option
      .setName('task')
      .setDescription('Describe what needs to be done')
      .setRequired(true)
  )
  .addAttachmentOption((option) =>
    option
      .setName('file1')
      .setDescription('Attach an image or file (e.g. screenshot, PDF)')
      .setRequired(false)
  )
  .addAttachmentOption((option) =>
    option
      .setName('file2')
      .setDescription('Second attachment (optional)')
      .setRequired(false)
  )
  .addAttachmentOption((option) =>
    option
      .setName('file3')
      .setDescription('Third attachment (optional)')
      .setRequired(false)
  );


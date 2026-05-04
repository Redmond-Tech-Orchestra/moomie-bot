import { REST, Routes } from 'discord.js';
import { loadCommands } from './commands/slash-commands.js';
import { DISCORD_CLIENT_ID, DISCORD_GUILD_ID } from './config.js';
import 'dotenv/config';

const commands = await loadCommands();
const commandData = commands.map((c) => c.data.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);
const clientId = DISCORD_CLIENT_ID;
const guildId = DISCORD_GUILD_ID;

try {
  // Register globally (works in DMs + all servers)
  console.log(`Registering ${commandData.length} global commands...`);
  await rest.put(
    Routes.applicationCommands(clientId),
    { body: commandData }
  );
  console.log('Global commands registered.');

  // Clear any leftover guild-scoped commands (they cause duplicates)
  if (guildId) {
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: [] }
    );
    console.log(`Cleared guild commands from ${guildId}.`);
  }
} catch (err) {
  console.error('Failed to register commands:', err);
}

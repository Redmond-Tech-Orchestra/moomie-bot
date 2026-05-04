import { REST, Routes } from 'discord.js';
import { loadCommands } from './commands/slash-commands.js';
import 'dotenv/config';

const commands = await loadCommands();
const commandData = commands.map((c) => c.data.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);
const clientId = process.env.DISCORD_CLIENT_ID!;
const guildId = process.env.DISCORD_GUILD_ID;

try {
  if (guildId) {
    console.log(`Registering ${commandData.length} guild commands to ${guildId}...`);
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commandData }
    );
    console.log('Guild commands registered (instant).');
  } else {
    console.log(`Registering ${commandData.length} global commands...`);
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commandData }
    );
    console.log('Global commands registered (may take up to 1 hour to propagate).');
  }
} catch (err) {
  console.error('Failed to register commands:', err);
}

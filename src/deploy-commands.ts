import { REST, Routes } from 'discord.js';
import { loadCommands } from './commands/index.js';
import 'dotenv/config';

const commands = await loadCommands();
const commandData = commands.map((c) => c.data.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

try {
  console.log(`Registering ${commandData.length} slash commands...`);
  await rest.put(
    Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!),
    { body: commandData }
  );
  console.log('Slash commands registered.');
} catch (err) {
  console.error('Failed to register commands:', err);
}

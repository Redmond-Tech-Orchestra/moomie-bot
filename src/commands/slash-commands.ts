import fs from 'node:fs';
import path from 'node:path';
import { Collection } from 'discord.js';
import { fileURLToPath } from 'node:url';
import type { CommandDefinition, CommandDefinitionCollection } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function loadCommands(): Promise<CommandDefinitionCollection> {
  const commands: CommandDefinitionCollection = new Collection();
  const exclude = ['index', 'handlers', 'command-registry', 'slash-commands'];
  const files = fs.readdirSync(__dirname)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts'))
    .filter((f) => !exclude.some((e) => f.startsWith(e)));

  for (const file of files) {
    const command = (await import(`./${file}`)) as CommandDefinition;
    commands.set(command.data.name, command);
  }

  return commands;
}

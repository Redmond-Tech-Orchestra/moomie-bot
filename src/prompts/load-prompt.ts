import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cache = new Map<string, string>();
let personaCache: string | null = null;

function getPersona(): string {
  if (!personaCache) {
    personaCache = fs.readFileSync(path.join(__dirname, 'persona.md'), 'utf-8');
  }
  return personaCache;
}

/**
 * Load a prompt template from src/prompts/ and replace placeholders with values.
 * Templates use {{PLACEHOLDER}} syntax.
 * The persona (persona.md) is automatically prepended unless `skipPersona` is true.
 */
export function loadPrompt(filename: string, vars: Record<string, string> = {}, skipPersona = false): string {
  if (!cache.has(filename)) {
    const filePath = path.join(__dirname, filename);
    cache.set(filename, fs.readFileSync(filePath, 'utf-8'));
  }

  let text = cache.get(filename)!;
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }

  if (!skipPersona) {
    text = getPersona() + '\n---\n\n' + text;
  }

  return text;
}

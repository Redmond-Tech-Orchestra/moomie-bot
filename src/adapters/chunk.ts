/**
 * Discord caps a single message at 2000 chars. Split on blank-line section
 * boundaries when possible, falling back to line boundaries; never break in
 * the middle of a line unless a single line itself exceeds `max`.
 */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  const sections = text.split(/\n\n+/);
  let current = '';
  const flush = (): void => {
    if (current.length > 0) { chunks.push(current); current = ''; }
  };
  for (const section of sections) {
    const candidate = current ? `${current}\n\n${section}` : section;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    flush();
    if (section.length <= max) {
      current = section;
    } else {
      for (const line of section.split('\n')) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length <= max) { current = next; continue; }
        flush();
        if (line.length <= max) { current = line; continue; }
        for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      }
    }
  }
  flush();
  return chunks;
}

/** Headroom under Discord's 2000-char hard limit. */
export const DISCORD_CHUNK_MAX = 1900;

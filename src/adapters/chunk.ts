/**
 * Discord caps a single message at 2000 chars. Split on blank-line section
 * boundaries when possible, falling back to line boundaries; never break in
 * the middle of a line unless a single line itself exceeds `max`.
 *
 * Fence-aware: if a chunk ends with an unclosed triple-backtick fence, the
 * fence is closed at the end of that chunk and reopened (with the same
 * language tag, if any) at the start of the next, so code blocks render
 * correctly across chunk boundaries.
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
  return repairFences(chunks);
}

/**
 * Walk chunks left-to-right tracking open ``` fences. If a chunk leaves a
 * fence open, close it (\`\`\`) and reopen the same language tag at the start
 * of the next chunk so each chunk is independently renderable.
 */
function repairFences(chunks: string[]): string[] {
  let openLang: string | null = null; // null = no open fence; '' = fenced without lang
  return chunks.map((chunk) => {
    let body = chunk;
    if (openLang !== null) {
      const prefix = openLang ? `\`\`\`${openLang}\n` : '```\n';
      body = prefix + body;
    }
    openLang = scanOpenFence(body);
    if (openLang !== null) {
      body = body.endsWith('\n') ? `${body}\`\`\`` : `${body}\n\`\`\``;
    }
    return body;
  });
}

/**
 * Returns the language tag of the trailing unclosed fence in `text` (empty
 * string if no language), or null if all fences are balanced.
 */
function scanOpenFence(text: string): string | null {
  const fenceRe = /^```([^\n`]*)$/gm;
  let open: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    if (open === null) {
      open = m[1].trim(); // language tag (may be empty)
    } else {
      open = null; // closing fence
    }
  }
  return open;
}

/** Headroom under Discord's 2000-char hard limit. */
export const DISCORD_CHUNK_MAX = 1900;

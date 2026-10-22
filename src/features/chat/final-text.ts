const MIN_DUPLICATE_UNIT_CHARS = 40;

/**
 * Some streaming model responses occasionally repeat the entire short answer
 * verbatim. Collapse only whole-response duplicates so intentional local
 * repetition inside a normal answer is preserved.
 */
export function collapseRepeatedFinalText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < MIN_DUPLICATE_UNIT_CHARS * 2) return trimmed;

  const exact = collapseExactHalves(trimmed);
  if (exact) return exact;

  const paragraphCollapsed = collapseRepeatedParagraphs(trimmed);
  return paragraphCollapsed ?? trimmed;
}

function collapseExactHalves(text: string): string | null {
  if (text.length % 2 !== 0) return null;

  const half = text.length / 2;
  if (half < MIN_DUPLICATE_UNIT_CHARS) return null;

  const first = text.slice(0, half).trim();
  const second = text.slice(half).trim();
  return first === second ? first : null;
}

function collapseRepeatedParagraphs(text: string): string | null {
  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length < 2 || paragraphs.length % 2 !== 0) return null;

  const half = paragraphs.length / 2;
  const first = paragraphs.slice(0, half).join('\n\n').trim();
  const second = paragraphs.slice(half).join('\n\n').trim();
  if (first.length < MIN_DUPLICATE_UNIT_CHARS) return null;

  return normalizeWhitespace(first) === normalizeWhitespace(second) ? first : null;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

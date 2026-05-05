/**
 * Parse a Performances channel name into event data.
 *
 * Patterns:
 *   <month>-<dates>-<name-parts...>   → full date + name
 *   <month>-<name-parts...>            → month only, no specific date
 *   <month-word>-<name-parts...>       → text month (e.g. "nov-concert")
 *
 * Examples:
 *   "7-1618-shakespeare"   → { month: 7, days: [16, 18], name: "Shakespeare" }
 *   "8-1-concerto"         → { month: 8, days: [1],      name: "Concerto" }
 *   "9-5-redmond-park"     → { month: 9, days: [5],      name: "Redmond Park" }
 *   "nov-concert"          → { month: 11, days: [],      name: "Concert" }
 *   "11-concert"           → { month: 11, days: [],      name: "Concert" }
 */
export interface ParsedChannel {
  month: number;
  days: number[];
  name: string;
  ambiguous: boolean;
  raw: string;
}

export function parseChannelName(channelName: string): ParsedChannel | null {
  const parts = channelName.split('-');
  if (parts.length < 2) return null;

  // Try numeric month first, then text month name
  let month = parseInt(parts[0], 10);
  if (isNaN(month) || month < 1 || month > 12) {
    month = parseMonthName(parts[0]);
    if (month === 0) return null;
  }

  // Check if second segment is a date or part of the name
  const secondPart = parts[1];
  const isDateSegment = /^\d+$/.test(secondPart);

  if (isDateSegment && parts.length >= 3) {
    // Full pattern: <month>-<dates>-<name...>
    const { days, ambiguous } = parseDateSegment(secondPart);
    if (days.length === 0 && !ambiguous) return null;

    const nameParts = parts.slice(2);
    const name = nameParts
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');

    return { month, days, name, ambiguous, raw: channelName };
  }

  // No date segment — treat everything after month as name
  const nameParts = parts.slice(1);
  const name = nameParts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');

  return { month, days: [], name, ambiguous: false, raw: channelName };
}

function parseDateSegment(segment: string): { days: number[]; ambiguous: boolean } {
  // Single or two-digit day
  if (segment.length <= 2) {
    const day = parseInt(segment, 10);
    if (day >= 1 && day <= 31) return { days: [day], ambiguous: false };
    return { days: [], ambiguous: false };
  }

  // Multi-digit: try splitting into 2-digit chunks
  if (segment.length % 2 === 0) {
    const days: number[] = [];
    for (let i = 0; i < segment.length; i += 2) {
      const day = parseInt(segment.slice(i, i + 2), 10);
      if (day < 1 || day > 31) return { days: [], ambiguous: true };
      days.push(day);
    }
    return { days, ambiguous: false };
  }

  // Odd length — ambiguous (e.g. "112" could be 1+12 or 11+2)
  return { days: [], ambiguous: true };
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function parseMonthName(s: string): number {
  return MONTH_NAMES[s.toLowerCase()] ?? 0;
}

/**
 * Compute the event date(s) from parsed channel data.
 * Infers year as the next occurrence of that month from today.
 */
export function computeEventDates(parsed: ParsedChannel, today: Date = new Date()): { date: string; end_date: string | null } {
  const year = inferYear(parsed.month, today);
  const firstDay = Math.min(...parsed.days);
  const lastDay = Math.max(...parsed.days);

  const date = formatDate(year, parsed.month, firstDay);
  const end_date = parsed.days.length > 1 ? formatDate(year, parsed.month, lastDay) : null;

  return { date, end_date };
}

function inferYear(month: number, today: Date): number {
  const currentMonth = today.getMonth() + 1; // 1-indexed
  const currentYear = today.getFullYear();
  // If the month has already passed this year, use next year
  return month < currentMonth ? currentYear + 1 : currentYear;
}

function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

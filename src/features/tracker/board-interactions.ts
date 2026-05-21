import {
  ActionRowBuilder,
  ComponentType,
  StringSelectMenuBuilder,
  type APIMessageComponentEmoji,
  type APISelectMenuOption,
  type StringSelectMenuComponent,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { getDb } from '../../db.js';
import { markItemDone, type TrackerItem } from './store.js';
import { createLogger } from '../../logger.js';

const log = createLogger('BoardActions');

const SELECT_DONE_ID = 'board:done';

/**
 * Build the dropdown row for "mark items done". Returns [] if no items.
 * Caller should attach the result to a message via `components: [...]`.
 *
 * Up to 25 items per Discord's select-menu option limit. Caller is responsible
 * for picking and ordering the most actionable subset.
 *
 * Optional `groups` maps a primary item id → all merged source ids (from LLM
 * consolidation). When an item's id appears as a key, the option's value is
 * encoded as the comma-joined id list (e.g. "38,39") so picking it closes
 * every merged item at once.
 *
 * Optional `overrides` maps a primary id → consolidated description/owner so
 * the dropdown label reads the LLM's merged text rather than the raw primary
 * item's description (keeps dropdown in sync with the printed board).
 */
export function buildBoardActionRows(
  items: TrackerItem[],
  groups: Map<number, number[]> = new Map(),
  overrides: Map<number, { description: string; owner: string | null }> = new Map(),
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const selectable = items.slice(0, 25);
  if (selectable.length === 0) return [];

  const select = new StringSelectMenuBuilder()
    .setCustomId(SELECT_DONE_ID)
    .setPlaceholder(`Mark items done… (up to ${selectable.length})`)
    .setMinValues(1)
    .setMaxValues(selectable.length)
    .addOptions(selectable.map((item) => {
      const groupedIds = groups.get(item.id);
      const override = overrides.get(item.id);
      const description = override?.description ?? item.description;
      const ownerStr = override?.owner ?? item.owner_name ?? 'unassigned';
      const idTag = `#${item.id} `;
      const labelMax = 100 - idTag.length;
      const label = idTag + truncate(description, labelMax);
      const dueStr = item.target_date ? ` · due ${item.target_date}` : '';
      const groupNote = groupedIds && groupedIds.length > 1
        ? ` · merges ${groupedIds.length} items`
        : '';
      return {
        label,
        value: groupedIds && groupedIds.length > 1 ? groupedIds.join(',') : String(item.id),
        description: truncate(`${ownerStr}${dueStr}${groupNote}`, 100),
        emoji: pickEmoji(item),
      };
    }));

  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
}

/**
 * Returns true if this select-menu interaction is one we own.
 */
export function isBoardSelect(customId: string): boolean {
  return customId === SELECT_DONE_ID;
}

/**
 * Handle the "mark items done" dropdown submission. Marks each selected item
 * (or merged group of items) as done in the DB, then updates the original
 * message: each closed line gets struck through, and the dropdown is
 * rebuilt with closed options removed so the user can keep closing
 * remaining items from the same message.
 */
export async function handleBoardSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  // Each selected value may be a single id ("42") or a comma-joined group
  // ("38,39") representing items the LLM consolidation merged.
  const itemIds = interaction.values
    .flatMap((v) => v.split(','))
    .map((v) => parseInt(v.trim(), 10))
    .filter((n) => !isNaN(n));
  // Dedup in case the same id appears in multiple selected groups.
  const uniqueIds = Array.from(new Set(itemIds));
  if (uniqueIds.length === 0) {
    await interaction.update({ content: interaction.message.content ?? '*(nothing selected)*' });
    return;
  }

  const db = getDb();
  const lookup = db.prepare(`SELECT id, description, status FROM items WHERE id = ?`);
  const closed: { id: number; description: string }[] = [];
  const skipped: { id: number; reason: string }[] = [];

  for (const id of uniqueIds) {
    const row = lookup.get(id) as { id: number; description: string; status: string } | undefined;
    if (!row) {
      skipped.push({ id, reason: 'not found' });
      continue;
    }
    if (row.status === 'done') {
      skipped.push({ id, reason: 'already done' });
      continue;
    }
    markItemDone(id);
    closed.push({ id, description: row.description });
  }

  log.info(`User ${interaction.user.username} closed ${closed.length} item(s) via /board: ${closed.map((c) => `#${c.id}`).join(', ')}`);

  const closedIdSet = new Set(closed.map((c) => c.id));

  // Rebuild message content: strike-through any line whose `#N` tags are all closed.
  const oldContent = interaction.message.content ?? '';
  const newContent = strikeClosedLines(oldContent, closedIdSet, { closed: closed.length, skipped: skipped.length });

  // Rebuild dropdown(s) with closed options removed.
  const newComponents: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  for (const row of interaction.message.components) {
    if (row.type !== ComponentType.ActionRow) continue;
    for (const comp of row.components) {
      if (comp.type !== ComponentType.StringSelect) continue;
      const select = comp as StringSelectMenuComponent;
      const remaining = select.options.filter((opt) => {
        const ids = opt.value.split(',').map((v) => parseInt(v.trim(), 10)).filter((n) => !isNaN(n));
        // Drop the option if any of its ids was just closed.
        return !ids.some((id) => closedIdSet.has(id));
      });
      if (remaining.length === 0) continue;
      newComponents.push(buildRebuiltSelect(select.customId, remaining));
    }
  }

  await interaction.update({ content: newContent.slice(0, 1900), components: newComponents });
}

/**
 * Wrap board lines whose backticked `#N` (or `#N,#M,...`) ids are all in
 * `closedIdSet` with Discord strike-through (`~~...~~`). Lines without any id
 * tags (section headers, hints, blanks) are preserved. Appends a one-line
 * confirmation footer.
 */
function strikeClosedLines(content: string, closedIdSet: Set<number>, summary: { closed: number; skipped: number }): string {
  const idTagRegex = /`#(\d+(?:,#\d+)*)`/g;
  const newLines = content.split('\n').map((line) => {
    const matches = [...line.matchAll(idTagRegex)];
    if (matches.length === 0) return line;
    const lineIds: number[] = [];
    for (const m of matches) {
      for (const part of m[1].split(',#')) {
        const n = parseInt(part, 10);
        if (!isNaN(n)) lineIds.push(n);
      }
    }
    if (lineIds.length === 0) return line;
    if (lineIds.every((id) => closedIdSet.has(id))) return `~~${line}~~`;
    return line;
  });

  const footer = summary.closed > 0
    ? `\n\n*✅ Closed ${summary.closed} item${summary.closed === 1 ? '' : 's'}${summary.skipped > 0 ? ` · skipped ${summary.skipped}` : ''}*`
    : summary.skipped > 0
      ? `\n\n*⚠️ Skipped ${summary.skipped} (already done or missing)*`
      : '';
  return newLines.join('\n') + footer;
}

/** Clone a select menu's surviving options into a fresh row. */
function buildRebuiltSelect(customId: string, options: readonly APISelectMenuOption[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(`Mark items done… (up to ${options.length})`)
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options.map((o) => ({
      label: o.label,
      value: o.value,
      description: o.description ?? undefined,
      emoji: (o.emoji ?? undefined) as APIMessageComponentEmoji | undefined,
    })));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function pickEmoji(item: TrackerItem): string | undefined {
  if (item.status === 'stale') return '⏸️';
  if (item.target_date) {
    const target = new Date(item.target_date + 'T00:00:00');
    if (target < new Date()) return '🔴';
    const sevenDays = 1000 * 60 * 60 * 24 * 7;
    if (target.getTime() - Date.now() < sevenDays) return '🟡';
  }
  return undefined;
}

/**
 * Eventbrite analytics — Pro-driven write/run/observe loop.
 *
 * Shape:
 *   chat LLM (flash) decides this question warrants analytics
 *     → calls `analyze_eventbrite({ question })`
 *       → this module: loops up to MAX_ITERATIONS, each iteration is a single
 *         Gemini Pro call with two function-call tools (`run_python_code`,
 *         `finalize`). Pro writes code, sees stdout/stderr, decides whether
 *         to write more or finalize.
 *     → returns { answer, transcript } to chat LLM
 *   chat LLM narrates the result for the user
 *
 * Pro never reaches the network or process secrets — its tools only do (a)
 * "run this python", which goes through the stripped-env runner, and (b)
 * "finalize", which just returns text.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { EVENTBRITE_DATA_DIR, MODEL_EXTRACT, geminiUrl } from '../../config.js';
import { createLogger } from '../../logger.js';
import { runPython } from '../sandbox/python-runner.js';

const log = createLogger('Eventbrite.analyze');

const MAX_ITERATIONS = 5;
const PYTHON_TIMEOUT_MS = 60_000;

// ─── Schema doc (embedded in Pro's prompt) ───────────────────────────────────

const SCHEMA_DOC = `
# Eventbrite archive layout

The archive lives at the absolute path provided to your code in the
\`EVENTBRITE_DATA_DIR\` environment variable (also passed at runtime as a
literal string you can read with \`os.environ['EVENTBRITE_DATA_DIR']\`).

Directory tree:

    {EVENTBRITE_DATA_DIR}/
      events/
        {event_id}/
          _meta.json
          event.json
          attendees.json
          orders.json
          ticket_classes.json
          description.json
          structured_content.json     (may be absent)
          questions.json              (may be absent)
          canned_questions.json       (may be absent)
          display_settings.json       (may be absent)
          reports/
            sales.json                (may be absent)
            attendees.json            (may be absent)

## File contents

- **_meta.json**: \`{ event_id, event_name, event_end, synced_at, frozen,
  sync_count, attendee_count, order_count }\`. Use this to enumerate events
  cheaply (\`glob('events/*/_meta.json')\`).

- **event.json**: Raw Eventbrite event blob with expansions. Notable fields:
  \`id\`, \`name.text\`, \`start.utc\`, \`end.utc\`, \`url\`, \`venue\` (when
  expanded), \`organizer\`, \`ticket_classes\` (with \`quantity_sold\`,
  \`quantity_total\`, \`cost.major_value\`), \`logo.url\` (event banner),
  \`category\` and \`subcategory\`, \`music_properties\` (door_time,
  presented_by, age_restriction), \`refund_policy\` (refund window/terms
  — useful when reconciling refunded orders), and \`ticket_availability\`
  (aggregate sales/availability snapshot across all ticket classes at
  the time of sync).

- **attendees.json**: Envelope \`{ source, retrieved_at, object_count, items: [...] }\`.
  Each attendee item has:
    - \`id\`, \`order_id\`, \`event_id\`, \`ticket_class_id\`, \`ticket_class_name\`
    - \`status\` — Title-Case display string. Per Eventbrite's API blueprint
      the field falls into one of two filter buckets:
        * "attending" bucket: \`'Attending'\` (registered, not yet scanned)
          or \`'Checked In'\` (scanned at the door).
        * "not_attending" bucket: \`'Not Attending'\` or \`'Deleted'\`
          (refunded, cancelled, or removed by the organizer).
      The snapshot intentionally pulls **all** of these (no \`?status=\`
      filter at fetch time) so the frozen archive is complete. Always
      inspect distinct values before assuming — e.g.
      \`Counter(a['status'] for a in items)\`.
    - \`checked_in\` (boolean) — perfectly correlates with
      \`status == 'Checked In'\`; prefer this field for
      "actually showed up" checks.
    - \`refunded\`, \`cancelled\` (booleans) — true for rows in the
      not_attending bucket; false for active registrations.
    - \`profile\`: \`{ name, first_name, last_name, email, ... }\` — PII, handle carefully
    - \`costs\`: \`{ base_price.major_value, gross.major_value, eventbrite_fee.major_value, ... }\`
    - \`barcodes\`: list of \`{ barcode, status ('unused'|'used'|'refunded'|'unpaid'),
      created, changed, checkin_type }\` — \`status='used'\` means checked in;
      \`changed\` is the scan timestamp.
    - \`answers\`: list of \`{ question, answer, type, question_id }\` for custom
      registration questions.
    - \`created\`, \`changed\`: ISO timestamps.

  ## Counting attendance correctly (READ THIS)

  The word "attendees" is ambiguous and routinely misleading. Always be
  precise about which figure you mean:

  - **Tickets issued / registered**: rows where
    \`status in ('Attending', 'Checked In')\` — i.e. neither refunded nor
    cancelled. This is what Eventbrite labels "attendees" in its
    dashboard.
  - **Actually attended (door scans)**: rows where \`checked_in == True\`
    (equivalently \`status == 'Checked In'\`).
  - **No-shows / didn't show up**: rows where
    \`status == 'Attending'\` (registered but never scanned at the door).
    Counter-intuitive but critical: once someone checks in, their status
    flips from \`'Attending'\` to \`'Checked In'\`, so rows still labelled
    \`'Attending'\` after the event are precisely the no-shows. Across our
    archive this is typically ~half of registrants.
  - **Refunded / cancelled**: rows where \`refunded == True\` or
    \`cancelled == True\` (status \`'Not Attending'\` or \`'Deleted'\`).
    Exclude these from any registration or revenue total.
  - **Do NOT** filter by \`status == 'Attending'\` and call that the total —
    that excludes the people who actually showed up (\`'Checked In'\`).

  ### Mapping user language to the right column

  When the user's question uses informal words, default to this mapping
  unless they're clearly asking about the registration funnel:

  - "people", "customers", "audience", "folks who came",
    "people who showed up", "attended", "turnout"
    → \`checked_in == True\` (actually walked through the door).
  - "attendees" (used explicitly), "registrants", "tickets sold",
    "sign-ups"
    → registered set: \`status in ('Attending', 'Checked In')\`.
  - "showed up rate", "attendance rate", "% who came"
    → numerator \`checked_in == True\`, denominator registered set.
  - "no-show rate"
    → numerator \`status == 'Attending'\` (post-event), denominator
    registered set.

  ### Distinguishing ticket classes

  Ticket names are NOT guaranteed to be unique within an event. For example,
  an event may have multiple classes named "ADA Seating" with different
  prices (e.g. one free, one $10).

  - **Always group by \`ticket_class_id\`** (or a combination of name and price)
    rather than just \`ticket_class_name\` to avoid collapsing distinct tiers.
  - When presenting a breakdown, include the price (from \`costs\`) if the
    names are identical or if it's relevant to the question.

  ### Don't relabel columns in output

  When presenting tabular results, keep the raw column names and status
  values as they appear in the data (\`status\`, \`'Attending'\`,
  \`'Checked In'\`, \`checked_in\`). Do **not** rename \`status\` to
  "attended" or rewrite \`'Attending'\` to "no-show" inside a results
  table — that hides the source of the number and makes the output
  un-auditable. Add a separate prose sentence explaining what the values
  mean if needed, but leave the underlying labels intact.

- **orders.json**: Envelope \`{ ..., items: [...] }\`. Each order:
    - \`id\`, \`event_id\`, \`status\` ('placed', 'refunded', ...)
    - \`first_name\`, \`last_name\`, \`email\`, \`name\` — PII
    - \`costs\`: nested money objects with \`.major_value\` (string decimal)
    - \`attendees\`: list of attendee IDs in this order
    - \`time_remaining\`, \`created\`, \`changed\`.

- **ticket_classes.json**: Array of ticket-type definitions with \`id\`, names, prices
  (\`cost.display\`, \`cost.major_value\`), \`quantity_total\`, \`quantity_sold\`.

- **reports/sales.json**: Aggregated revenue. Top-level summary has
  \`gross\`, \`net\`, \`fees\` (Eventbrite's nested money format). Per-ticket
  breakdown under \`data\` or similar (varies — inspect first).

- **reports/attendees.json**: Aggregated attendee counts. Top-level has
  \`attendees.num_attendees\`, \`attendees.num_orders\`. \`data\` array has
  per-grouping rows (group_by=ticket → one row per ticket class).

## Conventions

- All money values are returned as **strings** in Eventbrite's "major_value"
  field (e.g. \`"42.50"\`). Cast with \`Decimal\` or \`float\` as needed.
- Timestamps are ISO 8601 in UTC ("Z" suffix). Use \`datetime.fromisoformat\`
  (Python 3.11+) which handles the "Z".
- A frozen event (\`_meta.frozen == true\`) means data is immutable; safe to
  cache aggressively.

## Environment you have

- Python 3.12+ with pandas, numpy, matplotlib, json, glob, pathlib, datetime, decimal.
- **No network access available.** Don't try to call URLs.
- **No secrets in env.** \`os.environ\` only contains PATH, locale, and
  \`EVENTBRITE_DATA_DIR\`.

## Output contract

- Print results to **stdout**. Final answer should be plain text or JSON.
- For tabular results, print as Markdown table or JSON.
- Keep stdout under 64 KB (will be truncated otherwise).

## File outputs (CSV exports, chart images)

When the user asks for raw data, a download, or anything bigger than fits
in a Discord message, write it as a file to the **current working
directory** instead of dumping it to stdout. Same for charts when a
visualization communicates the answer better than prose.

**Never print ASCII bar charts, sparklines, or hand-drawn diagrams to
stdout.** If a chart would help the answer, you MUST save it as a PNG
in the cwd using matplotlib — not as printed text. Discord renders the
PNG inline; an ASCII chart looks broken there.

Chart example (save as PNG, do not print):
\`\`\`
import matplotlib.pyplot as plt
ax = df.plot.bar(x='day', y='sold', figsize=(10, 4))
ax.set_title('Daily ticket sales — Symphonic Fantasia')
plt.tight_layout()
plt.savefig('sales-symphonic-fantasia.png', dpi=150, bbox_inches='tight')
plt.close()
print('saved sales-symphonic-fantasia.png')
\`\`\`

Raw data export (save as CSV, do not dump the whole df to stdout):
\`\`\`
df.to_csv('attendees-2024.csv', index=False)
print(f'saved attendees-2024.csv ({len(df)} rows)')
\`\`\`

Files matching \`*.csv\` and \`*.png\` in cwd are collected after each run
and surfaced to the user as Discord attachments. Use descriptive,
lowercase, hyphenated filenames (\`attendees-2024.csv\`, not \`out.csv\`).
Keep each file under 5 MB. Caps: max 5 files per analysis. After
saving, print a short confirmation line (e.g. \`saved chart.png\`) — don't
repeat the data in the answer.
`.trim();

// ─── Pro function-call tools (what Pro can call inside the loop) ─────────────

const PRO_TOOL_DECLARATIONS = [
  {
    name: 'run_python_code',
    description:
      'Execute Python in a sandbox with read access to the Eventbrite archive at $EVENTBRITE_DATA_DIR. ' +
      'pandas/numpy preinstalled. No network. Returns stdout, stderr, exit_code, duration_ms.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source. Print results to stdout.' },
        reason: {
          type: 'string',
          description: 'Brief one-line note on what this iteration is trying to accomplish.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'finalize',
    description: 'Submit the final natural-language answer to the question. Call this when you have what you need.',
    parameters: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'The final answer to the user\'s question.' },
        summary: { type: 'string', description: 'Brief note on what you did to arrive at this.' },
      },
      required: ['answer'],
    },
  },
];

// ─── Public types ────────────────────────────────────────────────────────────

export interface AnalyzeFile {
  name: string;
  data: Buffer;
  from_iteration: number;
}

export interface AnalyzeResult {
  answer: string | null;
  summary: string | null;
  transcript: Array<{
    iteration: number;
    code?: string;
    reason?: string;
    stdout?: string;
    stderr?: string;
    exit_code?: number | null;
    duration_ms?: number;
    timed_out?: boolean;
    files_produced?: string[];
  }>;
  iterations_used: number;
  total_duration_ms: number;
  /** CSV/PNG artifacts written to the sandbox cwd, aggregated across iterations. */
  files?: AnalyzeFile[];
  error?: string;
}

// ─── Public entry point ──────────────────────────────────────────────────────

export async function analyze(question: string, context?: string): Promise<AnalyzeResult> {
  const t0 = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return errorResult(t0, 'GEMINI_API_KEY is not set');
  }

  const dataDirAbs = resolve(EVENTBRITE_DATA_DIR);
  if (!existsSync(dataDirAbs)) {
    return errorResult(t0, `Archive dir does not exist: ${dataDirAbs}. Run sync_eventbrite_archive first.`);
  }

  const systemPrompt = buildSystemPrompt(dataDirAbs);
  const userMessage = context ? `${question}\n\nAdditional context:\n${context}` : question;
  const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: userMessage }] }];

  const transcript: AnalyzeResult['transcript'] = [];
  const collectedFiles: AnalyzeFile[] = [];

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    const response = await callGeminiPro(apiKey, systemPrompt, contents);
    if ('error' in response) {
      return finishResult(t0, transcript, iter, null, null, collectedFiles, `Gemini call failed: ${response.error}`);
    }

    const parts = response.data.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      return finishResult(t0, transcript, iter, null, null, collectedFiles, 'Gemini returned no parts');
    }

    contents.push({ role: 'model', parts });

    // Find the first function call (we only honor one per iteration).
    const fnCall = parts.find((p) => p.functionCall)?.functionCall;
    if (!fnCall) {
      // Pro returned plain text without calling a tool — treat as final answer.
      const text = (parts.find((p) => p.text)?.text as string) ?? '';
      return finishResult(t0, transcript, iter, text || null, null, collectedFiles);
    }

    if (fnCall.name === 'finalize') {
      const answer = (fnCall.args?.answer as string) ?? null;
      const summary = (fnCall.args?.summary as string) ?? null;
      return finishResult(t0, transcript, iter, answer, summary, collectedFiles);
    }

    if (fnCall.name === 'run_python_code') {
      const code = (fnCall.args?.code as string) ?? '';
      const reason = (fnCall.args?.reason as string) ?? '';
      const result = await runPython({
        code,
        timeoutMs: PYTHON_TIMEOUT_MS,
        env: { EVENTBRITE_DATA_DIR: dataDirAbs },
        collectFiles: { extensions: ['.csv', '.png'] },
      });

      const filesProduced: string[] = [];
      for (const f of result.files ?? []) {
        const finalName = uniqueFileName(f.name, collectedFiles);
        collectedFiles.push({ name: finalName, data: f.data, from_iteration: iter });
        filesProduced.push(finalName);
      }

      transcript.push({
        iteration: iter,
        code,
        reason,
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        timed_out: result.timed_out,
        files_produced: filesProduced.length ? filesProduced : undefined,
      });

      log.info(
        `iter=${iter} code=${code.length}b exit=${result.exit_code} dur=${result.duration_ms}ms stdout=${result.stdout.length}b stderr=${result.stderr.length}b files=${filesProduced.length}${result.timed_out ? ' TIMED_OUT' : ''}`,
      );

      // Feed the result back as the function response.
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'run_python_code',
              response: {
                exit_code: result.exit_code,
                stdout: result.stdout,
                stderr: result.stderr,
                duration_ms: result.duration_ms,
                timed_out: result.timed_out,
                stdout_truncated: result.stdout_truncated,
                stderr_truncated: result.stderr_truncated,
                files_produced: filesProduced,
              },
            },
          },
        ],
      });
      continue;
    }

    // Unknown function name — tell Pro and continue.
    contents.push({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: fnCall.name,
            response: { error: `Unknown tool: ${fnCall.name}. Use run_python_code or finalize.` },
          },
        },
      ],
    });
  }

  return finishResult(t0, transcript, MAX_ITERATIONS, null, null, collectedFiles, `Hit max iterations (${MAX_ITERATIONS}) without finalizing`);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(dataDirAbs: string): string {
  return `You are a data analyst assistant for the Redmond Tech Orchestra's Eventbrite archive.

A user has asked a question that requires analysis over the archive on disk. You have two tools:

1. **run_python_code(code, reason?)** — runs Python in a sandbox. \`os.environ['EVENTBRITE_DATA_DIR']\` is set to:
   \`${dataDirAbs}\`
   You see only stdout/stderr/exit_code back. No network. pandas/numpy preinstalled.

2. **finalize(answer, summary?)** — submit your final natural-language answer.

Iterate as needed (up to ${MAX_ITERATIONS} iterations): write code, observe stdout/stderr, refine.
When you have enough to answer, call finalize.

Be concise. Don't print enormous dataframes; aggregate first. For raw data
the user can take away, write a CSV file to the current directory rather
than dumping to stdout. **If a chart is needed, save it as a PNG with
matplotlib — NEVER print an ASCII bar chart, sparkline, or text-art
diagram.** Files written to cwd are auto-attached to the reply.

${SCHEMA_DOC}`;
}

interface GeminiContent {
  role: string;
  parts: Array<{
    text?: string;
    functionCall?: { name: string; args?: Record<string, unknown> };
    functionResponse?: { name: string; response: Record<string, unknown> };
  }>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name: string; args?: Record<string, unknown> };
      }>;
    };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

async function callGeminiPro(
  apiKey: string,
  systemPrompt: string,
  contents: GeminiContent[],
): Promise<{ data: GeminiResponse } | { error: string }> {
  try {
    const res = await fetch(`${geminiUrl(MODEL_EXTRACT)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: [{ functionDeclarations: PRO_TOOL_DECLARATIONS }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      log.error(`Gemini Pro error ${res.status}:`, body);
      return { error: `${res.status} ${res.statusText}` };
    }

    return { data: await res.json() as GeminiResponse };
  } catch (err) {
    log.error('Gemini Pro call failed:', err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function finishResult(
  t0: number,
  transcript: AnalyzeResult['transcript'],
  iterations: number,
  answer: string | null,
  summary: string | null,
  files: AnalyzeFile[],
  error?: string,
): AnalyzeResult {
  return {
    answer,
    summary,
    transcript,
    iterations_used: iterations,
    total_duration_ms: Date.now() - t0,
    files: files.length ? files : undefined,
    error,
  };
}

function uniqueFileName(name: string, existing: AnalyzeFile[]): string {
  if (!existing.some((e) => e.name === name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!existing.some((e) => e.name === candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

function errorResult(t0: number, error: string): AnalyzeResult {
  return {
    answer: null,
    summary: null,
    transcript: [],
    iterations_used: 0,
    total_duration_ms: Date.now() - t0,
    error,
  };
}

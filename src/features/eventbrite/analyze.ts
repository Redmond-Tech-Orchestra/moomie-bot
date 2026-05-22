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
  \`quantity_total\`, \`cost.major_value\`).

- **attendees.json**: Envelope \`{ source, retrieved_at, object_count, items: [...] }\`.
  Each attendee item has:
    - \`id\`, \`order_id\`, \`event_id\`, \`ticket_class_id\`, \`ticket_class_name\`
    - \`status\` ('attending', 'not_attending', 'unpaid', ...)
    - \`checked_in\` (boolean)
    - \`profile\`: \`{ name, first_name, last_name, email, ... }\` — PII, handle carefully
    - \`costs\`: \`{ base_price.major_value, gross.major_value, eventbrite_fee.major_value, ... }\`
    - \`barcodes\`: list of \`{ barcode, status ('unused'|'used'|'refunded'|'unpaid'),
      created, changed, checkin_type }\` — \`status='used'\` means checked in;
      \`changed\` is the scan timestamp.
    - \`answers\`: list of \`{ question, answer, type, question_id }\` for custom
      registration questions.
    - \`created\`, \`changed\`: ISO timestamps.

- **orders.json**: Envelope \`{ ..., items: [...] }\`. Each order:
    - \`id\`, \`event_id\`, \`status\` ('placed', 'refunded', ...)
    - \`first_name\`, \`last_name\`, \`email\`, \`name\` — PII
    - \`costs\`: nested money objects with \`.major_value\` (string decimal)
    - \`attendees\`: list of attendee IDs in this order
    - \`time_remaining\`, \`created\`, \`changed\`.

- **ticket_classes.json**: Array of ticket-type definitions with prices
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

- Python 3.12+ with pandas, numpy, json, glob, pathlib, datetime, decimal.
- **No network access available.** Don't try to call URLs.
- **No secrets in env.** \`os.environ\` only contains PATH, locale, and
  \`EVENTBRITE_DATA_DIR\`.

## Output contract

- Print results to **stdout**. Final answer should be plain text or JSON.
- For tabular results, print as Markdown table or JSON.
- Keep stdout under 64 KB (will be truncated otherwise).
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
  }>;
  iterations_used: number;
  total_duration_ms: number;
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

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    const response = await callGeminiPro(apiKey, systemPrompt, contents);
    if ('error' in response) {
      return finishResult(t0, transcript, iter, null, null, `Gemini call failed: ${response.error}`);
    }

    const parts = response.data.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      return finishResult(t0, transcript, iter, null, null, 'Gemini returned no parts');
    }

    contents.push({ role: 'model', parts });

    // Find the first function call (we only honor one per iteration).
    const fnCall = parts.find((p) => p.functionCall)?.functionCall;
    if (!fnCall) {
      // Pro returned plain text without calling a tool — treat as final answer.
      const text = (parts.find((p) => p.text)?.text as string) ?? '';
      return finishResult(t0, transcript, iter, text || null, null);
    }

    if (fnCall.name === 'finalize') {
      const answer = (fnCall.args?.answer as string) ?? null;
      const summary = (fnCall.args?.summary as string) ?? null;
      return finishResult(t0, transcript, iter, answer, summary);
    }

    if (fnCall.name === 'run_python_code') {
      const code = (fnCall.args?.code as string) ?? '';
      const reason = (fnCall.args?.reason as string) ?? '';
      const result = await runPython({
        code,
        timeoutMs: PYTHON_TIMEOUT_MS,
        env: { EVENTBRITE_DATA_DIR: dataDirAbs },
      });

      transcript.push({
        iteration: iter,
        code,
        reason,
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        timed_out: result.timed_out,
      });

      log.info(
        `iter=${iter} code=${code.length}b exit=${result.exit_code} dur=${result.duration_ms}ms stdout=${result.stdout.length}b stderr=${result.stderr.length}b${result.timed_out ? ' TIMED_OUT' : ''}`,
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

  return finishResult(t0, transcript, MAX_ITERATIONS, null, null, `Hit max iterations (${MAX_ITERATIONS}) without finalizing`);
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

Be concise. Don't print enormous dataframes; aggregate first. Always print results to stdout (no figures/files).

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
  error?: string,
): AnalyzeResult {
  return {
    answer,
    summary,
    transcript,
    iterations_used: iterations,
    total_duration_ms: Date.now() - t0,
    error,
  };
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

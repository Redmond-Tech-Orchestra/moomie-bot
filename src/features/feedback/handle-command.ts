import type { CommandContext } from '../../types.js';
import { getOctokit } from '../coding/github-client.js';
import { trackIssue } from '../coding/issue-tracker.js';
import { generateIssueTitle } from '../coding/title-generator.js';
import { runCodingTask } from '../coding/job-runner.js';
import { notifyUser } from '../../adapters/index.js';
import { GITHUB_OWNER, GITHUB_BOT_REPO, PORT } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Feedback');

export const name = 'feedback';
export const description = 'Report something Moomie got wrong — she will investigate and try to fix herself';

interface FeedbackOptions {
  feedback: string;
  channelId: string;
  channelName: string;
  userId: string;
  userName: string;
  platform: 'discord' | 'teams';
  conversationRef?: string;
  /** The moomie message being replied to */
  referencedMessage?: string;
  /** Pre-generated issue title (avoids redundant LLM call when caller already needed it for a thread name). */
  titleOverride?: string;
}

/**
 * Full feedback flow:
 * 1. Create a GitHub issue on the bot repo (user feedback only — no internal data)
 * 2. Queue a coding task that tells the agent to self-investigate via MCP
 * 3. Agent queries audit logs + DB state through the MCP endpoint
 * 4. Agent opens a PR to fix itself
 * 5. User gets notified via webhook → tracked issue → notifyUser
 */
export async function executeFeedback(opts: FeedbackOptions): Promise<string> {
  // 1. Build a clean public issue body (no internal diagnostics)
  const quotedFeedback = opts.feedback.split('\n').map((l) => `> ${l}`).join('\n');
  const issueBody = [
    `## Feedback`,
    `Reported by **${opts.userName}** via ${opts.platform}`,
    '',
    quotedFeedback,
    '',
    opts.referencedMessage
      ? `### Moomie Message Being Corrected\n> ${opts.referencedMessage.slice(0, 500)}\n`
      : '',
  ].filter(Boolean).join('\n');

  // 2. Create GitHub issue on the bot repo
  const title = opts.titleOverride ?? await generateIssueTitle(`Feedback: ${opts.feedback}`);

  const octokit = getOctokit();
  const { data: issue } = await octokit.issues.create({
    owner: GITHUB_OWNER,
    repo: GITHUB_BOT_REPO,
    title,
    body: issueBody,
    labels: ['feedback'],
  });

  // Track issue for webhook notifications (scoped to bot repo)
  trackIssue(issue.number, GITHUB_BOT_REPO, {
    channelId: opts.channelId,
    userId: opts.userId,
    platform: opts.platform,
    conversationRef: opts.conversationRef,
  });

  log.audit({
    type: 'feedback',
    channel_id: opts.channelId,
    channel_name: opts.channelName,
    input_summary: opts.feedback.slice(0, 500),
    result: `Issue #${issue.number}: ${issue.html_url}`,
  });

  // 3. Build the agent prompt — tells it to use MCP for self-investigation
  const mcpUrl = `http://localhost:${PORT}/mcp`;
  const codingPrompt = [
    `## Self-Patch: Fix Feedback Issue #${issue.number}`,
    '',
    `A user reported a problem with Moomie (this bot). Your job is to investigate`,
    `the issue using the internal observability API, then make targeted code changes to fix it.`,
    '',
    `### User Feedback`,
    opts.feedback,
    '',
    opts.referencedMessage
      ? `### Moomie Message Being Corrected\n${opts.referencedMessage.slice(0, 1000)}\n`
      : '',
    `### Context`,
    `- Channel: ${opts.channelName} (${opts.channelId})`,
    `- Reporter: ${opts.userName}`,
    '',
    `### Investigation: MCP Observability API`,
    `Before making changes, investigate what went wrong using the internal MCP endpoint.`,
    `Send POST requests to: ${mcpUrl}`,
    '',
    `Available MCP tools:`,
    `- **query_audit_log** — Query recent LLM calls (extraction, dedup, chat). Params: hours (default 24), type (extraction|dedup|chat|outcome)`,
    `- **get_stats** — Aggregate LLM stats (call counts, token usage by type/model). Params: days (default 7)`,
    `- **query_items** — Query tracked action items. Params: event_id, status (open|done|stale|all), stale_days, orphans_only`,
    `- **get_events** — List orchestra events. Params: active_only (default true)`,
    '',
    `Use the MCP Streamable HTTP protocol. Example request:`,
    '```',
    `POST ${mcpUrl}`,
    `Content-Type: application/json`,
    '',
    `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_audit_log","arguments":{"hours":6,"type":"chat"}}}`,
    '```',
    '',
    `### Investigation Steps`,
    `1. Query the audit log for recent chat/extraction calls in channel ${opts.channelId}`,
    `2. Check what input/output the LLM produced that was incorrect`,
    `3. Look at stats to see if there's a pattern`,
    `4. Determine the root cause (prompt issue, tool logic, extraction bug, etc.)`,
    '',
    `### Fix Guidelines`,
    `- This is the moomie-bot codebase (TypeScript, discord.js, Gemini LLM)`,
    `- Only modify files relevant to the fix`,
    `- If the fix involves prompt wording, update the .md files in src/prompts/`,
    `- If the fix involves code logic, update the relevant .ts files in src/`,
    `- Run \`npx tsc --noEmit\` to verify the changes compile`,
    `- Keep changes minimal and focused on the reported issue`,
  ].join('\n');

  // 4. Queue the self-patching coding task (fire-and-forget)
  // Notification is handled by the webhook → tracked issue → notifyUser path.
  runCodingTask({
    title: issue.title,
    task: codingPrompt,
    issueNumber: issue.number,
    requestedBy: opts.userName,
    repo: GITHUB_BOT_REPO,
  }).then((result) => {
    if (result.success) {
      log.info(`Self-patch PR created for #${issue.number}: ${result.prUrl}`);
    } else {
      log.error(`Self-patch failed for #${issue.number}: ${result.error}`);
    }
  }).catch((err) => {
    log.error('Coding task failed:', err);
  });

  return issue.html_url;
}

/**
 * Slash command entry point.
 */
export async function execute(ctx: CommandContext, args: string): Promise<void> {
  if (!args) {
    await ctx.reply('Please describe what went wrong.');
    return;
  }

  await ctx.deferReply();

  try {
    // Generate the title first so the thread name can include it. We pay the
    // small extra latency in exchange for a coherent "trail of work" in one
    // thread (issue → PR → revisions).
    const title = await generateIssueTitle(`Feedback: ${args}`);
    const threadId = ctx.startThread
      ? await ctx.startThread(`Feedback: ${title}`)
      : undefined;

    const issueUrl = await executeFeedback({
      feedback: args,
      channelId: threadId ?? ctx.channelId,
      channelName: ctx.channelId, // slash commands don't carry channel name; use ID as fallback
      userId: ctx.userId,
      userName: ctx.userName,
      platform: ctx.platform,
      conversationRef: ctx.conversationRef,
      titleOverride: title,
    });

    const summary = threadId
      ? `Got it — investigating in the thread. 🐄\nIssue: ${issueUrl}`
      : `Got it — I'm investigating and will try to fix myself. 🐄\nIssue: ${issueUrl}\nI'll follow up with a PR when I'm done.`;
    await ctx.editReply(summary);

    if (threadId) {
      try {
        await notifyUser(
          { platform: 'discord', channelId: threadId, userId: ctx.userId },
          `📋 Issue created: ${issueUrl}\nLooking into this now — I'll post the PR here when I'm done, and you can reply in this thread to ask for changes.`,
        );
      } catch (err) {
        log.warn(`Failed to post kickoff message in feedback thread ${threadId}:`, err);
      }
    }
  } catch (err) {
    log.error('Command failed:', err);
    await ctx.editReply('Something went wrong processing the feedback. Check the logs.');
  }
}

import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Client } from 'discord.js';
import { getTrackedIssue, untrackIssue } from './features/coding/issue-tracker.js';
import { isOrgMember, listReviewComments } from './features/coding/github-client.js';
import { runCodingTask, runRevisionTask, getQueueStatus, setDraining } from './features/coding/job-runner.js';
import { notifyOnRevisionComplete } from './features/coding/revision-notifier.js';
import { startTeams } from './adapters/teams.js';
import { getUploadsDir } from './features/website/attachment-store.js';
import { initNotifications, notifyUser } from './adapters/index.js';
import { mountMcp } from './features/admin/mcp-server.js';
import { PORT, GITHUB_REPO } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('Webhook');

interface WebhookRequest extends Request {
  rawBody?: Buffer;
}

export function startServer(discordClient: Client): express.Express {
  const app = express();

  // Initialize the shared notification service
  initNotifications(discordClient);

  // Serve uploaded attachments
  app.use('/uploads', express.static(getUploadsDir()));

  app.use(express.json({
    verify: (req: WebhookRequest, _res, buf) => { req.rawBody = buf; },
  }));

  // Verify GitHub webhook signature
  app.use('/webhook', (req: WebhookRequest, res: Response, next: NextFunction) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      log.warn('GITHUB_WEBHOOK_SECRET not set — skipping signature verification');
      return next();
    }

    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!signature) return res.status(401).send('Missing signature');

    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(req.rawBody!)
      .digest('hex');

    // Prevent RangeError from mismatched buffer lengths
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).send('Invalid signature');
    }

    next();
  });

  app.post('/webhook', async (req: Request, res: Response) => {
    const event = req.headers['x-github-event'] as string;
    const payload = req.body;

    if (event === 'issues' && payload.action === 'labeled') {
      await handleIssueLabelAdded(payload);
    }

    if (event === 'issues' && payload.action === 'unlabeled') {
      handleIssueLabelRemoved(payload);
    }

    if (event === 'pull_request' && payload.action === 'opened') {
      await handlePullRequest(payload.pull_request, payload.repository?.name);
    }

    if (event === 'issue_comment' && payload.action === 'created') {
      await handleIssueComment(payload);
    }

    if (event === 'pull_request_review' && payload.action === 'submitted') {
      await handlePullRequestReview(payload);
    }

    res.sendStatus(200);
  });

  // ─── Admin/Health Endpoints ─────────────────────────────────────────────────

  // Lightweight liveness probe for Docker healthcheck — no DB queries
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get('/status', (_req: Request, res: Response) => {
    const status = getQueueStatus();
    res.json({
      ok: true,
      queue: {
        running: status.running,
        queued: status.queued,
        runningForMin: status.runningForMs ? Math.round(status.runningForMs / 60000) : null,
        draining: status.draining,
      },
    });
  });

  // Deploy-time drain control. Flipping drain on lets the in-flight coding job
  // finish while blocking new pickups, so a deploy can swap the container without
  // killing a running job. Guarded because nginx proxies all paths publicly:
  // require a matching DEPLOY_TOKEN header, or — if no token is configured —
  // only accept direct loopback calls (no proxy headers), which is how the
  // server-side deploy script reaches it.
  app.post('/drain', (req: Request, res: Response) => {
    if (!isLocalDeployRequest(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const drain = req.body?.drain !== false; // default true
    setDraining(drain);
    res.json({ ok: true, draining: drain, queue: getQueueStatus() });
  });



  // Register Teams bot endpoint
  startTeams(app);

  // Mount MCP observability endpoint
  mountMcp(app);

  const port = PORT;
  app.listen(port, () => {
    log.info(`Server listening on port ${port}`);
  });

  return app;
}

// ─── Webhook Handlers ─────────────────────────────────────────────────────────

/**
 * Authorize a deploy-control request (`/drain`). Since nginx proxies every path
 * publicly, this must not be open to the internet:
 *  - If DEPLOY_TOKEN is set, require a matching `x-deploy-token` header.
 *  - Otherwise accept only direct loopback calls: nginx-proxied requests carry
 *    `x-forwarded-*` headers and a public Host, so a plain `curl localhost:3000`
 *    from the server-side deploy script is distinguishable.
 */
function isLocalDeployRequest(req: Request): boolean {
  const token = process.env.DEPLOY_TOKEN;
  if (token) return req.get('x-deploy-token') === token;
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return false;
  const host = (req.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

async function handlePullRequest(pr: { number: number; body?: string; html_url: string }, repo?: string): Promise<void> {
  const issueRefs = pr.body?.matchAll(/(?:closes|fixes|resolves)\s+#(\d+)/gi);
  if (!issueRefs) return;

  const repoName = repo || GITHUB_REPO;

  for (const match of issueRefs) {
    const issueNumber = parseInt(match[1], 10);
    const tracked = getTrackedIssue(issueNumber, repoName);
    if (!tracked) continue;

    try {
      const previewSuffix = repoName === GITHUB_REPO
        ? `\nProposed change: https://preview.redmondtechorchestra.org`
        : '';
      await notifyUser(
        tracked,
        `PR is ready for issue #${issueNumber}: ${pr.html_url}${previewSuffix}`,
        { kind: 'pr-actions', repo: repoName, prNumber: pr.number },
      );
      untrackIssue(issueNumber, repoName);
    } catch (err) {
      log.error(`Failed to notify user for issue #${issueNumber}:`, err);
    }
  }
}

const TRIGGER_LABEL = 'moomie-bot';

async function handleIssueLabelAdded(
  payload: { issue: { number: number; title: string; body?: string; html_url: string; labels?: { name: string }[] }; label: { name: string }; sender: { login: string; type?: string }; repository?: { name: string } },
): Promise<void> {
  if (payload.label.name !== TRIGGER_LABEL) return;

  // Skip feedback issues — they have their own coding flow
  if (payload.issue.labels?.some((l) => l.name === 'feedback')) return;

  const { issue, sender } = payload;
  const repoName = payload.repository?.name || GITHUB_REPO;

  // Allow GitHub App bot accounts (sender.type === 'Bot') to trigger the agent.
  // The webhook signature guarantees this field is set by GitHub, not spoofable.
  const isBotApp = sender.type === 'Bot';

  // Only allow org members (or a GitHub App bot) to trigger the agent
  if (!isBotApp && !await isOrgMember(sender.login)) {
    log.info(`Ignoring label from non-org-member: ${sender.login}`);
    return;
  }

  log.info(`Label "${TRIGGER_LABEL}" added to #${issue.number} by ${sender.login}`);

  // Notify initiator if tracked
  const tracked = getTrackedIssue(issue.number, repoName);
  if (tracked) {
    try {
      await notifyUser(tracked, `Moomie is working on issue #${issue.number}: ${issue.html_url}`);
    } catch (err) {
      log.error(`Failed to notify user for #${issue.number}:`, err);
    }
  }

  // Trigger the coding agent
  // Parse attachment filenames from issue body (format: `- \`filename\` (original: ...)`)
  const attachments: string[] = [];
  if (issue.body) {
    const matches = issue.body.matchAll(/^- `([^`]+)`\s*\(original:/gm);
    for (const match of matches) {
      attachments.push(match[1]);
    }
  }

  runCodingTask({
    title: issue.title,
    task: issue.title + (issue.body ? `\n\n${issue.body}` : ''),
    issueNumber: issue.number,
    requestedBy: sender.login,
    attachments: attachments.length > 0 ? attachments : undefined,
    repo: repoName,
  }).then(async (result) => {
    if (result.success) {
      log.info(`PR created for #${issue.number}: ${result.prUrl}`);
      if (tracked) {
        try {
          const previewSuffix = repoName === GITHUB_REPO
            ? `\nProposed change: https://preview.redmondtechorchestra.org`
            : '';
          await notifyUser(
            tracked,
            `PR ready for issue #${issue.number}: ${result.prUrl}${previewSuffix}`,
            result.prNumber ? { kind: 'pr-actions', repo: repoName, prNumber: result.prNumber } : undefined,
          );
        } catch (err) {
          log.error(`Failed to notify user for PR on #${issue.number}:`, err);
        }
        // Untrack so the `pull_request.opened` webhook (which also notifies as
        // a fallback) doesn't send a duplicate "PR is ready" message.
        untrackIssue(issue.number, repoName);
      }
    } else {
      log.error(`Agent failed for #${issue.number}: ${result.error}`);
      if (tracked) {
        try {
          await notifyUser(tracked, `Agent couldn't complete #${issue.number}: ${result.error}`);
        } catch (err) {
          log.error(`Failed to notify user for failure on #${issue.number}:`, err);
        }
      }
    }
  }).catch((err) => {
    log.error(`Unexpected error for #${issue.number}:`, err);
  });
}

function handleIssueLabelRemoved(
  payload: { issue: { number: number }; label: { name: string } },
): void {
  if (payload.label.name !== TRIGGER_LABEL) return;
  log.info(`Label "${TRIGGER_LABEL}" removed from #${payload.issue.number}`);
  // Future: could cancel in-progress agent work here
}

// ─── PR Revisions ────────────────────────────────────────────────────────────

const BOT_AUTHOR_LOGIN = 'moomie-bot[bot]';
const MENTION_PATTERN = /(?:^|\s)(?:@moomie-bot|\/moomie)\b/i;

interface IssueCommentPayload {
  action: string;
  issue: {
    number: number;
    pull_request?: unknown;
    user: { login: string };
  };
  comment: {
    body: string;
    user: { login: string; type?: string };
    html_url: string;
  };
  repository?: { name: string };
}

/**
 * Handle a comment on a PR. Triggers a revision if:
 *  - the comment is on a PR (not a regular issue)
 *  - the PR was authored by moomie-bot
 *  - the comment body contains @moomie-bot or /moomie
 *  - the commenter is an org member or a GitHub App bot (covers Discord-relayed comments)
 */
async function handleIssueComment(payload: IssueCommentPayload): Promise<void> {
  // Only PR comments — `issue_comment` fires for both issues and PRs.
  if (!payload.issue.pull_request) return;

  const repo = payload.repository?.name;
  if (!repo) return;

  // Only act on PRs the bot opened.
  if (payload.issue.user.login !== BOT_AUTHOR_LOGIN) return;

  const body = payload.comment.body || '';
  if (!MENTION_PATTERN.test(body)) return;

  // Permission check: org member, or our own bot account (Discord relay path).
  const sender = payload.comment.user;
  const isBotApp = sender.type === 'Bot';
  if (!isBotApp && !await isOrgMember(sender.login)) {
    log.info(`Ignoring PR comment from non-org-member: ${sender.login}`);
    return;
  }

  // Strip the trigger token to get the real instruction.
  const feedback = body.replace(MENTION_PATTERN, '').trim();
  if (!feedback) return;

  log.info(`Revising ${repo}/PR${payload.issue.number} from comment by ${sender.login}`);
  notifyOnRevisionComplete(repo, payload.issue.number, runRevisionTask({
    repo,
    prNumber: payload.issue.number,
    feedback,
    requestedBy: sender.login,
  }));
}

interface PullRequestReviewPayload {
  action: string;
  review: {
    id: number;
    body: string | null;
    state: string;
    user: { login: string; type?: string };
    html_url: string;
  };
  pull_request: {
    number: number;
    user: { login: string };
  };
  repository?: { name: string };
}

/**
 * Handle a submitted PR review. Triggers a revision when a reviewer requests
 * changes (or just leaves comments) on a moomie-authored PR.
 */
async function handlePullRequestReview(payload: PullRequestReviewPayload): Promise<void> {
  const repo = payload.repository?.name;
  if (!repo) return;

  // Only act on PRs the bot opened.
  if (payload.pull_request.user.login !== BOT_AUTHOR_LOGIN) return;

  // Approve reviews need no work.
  if (payload.review.state !== 'changes_requested' && payload.review.state !== 'commented') return;

  const sender = payload.review.user;
  const isBotApp = sender.type === 'Bot';
  if (sender.login === BOT_AUTHOR_LOGIN) return; // self-loop guard
  if (!isBotApp && !await isOrgMember(sender.login)) {
    log.info(`Ignoring review from non-org-member: ${sender.login}`);
    return;
  }

  const reviewBody = (payload.review.body || '').trim();
  const inline = await listReviewComments(repo, payload.pull_request.number, payload.review.id);

  // No actionable content? Skip — happens when a user clicks "Approve" with no body
  // or submits a "Comment" review with nothing in it.
  if (!reviewBody && inline.length === 0) return;

  const feedbackParts: string[] = [];
  if (reviewBody) feedbackParts.push(reviewBody);
  for (const c of inline) {
    const loc = c.line ? `${c.path}:${c.line}` : c.path;
    feedbackParts.push(`(${loc}) ${c.body}`);
  }
  const feedback = feedbackParts.join('\n\n');

  log.info(`Revising ${repo}/PR${payload.pull_request.number} from review by ${sender.login} (${inline.length} inline comments)`);
  notifyOnRevisionComplete(repo, payload.pull_request.number, runRevisionTask({
    repo,
    prNumber: payload.pull_request.number,
    feedback,
    requestedBy: sender.login,
  }));
}



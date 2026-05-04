import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Client } from 'discord.js';
import { getTrackedIssue, untrackIssue } from './features/website/tracker.js';
import { isOrgMember } from './features/website/github.js';
import { runCodingTask } from './features/website/orchestrator.js';
import { startTeams } from './adapters/teams.js';

interface WebhookRequest extends Request {
  rawBody?: Buffer;
}

export function startServer(discordClient: Client): express.Express {
  const app = express();

  app.use(express.json({
    verify: (req: WebhookRequest, _res, buf) => { req.rawBody = buf; },
  }));

  // Verify GitHub webhook signature
  app.use('/webhook', (req: WebhookRequest, res: Response, next: NextFunction) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      console.warn('[Webhook] GITHUB_WEBHOOK_SECRET not set — skipping signature verification');
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
      await handleIssueLabelAdded(payload, discordClient);
    }

    if (event === 'issues' && payload.action === 'unlabeled') {
      handleIssueLabelRemoved(payload);
    }

    if (event === 'pull_request' && payload.action === 'opened') {
      await handlePullRequest(payload.pull_request, discordClient);
    }

    res.sendStatus(200);
  });

  // Register Teams bot endpoint
  startTeams(app);

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });

  return app;
}

async function handlePullRequest(pr: { body?: string; html_url: string }, discordClient: Client): Promise<void> {
  const issueRefs = pr.body?.matchAll(/(?:closes|fixes|resolves)\s+#(\d+)/gi);
  if (!issueRefs) return;

  for (const match of issueRefs) {
    const issueNumber = parseInt(match[1], 10);
    const tracked = getTrackedIssue(issueNumber);
    if (!tracked) continue;

    try {
      const channel = await discordClient.channels.fetch(tracked.channelId);
      if (channel && 'send' in channel) {
        await channel.send(
          `<@${tracked.userId}> PR is ready for issue #${issueNumber}: ${pr.html_url}`
        );
      }
      untrackIssue(issueNumber);
    } catch (err) {
      console.error(`Failed to notify Discord for issue #${issueNumber}:`, err);
    }
  }
}

const TRIGGER_LABEL = 'moomie-bot';

async function handleIssueLabelAdded(
  payload: { issue: { number: number; title: string; body?: string; html_url: string }; label: { name: string }; sender: { login: string } },
  discordClient: Client,
): Promise<void> {
  if (payload.label.name !== TRIGGER_LABEL) return;

  const { issue, sender } = payload;

  // Only allow org members to trigger the agent
  if (!await isOrgMember(sender.login)) {
    console.log(`[Webhook] Ignoring label from non-org-member: ${sender.login}`);
    return;
  }

  console.log(`[Webhook] Label "${TRIGGER_LABEL}" added to #${issue.number} by ${sender.login}`);

  // Notify Discord if tracked
  const tracked = getTrackedIssue(issue.number);
  if (tracked) {
    try {
      const channel = await discordClient.channels.fetch(tracked.channelId);
      if (channel && 'send' in channel) {
        await channel.send(
          `<@${tracked.userId}> Moomie is working on issue #${issue.number}: ${issue.html_url}`
        );
      }
    } catch (err) {
      console.error(`[Webhook] Failed to notify Discord for #${issue.number}:`, err);
    }
  }

  // Trigger the coding agent
  runCodingTask({
    title: issue.title,
    task: issue.title + (issue.body ? `\n\n${issue.body}` : ''),
    issueNumber: issue.number,
    referenceFiles: [],
    requestedBy: sender.login,
  }).then(async (result) => {
    if (result.success) {
      console.log(`[Webhook] PR created for #${issue.number}: ${result.prUrl}`);
      if (tracked) {
        try {
          const channel = await discordClient.channels.fetch(tracked.channelId);
          if (channel && 'send' in channel) {
            await channel.send(
              `<@${tracked.userId}> PR ready for issue #${issue.number}: ${result.prUrl}`
            );
          }
        } catch (err) {
          console.error(`[Webhook] Failed to notify Discord for PR on #${issue.number}:`, err);
        }
      }
    } else {
      console.error(`[Webhook] Agent failed for #${issue.number}: ${result.error}`);
      if (tracked) {
        try {
          const channel = await discordClient.channels.fetch(tracked.channelId);
          if (channel && 'send' in channel) {
            const msg = `<@${tracked.userId}> Agent couldn't complete #${issue.number}: ${result.error}`;
            await channel.send(msg.slice(0, 2000));
          }
        } catch (err) {
          console.error(`[Webhook] Failed to notify Discord for failure on #${issue.number}:`, err);
        }
      }
    }
  }).catch((err) => {
    console.error(`[Webhook] Unexpected error for #${issue.number}:`, err);
  });
}

function handleIssueLabelRemoved(
  payload: { issue: { number: number }; label: { name: string } },
): void {
  if (payload.label.name !== TRIGGER_LABEL) return;
  console.log(`[Webhook] Label "${TRIGGER_LABEL}" removed from #${payload.issue.number}`);
  // Future: could cancel in-progress agent work here
}

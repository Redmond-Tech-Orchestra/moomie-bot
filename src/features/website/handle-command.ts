import type { CommandContext } from '../../types.js';
import { createIssue, getOctokit } from '../coding/github-client.js';
import { trackIssue } from '../coding/issue-tracker.js';
import { generateIssueTitle } from '../coding/title-generator.js';
import { saveAttachment } from './attachment-store.js';
import { GITHUB_OWNER, GITHUB_REPO } from '../../config.js';
import { notifyUser } from '../../adapters/index.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Website');

export const name = 'website';
export const description = 'Create a website issue and have Moomie work on it';

export interface WebsiteUpdateOptions {
  task: string;
  existingIssueNumber?: number;
  attachments?: { name: string; url: string }[];
  platform: 'discord' | 'teams';
  userId: string;
  userName: string;
  channelId: string;
  conversationRef?: string;
  /** Callback to start a thread if possible */
  startThread?: (title: string) => Promise<string | undefined>;
}

const TRIGGER_LABEL = 'moomie-bot';

function parseExistingIssueNumber(task: string): number | undefined {
  const repoUrl = new RegExp(
    `github\\.com/${escapeRegExp(GITHUB_OWNER)}/${escapeRegExp(GITHUB_REPO)}/issues/(\\d+)`,
    'i',
  );
  const urlMatch = task.match(repoUrl);
  if (urlMatch) return Number(urlMatch[1]);

  const issueMatch = task.match(/\bissue\s+#?(\d+)\b/i);
  return issueMatch ? Number(issueMatch[1]) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function executeWebsiteUpdate(opts: WebsiteUpdateOptions): Promise<{ issueUrl: string; threadId?: string; issueNumber: number; created: boolean }> {
  const { task, attachments, platform, userId, userName, channelId, conversationRef, startThread } = opts;
  const existingIssueNumber = opts.existingIssueNumber ?? parseExistingIssueNumber(task);

  if (existingIssueNumber) {
    const octokit = getOctokit();
    const { data: issue } = await octokit.issues.get({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      issue_number: existingIssueNumber,
    });

    if (issue.pull_request) {
      throw new Error(`#${existingIssueNumber} is a pull request, not a website issue.`);
    }
    if (issue.state !== 'open') {
      throw new Error(`#${existingIssueNumber} is closed.`);
    }

    const threadId = startThread
      ? await startThread(`#${issue.number}: ${issue.title}`)
      : undefined;
    const trackingChannelId = threadId ?? channelId;

    trackIssue(issue.number, GITHUB_REPO, {
      channelId: trackingChannelId,
      userId,
      platform,
      conversationRef,
    });

    const hasTriggerLabel = issue.labels.some((label) => {
      const name = typeof label === 'string' ? label : label.name;
      return name === TRIGGER_LABEL;
    });
    if (!hasTriggerLabel) {
      await octokit.issues.addLabels({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        issue_number: issue.number,
        labels: [TRIGGER_LABEL],
      });
    }

    if (threadId) {
      try {
        await notifyUser(
          {
            platform: 'discord',
            channelId: threadId,
            userId,
          },
          `📋 Tracking existing issue: ${issue.html_url}\nOn it — I'll post the PR here when it's ready, and you can reply in this thread to ask for changes.`,
        );
      } catch (err) {
        log.warn(`Failed to post kickoff message in thread ${threadId}:`, err);
      }
    }

    return { issueUrl: issue.html_url, threadId, issueNumber: issue.number, created: false };
  }

  // Save attachments locally if provided as URLs
  const uploadedFiles: { name: string; fileName: string }[] = [];
  if (attachments && attachments.length > 0) {
    for (const file of attachments) {
      try {
        const { fileName } = await saveAttachment(file);
        uploadedFiles.push({ name: file.name, fileName });
      } catch (err) {
        log.error(`Failed to save attachment ${file.name}:`, err);
      }
    }
  }

  // Build issue body
  let body = `Requested via ${platform} by **${userName}**\n\n${task}`;
  if (uploadedFiles.length > 0) {
    body += '\n\n### Attachments\n';
    body += '\nThese files are available in `.github/issue-assets/` in the workspace:\n';
    for (const file of uploadedFiles) {
      body += `\n- \`${file.fileName}\` (original: ${file.name})`;
    }
  }

  // Generate a concise issue title via AI
  const title = await generateIssueTitle(task);

  // Create tracking issue
  const issue = await createIssue({
    title,
    body,
  });

  // Try to spin up a thread
  const threadId = startThread
    ? await startThread(`#${issue.number}: ${title}`)
    : undefined;
  const trackingChannelId = threadId ?? channelId;

  trackIssue(issue.number, GITHUB_REPO, {
    channelId: trackingChannelId,
    userId: userId,
    platform,
    conversationRef,
  });

  // Kickoff message in thread
  if (threadId) {
    try {
      await notifyUser(
        {
          platform: 'discord',
          channelId: threadId,
          userId: userId,
        },
        `📋 Issue created: ${issue.html_url}\nOn it — I'll post the PR here when it's ready, and you can reply in this thread to ask for changes.`,
      );
    } catch (err) {
      log.warn(`Failed to post kickoff message in thread ${threadId}:`, err);
    }
  }

  return { issueUrl: issue.html_url, threadId, issueNumber: issue.number, created: true };
}

export async function execute(ctx: CommandContext, args: string): Promise<void> {
  if (!args) {
    await ctx.reply('Please include a task description.');
    return;
  }

  await ctx.deferReply();

  try {
    const { issueUrl, threadId, created } = await executeWebsiteUpdate({
      task: args,
      attachments: ctx.attachments,
      platform: ctx.platform,
      userId: ctx.userId,
      userName: ctx.userName,
      channelId: ctx.channelId,
      conversationRef: ctx.conversationRef,
      startThread: ctx.startThread,
    });

    const summary = threadId
      ? `${created ? 'Issue created' : 'Tracking existing issue'}: ${issueUrl}\nFollow along in the thread — Moomie will post updates there.`
      : `${created ? 'Issue created' : 'Tracking existing issue'}: ${issueUrl}\nMoomie will start working on it shortly.`;
    await ctx.editReply(summary);
  } catch (err) {
    log.error('Failed to create issue:', err);
    await ctx.editReply('Something went wrong creating the issue. Check the logs.');
  }
}

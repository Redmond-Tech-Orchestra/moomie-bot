import type { CommandContext } from '../../types.js';
import { createIssue } from '../coding/github-client.js';
import { trackIssue } from '../coding/issue-tracker.js';
import { generateIssueTitle } from '../coding/title-generator.js';
import { saveAttachment } from './attachment-store.js';
import { GITHUB_REPO } from '../../config.js';
import { notifyUser } from '../../adapters/index.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Website');

export const name = 'website';
export const description = 'Create a website issue and have Moomie work on it';

export async function execute(ctx: CommandContext, args: string): Promise<void> {
  if (!args) {
    await ctx.reply('Please include a task description.');
    return;
  }

  await ctx.deferReply();

  try {
    // Save attachments locally
    const uploadedFiles: { name: string; fileName: string }[] = [];
    if (ctx.attachments && ctx.attachments.length > 0) {
      for (const file of ctx.attachments) {
        try {
          const { fileName } = await saveAttachment(file);
          uploadedFiles.push({ name: file.name, fileName });
        } catch (err) {
          log.error(`Failed to save attachment ${file.name}:`, err);
        }
      }
    }

    // Build issue body
    let body = `Requested via ${ctx.platform} by **${ctx.userName}**\n\n${args}`;
    if (uploadedFiles.length > 0) {
      body += '\n\n### Attachments\n';
      body += '\nThese files are available in `.github/issue-assets/` in the workspace:\n';
      for (const file of uploadedFiles) {
        body += `\n- \`${file.fileName}\` (original: ${file.name})`;
      }
    }

    // Generate a concise issue title via AI
    const title = await generateIssueTitle(args);

    // Create tracking issue
    const issue = await createIssue({
      title,
      body,
    });

    // Try to spin up a thread so the entire trail of work (issue update, PR
    // ready, PR revisions) stays in one place. Fall back to the parent
    // channel if threads aren't available here (DMs, Teams, etc).
    const threadId = ctx.startThread
      ? await ctx.startThread(`#${issue.number}: ${title}`)
      : undefined;
    const trackingChannelId = threadId ?? ctx.channelId;

    trackIssue(issue.number, GITHUB_REPO, {
      channelId: trackingChannelId,
      userId: ctx.userId,
      platform: ctx.platform,
      conversationRef: ctx.conversationRef,
    });

    const summary = threadId
      ? `Issue created: ${issue.html_url}\nFollow along in the thread — Moomie will post updates there.`
      : `Issue created: ${issue.html_url}\nMoomie will start working on it shortly.`;
    await ctx.editReply(summary);

    // Drop the kickoff message into the thread itself so the trail starts
    // there, not in the parent channel.
    if (threadId) {
      try {
        await notifyUser(
          {
            platform: 'discord',
            channelId: threadId,
            userId: ctx.userId,
          },
          `Working on this now — I'll post here when the PR is ready.\nIssue: ${issue.html_url}`,
        );
      } catch (err) {
        log.warn(`Failed to post kickoff message in thread ${threadId}:`, err);
      }
    }
  } catch (err) {
    log.error('Failed to create issue:', err);
    await ctx.editReply('Something went wrong creating the issue. Check the logs.');
  }
}

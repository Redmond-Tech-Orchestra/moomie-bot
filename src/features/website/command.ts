import type { CommandContext } from '../../types.js';
import { createIssueAndAssignCopilot, uploadAttachmentToRepo } from './github.js';
import { trackIssue } from './tracker.js';
import { generateIssueTitle } from './summarize.js';

export const name = 'website';
export const description = 'Create a website issue and assign Copilot to work on it';

export async function execute(ctx: CommandContext, args: string): Promise<void> {
  if (!args) {
    await ctx.reply('Please include a task description.');
    return;
  }

  await ctx.deferReply();

  try {
    // Upload attachments to the repo and collect permanent URLs
    const uploadedFiles: { name: string; url: string; isImage: boolean }[] = [];
    if (ctx.attachments && ctx.attachments.length > 0) {
      const folder = '.github/issue-assets';
      for (const file of ctx.attachments) {
        try {
          const url = await uploadAttachmentToRepo(file, folder);
          uploadedFiles.push({
            name: file.name,
            url,
            isImage: file.contentType?.startsWith('image/') ?? false,
          });
        } catch (err) {
          console.error(`Failed to upload attachment ${file.name}:`, err);
        }
      }
    }

    // Build issue body
    let body = `Requested via ${ctx.platform} by **${ctx.userName}**\n\n${args}`;
    if (uploadedFiles.length > 0) {
      body += '\n\n### Attachments\n';
      for (const file of uploadedFiles) {
        if (file.isImage) {
          body += `\n![${file.name}](${file.url})`;
        } else {
          body += `\n- [${file.name}](${file.url})`;
        }
      }
    }

    // Generate a concise issue title via AI
    const title = await generateIssueTitle(args);

    // Create tracking issue
    const issue = await createIssueAndAssignCopilot({
      title,
      body,
    });

    trackIssue(issue.number, {
      channelId: ctx.channelId,
      userId: ctx.userId,
      platform: ctx.platform,
    });

    await ctx.editReply(
      `Issue created: ${issue.html_url}\nMoomie will start working on it shortly.`
    );
  } catch (err) {
    console.error('Failed to create issue:', err);
    await ctx.editReply('Something went wrong creating the issue. Check the logs.');
  }
}

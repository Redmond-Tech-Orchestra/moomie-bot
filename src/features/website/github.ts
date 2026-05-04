import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import fs from 'node:fs';
import path from 'node:path';
import type { Attachment } from '../../types.js';

let octokitInstance: Octokit | null = null;

export function getOctokit(): Octokit {
  if (!octokitInstance) {
    const appId = process.env.GITHUB_APP_ID;
    const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

    if (appId && privateKeyPath && installationId) {
      const privateKey = fs.readFileSync(
        path.resolve(privateKeyPath),
        'utf-8'
      );
      octokitInstance = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId,
          privateKey,
          installationId: Number(installationId),
        },
      });
    } else {
      // Fallback to PAT for development/testing
      octokitInstance = new Octokit({ auth: process.env.GITHUB_TOKEN });
    }
  }
  return octokitInstance;
}

interface CreateIssueOptions {
  title: string;
  body: string;
}

export async function createIssueAndAssignCopilot({ title, body }: CreateIssueOptions) {
  const octokit = getOctokit();
  const { data: issue } = await octokit.issues.create({
    owner: process.env.GITHUB_OWNER!,
    repo: process.env.GITHUB_REPO!,
    title,
    body,
    labels: ['moomie-bot'],
  });
  return issue;
}

export async function isOrgMember(username: string): Promise<boolean> {
  const octokit = getOctokit();
  try {
    await octokit.orgs.checkMembershipForUser({
      org: process.env.GITHUB_OWNER!,
      username,
    });
    return true; // 204 = member, 302 = redirected (not a member)
  } catch {
    return false;
  }
}

/**
 * Download a file from a URL and upload it to the GitHub repo.
 * Returns the permanent raw URL for the uploaded file.
 */
export async function uploadAttachmentToRepo(attachment: Attachment, folder: string): Promise<string> {
  const octokit = getOctokit();
  const owner = process.env.GITHUB_OWNER!;
  const repo = process.env.GITHUB_REPO!;

  // Download the file
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to download ${attachment.name}: ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const content = buffer.toString('base64');

  // Sanitize filename and build path
  const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${folder}/${safeName}`;

  // Check if file already exists (append suffix if so)
  let finalPath = path;
  try {
    await octokit.repos.getContent({ owner, repo, path });
    // File exists — add timestamp suffix
    const ext = safeName.includes('.') ? '.' + safeName.split('.').pop() : '';
    const base = ext ? safeName.slice(0, -ext.length) : safeName;
    finalPath = `${folder}/${base}-${Date.now()}${ext}`;
  } catch {
    // 404 = file doesn't exist, which is what we want
  }

  // Upload file to repo
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: finalPath,
    message: `Upload attachment: ${attachment.name}`,
    content,
  });

  // Return raw URL
  const branch = (await octokit.repos.get({ owner, repo })).data.default_branch;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${finalPath}`;
}

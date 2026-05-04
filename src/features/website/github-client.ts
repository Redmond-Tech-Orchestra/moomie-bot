import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type { InstallationAccessTokenAuthentication } from '@octokit/auth-app';
import fs from 'node:fs';
import path from 'node:path';

let octokitInstance: Octokit | null = null;

function getAppCredentials() {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  if (!appId || !privateKeyPath || !installationId) {
    throw new Error('Missing GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, or GITHUB_APP_INSTALLATION_ID');
  }
  const privateKey = fs.readFileSync(path.resolve(privateKeyPath), 'utf-8');
  return { appId, privateKey, installationId: Number(installationId) };
}

export function getOctokit(): Octokit {
  if (!octokitInstance) {
    const creds = getAppCredentials();
    octokitInstance = new Octokit({
      authStrategy: createAppAuth,
      auth: creds,
    });
  }
  return octokitInstance;
}

/**
 * Generate a short-lived installation access token for git operations.
 * Tokens expire after ~1 hour.
 */
export async function getInstallationToken(): Promise<string> {
  const octokit = getOctokit();
  const auth = await octokit.auth({ type: 'installation' }) as InstallationAccessTokenAuthentication;
  return auth.token;
}

interface CreateIssueOptions {
  title: string;
  body: string;
}

export async function createIssue({ title, body }: CreateIssueOptions) {
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


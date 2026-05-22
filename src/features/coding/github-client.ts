import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type { InstallationAccessTokenAuthentication } from '@octokit/auth-app';
import fs from 'node:fs';
import path from 'node:path';
import { GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_OWNER, GITHUB_REPO } from '../../config.js';

let octokitInstance: Octokit | null = null;

function getAppCredentials() {
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!privateKeyPath) {
    throw new Error('Missing GITHUB_APP_PRIVATE_KEY_PATH');
  }
  const privateKey = fs.readFileSync(path.resolve(privateKeyPath), 'utf-8');
  return { appId: GITHUB_APP_ID, privateKey, installationId: Number(GITHUB_APP_INSTALLATION_ID) };
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
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
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
      org: GITHUB_OWNER,
      username,
    });
    return true; // 204 = member, 302 = redirected (not a member)
  } catch {
    return false;
  }
}

interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  headRef: string;
  baseRef: string;
  authorLogin: string;
  state: 'open' | 'closed';
}

/** Fetch metadata for a PR. Returns undefined if not found. */
export async function getPullRequest(repo: string, prNumber: number): Promise<PullRequestInfo | undefined> {
  const octokit = getOctokit();
  try {
    const { data } = await octokit.pulls.get({ owner: GITHUB_OWNER, repo, pull_number: prNumber });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      htmlUrl: data.html_url,
      headRef: data.head.ref,
      baseRef: data.base.ref,
      authorLogin: data.user?.login ?? '',
      state: data.state as 'open' | 'closed',
    };
  } catch {
    return undefined;
  }
}

/** List inline review comments associated with a specific review. */
export async function listReviewComments(repo: string, prNumber: number, reviewId: number): Promise<{ path: string; line: number | null; body: string }[]> {
  const octokit = getOctokit();
  try {
    const { data } = await octokit.pulls.listCommentsForReview({
      owner: GITHUB_OWNER,
      repo,
      pull_number: prNumber,
      review_id: reviewId,
    });
    return data.map((c) => ({
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      body: c.body ?? '',
    }));
  } catch {
    return [];
  }
}

/** Post a comment on a PR (uses the issues API since PR comments are issue comments). */
export async function commentOnPR(repo: string, prNumber: number, body: string): Promise<void> {
  const octokit = getOctokit();
  await octokit.issues.createComment({
    owner: GITHUB_OWNER,
    repo,
    issue_number: prNumber,
    body,
  });
}

export interface PullRequestMergeability {
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  /** GitHub's combined readiness signal: `clean`, `blocked`, `behind`, `dirty`, `unstable`, `unknown`. */
  mergeableState: string;
  headSha: string;
}

/** Fetch just the bits needed to decide if a PR is safe to merge. */
export async function getPullRequestMergeability(repo: string, prNumber: number): Promise<PullRequestMergeability | undefined> {
  const octokit = getOctokit();
  try {
    const { data } = await octokit.pulls.get({ owner: GITHUB_OWNER, repo, pull_number: prNumber });
    return {
      state: data.state as 'open' | 'closed',
      merged: data.merged,
      mergeable: data.mergeable,
      mergeableState: data.mergeable_state,
      headSha: data.head.sha,
    };
  } catch {
    return undefined;
  }
}

/** Submit an APPROVE review on a PR as the bot. */
export async function approvePullRequest(repo: string, prNumber: number, body: string): Promise<void> {
  const octokit = getOctokit();
  await octokit.pulls.createReview({
    owner: GITHUB_OWNER,
    repo,
    pull_number: prNumber,
    event: 'APPROVE',
    body,
  });
}

export interface MergeOptions {
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  commitTitle?: string;
  commitMessage?: string;
}

/** Merge a PR. Returns the merge commit SHA on success. Throws on failure. */
export async function mergePullRequest(repo: string, prNumber: number, opts: MergeOptions = {}): Promise<string> {
  const octokit = getOctokit();
  const { data } = await octokit.pulls.merge({
    owner: GITHUB_OWNER,
    repo,
    pull_number: prNumber,
    merge_method: opts.mergeMethod ?? 'squash',
    commit_title: opts.commitTitle,
    commit_message: opts.commitMessage,
  });
  return data.sha;
}



import {
  approvePullRequest,
  commentOnPR,
  getPullRequestMergeability,
  mergePullRequest,
} from './github-client.js';
import { untrackPR } from './issue-tracker.js';
import { createLogger } from '../../logger.js';

const log = createLogger('PRActions');

export interface ApproveAndMergeOptions {
  repo: string;
  prNumber: number;
  /** Display name of whoever clicked the button in Discord, for audit trail. */
  requestedBy: string;
}

export interface ApproveAndMergeResult {
  success: boolean;
  /** User-facing message safe to surface in Discord. */
  message: string;
  /** Merge commit SHA on success. */
  sha?: string;
}

/**
 * Approve a PR as the bot, then merge it. Used by the Discord "Approve & Merge"
 * button so org members can ship moomie's PRs without leaving the channel.
 *
 * Performs a readiness check first so we surface a useful message instead of
 * letting GitHub's merge endpoint return a confusing 405.
 */
export async function approveAndMerge(opts: ApproveAndMergeOptions): Promise<ApproveAndMergeResult> {
  const { repo, prNumber, requestedBy } = opts;

  const info = await getPullRequestMergeability(repo, prNumber);
  if (!info) {
    return { success: false, message: `Couldn't find PR #${prNumber} in ${repo}.` };
  }
  if (info.merged) {
    return { success: false, message: `PR #${prNumber} is already merged.` };
  }
  if (info.state !== 'open') {
    return { success: false, message: `PR #${prNumber} is ${info.state}.` };
  }

  // GitHub returns `mergeable: null` while it's still computing — caller can
  // retry, but it's almost always ready within a few seconds of PR open.
  if (info.mergeable === false) {
    return { success: false, message: `PR #${prNumber} has merge conflicts. Needs a rebase before it can ship.` };
  }

  // `mergeable_state` blocks on failing required checks, missing approvals, etc.
  // `clean` and `has_hooks` are both safe; `unstable` means non-required checks
  // are failing but it's still mergeable. Everything else, refuse.
  const blockedStates = new Set(['blocked', 'dirty', 'behind', 'draft']);
  if (blockedStates.has(info.mergeableState)) {
    return {
      success: false,
      message: `PR #${prNumber} isn't ready to merge (status: \`${info.mergeableState}\`). Check the PR for failing checks or missing approvals.`,
    };
  }

  // Approve as the bot, on behalf of the Discord user.
  try {
    await approvePullRequest(
      repo,
      prNumber,
      `Approved via Discord by **${requestedBy}**.`,
    );
  } catch (err) {
    log.error(`Failed to approve ${repo}/PR${prNumber}:`, err);
    // Keep going — approval failure often just means the bot already approved,
    // and merge will still work.
  }

  let sha: string;
  try {
    sha = await mergePullRequest(repo, prNumber, {
      mergeMethod: 'squash',
      commitMessage: `Merged via Discord by ${requestedBy}.`,
    });
  } catch (err) {
    log.error(`Failed to merge ${repo}/PR${prNumber}:`, err);
    const reason = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Merge failed: ${reason}` };
  }

  // Best-effort comment so the GitHub side carries the same audit trail.
  try {
    await commentOnPR(repo, prNumber, `Merged via Discord by **${requestedBy}** (commit \`${sha.slice(0, 7)}\`).`);
  } catch (err) {
    log.warn(`Failed to post merge audit comment on ${repo}/PR${prNumber}:`, err);
  }

  untrackPR(prNumber, repo);

  log.audit({
    type: 'pr_merge',
    input_summary: `${repo}/PR${prNumber} merged by ${requestedBy} via Discord`,
    result: sha,
  });

  return {
    success: true,
    message: `Merged PR #${prNumber} (\`${sha.slice(0, 7)}\`). Thanks, ${requestedBy}!`,
    sha,
  };
}

import { getTrackedPR, untrackPR } from './issue-tracker.js';
import { runRevisionTask } from './job-runner.js';
import { notifyUser } from '../../adapters/index.js';
import { createLogger } from '../../logger.js';

const log = createLogger('RevisionNotifier');

/**
 * Bridge a revision job's result back to the originating channel (if any).
 * `runRevisionTask` always resolves — even on failure — so we just need to
 * look up the tracker entry once it settles.
 *
 * Used by both the GitHub webhook paths (issue comment / PR review) and the
 * Discord modal handler so every revision path delivers a completion ping.
 */
export function notifyOnRevisionComplete(
  repo: string,
  prNumber: number,
  job: ReturnType<typeof runRevisionTask>,
): void {
  job.then(async (result) => {
    const tracked = getTrackedPR(prNumber, repo);
    if (!tracked) return;
    try {
      if (result.success) {
        await notifyUser(
          tracked,
          `Revision pushed to PR #${prNumber}: ${result.prUrl ?? ''}`.trim(),
          { kind: 'pr-actions', repo, prNumber },
        );
      } else {
        await notifyUser(
          tracked,
          `Couldn't revise PR #${prNumber}: ${result.error ?? 'unknown error'}`,
        );
      }
    } catch (err) {
      log.error(`Failed to notify user for revision on ${repo}/PR${prNumber}:`, err);
    } finally {
      untrackPR(prNumber, repo);
    }
  }).catch((err) => {
    log.error(`Unexpected error in revision job for ${repo}/PR${prNumber}:`, err);
  });
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getOctokit, getInstallationToken, getPullRequest } from './github-client.js';
import { getAgent } from './agents/index.js';
import type { AgentResult } from './agents/index.js';
import { copyToWorkspace, deleteUploads } from '../website/attachment-store.js';
import {
  insertJob,
  markRunning,
  markDone,
  markFailed,
  requeueInterrupted,
  getResumableJobs,
  pruneFinishedJobs,
} from './job-store.js';
import { getTrackedIssue, untrackIssue, getTrackedPR, untrackPR } from './issue-tracker.js';
import { notifyOnRevisionComplete } from './revision-notifier.js';
import { resolveActivity } from '../../adapters/index.js';
import type { ActivityTarget } from '../../adapters/index.js';
import { AGENT_WORKSPACE, GITHUB_OWNER, GITHUB_REPO } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('JobRunner');

const WORKSPACE_DIR = path.resolve(AGENT_WORKSPACE);
const MAX_QUEUE_SIZE = 5;
const JOB_TIMEOUT_MS = 35 * 60 * 1000; // 35 min (slightly above the coding agent's 30 min hard cap)
const JOB_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour — discard queued jobs older than this
const MAX_ATTEMPTS = 3; // give up resuming a job after this many interrupted runs

interface OrchestratorResult {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  issueNumber?: number;
  error?: string;
  summary?: string;
  /**
   * True when a live Discord surface already showed the user the terminal
   * result, so downstream webhook/notifier fallbacks should stay silent.
   */
  deliveredToUser?: boolean;
}

/** Resolve the live Discord surface for a tracked issue/PR, if any. */
function issueTarget(issueNumber: number | undefined, repo: string): ActivityTarget | undefined {
  if (!issueNumber) return undefined;
  const tracked = getTrackedIssue(issueNumber, repo);
  if (!tracked) return undefined;
  return { platform: tracked.platform, channelId: tracked.channelId, userId: tracked.userId, conversationRef: tracked.conversationRef, label: `Issue #${issueNumber}` };
}

function prTarget(prNumber: number, repo: string): ActivityTarget | undefined {
  const tracked = getTrackedPR(prNumber, repo);
  if (!tracked) return undefined;
  return { platform: tracked.platform, channelId: tracked.channelId, userId: tracked.userId, conversationRef: tracked.conversationRef, label: `PR #${prNumber} revision` };
}

// ─── Job Queue ────────────────────────────────────────────────────────────────

interface NewTaskJob {
  kind: 'new';
  options: CodingTaskOptions;
  resolve: (result: OrchestratorResult) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  /** Row id in the coding_jobs table (for restart recovery). */
  dbId: number;
}

interface RevisionTaskJob {
  kind: 'revision';
  options: RevisionTaskOptions;
  resolve: (result: OrchestratorResult) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  /** Row id in the coding_jobs table (for restart recovery). */
  dbId: number;
}

type QueuedJob = NewTaskJob | RevisionTaskJob;

const queue: QueuedJob[] = [];
let running = false;
let currentJobStart: number | null = null;
let warmupDone = false;
let warmupPromise: Promise<void> | null = null;

// Drain mode: when true, `processQueue` finishes the in-flight job but does NOT
// pick up the next one. A deploy flips this on, waits for the running job to
// settle, then swaps the container. Queued jobs persist (coding_jobs table) and
// resume on the next startup, so they're safe to leave behind.
let draining = false;

export function setDraining(value: boolean): void {
  if (draining !== value) log.info(value ? 'Entering drain mode — no new jobs will start.' : 'Exiting drain mode.');
  draining = value;
  if (!value) processQueue();
}

export function isDraining(): boolean {
  return draining;
}

function jobLabel(job: QueuedJob): string {
  if (job.kind === 'new') return `new#${job.options.issueNumber || '?'}`;
  return `rev#${job.options.repo}/PR${job.options.prNumber}`;
}

function jobAttachments(job: QueuedJob): string[] | undefined {
  return job.kind === 'new' ? job.options.attachments : undefined;
}

function jobRepo(job: QueuedJob): string {
  return job.kind === 'new' ? (job.options.repo || GITHUB_REPO) : job.options.repo;
}

async function processQueue(): Promise<void> {
  if (running || queue.length === 0) return;
  // Drain mode: leave queued jobs in place; they'll resume after the next start.
  if (draining) return;
  // Wait for warmup to finish before processing jobs
  if (!warmupDone && warmupPromise) await warmupPromise;

  // Discard stale jobs that have been waiting too long
  while (queue.length > 0 && Date.now() - queue[0].enqueuedAt > JOB_MAX_AGE_MS) {
    const stale = queue.shift()!;
    log.warn(`Discarding stale job ${jobLabel(stale)} (queued ${Math.round((Date.now() - stale.enqueuedAt) / 60000)}min ago)`);
    markFailed(stale.dbId, { error: 'expired in queue' });
    stale.resolve({ success: false, error: 'Job expired — it waited too long in the queue.' });
    const atts = jobAttachments(stale);
    if (atts?.length) deleteUploads(atts);
  }

  if (queue.length === 0) return;
  // Re-check drain after the warmup await above (it may have flipped meanwhile).
  if (draining) return;
  running = true;
  currentJobStart = Date.now();

  const job = queue.shift()!;
  markRunning(job.dbId);
  let timedOut = false;

  // Hard timeout: race against the job execution
  const timeoutPromise = new Promise<OrchestratorResult>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      log.error(`Job ${jobLabel(job)} timed out after ${JOB_TIMEOUT_MS / 60000}min`);
      resolve({ success: false, error: 'Job timed out and was force-cleared.' });
    }, JOB_TIMEOUT_MS);
  });

  try {
    const work = job.kind === 'new'
      ? executeTask(job.options)
      : executeRevision(job.options);
    const result = await Promise.race([work, timeoutPromise]);
    if (result.success) markDone(job.dbId, result);
    else markFailed(job.dbId, result);
    job.resolve(result);
  } catch (err) {
    markFailed(job.dbId, { error: String(err) });
    job.reject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    const atts = jobAttachments(job);
    if (atts?.length) deleteUploads(atts);
    running = false;
    currentJobStart = null;
    // If timed out, reset the workspace to prevent stale state for next job
    if (timedOut) {
      try {
        const repoDir = getRepoDir(jobRepo(job));
        git(['checkout', 'main'], repoDir);
        git(['reset', '--hard', 'origin/main'], repoDir);
      } catch { /* best effort */ }
    }
    processQueue();
  }
}

// ─── Git Helpers ──────────────────────────────────────────────────────────────

function git(args: string[], cwd: string, stdin?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: stdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    input: stdin,
  }).trim();
}

function getRepoDir(repo?: string): string {
  const repoSlug = repo || GITHUB_REPO;
  return path.join(WORKSPACE_DIR, `${GITHUB_OWNER}--${repoSlug}`);
}

async function cloneOrPull(repo?: string): Promise<string> {
  const repoSlug = repo || GITHUB_REPO;
  const repoDir = getRepoDir(repoSlug);
  const token = await getInstallationToken();

  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    const cloneUrl = `https://github.com/${GITHUB_OWNER}/${repoSlug}.git`;
    execFileSync('git', ['clone', cloneUrl, repoDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_ASKPASS: 'echo',
        GIT_USERNAME: 'x-access-token',
        GIT_PASSWORD: token,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    // Configure credential for future operations on this repo
    git(['config', 'credential.helper', ''], repoDir);
    git(['remote', 'set-url', 'origin', cloneUrl], repoDir);
  } else {
    // Set fresh token for pull
    setGitToken(repoDir, token, repoSlug);
    git(['checkout', 'main'], repoDir);
    git(['reset', '--hard', 'origin/main'], repoDir);
    git(['pull', '--rebase'], repoDir);
  }

  // Pre-install npm deps so the agent doesn't burn its idle-timeout on a cold
  // `npx tsc` install. Only runs when the repo has a package.json and there's
  // no node_modules yet — once populated, the agent can manage incremental
  // installs itself. Failures here are non-fatal: the agent can retry.
  ensureNodeModules(repoDir);

  return repoDir;
}

function ensureNodeModules(repoDir: string): void {
  if (!fs.existsSync(path.join(repoDir, 'package.json'))) return;
  if (fs.existsSync(path.join(repoDir, 'node_modules'))) return;

  const hasLockfile = fs.existsSync(path.join(repoDir, 'package-lock.json'));
  const npmArgs = hasLockfile
    ? ['ci', '--prefer-offline', '--no-audit', '--no-fund']
    : ['install', '--prefer-offline', '--no-audit', '--no-fund'];

  log.info(`Installing npm deps in ${path.basename(repoDir)} (npm ${npmArgs[0]})…`);
  const start = Date.now();
  try {
    execFileSync('npm', npmArgs, {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_progress: 'false' },
    });
    log.info(`npm ${npmArgs[0]} done in ${Math.round((Date.now() - start) / 1000)}s`);
  } catch (err) {
    log.warn(`npm ${npmArgs[0]} failed in ${path.basename(repoDir)} (agent will retry if needed):`, err);
  }
}

/** Configure git credential for the repo so push/pull uses the given token. */
function setGitToken(repoDir: string, token: string, repo?: string): void {
  const repoSlug = repo || GITHUB_REPO;
  const url = `https://x-access-token:${token}@github.com/${GITHUB_OWNER}/${repoSlug}.git`;
  git(['remote', 'set-url', 'origin', url], repoDir);
}

function cleanupLocalBranches(repoDir: string): void {
  try {
    // Delete all local moomie/* branches except the current one
    const branches = git(['branch', '--list', 'moomie/*'], repoDir);
    for (const branch of branches.split('\n')) {
      const name = branch.replace(/^\*?\s*/, '').trim();
      if (name) {
        try { git(['branch', '-D', name], repoDir); } catch { /* branch already gone */ }
      }
    }
    // Prune remote tracking refs
    git(['remote', 'prune', 'origin'], repoDir);
  } catch {
    // Non-critical
  }
}

// ─── Pre-clone on import ──────────────────────────────────────────────────────

export function warmupRepo(): void {
  warmupPromise = (async () => {
    try {
      const repoDir = await cloneOrPull();
      cleanupLocalBranches(repoDir);
      log.info(`Repo ready at ${repoDir}`);
    } catch (err) {
      log.error('Warmup failed (will retry on first job):', err);
    } finally {
      warmupDone = true;
    }
  })();
}

// ─── Public API ───────────────────────────────────────────────────────────────

interface CodingTaskOptions {
  task: string;
  title?: string;
  issueNumber?: number;
  requestedBy: string;
  /** Filenames in the uploads/ directory to copy into the workspace */
  attachments?: string[];
  /** Target repo slug (defaults to GITHUB_REPO). Use GITHUB_BOT_REPO for self-patching. */
  repo?: string;
}

export function getQueueStatus(): { running: boolean; queued: number; runningForMs: number | null; draining: boolean } {
  return {
    running,
    queued: queue.length,
    runningForMs: currentJobStart ? Date.now() - currentJobStart : null,
    draining,
  };
}

/**
 * Force-clear the running flag and drain the queue.
 * Use when the queue is stuck and no other fix works.
 */
export function forceResetQueue(): { drained: number } {
  const drained = queue.length;
  for (const job of queue) {
    markFailed(job.dbId, { error: 'force-reset by admin' });
    job.resolve({ success: false, error: 'Queue was force-reset by admin.' });
    const atts = jobAttachments(job);
    if (atts?.length) deleteUploads(atts);
  }
  queue.length = 0;
  running = false;
  currentJobStart = null;
  log.warn(`Queue force-reset. Drained ${drained} queued jobs.`);
  return { drained };
}

export function runCodingTask(options: CodingTaskOptions): Promise<OrchestratorResult> {
  if (queue.length >= MAX_QUEUE_SIZE) {
    return Promise.resolve({
      success: false,
      error: `Queue is full (${MAX_QUEUE_SIZE} jobs waiting). Try again later.`,
    });
  }

  log.info(`Queued new#${options.issueNumber || '?'} (${queue.length + 1} in queue, ${running ? 'one running' : 'idle'})`);

  const dbId = insertJob('new', options);
  return new Promise((resolve, reject) => {
    queue.push({ kind: 'new', options, resolve, reject, enqueuedAt: Date.now(), dbId });
    processQueue();
  });
}

export interface RevisionTaskOptions {
  repo: string;
  prNumber: number;
  feedback: string;
  requestedBy: string;
}

/**
 * Enqueue a revision job that re-checks-out an existing PR branch and applies
 * additional changes from user feedback. Result-comment posting is the caller's
 * responsibility — `executeRevision` only handles git/agent and posts a status
 * comment on the PR itself.
 */
export function runRevisionTask(options: RevisionTaskOptions): Promise<OrchestratorResult> {
  if (queue.length >= MAX_QUEUE_SIZE) {
    return Promise.resolve({
      success: false,
      error: `Queue is full (${MAX_QUEUE_SIZE} jobs waiting). Try again later.`,
    });
  }

  log.info(`Queued rev#${options.repo}/PR${options.prNumber} (${queue.length + 1} in queue, ${running ? 'one running' : 'idle'})`);

  const dbId = insertJob('revision', options);
  return new Promise((resolve, reject) => {
    queue.push({ kind: 'revision', options, resolve, reject, enqueuedAt: Date.now(), dbId });
    processQueue();
  });
}

/**
 * Re-enqueue jobs that were queued or running when the process last stopped
 * (deploy, crash, OOM). Called once on startup. A job caught mid-run can't be
 * resumed in place — an LLM agent run isn't checkpointable — so it's retried
 * from scratch; `executeTask` guards against duplicate PRs for the same branch.
 *
 * Recovered jobs have no live caller to await them, so notifications are
 * re-attached here: recovered *revisions* are wired back through
 * `notifyOnRevisionComplete` (the `tracked_prs` row persists), and recovered
 * *new* jobs are notified by the GitHub `pull_request.opened` webhook (which
 * looks up the still-tracked issue) — so those only need a status update.
 */
export function recoverJobs(): void {
  pruneFinishedJobs();
  const rows = getResumableJobs();
  if (rows.length === 0) return;

  let resumed = 0;
  for (const row of rows) {
    const interrupted = row.status === 'running';
    const ageMs = Date.now() - row.enqueued_at * 1000;

    if (ageMs > JOB_MAX_AGE_MS) {
      markFailed(row.id, { error: 'expired before recovery' });
      log.warn(`Skipping stale ${row.kind} job #${row.id} (queued ${Math.round(ageMs / 60000)}min ago).`);
      continue;
    }
    if (interrupted && row.attempts + 1 >= MAX_ATTEMPTS) {
      markFailed(row.id, { error: `gave up after ${row.attempts + 1} interrupted attempts` });
      log.warn(`Giving up on ${row.kind} job #${row.id} after ${row.attempts + 1} attempts.`);
      continue;
    }

    let options: CodingTaskOptions | RevisionTaskOptions;
    try {
      options = JSON.parse(row.payload);
    } catch (err) {
      markFailed(row.id, { error: `unparseable payload: ${err}` });
      continue;
    }

    if (interrupted) requeueInterrupted(row.id);
    const enqueuedAt = row.enqueued_at * 1000;
    if (row.kind === 'new') {
      const noop = () => {};
      queue.push({ kind: 'new', options: options as CodingTaskOptions, resolve: noop, reject: noop, enqueuedAt, dbId: row.id });
    } else {
      // Re-attach the completion ping: build a real promise around the queued
      // job so the originating channel (still in tracked_prs) gets notified.
      const opts = options as RevisionTaskOptions;
      const p = new Promise<OrchestratorResult>((resolve, reject) => {
        queue.push({ kind: 'revision', options: opts, resolve, reject, enqueuedAt, dbId: row.id });
      });
      notifyOnRevisionComplete(opts.repo, opts.prNumber, p);
    }
    resumed++;
  }

  if (resumed > 0) {
    log.info(`Recovered ${resumed} coding job(s) from the previous run.`);
    processQueue();
  }
}

// ─── Task Execution ───────────────────────────────────────────────────────────

async function executeTask(options: CodingTaskOptions): Promise<OrchestratorResult> {
  const { task, title, issueNumber, requestedBy, attachments, repo } = options;
  const targetRepo = repo || GITHUB_REPO;
  const prTitle = title || task.split('\n')[0].slice(0, 80);
  const agent = getAgent();

  log.info(`Starting task with ${agent.name} on ${targetRepo}: "${prTitle}"`);

  // 1. Ensure repo is up to date
  let repoDir: string;
  try {
    repoDir = await cloneOrPull(targetRepo);
  } catch (err) {
    return { success: false, error: `Failed to set up repo: ${err}` };
  }

  // 2. Create a feature branch
  const branchName = `moomie/${issueNumber || Date.now()}-${prTitle.slice(0, 30).replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
  try {
    git(['checkout', '-b', branchName], repoDir);
  } catch {
    git(['checkout', branchName], repoDir);
    git(['reset', '--hard', 'main'], repoDir);
  }

  // 2.5 Copy attachments into the workspace
  if (attachments && attachments.length > 0) {
    const destDir = path.join(repoDir, '.github', 'issue-assets');
    for (const fileName of attachments) {
      try {
        copyToWorkspace(fileName, destDir);
      } catch (err) {
        log.warn(`Failed to copy attachment ${fileName}:`, err);
      }
    }
  }

  // 3. Run the coding agent. If the originating issue is tracked back to a
  //    Discord channel, stream the agent's thinking into a single live message
  //    there (ack → work → done/fail). Untracked / non-Discord jobs get a no-op
  //    session and fall back to the webhook's completion notification.
  const session = resolveActivity(issueTarget(issueNumber, targetRepo));
  await session.ack();
  // Once a live surface delivered the result, untrack so the webhook fallbacks
  // (`pull_request.opened`, label `.then`) don't post a duplicate completion.
  const settle = async (r: OrchestratorResult): Promise<OrchestratorResult> => {
    if (session.delivered && issueNumber) untrackIssue(issueNumber, targetRepo);
    return { ...r, deliveredToUser: session.delivered };
  };

  let result: AgentResult;
  try {
    result = await agent.execute(
      { prompt: task },
      repoDir,
      (p) => session.work(p),
    );
  } catch (err) {
    git(['checkout', 'main'], repoDir);
    await session.fail(`Couldn't complete the task: ${err}.`);
    return settle({ success: false, error: `Agent failed: ${err}` });
  }

  if (!result.success) {
    git(['checkout', 'main'], repoDir);
    await session.fail(`Couldn't complete the task: ${result.error || 'agent reported failure'}.`);
    return settle({ success: false, error: result.error || 'Agent reported failure.' });
  }

  // 4. Clean up temp attachments so they aren't committed
  const issueAssetsDir = path.join(repoDir, '.github', 'issue-assets');
  if (fs.existsSync(issueAssetsDir)) {
    fs.rmSync(issueAssetsDir, { recursive: true, force: true });
  }

  // 5. Check if there are actual changes
  const status = git(['status', '--porcelain'], repoDir);
  if (!status) {
    git(['checkout', 'main'], repoDir);
    await session.fail('Finished, but ended up making no changes.');
    return settle({ success: false, error: 'Agent finished but made no changes.' });
  }

  // 6. Commit and push
  try {
    git(['add', '-A'], repoDir);
    const commitMsg = issueNumber
      ? `${prTitle}\n\nFixes #${issueNumber}\nRequested by ${requestedBy}`
      : `${prTitle}\n\nRequested by ${requestedBy}`;
    // Use -F - to pass commit message via stdin (avoids shell injection)
    git(['commit', '-F', '-'], repoDir, commitMsg);
    // Refresh token before push (installation tokens expire after ~1hr)
    const pushToken = await getInstallationToken();
    setGitToken(repoDir, pushToken, targetRepo);
    git(['push', 'origin', branchName, '--force'], repoDir);
  } catch (err) {
    git(['checkout', 'main'], repoDir);
    await session.fail(`Made changes but couldn't push them: ${err}.`);
    return settle({ success: false, error: `Failed to push: ${err}` });
  }

  // 6. Open a PR
  try {
    const octokit = getOctokit();
    // Reference the issue instead of inlining the full task, which may
    // contain internal data (MCP URLs, channel IDs, investigation prompts).
    const taskSection = issueNumber
      ? `See #${issueNumber} for details.`
      : task;

    const prBody = [
      `## Task`,
      taskSection,
      '',
      `## Summary`,
      result.summary,
      '',
      `---`,
      `Requested by **${requestedBy}** via Discord`,
      issueNumber ? `Fixes #${issueNumber}` : '',
    ].filter(Boolean).join('\n');

    // Idempotency guard: a recovered/retried job may have already opened a PR
    // for this branch before the process was killed. Reuse it instead of letting
    // pulls.create 422 on a duplicate head.
    const existing = await octokit.pulls.list({
      owner: GITHUB_OWNER,
      repo: targetRepo,
      head: `${GITHUB_OWNER}:${branchName}`,
      state: 'open',
    });
    const pr = existing.data[0] ?? (await octokit.pulls.create({
      owner: GITHUB_OWNER,
      repo: targetRepo,
      title: prTitle,
      body: prBody,
      head: branchName,
      base: 'main',
    })).data;
    if (existing.data[0]) {
      log.info(`Reusing existing PR #${pr.number} for ${branchName} (recovered job).`);
    }

    // 7. Cleanup: switch to main, delete local branch
    git(['checkout', 'main'], repoDir);
    try { git(['branch', '-D', branchName], repoDir); } catch { /* already gone */ }

    log.audit({
      type: 'coding',
      model: agent.name,
      input_summary: `#${issueNumber ?? '?'}: ${prTitle}`.slice(0, 500),
      result: `PR created: ${pr.html_url}`,
    });

    const previewNote = targetRepo === GITHUB_REPO
      ? `\nProposed change: https://preview.redmondtechorchestra.org`
      : '';
    // Untrack BEFORE the (awaited) Discord delivery: everything since
    // `pulls.create` has been synchronous, so the `pull_request.opened` webhook
    // can't have been processed yet. Untracking now guarantees that fallback
    // sees no tracked issue and stays silent — no duplicate completion message.
    if (session.delivered && issueNumber) untrackIssue(issueNumber, targetRepo);
    await session.done({
      headline: `Opened PR #${pr.number}: ${pr.html_url}${previewNote}`,
      actions: { kind: 'pr-actions', repo: targetRepo, prNumber: pr.number },
    });

    return settle({
      success: true,
      prUrl: pr.html_url,
      prNumber: pr.number,
      issueNumber,
      summary: result.summary,
    });
  } catch (err) {
    git(['checkout', 'main'], repoDir);
    log.audit({
      type: 'coding',
      model: agent.name,
      input_summary: `#${issueNumber ?? '?'}: ${prTitle}`.slice(0, 500),
      result: `Failed: ${err}`,
    });
    await session.fail(`Pushed the changes but couldn't open the PR: ${err}.`);
    return settle({ success: false, error: `PR creation failed: ${err}` });
  }
}

// ─── Revision Execution ──────────────────────────────────────────────────────

/**
 * Apply user feedback to an existing PR. Checks out the PR's head branch,
 * runs the agent, force-pushes, and posts a status comment on the PR.
 */
async function executeRevision(options: RevisionTaskOptions): Promise<OrchestratorResult> {
  const { repo, prNumber, feedback, requestedBy } = options;
  const agent = getAgent();

  log.info(`Revising ${repo}/PR${prNumber} via ${agent.name} (requested by ${requestedBy})`);

  // 1. Fetch PR metadata + verify it's a moomie PR on an open branch
  const pr = await getPullRequest(repo, prNumber);
  if (!pr) return { success: false, error: `PR #${prNumber} not found.` };
  if (pr.state !== 'open') return { success: false, error: `PR #${prNumber} is ${pr.state}.` };

  // 2. Ensure repo is local
  let repoDir: string;
  try {
    repoDir = await cloneOrPull(repo);
  } catch (err) {
    return { success: false, error: `Failed to set up repo: ${err}` };
  }

  // 3. Check out the PR head branch (force-sync to remote)
  const branchName = pr.headRef;
  try {
    git(['fetch', 'origin', branchName], repoDir);
    git(['checkout', '-B', branchName, `origin/${branchName}`], repoDir);
  } catch (err) {
    git(['checkout', 'main'], repoDir);
    return { success: false, error: `Failed to checkout ${branchName}: ${err}` };
  }

  // 4. Build the revision prompt — give the agent context on what's already
  //    been done plus what the user wants changed.
  const prompt = [
    `You previously opened PR #${prNumber} titled "${pr.title}" with this description:`,
    '---',
    pr.body || '(no body)',
    '---',
    '',
    `A user has now reviewed the PR and is requesting follow-up changes:`,
    '',
    feedback,
    '',
    `Apply these changes to the existing branch. Only make changes related to the user's feedback — do not undo or rework anything from the original PR unless explicitly asked.`,
  ].join('\n');

  // 5. Run the agent. If the revision was requested from a Discord channel,
  //    stream the agent's thinking into a single live message there and finalize
  //    it with the result (ack → work → done/fail). Untracked / non-Discord
  //    jobs get a no-op session and fall back to `notifyOnRevisionComplete`.
  const session = resolveActivity(prTarget(prNumber, repo));
  await session.ack();
  const settle = async (r: OrchestratorResult): Promise<OrchestratorResult> => {
    if (session.delivered) untrackPR(prNumber, repo);
    return { ...r, deliveredToUser: session.delivered };
  };

  let result: AgentResult;
  try {
    result = await agent.execute({ prompt }, repoDir, (p) => session.work(p));
  } catch (err) {
    git(['checkout', 'main'], repoDir);
    await session.fail(`Couldn't apply revision: ${err}.`);
    return settle({ success: false, error: `Agent failed: ${err}` });
  }

  if (!result.success) {
    git(['checkout', 'main'], repoDir);
    await session.fail(`Couldn't apply revision: ${result.error || 'agent reported failure'}.`);
    return settle({ success: false, error: result.error || 'Agent reported failure.' });
  }

  // 6. Anything to commit?
  const changes = git(['status', '--porcelain'], repoDir);
  if (!changes) {
    git(['checkout', 'main'], repoDir);
    await session.fail(`Took a look but didn't end up changing anything.`);
    return settle({ success: false, error: 'Agent finished but made no changes.' });
  }

  // 7. Commit + push
  let newSha: string;
  try {
    git(['add', '-A'], repoDir);
    const commitMsg = `Revision: ${feedback.split('\n')[0].slice(0, 80)}\n\nRequested by ${requestedBy}`;
    git(['commit', '-F', '-'], repoDir, commitMsg);
    const pushToken = await getInstallationToken();
    setGitToken(repoDir, pushToken, repo);
    git(['push', 'origin', branchName], repoDir);
    newSha = git(['rev-parse', '--short', 'HEAD'], repoDir);
  } catch (err) {
    git(['checkout', 'main'], repoDir);
    await session.fail(`Made changes but couldn't push them: ${err}.`);
    return settle({ success: false, error: `Failed to push: ${err}` });
  } finally {
    git(['checkout', 'main'], repoDir);
  }

  await session.done({
    headline: `Revision pushed to PR #${prNumber} (\`${newSha}\`): ${pr.htmlUrl}`,
    actions: { kind: 'pr-actions', repo, prNumber },
  });

  log.audit({
    type: 'coding',
    model: agent.name,
    input_summary: `revision ${repo}/PR${prNumber}: ${feedback.slice(0, 200)}`,
    result: `Pushed ${newSha}`,
  });

  return settle({ success: true, prUrl: pr.htmlUrl, prNumber: pr.number, summary: result.summary });
}


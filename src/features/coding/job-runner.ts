import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getOctokit, getInstallationToken } from './github-client.js';
import { getAgent } from './agents/index.js';
import type { AgentResult } from './agents/index.js';
import { copyToWorkspace, deleteUploads } from '../website/attachment-store.js';
import { AGENT_WORKSPACE, GITHUB_OWNER, GITHUB_REPO } from '../../config.js';

const WORKSPACE_DIR = path.resolve(AGENT_WORKSPACE);
const MAX_QUEUE_SIZE = 5;
const JOB_TIMEOUT_MS = 35 * 60 * 1000; // 35 min (slightly above Gemini's 30 min hard cap)
const JOB_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour — discard queued jobs older than this

interface OrchestratorResult {
  success: boolean;
  prUrl?: string;
  issueNumber?: number;
  error?: string;
  summary?: string;
}

// ─── Job Queue ────────────────────────────────────────────────────────────────

interface QueuedJob {
  options: CodingTaskOptions;
  resolve: (result: OrchestratorResult) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

const queue: QueuedJob[] = [];
let running = false;
let currentJobStart: number | null = null;
let warmupDone = false;
let warmupPromise: Promise<void> | null = null;

async function processQueue(): Promise<void> {
  if (running || queue.length === 0) return;
  // Wait for warmup to finish before processing jobs
  if (!warmupDone && warmupPromise) await warmupPromise;

  // Discard stale jobs that have been waiting too long
  while (queue.length > 0 && Date.now() - queue[0].enqueuedAt > JOB_MAX_AGE_MS) {
    const stale = queue.shift()!;
    console.warn(`[JobRunner] Discarding stale job #${stale.options.issueNumber || '?'} (queued ${Math.round((Date.now() - stale.enqueuedAt) / 60000)}min ago)`);
    stale.resolve({ success: false, error: 'Job expired — it waited too long in the queue.' });
    if (stale.options.attachments?.length) deleteUploads(stale.options.attachments);
  }

  if (queue.length === 0) return;
  running = true;
  currentJobStart = Date.now();

  const job = queue.shift()!;
  let timedOut = false;

  // Hard timeout: race against the job execution
  const timeoutPromise = new Promise<OrchestratorResult>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      console.error(`[JobRunner] Job #${job.options.issueNumber || '?'} timed out after ${JOB_TIMEOUT_MS / 60000}min`);
      resolve({ success: false, error: 'Job timed out and was force-cleared.' });
    }, JOB_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([executeTask(job.options), timeoutPromise]);
    job.resolve(result);
  } catch (err) {
    job.reject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    if (job.options.attachments?.length) {
      deleteUploads(job.options.attachments);
    }
    running = false;
    currentJobStart = null;
    // If timed out, reset the workspace to prevent stale state for next job
    if (timedOut) {
      try {
        const repoDir = getRepoDir(job.options.repo);
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

  return repoDir;
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
      console.log(`[Orchestrator] Repo ready at ${repoDir}`);
    } catch (err) {
      console.error('[Orchestrator] Warmup failed (will retry on first job):', err);
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

export function getQueueStatus(): { running: boolean; queued: number; runningForMs: number | null } {
  return {
    running,
    queued: queue.length,
    runningForMs: currentJobStart ? Date.now() - currentJobStart : null,
  };
}

/**
 * Force-clear the running flag and drain the queue.
 * Use when the queue is stuck and no other fix works.
 */
export function forceResetQueue(): { drained: number } {
  const drained = queue.length;
  for (const job of queue) {
    job.resolve({ success: false, error: 'Queue was force-reset by admin.' });
    if (job.options.attachments?.length) deleteUploads(job.options.attachments);
  }
  queue.length = 0;
  running = false;
  currentJobStart = null;
  console.warn(`[JobRunner] Queue force-reset. Drained ${drained} queued jobs.`);
  return { drained };
}

export function runCodingTask(options: CodingTaskOptions): Promise<OrchestratorResult> {
  if (queue.length >= MAX_QUEUE_SIZE) {
    return Promise.resolve({
      success: false,
      error: `Queue is full (${MAX_QUEUE_SIZE} jobs waiting). Try again later.`,
    });
  }

  console.log(`[JobRunner] Queued job #${options.issueNumber || '?'} (${queue.length + 1} in queue, ${running ? 'one running' : 'idle'})`);

  return new Promise((resolve, reject) => {
    queue.push({ options, resolve, reject, enqueuedAt: Date.now() });
    processQueue();
  });
}

// ─── Task Execution ───────────────────────────────────────────────────────────

async function executeTask(options: CodingTaskOptions): Promise<OrchestratorResult> {
  const { task, title, issueNumber, requestedBy, attachments, repo } = options;
  const targetRepo = repo || GITHUB_REPO;
  const prTitle = title || task.split('\n')[0].slice(0, 80);
  const agent = getAgent();

  console.log(`[Orchestrator] Starting task with ${agent.name} on ${targetRepo}: "${prTitle}"`);

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
        console.warn(`[Orchestrator] Failed to copy attachment ${fileName}:`, err);
      }
    }
  }

  // 3. Run the coding agent
  let result: AgentResult;
  try {
    result = await agent.execute(
      { prompt: task },
      repoDir
    );
  } catch (err) {
    git(['checkout', 'main'], repoDir);
    return { success: false, error: `Agent failed: ${err}` };
  }

  if (!result.success) {
    git(['checkout', 'main'], repoDir);
    return { success: false, error: result.error || 'Agent reported failure.' };
  }

  // 4. Check if there are actual changes
  const status = git(['status', '--porcelain'], repoDir);
  if (!status) {
    git(['checkout', 'main'], repoDir);
    return { success: false, error: 'Agent finished but made no changes.' };
  }

  // 5. Commit and push
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
    return { success: false, error: `Failed to push: ${err}` };
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

    const { data: pr } = await octokit.pulls.create({
      owner: GITHUB_OWNER,
      repo: targetRepo,
      title: prTitle,
      body: prBody,
      head: branchName,
      base: 'main',
    });

    // 7. Cleanup: switch to main, delete local branch
    git(['checkout', 'main'], repoDir);
    try { git(['branch', '-D', branchName], repoDir); } catch { /* already gone */ }

    return {
      success: true,
      prUrl: pr.html_url,
      issueNumber,
      summary: result.summary,
    };
  } catch (err) {
    git(['checkout', 'main'], repoDir);
    return { success: false, error: `PR creation failed: ${err}` };
  }
}

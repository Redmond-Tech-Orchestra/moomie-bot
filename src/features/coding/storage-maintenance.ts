import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LAST_USED_FILE = '.moomie-last-used';
const REBUILDABLE_NAMES = ['node_modules', 'dist'];

export interface StorageMaintenancePolicy {
  workspaceDir: string;
  protectedWorkspaces: string[];
  workspaceMaxBytes: number;
  workspaceRetentionMs: number;
  rebuildableRetentionMs: number;
  cacheMaxBytes: number;
  cacheRetentionMs: number;
  scratchRetentionMs: number;
  cacheRoots: string[];
  scratchRoots: string[];
}

export interface MaintenanceAction {
  path: string;
  reason: string;
  estimatedBytes: number;
}

export interface MaintenanceResult {
  dryRun: boolean;
  actions: MaintenanceAction[];
  estimatedBytes: number;
  reclaimedBytes: number;
  skippedActivePaths: string[];
  cacheCleanupSkipped: boolean;
}

interface Entry {
  path: string;
  bytes: number;
  lastUsedMs: number;
}

const activeWorkspaces = new Map<string, number>();
let maintenanceRun: Promise<MaintenanceResult> | null = null;

function normalize(candidate: string): string {
  return path.resolve(candidate);
}

export function getActiveWorkspacePaths(): string[] {
  return [...activeWorkspaces.keys()];
}

export async function withActiveWorkspace<T>(workspacePath: string, work: () => Promise<T>): Promise<T> {
  const normalized = normalize(workspacePath);
  activeWorkspaces.set(normalized, (activeWorkspaces.get(normalized) ?? 0) + 1);
  markWorkspaceUsed(normalized);
  try {
    return await work();
  } finally {
    markWorkspaceUsed(normalized);
    const remaining = (activeWorkspaces.get(normalized) ?? 1) - 1;
    if (remaining > 0) activeWorkspaces.set(normalized, remaining);
    else activeWorkspaces.delete(normalized);
  }
}

export function markWorkspaceUsed(workspacePath: string, now = new Date()): void {
  try {
    if (!fs.existsSync(workspacePath)) return;
    const marker = path.join(workspacePath, LAST_USED_FILE);
    fs.closeSync(fs.openSync(marker, 'a'));
    fs.utimesSync(marker, now, now);
  } catch {
    // Usage tracking is advisory; a repository operation should not fail for it.
  }
}

function directorySize(candidate: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(candidate, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = path.join(candidate, entry.name);
    try {
      if (entry.isDirectory()) total += directorySize(child);
      else if (entry.isFile()) total += fs.statSync(child).size;
    } catch {
      // Files may disappear while measuring caches; continue with the snapshot.
    }
  }
  return total;
}

function lastUsed(candidate: string): number {
  const marker = path.join(candidate, LAST_USED_FILE);
  try {
    return fs.statSync(marker).mtimeMs;
  } catch {
    try {
      return fs.statSync(candidate).mtimeMs;
    } catch {
      return 0;
    }
  }
}

function childDirectories(root: string): Entry[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const entryPath = path.join(root, entry.name);
        return { path: entryPath, bytes: directorySize(entryPath), lastUsedMs: lastUsed(entryPath) };
      });
  } catch {
    return [];
  }
}

function removeEntry(entry: Entry, reason: string, dryRun: boolean, actions: MaintenanceAction[]): number {
  actions.push({ path: entry.path, reason, estimatedBytes: entry.bytes });
  if (!dryRun) fs.rmSync(entry.path, { recursive: true, force: true });
  return entry.bytes;
}

function pruneRoot(
  root: string,
  maxBytes: number,
  retentionMs: number,
  nowMs: number,
  dryRun: boolean,
  actions: MaintenanceAction[],
  reasonPrefix: string,
): number {
  const entries = childDirectories(root).sort((left, right) => left.lastUsedMs - right.lastUsedMs);
  let currentBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let reclaimed = 0;
  for (const entry of entries) {
    const expired = nowMs - entry.lastUsedMs > retentionMs;
    if (!expired && currentBytes <= maxBytes) continue;
    const reason = expired ? `${reasonPrefix} older than retention` : `${reasonPrefix} over size limit`;
    const removed = removeEntry(entry, reason, dryRun, actions);
    currentBytes -= removed;
    reclaimed += removed;
  }
  return reclaimed;
}

function pruneRoots(
  roots: string[],
  maxBytes: number,
  retentionMs: number,
  nowMs: number,
  dryRun: boolean,
  actions: MaintenanceAction[],
  reasonPrefix: string,
): number {
  const entries = roots.flatMap(childDirectories).sort((left, right) => left.lastUsedMs - right.lastUsedMs);
  let currentBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let reclaimed = 0;
  for (const entry of entries) {
    const expired = nowMs - entry.lastUsedMs > retentionMs;
    if (!expired && currentBytes <= maxBytes) continue;
    const reason = expired ? `${reasonPrefix} older than retention` : `${reasonPrefix} over shared size limit`;
    const removed = removeEntry(entry, reason, dryRun, actions);
    currentBytes -= removed;
    reclaimed += removed;
  }
  return reclaimed;
}

function runMaintenance(policy: StorageMaintenancePolicy, dryRun: boolean, nowMs: number): MaintenanceResult {
  const actions: MaintenanceAction[] = [];
  const skippedActivePaths: string[] = [];
  const active = new Set(getActiveWorkspacePaths().map(normalize));
  const protectedPaths = new Set(policy.protectedWorkspaces.map(normalize));
  const workspaces = childDirectories(policy.workspaceDir).sort((left, right) => left.lastUsedMs - right.lastUsedMs);
  let workspaceBytes = workspaces.reduce((sum, entry) => sum + entry.bytes, 0);
  let reclaimedBytes = 0;

  for (const workspace of workspaces) {
    if (active.has(normalize(workspace.path))) {
      skippedActivePaths.push(workspace.path);
      continue;
    }
    for (const name of REBUILDABLE_NAMES) {
      const rebuildablePath = path.join(workspace.path, name);
      if (!fs.existsSync(rebuildablePath)) continue;
      const entry = { path: rebuildablePath, bytes: directorySize(rebuildablePath), lastUsedMs: workspace.lastUsedMs };
      const expired = nowMs - workspace.lastUsedMs > policy.rebuildableRetentionMs;
      if (!expired && workspaceBytes <= policy.workspaceMaxBytes) continue;
      const reason = expired ? 'inactive rebuildable content older than retention' : 'workspace storage over size limit';
      const removed = removeEntry(entry, reason, dryRun, actions);
      workspaceBytes -= removed;
      reclaimedBytes += removed;
    }
  }

  for (const workspace of workspaces) {
    if (active.has(normalize(workspace.path)) || protectedPaths.has(normalize(workspace.path))) continue;
    const expired = nowMs - workspace.lastUsedMs > policy.workspaceRetentionMs;
    if (!expired && workspaceBytes <= policy.workspaceMaxBytes) continue;
    const remainingBytes = dryRun
      ? Math.max(0, workspace.bytes - actions.filter((action) => action.path.startsWith(`${workspace.path}${path.sep}`)).reduce((sum, action) => sum + action.estimatedBytes, 0))
      : directorySize(workspace.path);
    const removed = removeEntry(
      { ...workspace, bytes: remainingBytes },
      expired ? 'inactive checkout older than retention' : 'workspace storage over size limit',
      dryRun,
      actions,
    );
    workspaceBytes -= removed;
    reclaimedBytes += removed;
  }

  const cacheCleanupSkipped = active.size > 0;
  if (!cacheCleanupSkipped) {
    reclaimedBytes += pruneRoots(
      policy.cacheRoots,
      policy.cacheMaxBytes,
      policy.cacheRetentionMs,
      nowMs,
      dryRun,
      actions,
      'cache entry',
    );
  }
  for (const root of policy.scratchRoots) {
    reclaimedBytes += pruneRoot(root, Number.MAX_SAFE_INTEGER, policy.scratchRetentionMs, nowMs, dryRun, actions, 'scratch entry');
  }

  return {
    dryRun,
    actions,
    estimatedBytes: actions.reduce((sum, action) => sum + action.estimatedBytes, 0),
    reclaimedBytes: dryRun ? 0 : reclaimedBytes,
    skippedActivePaths,
    cacheCleanupSkipped,
  };
}

export async function maintainStorage(
  policy: StorageMaintenancePolicy,
  options: { dryRun?: boolean; nowMs?: number } = {},
): Promise<MaintenanceResult> {
  if (maintenanceRun) return maintenanceRun;
  maintenanceRun = Promise.resolve().then(() => runMaintenance(policy, options.dryRun ?? false, options.nowMs ?? Date.now()));
  try {
    return await maintenanceRun;
  } finally {
    maintenanceRun = null;
  }
}

export function defaultCacheRoots(homeDir = os.homedir()): string[] {
  return [
    path.join(homeDir, '.npm', '_cacache'),
    path.join(homeDir, '.cache', 'ms-playwright'),
    path.join(homeDir, '.codex', 'tmp'),
    path.join(homeDir, '.codex', 'plugins', 'cache'),
    path.join(homeDir, '.gemini', 'tmp'),
  ];
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function storagePolicyFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): StorageMaintenancePolicy {
  const workspaceDir = path.resolve(env.AGENT_WORKSPACE || './workspace');
  const owner = env.GITHUB_OWNER || 'Redmond-Tech-Orchestra';
  const defaultRepo = env.GITHUB_REPO || 'redmond-tech-orchestra.github.io';
  const gb = 1024 * 1024 * 1024;
  const dayMs = 24 * 60 * 60 * 1000;
  return {
    workspaceDir,
    protectedWorkspaces: [path.join(workspaceDir, `${owner}--${defaultRepo}`)],
    workspaceMaxBytes: positiveNumber(env.WORKSPACE_MAX_GB, 3) * gb,
    workspaceRetentionMs: positiveNumber(env.WORKSPACE_RETENTION_DAYS, 30) * dayMs,
    rebuildableRetentionMs: positiveNumber(env.REBUILDABLE_RETENTION_DAYS, 7) * dayMs,
    cacheMaxBytes: positiveNumber(env.TOOL_CACHE_MAX_GB, 2) * gb,
    cacheRetentionMs: positiveNumber(env.TOOL_CACHE_RETENTION_DAYS, 30) * dayMs,
    scratchRetentionMs: dayMs,
    cacheRoots: defaultCacheRoots(homeDir),
    scratchRoots: [],
  };
}

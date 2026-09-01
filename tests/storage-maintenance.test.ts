import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  maintainStorage,
  markWorkspaceUsed,
  withActiveWorkspace,
  type StorageMaintenancePolicy,
} from '../src/features/coding/storage-maintenance.js';

function fixture(): { root: string; policy: StorageMaintenancePolicy } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moomie-maintenance-test-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir);
  return {
    root,
    policy: {
      workspaceDir,
      protectedWorkspaces: [],
      workspaceMaxBytes: 10,
      workspaceRetentionMs: 30 * 24 * 60 * 60 * 1000,
      rebuildableRetentionMs: 7 * 24 * 60 * 60 * 1000,
      cacheMaxBytes: 10,
      cacheRetentionMs: 7 * 24 * 60 * 60 * 1000,
      scratchRetentionMs: 24 * 60 * 60 * 1000,
      cacheRoots: [],
      scratchRoots: [],
    },
  };
}

test('dry run selects stale rebuildable content before its checkout', async (t) => {
  const { root, policy } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(policy.workspaceDir, 'owner--repo');
  const modules = path.join(repo, 'node_modules', 'package');
  fs.mkdirSync(modules, { recursive: true });
  fs.writeFileSync(path.join(modules, 'payload'), Buffer.alloc(32));
  markWorkspaceUsed(repo, new Date('2026-01-01T00:00:00Z'));

  const result = await maintainStorage(policy, { dryRun: true, nowMs: Date.parse('2026-01-10T00:00:00Z') });

  assert.equal(result.actions[0]?.path, path.join(repo, 'node_modules'));
  assert.ok(result.estimatedBytes >= 32);
  assert.equal(result.reclaimedBytes, 0);
  assert.equal(fs.existsSync(modules), true);
});

test('active workspace and shared caches are protected', async (t) => {
  const { root, policy } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(policy.workspaceDir, 'owner--active');
  const modules = path.join(repo, 'node_modules', 'package');
  fs.mkdirSync(modules, { recursive: true });
  fs.writeFileSync(path.join(modules, 'payload'), Buffer.alloc(32));

  await withActiveWorkspace(repo, async () => {
    const result = await maintainStorage(policy, { dryRun: false, nowMs: Date.now() + 60 * 24 * 60 * 60 * 1000 });
    assert.deepEqual(result.skippedActivePaths, [repo]);
    assert.equal(result.cacheCleanupSkipped, true);
    assert.equal(result.actions.length, 0);
    assert.equal(fs.existsSync(modules), true);
  });
});

test('leasing a missing workspace does not create an empty checkout', async (t) => {
  const { root, policy } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(policy.workspaceDir, 'owner--not-cloned');

  await withActiveWorkspace(repo, async () => {
    assert.equal(fs.existsSync(repo), false);
  });

  assert.equal(fs.existsSync(repo), false);
});

test('cache size limit is shared across managed tool roots', async (t) => {
  const { root, policy } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const npmRoot = path.join(root, 'npm-cache');
  const browserRoot = path.join(root, 'browser-cache');
  for (const cacheRoot of [npmRoot, browserRoot]) {
    const entry = path.join(cacheRoot, 'entry');
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(path.join(entry, 'payload'), Buffer.alloc(8));
  }
  policy.cacheRoots = [npmRoot, browserRoot];
  policy.cacheMaxBytes = 10;

  const result = await maintainStorage(policy, { dryRun: true });

  assert.equal(result.actions.length, 1);
  assert.match(result.actions[0].reason, /shared size limit/);
});
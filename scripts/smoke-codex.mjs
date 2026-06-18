// Live smoke test for the Codex coding agent. Creates a throwaway git repo,
// runs a tiny coding task through the real CodexAgent, streams progress, and
// prints the resulting file + summary. Auth comes from OPENAI_API_KEY in .env.
//
//   node scripts/smoke-codex.mjs
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const { CodexAgent } = await import('../dist/features/coding/agents/codex-cli.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-'));
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.email', 'smoke@test.local');
git('config', 'user.name', 'smoke');
fs.writeFileSync(path.join(dir, 'README.md'), '# Smoke repo\n');
git('add', '.');
git('commit', '-qm', 'init');
console.log('workspace:', dir);

const agent = new CodexAgent();
const t0 = Date.now();
const result = await agent.execute(
  { prompt: 'Create a file named hello.txt containing exactly the line: hello from codex' },
  dir,
  (p) => console.log(`  [+${(p.elapsedMs / 1000).toFixed(1)}s]${p.toolName ? ` (${p.toolName})` : ''} ${p.headline}`),
);

console.log(`\nelapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('success:', result.success);
console.log('summary:', result.summary);
if (result.error) console.log('error:', result.error);

const target = path.join(dir, 'hello.txt');
console.log('\nhello.txt exists:', fs.existsSync(target));
if (fs.existsSync(target)) console.log('contents:', JSON.stringify(fs.readFileSync(target, 'utf8')));
console.log('\ngit status:\n' + git('status', '--porcelain').toString());

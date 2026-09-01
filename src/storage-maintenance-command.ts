import 'dotenv/config';
import {
  maintainStorage,
  storagePolicyFromEnvironment,
} from './features/coding/storage-maintenance.js';

function formatBytes(bytes: number): string {
  const gb = 1024 * 1024 * 1024;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < gb) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / gb).toFixed(2)} GB`;
}

if (process.argv.includes('--apply')) {
  console.error('This command is dry-run only. Live cleanup runs inside Moomie so active jobs remain protected.');
  process.exitCode = 2;
} else {
  const result = await maintainStorage(storagePolicyFromEnvironment(), { dryRun: true });
  console.log(`Dry run found ${formatBytes(result.estimatedBytes)} across ${result.actions.length} path(s).`);
  for (const action of result.actions) {
    console.log(`Would remove ${action.path} (${formatBytes(action.estimatedBytes)}): ${action.reason}`);
  }
}
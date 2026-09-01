import {
  STORAGE_MAINTENANCE_ENABLED,
  STORAGE_MAINTENANCE_INTERVAL_HOURS,
} from '../../config.js';
import { createLogger } from '../../logger.js';
import { getChatTurnStatus } from '../chat/active-turns.js';
import {
  maintainStorage,
  storagePolicyFromEnvironment,
  type MaintenanceResult,
  type StorageMaintenancePolicy,
} from './storage-maintenance.js';

const log = createLogger('StorageMaintenance');
const GB = 1024 * 1024 * 1024;

export function configuredStoragePolicy(): StorageMaintenancePolicy {
  return storagePolicyFromEnvironment();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}

export function logMaintenanceResult(result: MaintenanceResult): void {
  const amount = result.dryRun ? result.estimatedBytes : result.reclaimedBytes;
  log.info(`${result.dryRun ? 'Dry run found' : 'Reclaimed'} ${formatBytes(amount)} across ${result.actions.length} path(s).`);
  for (const action of result.actions) {
    log.info(`${result.dryRun ? 'Would remove' : 'Removed'} ${action.path} (${formatBytes(action.estimatedBytes)}): ${action.reason}`);
  }
  if (result.skippedActivePaths.length > 0) {
    log.info(`Protected ${result.skippedActivePaths.length} active workspace(s); shared cache cleanup was skipped.`);
  }
}

export async function startStorageMaintenance(): Promise<void> {
  if (!STORAGE_MAINTENANCE_ENABLED) {
    log.info('Automatic storage maintenance is disabled.');
    return;
  }
  const policy = configuredStoragePolicy();
  const run = async () => {
    if (getChatTurnStatus().active > 0) {
      log.info('Deferring storage maintenance while chat turns are active.');
      return;
    }
    try {
      logMaintenanceResult(await maintainStorage(policy));
    } catch (err) {
      log.warn('Storage maintenance failed; bot operation will continue:', err);
    }
  };
  await run();
  const timer = setInterval(() => { void run(); }, STORAGE_MAINTENANCE_INTERVAL_HOURS * 60 * 60 * 1000);
  timer.unref();
}
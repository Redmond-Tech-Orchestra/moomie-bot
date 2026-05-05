import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Features must never import platform libraries or adapter internals directly.
    // They go through src/adapters/index.ts (the barrel) for all platform I/O.
    files: ['src/features/**/*.ts'],
    ignores: ['src/features/admin/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'discord.js', message: 'Features must use src/adapters/index.ts for platform I/O.' },
          { name: 'botbuilder', message: 'Features must use src/adapters/index.ts for platform I/O.' },
        ],
        patterns: [
          { group: ['**/adapters/discord*'], message: 'Import from adapters/index.js instead.' },
          { group: ['**/adapters/teams*'], message: 'Import from adapters/index.js instead.' },
          { group: ['**/adapters/notify*'], message: 'Import from adapters/index.js instead.' },
        ],
      }],
      // Use createLogger() from src/logger.ts instead of bare console calls.
      'no-console': 'error',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'workspace/'],
  },
);

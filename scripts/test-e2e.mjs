import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');
const databaseConfig = 'APP_CONFIG_backend_database_connection_directory';
const databaseDirectory =
  process.env[databaseConfig] === undefined
    ? await mkdtemp(join(tmpdir(), 'frontstage-e2e-'))
    : undefined;

try {
  const runner = spawn(
    process.execPath,
    [cli, 'test', ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(databaseDirectory && { [databaseConfig]: databaseDirectory }),
      },
    },
  );
  const interrupt = () => runner.kill('SIGINT');
  const terminate = () => runner.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const [code, signal] = await once(runner, 'close');
    process.exitCode = code ?? 128 + constants.signals[signal];
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
} finally {
  if (databaseDirectory)
    await rm(databaseDirectory, { recursive: true, force: true });
}

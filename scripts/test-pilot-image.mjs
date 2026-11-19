import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2] ?? 'frontstage:pilot';
const network = `frontstage-pilot-${randomUUID()}`;
const database = `${network}-db`;
const app = `${network}-app`;
const databasePassword = randomUUID();
const appOrigin = 'http://localhost:7007';
const oauthClientId = 'frontstage-smoke-client';
const oauthSecret = randomUUID();
const interruption = new AbortController();
process.once('SIGINT', () => interruption.abort(130));
process.once('SIGTERM', () => interruption.abort(143));

function docker(args, { allowFailure = false, timeout = 30_000 } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout,
  });
  if (result.error) {
    if (allowFailure) return undefined;
    throw result.error;
  }
  if (result.status !== 0) {
    if (allowFailure) return undefined;
    throw new Error(result.stderr.trim() || `docker ${args[0]} failed`);
  }
  return result.stdout.trim();
}

async function waitFor(description, check) {
  const until = Date.now() + 60_000;
  do {
    if (check()) return;
    await delay(1_000, undefined, { signal: interruption.signal });
  } while (Date.now() < until);
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  docker(['image', 'inspect', image]);
  docker(['network', 'create', network]);
  docker(
    [
      'run',
      '--detach',
      '--name',
      database,
      '--network',
      network,
      '-e',
      `POSTGRES_PASSWORD=${randomUUID()}`,
      'postgres:17',
    ],
    { timeout: 120_000 },
  );
  await waitFor(
    'PostgreSQL readiness',
    () =>
      docker(
        ['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
        { allowFailure: true },
      ) !== undefined,
  );
  for (const sql of [
    `CREATE ROLE frontstage LOGIN PASSWORD '${databasePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    'CREATE DATABASE frontstage_pilot OWNER frontstage',
  ]) {
    docker([
      'exec',
      database,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-c',
      sql,
    ]);
  }
  docker([
    'run',
    '--detach',
    '--name',
    app,
    '--network',
    network,
    '-e',
    `FRONTSTAGE_POSTGRES_URL=postgresql://frontstage:${databasePassword}@${database}:5432/frontstage_pilot`,
    '-e',
    `FRONTSTAGE_GITHUB_CLIENT_ID=${oauthClientId}`,
    '-e',
    `FRONTSTAGE_GITHUB_CLIENT_SECRET=${oauthSecret}`,
    '-e',
    `APP_CONFIG_app_baseUrl=${appOrigin}`,
    '-e',
    `APP_CONFIG_backend_baseUrl=${appOrigin}`,
    '-e',
    `APP_CONFIG_backend_cors_origin=${appOrigin}`,
    image,
  ]);
  await waitFor('Frontstage container health', () => {
    const state = docker([
      'inspect',
      app,
      '--format',
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
    ]);
    if (state.startsWith('exited'))
      throw new Error('Frontstage exited during startup');
    if (state === 'running unhealthy')
      throw new Error('Frontstage container is unhealthy');
    return state === 'running healthy';
  });

  docker([
    'exec',
    app,
    'node',
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    const origin = ${JSON.stringify(appOrigin)};
    assert.notEqual(process.getuid(), 0);
    const response = await fetch(origin + '/');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<!--|<!doctype html>/i);
    assert.match(html, /AI App Governance/);
    assert.ok(!html.includes(process.env.FRONTSTAGE_GITHUB_CLIENT_SECRET));
    const guest = await fetch(origin + '/api/auth/guest/refresh', {
      headers: { Origin: origin, 'X-Requested-With': 'XMLHttpRequest' },
    });
    assert.equal(guest.status, 404);
    const start = new URL('/api/auth/github/start', origin);
    start.search = new URLSearchParams({ env: 'pilot', origin, flow: 'popup' }).toString();
    const oauth = await fetch(start, { redirect: 'manual' });
    assert.equal(oauth.status, 302);
    const redirect = new URL(oauth.headers.get('location'));
    assert.equal(redirect.origin + redirect.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(redirect.searchParams.get('client_id'), process.env.FRONTSTAGE_GITHUB_CLIENT_ID);
    assert.equal(redirect.searchParams.get('redirect_uri'), origin + '/api/auth/github/handler/frame');
  `,
  ]);
  const table = docker([
    'exec',
    database,
    'psql',
    '-At',
    '-U',
    'postgres',
    '-d',
    'frontstage_pilot',
    '-c',
    "SELECT to_regclass('governance.governance_apps')",
  ]);
  if (table !== 'governance.governance_apps')
    throw new Error('The governance migration did not create its app table');

  console.log(
    'Pilot image is healthy, non-root, and serving Frontstage on PostgreSQL. OAuth redirect verified.',
  );
} catch (error) {
  if (interruption.signal.aborted) {
    process.exitCode = interruption.signal.reason;
  } else {
    console.error(error.message);
    const logs = docker(['logs', '--tail', '25', app], { allowFailure: true });
    if (logs) console.error(logs);
    process.exitCode = 1;
  }
} finally {
  docker(['rm', '-f', '-v', app, database], { allowFailure: true });
  docker(['network', 'rm', network], { allowFailure: true });
}

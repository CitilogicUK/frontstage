import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const image = process.argv[2] ?? 'frontstage:pilot';
const network = `frontstage-pilot-${randomUUID()}`;
const database = `${network}-db`;
const app = `${network}-app`;
const restoredApp = `${network}-restored-app`;
const sourceDatabase = 'frontstage_pilot';
const restoredDatabase = 'frontstage_restored';
const backupPath = '/tmp/frontstage-pilot.dump';
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

async function waitForAppHealth(container, stage) {
  await waitFor(`Frontstage container health after ${stage}`, () => {
    const state = docker([
      'inspect',
      container,
      '--format',
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
    ]);
    if (state.startsWith('exited'))
      throw new Error(`Frontstage exited after ${stage}`);
    if (state === 'running unhealthy')
      throw new Error(`Frontstage container is unhealthy after ${stage}`);
    return state === 'running healthy';
  });
}

function startPilotApp(container, targetDatabase) {
  docker([
    'run',
    '--detach',
    '--name',
    container,
    '--network',
    network,
    '-e',
    `FRONTSTAGE_POSTGRES_URL=postgresql://frontstage:${databasePassword}@${database}:5432/${targetDatabase}`,
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
    '-v',
    `${fileURLToPath(
      new URL('../examples/pilot-identity-config.yaml', import.meta.url),
    )}:/app/app-config.identity.local.yaml:ro`,
    '-v',
    `${fileURLToPath(
      new URL('../examples/pilot-identities.yaml', import.meta.url),
    )}:/app/pilot-identities.yaml:ro`,
    image,
    '--config',
    'app-config.yaml',
    '--config',
    'app-config.postgres.yaml',
    '--config',
    'app-config.github-signin.yaml',
    '--config',
    'app-config.identity.local.yaml',
  ]);
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
    `CREATE DATABASE ${sourceDatabase} OWNER frontstage`,
    `CREATE DATABASE ${restoredDatabase} OWNER frontstage`,
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
  startPilotApp(app, sourceDatabase);
  await waitForAppHealth(app, 'startup');

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
    for (const [method, path] of [
      ['GET', '/api/governance/apps'],
      ['POST', '/api/governance/apps'],
      ['GET', '/api/governance/reports/registration-feedback'],
      ['GET', '/api/catalog/entities'],
      ['POST', '/api/catalog/locations'],
    ]) {
      const anonymous = await fetch(origin + path, {
        method,
        redirect: 'manual',
        ...(method === 'POST' && {
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
      });
      assert.equal(anonymous.status, 401, method + ' ' + path + ' must require authentication');
      await anonymous.body?.cancel();
    }
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
  function queryPilotDatabase(targetDatabase, ...statements) {
    return docker([
      'exec',
      database,
      'psql',
      '-Atq',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      targetDatabase,
      ...statements.flatMap(statement => ['-c', statement]),
    ]);
  }

  const identityMappings = `SELECT entity_ref || '=' || (final_entity::jsonb #>> '{metadata,annotations,github.com/user-id}')
    FROM catalog.final_entities
    WHERE entity_ref IN ('user:default/pilot-builder', 'user:default/pilot-reviewer')
    ORDER BY entity_ref`;
  const expectedIdentityMappings = [
    'user:default/pilot-builder=example-builder-node-id',
    'user:default/pilot-reviewer=example-reviewer-node-id',
  ].join('\n');
  await waitFor(
    'pilot Catalog identity import',
    () =>
      queryPilotDatabase(sourceDatabase, identityMappings) ===
      expectedIdentityMappings,
  );

  queryPilotDatabase(
    sourceDatabase,
    'SELECT 1 FROM governance.governance_apps LIMIT 0',
    'SELECT token_digest, utc_day, rating FROM governance.governance_registration_feedback LIMIT 0',
    "INSERT INTO governance.governance_tier_one_registration_timing (utc_day, elapsed_seconds) VALUES ('2025-01-01', 12)",
  );
  docker(['restart', app]);
  await waitForAppHealth(app, 'restart');
  const readSample =
    "SELECT elapsed_seconds FROM governance.governance_tier_one_registration_timing WHERE utc_day = '2025-01-01'";
  const persisted = queryPilotDatabase(sourceDatabase, readSample);
  if (persisted !== '12')
    throw new Error('The synthetic timing sample did not survive app restart.');

  docker([
    'exec',
    database,
    'pg_dump',
    '-U',
    'postgres',
    '--format=custom',
    '--file',
    backupPath,
    sourceDatabase,
  ]);
  docker([
    'exec',
    database,
    'pg_restore',
    '-U',
    'postgres',
    '--exit-on-error',
    '--dbname',
    restoredDatabase,
    backupPath,
  ]);
  if (
    queryPilotDatabase(restoredDatabase, identityMappings) !==
    expectedIdentityMappings
  )
    throw new Error(
      'The pilot Catalog identity mappings were missing after restore.',
    );
  startPilotApp(restoredApp, restoredDatabase);
  await waitForAppHealth(restoredApp, 'database restore');
  if (queryPilotDatabase(restoredDatabase, readSample) !== '12')
    throw new Error('The synthetic timing sample was missing after restore.');

  console.log(
    'Pilot image is healthy and non-root. PostgreSQL migrations, Catalog identity import, anonymous API denial, OAuth redirect, restart persistence, and database restore verified.',
  );
} catch (error) {
  if (interruption.signal.aborted) {
    process.exitCode = interruption.signal.reason;
  } else {
    console.error(error.message);
    for (const container of [app, restoredApp]) {
      const logs = docker(['logs', '--tail', '25', container], {
        allowFailure: true,
      });
      if (logs) console.error(logs);
    }
    process.exitCode = 1;
  }
} finally {
  docker(['rm', '-f', '-v', app, restoredApp, database], {
    allowFailure: true,
  });
  docker(['network', 'rm', network], { allowFailure: true });
}

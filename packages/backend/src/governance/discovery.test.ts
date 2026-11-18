import { appSourceKey } from './sourceKey';
import knex, { type Knex } from 'knex';
import {
  discoveryClaimsMigration,
  discoveryDecisionsMigration,
  discoveryMigration,
  discoveryScanMigration,
  githubDiscovery,
} from './discovery';

const table = 'apps';
const configuration = { organization: 'ExampleAI', topic: 'llm' };
let db: Knex;
let github: jest.SpiedFunction<typeof fetch>;

function results(fullName: string) {
  return Response.json({
    total_count: 2,
    incomplete_results: false,
    items: [
      { id: 101, full_name: fullName, description: 'AI prototype' },
      { id: 102, full_name: 'unrelated/private-tool', description: null },
    ],
  });
}

beforeEach(async () => {
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.schema.createTable(table, builder => {
    builder.string('id').primary();
    builder.string('source_key').unique().notNullable();
  });
  await discoveryMigration().up(db);
  await discoveryClaimsMigration(table).up(db);
  await discoveryDecisionsMigration().up(db);
  await discoveryScanMigration().up(db);
  github = jest.spyOn(globalThis, 'fetch');
});

afterEach(async () => {
  github.mockRestore();
  await db.destroy();
});

test('keeps a claim attached to the repository through a rename', async () => {
  const discovery = githubDiscovery(db, table, configuration);
  github.mockResolvedValueOnce(results('ExampleAI/initial-name'));
  await expect(discovery.scan()).resolves.toEqual({ found: 1, partial: false });
  await expect(discovery.list()).resolves.toEqual([
    expect.objectContaining({
      id: '101',
      sourceUrl: 'https://github.com/exampleai/initial-name',
      appId: null,
    }),
  ]);
  await db.transaction(async transaction => {
    await transaction(table).insert({
      id: 'app-1',
      source_key: 'https://github.com/exampleai/initial-name',
    });
    await discovery.markClaimed(
      transaction,
      '101',
      'app-1',
      'https://github.com/exampleai/initial-name',
    );
  });

  github.mockResolvedValueOnce(results('ExampleAI/renamed'));
  await discovery.scan();
  await expect(discovery.list()).resolves.toEqual([
    expect.objectContaining({
      id: '101',
      sourceUrl: 'https://github.com/exampleai/renamed',
      appId: 'app-1',
    }),
  ]);
  await expect(
    db.transaction(async transaction => {
      await transaction(table).insert({
        id: 'app-2',
        source_key: 'https://github.com/exampleai/renamed',
      });
      await discovery.markClaimed(
        transaction,
        '101',
        'app-2',
        'https://github.com/exampleai/renamed',
      );
    }),
  ).rejects.toThrow('already been claimed');
  await expect(db(table).select('id')).resolves.toEqual([{ id: 'app-1' }]);
});

test('rejects a claim using the URL from before a repository rename', async () => {
  const discovery = githubDiscovery(db, table, configuration);
  github.mockResolvedValueOnce(results('ExampleAI/original'));
  await discovery.scan();
  const candidate = await discovery.get('101');
  expect(candidate?.source_url).toBe('https://github.com/exampleai/original');

  github.mockResolvedValueOnce(results('ExampleAI/renamed'));
  await discovery.scan();
  const sourceKey = candidate?.source_url ?? '';
  await expect(
    db.transaction(async transaction => {
      await transaction(table).insert({ id: 'app-1', source_key: sourceKey });
      await discovery.markClaimed(transaction, '101', 'app-1', sourceKey);
    }),
  ).rejects.toThrow('repository has changed');
  await expect(db(table).select('id')).resolves.toEqual([]);
});

test('retains an existing intake registration when its discovered repository is renamed', async () => {
  const discovery = githubDiscovery(db, table, configuration);
  github.mockResolvedValueOnce(results('ExampleAI/original'));
  await discovery.scan();
  await db(table).insert({
    id: 'intake-app',
    source_key: 'https://github.com/exampleai/original',
  });

  github.mockResolvedValueOnce(results('ExampleAI/renamed'));
  await discovery.scan();

  expect(await discovery.list()).toEqual([
    expect.objectContaining({
      id: '101',
      sourceUrl: 'https://github.com/exampleai/renamed',
      appId: 'intake-app',
    }),
  ]);
});

test('links an intake registration immediately and rejects a stale dismissal', async () => {
  const discovery = githubDiscovery(db, table, configuration);
  github.mockResolvedValueOnce(results('ExampleAI/tool'));
  await discovery.scan();

  const sourceKey = appSourceKey('https://github.com/ExampleAI/Tool.git/');
  await db.transaction(async transaction => {
    await transaction(table).insert({
      id: 'intake-app',
      source_key: sourceKey,
    });
    await discovery.linkRegistered(transaction, sourceKey, 'intake-app');
  });
  const linked = await db('governance_discovered_repositories')
    .where({ id: '101' })
    .first('app_id');
  expect(linked).toEqual({ app_id: 'intake-app' });
  await expect(
    discovery.decide('101', 'user:default/reviewer', 'Library, not an app'),
  ).rejects.toThrow('no longer available');
  expect(await db('governance_discovery_decisions')).toEqual([]);
});

test('preserves the queue on a GitHub outage and scopes results by topic', async () => {
  const discovery = githubDiscovery(db, table, configuration);
  github.mockResolvedValueOnce(results('ExampleAI/tool'));
  await discovery.scan();
  github.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(discovery.scan()).rejects.toThrow(
    'GitHub discovery could not complete',
  );
  await expect(discovery.list()).resolves.toHaveLength(1);

  const otherTopic = githubDiscovery(db, table, {
    ...configuration,
    topic: 'agent',
  });
  await expect(otherTopic.list()).resolves.toEqual([]);
  await expect(otherTopic.get('101')).resolves.toBeUndefined();
});

test('keeps dismissal through rescans, rejects claims, and records reopening', async () => {
  const discovery = githubDiscovery(db, table, configuration);
  github.mockResolvedValueOnce(results('ExampleAI/tool'));
  await discovery.scan();
  await discovery.decide('101', 'user:default/reviewer', 'Library, not an app');
  github.mockResolvedValueOnce(results('ExampleAI/tool'));
  await discovery.scan();
  expect((await discovery.list())[0]).toMatchObject({ dismissed: 1 });
  expect((await discovery.list())[0]).not.toHaveProperty('dismissalReason');
  expect((await discovery.list(true))[0]).toMatchObject({
    dismissalReason: 'Library, not an app',
  });
  await expect(
    db.transaction(async transaction => {
      await transaction(table).insert({
        id: 'blocked',
        source_key: 'https://github.com/exampleai/tool',
      });
      await discovery.markClaimed(
        transaction,
        '101',
        'blocked',
        'https://github.com/exampleai/tool',
      );
    }),
  ).rejects.toThrow('dismissed');
  expect(await db(table).select('id')).toEqual([]);
  await discovery.decide('101', 'user:default/reviewer', null);
  expect((await discovery.list())[0]).toMatchObject({ dismissed: 0 });
  expect(
    await db('governance_discovery_decisions')
      .select('decision', 'actor')
      .orderBy('id'),
  ).toEqual([
    { decision: 'dismissed', actor: 'user:default/reviewer' },
    { decision: 'reopened', actor: 'user:default/reviewer' },
  ]);
});

test('records scheduled results and merges overlapping attempts in the same process', async () => {
  const discovery = githubDiscovery(db, table, configuration);
  github.mockResolvedValueOnce(results('ExampleAI/tool'));
  const first = discovery.scan('scheduled');
  expect(discovery.scan('manual')).toBe(first);
  await first;
  expect(github).toHaveBeenCalledTimes(1);
  expect(await discovery.lastScan()).toMatchObject({
    trigger: 'scheduled',
    status: 'completed',
    found: 1,
  });
  github.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(discovery.scan()).rejects.toThrow(
    'GitHub discovery could not complete',
  );
  expect(await discovery.lastScan()).toMatchObject({
    trigger: 'manual',
    status: 'failed',
  });
});

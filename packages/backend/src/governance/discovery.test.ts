import { appSourceKey } from './sourceKey';
import knex, { type Knex } from 'knex';
import {
  discoveryClaimsMigration,
  discoveryDecisionsMigration,
  discoveryMigration,
  discoveryScanMigration,
  discoveryVisibilityMigration,
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
      {
        id: 101,
        full_name: fullName,
        description: 'AI prototype',
        private: false,
      },
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
  await discoveryVisibilityMigration().up(db);
  github = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Mocked GitHub network failure'));
});

afterEach(async () => {
  github.mockRestore();
  await db.destroy();
});

test('keeps previously linked rows private to reviewers until visibility is verified', async () => {
  await discoveryVisibilityMigration().down(db);
  const sourceUrl = 'https://github.com/exampleai/legacy';
  await db(table).insert({ id: 'legacy-app', source_key: sourceUrl });
  const before = new Date().toISOString();
  await db('governance_discovered_repositories').insert({
    id: '101',
    source_url: sourceUrl,
    name: 'exampleai/legacy',
    description: 'Unverified visibility',
    topic: 'llm',
    app_id: 'legacy-app',
    first_seen: before,
    last_seen: before,
  });
  await discoveryVisibilityMigration().up(db);

  const discovery = githubDiscovery(db, table, configuration);
  await expect(discovery.list()).resolves.toEqual([]);
  await expect(discovery.list(true)).resolves.toEqual([
    expect.objectContaining({ id: '101', appId: 'legacy-app' }),
  ]);
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

test('keeps previous unclaimed rows during a partial scan and retires them on a complete scan', async () => {
  const discovery = githubDiscovery(db, table, configuration);
  const project = {
    id: 101,
    full_name: 'ExampleAI/tool',
    description: null,
    private: false,
  };
  const linked = { ...project, id: 102, full_name: 'ExampleAI/linked' };
  const dismissed = { ...project, id: 103, full_name: 'ExampleAI/dismissed' };
  const reply = (items: object[], total = items.length) =>
    Response.json({ total_count: total, incomplete_results: false, items });

  github.mockResolvedValueOnce(reply([project, linked, dismissed]));
  await discovery.scan();
  await db.transaction(async transaction => {
    const sourceKey = 'https://github.com/exampleai/linked';
    await transaction(table).insert({
      id: 'linked-app',
      source_key: sourceKey,
    });
    await discovery.markClaimed(transaction, '102', 'linked-app', sourceKey);
  });
  await discovery.decide('103', 'user:default/reviewer', 'Out of scope');

  github.mockResolvedValueOnce(reply([], 100));
  await expect(discovery.scan()).resolves.toMatchObject({ partial: true });
  await expect(discovery.list()).resolves.toHaveLength(3);
  await expect(discovery.get('101')).resolves.toMatchObject({
    source_url: 'https://github.com/exampleai/tool',
  });

  github.mockResolvedValueOnce(reply([]));
  await expect(discovery.scan()).resolves.toMatchObject({ partial: false });
  await expect(discovery.list()).resolves.toEqual([]);
  await expect(discovery.list(true)).resolves.toEqual([
    expect.objectContaining({ id: '102', appId: 'linked-app' }),
  ]);
  await expect(discovery.get('101', true)).resolves.toBeUndefined();
  await expect(discovery.descriptor('101', true)).resolves.toBeUndefined();
  expect(github).toHaveBeenCalledTimes(3);
  expect(await db('governance_discovery_decisions')).toHaveLength(1);

  github.mockResolvedValueOnce(reply([project, dismissed]));
  await discovery.scan();
  await expect(discovery.list(true)).resolves.toEqual([
    expect.objectContaining({ id: '103', dismissed: 1 }),
    expect.objectContaining({ id: '102', appId: 'linked-app' }),
    expect.objectContaining({ id: '101' }),
  ]);
  await expect(discovery.get('101')).resolves.toBeDefined();
  expect(await db('governance_discovery_decisions')).toHaveLength(1);
});

test('rechecks public visibility in the transaction after a visibility change', async () => {
  const discovery = githubDiscovery(db, table, configuration);
  const repo = { id: 101, full_name: 'ExampleAI/tool', description: null };
  const reply = (visibility: string, isPrivate: boolean) =>
    Response.json({
      total_count: 1,
      incomplete_results: false,
      items: [{ ...repo, visibility, private: isPrivate }],
    });
  github.mockResolvedValueOnce(reply('public', false));
  await discovery.scan();
  const sourceUrl = (await discovery.get('101'))?.source_url ?? '';
  expect(sourceUrl).toBe('https://github.com/exampleai/tool');

  github.mockResolvedValueOnce(reply('internal', false));
  await discovery.scan();
  await expect(discovery.list()).resolves.toEqual([]);
  await expect(discovery.get('101')).resolves.toBeUndefined();
  await expect(discovery.get('101', true)).resolves.toBeDefined();
  await expect(
    db.transaction(async transaction => {
      await transaction(table).insert({
        id: 'blocked-app',
        source_key: sourceUrl,
      });
      await discovery.markClaimed(transaction, '101', 'blocked-app', sourceUrl);
    }),
  ).rejects.toThrow('repository has changed');
  expect(await db(table)).toEqual([]);
});

test('applies the newest completed scan across independent workers', async () => {
  const first = githubDiscovery(db, table, configuration);
  const second = githubDiscovery(db, table, configuration);
  let releaseOld!: (response: Response) => void;
  let started!: () => void;
  const oldResponse = new Promise<Response>(resolve => {
    releaseOld = resolve;
  });
  const startedOld = new Promise<void>(resolve => {
    started = resolve;
  });
  github.mockImplementationOnce(async () => {
    started();
    return oldResponse;
  });
  const oldScan = first.scan();
  await startedOld;
  github.mockResolvedValueOnce(
    Response.json({
      total_count: 2,
      incomplete_results: false,
      items: [
        {
          id: 101,
          full_name: 'ExampleAI/tool',
          description: 'Now restricted',
          private: true,
        },
        {
          id: 103,
          full_name: 'ExampleAI/new',
          description: null,
          private: false,
        },
      ],
    }),
  );
  await second.scan('scheduled');
  releaseOld(results('ExampleAI/tool'));
  await oldScan;

  await expect(first.list()).resolves.toEqual([
    expect.objectContaining({ id: '103' }),
  ]);
  await expect(first.get('101')).resolves.toBeUndefined();
  await expect(first.lastScan()).resolves.toMatchObject({
    trigger: 'scheduled',
    found: 2,
  });
});

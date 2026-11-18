import { TestDatabases } from '@backstage/backend-test-utils';
import { appSourceKey, repositorySourceMigration } from './sourceKey';

it('preserves non-GitHub URLs and GitHub links below the repository root', () => {
  expect(appSourceKey('https://github.com/ExampleAI/Project/tree/Main')).toBe(
    'https://github.com/ExampleAI/Project/tree/Main',
  );
  expect(appSourceKey('https://example.com/ExampleAI/Project.git/')).toBe(
    'https://example.com/ExampleAI/Project.git/',
  );
});

describe('repository source migration', () => {
  const databases = TestDatabases.create({ ids: ['SQLITE_3'] });

  it('preserves existing duplicates and original record URLs', async () => {
    const db = await databases.init('SQLITE_3');
    const table = 'apps';
    await db.schema.createTable(table, schema => {
      schema.string('id').primary();
      schema.text('source_key').unique().notNullable();
      schema.text('payload').notNullable();
    });
    const original = [
      ['existing-alias', 'https://github.com/ExampleAI/Tool.git'],
      ['existing-root', 'https://github.com/exampleai/tool'],
      ['legacy-clone', 'https://github.com/ExampleAI/Other.git/'],
    ].map(([id, sourceUrl]) => ({
      id,
      source_key: sourceUrl,
      payload: JSON.stringify({ sourceUrl }),
    }));
    await db(table).insert(original);

    const migration = repositorySourceMigration(table);
    await migration.up(db);
    expect(await db(table).select('*').orderBy('id')).toEqual([
      ...original.slice(0, 2),
      { ...original[2], source_key: 'https://github.com/exampleai/other' },
    ]);
    await migration.down(db);
    expect(await db(table).select('*').orderBy('id')).toEqual(original);
  });
});

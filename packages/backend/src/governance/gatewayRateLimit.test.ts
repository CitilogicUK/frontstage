import {
  TestDatabases,
  type TestDatabaseId,
} from '@backstage/backend-test-utils';
import {
  gatewayRateMigration,
  reserveGatewayRequest,
} from './gatewayRateLimit';

describe('gateway rate limit', () => {
  const databases = TestDatabases.create({ ids: ['SQLITE_3', 'POSTGRES_17'] });

  async function createDatabase(id: TestDatabaseId) {
    const db = await databases.init(id);
    await db.schema.createTable('apps', table => table.string('id').primary());
    await db('apps').insert([{ id: 'first' }, { id: 'second' }]);
    await gatewayRateMigration('apps').up(db);
    return db;
  }

  it.each(databases.eachSupportedId())(
    'reserves the per-app allowance atomically and resets at the minute boundary (%s)',
    async id => {
      const db = await createDatabase(id);
      const attempts = await Promise.all(
        Array.from({ length: 6 }, () =>
          reserveGatewayRequest(db, 'first', 2, 59_500),
        ),
      );
      expect(attempts.filter(result => result.allowed)).toHaveLength(2);
      expect(attempts.filter(result => !result.allowed)).toEqual(
        Array(4).fill({ allowed: false, retryAfter: 1 }),
      );
      await expect(
        reserveGatewayRequest(db, 'second', 2, 59_500),
      ).resolves.toMatchObject({ allowed: true });
      await expect(
        reserveGatewayRequest(db, 'first', 2, 60_000),
      ).resolves.toMatchObject({ allowed: true });
    },
  );

  it.each(databases.eachSupportedId())(
    'uses the newer window to calculate a retry for an out-of-order request (%s)',
    async id => {
      const db = await createDatabase(id);
      await reserveGatewayRequest(db, 'first', 2, 120_000);
      await expect(
        reserveGatewayRequest(db, 'first', 2, 59_500),
      ).resolves.toEqual({ allowed: false, retryAfter: 61 });
      await expect(
        reserveGatewayRequest(db, 'first', 2, 120_000),
      ).resolves.toMatchObject({ allowed: true });
      await expect(
        reserveGatewayRequest(db, 'first', 2, 59_500),
      ).resolves.toEqual({ allowed: false, retryAfter: 121 });
    },
  );
});

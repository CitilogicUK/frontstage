import knex from 'knex';
import {
  gatewayRateMigration,
  reserveGatewayRequest,
} from './gatewayRateLimit';

it('reserves the per-app allowance atomically and resets it at the minute boundary', async () => {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  try {
    await db.schema.createTable('apps', table => table.string('id').primary());
    await db('apps').insert([{ id: 'first' }, { id: 'second' }]);
    await gatewayRateMigration('apps').up(db);

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
  } finally {
    await db.destroy();
  }
});

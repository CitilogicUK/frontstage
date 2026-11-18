import type { DatabaseService } from '@backstage/backend-plugin-api';

type Database = Awaited<ReturnType<DatabaseService['getClient']>>;
const rateTable = 'governance_gateway_rate_windows';
const windowMs = 60_000;

export function gatewayRateMigration(appsTable: string) {
  return {
    async up(db: Database) {
      await db.schema.createTable(rateTable, table => {
        table.string('app_id').primary().references('id').inTable(appsTable);
        table.integer('minute').notNullable();
        table.integer('requests').notNullable();
      });
    },
    async down(db: Database) {
      await db.schema.dropTable(rateTable);
    },
  };
}

export async function reserveGatewayRequest(
  db: Database,
  appId: string,
  limit: number,
  now = Date.now(),
) {
  const minute = Math.floor(now / windowMs);
  const inserted = await db(rateTable)
    .insert({ app_id: appId, minute, requests: 1 })
    .onConflict('app_id')
    .merge({
      minute,
      requests: db.raw('case when ?? = ? then ?? + 1 else 1 end', [
        `${rateTable}.minute`,
        minute,
        `${rateTable}.requests`,
      ]),
    })
    .whereRaw('?? < ? or (?? = ? and ?? < ?)', [
      `${rateTable}.minute`,
      minute,
      `${rateTable}.minute`,
      minute,
      `${rateTable}.requests`,
      limit,
    ])
    .returning('app_id');

  return {
    allowed: inserted.length > 0,
    retryAfter: Math.ceil(((minute + 1) * windowMs - now) / 1000),
  };
}

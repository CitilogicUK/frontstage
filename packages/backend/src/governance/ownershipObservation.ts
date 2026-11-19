import type { DatabaseService } from '@backstage/backend-plugin-api';

type Database = Awaited<ReturnType<DatabaseService['getClient']>>;
const observationTable = 'governance_owner_observations';
const batchSize = 100;

type OwnerObservation = {
  app_id: string;
  owner_ref: string;
  unavailable_since: string;
};

export function ownershipObservationMigration(appsTable: string) {
  return {
    async up(db: Database) {
      await db.schema.createTable(observationTable, table => {
        table
          .string('app_id')
          .primary()
          .references('id')
          .inTable(appsTable)
          .onDelete('CASCADE');
        table.string('owner_ref').notNullable();
        table.string('unavailable_since', 24).notNullable();
      });
    },
    async down(db: Database) {
      await db.schema.dropTable(observationTable);
    },
  };
}

export async function clearOwnerObservation(db: Database, appId: string) {
  await db(observationTable).where({ app_id: appId }).del();
}

type ScannedApp = { id: string; owner: string; revision: number };

export async function saveOwnerObservations(
  db: Database,
  appsTable: string,
  apps: ScannedApp[],
  unavailableOwners: Set<string>,
  unavailableSince: string,
  signal: AbortSignal,
) {
  if (signal.aborted || !apps.length) return;
  await db.transaction(async transaction => {
    for (let offset = 0; offset < apps.length; offset += batchSize) {
      signal.throwIfAborted();
      const batch = apps.slice(offset, offset + batchSize);
      const current = await transaction(appsTable)
        .whereIn(
          'id',
          batch.map(app => app.id),
        )
        .orderBy('id')
        .forUpdate()
        .select<Array<{ id: string; revision: number }>>('id', 'revision');
      const revisions = new Map(current.map(row => [row.id, row.revision]));
      const recovered: string[] = [];
      const observations: OwnerObservation[] = [];
      for (const app of batch) {
        // The Catalog result can only describe the record that was checked.
        if (revisions.get(app.id) !== app.revision) continue;
        if (unavailableOwners.has(app.owner)) {
          observations.push({
            app_id: app.id,
            owner_ref: app.owner,
            unavailable_since: unavailableSince,
          });
        } else {
          recovered.push(app.id);
        }
      }
      signal.throwIfAborted();
      if (recovered.length) {
        await transaction(observationTable).whereIn('app_id', recovered).del();
      }
      signal.throwIfAborted();
      if (observations.length) {
        await transaction<OwnerObservation>(observationTable)
          .insert(observations)
          .onConflict('app_id')
          .merge(['owner_ref', 'unavailable_since'])
          .whereRaw('?? <> excluded.??', [
            `${observationTable}.owner_ref`,
            'owner_ref',
          ]);
      }
    }
    signal.throwIfAborted();
  });
}

export async function readOwnerObservations(db: Database, appIds: string[]) {
  const observations = new Map<string, OwnerObservation>();
  for (let offset = 0; offset < appIds.length; offset += batchSize) {
    const batch = await db<OwnerObservation>(observationTable)
      .whereIn('app_id', appIds.slice(offset, offset + batchSize))
      .select('app_id', 'owner_ref', 'unavailable_since');
    for (const row of batch) observations.set(row.app_id, row);
  }
  return observations;
}

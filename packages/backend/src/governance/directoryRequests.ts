import type { DatabaseService } from '@backstage/backend-plugin-api';

type Database = Awaited<ReturnType<DatabaseService['getClient']>>;

export const directoryRequestsTable = 'governance_directory_requests';

export type DirectoryRequestRow = {
  id: string;
  app_id: string;
  requester: string;
  message: string;
  status: 'pending' | 'approved' | 'declined';
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

export function directoryRequestView(row: DirectoryRequestRow) {
  const { id, requester, message, status } = row;
  return {
    id,
    requester,
    message,
    status,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at ?? undefined,
    decidedBy: row.decided_by ?? undefined,
  };
}

export function directoryRequestsMigration(appsTable: string) {
  return {
    async up(db: Database) {
      await db.schema.createTable(directoryRequestsTable, table => {
        table.string('id').primary();
        table
          .string('app_id')
          .notNullable()
          .references('id')
          .inTable(appsTable);
        table.string('requester').notNullable();
        table.text('message').notNullable();
        table.enu('status', ['pending', 'approved', 'declined']).notNullable();
        table.string('requested_at').notNullable();
        table.string('decided_at');
        table.string('decided_by');
        table.unique(['app_id', 'requester']);
        table.index('requester');
      });
    },
    async down(db: Database) {
      await db.schema.dropTable(directoryRequestsTable);
    },
  };
}

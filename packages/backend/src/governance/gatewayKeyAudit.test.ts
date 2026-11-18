import { TestDatabases } from '@backstage/backend-test-utils';
import {
  gatewayKeyAuditMigration,
  gatewayMigration,
  readGatewayKeyEvents,
} from './gateway';

describe('gateway key audit migration', () => {
  const databases = TestDatabases.create({ ids: ['SQLITE_3', 'POSTGRES_17'] });
  it.each(databases.eachSupportedId())(
    'builds a key audit chain for stored legacy events on %s',
    async databaseId => {
      const db = await databases.init(databaseId);
      await db.schema.createTable('apps', table =>
        table.string('id').primary(),
      );
      await db('apps').insert({ id: 'legacy-app' });
      await gatewayMigration('apps').up(db);
      await db('governance_gateway_key_events').insert([
        {
          id: 'z',
          app_id: 'legacy-app',
          actor: 'user:default/owner',
          action: 'revoked',
          created_at: new Date('2026-11-18T00:00:01Z'),
        },
        {
          id: 'a',
          app_id: 'legacy-app',
          actor: 'user:default/owner',
          action: 'issued',
          created_at: new Date('2026-11-18T00:00:00Z'),
        },
      ]);
      await gatewayKeyAuditMigration().up(db);
      const [issued, revoked] = await readGatewayKeyEvents(db, 'legacy-app');
      expect(JSON.parse(issued.event)).toMatchObject({
        appId: 'legacy-app',
        revision: 0,
        action: 'issued',
        previousDigest: null,
      });
      expect(JSON.parse(revoked.event)).toMatchObject({
        appId: 'legacy-app',
        revision: 1,
        action: 'revoked',
        previousDigest: issued.digest,
      });
    },
  );
});

import { TestDatabases } from '@backstage/backend-test-utils';
import {
  gatewayKeyAuditMigration,
  gatewayKeyEnvironmentsMigration,
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

  it.each(databases.eachSupportedId())(
    'preserves legacy key hashes in the sandbox slot on %s',
    async databaseId => {
      const db = await databases.init(databaseId);
      await db.schema.createTable('apps', table =>
        table.string('id').primary(),
      );
      await db('apps').insert({ id: 'legacy-app' });
      await gatewayMigration('apps').up(db);
      const keys = 'governance_gateway_keys';
      const original = { app_id: 'legacy-app', digest: 'a'.repeat(64) };
      await db(keys).insert(original);
      await gatewayKeyEnvironmentsMigration('apps').up(db);
      expect(await db(keys)).toEqual([{ ...original, environment: 'sandbox' }]);
      await db(keys).insert({
        app_id: 'legacy-app',
        environment: 'production',
        digest: 'b'.repeat(64),
      });
      await expect(db(keys)).resolves.toHaveLength(2);
      await gatewayKeyEnvironmentsMigration('apps').down(db);
      expect(await db(keys)).toEqual([]);
    },
  );
});

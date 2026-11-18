import type { DatabaseService } from '@backstage/backend-plugin-api';

type Database = Awaited<ReturnType<DatabaseService['getClient']>>;

export function appSourceKey(sourceUrl: string) {
  const url = new URL(sourceUrl);
  if (
    url.protocol !== 'https:' ||
    url.host !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return url.href;

  const repository = /^\/([a-z\d-]+)\/([a-z\d_.-]+)\/?$/i.exec(url.pathname);
  if (!repository) return url.href;
  const [, owner, name] = repository;
  const repo = name.replace(/\.git$/i, '');
  return repo
    ? `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`
    : url.href;
}

export function repositorySourceMigration(table: string) {
  return {
    async up(db: Database) {
      const rows = await db(table).select('id', 'source_key').orderBy('id');
      const registered = new Set(rows.map(row => row.source_key));
      for (const row of rows) {
        const canonical = appSourceKey(row.source_key);
        // Keep legacy duplicates intact and prefer any record already using the canonical key.
        if (registered.has(canonical)) continue;
        await db(table).where({ id: row.id }).update({ source_key: canonical });
        registered.add(canonical);
      }
    },
    async down(db: Database) {
      const rows = await db(table).select('id', 'payload');
      for (const row of rows) {
        const record = JSON.parse(row.payload) as { sourceUrl: string };
        await db(table)
          .where({ id: row.id })
          .update({ source_key: new URL(record.sourceUrl).href });
      }
    },
  };
}

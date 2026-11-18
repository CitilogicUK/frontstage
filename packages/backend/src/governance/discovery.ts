import type { DatabaseService } from '@backstage/backend-plugin-api';
import { ConflictError, ServiceUnavailableError } from '@backstage/errors';
import { z } from 'zod';

type Database = Awaited<ReturnType<DatabaseService['getClient']>>;
const scanStateTable = 'governance_discovery_scan_state';
const decisionsTable = 'governance_discovery_decisions';
const discoveryTable = 'governance_discovered_repositories';

const githubConfig = z
  .object({
    organization: z.string().regex(/^[a-z\d][a-z\d-]{0,38}$/i),
    topic: z.string().regex(/^[a-z\d][a-z\d-]{0,49}$/),
    token: z.string().trim().min(1).optional(),
    scanIntervalMinutes: z.number().int().min(15).max(10_080).optional(),
  })
  .strict();

const githubResult = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z
    .array(
      z.object({
        id: z.number().int().positive(),
        full_name: z.string().regex(/^[a-z\d-]+\/[a-z\d._-]+$/i),
        description: z.string().nullable(),
      }),
    )
    .max(100),
});

const descriptorByteLimit = 100_000;

async function readDescriptor(response: Response) {
  if (!response.body) return undefined;
  if (Number(response.headers.get('content-length')) > descriptorByteLimit) {
    await response.body.cancel();
    return undefined;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let content = '';
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > descriptorByteLimit) return undefined;
      content += decoder.decode(chunk.value, { stream: true });
      chunk = await reader.read();
    }
    return content + decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export function discoveryMigration() {
  return {
    async up(db: Database) {
      await db.schema.createTable(discoveryTable, table => {
        table.string('id').primary();
        table.text('source_url').notNullable();
        table.string('name').notNullable();
        table.text('description').notNullable();
        table.string('first_seen').notNullable();
        table.string('last_seen').notNullable();
      });
    },
    async down(db: Database) {
      await db.schema.dropTable(discoveryTable);
    },
  };
}

export function discoveryClaimsMigration(appsTable: string) {
  return {
    async up(db: Database) {
      await db.schema.alterTable(discoveryTable, table => {
        table.string('app_id').references('id').inTable(appsTable);
        table.string('topic');
      });
    },
    async down(db: Database) {
      await db.schema.alterTable(discoveryTable, table => {
        table.dropColumn('app_id');
        table.dropColumn('topic');
      });
    },
  };
}

export function discoveryDecisionsMigration() {
  return {
    async up(db: Database) {
      await db.schema.alterTable(discoveryTable, table =>
        table.text('dismissal_reason'),
      );
      await db.schema.createTable(decisionsTable, table => {
        table.increments('id');
        table
          .string('repository_id')
          .notNullable()
          .references('id')
          .inTable(discoveryTable);
        table.string('actor').notNullable();
        table.string('decision').notNullable();
        table.text('reason');
        table.timestamp('created_at', { useTz: true }).notNullable();
      });
    },
    async down(db: Database) {
      await db.schema.dropTable(decisionsTable);
      await db.schema.alterTable(discoveryTable, table =>
        table.dropColumn('dismissal_reason'),
      );
    },
  };
}

export function discoveryScanMigration() {
  return {
    async up(db: Database) {
      await db.schema.createTable(scanStateTable, table => {
        table.string('source').primary();
        table.text('result').notNullable();
      });
    },
    async down(db: Database) {
      await db.schema.dropTable(scanStateTable);
    },
  };
}

export function githubDiscovery(
  db: Database,
  appsTable: string,
  configuration: unknown,
) {
  const config = githubConfig.optional().parse(configuration);
  const scope = config && `${config.organization.toLowerCase()}/%`;

  const source = {
    source: config && {
      organization: config.organization,
      topic: config.topic,
    },
    async list(includeReasons = false) {
      if (!scope || !config) return [];
      return db(`${discoveryTable} as repository`)
        .leftJoin(
          `${appsTable} as app`,
          'repository.source_url',
          'app.source_key',
        )
        .where('repository.name', 'like', scope)
        .where('repository.topic', config.topic)
        .select(
          'repository.id',
          'repository.source_url as sourceUrl',
          'repository.name',
          'repository.description',
          'repository.first_seen as firstSeen',
          db.raw(
            'case when repository.dismissal_reason is null then 0 else 1 end as ??',
            ['dismissed'],
          ),
          ...(includeReasons
            ? ['repository.dismissal_reason as dismissalReason']
            : []),
          db.raw('coalesce(repository.app_id, app.id) as ??', ['appId']),
        )
        .orderBy('repository.name');
    },
    async get(id: string): Promise<{ source_url: string } | undefined> {
      if (!scope || !config) return undefined;
      return db(discoveryTable)
        .where({ id, topic: config.topic })
        .where('name', 'like', scope)
        .first('source_url');
    },
    async descriptor(id: string, useToken: boolean) {
      if (!scope || !config) return undefined;
      const candidate = await db(`${discoveryTable} as repository`)
        .leftJoin(
          `${appsTable} as app`,
          'repository.source_url',
          'app.source_key',
        )
        .where('repository.id', id)
        .where('repository.topic', config.topic)
        .where('repository.name', 'like', scope)
        .whereNull('repository.app_id')
        .whereNull('repository.dismissal_reason')
        .whereNull('app.id')
        .first('repository.name', 'repository.source_url as sourceUrl');
      if (!candidate) return undefined;
      const { name, sourceUrl } = candidate as {
        name: string;
        sourceUrl: string;
      };
      if (!/^[a-z\d-]+\/(?!\.+$)[a-z\d._-]+$/.test(name)) return undefined;
      const url = new URL(
        `https://api.github.com/repos/${name}/contents/catalog-info.yaml`,
      );
      try {
        const response = await fetch(url, {
          headers: {
            Accept: 'application/vnd.github.raw+json',
            'User-Agent': 'Frontstage',
            ...(useToken &&
              config.token && { Authorization: `Bearer ${config.token}` }),
          },
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          return undefined;
        }
        const content = await readDescriptor(response);
        if (content) return { content, sourceUrl };
      } catch {
        return undefined;
      }
      return undefined;
    },
    async linkRegistered(
      transaction: Database,
      sourceKey: string,
      appId: string,
    ) {
      if (!scope || !config) return;
      await transaction(discoveryTable)
        .where({ source_url: sourceKey, topic: config.topic })
        .where('name', 'like', scope)
        .whereNull('app_id')
        .update({ app_id: appId });
    },
    async markClaimed(
      transaction: Database,
      id: string,
      appId: string,
      sourceKey: string,
    ) {
      if (!scope || !config)
        throw new ServiceUnavailableError('GitHub discovery is disabled.');
      const updated = await transaction(discoveryTable)
        .where({ id, topic: config.topic, source_url: sourceKey })
        .where('name', 'like', scope)
        .whereNull('app_id')
        .whereNull('dismissal_reason')
        .update({ app_id: appId });
      if (!updated)
        throw new ConflictError(
          'This repository has changed or has already been claimed or dismissed.',
        );
    },
    async decide(id: string, actor: string, reason: string | null) {
      if (!scope || !config)
        throw new ServiceUnavailableError('GitHub discovery is disabled.');
      await db.transaction(async transaction => {
        const candidate = transaction(discoveryTable)
          .where({ id, topic: config.topic })
          .where('name', 'like', scope)
          .whereNull('app_id')
          .whereNotExists(
            transaction(appsTable)
              .select('id')
              .whereRaw('?? = ??', [
                `${appsTable}.source_key`,
                `${discoveryTable}.source_url`,
              ]),
          );
        const updated = await (reason
          ? candidate.whereNull('dismissal_reason')
          : candidate.whereNotNull('dismissal_reason')
        ).update({ dismissal_reason: reason });
        if (!updated)
          throw new ConflictError(
            'The repository is no longer available for this decision. Refresh discovery.',
          );
        await transaction(decisionsTable).insert({
          repository_id: id,
          actor,
          decision: reason ? 'dismissed' : 'reopened',
          reason,
          created_at: new Date(),
        });
      });
    },
    async scan() {
      if (!config)
        throw new ServiceUnavailableError('GitHub discovery is disabled.');
      const url = new URL('https://api.github.com/search/repositories');
      url.searchParams.set(
        'q',
        `org:${config.organization} topic:${config.topic} archived:false`,
      );
      url.searchParams.set('per_page', '100');

      const result = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Frontstage',
          ...(config.token && { Authorization: `Bearer ${config.token}` }),
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      })
        .then(async response => {
          if (!response.ok) throw new Error('GitHub returned an error.');
          return githubResult.parse(await response.json());
        })
        .catch(() => {
          throw new ServiceUnavailableError(
            'GitHub discovery could not complete. Check source access or retry later.',
          );
        });

      const now = new Date().toISOString();
      const repos = new Map(
        result.items.flatMap(repo => {
          const name = repo.full_name.toLowerCase();
          if (!name.startsWith(`${config.organization.toLowerCase()}/`))
            return [];
          return [
            [
              String(repo.id),
              {
                id: String(repo.id),
                name,
                topic: config.topic,
                source_url: `https://github.com/${name}`,
                description: repo.description ?? '',
                first_seen: now,
                last_seen: now,
              },
            ] as const,
          ];
        }),
      );
      if (repos.size) {
        await db.transaction(async transaction => {
          const matchingApp = transaction(appsTable)
            .select('id')
            .whereRaw('?? = ??', [
              'source_key',
              `${discoveryTable}.source_url`,
            ]);
          const linkExistingApps = () =>
            transaction(discoveryTable)
              .whereIn('id', [...repos.keys()])
              .whereNull('app_id')
              .whereExists(matchingApp.clone())
              .update({ app_id: matchingApp });
          // Resolve both the previous and current URLs before forgetting a rename.
          await linkExistingApps();
          await transaction(discoveryTable)
            .insert([...repos.values()])
            .onConflict('id')
            .merge(['name', 'source_url', 'description', 'last_seen', 'topic']);
          await linkExistingApps();
        });
      }
      return {
        found: repos.size,
        partial:
          result.incomplete_results || result.total_count > result.items.length,
      };
    },
  };
  const sourceKey =
    config && `${config.organization.toLowerCase()}:${config.topic}`;
  type ScanResult = { found: number; partial: boolean };
  let activeScan: Promise<ScanResult> | undefined;

  return {
    ...source,
    intervalMinutes: config?.scanIntervalMinutes,
    async lastScan() {
      if (!sourceKey) return null;
      const row = await db(scanStateTable)
        .where({ source: sourceKey })
        .first('result');
      return row ? JSON.parse(row.result) : null;
    },
    scan(trigger: 'manual' | 'scheduled' = 'manual') {
      if (!sourceKey)
        return Promise.reject(
          new ServiceUnavailableError('GitHub discovery is disabled.'),
        );
      if (activeScan) return activeScan;
      const recordOutcome = (outcome: {
        status: 'completed' | 'failed';
        found?: number;
        partial?: boolean;
      }) =>
        db(scanStateTable)
          .insert({
            source: sourceKey,
            result: JSON.stringify({
              ...outcome,
              trigger,
              at: new Date().toISOString(),
            }),
          })
          .onConflict('source')
          .merge();
      activeScan = source
        .scan()
        .then(
          async result => {
            await recordOutcome({ status: 'completed', ...result });
            return result;
          },
          async error => {
            await recordOutcome({ status: 'failed' });
            throw error;
          },
        )
        .finally(() => {
          activeScan = undefined;
        });
      return activeScan;
    },
  };
}

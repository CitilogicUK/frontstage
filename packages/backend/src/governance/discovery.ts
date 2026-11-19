import type { DatabaseService } from '@backstage/backend-plugin-api';
import { ConflictError, ServiceUnavailableError } from '@backstage/errors';
import { z } from 'zod';
import {
  sdkManifestPaths,
  sdkPackages,
  type SdkManifestPath,
} from './sdkEvidence';

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
        private: z.boolean().optional(),
        visibility: z.enum(['public', 'internal', 'private']).optional(),
      }),
    )
    .max(100),
});

function repositoryPublicFlag(
  repo: z.infer<typeof githubResult>['items'][number],
) {
  if (
    repo.private === true ||
    repo.visibility === 'private' ||
    repo.visibility === 'internal'
  )
    return false;
  if (repo.private === false || repo.visibility === 'public') return true;
  return null;
}

const rootFileByteLimit = 100_000;

async function readRootFile(response: Response) {
  if (Number(response.headers.get('content-length')) > rootFileByteLimit) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let content = '';
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > rootFileByteLimit) return undefined;
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

export function discoveryVisibilityMigration() {
  return {
    async up(db: Database) {
      await db.schema.alterTable(discoveryTable, table => {
        table.boolean('is_public');
        table.boolean('is_stale').notNullable().defaultTo(false);
      });
      await db.schema.alterTable(scanStateTable, table => {
        table.bigInteger('started_scan').notNullable().defaultTo(0);
        table.bigInteger('applied_scan').notNullable().defaultTo(0);
      });
    },
    async down(db: Database) {
      await db.schema.alterTable(scanStateTable, table => {
        table.dropColumn('started_scan');
        table.dropColumn('applied_scan');
      });
      await db.schema.alterTable(discoveryTable, table => {
        table.dropColumn('is_public');
        table.dropColumn('is_stale');
      });
    },
  };
}

type ScanTrigger = 'manual' | 'scheduled';
type ScanResult = { found: number; partial: boolean };
type ScanGeneration = number | string;

function scanOutcome(
  outcome: ({ status: 'completed' } & ScanResult) | { status: 'failed' },
  trigger: ScanTrigger,
) {
  return JSON.stringify({ ...outcome, trigger, at: new Date().toISOString() });
}

export function githubDiscovery(
  db: Database,
  appsTable: string,
  configuration: unknown,
) {
  const config = githubConfig.optional().parse(configuration);
  const scope = config && `${config.organization.toLowerCase()}/%`;
  const scanSource =
    config && `${config.organization.toLowerCase()}:${config.topic}`;
  let activeScan: Promise<ScanResult> | undefined;

  async function findContentCandidate(id: string, includePrivate: boolean) {
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
      .where('repository.is_stale', false)
      .modify(query => {
        if (!includePrivate) query.where('repository.is_public', true);
      })
      .whereNull('repository.app_id')
      .whereNull('repository.dismissal_reason')
      .whereNull('app.id')
      .first<{ name: string; sourceUrl: string }>(
        'repository.name',
        'repository.source_url as sourceUrl',
      );
    if (!candidate || !/^[a-z\d-]+\/(?!\.+$)[a-z\d._-]+$/.test(candidate.name))
      return undefined;
    return candidate;
  }

  async function githubRootFile(
    name: string,
    path: 'catalog-info.yaml' | SdkManifestPath,
    includePrivate: boolean,
  ): Promise<
    | { status: 'checked'; content: string }
    | { status: 'missing' | 'unavailable' }
  > {
    const url = new URL(
      `https://api.github.com/repos/${name}/contents/${path}`,
    );
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github.raw+json',
          'User-Agent': 'Frontstage',
          ...(includePrivate &&
            config?.token && { Authorization: `Bearer ${config.token}` }),
        },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status === 404 ? 'missing' : 'unavailable' };
      }
      const mediaType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase();
      // GitHub can return metadata or a directory listing for a repository path.
      if (
        path !== 'catalog-info.yaml' &&
        mediaType !== 'application/vnd.github.raw+json' &&
        (mediaType === 'application/json' ||
          mediaType === 'text/json' ||
          mediaType?.endsWith('+json'))
      ) {
        await response.body?.cancel();
        return { status: 'unavailable' };
      }
      const content = await readRootFile(response);
      if (content !== undefined) return { status: 'checked', content };
    } catch {
      return { status: 'unavailable' };
    }
    return { status: 'unavailable' };
  }

  const source = {
    source: config && {
      organization: config.organization,
      topic: config.topic,
    },
    async list(includePrivate = false) {
      if (!scope || !config) return [];
      return db(`${discoveryTable} as repository`)
        .leftJoin(
          `${appsTable} as app`,
          'repository.source_url',
          'app.source_key',
        )
        .where('repository.name', 'like', scope)
        .where('repository.topic', config.topic)
        .where('repository.is_stale', false)
        .modify(query => {
          if (!includePrivate) query.where('repository.is_public', true);
        })
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
          ...(includePrivate
            ? ['repository.dismissal_reason as dismissalReason']
            : []),
          db.raw('coalesce(repository.app_id, app.id) as ??', ['appId']),
        )
        .orderBy('repository.name');
    },
    async get(
      id: string,
      includePrivate = false,
    ): Promise<{ source_url: string } | undefined> {
      if (!scope || !config) return undefined;
      return db(discoveryTable)
        .where({ id, topic: config.topic, is_stale: false })
        .where('name', 'like', scope)
        .modify(query => {
          if (!includePrivate) query.where('is_public', true);
        })
        .whereNull('app_id')
        .whereNull('dismissal_reason')
        .first('source_url');
    },
    async descriptor(id: string, includePrivate: boolean) {
      const candidate = await findContentCandidate(id, includePrivate);
      if (!candidate) return undefined;
      const file = await githubRootFile(
        candidate.name,
        'catalog-info.yaml',
        includePrivate,
      );
      return file.status === 'checked' && file.content
        ? { content: file.content, sourceUrl: candidate.sourceUrl }
        : undefined;
    },
    async sdkEvidence(id: string, includePrivate: boolean) {
      const candidate = await findContentCandidate(id, includePrivate);
      if (!candidate) return undefined;
      const manifests = await Promise.all(
        sdkManifestPaths.map(async path => {
          const file = await githubRootFile(
            candidate.name,
            path,
            includePrivate,
          );
          if (file.status !== 'checked')
            return { path, status: file.status, packages: [] };
          const packages = sdkPackages(path, file.content);
          return packages
            ? { path, status: 'checked' as const, packages }
            : { path, status: 'unavailable' as const, packages: [] };
        }),
      );
      const current = await findContentCandidate(id, includePrivate);
      if (
        current?.name !== candidate.name ||
        current.sourceUrl !== candidate.sourceUrl
      )
        return undefined;
      return { manifests };
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
        .update({ app_id: appId, is_stale: false });
    },
    async markClaimed(
      transaction: Database,
      id: string,
      appId: string,
      sourceKey: string,
      includePrivate = false,
    ) {
      if (!scope || !config)
        throw new ServiceUnavailableError('GitHub discovery is disabled.');
      const updated = await transaction(discoveryTable)
        .where({
          id,
          topic: config.topic,
          source_url: sourceKey,
          is_stale: false,
        })
        .where('name', 'like', scope)
        .modify(query => {
          if (!includePrivate) query.where('is_public', true);
        })
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
          .where({ id, topic: config.topic, is_stale: false })
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
    async scan(generation: ScanGeneration, trigger: ScanTrigger) {
      if (!config || !scope || !scanSource)
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
      const partial =
        result.incomplete_results || result.total_count > result.items.length;
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
                is_public: repositoryPublicFlag(repo),
                is_stale: false,
              },
            ] as const,
          ];
        }),
      );
      const summary = { found: repos.size, partial };
      await db.transaction(async transaction => {
        // Skip an older response that arrived after a newer scan was applied.
        const applied = await transaction(scanStateTable)
          .where({ source: scanSource })
          .where('applied_scan', '<', generation)
          .update({
            applied_scan: generation,
            result: scanOutcome({ status: 'completed', ...summary }, trigger),
          });
        if (!applied) return;
        const matchingApp = transaction(appsTable)
          .select('id')
          .whereRaw('?? = ??', ['source_key', `${discoveryTable}.source_url`]);
        if (repos.size) {
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
            .merge([
              'name',
              'source_url',
              'description',
              'last_seen',
              'topic',
              'is_public',
              'is_stale',
            ]);
          await linkExistingApps();
        }
        if (!partial) {
          const missing = transaction(discoveryTable)
            .where({ topic: config.topic })
            .where('name', 'like', scope)
            .whereNotIn('id', [...repos.keys()]);
          await missing.clone().update({ is_public: null });
          await missing
            .whereNull('app_id')
            .whereNotExists(matchingApp)
            .update({ is_stale: true });
        }
      });
      return summary;
    },
  };

  return {
    ...source,
    intervalMinutes: config?.scanIntervalMinutes,
    async lastScan(includeCounts = true) {
      if (!scanSource) return null;
      const row = await db(scanStateTable)
        .where({ source: scanSource })
        .first('result');
      if (!row) return null;
      const result = JSON.parse(row.result);
      if (!result || includeCounts) return result;
      const { at, status, trigger } = result;
      return { at, status, trigger };
    },
    scan(trigger: ScanTrigger = 'manual') {
      if (!scanSource)
        return Promise.reject(
          new ServiceUnavailableError('GitHub discovery is disabled.'),
        );
      if (activeScan) return activeScan;
      const run = async () => {
        // Reserve a generation without holding a database lock during GitHub I/O.
        const generation = await db.transaction(async transaction => {
          await transaction(scanStateTable)
            .insert({ source: scanSource, result: 'null' })
            .onConflict('source')
            .ignore();
          const [row] = await transaction(scanStateTable)
            .where({ source: scanSource })
            .increment('started_scan', 1)
            .returning('started_scan');
          return row.started_scan as ScanGeneration;
        });
        try {
          return await source.scan(generation, trigger);
        } catch (error) {
          await db(scanStateTable)
            .where({ source: scanSource, started_scan: generation })
            .where('applied_scan', '<', generation)
            .update({ result: scanOutcome({ status: 'failed' }, trigger) });
          throw error;
        }
      };
      activeScan = run().finally(() => {
        activeScan = undefined;
      });
      return activeScan;
    },
  };
}

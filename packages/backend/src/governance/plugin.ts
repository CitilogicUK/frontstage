import { createHash, randomUUID } from 'node:crypto';
import {
  type BackstageUserPrincipal,
  type BackstageServicePrincipal,
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import {
  ConflictError,
  InputError,
  NotAllowedError,
  NotFoundError,
} from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  currentSignoffs,
  reviewTrack,
  reviewTrackConfig,
  trackedReview,
  type Signoffs,
} from './reviewTracks';
import { gatewayRateMigration } from './gatewayRateLimit';
import { parseAppCsv } from './csv';
import {
  discoveryClaimsMigration,
  discoveryMigration,
  discoveryScanMigration,
  discoveryDecisionsMigration,
  githubDiscovery,
} from './discovery';
import {
  gatewayMigration,
  gatewayUsageModeMigration,
  gatewayUsageTokensMigration,
  gatewayBlocksMigration,
  registerGatewayRoutes,
  readGatewayKeyEvents,
  revokeGatewayKey,
} from './gateway';
import {
  appInput,
  AppInput,
  calculateTier,
  effectiveClassification,
  nextReview,
  ReviewStatus,
  riskInput,
  tierPolicyInput,
} from './policy';

const importInput = z.union([
  z.object({ apps: z.array(z.unknown()).min(1).max(100) }).strict(),
  z.object({ csv: z.string().min(1).max(500_000) }).strict(),
]);

export type GovernanceRecord = AppInput & {
  id: string;
  tier: number;
  effectiveClassification?: AppInput['classification'];
  reviewStatus: ReviewStatus;
  lastReview: string | null;
  nextReview: string | null;
  discoverySource: 'registered' | 'git' | 'bulk import';
  updatedAt: string;
  reviewNotes?: string;
  signoffs?: Signoffs;
};

function nextRecordTimestamp(previous: string) {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

export const governancePlugin = createBackendPlugin({
  pluginId: 'governance',
  register(env) {
    env.registerInit({
      deps: {
        auth: coreServices.auth,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        database: coreServices.database,
        discovery: coreServices.discovery,
        scheduler: coreServices.scheduler,
        config: coreServices.rootConfig,
      },
      async init({
        auth,
        httpAuth,
        httpRouter,
        database,
        discovery,
        scheduler,
        config,
      }) {
        const db = await database.getClient();
        const catalog = new CatalogClient({
          discoveryApi: discovery,
          fetchApi: {
            fetch: (input, init) => {
              const timeout = AbortSignal.timeout(5_000);
              const signal = init?.signal
                ? AbortSignal.any([init.signal, timeout])
                : timeout;
              return fetch(input, { ...init, signal });
            },
          },
        });
        const trackConfig = reviewTrackConfig
          .optional()
          .parse(config.getOptional('governance.reviewTracks'));
        const reviewers = [
          ...(config.getOptionalStringArray('governance.reviewers') ?? []),
          ...(trackConfig?.security ?? []),
          ...(trackConfig?.dataProtection ?? []),
        ];
        const approvedHostedWorkspaces = z
          .array(
            z.object({
              provider: z.string().trim().min(1),
              workspace: z.string().trim().min(1),
            }),
          )
          .optional()
          .parse(config.getOptional('governance.approvedHostedWorkspaces'));
        const tierPolicy = tierPolicyInput.parse(
          config.getOptional('governance.tierPolicy') ?? {},
        );
        const evaluateTier = (app: Parameters<typeof calculateTier>[0]) =>
          calculateTier(app, tierPolicy);
        const table = 'governance_apps';
        const history = 'governance_history';
        const github = githubDiscovery(
          db,
          table,
          config.getOptional('governance.discovery.github'),
        );
        const migrations = {
          getMigrations: async () => [
            '001_inventory',
            '002_history',
            '003_gateway',
            '004_github_discovery',
            '005_discovery_claims',
            '006_gateway_usage_mode',
            '007_discovery_decisions',
            '008_gateway_blocks',
            '009_discovery_scan_state',
            '010_gateway_rate_windows',
            '011_gateway_usage_tokens',
          ],
          getMigrationName: (name: string) => name,
          getMigration: async (name: string) => {
            if (name === '003_gateway') return gatewayMigration(table);
            if (name === '004_github_discovery') return discoveryMigration();
            if (name === '005_discovery_claims')
              return discoveryClaimsMigration(table);
            if (name === '006_gateway_usage_mode')
              return gatewayUsageModeMigration();
            if (name === '007_discovery_decisions')
              return discoveryDecisionsMigration();
            if (name === '008_gateway_blocks')
              return gatewayBlocksMigration(table);
            if (name === '009_discovery_scan_state')
              return discoveryScanMigration();
            if (name === '010_gateway_rate_windows')
              return gatewayRateMigration(table);
            if (name === '011_gateway_usage_tokens')
              return gatewayUsageTokensMigration();
            return {
              async up(client: typeof db) {
                if (name === '001_inventory') {
                  if (await client.schema.hasTable(table)) return;
                  await client.schema.createTable(table, schema => {
                    schema.string('id').primary();
                    schema.text('source_key').unique().notNullable();
                    schema.text('payload').notNullable();
                    schema.integer('revision').notNullable();
                  });
                } else {
                  await client.schema.createTable(history, schema => {
                    schema
                      .string('app_id')
                      .notNullable()
                      .references('id')
                      .inTable(table);
                    schema.integer('revision').notNullable();
                    schema.text('event').notNullable();
                    schema.string('digest', 64).notNullable();
                    schema.primary(['app_id', 'revision']);
                  });
                }
              },
              async down(client: typeof db) {
                await client.schema.dropTable(
                  name === '001_inventory' ? table : history,
                );
              },
            };
          },
        };
        await db.migrate.latest({ migrationSource: migrations });
        if (github.intervalMinutes) {
          await scheduler.scheduleTask({
            id: 'governance-github-discovery',
            frequency: { minutes: github.intervalMinutes },
            initialDelay: { seconds: 5 },
            timeout: { seconds: 45 },
            async fn() {
              await github.scan('scheduled');
            },
          });
        }
        const router = Router();
        router.use(express.json({ limit: '1mb' }));

        function ownershipRefs(app: AppInput) {
          return [
            app.owner,
            app.team,
            ...(app.backupOwner ? [app.backupOwner] : []),
          ];
        }

        async function unavailableOwners(entityRefs: string[]) {
          if (!entityRefs.length) return new Set<string>();
          const { token } = await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId: 'catalog',
          });
          const unavailable = new Set<string>();
          for (let offset = 0; offset < entityRefs.length; offset += 100) {
            const batch = entityRefs.slice(offset, offset + 100);
            const { items } = await catalog.getEntitiesByRefs(
              { entityRefs: batch },
              { token },
            );
            batch.forEach((ref, index) => {
              const entity = items[index];
              if (
                !entity ||
                entity.metadata.annotations?.[
                  'governance.backstage.io/active'
                ] === 'false'
              )
                unavailable.add(ref);
            });
          }
          return unavailable;
        }

        async function ownersAreActive(app: AppInput) {
          return (await unavailableOwners(ownershipRefs(app))).size === 0;
        }

        async function validateOwners(app: AppInput) {
          if (!(await ownersAreActive(app))) {
            throw new InputError(
              'Choose active owners and a team from the Backstage catalog.',
            );
          }
        }

        function parseApp(input: unknown) {
          const result = appInput.safeParse(input);
          if (!result.success) {
            throw new InputError(
              result.error.issues
                .map(issue => `${issue.path.join('.')}: ${issue.message}`)
                .join('; '),
            );
          }
          const app = result.data;
          if (
            evaluateTier(app) >= 2 &&
            (!app.backupOwner || app.backupOwner === app.owner)
          ) {
            throw new InputError(
              'Choose a different backup owner for tier 2 and 3 apps.',
            );
          }
          return app;
        }

        function hostedWorkspaceApproved(app: AppInput) {
          const hosted = app.hosted;
          return approvedHostedWorkspaces?.some(
            entry =>
              entry.provider === hosted?.provider &&
              entry.workspace === hosted?.workspace,
          );
        }

        function assertHostedWorkspaceForLaunch(app: AppInput) {
          if (
            app.lifecycle === 'active' &&
            app.type === 'provider-hosted app' &&
            hostedWorkspaceApproved(app) === false
          ) {
            throw new InputError(
              'Choose an approved provider workspace before activating this app.',
            );
          }
        }

        function buildRecord(
          app: AppInput,
          source: GovernanceRecord['discoverySource'],
          id: string = randomUUID(),
        ): GovernanceRecord {
          const tier = evaluateTier(app);
          if (tier === 3 && app.lifecycle === 'active') {
            throw new InputError(
              'Register tier 3 apps as experimental until reviewers approve them.',
            );
          }
          assertHostedWorkspaceForLaunch(app);
          const updatedAt = new Date().toISOString();
          return {
            ...app,
            id,
            tier,
            effectiveClassification: effectiveClassification(app),
            updatedAt,
            discoverySource: source,
            reviewStatus: tier === 3 ? 'pending' : 'not required',
            lastReview: null,
            nextReview: tier === 2 ? nextReview(tier, updatedAt) : null,
          };
        }

        async function logChange(
          transaction: typeof db,
          record: GovernanceRecord,
          revision: number,
          principal: BackstageUserPrincipal | BackstageServicePrincipal,
          action: 'registered' | 'updated' | 'reviewed' | 'attested',
          lifecycleReason?: string,
        ) {
          const previous = await transaction(history)
            .where({ app_id: record.id, revision: revision - 1 })
            .first('digest');
          const event = JSON.stringify({
            action,
            actor:
              principal.type === 'user'
                ? principal.userEntityRef
                : principal.subject,
            revision,
            previousDigest: previous?.digest ?? null,
            lifecycleReason,
            record,
          });
          await transaction(history).insert({
            app_id: record.id,
            revision,
            event,
            digest: createHash('sha256').update(event).digest('hex'),
          });
        }

        async function insert(
          records: GovernanceRecord[],
          principal: BackstageUserPrincipal | BackstageServicePrincipal,
          discoveryId?: string,
        ) {
          await db.transaction(async transaction => {
            const rows = records.map(record => ({
              id: record.id,
              source_key: new URL(record.sourceUrl).href,
              payload: JSON.stringify(record),
              revision: 0,
            }));
            const inserted = await transaction(table)
              .insert(rows)
              .onConflict('source_key')
              .ignore()
              .returning('id');
            if (inserted.length !== rows.length) {
              throw new ConflictError('A source URL is already registered.');
            }
            if (discoveryId) {
              await github.markClaimed(transaction, discoveryId, records[0].id);
            } else {
              for (const row of rows)
                await github.linkRegistered(
                  transaction,
                  row.source_key,
                  row.id,
                );
            }
            for (const record of records) {
              await logChange(transaction, record, 0, principal, 'registered');
            }
          });
        }

        async function load(id: string, transaction?: typeof db) {
          const query = (transaction ?? db)(table).where({ id });
          const row = await (transaction ? query.forUpdate() : query).first();
          if (!row) throw new NotFoundError('AI app not found.');
          return {
            record: JSON.parse(row.payload) as GovernanceRecord,
            revision: row.revision as number,
          };
        }

        async function save(
          record: GovernanceRecord,
          revision: number,
          principal: BackstageUserPrincipal | BackstageServicePrincipal,
          action: 'updated' | 'reviewed' | 'attested',
          {
            ownerChanged = false,
            lifecycleReason,
          }: { ownerChanged?: boolean; lifecycleReason?: string } = {},
        ) {
          await db.transaction(async transaction => {
            const count = await transaction(table)
              .where({ id: record.id, revision })
              .update({
                payload: JSON.stringify(record),
                revision: revision + 1,
              });
            if (!count)
              throw new ConflictError(
                'The app changed. Refresh and try again.',
              );
            if (
              ownerChanged ||
              record.lifecycle === 'retired' ||
              record.usesAiAtRuntime === false
            ) {
              await revokeGatewayKey(
                transaction,
                record.id,
                principal.type === 'user'
                  ? principal.userEntityRef
                  : principal.subject,
              );
            }
            await logChange(
              transaction,
              record,
              revision + 1,
              principal,
              action,
              lifecycleReason,
            );
          });
        }

        router.get('/reports/ownership', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          if (!reviewers.includes(principal.userEntityRef))
            throw new NotAllowedError('Reviewer access is required.');
          const rows = await db(table).select('payload');
          const apps = rows
            .map(row => JSON.parse(row.payload) as GovernanceRecord)
            .filter(app => app.lifecycle !== 'retired');
          const refs = [...new Set(apps.flatMap(ownershipRefs))];
          const unavailable = await unavailableOwners(refs);
          const issues = apps.flatMap(app => {
            const missing = ownershipRefs(app).filter(ref =>
              unavailable.has(ref),
            );
            if (missing.length === 0) return [];
            const availableBackupOwner =
              unavailable.has(app.owner) &&
              app.backupOwner &&
              !unavailable.has(app.backupOwner)
                ? app.backupOwner
                : undefined;
            return [
              {
                appId: app.id,
                name: app.name,
                unavailable: missing,
                availableBackupOwner,
              },
            ];
          });
          res.set('Cache-Control', 'no-store').json({ issues });
        });

        router.get('/reports/hosted-workspaces', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          if (!reviewers.includes(principal.userEntityRef))
            throw new NotAllowedError('Reviewer access is required.');
          const configured = approvedHostedWorkspaces !== undefined;
          const rows = configured ? await db(table).select('payload') : [];
          const issues = rows
            .map(row => JSON.parse(row.payload) as GovernanceRecord)
            .filter(
              app =>
                app.type === 'provider-hosted app' &&
                app.lifecycle !== 'retired' &&
                hostedWorkspaceApproved(app) === false,
            )
            .map(app => ({
              appId: app.id,
              name: app.name,
              lifecycle: app.lifecycle,
              provider: app.hosted?.provider,
              workspace: app.hosted?.workspace,
            }))
            .sort(
              (a, b) =>
                Number(b.lifecycle === 'active') -
                  Number(a.lifecycle === 'active') ||
                a.name.localeCompare(b.name),
            );
          res.set('Cache-Control', 'no-store').json({ configured, issues });
        });

        router.get('/apps/:id/history', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          if (!reviewers.includes(principal.userEntityRef))
            throw new NotAllowedError('Reviewer access is required.');
          await load(req.params.id);
          const events = await db(history)
            .where({ app_id: req.params.id })
            .orderBy('revision')
            .select('event', 'digest');
          const keyEvents = await readGatewayKeyEvents(db, req.params.id);
          res.set('Cache-Control', 'no-store').json({ events, keyEvents });
        });

        function visibleRecord(
          record: GovernanceRecord,
          principal: BackstageUserPrincipal | BackstageServicePrincipal,
        ) {
          const now = Date.now();
          const result = {
            ...record,
            effectiveClassification: effectiveClassification(record),
            ...(trackConfig &&
              record.tier === 3 && {
                ...trackedReview(record.signoffs, trackConfig, now),
                signoffs: currentSignoffs(record.signoffs, trackConfig, now),
              }),
          };
          if (
            principal.type === 'user' &&
            (principal.userEntityRef === record.owner ||
              principal.userEntityRef === record.backupOwner ||
              reviewers.includes(principal.userEntityRef))
          )
            return result;
          return {
            ...result,
            reviewNotes: undefined,
            reviewTicketUrl: undefined,
            evidence: undefined,
            signoffs: undefined,
          };
        }

        function assertCanEdit(
          record: GovernanceRecord,
          principal: BackstageUserPrincipal | BackstageServicePrincipal,
        ) {
          if (
            principal.type === 'user' &&
            principal.userEntityRef !== record.owner &&
            !reviewers.includes(principal.userEntityRef)
          ) {
            throw new NotAllowedError(
              'Only the owner or a reviewer can update this app.',
            );
          }
        }

        function meetsLaunchRequirements(record: GovernanceRecord) {
          const tier = evaluateTier(record);
          return (
            tier === record.tier &&
            (tier !== 3 ||
              ((!trackConfig ||
                trackedReview(record.signoffs, trackConfig, Date.now())
                  .reviewStatus === 'approved') &&
                record.reviewStatus === 'approved' &&
                record.nextReview !== null &&
                Date.parse(record.nextReview) > Date.now()))
          );
        }

        function assertCanLaunch(record: GovernanceRecord) {
          assertHostedWorkspaceForLaunch(record);
          if (
            record.lifecycle === 'active' &&
            !meetsLaunchRequirements(record)
          ) {
            throw new InputError(
              'Resolve the current risk requirements and obtain any required approval before launch.',
            );
          }
        }

        router.get('/apps', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
          const rows = await db(table).select('payload');
          res.json({
            apps: rows
              .map(row =>
                visibleRecord(
                  JSON.parse(row.payload) as GovernanceRecord,
                  principal,
                ),
              )
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
            reviewTracks: trackConfig ? reviewTrack.options : [],
            reviewerTracks:
              trackConfig && principal.type === 'user'
                ? reviewTrack.options.filter(track =>
                    trackConfig[track].includes(principal.userEntityRef),
                  )
                : [],
            gatewayEnabled:
              config.getOptionalBoolean('governance.gateway.enabled') ?? false,
            actor: principal.type === 'user' ? principal.userEntityRef : null,
            canReview:
              principal.type === 'user' &&
              reviewers.includes(principal.userEntityRef),
          });
        });

        router.get('/hosted-workspaces', async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          res.set('Cache-Control', 'no-store').json({
            configured: approvedHostedWorkspaces !== undefined,
            workspaces: approvedHostedWorkspaces ?? [],
          });
        });

        router.post('/tier-preview', async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user', 'service'] });
          const result = riskInput.safeParse(req.body);
          if (!result.success)
            throw new InputError('Supply valid risk questionnaire answers.');
          res.json({
            tier: evaluateTier(result.data),
            effectiveClassification: effectiveClassification(result.data),
          });
        });

        router.get('/apps/:id', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
          res.json(
            visibleRecord((await load(req.params.id)).record, principal),
          );
        });

        router.get('/discovery/github', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          res.json({
            source: github.source ?? null,
            lastScan: await github.lastScan(),
            intervalMinutes: github.intervalMinutes ?? null,
            repositories: await github.list(
              reviewers.includes(principal.userEntityRef),
            ),
          });
        });

        router.post('/discovery/github/scan', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          if (!reviewers.includes(principal.userEntityRef)) {
            throw new NotAllowedError('Only reviewers can scan GitHub.');
          }
          res.json(await github.scan());
        });

        router.post('/discovery/github/:id/decision', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          if (!reviewers.includes(principal.userEntityRef))
            throw new NotAllowedError('Only reviewers can triage discoveries.');
          const decision = z
            .discriminatedUnion('action', [
              z.object({
                action: z.literal('dismiss'),
                reason: z.string().trim().min(1).max(500),
              }),
              z.object({ action: z.literal('reopen') }),
            ])
            .safeParse(req.body);
          if (!decision.success)
            throw new InputError(
              'Provide a reason to dismiss the repository, or reopen it.',
            );
          await github.decide(
            req.params.id,
            principal.userEntityRef,
            decision.data.action === 'dismiss' ? decision.data.reason : null,
          );
          res.json({ action: decision.data.action });
        });

        router.post('/discovery/github/:id/claim', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const candidate = await github.get(req.params.id);
          if (!candidate)
            throw new NotFoundError('Discovered repository not found.');
          const app = parseApp({
            ...req.body,
            sourceUrl: candidate.source_url,
            platform: 'GitHub',
            lifecycle: 'experimental',
          });
          if (
            principal.userEntityRef !== app.owner &&
            !reviewers.includes(principal.userEntityRef)
          ) {
            throw new NotAllowedError(
              'Claim the app as its owner or ask a reviewer.',
            );
          }
          await validateOwners(app);
          const record = buildRecord(app, 'git');
          await insert([record], principal, req.params.id);
          res.status(201).json(record);
        });

        router.post('/apps', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
          const app = parseApp(req.body);
          if (
            principal.type === 'user' &&
            principal.userEntityRef !== app.owner &&
            !reviewers.includes(principal.userEntityRef)
          ) {
            throw new NotAllowedError(
              'Register as the owner or ask a reviewer to register on their behalf.',
            );
          }
          await validateOwners(app);
          const record = buildRecord(app, 'registered');
          await insert([record], principal);
          res.status(201).json(record);
        });

        function isImportPreview(value: unknown) {
          const result = z
            .enum(['true', 'false'])
            .default('false')
            .safeParse(value);
          if (!result.success)
            throw new InputError('dryRun must be true or false.');
          return result.data === 'true';
        }

        async function previewImport(
          candidates: Array<{ record: GovernanceRecord; source: string }>,
        ) {
          const rows = candidates.map(({ record, source }) => ({
            record,
            source,
            sourceKey: new URL(record.sourceUrl).href,
          }));
          const registered = new Set(
            await db(table)
              .whereIn('source_key', [
                ...new Set(rows.map(row => row.sourceKey)),
              ])
              .pluck('source_key'),
          );
          const firstOccurrence = new Map<string, string>();
          const conflicts: string[] = [];
          for (const { source, sourceKey } of rows) {
            const first = firstOccurrence.get(sourceKey);
            if (registered.has(sourceKey))
              conflicts.push(`${source}: Source URL is already registered.`);
            else if (first)
              conflicts.push(`${source}: Source URL also appears in ${first}.`);
            if (!first) firstOccurrence.set(sourceKey, source);
          }
          if (conflicts.length) throw new ConflictError(conflicts.join('\n'));
          return {
            apps: rows.map(({ record }) => ({
              name: record.name,
              tier: record.tier,
              deliveryStage: record.deliveryStage,
              usesAiAtRuntime: record.usesAiAtRuntime,
              effectiveClassification: record.effectiveClassification,
              owner: record.owner,
              backupOwner: record.backupOwner,
              team: record.team,
            })),
          };
        }

        router.post('/repository', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
          const dryRun = isImportPreview(req.query.dryRun);
          const content = z
            .string()
            .min(1)
            .max(100_000)
            .safeParse(req.body?.content);
          if (!content.success)
            throw new InputError('Supply a YAML repository descriptor.');
          let descriptor: unknown;
          try {
            descriptor = parse(content.data, { maxAliasCount: 0 });
          } catch {
            throw new InputError('The repository descriptor is invalid YAML.');
          }
          const entity = z
            .object({
              apiVersion: z.literal('governance.backstage.io/v1alpha1'),
              kind: z.literal('AIApp'),
              spec: z.unknown(),
            })
            .safeParse(descriptor);
          if (!entity.success)
            throw new InputError('Expected an AIApp repository descriptor.');
          const app = parseApp(entity.data.spec);
          if (
            principal.type === 'user' &&
            principal.userEntityRef !== app.owner &&
            !reviewers.includes(principal.userEntityRef)
          ) {
            throw new NotAllowedError(
              'Register as the owner or ask a reviewer to register on their behalf.',
            );
          }
          await validateOwners(app);
          const record = buildRecord(app, 'git');
          if (dryRun) {
            res.json(await previewImport([{ record, source: 'Descriptor' }]));
            return;
          }
          await insert([record], principal);
          res.status(201).json(record);
        });

        router.post('/imports', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
          if (
            principal.type === 'user' &&
            !reviewers.includes(principal.userEntityRef)
          ) {
            throw new NotAllowedError('Bulk import requires a reviewer.');
          }
          const dryRun = isImportPreview(req.query.dryRun);
          const parsed = importInput.safeParse(req.body);
          if (!parsed.success) {
            throw new InputError(
              'Supply a CSV file or an array of 1 to 100 apps.',
            );
          }
          const rows =
            'csv' in parsed.data
              ? parseAppCsv(parsed.data.csv)
              : parsed.data.apps.map((app, index) => ({
                  app,
                  source: `App ${index + 1}`,
                }));
          const errors = new Map<number, string>();
          const candidates = rows.flatMap(({ app: input, source }, index) => {
            try {
              const record = buildRecord(parseApp(input), 'bulk import');
              return [{ record, refs: ownershipRefs(record), source, index }];
            } catch (error) {
              if (!(error instanceof InputError)) throw error;
              const message = `${source}: ${error.message}`;
              if (!dryRun) throw new InputError(message);
              errors.set(index, message);
              return [];
            }
          });
          const unavailable = await unavailableOwners([
            ...new Set(candidates.flatMap(candidate => candidate.refs)),
          ]);
          for (const { refs, source, index } of candidates) {
            if (!refs.some(ref => unavailable.has(ref))) continue;
            const message = `${source}: Choose active owners and a team from the Backstage catalog.`;
            if (!dryRun) throw new InputError(message);
            errors.set(index, message);
          }
          if (errors.size) {
            throw new InputError(
              [...errors]
                .sort(([a], [b]) => a - b)
                .map(([, message]) => message)
                .join('\n'),
            );
          }
          const records = candidates.map(candidate => candidate.record);
          if (dryRun) {
            res.json(await previewImport(candidates));
            return;
          }
          await insert(records, principal);
          res.status(201).json(records);
        });

        router.patch('/apps/:id/lifecycle', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
          const { record, revision } = await load(req.params.id);
          assertCanEdit(record, principal);
          const expectedUpdatedAt = req.body?.expectedUpdatedAt;
          if (
            expectedUpdatedAt !== undefined &&
            expectedUpdatedAt !== record.updatedAt
          ) {
            throw new ConflictError(
              'The app changed since you opened it. Reopen the current record before updating its lifecycle.',
            );
          }
          const lifecycle = z
            .enum(['experimental', 'active', 'deprecated', 'retired'])
            .safeParse(req.body?.lifecycle);
          if (!lifecycle.success)
            throw new InputError('Choose a valid lifecycle.');
          const reason = z
            .string()
            .trim()
            .max(500)
            .optional()
            .safeParse(req.body?.reason);
          if (!reason.success)
            throw new InputError(
              'Use at most 500 characters for the lifecycle reason.',
            );
          const updated = {
            ...record,
            lifecycle: lifecycle.data,
            updatedAt: nextRecordTimestamp(record.updatedAt),
          };
          assertCanLaunch(updated);
          if (updated.lifecycle === 'active') await validateOwners(updated);
          await save(updated, revision, principal, 'updated', {
            lifecycleReason: reason.data || undefined,
          });
          res.json(visibleRecord(updated, principal));
        });

        router.put('/apps/:id', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
          const { record, revision } = await load(req.params.id);
          assertCanEdit(record, principal);
          const expectedUpdatedAt = req.body?.expectedUpdatedAt;
          if (
            expectedUpdatedAt !== undefined &&
            expectedUpdatedAt !== record.updatedAt
          ) {
            throw new ConflictError(
              'The app changed since you opened it. Reopen the current record before editing.',
            );
          }
          const app = parseApp({
            evidence: record.evidence,
            reviewTicketUrl: record.reviewTicketUrl,
            ...req.body,
          });
          if (app.sourceUrl !== record.sourceUrl)
            throw new InputError('The registered source URL is fixed.');
          await validateOwners(app);
          const previousInput = appInput.parse(record);
          const tier = evaluateTier(app);
          const riskFields = [
            'purpose',
            'evidence',
            'owner',
            'backupOwner',
            'team',
            'type',
            'platform',
            'audience',
            'classification',
            'models',
            'usesAiAtRuntime',
            'connections',
            'takesActions',
            'actionDescription',
            'affectsPeople',
            'critical',
            'personalData',
            'hosted',
          ] as const;
          const enteringProduction =
            app.deliveryStage === 'production' &&
            previousInput.deliveryStage !== 'production';
          const needsReview =
            tier === 3 &&
            (enteringProduction ||
              riskFields.some(
                key =>
                  JSON.stringify(app[key]) !==
                  JSON.stringify(previousInput[key]),
              ));
          const reopening = tier === 3 && (tier !== record.tier || needsReview);
          const updated =
            tier !== record.tier || needsReview
              ? {
                  ...buildRecord(
                    {
                      ...app,
                      lifecycle:
                        reopening && app.lifecycle === 'active'
                          ? 'experimental'
                          : app.lifecycle,
                    },
                    record.discoverySource,
                    record.id,
                  ),
                  updatedAt: nextRecordTimestamp(record.updatedAt),
                }
              : {
                  ...record,
                  ...app,
                  backupOwner: app.backupOwner,
                  deliveryStage: app.deliveryStage,
                  evidence: app.evidence,
                  reviewTicketUrl: app.reviewTicketUrl,
                  actionDescription: app.actionDescription,
                  hosted: app.hosted,
                  effectiveClassification: effectiveClassification(app),
                  updatedAt: nextRecordTimestamp(record.updatedAt),
                };
          const ownerChanged = app.owner !== record.owner;
          if (ownerChanged && updated.tier === 2) {
            updated.lastReview = null;
            updated.nextReview = updated.updatedAt;
          }
          assertCanLaunch(updated);
          await save(updated, revision, principal, 'updated', { ownerChanged });
          res.json(visibleRecord(updated, principal));
        });

        router.post('/apps/:id/attestation', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const { record, revision } = await load(req.params.id);
          if (record.owner !== principal.userEntityRef) {
            throw new NotAllowedError(
              'Only the accountable owner can attest to this app.',
            );
          }
          const input = z
            .object({
              confirmed: z.literal(true),
              expectedUpdatedAt: z.string().datetime(),
            })
            .safeParse(req.body);
          if (!input.success)
            throw new InputError(
              'Confirm the current record before attesting.',
            );
          if (input.data.expectedUpdatedAt !== record.updatedAt) {
            throw new ConflictError(
              'The app changed. Reopen the current record before attesting.',
            );
          }
          if (
            record.tier !== 2 ||
            evaluateTier(record) !== 2 ||
            record.lifecycle === 'retired'
          ) {
            throw new InputError(
              'Owner attestation applies to current, non-retired Tier 2 apps.',
            );
          }
          await validateOwners(parseApp(record));
          const at = nextRecordTimestamp(record.updatedAt);
          const updated = {
            ...record,
            updatedAt: at,
            lastReview: at,
            nextReview: nextReview(2, at),
          };
          await save(updated, revision, principal, 'attested');
          res.json(updated);
        });

        router.post('/apps/:id/reviews', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          if (!reviewers.includes(principal.userEntityRef))
            throw new NotAllowedError('Reviewer access is required.');
          const decision = z
            .object({
              status: z.enum(['approved', 'changes needed']),
              track: reviewTrack.optional(),
              notes: z.string().trim().min(1).max(4000),
              expectedUpdatedAt: z.string().datetime(),
            })
            .safeParse(req.body);
          if (!decision.success)
            throw new InputError(
              'Submit a decision, review notes, and the current record timestamp.',
            );
          const { record, revision } = await load(req.params.id);
          if (decision.data.expectedUpdatedAt !== record.updatedAt) {
            throw new ConflictError(
              'The app changed since you opened this review. Refresh and review the current record.',
            );
          }
          if (
            record.owner === principal.userEntityRef ||
            record.backupOwner === principal.userEntityRef
          ) {
            throw new NotAllowedError('Owners cannot review their own apps.');
          }
          if (record.tier !== 3 || record.lifecycle === 'retired')
            throw new InputError(
              'Reviewer decisions apply to non-retired tier 3 apps.',
            );
          if (decision.data.status === 'approved') {
            if (evaluateTier(record) !== record.tier) {
              throw new ConflictError(
                'The current risk policy changed. Reassess the app before approving it.',
              );
            }
            await validateOwners(parseApp(record));
          }
          const track = decision.data.track;
          if (
            trackConfig &&
            (!track || !trackConfig[track].includes(principal.userEntityRef))
          ) {
            throw new NotAllowedError('Choose a review track assigned to you.');
          }
          if (!trackConfig && track)
            throw new InputError('Separate review tracks are disabled.');
          const at = nextRecordTimestamp(record.updatedAt);
          const signoffs = track && {
            ...record.signoffs,
            [track]: {
              status: decision.data.status,
              actor: principal.userEntityRef,
              notes: decision.data.notes,
              at,
            },
          };
          const summary = trackConfig
            ? trackedReview(signoffs || undefined, trackConfig, Date.parse(at))
            : {
                reviewStatus: decision.data.status,
                nextReview:
                  decision.data.status === 'approved'
                    ? nextReview(3, at)
                    : null,
              };
          const updated: GovernanceRecord = {
            ...record,
            updatedAt: at,
            lastReview: at,
            lifecycle:
              summary.reviewStatus !== 'approved' &&
              record.lifecycle === 'active'
                ? 'experimental'
                : record.lifecycle,
            ...summary,
            signoffs: signoffs || undefined,
            reviewNotes: decision.data.notes,
          };
          await save(updated, revision, principal, 'reviewed');
          res.json(visibleRecord(updated, principal));
        });

        const gatewayRouter = Router();
        registerGatewayRoutes({
          router: gatewayRouter,
          httpAuth,
          httpRouter,
          db,
          appsTable: table,
          configuration: config.getOptional('governance.gateway'),
          hostedWorkspaceApproved,
          listenHost: config.getOptionalString('backend.listen.host'),
          load,
          assertCanEdit,
          meetsLaunchRequirements,
          evaluateTier,
          ownersAreActive,
          isReviewer: principal => reviewers.includes(principal.userEntityRef),
        });
        httpRouter.use(gatewayRouter);
        httpRouter.use(router);
      },
    });
  },
});

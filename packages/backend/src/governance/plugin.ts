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
import { parseAppCsv } from './csv';
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
};

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
        config: coreServices.rootConfig,
      },
      async init({ auth, httpAuth, httpRouter, database, discovery, config }) {
        const db = await database.getClient();
        const catalog = new CatalogClient({ discoveryApi: discovery });
        const reviewers =
          config.getOptionalStringArray('governance.reviewers') ?? [];
        const tierPolicy = tierPolicyInput.parse(
          config.getOptional('governance.tierPolicy') ?? {},
        );
        const evaluateTier = (app: Parameters<typeof calculateTier>[0]) =>
          calculateTier(app, tierPolicy);
        const table = 'governance_apps';
        const history = 'governance_history';
        const migrations = {
          getMigrations: async () => ['001_inventory', '002_history'],
          getMigrationName: (name: string) => name,
          getMigration: async (name: string) => ({
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
          }),
        };
        await db.migrate.latest({ migrationSource: migrations });
        const router = Router();
        router.use(express.json({ limit: '1mb' }));

        async function validateOwners(app: AppInput) {
          const { token } = await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId: 'catalog',
          });
          const entityRefs = [
            app.owner,
            app.team,
            ...(app.backupOwner ? [app.backupOwner] : []),
          ];
          const { items } = await catalog.getEntitiesByRefs(
            { entityRefs },
            { token },
          );
          if (
            items.some(
              entity =>
                !entity ||
                entity.metadata.annotations?.[
                  'governance.backstage.io/active'
                ] === 'false',
            )
          ) {
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
          action: 'registered' | 'updated' | 'reviewed',
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
            for (const record of records) {
              await logChange(transaction, record, 0, principal, 'registered');
            }
          });
        }

        async function load(id: string) {
          const row = await db(table).where({ id }).first();
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
          action: 'updated' | 'reviewed',
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
            await logChange(
              transaction,
              record,
              revision + 1,
              principal,
              action,
            );
          });
        }

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
          res.json({ events });
        });

        function visibleRecord(
          record: GovernanceRecord,
          principal: BackstageUserPrincipal | BackstageServicePrincipal,
        ) {
          const result = {
            ...record,
            effectiveClassification: effectiveClassification(record),
          };
          if (
            principal.type === 'user' &&
            (principal.userEntityRef === record.owner ||
              principal.userEntityRef === record.backupOwner ||
              reviewers.includes(principal.userEntityRef))
          )
            return result;
          return { ...result, reviewNotes: undefined };
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

        function assertCanLaunch(record: GovernanceRecord) {
          const tier = evaluateTier(record);
          if (
            record.lifecycle === 'active' &&
            (tier !== record.tier ||
              (tier === 3 &&
                (record.reviewStatus !== 'approved' ||
                  !record.nextReview ||
                  Date.parse(record.nextReview) <= Date.now())))
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
            actor: principal.type === 'user' ? principal.userEntityRef : null,
            canReview:
              principal.type === 'user' &&
              reviewers.includes(principal.userEntityRef),
          });
        });

        router.post('/tier-preview', async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user', 'service'] });
          const result = riskInput.safeParse(req.body);
          if (!result.success)
            throw new InputError('Supply valid risk questionnaire answers.');
          res.json({ tier: evaluateTier(result.data) });
        });

        router.get('/apps/:id', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
          res.json(
            visibleRecord((await load(req.params.id)).record, principal),
          );
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

        router.post('/repository', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
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
          const records = await Promise.all(
            rows.map(async ({ app: input, source }) => {
              try {
                const app = parseApp(input);
                await validateOwners(app);
                return buildRecord(app, 'bulk import');
              } catch (error) {
                if (!(error instanceof InputError)) throw error;
                throw new InputError(`${source}: ${error.message}`);
              }
            }),
          );
          await insert(records, principal);
          res.status(201).json(records);
        });

        router.patch('/apps/:id/lifecycle', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
          const { record, revision } = await load(req.params.id);
          assertCanEdit(record, principal);
          const lifecycle = z
            .enum(['experimental', 'active', 'deprecated', 'retired'])
            .safeParse(req.body?.lifecycle);
          if (!lifecycle.success)
            throw new InputError('Choose a valid lifecycle.');
          const updated = {
            ...record,
            lifecycle: lifecycle.data,
            updatedAt: new Date().toISOString(),
          };
          assertCanLaunch(updated);
          await save(updated, revision, principal, 'updated');
          res.json(visibleRecord(updated, principal));
        });

        router.put('/apps/:id', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
          const { record, revision } = await load(req.params.id);
          assertCanEdit(record, principal);
          const app = parseApp(req.body);
          if (app.sourceUrl !== record.sourceUrl)
            throw new InputError('The registered source URL is fixed.');
          await validateOwners(app);
          const previousInput = appInput.parse(record);
          const tier = evaluateTier(app);
          const riskFields = [
            'type',
            'platform',
            'audience',
            'classification',
            'models',
            'connections',
            'takesActions',
            'actionDescription',
            'affectsPeople',
            'critical',
            'personalData',
            'hosted',
          ] as const;
          const needsReview =
            tier === 3 &&
            riskFields.some(
              key =>
                JSON.stringify(app[key]) !== JSON.stringify(previousInput[key]),
            );
          const updated =
            tier !== record.tier || needsReview
              ? buildRecord(app, record.discoverySource, record.id)
              : {
                  ...record,
                  ...app,
                  backupOwner: app.backupOwner,
                  actionDescription: app.actionDescription,
                  hosted: app.hosted,
                  effectiveClassification: effectiveClassification(app),
                  updatedAt: new Date().toISOString(),
                };
          assertCanLaunch(updated);
          await save(updated, revision, principal, 'updated');
          res.json(visibleRecord(updated, principal));
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
              notes: z.string().trim().min(1).max(4000),
              expectedUpdatedAt: z.string().datetime().optional(),
            })
            .safeParse(req.body);
          if (!decision.success)
            throw new InputError('Select a decision and enter review notes.');
          const { record, revision } = await load(req.params.id);
          if (
            decision.data.expectedUpdatedAt &&
            decision.data.expectedUpdatedAt !== record.updatedAt
          ) {
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
          if (record.tier !== 3)
            throw new InputError('Reviewer decisions apply to tier 3 apps.');
          const at = new Date().toISOString();
          const updated: GovernanceRecord = {
            ...record,
            updatedAt: at,
            lastReview: at,
            lifecycle:
              decision.data.status === 'changes needed' &&
              record.lifecycle === 'active'
                ? 'experimental'
                : record.lifecycle,
            reviewStatus: decision.data.status,
            reviewNotes: decision.data.notes,
            nextReview:
              decision.data.status === 'approved' ? nextReview(3, at) : null,
          };
          await save(updated, revision, principal, 'reviewed');
          res.json(updated);
        });

        httpRouter.use(router);
      },
    });
  },
});

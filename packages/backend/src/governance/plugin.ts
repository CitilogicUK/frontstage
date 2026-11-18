import { approvedConnectorsInput } from './approvedConnectors';
import { reviewTurnaround } from './reviewTurnaround';
import { appSourceKey, repositorySourceMigration } from './sourceKey';
import { createHash, randomUUID } from 'node:crypto';
import {
  type BackstageUserPrincipal,
  type BackstageServicePrincipal,
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import {
  RELATION_MEMBER_OF,
  stringifyEntityRef,
  type Entity,
} from '@backstage/catalog-model';
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
  discoveryVisibilityMigration,
  githubDiscovery,
} from './discovery';
import {
  gatewayMigration,
  gatewayKeyAuditMigration,
  gatewayUsageModeMigration,
  gatewayUsageTokensMigration,
  gatewayBlocksMigration,
  registerGatewayRoutes,
  readGatewayKeyEvents,
  isOldEnoughForRetirement,
  isRetirementCandidate,
  lastSuccessfulLiveCall,
  readRetirementCandidates,
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

type RenewalException = {
  reason: string;
  expiresAt: string;
  grantedAt: string;
  actor: string;
  owner: string;
};

type RetirementReview = {
  requestedAt: string;
  requestedBy: string;
  owner: string;
  lastLiveCall: string;
} & (
  | { status: 'pending' }
  | { status: 'kept' | 'retired'; decidedAt: string; reason: string }
);

type Graduation = {
  nominee: string;
  requestedBy: string;
  requestedAt: string;
} & (
  | { status: 'pending' }
  | { status: 'accepted' | 'declined'; decidedAt: string; reason?: string }
);

function isIndependentReviewer(record: GovernanceRecord, reviewer: string) {
  return (
    reviewer !== record.owner &&
    reviewer !== record.backupOwner &&
    (record.graduation?.status !== 'accepted' ||
      reviewer !== record.graduation.nominee)
  );
}

const graduationGroupsInput = z
  .array(z.string().regex(/^group:[a-z0-9_.-]+\/[a-z0-9_.-]+$/))
  .refine(
    groups => new Set(groups).size === groups.length,
    'Graduation groups must be unique.',
  );

type RecordAction =
  | 'registered'
  | 'updated'
  | 'reviewed'
  | 'attested'
  | 'hosted-attested'
  | 'renewal-exception-granted'
  | 'renewal-exception-revoked'
  | 'retirement-review-requested'
  | 'retirement-review-kept'
  | 'retirement-review-retired'
  | 'graduation-requested'
  | 'graduation-accepted'
  | 'graduation-declined'
  | 'graduation-cancelled';

const retirementReviewWritesPerRun = 50;
const retirementReviewOwnerBatchSize = 100;
const hostedAttestationIntervalMs = 90 * 86_400_000;
const attestationInput = z.object({
  confirmed: z.literal(true),
  expectedUpdatedAt: z.string().datetime(),
});

function recordActor(
  principal: BackstageUserPrincipal | BackstageServicePrincipal,
) {
  return principal.type === 'user'
    ? principal.userEntityRef
    : principal.subject;
}

const renewalWindowMs = 30 * 24 * 60 * 60 * 1_000;

function isRenewalExpiryWithinWindow(due: number, expiry: number) {
  return expiry > due && expiry <= due + renewalWindowMs;
}

export type GovernanceRecord = AppInput & {
  id: string;
  tier: number;
  effectiveClassification?: AppInput['classification'];
  reviewStatus: ReviewStatus;
  lastReview: string | null;
  nextReview: string | null;
  discoverySource: 'registered' | 'git' | 'bulk import';
  updatedAt: string;
  activeSince?: string;
  reviewNotes?: string;
  signoffs?: Signoffs;
  hostedAttestation?: { at: string; nextDue: string };
  renewalException?: RenewalException;
  retirementReview?: RetirementReview;
  graduation?: Graduation;
};

function activeSinceAfterEdit(
  previous: GovernanceRecord,
  current: GovernanceRecord,
) {
  if (current.lifecycle !== 'active') return undefined;
  return previous.lifecycle === 'active'
    ? previous.activeSince
    : current.updatedAt;
}

function isGraduationStage(record: GovernanceRecord) {
  return (
    record.tier === 3 &&
    record.deliveryStage === 'production' &&
    record.lifecycle !== 'retired'
  );
}

function graduationAfterEdit(
  previous: GovernanceRecord,
  current: GovernanceRecord,
) {
  return previous.owner === current.owner && isGraduationStage(current)
    ? previous.graduation
    : undefined;
}

function retirementReviewAfterEdit(
  previous: GovernanceRecord,
  current: AppInput,
) {
  const review = previous.retirementReview;
  if (
    review?.status === 'pending' &&
    (current.lifecycle !== 'active' ||
      current.owner !== previous.owner ||
      current.team !== previous.team ||
      current.usesAiAtRuntime === false ||
      current.type === 'provider-hosted app')
  ) {
    return undefined;
  }
  return review;
}

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
        logger: coreServices.logger,
        discovery: coreServices.discovery,
        scheduler: coreServices.scheduler,
        config: coreServices.rootConfig,
      },
      async init({
        auth,
        httpAuth,
        httpRouter,
        database,
        logger,
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
        const approvedConnectors = approvedConnectorsInput.parse(
          config.getOptional('governance.approvedConnectors'),
        );
        const retirementReviewIntervalMinutes = z
          .number()
          .int()
          .min(15)
          .max(10_080)
          .optional()
          .parse(
            config.getOptional('governance.retirementReviewIntervalMinutes'),
          );
        const graduationGroups = graduationGroupsInput
          .default([])
          .parse(config.getOptional('governance.graduationGroups'));
        const graduationEnabled = graduationGroups.length > 0;
        const firstDecisionTargetWeekdays = z
          .number()
          .int()
          .positive()
          .optional()
          .parse(config.getOptional('governance.firstDecisionTargetWeekdays'));
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
            '012_gateway_key_audit',
            '013_repository_source_keys',
            '014_discovery_visibility',
          ],
          getMigrationName: (name: string) => name,
          getMigration: async (name: string) => {
            if (name === '012_gateway_key_audit')
              return gatewayKeyAuditMigration();
            if (name === '013_repository_source_keys')
              return repositorySourceMigration(table);
            if (name === '014_discovery_visibility')
              return discoveryVisibilityMigration();
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

        async function activeCatalogEntities(entityRefs: string[]) {
          const active = new Map<string, Entity>();
          if (!entityRefs.length) return active;
          const { token } = await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId: 'catalog',
          });
          for (let offset = 0; offset < entityRefs.length; offset += 100) {
            const batch = entityRefs.slice(offset, offset + 100);
            const { items } = await catalog.getEntitiesByRefs(
              { entityRefs: batch },
              { token },
            );
            batch.forEach((ref, index) => {
              const entity = items[index];
              if (
                entity &&
                entity.metadata.annotations?.[
                  'governance.backstage.io/active'
                ] !== 'false'
              )
                active.set(ref, entity);
            });
          }
          return active;
        }

        async function unavailableOwners(entityRefs: string[]) {
          const active = await activeCatalogEntities(entityRefs);
          return new Set(entityRefs.filter(ref => !active.has(ref)));
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

        function parseRepositoryDescriptor(input: unknown) {
          const content = z.string().min(1).max(100_000).safeParse(input);
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
          return parseApp(entity.data.spec);
        }

        function hostedWorkspaceApproved(app: AppInput) {
          const hosted = app.hosted;
          return approvedHostedWorkspaces?.some(
            entry =>
              entry.provider === hosted?.provider &&
              entry.workspace === hosted?.workspace,
          );
        }

        function withHostedWorkspaceStatus(record: GovernanceRecord) {
          return record.type === 'provider-hosted app'
            ? {
                ...record,
                hostedWorkspaceAllowed: hostedWorkspaceApproved(record),
              }
            : record;
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
            activeSince: app.lifecycle === 'active' ? updatedAt : undefined,
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
          action: RecordAction,
          lifecycleReason?: string,
          renewalException?: RenewalException,
          graduationNominee?: string,
        ) {
          const previous = await transaction(history)
            .where({ app_id: record.id, revision: revision - 1 })
            .first('digest');
          const event = JSON.stringify({
            action,
            actor: recordActor(principal),
            revision,
            previousDigest: previous?.digest ?? null,
            lifecycleReason,
            renewalException,
            graduationNominee,
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
          discoveryClaim?: { id: string; includePrivate: boolean },
        ) {
          await db.transaction(async transaction => {
            const rows = records.map(record => ({
              id: record.id,
              source_key: appSourceKey(record.sourceUrl),
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
            if (discoveryClaim) {
              await github.markClaimed(
                transaction,
                discoveryClaim.id,
                rows[0].id,
                rows[0].source_key,
                discoveryClaim.includePrivate,
              );
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
          action: Exclude<RecordAction, 'registered'>,
          {
            ownerChanged = false,
            lifecycleReason,
            renewalException,
            expectedRetirementActivity,
            graduationNominee,
          }: {
            ownerChanged?: boolean;
            lifecycleReason?: string;
            renewalException?: RenewalException;
            expectedRetirementActivity?: string;
            graduationNominee?: string;
          } = {},
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
            if (expectedRetirementActivity) {
              const lastLiveCall = await lastSuccessfulLiveCall(
                transaction,
                record.id,
              );
              if (
                !lastLiveCall ||
                lastLiveCall !== expectedRetirementActivity ||
                !isOldEnoughForRetirement(lastLiveCall)
              )
                throw new ConflictError(
                  'Live gateway activity changed. Refresh the retirement review.',
                );
            }
            if (
              ownerChanged ||
              record.lifecycle === 'retired' ||
              record.usesAiAtRuntime === false
            ) {
              await revokeGatewayKey(
                transaction,
                record.id,
                recordActor(principal),
              );
            }
            await logChange(
              transaction,
              record,
              revision + 1,
              principal,
              action,
              lifecycleReason,
              renewalException,
              graduationNominee,
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

        router.get('/reports/review-turnaround', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          if (!reviewers.includes(principal.userEntityRef))
            throw new NotAllowedError('Reviewer access is required.');
          const events = await db(history)
            .select('app_id', 'event')
            .orderBy(['app_id', 'revision']);
          res
            .set('Cache-Control', 'no-store')
            .json(
              reviewTurnaround(events, Date.now(), firstDecisionTargetWeekdays),
            );
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
          const { events, keyEvents } = await db.transaction(
            async transaction => {
              await load(req.params.id, transaction);
              const recordEvents = await transaction(history)
                .where({ app_id: req.params.id })
                .orderBy('revision')
                .select('event', 'digest');
              const gatewayEvents = await readGatewayKeyEvents(
                transaction,
                req.params.id,
              );
              return { events: recordEvents, keyEvents: gatewayEvents };
            },
          );
          res
            .set('Cache-Control', 'no-store')
            .json({ events, keyEvents, keyAuditVersion: 1 });
        });

        function visibleRecord(
          record: GovernanceRecord,
          principal: BackstageUserPrincipal | BackstageServicePrincipal,
        ) {
          const now = Date.now();
          const result = {
            ...(principal.type === 'user'
              ? withHostedWorkspaceStatus(record)
              : record),
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
            renewalException: undefined,
            retirementReview: undefined,
            graduation:
              principal.type === 'user' &&
              principal.userEntityRef === record.graduation?.nominee
                ? record.graduation
                : undefined,
          };
        }

        async function assertEligibleNominee(nominee: string, owner: string) {
          if (nominee === owner)
            throw new InputError(
              'Choose an engineering co-owner other than the app owner.',
            );
          const active = await activeCatalogEntities([
            nominee,
            ...graduationGroups,
          ]);
          const user = active.get(nominee);
          const qualified =
            user &&
            stringifyEntityRef(user) === nominee &&
            user.relations?.some(({ type, targetRef }) => {
              if (
                type !== RELATION_MEMBER_OF ||
                !graduationGroups.includes(targetRef)
              )
                return false;
              const group = active.get(targetRef);
              return group && stringifyEntityRef(group) === targetRef;
            });
          if (!qualified)
            throw new InputError(
              'Choose an active catalog user who is a direct member of an active configured engineering group.',
            );
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

        function meetsLaunchRequirements(
          record: GovernanceRecord,
          now = Date.now(),
        ) {
          const tier = evaluateTier(record);
          return (
            tier === record.tier &&
            (tier !== 3 ||
              ((!trackConfig ||
                trackedReview(record.signoffs, trackConfig, now)
                  .reviewStatus === 'approved') &&
                record.reviewStatus === 'approved' &&
                record.nextReview !== null &&
                Date.parse(record.nextReview) > now))
          );
        }

        function meetsGatewayReviewRequirements(record: GovernanceRecord) {
          const now = Date.now();
          if (meetsLaunchRequirements(record, now)) return true;
          const exception = record.renewalException;
          const due = Date.parse(record.nextReview ?? '');
          const expiry = Date.parse(exception?.expiresAt ?? '');
          return (
            !trackConfig &&
            record.lifecycle === 'active' &&
            record.tier === 3 &&
            evaluateTier(record) === record.tier &&
            record.reviewStatus === 'approved' &&
            Boolean(
              exception &&
                exception.owner === record.owner &&
                reviewers.includes(exception.actor) &&
                isIndependentReviewer(record, exception.actor) &&
                Date.parse(exception.grantedAt) < due &&
                isRenewalExpiryWithinWindow(due, expiry) &&
                expiry > now,
            )
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
            graduationEnabled,
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

        router.get('/approved-connectors', async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          res.set('Cache-Control', 'no-store').json({
            configured: approvedConnectors !== undefined,
            connectors: approvedConnectors ?? [],
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
          const includePrivate = reviewers.includes(principal.userEntityRef);
          res.set('Cache-Control', 'no-store').json({
            source: github.source ?? null,
            lastScan: await github.lastScan(includePrivate),
            intervalMinutes: github.intervalMinutes ?? null,
            repositories: await github.list(includePrivate),
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

        router.get('/discovery/github/:id/descriptor', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          res.set('Cache-Control', 'no-store');
          const descriptor = await github.descriptor(
            req.params.id,
            reviewers.includes(principal.userEntityRef),
          );
          if (descriptor) {
            try {
              const app = parseRepositoryDescriptor(descriptor.content);
              if (appSourceKey(app.sourceUrl) === descriptor.sourceUrl) {
                res.json({
                  status: 'ready',
                  app: {
                    ...app,
                    evidence: undefined,
                    reviewTicketUrl: undefined,
                  },
                });
                return;
              }
            } catch (error) {
              if (!(error instanceof InputError)) throw error;
            }
          }
          res.json({ status: 'unavailable' });
        });

        router.post('/discovery/github/:id/claim', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const includePrivate = reviewers.includes(principal.userEntityRef);
          const candidate = await github.get(req.params.id, includePrivate);
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
          await insert([record], principal, {
            id: req.params.id,
            includePrivate,
          });
          res.status(201).json(withHostedWorkspaceStatus(record));
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
          res.status(201).json(withHostedWorkspaceStatus(record));
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
            sourceKey: appSourceKey(record.sourceUrl),
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
          const app = parseRepositoryDescriptor(req.body?.content);
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
          res.status(201).json(withHostedWorkspaceStatus(record));
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
          res.status(201).json(records.map(withHostedWorkspaceStatus));
        });

        function assertRetirementRevision(
          record: GovernanceRecord,
          expectedUpdatedAt: string,
        ) {
          if (record.updatedAt !== expectedUpdatedAt)
            throw new ConflictError(
              'The app changed. Reopen the current record before changing its retirement review.',
            );
        }

        async function assertRetirementOwnerActive(owner: string) {
          if ((await unavailableOwners([owner])).size)
            throw new NotAllowedError(
              'The app owner must be active in the catalog to review retirement.',
            );
        }

        async function requestRetirementReview(
          record: GovernanceRecord,
          revision: number,
          principal: BackstageUserPrincipal | BackstageServicePrincipal,
          lastLiveCall: string | undefined,
        ) {
          if (record.retirementReview?.status === 'pending')
            throw new ConflictError(
              'This app already has a pending retirement review.',
            );
          if (!lastLiveCall || !isRetirementCandidate(record, lastLiveCall))
            throw new InputError(
              'This app is not a current retirement candidate.',
            );
          const updatedAt = nextRecordTimestamp(record.updatedAt);
          const updated: GovernanceRecord = {
            ...record,
            updatedAt,
            retirementReview: {
              requestedAt: updatedAt,
              requestedBy: recordActor(principal),
              owner: record.owner,
              lastLiveCall,
              status: 'pending',
            },
          };
          await save(
            updated,
            revision,
            principal,
            'retirement-review-requested',
            {
              expectedRetirementActivity: lastLiveCall,
            },
          );
          return updated;
        }

        router.post('/apps/:id/retirement-review', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          if (!reviewers.includes(principal.userEntityRef))
            throw new NotAllowedError('Reviewer access is required.');
          const input = z
            .string()
            .datetime()
            .safeParse(req.body?.expectedUpdatedAt);
          if (!input.success)
            throw new InputError('Provide the current app timestamp.');
          const { record, revision } = await load(req.params.id);
          assertRetirementRevision(record, input.data);
          await assertRetirementOwnerActive(record.owner);
          const updated = await requestRetirementReview(
            record,
            revision,
            principal,
            await lastSuccessfulLiveCall(db, record.id),
          );
          res.json(visibleRecord(updated, principal));
        });

        router.patch('/apps/:id/retirement-review', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const input = z
            .object({
              decision: z.enum(['keep', 'retire']),
              reason: z.string().trim().min(1).max(500),
              expectedUpdatedAt: z.string().datetime(),
            })
            .safeParse(req.body);
          if (!input.success)
            throw new InputError(
              'Provide a decision, a reason, and the current app timestamp.',
            );
          const { record, revision } = await load(req.params.id);
          if (principal.userEntityRef !== record.owner)
            throw new NotAllowedError(
              'Only the current app owner can decide its retirement review.',
            );
          assertRetirementRevision(record, input.data.expectedUpdatedAt);
          const review = record.retirementReview;
          if (
            review?.status !== 'pending' ||
            record.lifecycle !== 'active' ||
            review.owner !== record.owner
          )
            throw new ConflictError(
              'There is no pending retirement review for the current owner.',
            );
          await assertRetirementOwnerActive(record.owner);
          const retire = input.data.decision === 'retire';
          if (retire && !isRetirementCandidate(record, review.lastLiveCall))
            throw new ConflictError(
              'This app is not a current retirement candidate.',
            );
          const decidedAt = nextRecordTimestamp(record.updatedAt);
          const updated: GovernanceRecord = {
            ...record,
            updatedAt: decidedAt,
            lifecycle: retire ? 'retired' : record.lifecycle,
            activeSince: retire ? undefined : record.activeSince,
            graduation: retire ? undefined : record.graduation,
            hostedAttestation: retire ? undefined : record.hostedAttestation,
            renewalException: retire ? undefined : record.renewalException,
            retirementReview: {
              ...review,
              status: retire ? 'retired' : 'kept',
              decidedAt,
              reason: input.data.reason,
            },
          };
          await save(
            updated,
            revision,
            principal,
            retire ? 'retirement-review-retired' : 'retirement-review-kept',
            retire
              ? {
                  lifecycleReason: input.data.reason,
                  expectedRetirementActivity: review.lastLiveCall,
                }
              : undefined,
          );
          res.json(visibleRecord(updated, principal));
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
          const updated: GovernanceRecord = {
            ...record,
            lifecycle: lifecycle.data,
            hostedAttestation:
              lifecycle.data === 'retired'
                ? undefined
                : record.hostedAttestation,
            renewalException:
              record.lifecycle === 'active' && lifecycle.data === 'active'
                ? record.renewalException
                : undefined,
            updatedAt: nextRecordTimestamp(record.updatedAt),
          };
          updated.activeSince = activeSinceAfterEdit(record, updated);
          updated.retirementReview = retirementReviewAfterEdit(record, updated);
          updated.graduation = graduationAfterEdit(record, updated);
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
                  renewalException:
                    record.lifecycle === 'active' && app.lifecycle === 'active'
                      ? record.renewalException
                      : undefined,
                  backupOwner: app.backupOwner,
                  deliveryStage: app.deliveryStage,
                  evidence: app.evidence,
                  reviewTicketUrl: app.reviewTicketUrl,
                  actionDescription: app.actionDescription,
                  hosted: app.hosted,
                  effectiveClassification: effectiveClassification(app),
                  updatedAt: nextRecordTimestamp(record.updatedAt),
                };
          updated.activeSince = activeSinceAfterEdit(record, updated);
          updated.retirementReview = retirementReviewAfterEdit(record, updated);
          updated.graduation = graduationAfterEdit(record, updated);
          const ownerChanged = app.owner !== record.owner;
          updated.hostedAttestation =
            !ownerChanged &&
            updated.lifecycle !== 'retired' &&
            updated.type === 'provider-hosted app' &&
            JSON.stringify(previousInput.hosted) === JSON.stringify(app.hosted)
              ? record.hostedAttestation
              : undefined;
          if (ownerChanged && updated.tier === 2) {
            updated.lastReview = null;
            updated.nextReview = updated.updatedAt;
          }
          assertCanLaunch(updated);
          await save(updated, revision, principal, 'updated', { ownerChanged });
          res.json(visibleRecord(updated, principal));
        });

        function assertGraduationAvailable(
          record: GovernanceRecord,
          expectedUpdatedAt: string,
        ) {
          if (!graduationEnabled)
            throw new NotAllowedError(
              'Engineering co-owner nominations are disabled.',
            );
          if (record.updatedAt !== expectedUpdatedAt)
            throw new ConflictError(
              'The app changed. Reopen the current record before changing its engineering handoff.',
            );
          if (!isGraduationStage(record) || evaluateTier(record) !== 3)
            throw new InputError(
              'Engineering handoff applies to non-retired Tier 3 production apps.',
            );
        }

        router.post('/apps/:id/graduation', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const input = z
            .object({
              nominee: z.string().regex(/^user:[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
              expectedUpdatedAt: z.string().datetime(),
            })
            .safeParse(req.body);
          if (!input.success)
            throw new InputError(
              'Choose a catalog user and provide the current app timestamp.',
            );
          const { record, revision } = await load(req.params.id);
          assertCanEdit(record, principal);
          assertGraduationAvailable(record, input.data.expectedUpdatedAt);
          if (record.graduation && record.graduation.status !== 'declined')
            throw new ConflictError(
              'This app already has a pending or accepted engineering handoff.',
            );
          await assertEligibleNominee(input.data.nominee, record.owner);
          const updatedAt = nextRecordTimestamp(record.updatedAt);
          const updated: GovernanceRecord = {
            ...record,
            updatedAt,
            graduation: {
              nominee: input.data.nominee,
              requestedBy: principal.userEntityRef,
              requestedAt: updatedAt,
              status: 'pending',
            },
          };
          await save(updated, revision, principal, 'graduation-requested');
          res.json(visibleRecord(updated, principal));
        });

        router.delete('/apps/:id/graduation', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const timestamp = z
            .string()
            .datetime()
            .safeParse(req.body?.expectedUpdatedAt);
          if (!timestamp.success)
            throw new InputError('Provide the current app timestamp.');
          const { record, revision } = await load(req.params.id);
          assertCanEdit(record, principal);
          if (record.updatedAt !== timestamp.data)
            throw new ConflictError(
              'The app changed. Reopen the current record before cancelling its engineering handoff.',
            );
          if (record.graduation?.status !== 'pending')
            throw new ConflictError(
              'Only pending engineering nominations can be cancelled.',
            );
          const updated: GovernanceRecord = {
            ...record,
            graduation: undefined,
            updatedAt: nextRecordTimestamp(record.updatedAt),
          };
          await save(updated, revision, principal, 'graduation-cancelled', {
            graduationNominee: record.graduation.nominee,
          });
          res.json(visibleRecord(updated, principal));
        });

        router.patch('/apps/:id/graduation', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const input = z
            .object({
              decision: z.enum(['accept', 'decline']),
              reason: z.string().trim().max(500).optional(),
              expectedUpdatedAt: z.string().datetime(),
            })
            .safeParse(req.body);
          if (!input.success)
            throw new InputError(
              'Provide an accept or decline decision, an optional reason up to 500 characters, and the current app timestamp.',
            );
          const { record, revision } = await load(req.params.id);
          const graduation = record.graduation;
          if (graduation?.nominee !== principal.userEntityRef)
            throw new NotAllowedError(
              'Only the engineering nominee can decide this handoff.',
            );
          assertGraduationAvailable(record, input.data.expectedUpdatedAt);
          if (graduation.status !== 'pending')
            throw new ConflictError(
              'This engineering handoff has already been decided.',
            );
          const accepted = input.data.decision === 'accept';
          if (accepted)
            await assertEligibleNominee(graduation.nominee, record.owner);
          const updatedAt = nextRecordTimestamp(record.updatedAt);
          const updated: GovernanceRecord = {
            ...record,
            updatedAt,
            renewalException:
              accepted && record.renewalException?.actor === graduation.nominee
                ? undefined
                : record.renewalException,
            graduation: {
              ...graduation,
              status: accepted ? 'accepted' : 'declined',
              decidedAt: updatedAt,
              reason: input.data.reason || undefined,
            },
          };
          await save(
            updated,
            revision,
            principal,
            accepted ? 'graduation-accepted' : 'graduation-declined',
          );
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
          const input = attestationInput.safeParse(req.body);
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
          res.json(withHostedWorkspaceStatus(updated));
        });

        router.post('/apps/:id/hosted-attestation', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const { record, revision } = await load(req.params.id);
          if (record.owner !== principal.userEntityRef)
            throw new NotAllowedError(
              'Only the accountable owner can attest to this hosted workspace.',
            );
          const input = attestationInput.safeParse(req.body);
          if (!input.success)
            throw new InputError('Confirm the current workspace settings.');
          if (input.data.expectedUpdatedAt !== record.updatedAt)
            throw new ConflictError(
              'The app changed. Reopen the current record before attesting.',
            );
          if (
            record.type !== 'provider-hosted app' ||
            !record.hosted ||
            record.lifecycle === 'retired'
          )
            throw new InputError(
              'Hosted workspace attestation applies to non-retired provider-hosted apps.',
            );
          if (hostedWorkspaceApproved(record) === false)
            throw new InputError(
              'Choose an approved provider workspace before attesting.',
            );
          const at = nextRecordTimestamp(record.updatedAt);
          const updated: GovernanceRecord = {
            ...record,
            updatedAt: at,
            hostedAttestation: {
              at,
              nextDue: new Date(
                Date.parse(at) + hostedAttestationIntervalMs,
              ).toISOString(),
            },
          };
          await save(updated, revision, principal, 'hosted-attested');
          res
            .set('Cache-Control', 'no-store')
            .json(visibleRecord(updated, principal));
        });

        async function loadRenewalExceptionRecord(
          id: string,
          principal: BackstageUserPrincipal,
          expectedUpdatedAt: string,
        ) {
          if (!reviewers.includes(principal.userEntityRef))
            throw new NotAllowedError('Reviewer access is required.');
          const current = await load(id);
          const { record } = current;
          if (!isIndependentReviewer(record, principal.userEntityRef))
            throw new NotAllowedError(
              'Only an independent reviewer can change a renewal exception.',
            );
          if (expectedUpdatedAt !== record.updatedAt)
            throw new ConflictError(
              'The app changed since you opened it. Reopen the current record before changing the renewal exception.',
            );
          return current;
        }

        router.post('/apps/:id/renewal-exception', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const input = z
            .object({
              reason: z.string().trim().min(1).max(1000),
              expiresAt: z.string().datetime(),
              expectedUpdatedAt: z.string().datetime(),
            })
            .safeParse(req.body);
          if (!input.success)
            throw new InputError(
              'Provide a reason, a UTC expiry, and the current record timestamp.',
            );
          const { record, revision } = await loadRenewalExceptionRecord(
            req.params.id,
            principal,
            input.data.expectedUpdatedAt,
          );
          if (trackConfig)
            throw new NotAllowedError(
              'Renewal exceptions are unavailable when separate review tracks are required.',
            );
          if (record.renewalException)
            throw new ConflictError(
              'Revoke the existing renewal exception before granting another.',
            );
          const now = Date.now();
          if (
            record.lifecycle !== 'active' ||
            record.tier !== 3 ||
            !meetsLaunchRequirements(record, now)
          )
            throw new InputError(
              'An active tier 3 app needs a current approval before a renewal exception can be granted.',
            );
          const due = Date.parse(record.nextReview ?? '');
          const expiry = Date.parse(input.data.expiresAt);
          if (!isRenewalExpiryWithinWindow(due, expiry))
            throw new InputError(
              'The expiry must be after the scheduled review and at most 30 days later.',
            );
          const updatedAt = nextRecordTimestamp(record.updatedAt);
          const renewalException: RenewalException = {
            reason: input.data.reason,
            expiresAt: new Date(expiry).toISOString(),
            grantedAt: new Date(now).toISOString(),
            actor: principal.userEntityRef,
            owner: record.owner,
          };
          const updated = { ...record, updatedAt, renewalException };
          await save(
            updated,
            revision,
            principal,
            'renewal-exception-granted',
            {
              renewalException,
            },
          );
          res.json(visibleRecord(updated, principal));
        });

        router.delete('/apps/:id/renewal-exception', async (req, res) => {
          const { principal } = await httpAuth.credentials(req, {
            allow: ['user'],
          });
          const input = z
            .string()
            .datetime()
            .safeParse(req.body?.expectedUpdatedAt);
          if (!input.success)
            throw new InputError('Provide the current record timestamp.');
          const { record, revision } = await loadRenewalExceptionRecord(
            req.params.id,
            principal,
            input.data,
          );
          if (!record.renewalException)
            throw new NotFoundError('This app has no renewal exception.');
          const updated = {
            ...record,
            updatedAt: nextRecordTimestamp(record.updatedAt),
            renewalException: undefined,
          };
          await save(
            updated,
            revision,
            principal,
            'renewal-exception-revoked',
            {
              renewalException: record.renewalException,
            },
          );
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
          if (!isIndependentReviewer(record, principal.userEntityRef)) {
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
            renewalException: undefined,
          };
          updated.activeSince = activeSinceAfterEdit(record, updated);
          updated.retirementReview = retirementReviewAfterEdit(record, updated);
          updated.graduation = graduationAfterEdit(record, updated);
          await save(updated, revision, principal, 'reviewed');
          res.json(visibleRecord(updated, principal));
        });

        if (retirementReviewIntervalMinutes !== undefined) {
          await scheduler.scheduleTask({
            id: 'governance-retirement-review',
            scope: 'global',
            frequency: { minutes: retirementReviewIntervalMinutes },
            initialDelay: { seconds: 5 },
            timeout: { minutes: 2 },
            async fn(signal) {
              if (signal.aborted) return;
              const { principal } = await auth.getOwnServiceCredentials();
              const candidates = (
                await readRetirementCandidates(db, table)
              ).filter(
                ({ record }) => record.retirementReview?.status !== 'pending',
              );
              let opened = 0;
              for (
                let index = 0;
                index < candidates.length;
                index += retirementReviewOwnerBatchSize
              ) {
                if (opened >= retirementReviewWritesPerRun || signal.aborted)
                  return;
                const batch = candidates.slice(
                  index,
                  index + retirementReviewOwnerBatchSize,
                );
                const unavailable = await unavailableOwners([
                  ...new Set(batch.map(({ record }) => record.owner)),
                ]);
                for (const { record, revision, lastLiveCall } of batch) {
                  if (opened >= retirementReviewWritesPerRun || signal.aborted)
                    return;
                  if (unavailable.has(record.owner)) continue;
                  try {
                    await requestRetirementReview(
                      record,
                      revision,
                      principal,
                      lastLiveCall,
                    );
                    opened += 1;
                  } catch (error) {
                    if (
                      !(
                        error instanceof ConflictError ||
                        error instanceof InputError
                      )
                    )
                      throw error;
                  }
                }
              }
            },
          });
        }

        const gatewayRouter = Router();
        registerGatewayRoutes({
          router: gatewayRouter,
          logger,
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
          meetsGatewayReviewRequirements,
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

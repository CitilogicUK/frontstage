import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  BackstageUserPrincipal,
  DatabaseService,
  HttpAuthService,
  HttpRouterService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import {
  AuthenticationError,
  ConflictError,
  InputError,
  NotAllowedError,
  ServiceUnavailableError,
} from '@backstage/errors';
import express, { type Router } from 'express';
import { z } from 'zod';
import type { GovernanceRecord } from './plugin';
import { reserveGatewayRequest } from './gatewayRateLimit';
import { effectiveClassification, sourceUrl as appSourceUrl } from './policy';
import { appSourceKey } from './sourceKey';

type Database = Awaited<ReturnType<DatabaseService['getClient']>>;
type UsageTotals = {
  appId: string;
  model: string;
  mode: string | null;
  calls: number | string;
  cost: number | string;
};

type TokenTotals = {
  tokenCalls: number | string;
  inputTokens: number | string | null;
  outputTokens: number | string | null;
};

function tokenAggregates(db: Database) {
  return [
    db.raw('count(??) as ??', ['input_tokens', 'tokenCalls']),
    db.raw('sum(??) as ??', ['input_tokens', 'inputTokens']),
    db.raw('sum(??) as ??', ['output_tokens', 'outputTokens']),
  ];
}

const keysTable = 'governance_gateway_keys';
const keyEnvironmentInput = z.enum(['sandbox', 'production']);
type KeyEnvironment = z.infer<typeof keyEnvironmentInput>;
type ExecutionMode = 'simulation' | 'openai';

function requestedKeyEnvironment(value: unknown): KeyEnvironment | undefined {
  if (value === undefined) return undefined;
  const environment = keyEnvironmentInput.safeParse(value);
  if (!environment.success)
    throw new InputError(
      'Choose the sandbox or production gateway key environment.',
    );
  return environment.data;
}
const keyEventsTable = 'governance_gateway_key_events';
const blocksTable = 'governance_gateway_blocks';
const usageTable = 'governance_gateway_usage';
const retirementReviewDays = 90;
const retirementReviewMs = retirementReviewDays * 86_400_000;

export function isOldEnoughForRetirement(timestamp: string, now = Date.now()) {
  return Date.parse(timestamp) <= now - retirementReviewMs;
}

export function isRetirementCandidate(
  app: GovernanceRecord,
  lastLiveCall: string,
  now = Date.now(),
) {
  const review = app.retirementReview;
  const recentKeep =
    review?.status === 'kept' &&
    review.lastLiveCall === lastLiveCall &&
    !!review.decidedAt &&
    Date.parse(review.decidedAt) > now - retirementReviewMs;
  return (
    app.lifecycle === 'active' &&
    app.usesAiAtRuntime !== false &&
    app.type !== 'provider-hosted app' &&
    isOldEnoughForRetirement(lastLiveCall, now) &&
    (app.activeSince === undefined ||
      isOldEnoughForRetirement(app.activeSince, now)) &&
    !recentKeep
  );
}

export async function lastSuccessfulLiveCall(db: Database, appId: string) {
  const row = await db(usageTable)
    .where({ app_id: appId, execution_mode: 'openai' })
    .max('created_at as lastLiveCall')
    .first<{ lastLiveCall: Date | string | number | null }>();
  if (!row || row.lastLiveCall === null) return undefined;
  return new Date(row.lastLiveCall).toISOString();
}

export async function readRetirementCandidates(
  db: Database,
  appsTable: string,
  now = Date.now(),
) {
  const retirementCutoff = new Date(now - retirementReviewMs);
  const lastLiveCalls = db(usageTable)
    .where('execution_mode', 'openai')
    .groupBy('app_id')
    .select('app_id')
    .max('created_at as last_live_call')
    .as('live');
  const retirementRows = await db(`${appsTable} as app`)
    .join(lastLiveCalls, 'live.app_id', 'app.id')
    .where('live.last_live_call', '<=', retirementCutoff)
    .orderBy('live.last_live_call')
    .orderBy('app.id')
    .select<
      Array<{
        payload: string;
        revision: number;
        lastLiveCall: Date | string | number;
      }>
    >('app.payload', 'app.revision', 'live.last_live_call as lastLiveCall');
  return retirementRows.flatMap(row => {
    const record = JSON.parse(row.payload) as GovernanceRecord;
    const lastLiveCall = new Date(row.lastLiveCall).toISOString();
    return isRetirementCandidate(record, lastLiveCall, now)
      ? [{ record, revision: row.revision, lastLiveCall }]
      : [];
  });
}

const chatPath = '/gateway/chat';
const nanosPerDollar = 1_000_000_000;
const rate = z.number().finite().nonnegative().max(1_000_000).default(0);
const requestLimit = z.number().int().min(1).max(10_000);
const gatewayConfig = z
  .object({
    enabled: z.boolean().default(false),
    requestsPerMinute: requestLimit.optional(),
    appRateLimits: z
      .array(
        z
          .object({
            sourceUrl: appSourceUrl,
            requestsPerMinute: requestLimit,
          })
          .strict(),
      )
      .default([]),
    appSpendThresholds: z
      .array(
        z
          .object({
            sourceUrl: appSourceUrl,
            monthlyUsd: z.number().finite().positive().max(1_000_000),
            stopAtThreshold: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
    mode: z.enum(['simulation', 'openai']).optional(),
    models: z
      .record(
        z.string(),
        z
          .object({
            allowedClassifications: z
              .array(
                z.enum(['public', 'internal', 'confidential', 'restricted']),
              )
              .min(1),
            maxCompletionTokens: z
              .number()
              .int()
              .min(1)
              .max(16_384)
              .default(1024),
            inputUsdPerMillionTokens: rate,
            outputUsdPerMillionTokens: rate,
          })
          .strict(),
      )
      .default({}),
    openaiApiKey: z.string().trim().min(1).optional(),
  })
  .strict();
type ModelPolicy = z.infer<typeof gatewayConfig>['models'][string];
const chatInput = z
  .object({
    model: z.string().min(1).max(128),
    prompt: z.string().min(1).max(16_000),
    expectedEnvironment: keyEnvironmentInput.optional(),
  })
  .strict();
const openaiResult = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
          refusal: z.string().nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }),
});

type KeyEventRow = {
  id: string;
  app_id: string;
  actor: string;
  action: string;
  created_at: Date | string | number;
};

function keyAuditFields(
  row: KeyEventRow,
  previous?: { revision: number; digest: string },
  environment?: KeyEnvironment,
) {
  const revision = (previous?.revision ?? -1) + 1;
  const event = JSON.stringify({
    id: row.id,
    appId: row.app_id,
    action: row.action,
    actor: row.actor,
    at: new Date(row.created_at).toISOString(),
    ...(environment && { environment }),
    revision,
    previousDigest: previous?.digest ?? null,
  });
  return {
    revision,
    event,
    digest: createHash('sha256').update(event).digest('hex'),
  };
}

async function logGatewayKeyChange(
  transaction: Database,
  appId: string,
  actor: string,
  action: 'issued' | 'rotated' | 'revoked',
  environment: KeyEnvironment,
) {
  const previous = await transaction(keyEventsTable)
    .where({ app_id: appId })
    .orderBy('revision', 'desc')
    .first('revision', 'digest');
  const row = {
    id: randomUUID(),
    app_id: appId,
    actor,
    action,
    created_at: new Date(),
  };
  await transaction(keyEventsTable).insert({
    ...row,
    ...keyAuditFields(row, previous, environment),
  });
}

export async function revokeGatewayKey(
  transaction: Database,
  appId: string,
  actor: string,
) {
  const credentials = transaction(keysTable).where({ app_id: appId });
  const scopes = await credentials
    .clone()
    .orderBy('environment')
    .select<{ environment: KeyEnvironment }[]>('environment');
  if (!scopes.length) return;
  await credentials.del();
  for (const { environment } of scopes) {
    await logGatewayKeyChange(
      transaction,
      appId,
      actor,
      'revoked',
      environment,
    );
  }
}

export function readGatewayKeyEvents(db: Database, appId: string) {
  return db(keyEventsTable)
    .where({ app_id: appId })
    .orderBy('revision')
    .select('action', 'actor', 'created_at as at', 'event', 'digest');
}

export function gatewayKeyAuditMigration() {
  return {
    async up(db: Database) {
      await db.schema.alterTable(keyEventsTable, table => {
        table.integer('revision');
        table.text('event');
        table.string('digest', 64);
        table.unique(['app_id', 'revision']);
      });
      const rows = await db<KeyEventRow>(keyEventsTable)
        .select('*')
        .orderBy(['app_id', 'created_at', 'id']);
      let previous:
        | { appId: string; revision: number; digest: string }
        | undefined;
      for (const row of rows) {
        const fields = keyAuditFields(
          row,
          previous?.appId === row.app_id ? previous : undefined,
        );
        await db(keyEventsTable).where({ id: row.id }).update(fields);
        previous = { appId: row.app_id, ...fields };
      }
    },
    async down(db: Database) {
      await db.schema.alterTable(keyEventsTable, table => {
        table.dropUnique(['app_id', 'revision']);
        table.dropColumns('revision', 'event', 'digest');
      });
    },
  };
}

export function gatewayMigration(appsTable: string) {
  return {
    async up(db: Database) {
      await db.schema.createTable(keysTable, table => {
        table.string('app_id').primary().references('id').inTable(appsTable);
        table.string('digest', 64).unique().notNullable();
      });
      await db.schema.createTable(keyEventsTable, table => {
        table.string('id').primary();
        table
          .string('app_id')
          .notNullable()
          .references('id')
          .inTable(appsTable);
        table.string('actor').notNullable();
        table.string('action').notNullable();
        table.timestamp('created_at', { useTz: true }).notNullable();
      });
      await db.schema.createTable(usageTable, table => {
        table.string('id').primary();
        table
          .string('app_id')
          .notNullable()
          .references('id')
          .inTable(appsTable);
        table.string('model', 128).notNullable();
        table.bigInteger('estimated_cost_nanos_usd').notNullable();
        table.timestamp('created_at', { useTz: true }).notNullable();
        table.index(['app_id', 'created_at']);
      });
    },
    async down(db: Database) {
      await db.schema.dropTable(usageTable);
      await db.schema.dropTable(keyEventsTable);
      await db.schema.dropTable(keysTable);
    },
  };
}

export function gatewayKeyEnvironmentsMigration(appsTable: string) {
  return {
    async up(db: Database) {
      const scopedKeys = `${keysTable}_scoped`;
      await db.schema.createTable(scopedKeys, table => {
        table
          .string('app_id')
          .notNullable()
          .references('id')
          .inTable(appsTable);
        table
          .string('environment', 16)
          .notNullable()
          .checkIn(keyEnvironmentInput.options);
        table.string('digest', 64).unique().notNullable();
        table.primary(['app_id', 'environment']);
      });
      await db(scopedKeys).insert(
        db(keysTable).select(
          'app_id',
          db.raw('? as environment', ['sandbox']),
          'digest',
        ),
      );
      await db.schema.dropTable(keysTable);
      await db.schema.renameTable(scopedKeys, keysTable);
    },
    async down(db: Database) {
      // Unscoped credentials must be reissued after rollback. Restoring a
      // sandbox digest to an unscoped live gateway could grant live access.
      await db.schema.dropTable(keysTable);
      await db.schema.createTable(keysTable, table => {
        table.string('app_id').primary().references('id').inTable(appsTable);
        table.string('digest', 64).unique().notNullable();
      });
    },
  };
}

export function gatewayUsageModeMigration() {
  return {
    async up(db: Database) {
      await db.schema.alterTable(usageTable, table => {
        table.string('execution_mode', 16);
      });
    },
    async down(db: Database) {
      await db.schema.alterTable(usageTable, table => {
        table.dropColumn('execution_mode');
      });
    },
  };
}

export function gatewayUsageTokensMigration() {
  return {
    async up(db: Database) {
      await db.schema.alterTable(usageTable, table => {
        table.bigInteger('input_tokens');
        table.bigInteger('output_tokens');
      });
    },
    async down(db: Database) {
      await db.schema.alterTable(usageTable, table =>
        table.dropColumns('input_tokens', 'output_tokens'),
      );
    },
  };
}

export function gatewayBlocksMigration(appsTable: string) {
  return {
    async up(db: Database) {
      await db.schema.createTable(blocksTable, table => {
        table.increments('id');
        table
          .string('app_id')
          .notNullable()
          .references('id')
          .inTable(appsTable);
        table.string('reason').notNullable();
        table.string('mode').notNullable();
        table.timestamp('created_at', { useTz: true }).notNullable().index();
      });
    },
    async down(db: Database) {
      await db.schema.dropTable(blocksTable);
    },
  };
}

function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

async function callOpenai(
  key: string,
  model: string,
  prompt: string,
  maxCompletionTokens: number,
  logFailure: (metadata: { kind: string; upstreamStatus?: number }) => void,
) {
  const signal = AbortSignal.timeout(20_000);
  let kind = 'transport';
  let upstreamStatus: number | undefined;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: maxCompletionTokens,
      }),
      signal,
    });
    if (!response.ok) {
      kind = 'upstream-http';
      upstreamStatus = response.status;
      await response.body?.cancel();
      throw new Error('Provider request was unsuccessful.');
    }
    kind = 'invalid-response';
    const result = openaiResult.parse(await response.json());
    const { content, refusal } = result.choices[0].message;
    const refusalText = refusal?.trim();
    const output = refusalText || content;
    if (output === null) throw new Error('Provider request returned no text.');
    return {
      output,
      refused: Boolean(refusalText),
      inputTokens: result.usage.prompt_tokens,
      outputTokens: result.usage.completion_tokens,
    };
  } catch {
    logFailure({ kind: signal.aborted ? 'timeout' : kind, upstreamStatus });
    throw new ServiceUnavailableError(
      'The configured model provider is temporarily unavailable.',
    );
  }
}

function simulate(model: string, prompt: string) {
  const output = `Simulated response from ${model}. No prompt was sent to a provider.`;
  return {
    output,
    refused: false,
    inputTokens: Math.ceil(Buffer.byteLength(prompt) / 4),
    outputTokens: Math.ceil(Buffer.byteLength(output) / 4),
  };
}

function estimateCost(
  model: ModelPolicy,
  inputTokens: number,
  outputTokens: number,
) {
  return Math.round(
    (inputTokens * model.inputUsdPerMillionTokens +
      outputTokens * model.outputUsdPerMillionTokens) *
      (nanosPerDollar / 1_000_000),
  );
}

function getCheckStatus(status: boolean | null | undefined) {
  if (status === null) return 'not-applicable';
  if (status === undefined) return 'unknown';
  return status ? 'pass' : 'attention';
}

function currentUtcMonthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function registerGatewayRoutes(options: {
  router: Router;
  httpAuth: HttpAuthService;
  httpRouter: HttpRouterService;
  logger: LoggerService;
  db: Database;
  appsTable: string;
  configuration: unknown;
  hostedWorkspaceApproved: (app: GovernanceRecord) => boolean | undefined;
  listenHost?: string;
  load: (
    id: string,
    transaction?: Database,
  ) => Promise<{ record: GovernanceRecord; revision: number }>;
  assertCanEdit: (
    app: GovernanceRecord,
    principal: BackstageUserPrincipal,
  ) => void;
  meetsLaunchRequirements: (app: GovernanceRecord) => boolean;
  meetsGatewayReviewRequirements: (app: GovernanceRecord) => boolean;
  attestationPaused?: (
    app: GovernanceRecord,
    transaction: Database,
  ) => Promise<boolean>;
  evaluateTier: (app: GovernanceRecord) => number;
  ownersAreActive: (app: GovernanceRecord) => Promise<boolean>;
  batchCatalogOwnership: (
    apps: GovernanceRecord[],
  ) => Promise<Map<string, boolean>>;
  isReviewer: (principal: BackstageUserPrincipal) => boolean;
}) {
  const {
    router,
    httpAuth,
    httpRouter,
    logger,
    db,
    appsTable,
    load,
    assertCanEdit,
    meetsLaunchRequirements,
    meetsGatewayReviewRequirements,
    attestationPaused,
    isReviewer,
    evaluateTier,
    ownersAreActive,
  } = options;
  const config = gatewayConfig.parse(options.configuration ?? {});
  const appRateLimits = new Map(
    config.appRateLimits.map(app => [
      appSourceKey(app.sourceUrl),
      app.requestsPerMinute,
    ]),
  );
  if (appRateLimits.size !== config.appRateLimits.length)
    throw new Error(
      'Configure only one gateway request limit per app source URL.',
    );

  const appSpendThresholds = new Map(
    config.appSpendThresholds.map(app => [appSourceKey(app.sourceUrl), app]),
  );
  if (appSpendThresholds.size !== config.appSpendThresholds.length)
    throw new Error(
      'Configure only one gateway spend threshold per app source URL.',
    );

  async function monthlyLiveCost(
    database: Database,
    appId: string,
    monthStart: Date,
  ) {
    const [month] = await database(usageTable)
      .where({ app_id: appId, execution_mode: 'openai' })
      .where('created_at', '>=', monthStart)
      .sum({ cost: 'estimated_cost_nanos_usd' });
    return Number(month.cost ?? 0) / nanosPerDollar;
  }

  function limitFor(app: GovernanceRecord) {
    return (
      appRateLimits.get(appSourceKey(app.sourceUrl)) ?? config.requestsPerMinute
    );
  }

  const simulationDeployment = config.mode === 'simulation';
  if (config.enabled && !config.mode) {
    throw new Error(
      'Select an explicit mode before enabling the governance gateway.',
    );
  }
  if (config.enabled && Object.keys(config.models).length === 0) {
    throw new Error(
      'Enable the governance gateway only after configuring its approved models.',
    );
  }
  if (
    config.enabled &&
    simulationDeployment &&
    (process.env.NODE_ENV !== 'development' ||
      !['localhost', '127.0.0.1', '::1'].includes(options.listenHost ?? ''))
  ) {
    throw new Error(
      'Gateway simulation is available only on a loopback development backend.',
    );
  }
  if (config.enabled && !simulationDeployment && !config.openaiApiKey) {
    throw new Error('OpenAI gateway mode requires a provider key.');
  }
  const providerKey = config.openaiApiKey;
  const readinessEnvironment: KeyEnvironment =
    config.mode === 'openai' ? 'production' : 'sandbox';

  function assertEnabled() {
    if (!config.enabled)
      throw new ServiceUnavailableError('The model gateway is disabled.');
  }

  function assertGatewayAppType(app: GovernanceRecord) {
    if (app.usesAiAtRuntime === false)
      throw new NotAllowedError('This app does not use AI at runtime.');
    if (app.type === 'provider-hosted app') {
      throw new NotAllowedError(
        'Provider-hosted apps use their approved workspace controls.',
      );
    }
  }

  async function recordBlock(
    appId: string,
    reason: string,
    mode: ExecutionMode,
  ) {
    await db(blocksTable).insert({
      app_id: appId,
      reason,
      mode,
      created_at: new Date(),
    });
  }

  const inactiveGatewayAppMessage =
    'Set the app lifecycle to active before using the gateway.';
  const attestationBlock = {
    reason: 'attestation-overdue',
    message:
      'Gateway access is paused until the app owner completes the overdue attestation.',
  };

  function launchBlock(app: GovernanceRecord) {
    if (app.usesAiAtRuntime === false)
      return {
        reason: 'model',
        message: 'This app does not use AI at runtime.',
      };
    if (app.type === 'provider-hosted app') {
      return {
        reason: 'provider-hosted',
        message: 'Provider-hosted apps use their approved workspace controls.',
      };
    }
    if (evaluateTier(app) !== app.tier) {
      return {
        reason: 'tier-drift',
        message:
          'Current risk policy assigns a different tier. Ask the app owner to reassess the app before using the gateway.',
      };
    }
    if (!meetsGatewayReviewRequirements(app)) {
      return {
        reason: 'review',
        message:
          'Resolve current risk requirements and obtain any required approval before using the gateway.',
      };
    }
    if (app.lifecycle !== 'active') {
      return {
        reason: 'lifecycle',
        message: inactiveGatewayAppMessage,
      };
    }
    return undefined;
  }

  function modelPolicy(app: GovernanceRecord, model: string) {
    const policy = Object.hasOwn(config.models, model)
      ? config.models[model]
      : undefined;
    if (
      app.models.includes(model) &&
      policy?.allowedClassifications.includes(effectiveClassification(app))
    ) {
      return policy;
    }
    return undefined;
  }

  function isScorecardGatewayApp(record: GovernanceRecord) {
    return (
      config.enabled &&
      record.usesAiAtRuntime !== false &&
      record.type !== 'provider-hosted app'
    );
  }

  function scorecardChecks(
    record: GovernanceRecord,
    evidence: {
      ownership?: boolean;
      issuedKey: boolean;
      recentModes?: { execution_mode: string | null }[];
    },
  ) {
    const { ownership, issuedKey, recentModes } = evidence;
    const tier = evaluateTier(record);
    const tierChanged = tier !== record.tier;
    const reviewed =
      !tierChanged &&
      (tier === 1 ||
        (tier === 2 &&
          !!record.nextReview &&
          Date.parse(record.nextReview) > Date.now()) ||
        (tier === 3 && meetsLaunchRequirements(record)));
    const gatewayApp = isScorecardGatewayApp(record);
    let reviewDetail = reviewed
      ? 'The current risk tier has no outstanding review requirement.'
      : 'The app needs reassessment or a current review.';
    if (tierChanged) {
      reviewDetail = `Current policy assigns Tier ${tier}. Reassess this app to update its saved Tier ${record.tier}.`;
    } else if (
      !reviewed &&
      gatewayApp &&
      record.renewalException &&
      meetsGatewayReviewRequirements(record)
    ) {
      const expiry = record.renewalException.expiresAt
        .slice(0, 19)
        .replace('T', ' ');
      reviewDetail = `Renewal is overdue. The exception permits eligible calls with an existing gateway key until ${expiry} UTC.`;
    }
    const checks: Array<{
      name: string;
      status: boolean | null | undefined;
      detail: string;
    }> = [
      {
        name: 'Catalog ownership',
        status: ownership,
        detail:
          'The owner, backup owner when listed, and team must be active in the catalog.',
      },
      {
        name: 'Review status',
        status: reviewed,
        detail: reviewDetail,
      },
    ];
    if (gatewayApp) {
      const hasLiveActivity = recentModes?.some(
        row => row.execution_mode === 'openai',
      );
      const hasSimulation = recentModes?.some(
        row => row.execution_mode === 'simulation',
      );
      const blockedModels = record.models.filter(
        model => !modelPolicy(record, model),
      );
      const hasDeclaredModels = record.models.length > 0;
      let modelPolicyDetail =
        'All declared models are permitted for the app’s data classification.';
      if (!hasDeclaredModels) {
        modelPolicyDetail =
          'Declare at least one approved runtime model before using the gateway.';
      } else if (blockedModels.length > 0) {
        modelPolicyDetail = `Unavailable for this app or data classification: ${blockedModels.join(
          ', ',
        )}.`;
      }
      const active = record.lifecycle === 'active';
      checks.push(
        {
          name: 'Gateway lifecycle',
          status: active,
          detail: active ? 'The app is active.' : inactiveGatewayAppMessage,
        },
        {
          name: 'Gateway model policy',
          status: hasDeclaredModels && blockedModels.length === 0,
          detail: modelPolicyDetail,
        },
        {
          name: 'Recent live gateway activity',
          status: hasLiveActivity ? true : undefined,
          detail: hasLiveActivity
            ? 'At least one live gateway call was recorded in the last 90 days.'
            : [
                'No live gateway calls were recorded in the last 90 days.',
                hasSimulation ? 'Simulated calls were recorded.' : '',
              ]
                .filter(Boolean)
                .join(' '),
        },
      );
      if (active) {
        checks.push({
          name: 'Gateway key',
          status: Boolean(issuedKey),
          detail: issuedKey
            ? `A ${readinessEnvironment} gateway key is issued for this app.`
            : `Ask the app owner or a reviewer to issue a ${readinessEnvironment} gateway key.`,
        });
      }
    } else if (record.type === 'provider-hosted app') {
      const approved = options.hostedWorkspaceApproved(record);
      let detail = 'No approved workspace list is configured.';
      if (approved === true) {
        detail =
          'The declared provider and workspace are on the approved list.';
      } else if (approved === false) {
        detail =
          'The declared provider and workspace are missing from the approved list.';
      }
      checks.push({
        name: 'Declared provider workspace',
        status: approved,
        detail,
      });
      const nextDue = record.hostedAttestation?.nextDue;
      const current = !!nextDue && Date.parse(nextDue) > Date.now();
      let attestationDetail =
        'Workspace attestation is due from the app owner.';
      if (record.lifecycle === 'retired')
        attestationDetail = 'The app is retired.';
      else if (nextDue) {
        const date = nextDue.slice(0, 10);
        attestationDetail = current
          ? `Current through ${date} UTC.`
          : `Overdue since ${date} UTC.`;
      }
      checks.push({
        name: 'Hosted workspace attestation',
        status: record.lifecycle === 'retired' ? null : current,
        detail: attestationDetail,
      });
    } else {
      const modelFree = record.usesAiAtRuntime === false;
      checks.push({
        name: 'Gateway model policy and activity',
        status: modelFree ? null : undefined,
        detail: modelFree
          ? 'This app has no runtime model calls.'
          : 'Gateway evidence is unavailable for this app.',
      });
    }
    return checks.map(check => ({
      ...check,
      status: getCheckStatus(check.status),
    }));
  }

  router.get('/apps/:id/scorecard', async (req, res) => {
    const { principal } = await httpAuth.credentials(req, { allow: ['user'] });
    const { record } = await load(req.params.id);
    if (
      principal.userEntityRef !== record.owner &&
      principal.userEntityRef !== record.backupOwner &&
      !isReviewer(principal)
    ) {
      throw new NotAllowedError(
        'Only the owner, backup owner, or a reviewer can view this scorecard.',
      );
    }
    const ownership = await ownersAreActive(record).catch(() => undefined);
    let recentModes;
    let issuedKey = false;
    let accessPaused = false;
    if (isScorecardGatewayApp(record)) {
      recentModes = await db(usageTable)
        .where({ app_id: record.id })
        .andWhere(
          'created_at',
          '>=',
          new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        )
        .distinct<{ execution_mode: string | null }[]>('execution_mode');
      if (record.lifecycle === 'active') {
        accessPaused =
          !launchBlock(record) &&
          Boolean(await attestationPaused?.(record, db));
        issuedKey = Boolean(
          await db(keysTable)
            .where({ app_id: record.id, environment: readinessEnvironment })
            .first('app_id'),
        );
      }
    }
    const checks = scorecardChecks(record, {
      ownership,
      issuedKey,
      recentModes,
    });
    if (accessPaused) {
      checks.push({
        name: 'Gateway access',
        status: 'attention',
        detail: attestationPauseBlock.message,
      });
    }
    res.set('Cache-Control', 'no-store').json({ checks });
  });

  router.get('/owner-scorecard', async (req, res) => {
    const { principal } = await httpAuth.credentials(req, { allow: ['user'] });
    const rows = await db(appsTable).select<{ payload: string }[]>('payload');
    const apps = rows
      .map(row => JSON.parse(row.payload) as GovernanceRecord)
      .filter(
        app =>
          app.owner === principal.userEntityRef && app.lifecycle === 'active',
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    const ownership = await options
      .batchCatalogOwnership(apps)
      .catch(() => undefined);
    const gatewayIds = apps.filter(isScorecardGatewayApp).map(app => app.id);
    const issuedKeys = new Set<string>();
    for (let offset = 0; offset < gatewayIds.length; offset += 100) {
      const keys = await db(keysTable)
        .where({ environment: readinessEnvironment })
        .whereIn('app_id', gatewayIds.slice(offset, offset + 100))
        .select<{ app_id: string }[]>('app_id');
      keys.forEach(key => issuedKeys.add(key.app_id));
    }
    const issues = apps.flatMap(app => {
      const checks = scorecardChecks(app, {
        ownership: ownership?.get(app.id),
        issuedKey: issuedKeys.has(app.id),
      })
        .filter(check => check.status === 'attention')
        .map(check => check.name);
      return checks.length ? [{ appId: app.id, checks }] : [];
    });
    res.set('Cache-Control', 'no-store').json({
      issues,
      catalogUnavailable: ownership === undefined,
    });
  });

  router.get('/gateway/models', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });
    const models = config.enabled
      ? Object.entries(config.models)
          .map(([id, policy]) => ({
            id,
            allowedClassifications: policy.allowedClassifications,
            maxCompletionTokens: policy.maxCompletionTokens,
          }))
          .sort((a, b) => a.id.localeCompare(b.id))
      : [];
    res.json({
      enabled: config.enabled,
      productionAvailable: config.enabled && config.mode === 'openai',
      models,
    });
  });

  function checkCatalogOwnership(app: GovernanceRecord) {
    return ownersAreActive(app).catch(() => {
      throw new ServiceUnavailableError(
        'Catalog ownership could not be verified. Retry when the catalog is available.',
      );
    });
  }

  router.get('/apps/:id/gateway-key', async (req, res) => {
    const { principal } = await httpAuth.credentials(req, { allow: ['user'] });
    assertEnabled();
    const { record } = await load(req.params.id);
    assertCanEdit(record, principal);
    const environment =
      requestedKeyEnvironment(req.query.environment) ?? 'sandbox';
    const existing = await db(keysTable)
      .where({ app_id: record.id, environment })
      .first('app_id');
    res.set('Cache-Control', 'no-store').json({ issued: Boolean(existing) });
  });

  router.delete('/apps/:id/gateway-key', async (req, res) => {
    const { principal } = await httpAuth.credentials(req, { allow: ['user'] });
    const environment =
      requestedKeyEnvironment(req.query.environment) ?? 'sandbox';
    await db.transaction(async transaction => {
      const { record } = await load(req.params.id, transaction);
      assertCanEdit(record, principal);
      const deleted = await transaction(keysTable)
        .where({ app_id: record.id, environment })
        .del();
      if (deleted)
        await logGatewayKeyChange(
          transaction,
          record.id,
          principal.userEntityRef,
          'revoked',
          environment,
        );
    });
    res.set('Cache-Control', 'no-store').status(204).end();
  });

  router.post('/apps/:id/gateway-key', async (req, res) => {
    const { principal } = await httpAuth.credentials(req, { allow: ['user'] });
    assertEnabled();
    const { record, revision } = await load(req.params.id);
    assertCanEdit(record, principal);
    assertGatewayAppType(record);
    const environment =
      requestedKeyEnvironment(req.query.environment) ?? 'sandbox';
    if (environment === 'production' && config.mode !== 'openai')
      throw new NotAllowedError(
        'Production gateway keys require a live gateway deployment.',
      );
    if (record.lifecycle === 'retired')
      throw new NotAllowedError('Retired apps cannot issue gateway keys.');
    if (!record.models.some(model => modelPolicy(record, model))) {
      throw new NotAllowedError(
        'Register an approved model for the app’s data classification.',
      );
    }
    if (!(await checkCatalogOwnership(record))) {
      throw new NotAllowedError(
        'Restore active catalog ownership before issuing a gateway key.',
      );
    }

    const key = `gak_${randomBytes(32).toString('base64url')}`;
    const digest = hashKey(key);
    await db.transaction(async transaction => {
      const current = await load(req.params.id, transaction);
      if (current.revision !== revision)
        throw new ConflictError('The app changed. Refresh and try again.');
      if (
        environment === 'production' &&
        (current.record.lifecycle !== 'active' ||
          !meetsLaunchRequirements(current.record))
      )
        throw new NotAllowedError(
          'Production gateway keys require an active app that meets current launch requirements.',
        );
      if (
        current.record.lifecycle === 'active' &&
        current.record.tier === 3 &&
        !meetsLaunchRequirements(current.record)
      )
        throw new NotAllowedError(
          'A current Tier 3 approval is required to issue or rotate a key for an active app.',
        );

      const inserted = await transaction(keysTable)
        .insert({ app_id: record.id, environment, digest })
        .onConflict(['app_id', 'environment'])
        .ignore()
        .returning('app_id');
      if (!inserted.length) {
        await transaction(keysTable)
          .where({ app_id: record.id, environment })
          .update({ digest });
      }
      await logGatewayKeyChange(
        transaction,
        record.id,
        principal.userEntityRef,
        inserted.length ? 'issued' : 'rotated',
        environment,
      );
    });
    res.set('Cache-Control', 'no-store').status(201).json({ key });
  });

  if (config.enabled) {
    httpRouter.addAuthPolicy({ path: chatPath, allow: 'unauthenticated' });
  }
  const parseJson = express.json({ limit: '128kb' });
  router.post(
    chatPath,
    (req, res, next) => {
      parseJson(req, res, error => {
        next(
          error
            ? new InputError('Supply a valid JSON request body.')
            : undefined,
        );
      });
    },
    async (req, res) => {
      assertEnabled();
      const key = /^Bearer (gak_[A-Za-z0-9_-]{43})$/i.exec(
        req.get('authorization') ?? '',
      )?.[1];
      if (!key)
        throw new AuthenticationError(
          'A valid gateway bearer key is required.',
        );
      const digest = hashKey(key);
      const credential = await db<{
        app_id: string;
        environment: KeyEnvironment;
        digest: string;
      }>(keysTable)
        .where({ digest })
        .first('app_id', 'environment');
      if (!credential)
        throw new AuthenticationError(
          'A valid gateway bearer key is required.',
        );
      const { record, revision } = await load(credential.app_id);
      const simulated = credential.environment === 'sandbox';
      const mode: ExecutionMode = simulated ? 'simulation' : 'openai';
      if (!simulated && (config.mode !== 'openai' || !providerKey)) {
        await recordBlock(record.id, 'environment', mode);
        throw new NotAllowedError(
          'Production gateway keys require a live gateway deployment.',
        );
      }

      const parsed = chatInput.safeParse(req.body);
      if (!parsed.success)
        throw new InputError(
          'Supply a model and a prompt of up to 16,000 characters. If set, expectedEnvironment must be sandbox or production.',
        );
      const { model, prompt, expectedEnvironment } = parsed.data;
      if (
        expectedEnvironment &&
        expectedEnvironment !== credential.environment
      ) {
        await recordBlock(record.id, 'key-environment', mode);
        throw new NotAllowedError(
          'The gateway key does not match the requested environment.',
        );
      }
      const policy = modelPolicy(record, model);
      const block = launchBlock(record);
      if (block || !policy) {
        await recordBlock(record.id, block?.reason ?? 'model', mode);
        throw new NotAllowedError(
          block?.message ??
            'The model is unavailable for this app and data classification.',
        );
      }

      if (!(await checkCatalogOwnership(record))) {
        await recordBlock(record.id, 'ownership', mode);
        throw new NotAllowedError(
          'Restore active catalog ownership before calling the gateway.',
        );
      }

      if (await attestationPaused?.(record, db)) {
        await recordBlock(record.id, attestationBlock.reason, mode);
        throw new NotAllowedError(attestationBlock.message);
      }

      const requestsPerMinute = limitFor(record);
      if (requestsPerMinute) {
        const reservation = await reserveGatewayRequest(
          db,
          record.id,
          requestsPerMinute,
        );
        if (!reservation.allowed) {
          await recordBlock(record.id, 'rate-limit', mode);
          res
            .set('Retry-After', String(reservation.retryAfter))
            .set('Cache-Control', 'no-store')
            .status(429)
            .json({
              error: {
                message:
                  'This app reached its gateway rate limit. Retry after the current minute.',
              },
            });
          return;
        }
      }

      // Use the same app lock as key writes and governance updates.
      const finalBlock = await db.transaction(async transaction => {
        const current = await load(record.id, transaction);
        const valid = await transaction(keysTable)
          .where({
            app_id: record.id,
            environment: credential.environment,
            digest,
          })
          .first('app_id');
        if (!valid)
          throw new AuthenticationError(
            'A valid gateway bearer key is required.',
          );
        if (current.revision !== revision)
          throw new ConflictError(
            'The app changed. Retry using the current app policy.',
          );
        const blockAtForwarding = launchBlock(current.record);
        if (blockAtForwarding) return blockAtForwarding;
        if (await attestationPaused?.(current.record, transaction))
          return attestationBlock;
        const spend = appSpendThresholds.get(appSourceKey(record.sourceUrl));
        if (!simulated && spend?.stopAtThreshold) {
          const cost = await monthlyLiveCost(
            transaction,
            record.id,
            currentUtcMonthStart(),
          );
          if (cost >= spend.monthlyUsd) {
            return {
              reason: 'spend-threshold',
              message:
                'This app reached its monthly estimated live spend threshold.',
            };
          }
        }
        return undefined;
      });
      if (finalBlock) {
        await recordBlock(record.id, finalBlock.reason, mode);
        throw new NotAllowedError(finalBlock.message);
      }

      const result =
        providerKey && !simulated
          ? await callOpenai(
              providerKey,
              model,
              prompt,
              policy.maxCompletionTokens,
              failure =>
                logger.warn('Model provider request failed', {
                  appId: record.id,
                  model,
                  ...failure,
                }),
            )
          : simulate(model, prompt);
      await db(usageTable).insert({
        id: randomUUID(),
        app_id: record.id,
        model,
        execution_mode: mode,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        estimated_cost_nanos_usd: estimateCost(
          policy,
          result.inputTokens,
          result.outputTokens,
        ),
        created_at: new Date(),
      });
      res.set('Cache-Control', 'no-store').json({
        output: result.output,
        model,
        simulated,
        ...(result.refused && { refused: true }),
      });
    },
  );

  router.get('/reports/usage', async (req, res) => {
    const { principal } = await httpAuth.credentials(req, { allow: ['user'] });
    if (!isReviewer(principal)) {
      throw new NotAllowedError(
        'Reviewer access is required for the gateway usage report.',
      );
    }
    const days = z
      .enum(['1', '7', '30'])
      .default('30')
      .safeParse(req.query.days);
    if (!days.success)
      throw new InputError('Choose a reporting window of 1, 7, or 30 days.');
    const from = new Date(Date.now() - Number(days.data) * 24 * 60 * 60 * 1000);
    const usage = await db(usageTable)
      .where('created_at', '>=', from)
      .groupBy('app_id', 'model', 'execution_mode')
      .select<Array<UsageTotals & TokenTotals>>(
        'app_id as appId',
        'model',
        'execution_mode as mode',
        db.raw('count(*) as ??', ['calls']),
        db.raw('sum(??) as ??', ['estimated_cost_nanos_usd', 'cost']),
        ...tokenAggregates(db),
      );
    const blocks = await db(blocksTable)
      .where('created_at', '>=', from)
      .groupBy('app_id', 'reason', 'mode')
      .select<
        Array<{
          appId: string;
          reason: string;
          mode: string;
          calls: number | string;
        }>
      >(
        'app_id as appId',
        'reason',
        'mode',
        db.raw('count(*) as ??', ['calls']),
      );
    const retirementCandidates = await readRetirementCandidates(db, appsTable);
    let monthlySpendAlerts;
    if (appSpendThresholds.size > 0) {
      const monthStart = currentUtcMonthStart();
      const monthlyCosts = await db(`${usageTable} as usage`)
        .join(`${appsTable} as app`, 'usage.app_id', 'app.id')
        .where('usage.execution_mode', 'openai')
        .where('usage.created_at', '>=', monthStart)
        .groupBy('usage.app_id', 'app.source_key')
        .select<
          Array<{ appId: string; sourceKey: string; cost: number | string }>
        >(
          'usage.app_id as appId',
          'app.source_key as sourceKey',
          db.raw('sum(??) as ??', ['usage.estimated_cost_nanos_usd', 'cost']),
        );
      monthlySpendAlerts = {
        monthStart: monthStart.toISOString(),
        apps: monthlyCosts.flatMap(row => {
          const threshold = appSpendThresholds.get(appSourceKey(row.sourceKey));
          const liveEstimatedCostUsd = Number(row.cost) / nanosPerDollar;
          if (!threshold || liveEstimatedCostUsd < threshold.monthlyUsd)
            return [];
          return [
            {
              appId: row.appId,
              liveEstimatedCostUsd,
              thresholdUsd: threshold.monthlyUsd,
              stopAtThreshold: threshold.stopAtThreshold,
            },
          ];
        }),
      };
    }
    res.set('Cache-Control', 'no-store').json({
      from: from.toISOString(),
      monthlySpendAlerts,
      retirementReview: {
        days: retirementReviewDays,
        apps: retirementCandidates.map(({ record, lastLiveCall }) => ({
          appId: record.id,
          lastLiveCall,
        })),
      },
      blocks: blocks.map(row => ({ ...row, calls: Number(row.calls) })),
      usage: usage.map(row => ({
        appId: row.appId,
        model: row.model,
        mode: row.mode ?? 'unclassified',
        calls: Number(row.calls),
        estimatedCostUsd: Number(row.cost) / nanosPerDollar,
        tokens:
          Number(row.tokenCalls) > 0
            ? {
                calls: Number(row.tokenCalls),
                input: Number(row.inputTokens),
                output: Number(row.outputTokens),
              }
            : undefined,
      })),
    });
  });

  router.get('/apps/:id/usage', async (req, res) => {
    const { principal } = await httpAuth.credentials(req, { allow: ['user'] });
    const { record } = await load(req.params.id);
    assertCanEdit(record, principal);
    const [usage, blockTotals] = await Promise.all([
      db(usageTable)
        .where({ app_id: record.id })
        .groupBy('execution_mode')
        .select<
          Array<Pick<UsageTotals, 'mode' | 'calls' | 'cost'> & TokenTotals>
        >(
          'execution_mode as mode',
          db.raw('count(*) as ??', ['calls']),
          db.raw('sum(??) as ??', ['estimated_cost_nanos_usd', 'cost']),
          ...tokenAggregates(db),
        ),
      db(blocksTable)
        .where({ app_id: record.id })
        .groupBy('reason')
        .select<Array<{ reason: string; calls: string | number }>>(
          'reason',
          db.raw('count(*) as ??', ['calls']),
        ),
    ]);
    const blocks = blockTotals
      .map(row => ({ reason: row.reason, calls: Number(row.calls) }))
      .sort((a, b) => b.calls - a.calls || a.reason.localeCompare(b.reason));
    const totals = {
      calls: 0,
      estimatedCostUsd: 0,
      liveCalls: 0,
      simulatedCalls: 0,
      unclassifiedCalls: 0,
      liveEstimatedCostUsd: 0,
      liveTokens: { calls: 0, input: 0, output: 0 },
      requestsPerMinute: limitFor(record) ?? null,
      blockedCalls: blocks.reduce((sum, row) => sum + row.calls, 0),
      blocks,
    };
    for (const row of usage) {
      const calls = Number(row.calls ?? 0);
      const estimatedCostUsd = Number(row.cost ?? 0) / nanosPerDollar;
      totals.calls += calls;
      totals.estimatedCostUsd += estimatedCostUsd;
      if (row.mode === 'openai') {
        totals.liveCalls += calls;
        totals.liveEstimatedCostUsd += estimatedCostUsd;
        totals.liveTokens.calls += Number(row.tokenCalls);
        totals.liveTokens.input += Number(row.inputTokens ?? 0);
        totals.liveTokens.output += Number(row.outputTokens ?? 0);
      } else if (row.mode === 'simulation') {
        totals.simulatedCalls += calls;
      } else {
        totals.unclassifiedCalls += calls;
      }
    }
    const spend = appSpendThresholds.get(appSourceKey(record.sourceUrl));
    let monthlySpend;
    if (spend) {
      const monthStart = currentUtcMonthStart();
      monthlySpend = {
        monthStart: monthStart.toISOString(),
        liveEstimatedCostUsd: await monthlyLiveCost(db, record.id, monthStart),
        thresholdUsd: spend.monthlyUsd,
        stopAtThreshold: spend.stopAtThreshold,
      };
    }
    res.set('Cache-Control', 'no-store').json({ ...totals, monthlySpend });
  });
}

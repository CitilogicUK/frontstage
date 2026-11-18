import {
  mockCredentials,
  mockServices,
  startTestBackend,
  TestDatabases,
} from '@backstage/backend-test-utils';
import { CatalogClient } from '@backstage/catalog-client';
import request from 'supertest';
import { governancePlugin } from './plugin';

describe('governance record access', () => {
  const databases = TestDatabases.create({ ids: ['SQLITE_3'] });
  afterEach(() => jest.restoreAllMocks());

  it('enforces evidence, history, and ownership permissions', async () => {
    const owner = 'user:default/owner';
    const backup = 'user:default/backup';
    const reviewer = 'user:default/reviewer';
    const teammate = 'user:default/teammate';
    const evidence = { tests: 'https://example.com/restricted-evidence' };
    const catalog = jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockResolvedValue({
        items: [
          {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'User',
            metadata: { name: 'owner' },
          },
          {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Group',
            metadata: { name: 'platform' },
          },
          {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'User',
            metadata: { name: 'backup' },
          },
        ],
      });
    jest.replaceProperty(process, 'env', {
      ...process.env,
      NODE_ENV: 'development',
    });
    const db = await databases.init('SQLITE_3');
    const { server } = await startTestBackend({
      features: [
        governancePlugin,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: {
            backend: { listen: { host: '127.0.0.1' } },
            governance: {
              reviewers: [reviewer],
              approvedHostedWorkspaces: [
                { provider: 'Example AI', workspace: 'Company' },
              ],
              gateway: {
                enabled: true,
                mode: 'simulation',
                appSpendThresholds: [
                  {
                    sourceUrl: 'https://example.com/runtime-app',
                    monthlyUsd: 20,
                  },
                ],
                models: {
                  'test-model': { allowedClassifications: ['internal'] },
                },
              },
            },
          },
        }),
      ],
    });
    const api = request(server);
    const apps = '/api/governance/apps';
    const auth = (user: string) => mockCredentials.user.header(user);
    const created = await api
      .post(apps)
      .set('Authorization', auth(owner))
      .send({
        name: 'Purchase order pilot',
        purpose: 'Submit synthetic orders',
        type: 'app',
        platform: 'GitHub',
        sourceUrl: 'https://example.com/purchase-orders',
        owner,
        backupOwner: backup,
        team: 'group:default/platform',
        lifecycle: 'experimental',
        audience: 'personal',
        classification: 'restricted',
        usesAiAtRuntime: false,
        deliveryStage: 'pilot',
        evidence,
      })
      .expect(201);

    const path = `${apps}/${created.body.id}`;
    const notes = 'Approval covers the sandbox only.';
    await api
      .post(`${path}/reviews`)
      .set('Authorization', auth(reviewer))
      .send({
        status: 'approved',
        expectedUpdatedAt: created.body.updatedAt,
        notes,
      })
      .expect(200);

    const reviewTicketUrl = 'https://tickets.example.com/review/123';
    const approved = await api
      .get(path)
      .set('Authorization', auth(owner))
      .expect(200);
    const linked = await api
      .put(path)
      .set('Authorization', auth(owner))
      .send({
        ...approved.body,
        reviewTicketUrl,
        expectedUpdatedAt: approved.body.updatedAt,
      })
      .expect(200);
    expect(linked.body).toMatchObject({
      reviewStatus: 'approved',
      reviewTicketUrl,
    });
    for (const user of [owner, backup, reviewer]) {
      const response = await api
        .get(path)
        .set('Authorization', auth(user))
        .expect(200);
      expect(response.body).toMatchObject({
        evidence,
        reviewNotes: notes,
        reviewTicketUrl,
      });
    }

    const unrelated = await api
      .get(path)
      .set('Authorization', auth(teammate))
      .expect(200);
    expect(unrelated.body).toMatchObject({
      deliveryStage: 'pilot',
      reviewStatus: 'approved',
    });
    expect(unrelated.body).not.toHaveProperty('evidence');
    expect(unrelated.body).not.toHaveProperty('reviewTicketUrl');
    expect(unrelated.body).not.toHaveProperty('reviewNotes');
    const list = await api
      .get(apps)
      .set('Authorization', auth(teammate))
      .expect(200);
    expect(list.body.apps).toEqual([unrelated.body]);

    for (const user of [owner, backup, teammate]) {
      await api
        .get(`${path}/history`)
        .set('Authorization', auth(user))
        .expect(403);
    }
    await api
      .get(path)
      .set('Authorization', mockCredentials.none.header())
      .expect(401);
    const history = await api
      .get(`${path}/history`)
      .set('Authorization', auth(reviewer))
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(
      history.body.events.map(
        ({ event }: { event: string }) => JSON.parse(event).action,
      ),
    ).toEqual(['registered', 'reviewed', 'updated']);

    const current = await api
      .get(path)
      .set('Authorization', auth(owner))
      .expect(200);
    await api
      .put(path)
      .set('Authorization', auth(owner))
      .send({
        ...current.body,
        owner: backup,
        backupOwner: owner,
        expectedUpdatedAt: current.body.updatedAt,
      })
      .expect(200);
    await api
      .patch(`${path}/lifecycle`)
      .set('Authorization', auth(owner))
      .send({
        lifecycle: 'deprecated',
      })
      .expect(403);
    await api
      .patch(`${path}/lifecycle`)
      .set('Authorization', auth(backup))
      .send({
        lifecycle: 'deprecated',
      })
      .expect(200);

    catalog.mockResolvedValueOnce({
      items: [
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'User',
          metadata: {
            name: 'backup',
            annotations: { 'governance.backstage.io/active': 'false' },
          },
        },
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Group',
          metadata: { name: 'platform' },
        },
        undefined,
      ],
    });
    const report = '/api/governance/reports/ownership';
    await api.get(report).set('Authorization', auth(teammate)).expect(403);
    const issues = await api
      .get(report)
      .set('Authorization', auth(reviewer))
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(issues.body).toEqual({
      issues: [
        {
          appId: created.body.id,
          name: 'Purchase order pilot',
          unavailable: [backup, owner],
        },
      ],
    });

    catalog.mockResolvedValueOnce({
      items: [
        undefined,
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Group',
          metadata: { name: 'platform' },
        },
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'User',
          metadata: { name: 'owner' },
        },
      ],
    });
    const handoffReport = await api
      .get(report)
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(handoffReport.body.issues).toEqual([
      {
        appId: created.body.id,
        name: 'Purchase order pilot',
        unavailable: [backup],
        availableBackupOwner: owner,
      },
    ]);

    const runtime = await api
      .post(apps)
      .set('Authorization', auth(owner))
      .send({
        name: 'Runtime app',
        purpose: 'Test live ownership checks with simulated model calls',
        type: 'app',
        platform: 'GitHub',
        sourceUrl: 'https://example.com/runtime-app',
        owner,
        backupOwner: backup,
        team: 'group:default/platform',
        audience: 'personal',
        classification: 'internal',
        lifecycle: 'experimental',
        takesActions: true,
        actionDescription: 'Writes to a synthetic sandbox.',
        models: ['test-model'],
      })
      .expect(201);
    const runtimePath = `${apps}/${runtime.body.id}`;
    await api
      .get(`${runtimePath}/scorecard`)
      .set('Authorization', auth(backup))
      .expect(200);
    await api
      .get(`${runtimePath}/scorecard`)
      .set('Authorization', auth(teammate))
      .expect(403);
    const runtimeRow = db('governance_apps').where({ id: runtime.body.id });
    const { payload } = await runtimeRow.clone().first('payload');
    await runtimeRow.clone().update({
      payload: JSON.stringify({ ...JSON.parse(payload), models: [] }),
    });
    const legacyScorecard = await api
      .get(`${runtimePath}/scorecard`)
      .set('Authorization', auth(backup))
      .expect(200);
    expect(legacyScorecard.body.checks).toContainEqual({
      name: 'Gateway model policy',
      status: 'attention',
      detail:
        'Declare at least one approved runtime model before using the gateway.',
    });
    await runtimeRow.update({ payload });
    const approvedRuntime = await api
      .post(`${runtimePath}/reviews`)
      .set('Authorization', auth(reviewer))
      .send({
        status: 'approved',
        notes: 'Sandbox use approved.',
        expectedUpdatedAt: runtime.body.updatedAt,
      })
      .expect(200);
    await api
      .patch(`${runtimePath}/lifecycle`)
      .set('Authorization', auth(owner))
      .send({
        lifecycle: 'retired',
        expectedUpdatedAt: runtime.body.updatedAt,
      })
      .expect(409);
    await api
      .patch(`${runtimePath}/lifecycle`)
      .set('Authorization', auth(owner))
      .send({
        lifecycle: 'active',
        expectedUpdatedAt: approvedRuntime.body.updatedAt,
      })
      .expect(200);
    const keyPath = `${runtimePath}/gateway-key`;
    const issue = () => api.post(keyPath).set('Authorization', auth(owner));
    catalog.mockResolvedValueOnce({ items: [undefined, undefined] });
    await issue().expect(403);
    let {
      body: { key },
    } = await issue().expect(201);
    catalog.mockRejectedValueOnce(new Error('Catalog offline'));
    await issue().expect(503);
    await api
      .get(keyPath)
      .set('Authorization', auth(owner))
      .expect(200, { issued: true });
    const call = () =>
      api
        .post('/api/governance/gateway/chat')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'test-model', prompt: 'Synthetic prompt' });
    catalog.mockResolvedValueOnce({ items: [undefined, undefined] });
    await call().expect(403);
    catalog.mockRejectedValueOnce(new Error('Catalog offline'));
    await call().expect(503);
    await call().expect(200);
    const usage = await api
      .get('/api/governance/reports/usage')
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(usage.body).toMatchObject({
      usage: [{ appId: runtime.body.id, calls: 1 }],
      blocks: [{ appId: runtime.body.id, reason: 'ownership', calls: 1 }],
    });

    const shortWindow = await api
      .get('/api/governance/reports/usage?days=7')
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(
      Date.parse(shortWindow.body.from) - Date.parse(usage.body.from),
    ).toBeGreaterThanOrEqual(23 * 86_400_000);
    await api
      .get('/api/governance/reports/usage?days=90')
      .set('Authorization', auth(reviewer))
      .expect(400);

    const date = new Date();
    const monthStart = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    );
    const recorded = {
      app_id: runtime.body.id,
      model: 'test-model',
      execution_mode: 'openai',
    };
    expect(usage.body.retirementReview).toEqual({ days: 90, apps: [] });
    const oldLiveCall = new Date(+date - 91 * 86_400_000);
    await db('governance_gateway_usage').insert({
      ...recorded,
      id: 'old-live',
      created_at: oldLiveCall,
      estimated_cost_nanos_usd: 0,
    });
    const retirement = await api
      .get('/api/governance/reports/usage?days=1')
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(retirement.body.retirementReview).toEqual({
      days: 90,
      apps: [
        { appId: runtime.body.id, lastLiveCall: oldLiveCall.toISOString() },
      ],
    });

    await db('governance_gateway_usage').insert([
      {
        ...recorded,
        id: 'current-live',
        created_at: monthStart,
        estimated_cost_nanos_usd: 21_500_000_000,
      },
      {
        ...recorded,
        id: 'previous-live',
        created_at: new Date(+monthStart - 1),
        estimated_cost_nanos_usd: 40_000_000_000,
      },
      {
        ...recorded,
        id: 'current-simulation',
        created_at: monthStart,
        execution_mode: 'simulation',
        estimated_cost_nanos_usd: 25_000_000_000,
      },
      {
        ...recorded,
        id: 'other-app-live',
        app_id: created.body.id,
        created_at: monthStart,
        estimated_cost_nanos_usd: 100_000_000_000,
      },
    ]);
    const appUsage = await api
      .get(`${runtimePath}/usage`)
      .set('Authorization', auth(owner))
      .expect(200);
    expect(appUsage.body).toMatchObject({
      liveEstimatedCostUsd: 61.5,
      liveTokens: { calls: 0, input: 0, output: 0 },
      monthlySpend: {
        monthStart: monthStart.toISOString(),
        liveEstimatedCostUsd: 21.5,
        thresholdUsd: 20,
      },
    });
    await api
      .get(`${runtimePath}/usage`)
      .set('Authorization', auth(teammate))
      .expect(403);

    const alerts = await api
      .get('/api/governance/reports/usage?days=1')
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(alerts.body.retirementReview).toEqual({ days: 90, apps: [] });
    const liveScorecard = await api
      .get(`${runtimePath}/scorecard`)
      .set('Authorization', auth(backup))
      .expect(200);
    expect(liveScorecard.body.checks).toContainEqual(
      expect.objectContaining({
        name: 'Recent live gateway activity',
        status: 'pass',
      }),
    );
    expect(alerts.body.monthlySpendAlerts).toEqual({
      monthStart: monthStart.toISOString(),
      apps: [
        {
          appId: runtime.body.id,
          liveEstimatedCostUsd: 21.5,
          thresholdUsd: 20,
        },
      ],
    });

    const activeCatalog = {
      items: [
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'User',
          metadata: { name: 'owner' },
        },
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Group',
          metadata: { name: 'platform' },
        },
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'User',
          metadata: { name: 'backup' },
        },
      ],
    };
    const clock = jest.spyOn(Date, 'now');
    catalog.mockImplementationOnce(async () => {
      clock.mockReturnValue(Date.parse(approvedRuntime.body.nextReview));
      return activeCatalog;
    });
    try {
      const expired = await call().expect(403);
      expect(expired.body.error.message).toMatch(/review|approval/i);
    } finally {
      clock.mockRestore();
    }

    catalog.mockImplementationOnce(async () => {
      await api
        .patch(`${runtimePath}/lifecycle`)
        .set('Authorization', auth(owner))
        .send({ lifecycle: 'deprecated' })
        .expect(200);
      return activeCatalog;
    });
    await call().expect(409);
    await api
      .patch(`${runtimePath}/lifecycle`)
      .set('Authorization', auth(owner))
      .send({ lifecycle: 'active' })
      .expect(200);

    catalog.mockImplementationOnce(async () => {
      await api.delete(keyPath).set('Authorization', auth(owner)).expect(204);
      return activeCatalog;
    });
    await call().expect(401);
    ({
      body: { key },
    } = await issue().expect(201));
    catalog.mockRestore();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(ms => timeout(ms === 5_000 ? 10 : ms));
    const transport = jest.spyOn(globalThis, 'fetch').mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('Missing catalog deadline'));
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    await call().expect(503);
    expect(deadline).toHaveBeenCalledWith(5_000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);

    transport.mockRestore();
    deadline.mockRestore();
    jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockImplementationOnce(async () => {
        await api
          .patch(`${runtimePath}/lifecycle`)
          .set('Authorization', auth(owner))
          .send({ lifecycle: 'retired' })
          .expect(200);
        return activeCatalog;
      });
    await issue().expect(409);
    await api
      .get(keyPath)
      .set('Authorization', auth(owner))
      .expect(200, { issued: false });
    await call().expect(401);
    const retired = await api
      .get(runtimePath)
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(retired.body.lifecycle).toBe('retired');
    await api
      .post(`${runtimePath}/reviews`)
      .set('Authorization', auth(reviewer))
      .send({
        status: 'approved',
        notes: 'Attempt to review a retired app.',
        expectedUpdatedAt: retired.body.updatedAt,
      })
      .expect(400);
    jest.spyOn(CatalogClient.prototype, 'getEntitiesByRefs').mockResolvedValue({
      items: activeCatalog.items.slice(0, 2),
    });
    await api
      .post('/api/governance/tier-preview')
      .set('Authorization', auth(owner))
      .send({
        audience: 'personal',
        classification: 'internal',
        hosted: { sharing: 'private', dataClassification: 'restricted' },
      })
      .expect(200, { tier: 3, effectiveClassification: 'restricted' });
    const hostedRecords = [];
    for (const workspace of ['Company', 'Personal']) {
      const hosted = await api
        .post(apps)
        .set('Authorization', auth(owner))
        .send({
          name: `Hosted ${workspace} app`,
          purpose: 'Check the declared workspace.',
          type: 'provider-hosted app',
          platform: 'Hosted workspace & tools',
          sourceUrl: `https://example.com/hosted-${workspace}`,
          owner,
          team: 'group:default/platform',
          lifecycle: 'experimental',
          audience: 'personal',
          classification: 'internal',
          models: ['test-model'],
          hosted: {
            provider: 'Example AI',
            workspace,
            sharing: 'private',
            dataAccess: 'none',
          },
        })
        .expect(201);
      hostedRecords.push(hosted.body);
      const scorecard = await api
        .get(`${apps}/${hosted.body.id}/scorecard`)
        .set('Authorization', auth(owner))
        .expect(200);
      expect(scorecard.body.checks).toContainEqual(
        expect.objectContaining({
          name: 'Declared provider workspace',
          status: workspace === 'Company' ? 'pass' : 'attention',
        }),
      );
      await api
        .patch(`${apps}/${hosted.body.id}/lifecycle`)
        .set('Authorization', auth(owner))
        .send({ lifecycle: 'active', expectedUpdatedAt: hosted.body.updatedAt })
        .expect(workspace === 'Company' ? 200 : 400);
    }
    const personal = hostedRecords[1];
    const workspaceReport = '/api/governance/reports/hosted-workspaces';
    await api
      .get(workspaceReport)
      .set('Authorization', auth(owner))
      .expect(403);
    await api
      .get(workspaceReport)
      .set('Authorization', auth(reviewer))
      .expect(200, {
        configured: true,
        issues: [
          {
            appId: personal.id,
            name: personal.name,
            lifecycle: 'experimental',
            provider: 'Example AI',
            workspace: 'Personal',
          },
        ],
      });
    const corrected = await api
      .put(`${apps}/${personal.id}`)
      .set('Authorization', auth(owner))
      .send({
        ...personal,
        hosted: { ...personal.hosted, workspace: 'Company' },
        expectedUpdatedAt: personal.updatedAt,
      })
      .expect(200);
    const activated = await api
      .patch(`${apps}/${personal.id}/lifecycle`)
      .set('Authorization', auth(owner))
      .send({
        lifecycle: 'active',
        expectedUpdatedAt: corrected.body.updatedAt,
      })
      .expect(200);
    jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockResolvedValueOnce(activeCatalog);
    const shared = await api
      .put(`${apps}/${personal.id}`)
      .set('Authorization', auth(owner))
      .send({
        ...activated.body,
        backupOwner: backup,
        hosted: { ...activated.body.hosted, sharing: 'public link' },
        expectedUpdatedAt: activated.body.updatedAt,
      })
      .expect(200);
    expect(shared.body).toMatchObject({
      tier: 3,
      lifecycle: 'experimental',
      reviewStatus: 'pending',
    });
    await api
      .get(workspaceReport)
      .set('Authorization', auth(reviewer))
      .expect(200, {
        configured: true,
        issues: [],
      });
  });
  it('blocks new live requests once recorded spend reaches an enforced threshold', async () => {
    const owner = 'user:default/owner';
    const sourceUrl = 'https://example.com/budgeted-app';
    const catalog = jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockResolvedValue({
        items: [
          {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'User',
            metadata: { name: 'owner' },
          },
          {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Group',
            metadata: { name: 'platform' },
          },
        ],
      });
    const provider = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({
          choices: [{ message: { content: 'Synthetic completion' } }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }),
      );
    const { server } = await startTestBackend({
      features: [
        governancePlugin,
        mockServices.rootConfig.factory({
          data: {
            governance: {
              gateway: {
                enabled: true,
                mode: 'openai',
                openaiApiKey: 'test-provider-key',
                models: {
                  'test-model': {
                    allowedClassifications: ['internal'],
                    inputUsdPerMillionTokens: 1_000_000,
                    maxCompletionTokens: 128,
                  },
                },
                appSpendThresholds: [
                  { sourceUrl, monthlyUsd: 1, stopAtThreshold: true },
                ],
              },
            },
          },
        }),
      ],
    });
    const api = request(server);
    const auth = mockCredentials.user.header(owner);
    const registration = {
      name: 'Budgeted app',
      purpose: 'Verify monthly stop policy',
      type: 'app',
      platform: 'GitHub',
      sourceUrl,
      owner,
      team: 'group:default/platform',
      audience: 'personal',
      classification: 'internal',
      lifecycle: 'active',
      models: ['test-model'],
    };
    const descriptor = JSON.stringify({
      apiVersion: 'governance.backstage.io/v1alpha1',
      kind: 'AIApp',
      spec: registration,
    });
    const importApi = '/api/governance/imports';
    const service = mockCredentials.service.header();
    await api
      .post('/api/governance/repository?dryRun=true')
      .set('Authorization', auth)
      .send({ content: descriptor })
      .expect(200, {
        apps: [
          {
            name: 'Budgeted app',
            tier: 1,
            usesAiAtRuntime: true,
            effectiveClassification: 'internal',
            owner,
            team: registration.team,
          },
        ],
      });
    await api
      .post('/api/governance/repository?dryRun=true')
      .set('Authorization', auth)
      .send({
        content: JSON.stringify({
          ...JSON.parse(descriptor),
          spec: {
            ...registration,
            models: [],
            usesAiAtRuntime: false,
            deliveryStage: 'poc',
          },
        }),
      })
      .expect(200, {
        apps: [
          {
            name: 'Budgeted app',
            tier: 1,
            usesAiAtRuntime: false,
            effectiveClassification: 'internal',
            owner,
            team: registration.team,
            deliveryStage: 'poc',
          },
        ],
      });
    await api
      .post(`${importApi}?dryRun=true`)
      .set('Authorization', auth)
      .send({ apps: [registration] })
      .expect(403);
    await api
      .post(`${importApi}?dryRun=true`)
      .set('Authorization', service)
      .send({ apps: [registration] })
      .expect(200, {
        apps: [
          {
            name: 'Budgeted app',
            tier: 1,
            usesAiAtRuntime: true,
            effectiveClassification: 'internal',
            owner,
            team: registration.team,
          },
        ],
      });
    await api
      .post(`${importApi}?dryRun=typo`)
      .set('Authorization', service)
      .send({ apps: [registration] })
      .expect(400);
    const secondApp = {
      ...registration,
      name: 'Second app',
      sourceUrl: 'https://example.com/second-app',
    };
    catalog.mockClear();
    await api
      .post(`${importApi}?dryRun=true`)
      .set('Authorization', service)
      .send({ apps: [registration, secondApp] })
      .expect(200, {
        apps: [
          {
            name: 'Budgeted app',
            tier: 1,
            usesAiAtRuntime: true,
            effectiveClassification: 'internal',
            owner,
            team: registration.team,
          },
          {
            name: 'Second app',
            tier: 1,
            usesAiAtRuntime: true,
            effectiveClassification: 'internal',
            owner,
            team: registration.team,
          },
        ],
      });
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(catalog.mock.calls[0][0]).toEqual({
      entityRefs: [owner, registration.team],
    });
    const activeEntities = await catalog.mock.results[0].value;
    catalog.mockResolvedValueOnce({
      items: [...activeEntities.items, undefined],
    });
    const invalidRows = await api
      .post(`${importApi}?dryRun=true`)
      .set('Authorization', service)
      .send({
        apps: [
          registration,
          { ...secondApp, classification: 'unknown' },
          { ...secondApp, owner: 'user:default/missing' },
        ],
      })
      .expect(400);
    expect(invalidRows.body.error.message.split('\n')).toEqual([
      expect.stringContaining('App 2: classification'),
      expect.stringContaining('App 3: Choose active owners'),
    ]);
    const beforeImport = await api
      .get('/api/governance/apps')
      .set('Authorization', auth)
      .expect(200);
    expect(beforeImport.body.apps).toEqual([]);
    const app = await api
      .post('/api/governance/apps')
      .set('Authorization', auth)
      .send(registration)
      .expect(201);
    const duplicates = await api
      .post(`${importApi}?dryRun=true`)
      .set('Authorization', service)
      .send({
        apps: [
          registration,
          secondApp,
          { ...secondApp, sourceUrl: 'https://EXAMPLE.COM/second-app' },
        ],
      })
      .expect(409);
    expect(duplicates.body.error.message.split('\n')).toEqual([
      'App 1: Source URL is already registered.',
      'App 3: Source URL also appears in App 2.',
    ]);
    const path = `/api/governance/apps/${app.body.id}`;
    const issued = await api
      .post(`${path}/gateway-key`)
      .set('Authorization', auth)
      .expect(201);
    const call = () =>
      api
        .post('/api/governance/gateway/chat')
        .set('Authorization', `Bearer ${issued.body.key}`)
        .send({ model: 'test-model', prompt: 'Synthetic prompt' });
    await call().expect(200);
    await call().expect(403);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(provider.mock.calls[0][1]?.body))).toMatchObject({
      max_completion_tokens: 128,
    });

    const usage = await api
      .get(`${path}/usage`)
      .set('Authorization', auth)
      .expect(200);
    expect(usage.body).toMatchObject({
      liveCalls: 1,
      liveTokens: { calls: 1, input: 1, output: 2 },
      monthlySpend: {
        liveEstimatedCostUsd: 1,
        thresholdUsd: 1,
        stopAtThreshold: true,
      },
      blocks: [{ reason: 'spend-threshold', calls: 1 }],
    });
  });
});

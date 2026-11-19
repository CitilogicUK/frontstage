import type { SchedulerService } from '@backstage/backend-plugin-api';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
  TestDatabases,
} from '@backstage/backend-test-utils';
import { CatalogClient } from '@backstage/catalog-client';
import request from 'supertest';
import { stringify } from 'yaml';
import { governancePlugin } from './plugin';

describe('governance record access', () => {
  const databases = TestDatabases.create({ ids: ['SQLITE_3'] });
  afterEach(() => jest.restoreAllMocks());

  it('lists explicitly published apps with current launch approval and protects publication state', async () => {
    const owner = 'user:default/owner';
    const backup = 'user:default/backup';
    const reviewer = 'user:default/reviewer';
    const teammate = 'user:default/teammate';
    const inactive = new Set<string>();
    jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockImplementation(async ({ entityRefs }) => ({
        items: entityRefs.map(ref => ({
          apiVersion: 'backstage.io/v1alpha1',
          kind: ref.startsWith('group:') ? 'Group' : 'User',
          metadata: {
            name: ref.split('/')[1],
            annotations: inactive.has(ref)
              ? { 'governance.backstage.io/active': 'false' }
              : undefined,
          },
        })),
      }));
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
                { provider: 'Example AI', workspace: 'Approved workspace' },
              ],
              gateway: {
                enabled: true,
                mode: 'simulation',
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
    const auth = (user: string) => mockCredentials.user.header(user);
    const directoryPath = '/api/governance/directory';
    const collection = '/api/governance/apps';
    const list = () =>
      api.get(directoryPath).set('Authorization', auth(teammate));
    const appInput = {
      name: 'Staff assistant',
      purpose: 'Help staff with a vetted workflow.',
      type: 'assistant',
      platform: 'GitHub',
      sourceUrl: 'https://example.com/source',
      owner,
      backupOwner: backup,
      team: 'group:default/operations',
      lifecycle: 'experimental',
      audience: 'external',
      classification: 'internal',
      models: ['test-model'],
    };
    const { body: app } = await api
      .post(collection)
      .set('Authorization', auth(owner))
      .send(appInput)
      .expect(201);
    const path = `${collection}/${app.id}`;
    const publishPath = `${path}/directory`;
    const summary = 'Get help with the staff workflow.';
    const url = 'https://tools.example.com/assistant?view=start#ready';
    const listing = { summary, url };
    const publish = (
      expectedUpdatedAt: string,
      actor = owner,
      changes: { summary?: string; url?: string } = {},
    ) =>
      api
        .put(publishPath)
        .set('Authorization', auth(actor))
        .send({ ...listing, ...changes, expectedUpdatedAt });
    const unpublish = (expectedUpdatedAt: string, actor = owner) =>
      api
        .delete(publishPath)
        .set('Authorization', auth(actor))
        .send({ expectedUpdatedAt });
    const review = (expectedUpdatedAt: string, status = 'approved') =>
      api
        .post(`${path}/reviews`)
        .set('Authorization', auth(reviewer))
        .send({ expectedUpdatedAt, status, notes: 'Reviewed for publication.' })
        .expect(200);
    const setLifecycle = (lifecycle: string, expectedUpdatedAt: string) =>
      api
        .patch(`${path}/lifecycle`)
        .set('Authorization', auth(owner))
        .send({ lifecycle, expectedUpdatedAt })
        .expect(200);

    await api
      .get(directoryPath)
      .set('Authorization', mockCredentials.none.header())
      .expect(401);
    await api
      .get(directoryPath)
      .set('Authorization', mockCredentials.service.header())
      .expect(403);
    await list().expect('Cache-Control', 'no-store').expect(200, { apps: [] });
    await publish(app.updatedAt).expect(400);

    const approved = await review(app.updatedAt);
    const activation = await setLifecycle('active', approved.body.updatedAt);
    const before = activation.body.updatedAt;
    await list().expect(200, { apps: [] });
    await publish(before, backup).expect(403);
    await publish(before, teammate).expect(403);
    await publish(approved.body.updatedAt).expect(409);
    for (const changes of [
      { summary: '   ' },
      { summary: 'x'.repeat(501) },
      { url: 'http://tools.example.com/assistant' },
      { url: `https://tools.example.com/${'x'.repeat(2048)}` },
      { url: 'https://example:secret@tools.example.com/assistant' },
    ]) {
      await publish(before, owner, changes).expect(400);
    }

    const published = await publish(before, owner, {
      summary: `  ${summary}  `,
    }).expect(200);
    expect(published.body.directoryListing).toEqual(listing);
    expect(published.body.directoryLaunchEligible).toBe(true);
    await list().expect(200, {
      apps: [{ id: app.id, name: app.name, ...listing }],
    });
    for (const principal of [
      mockCredentials.user.header(backup),
      auth(teammate),
      mockCredentials.service.header(),
    ]) {
      const { body } = await api
        .get(path)
        .set('Authorization', principal)
        .expect(200);
      expect(body).not.toHaveProperty('directoryListing');
      expect(body).not.toHaveProperty('directoryLaunchEligible');
    }
    const { body: reviewerView } = await api
      .get(path)
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(reviewerView.directoryListing).toEqual(listing);

    const {
      body: { key },
    } = await api
      .post(`${path}/gateway-key`)
      .set('Authorization', auth(owner))
      .expect(201);
    const edited = await publish(published.body.updatedAt, reviewer, {
      summary: 'Revised launch instructions.',
    }).expect(200);
    expect(edited.body.directoryListing.summary).toBe(
      'Revised launch instructions.',
    );
    await unpublish(edited.body.updatedAt, teammate).expect(403);
    await unpublish(published.body.updatedAt).expect(409);
    await api
      .post('/api/governance/gateway/chat')
      .set('Authorization', `Bearer ${key}`)
      .send({ model: 'test-model', prompt: 'Check access after publishing.' })
      .expect(200);

    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(approved.body.nextReview));
    await list().expect(200, { apps: [] });
    await publish(edited.body.updatedAt).expect(400);
    const removed = await unpublish(edited.body.updatedAt, reviewer).expect(
      200,
    );
    expect(removed.body).not.toHaveProperty('directoryListing');

    const renewed = await review(removed.body.updatedAt);
    const republished = await publish(renewed.body.updatedAt).expect(200);
    const paused = await setLifecycle('deprecated', republished.body.updatedAt);
    expect(paused.body).not.toHaveProperty('directoryListing');
    const restarted = await setLifecycle('active', paused.body.updatedAt);
    await list().expect(200, { apps: [] });
    const afterRestart = await publish(restarted.body.updatedAt).expect(200);
    const rejected = await review(
      afterRestart.body.updatedAt,
      'changes needed',
    );
    expect(rejected.body.lifecycle).toBe('experimental');
    expect(rejected.body).not.toHaveProperty('directoryListing');
    await list().expect(200, { apps: [] });
    clock.mockRestore();

    const personalInput = {
      ...appInput,
      audience: 'personal',
      lifecycle: 'active',
      sourceUrl: 'https://example.com/personal-assistant',
    };
    const { body: personalApp } = await api
      .post(collection)
      .set('Authorization', auth(owner))
      .send(personalInput)
      .expect(201);
    const personalPath = `${collection}/${personalApp.id}`;
    const publicPersonal = await api
      .put(`${personalPath}/directory`)
      .set('Authorization', auth(owner))
      .send({ ...listing, expectedUpdatedAt: personalApp.updatedAt })
      .expect(200);
    inactive.add(owner);
    await list().expect(200, { apps: [] });
    await api
      .put(`${personalPath}/directory`)
      .set('Authorization', auth(reviewer))
      .send({ ...listing, expectedUpdatedAt: publicPersonal.body.updatedAt })
      .expect(400);
    inactive.delete(owner);
    await list().expect(200, {
      apps: [{ id: personalApp.id, name: personalApp.name, ...listing }],
    });
    const transferred = await api
      .put(personalPath)
      .set('Authorization', auth(owner))
      .send({
        ...personalInput,
        owner: teammate,
        expectedUpdatedAt: publicPersonal.body.updatedAt,
      })
      .expect(200);
    expect(transferred.body.lifecycle).toBe('active');
    expect(transferred.body).not.toHaveProperty('directoryListing');
    await list().expect(200, { apps: [] });

    const { body: hosted } = await api
      .post(collection)
      .set('Authorization', auth(owner))
      .send({
        ...appInput,
        audience: 'personal',
        type: 'provider-hosted app',
        sourceUrl: 'https://example.com/hosted-assistant',
        hosted: {
          provider: 'Example AI',
          workspace: 'Previously approved workspace',
          sharing: 'private',
          dataAccess: 'none',
        },
      })
      .expect(201);
    // Represent an existing publication whose workspace was removed from policy.
    await db('governance_apps')
      .where({ id: hosted.id })
      .update({
        payload: JSON.stringify({
          ...hosted,
          lifecycle: 'active',
          directoryListing: listing,
        }),
      });
    await list().expect(200, { apps: [] });
    await api
      .get(`${collection}/${hosted.id}`)
      .set('Authorization', auth(owner))
      .expect(200)
      .expect(({ body }) => {
        expect(body.directoryLaunchEligible).toBe(false);
        expect(body.directoryListing).toEqual(listing);
      });
    await api
      .put(`${collection}/${hosted.id}/directory`)
      .set('Authorization', auth(owner))
      .send({ ...listing, expectedUpdatedAt: hosted.updatedAt })
      .expect(400);
    await api
      .delete(`${collection}/${hosted.id}/directory`)
      .set('Authorization', auth(owner))
      .send({ expectedUpdatedAt: hosted.updatedAt })
      .expect(200);

    const { body: history } = await api
      .get(`${path}/history`)
      .set('Authorization', auth(reviewer))
      .expect(200);
    const events = history.events.map((item: { event: string }) =>
      JSON.parse(item.event),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'directory-published',
          actor: owner,
          record: expect.objectContaining({ directoryListing: listing }),
        }),
        expect.objectContaining({
          action: 'directory-unpublished',
          actor: reviewer,
          record: expect.not.objectContaining({
            directoryListing: expect.anything(),
          }),
        }),
      ]),
    );
  });

  const approvedConnector = {
    id: 'catalog-lookup',
    name: 'Catalog lookup',
    kind: 'mcp',
    description: 'Read service ownership from the catalog.',
    access: 'read',
    maxClassification: 'internal',
    docsUrl: 'https://docs.example.com/catalog-lookup',
  };

  it.each([
    { state: 'unconfigured', config: {}, connectors: [], configured: false },
    {
      state: 'configured but empty',
      config: { approvedConnectors: [] },
      connectors: [],
      configured: true,
    },
    {
      state: 'configured with approved connectors',
      config: { approvedConnectors: [approvedConnector] },
      connectors: [approvedConnector],
      configured: true,
    },
  ])(
    'serves the $state connector registry to signed-in users',
    async ({ config, configured, connectors }) => {
      const db = await databases.init('SQLITE_3');
      const { server } = await startTestBackend({
        features: [
          governancePlugin,
          mockServices.database.factory({ knex: db }),
          mockServices.rootConfig.factory({ data: { governance: config } }),
        ],
      });
      const path = '/api/governance/approved-connectors';
      await request(server)
        .get(path)
        .set('Authorization', mockCredentials.none.header())
        .expect(401);
      await request(server)
        .get(path)
        .set('Authorization', mockCredentials.service.header())
        .expect(403);
      await request(server)
        .get(path)
        .set('Authorization', mockCredentials.user.header())
        .expect('Cache-Control', 'no-store')
        .expect(200, { configured, connectors });
    },
  );

  it.each([undefined, []])(
    'disables engineering handoffs when groups are %j',
    async groups => {
      const db = await databases.init('SQLITE_3');
      const { server } = await startTestBackend({
        features: [
          governancePlugin,
          mockServices.database.factory({ knex: db }),
          mockServices.rootConfig.factory({
            data: { governance: { graduationGroups: groups } },
          }),
        ],
      });
      const { body } = await request(server)
        .get('/api/governance/apps')
        .set('Authorization', mockCredentials.user.header())
        .expect(200);
      expect(body.graduationEnabled).toBe(false);
    },
  );

  it('limits engineering handoffs to eligible nominees for Tier 3 production apps', async () => {
    const owner = 'user:default/owner';
    const backup = 'user:default/backup';
    const engineer = 'user:default/engineer';
    const outside = 'user:default/outside';
    const reviewer = 'user:default/reviewer';
    const group = 'group:default/engineering';
    let membership = group;
    let activeGroup = true;
    let activeEngineer = true;
    jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockImplementation(async ({ entityRefs }) => ({
        items: entityRefs.map(ref => ({
          apiVersion: 'backstage.io/v1alpha1',
          kind: ref.startsWith('group:') ? 'Group' : 'User',
          metadata: {
            name: ref.split('/')[1],
            annotations: {
              'governance.backstage.io/active':
                (ref !== group || activeGroup) &&
                (ref !== engineer || activeEngineer)
                  ? 'true'
                  : 'false',
            },
          },
          relations: [
            ...(ref === engineer || ref === reviewer
              ? [{ type: 'memberOf', targetRef: membership }]
              : []),
            ...(ref === outside
              ? [{ type: 'memberOf', targetRef: 'group:default/subteam' }]
              : []),
          ],
        })),
      }));
    const db = await databases.init('SQLITE_3');
    const { server } = await startTestBackend({
      features: [
        governancePlugin,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: {
            governance: {
              reviewers: [reviewer],
              graduationGroups: [group],
            },
          },
        }),
      ],
    });
    const api = request(server);
    const auth = (user: string) => mockCredentials.user.header(user);
    const collection = '/api/governance/apps';
    const appInput = {
      name: 'Customer workflow',
      purpose: 'Provide a production customer workflow',
      type: 'app',
      platform: 'GitHub',
      sourceUrl: 'https://example.com/customer-workflow',
      owner,
      backupOwner: backup,
      team: 'group:default/platform',
      lifecycle: 'experimental',
      audience: 'external',
      classification: 'internal',
      usesAiAtRuntime: false,
      deliveryStage: 'pilot',
      evidence: { tests: 'https://example.com/limited-evidence' },
    };
    const created = await api
      .post(collection)
      .set('Authorization', auth(owner))
      .send(appInput)
      .expect(201);
    const appPath = `${collection}/${created.body.id}`;
    const route = `${appPath}/graduation`;
    const getApp = (as: string) =>
      api.get(appPath).set('Authorization', auth(as)).expect(200);
    const nominate = (
      nominee: string,
      expectedUpdatedAt: string,
      actor = owner,
    ) =>
      api
        .post(route)
        .set('Authorization', auth(actor))
        .send({ nominee, expectedUpdatedAt });
    const decide = (
      decision: 'accept' | 'decline',
      expectedUpdatedAt: string,
      actor = engineer,
      reason?: string,
    ) =>
      api
        .patch(route)
        .set('Authorization', auth(actor))
        .send({ decision, expectedUpdatedAt, reason });
    const edit = (
      changes: Record<string, unknown>,
      expectedUpdatedAt: string,
      actor = owner,
    ) =>
      api
        .put(appPath)
        .set('Authorization', auth(actor))
        .send({ ...appInput, ...changes, expectedUpdatedAt });

    await api
      .get(collection)
      .set('Authorization', auth(engineer))
      .expect(200)
      .expect(({ body }) => expect(body.graduationEnabled).toBe(true));
    await nominate(engineer, created.body.updatedAt).expect(400);
    const production = await edit(
      { deliveryStage: 'production' },
      created.body.updatedAt,
    ).expect(200);
    const before = production.body.updatedAt;
    await nominate(engineer, before, outside).expect(403);
    await nominate(engineer, created.body.updatedAt).expect(409);
    await nominate(owner, before).expect(400);
    await nominate(outside, before).expect(400);
    activeGroup = false;
    await nominate(engineer, before).expect(400);
    activeGroup = true;
    activeEngineer = false;
    await nominate(engineer, before).expect(400);
    activeEngineer = true;

    const cancel = (expectedUpdatedAt: string, actor = owner) =>
      api
        .delete(route)
        .set('Authorization', auth(actor))
        .send({ expectedUpdatedAt });
    await cancel(before).expect(409);
    const abandoned = await nominate(engineer, before).expect(200);
    await cancel(before).expect(409);
    await cancel(abandoned.body.updatedAt, engineer).expect(403);
    activeEngineer = false;
    const cancelled = await cancel(abandoned.body.updatedAt, reviewer).expect(
      200,
    );
    expect(cancelled.body).not.toHaveProperty('graduation');
    expect((await getApp(engineer)).body).not.toHaveProperty('graduation');
    await decide('accept', cancelled.body.updatedAt).expect(403);
    activeEngineer = true;

    const proposed = await nominate(engineer, cancelled.body.updatedAt).expect(
      200,
    );
    expect(proposed.body).toMatchObject({
      owner,
      lifecycle: 'experimental',
      reviewStatus: 'pending',
      graduation: { nominee: engineer, requestedBy: owner, status: 'pending' },
    });
    expect((await getApp(outside)).body).not.toHaveProperty('graduation');
    expect((await getApp(backup)).body.graduation).toEqual(
      proposed.body.graduation,
    );
    const nomineeRecord = (await getApp(engineer)).body;
    expect(nomineeRecord.graduation).toEqual(proposed.body.graduation);
    expect(nomineeRecord).not.toHaveProperty('evidence');
    await api
      .get(appPath)
      .set('Authorization', mockCredentials.service.header())
      .expect(200)
      .expect(({ body }) => expect(body).not.toHaveProperty('graduation'));
    await edit(
      { deliveryStage: 'production' },
      proposed.body.updatedAt,
      engineer,
    ).expect(403);
    await nominate(engineer, proposed.body.updatedAt, reviewer).expect(409);
    await decide('accept', proposed.body.updatedAt, owner).expect(403);
    await decide('accept', before).expect(409);

    membership = 'group:default/subteam';
    await decide('accept', proposed.body.updatedAt).expect(400);
    const declined = await decide(
      'decline',
      proposed.body.updatedAt,
      engineer,
      '  Not available  ',
    ).expect(200);
    expect(declined.body.graduation).toMatchObject({
      status: 'declined',
      reason: 'Not available',
    });
    membership = group;
    const reproposed = await nominate(
      engineer,
      declined.body.updatedAt,
      reviewer,
    ).expect(200);
    const accepted = await decide('accept', reproposed.body.updatedAt).expect(
      200,
    );
    expect(accepted.body).toMatchObject({
      owner,
      lifecycle: 'experimental',
      reviewStatus: 'pending',
      graduation: {
        nominee: engineer,
        requestedBy: reviewer,
        status: 'accepted',
      },
    });
    await nominate(outside, accepted.body.updatedAt).expect(409);
    await cancel(accepted.body.updatedAt).expect(409);

    const renamed = await edit(
      { name: 'Renamed workflow', deliveryStage: 'production' },
      accepted.body.updatedAt,
    ).expect(200);
    expect(renamed.body.graduation).toEqual(accepted.body.graduation);
    const reverted = await edit(
      { deliveryStage: 'pilot' },
      renamed.body.updatedAt,
    ).expect(200);
    expect(reverted.body).not.toHaveProperty('graduation');
    const productionAgain = await edit(
      { deliveryStage: 'production' },
      reverted.body.updatedAt,
    ).expect(200);
    const pendingTransfer = await nominate(
      engineer,
      productionAgain.body.updatedAt,
    ).expect(200);
    const transferred = await edit(
      { owner: outside, deliveryStage: 'production' },
      pendingTransfer.body.updatedAt,
    ).expect(200);
    expect(transferred.body).not.toHaveProperty('graduation');
    const pendingDowngrade = await nominate(
      engineer,
      transferred.body.updatedAt,
      reviewer,
    ).expect(200);
    const downgraded = await edit(
      { owner: outside, audience: 'team', deliveryStage: 'production' },
      pendingDowngrade.body.updatedAt,
      outside,
    ).expect(200);
    expect(downgraded.body.tier).toBe(2);
    expect(downgraded.body).not.toHaveProperty('graduation');
    const escalated = await edit(
      { owner: outside, deliveryStage: 'production' },
      downgraded.body.updatedAt,
      outside,
    ).expect(200);
    const pendingRetirement = await nominate(
      engineer,
      escalated.body.updatedAt,
      reviewer,
    ).expect(200);
    const retired = await api
      .patch(`${appPath}/lifecycle`)
      .set('Authorization', auth(outside))
      .send({
        lifecycle: 'retired',
        expectedUpdatedAt: pendingRetirement.body.updatedAt,
      })
      .expect(200);
    expect(retired.body).not.toHaveProperty('graduation');

    const { body: history } = await api
      .get(`${appPath}/history`)
      .set('Authorization', auth(reviewer))
      .expect(200);
    const events = history.events.map((item: { event: string }) =>
      JSON.parse(item.event),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'graduation-requested',
          actor: owner,
          record: expect.objectContaining({
            graduation: proposed.body.graduation,
          }),
        }),
        expect.objectContaining({
          action: 'graduation-cancelled',
          actor: reviewer,
          graduationNominee: engineer,
          record: expect.not.objectContaining({
            graduation: expect.anything(),
          }),
        }),
        expect.objectContaining({
          action: 'graduation-declined',
          actor: engineer,
          record: expect.objectContaining({
            graduation: declined.body.graduation,
          }),
        }),
        expect.objectContaining({
          action: 'graduation-accepted',
          actor: engineer,
          record: expect.objectContaining({
            graduation: accepted.body.graduation,
          }),
        }),
      ]),
    );

    const second = await api
      .post(collection)
      .set('Authorization', auth(owner))
      .send({
        ...appInput,
        sourceUrl: 'https://example.com/reviewer-handoff',
        deliveryStage: 'production',
      })
      .expect(201);
    const secondPath = `${collection}/${second.body.id}`;
    const nomination = await api
      .post(`${secondPath}/graduation`)
      .set('Authorization', auth(owner))
      .send({ nominee: reviewer, expectedUpdatedAt: second.body.updatedAt })
      .expect(200);
    const handoff = await api
      .patch(`${secondPath}/graduation`)
      .set('Authorization', auth(reviewer))
      .send({
        decision: 'accept',
        expectedUpdatedAt: nomination.body.updatedAt,
      })
      .expect(200);
    await api
      .post(`${secondPath}/reviews`)
      .set('Authorization', auth(reviewer))
      .send({
        status: 'approved',
        notes: 'Review by the accepted co-owner.',
        expectedUpdatedAt: handoff.body.updatedAt,
      })
      .expect(403);
    await api
      .post(`${secondPath}/renewal-exception`)
      .set('Authorization', auth(reviewer))
      .send({
        reason: 'Exception by the accepted co-owner.',
        expiresAt: '2030-01-01T00:00:00.000Z',
        expectedUpdatedAt: handoff.body.updatedAt,
      })
      .expect(403);
  });

  it('previews a matching discovered descriptor without writing or exposing GitHub credentials', async () => {
    const reviewer = 'user:default/reviewer';
    const owner = 'user:default/owner';
    const token = 'test-github-token';
    const db = await databases.init('SQLITE_3');
    const { server } = await startTestBackend({
      features: [
        governancePlugin,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: {
            governance: {
              reviewers: [reviewer],
              discovery: {
                github: { organization: 'example', topic: 'llm', token },
              },
            },
          },
        }),
      ],
    });
    const api = request(server);
    const github = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Mocked GitHub network failure'))
      .mockResolvedValueOnce(
        Response.json({
          total_count: 4,
          incomplete_results: false,
          items: [
            {
              id: 100,
              full_name: 'example/helper',
              description: null,
              private: false,
            },
            {
              id: 200,
              full_name: 'example/private',
              description: 'Restricted project',
              private: true,
            },
            { id: 300, full_name: 'example/..', description: null },
            {
              id: 400,
              full_name: 'example/unknown',
              description: 'Unverified project',
            },
          ],
        }),
      );
    const discovery = '/api/governance/discovery/github';
    const auth = (user: string) => mockCredentials.user.header(user);
    await api
      .post(`${discovery}/scan`)
      .set('Authorization', auth(reviewer))
      .expect(200);
    const preview = (id: number, user: string) =>
      api.get(`${discovery}/${id}/descriptor`).set('Authorization', auth(user));
    const descriptor = {
      apiVersion: 'governance.backstage.io/v1alpha1',
      kind: 'AIApp',
      spec: {
        name: 'Helper from descriptor',
        purpose: 'Sort the project notes',
        type: 'app',
        platform: 'GitHub',
        sourceUrl: 'https://github.com/Example/Helper.git/',
        owner,
        team: 'group:default/platform',
        lifecycle: 'experimental',
        audience: 'personal',
        classification: 'internal',
        usesAiAtRuntime: false,
      },
    };

    const builderQueue = await api
      .get(discovery)
      .set('Authorization', auth(owner))
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(
      builderQueue.body.repositories.map((repo: { id: string }) => repo.id),
    ).toEqual(['100']);
    expect(builderQueue.body.lastScan).toMatchObject({ status: 'completed' });
    expect(builderQueue.body.lastScan).not.toHaveProperty('found');
    expect(builderQueue.body.lastScan).not.toHaveProperty('partial');
    const reviewerQueue = await api
      .get(discovery)
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(reviewerQueue.body.repositories).toHaveLength(4);
    expect(reviewerQueue.body.lastScan).toMatchObject({
      found: 4,
      partial: false,
    });
    for (const id of [200, 400]) {
      await preview(id, owner).expect(200, { status: 'unavailable' });
      await api
        .post(`${discovery}/${id}/claim`)
        .set('Authorization', auth(owner))
        .send(descriptor.spec)
        .expect(404);
    }

    await api
      .get(`${discovery}/100/descriptor`)
      .set('Authorization', mockCredentials.none.header())
      .expect(401);
    expect(github).toHaveBeenCalledTimes(1);
    github.mockResolvedValueOnce(
      new Response(
        stringify({
          ...descriptor,
          spec: {
            ...descriptor.spec,
            evidence: { tests: 'https://example.com/private-evidence' },
            reviewTicketUrl: 'https://example.com/private-ticket',
          },
        }),
      ),
    );
    await preview(100, owner)
      .expect('Cache-Control', 'no-store')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ status: 'ready', app: descriptor.spec });
        expect(body.app).not.toHaveProperty('evidence');
        expect(body.app).not.toHaveProperty('reviewTicketUrl');
      });
    expect(github).toHaveBeenLastCalledWith(
      new URL(
        'https://api.github.com/repos/example/helper/contents/catalog-info.yaml',
      ),
      expect.objectContaining({
        headers: {
          Accept: 'application/vnd.github.raw+json',
          'User-Agent': 'Frontstage',
        },
        redirect: 'error',
      }),
    );
    expect(await db('governance_apps')).toEqual([]);

    github.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await preview(200, reviewer).expect(200, { status: 'unavailable' });
    expect(github).toHaveBeenLastCalledWith(
      new URL(
        'https://api.github.com/repos/example/private/contents/catalog-info.yaml',
      ),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      }),
    );

    for (const invalid of [
      stringify({ ...descriptor, kind: 'Component' }),
      stringify({
        ...descriptor,
        spec: {
          ...descriptor.spec,
          sourceUrl: 'https://github.com/example/other',
        },
      }),
      'a'.repeat(100_001),
    ]) {
      github.mockResolvedValueOnce(new Response(invalid));
      await preview(100, owner).expect(200, { status: 'unavailable' });
    }

    await preview(200, reviewer).expect(200, { status: 'unavailable' });

    await api
      .post(`${discovery}/100/decision`)
      .set('Authorization', auth(reviewer))
      .send({ action: 'dismiss', reason: 'Not operated by our team' })
      .expect(200);
    github.mockClear();
    await preview(100, reviewer).expect(200, { status: 'unavailable' });
    await preview(300, reviewer).expect(200, { status: 'unavailable' });
    await preview(999, reviewer).expect(200, { status: 'unavailable' });
    expect(github).not.toHaveBeenCalled();
  });

  it('extends only an existing Tier 3 app’s gateway access and audits exceptions', async () => {
    const owner = 'user:default/owner';
    const backup = 'user:default/backup';
    const reviewer = 'user:default/reviewer';
    jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockImplementation(async ({ entityRefs }) => ({
        items: entityRefs.map(ref => ({
          apiVersion: 'backstage.io/v1alpha1',
          kind: ref.startsWith('group:') ? 'Group' : 'User',
          metadata: { name: ref.split('/')[1] },
        })),
      }));
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
              reviewers: [owner, backup, reviewer],
              gateway: {
                enabled: true,
                mode: 'simulation',
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
    const auth = (user: string) => mockCredentials.user.header(user);
    const appInput = {
      name: 'Renewal prototype',
      purpose: 'Demonstrate time-limited gateway continuation',
      type: 'app',
      platform: 'GitHub',
      sourceUrl: 'https://example.com/renewal-prototype',
      owner,
      backupOwner: backup,
      team: 'group:default/platform',
      lifecycle: 'experimental',
      audience: 'personal',
      classification: 'internal',
      critical: true,
      models: ['test-model'],
    };
    const created = await api
      .post('/api/governance/apps')
      .set('Authorization', auth(owner))
      .send(appInput)
      .expect(201);
    const path = `/api/governance/apps/${created.body.id}`;
    const exceptionPath = `${path}/renewal-exception`;
    const issueKey = () =>
      api.post(`${path}/gateway-key`).set('Authorization', auth(owner));
    let key = (await issueKey().expect(201)).body.key;
    const call = () =>
      api
        .post('/api/governance/gateway/chat')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'test-model', prompt: 'Synthetic prompt' });
    await call().expect(403);

    const review = (expectedUpdatedAt: string) =>
      api.post(`${path}/reviews`).set('Authorization', auth(reviewer)).send({
        expectedUpdatedAt,
        status: 'approved',
        notes: 'Approved for operations.',
      });
    const lifecycle = (newLifecycle: string, expectedUpdatedAt: string) =>
      api
        .patch(`${path}/lifecycle`)
        .set('Authorization', auth(owner))
        .send({ expectedUpdatedAt, lifecycle: newLifecycle });
    const approved = await review(created.body.updatedAt).expect(200);
    const due = Date.parse(approved.body.nextReview);
    const day = 24 * 60 * 60 * 1000;
    const expiresAt = new Date(due + 30 * day).toISOString();
    const grant = (
      expectedUpdatedAt: string,
      expiry = expiresAt,
      actor = reviewer,
    ) =>
      api.post(exceptionPath).set('Authorization', auth(actor)).send({
        expectedUpdatedAt,
        expiresAt: expiry,
        reason: 'Renewal evidence is pending.',
      });

    await grant(approved.body.updatedAt).expect(400);
    const active = await lifecycle('active', approved.body.updatedAt).expect(
      200,
    );
    const timestamp = active.body.updatedAt;
    await grant(timestamp, expiresAt, owner).expect(403);
    await grant(timestamp, expiresAt, backup).expect(403);
    await grant(approved.body.updatedAt).expect(409);
    await grant(timestamp, approved.body.nextReview).expect(400);
    await grant(timestamp, new Date(due + 30 * day + 1).toISOString()).expect(
      400,
    );
    const granted = await grant(timestamp).expect(200);
    expect(granted.body).toMatchObject({
      nextReview: approved.body.nextReview,
      renewalException: {
        expiresAt,
        owner,
        actor: reviewer,
        reason: 'Renewal evidence is pending.',
      },
    });
    await grant(granted.body.updatedAt).expect(409);

    const clock = jest.spyOn(Date, 'now').mockReturnValue(due);
    const rejectedRotation = await issueKey().expect(403);
    expect(rejectedRotation.body.error.message).toContain(
      'A current Tier 3 approval is required',
    );
    await call().expect(200);
    const scorecard = () =>
      api
        .get(`${path}/scorecard`)
        .set('Authorization', auth(owner))
        .expect(200);
    const duringException = await scorecard();
    expect(duringException.body.checks).toContainEqual({
      name: 'Review status',
      status: 'attention',
      detail: expect.stringContaining(
        'Renewal is overdue. The exception permits eligible calls',
      ),
    });
    clock.mockReturnValue(Date.parse(expiresAt));
    await call().expect(403);
    const afterExpiry = await scorecard();
    expect(afterExpiry.body.checks).toContainEqual({
      name: 'Review status',
      status: 'attention',
      detail: 'The app needs reassessment or a current review.',
    });
    clock.mockReturnValue(due);
    await api
      .delete(`${path}/gateway-key`)
      .set('Authorization', auth(owner))
      .expect(204);
    await issueKey().expect(403);
    await call().expect(401);

    clock.mockReturnValue(Date.parse(expiresAt));
    const revoke = (expectedUpdatedAt: string) =>
      api
        .delete(exceptionPath)
        .set('Authorization', auth(reviewer))
        .send({ expectedUpdatedAt });
    await revoke(timestamp).expect(409);
    const revoked = await revoke(granted.body.updatedAt).expect(200);
    expect(revoked.body).not.toHaveProperty('renewalException');
    await grant(revoked.body.updatedAt).expect(400);

    const renewed = await review(revoked.body.updatedAt).expect(200);
    key = (await issueKey().expect(201)).body.key;
    const newExpiry = new Date(
      Date.parse(renewed.body.nextReview) + day,
    ).toISOString();
    const second = await grant(renewed.body.updatedAt, newExpiry).expect(200);
    const reapproved = await review(second.body.updatedAt).expect(200);
    expect(reapproved.body).not.toHaveProperty('renewalException');
    const third = await grant(reapproved.body.updatedAt, newExpiry).expect(200);
    const changed = await api
      .put(path)
      .set('Authorization', auth(owner))
      .send({
        ...appInput,
        lifecycle: 'active',
        purpose: 'Changed risk scope',
        expectedUpdatedAt: third.body.updatedAt,
      })
      .expect(200);
    expect(changed.body).toMatchObject({
      lifecycle: 'experimental',
      reviewStatus: 'pending',
    });
    expect(changed.body).not.toHaveProperty('renewalException');
    await lifecycle('active', changed.body.updatedAt).expect(400);
    const newApproval = await review(changed.body.updatedAt).expect(200);
    const newActivation = await lifecycle(
      'active',
      newApproval.body.updatedAt,
    ).expect(200);
    const fourth = await grant(newActivation.body.updatedAt, newExpiry).expect(
      200,
    );
    clock.mockReturnValue(Date.parse(newApproval.body.nextReview));
    await call().expect(200);
    const deprecated = await lifecycle(
      'deprecated',
      fourth.body.updatedAt,
    ).expect(200);
    expect(deprecated.body).not.toHaveProperty('renewalException');
    await lifecycle('active', deprecated.body.updatedAt).expect(400);
    await call().expect(403);

    const history = await api
      .get(`${path}/history`)
      .set('Authorization', auth(reviewer))
      .expect(200);
    const events = history.body.events.map((event: { event: string }) =>
      JSON.parse(event.event),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'renewal-exception-granted',
          renewalException: granted.body.renewalException,
        }),
        expect.objectContaining({
          action: 'renewal-exception-revoked',
          renewalException: granted.body.renewalException,
        }),
      ]),
    );
  });

  it('opens scheduled retirement reviews in bounded runs with service attribution', async () => {
    const owner = 'user:default/owner';
    const inactiveOwner = 'user:default/inactive';
    const reviewer = 'user:default/reviewer';
    const catalog = jest.spyOn(CatalogClient.prototype, 'getEntitiesByRefs');
    const entities = (refs: string[], unavailable?: string) => ({
      items: refs.map(ref =>
        ref === unavailable
          ? undefined
          : {
              apiVersion: 'backstage.io/v1alpha1',
              kind: ref.startsWith('group:') ? 'Group' : 'User',
              metadata: { name: ref.split('/')[1] },
            },
      ),
    });
    catalog.mockImplementation(async ({ entityRefs }) => entities(entityRefs));
    const scheduleTask = jest.fn<
      Promise<void>,
      Parameters<SchedulerService['scheduleTask']>
    >();
    const db = await databases.init('SQLITE_3');
    const { server } = await startTestBackend({
      features: [
        governancePlugin,
        mockServices.database.factory({ knex: db }),
        mockServices.scheduler.mock({ scheduleTask }).factory,
        mockServices.rootConfig.factory({
          data: {
            governance: {
              reviewers: [reviewer],
              retirementReviewIntervalMinutes: 15,
            },
          },
        }),
      ],
    });
    expect(scheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'governance-retirement-review',
        scope: 'global',
        frequency: { minutes: 15 },
      }),
    );
    const task = scheduleTask.mock.calls[0][0];
    const api = request(server);
    const auth = (user: string) => mockCredentials.user.header(user);
    const appInput = {
      purpose: 'Test automated dormancy review',
      type: 'app',
      platform: 'GitHub',
      team: 'group:default/platform',
      lifecycle: 'active',
      audience: 'personal',
      classification: 'internal',
      models: ['test-model'],
    };
    const names = [
      'resumed',
      'inactive',
      'kept',
      'simulation',
      'reactivated',
      ...Array.from({ length: 51 }, (_, index) => `eligible-${index + 1}`),
    ];
    const { body: apps } = await api
      .post('/api/governance/imports')
      .set('Authorization', auth(reviewer))
      .send({
        apps: names.map(name => ({
          ...appInput,
          name,
          owner: name === 'inactive' ? inactiveOwner : owner,
          sourceUrl: `https://example.com/${name}`,
        })),
      })
      .expect(201);
    expect(apps).toHaveLength(names.length);
    const [resumed, inactive, kept, simulation, reactivated] = apps;
    const activation = Math.max(
      ...apps.map((app: { activeSince: string }) =>
        Date.parse(app.activeSince),
      ),
    );
    const now = activation + 91 * 86_400_000;
    const old = activation;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const reactivatedPath = `/api/governance/apps/${reactivated.id}/lifecycle`;
    const deprecated = await api
      .patch(reactivatedPath)
      .set('Authorization', auth(owner))
      .send({
        lifecycle: 'deprecated',
        expectedUpdatedAt: reactivated.updatedAt,
      })
      .expect(200);
    const restarted = await api
      .patch(reactivatedPath)
      .set('Authorization', auth(owner))
      .send({
        lifecycle: 'active',
        expectedUpdatedAt: deprecated.body.updatedAt,
      })
      .expect(200);
    expect(restarted.body.activeSince).toBe(restarted.body.updatedAt);
    const usage = (
      app: { id: string; name: string },
      at: number,
      mode = 'openai',
    ) => ({
      app_id: app.id,
      id: `${app.name}-${at}`,
      model: 'test-model',
      execution_mode: mode,
      created_at: new Date(at),
      estimated_cost_nanos_usd: 0,
    });
    await db('governance_gateway_usage').insert(
      apps.map((app: { id: string; name: string }, index: number) =>
        usage(
          app,
          old + index,
          app.name === 'simulation' ? 'simulation' : 'openai',
        ),
      ),
    );
    const keptRoute = `/api/governance/apps/${kept.id}/retirement-review`;
    const pending = await api
      .post(keptRoute)
      .set('Authorization', auth(reviewer))
      .send({ expectedUpdatedAt: kept.updatedAt })
      .expect(200);
    await api
      .patch(keptRoute)
      .set('Authorization', auth(owner))
      .send({
        expectedUpdatedAt: pending.body.updatedAt,
        decision: 'keep',
        reason: 'Continues in operation outside the gateway.',
      })
      .expect(200);

    const readReviews = async () => {
      const { body } = await api
        .get('/api/governance/apps')
        .set('Authorization', auth(reviewer))
        .expect(200);
      return new Map<
        string,
        {
          lifecycle: string;
          retirementReview?: { status: string; requestedBy: string };
        }
      >(body.apps.map((app: { name: string }) => [app.name, app]));
    };
    const openedBySchedule = (
      records: Awaited<ReturnType<typeof readReviews>>,
    ) =>
      [...records.values()].filter(
        record => record.retirementReview?.requestedBy === 'plugin:governance',
      );

    await task.fn(AbortSignal.abort());
    expect(openedBySchedule(await readReviews())).toHaveLength(0);

    catalog.mockImplementation(async ({ entityRefs }) =>
      entities(entityRefs, inactiveOwner),
    );
    catalog.mockImplementationOnce(async ({ entityRefs }) => {
      await db('governance_gateway_usage').insert(usage(resumed, now));
      return entities(entityRefs, inactiveOwner);
    });
    await task.fn(new AbortController().signal);
    expect(openedBySchedule(await readReviews())).toHaveLength(50);
    await task.fn(new AbortController().signal);
    const reviews = await readReviews();
    const opened = openedBySchedule(reviews);
    expect(opened).toHaveLength(51);
    expect(
      opened.every(
        app =>
          app.lifecycle === 'active' &&
          app.retirementReview?.status === 'pending',
      ),
    ).toBe(true);
    expect(reviews.get(resumed.name)).not.toHaveProperty('retirementReview');
    expect(reviews.get(inactive.name)).not.toHaveProperty('retirementReview');
    expect(reviews.get(simulation.name)).not.toHaveProperty('retirementReview');
    expect(reviews.get(reactivated.name)).not.toHaveProperty(
      'retirementReview',
    );
    expect(reviews.get(kept.name)?.retirementReview?.status).toBe('kept');
    await task.fn(new AbortController().signal);
    expect(openedBySchedule(await readReviews())).toEqual(opened);

    const eligible = apps[5];
    const { body: history } = await api
      .get(`/api/governance/apps/${eligible.id}/history`)
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(
      history.events.map((event: { event: string }) => JSON.parse(event.event)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'retirement-review-requested',
          actor: 'plugin:governance',
          record: expect.objectContaining({
            retirementReview: expect.objectContaining({
              requestedBy: 'plugin:governance',
              owner,
            }),
          }),
        }),
      ]),
    );
  });

  it('requires owner confirmation and rechecks live traffic before retirement', async () => {
    const owner = 'user:default/owner';
    const reviewer = 'user:default/reviewer';
    const teammate = 'user:default/teammate';
    const day = 86_400_000;
    const catalog = jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockImplementation(async ({ entityRefs }) => ({
        items: entityRefs.map(ref => ({
          apiVersion: 'backstage.io/v1alpha1',
          kind: ref.startsWith('group:') ? 'Group' : 'User',
          metadata: { name: ref.split('/')[1] },
        })),
      }));
    jest.replaceProperty(process, 'env', {
      ...process.env,
      NODE_ENV: 'development',
    });
    const scheduleTask = jest.fn();
    const db = await databases.init('SQLITE_3');
    const { server } = await startTestBackend({
      features: [
        governancePlugin,
        mockServices.scheduler.mock({ scheduleTask }).factory,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: {
            backend: { listen: { host: '127.0.0.1' } },
            governance: {
              reviewers: [reviewer],
              gateway: {
                enabled: true,
                mode: 'simulation',
                models: {
                  'test-model': { allowedClassifications: ['internal'] },
                },
              },
            },
          },
        }),
      ],
    });
    expect(scheduleTask).not.toHaveBeenCalled();
    const api = request(server);
    const auth = (user: string) => mockCredentials.user.header(user);
    const appInput = {
      name: 'Legacy helper',
      purpose: 'Use gateway for notes',
      type: 'app',
      platform: 'GitHub',
      sourceUrl: 'https://example.com/legacy-helper',
      owner,
      team: 'group:default/platform',
      lifecycle: 'active',
      audience: 'personal',
      classification: 'internal',
      models: ['test-model'],
    };
    const app = await api
      .post('/api/governance/apps')
      .set('Authorization', auth(owner))
      .send(appInput)
      .expect(201);
    expect(app.body.activeSince).toBe(app.body.updatedAt);
    const currentTime = Date.parse(app.body.activeSince) + 91 * day;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(currentTime);
    const path = `/api/governance/apps/${app.body.id}`;
    const retirementPath = `${path}/retirement-review`;
    const gatewayKey = () =>
      api.post(`${path}/gateway-key`).set('Authorization', auth(owner));
    const keyStatus = () =>
      api.get(`${path}/gateway-key`).set('Authorization', auth(owner));
    const open = (expectedUpdatedAt: string, actor = reviewer) =>
      api
        .post(retirementPath)
        .set('Authorization', auth(actor))
        .send({ expectedUpdatedAt });
    const decide = (
      decision: 'keep' | 'retire',
      expectedUpdatedAt: string,
      actor = owner,
    ) =>
      api.patch(retirementPath).set('Authorization', auth(actor)).send({
        decision,
        expectedUpdatedAt,
        reason: 'Confirmed by app operations.',
      });
    const usageReport = () =>
      api
        .get('/api/governance/reports/usage?days=1')
        .set('Authorization', auth(reviewer))
        .expect(200);
    const usage = (id: string, at: number, mode = 'openai') =>
      db('governance_gateway_usage').insert({
        id,
        app_id: app.body.id,
        model: 'test-model',
        execution_mode: mode,
        created_at: new Date(at),
        estimated_cost_nanos_usd: 0,
      });
    await gatewayKey().expect(201);
    const start = app.body.updatedAt;
    const old = currentTime - 90 * day;
    await usage('simulation-only', old, 'simulation');
    await open(start).expect(400);
    await usage('just-too-recent', old + 1);
    await open(start).expect(400);
    clock.mockReturnValue(currentTime + 1);
    await open(start, owner).expect(403);
    catalog.mockResolvedValueOnce({ items: [undefined] });
    await open(start).expect(403);
    const pending = await open(start).expect(200);
    expect(pending.body).toMatchObject({
      lifecycle: 'active',
      retirementReview: {
        owner,
        status: 'pending',
        requestedBy: reviewer,
        lastLiveCall: new Date(old + 1).toISOString(),
      },
    });
    const candidate = {
      appId: app.body.id,
      lastLiveCall: new Date(old + 1).toISOString(),
    };
    expect((await usageReport()).body.retirementReview.apps).toEqual([
      candidate,
    ]);
    expect(
      (await api.get(path).set('Authorization', auth(teammate)).expect(200))
        .body,
    ).not.toHaveProperty('retirementReview');
    await keyStatus().expect(200, { issued: true });
    await open(pending.body.updatedAt).expect(409);
    await decide('keep', start).expect(409);
    await decide('retire', pending.body.updatedAt, reviewer).expect(403);
    catalog.mockResolvedValueOnce({ items: [undefined] });
    await decide('keep', pending.body.updatedAt).expect(403);
    const kept = await decide('keep', pending.body.updatedAt).expect(200);
    expect(kept.body.retirementReview).toMatchObject({
      status: 'kept',
      reason: 'Confirmed by app operations.',
    });
    await keyStatus().expect(200, { issued: true });
    expect((await usageReport()).body.retirementReview.apps).toEqual([]);
    await open(kept.body.updatedAt).expect(400);

    const later = Date.parse(kept.body.retirementReview.decidedAt) + 90 * day;
    clock.mockReturnValue(later);
    expect((await usageReport()).body.retirementReview.apps).toEqual([
      candidate,
    ]);
    const reopened = await open(kept.body.updatedAt).expect(200);
    await usage('resumed-live', later);
    await decide('retire', reopened.body.updatedAt).expect(409);
    await keyStatus().expect(200, { issued: true });
    const deprecated = await api
      .patch(`${path}/lifecycle`)
      .set('Authorization', auth(owner))
      .send({
        lifecycle: 'deprecated',
        expectedUpdatedAt: reopened.body.updatedAt,
      })
      .expect(200);
    expect(deprecated.body).not.toHaveProperty('retirementReview');
    expect(deprecated.body).not.toHaveProperty('activeSince');
    clock.mockReturnValue(later + 1_000);
    const active = await api
      .put(path)
      .set('Authorization', auth(owner))
      .send({ ...appInput, expectedUpdatedAt: deprecated.body.updatedAt })
      .expect(200);
    expect(active.body.activeSince).toBe(active.body.updatedAt);
    clock.mockReturnValue(later + 2_000);
    const shared = await api
      .put(path)
      .set('Authorization', auth(owner))
      .send({
        ...appInput,
        audience: 'team',
        backupOwner: 'user:default/backup',
        expectedUpdatedAt: active.body.updatedAt,
      })
      .expect(200);
    expect(shared.body).toMatchObject({
      tier: 2,
      activeSince: active.body.activeSince,
    });
    expect(shared.body.updatedAt).not.toBe(shared.body.activeSince);

    const nextEligible = Date.parse(active.body.activeSince) + 90 * day;
    clock.mockReturnValue(nextEligible - 1);
    expect((await usageReport()).body.retirementReview.apps).toEqual([]);
    await open(shared.body.updatedAt).expect(400);
    clock.mockReturnValue(nextEligible);
    expect((await usageReport()).body.retirementReview.apps).toEqual([
      { appId: app.body.id, lastLiveCall: new Date(later).toISOString() },
    ]);
    const finalPending = await open(shared.body.updatedAt).expect(200);
    const retired = await decide('retire', finalPending.body.updatedAt).expect(
      200,
    );
    expect(retired.body).toMatchObject({
      lifecycle: 'retired',
      retirementReview: {
        status: 'retired',
        reason: 'Confirmed by app operations.',
        owner,
      },
    });
    expect(retired.body).not.toHaveProperty('activeSince');
    await keyStatus().expect(200, { issued: false });
    const history = await api
      .get(`${path}/history`)
      .set('Authorization', auth(reviewer))
      .expect(200);
    const events = history.body.events.map((event: { event: string }) =>
      JSON.parse(event.event),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'retirement-review-requested',
          actor: reviewer,
          record: expect.objectContaining({
            retirementReview: pending.body.retirementReview,
          }),
        }),
        expect.objectContaining({
          action: 'retirement-review-kept',
          actor: owner,
          record: expect.objectContaining({
            retirementReview: kept.body.retirementReview,
          }),
        }),
        expect.objectContaining({
          action: 'retirement-review-retired',
          actor: owner,
          lifecycleReason: 'Confirmed by app operations.',
          record: expect.objectContaining({
            retirementReview: retired.body.retirementReview,
          }),
        }),
      ]),
    );
    expect(history.body.keyEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'revoked', actor: owner }),
      ]),
    );
  });

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
              firstDecisionTargetWeekdays: 15,
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
    const freshActivation = await api
      .get('/api/governance/reports/usage?days=1')
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(freshActivation.body.retirementReview).toEqual({
      days: 90,
      apps: [],
    });
    const legacyRuntimeRow = db('governance_apps').where('id', runtime.body.id);
    const legacyRuntime = await legacyRuntimeRow.clone().first('payload');
    await legacyRuntimeRow.update({
      payload: JSON.stringify({
        ...JSON.parse(legacyRuntime.payload),
        activeSince: undefined,
      }),
    });
    const legacyActive = await api
      .patch(`${runtimePath}/lifecycle`)
      .set('Authorization', auth(owner))
      .send({ lifecycle: 'active' })
      .expect(200);
    expect(legacyActive.body).not.toHaveProperty('activeSince');
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
          stopAtThreshold: false,
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
    const reviewReport = '/api/governance/reports/review-turnaround';
    await api.get(reviewReport).set('Authorization', auth(owner)).expect(403);
    const turnaround = await api
      .get(reviewReport)
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(turnaround.body.target).toEqual({
      workingDays: 15,
      pendingAtOrOver: 0,
    });
    expect(turnaround.body.decisions).toBeGreaterThan(0);
    expect(turnaround.body.medianWorkingDays).toBeGreaterThanOrEqual(0);
    const personal = hostedRecords[1];
    const activeUnlisted = {
      ...personal,
      sourceUrl: 'https://example.com/hosted-active-unlisted',
      lifecycle: 'active',
    };
    const descriptor = {
      content: JSON.stringify({
        apiVersion: 'governance.backstage.io/v1alpha1',
        kind: 'AIApp',
        spec: activeUnlisted,
      }),
    };
    for (const input of [
      { route: apps, body: activeUnlisted },
      { route: '/api/governance/repository?dryRun=true', body: descriptor },
      { route: '/api/governance/repository', body: descriptor },
      {
        route: '/api/governance/imports?dryRun=true',
        body: { apps: [activeUnlisted] },
      },
      { route: '/api/governance/imports', body: { apps: [activeUnlisted] } },
    ]) {
      const blocked = await api
        .post(input.route)
        .set('Authorization', auth(reviewer))
        .send(input.body)
        .expect(400);
      expect(blocked.body.error.message).toContain(
        'Choose an approved provider workspace before activating this app.',
      );
    }
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
    const sourceUrl = 'https://github.com/exampleai/budgeted-app';
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
    const warn = jest.fn();
    const { server } = await startTestBackend({
      features: [
        governancePlugin,
        mockServices.logger.mock({ warn }).factory,
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
                  { sourceUrl, monthlyUsd: 2, stopAtThreshold: true },
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
      sourceUrl: 'https://github.com/ExampleAI/Budgeted-App.git/',
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
    await api
      .post('/api/governance/apps')
      .set('Authorization', auth)
      .send({ ...registration, sourceUrl })
      .expect(409);
    const duplicates = await api
      .post(`${importApi}?dryRun=true`)
      .set('Authorization', service)
      .send({
        apps: [
          { ...registration, sourceUrl },
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
    provider.mockResolvedValueOnce(
      new Response('Synthetic upstream details', {
        status: 307,
        headers: { Location: 'https://example.com/unexpected-provider-target' },
      }),
    );
    const unavailable = await call().expect(503);
    expect(unavailable.body.error.message).toBe(
      'The configured model provider is temporarily unavailable.',
    );
    expect(warn).toHaveBeenCalledWith('Model provider request failed', {
      appId: app.body.id,
      model: 'test-model',
      kind: 'upstream-http',
      upstreamStatus: 307,
    });
    expect(provider).toHaveBeenNthCalledWith(
      1,
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ redirect: 'error' }),
    );
    await call().expect(200, {
      output: 'Synthetic completion',
      model: 'test-model',
      simulated: false,
    });
    provider.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            message: {
              content: null,
              refusal: 'I cannot assist with that request.',
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 3 },
      }),
    );
    await call().expect(200, {
      output: 'I cannot assist with that request.',
      model: 'test-model',
      simulated: false,
      refused: true,
    });
    await call().expect(403);
    expect(provider).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(provider.mock.calls[1][1]?.body))).toMatchObject({
      max_completion_tokens: 128,
    });

    const usage = await api
      .get(`${path}/usage`)
      .set('Authorization', auth)
      .expect(200);
    expect(usage.body).toMatchObject({
      liveCalls: 2,
      liveTokens: { calls: 2, input: 2, output: 5 },
      monthlySpend: {
        liveEstimatedCostUsd: 2,
        thresholdUsd: 2,
        stopAtThreshold: true,
      },
      blocks: [{ reason: 'spend-threshold', calls: 1 }],
    });
  });
});

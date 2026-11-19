import { createHash } from 'node:crypto';
import type { SchedulerService } from '@backstage/backend-plugin-api';
import {
  createServiceMock,
  mockCredentials,
  mockServices,
  startTestBackend,
  TestDatabases,
} from '@backstage/backend-test-utils';
import { CatalogClient } from '@backstage/catalog-client';
import type { Entity } from '@backstage/catalog-model';
import { notificationService } from '@backstage/plugin-notifications-node';
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

    const accessPath = `${path}/directory-requests`;
    const { body: submitted } = await api
      .post(accessPath)
      .set('Authorization', auth(teammate))
      .send({ message: 'Need access for staff support.' })
      .expect(201);
    const readQueue = () =>
      api.get(accessPath).set('Authorization', auth(reviewer)).expect(200);
    expect((await readQueue()).body.canApprove).toBe(true);

    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(approved.body.nextReview));
    expect((await readQueue()).body.canApprove).toBe(false);
    await api
      .patch(`${accessPath}/${submitted.id}`)
      .set('Authorization', auth(reviewer))
      .send({ status: 'approved' })
      .expect(409);
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
    const personalQueue = `${personalPath}/directory-requests`;
    const { body: pendingTransferRequest } = await api
      .post(personalQueue)
      .set('Authorization', auth(reviewer))
      .send({ message: 'I need access for the review.' })
      .expect(201);
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

    await api.get(personalQueue).set('Authorization', auth(owner)).expect(403);
    const { body: transferredQueue } = await api
      .get(personalQueue)
      .set('Authorization', auth(teammate))
      .expect(200);
    expect(transferredQueue).toMatchObject({
      canApprove: false,
      requests: [
        {
          id: pendingTransferRequest.id,
          requester: reviewer,
          status: 'pending',
        },
      ],
    });
    await api
      .patch(`${personalQueue}/${pendingTransferRequest.id}`)
      .set('Authorization', auth(teammate))
      .send({ status: 'approved' })
      .expect(409);

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

  it('sends each scheduled governance reminder to its active owner and retries failed sends', async () => {
    const owner = 'user:default/owner';
    const nextOwner = 'user:default/next';
    const inactiveOwner = 'user:default/inactive';
    const manager = 'user:default/manager';
    jest.replaceProperty(process, 'env', {
      ...process.env,
      NODE_ENV: 'development',
    });
    const reviewer = 'user:default/reviewer';
    const backupOwner = 'user:default/backup';
    const inactive = new Set<string>();
    const catalog = jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockImplementation(async ({ entityRefs }) => ({
        items: entityRefs.map(ref => ({
          apiVersion: 'backstage.io/v1alpha1',
          kind: ref.startsWith('group:') ? 'Group' : 'User',
          metadata: {
            name: ref.split('/')[1],
            annotations: {
              ...(inactive.has(ref) && {
                'governance.backstage.io/active': 'false',
              }),
              ...(ref === owner && {
                'governance.backstage.io/manager': manager,
              }),
            },
          },
        })),
      }));
    const notifications = createServiceMock(notificationService, () => ({
      send: jest.fn(),
    }))();
    notifications.send.mockResolvedValue(undefined);
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
        notifications.factory,
        mockServices.rootConfig.factory({
          data: {
            app: { baseUrl: 'https://portal.example.com/internal/' },
            backend: { listen: { host: '127.0.0.1' } },
            governance: {
              reviewReminderIntervalMinutes: 15,
              reviewManagerEscalationDays: 14,
              reviewGatewayPauseDays: 30,
              gateway: {
                enabled: true,
                mode: 'simulation',
                models: {
                  'test-model': { allowedClassifications: ['internal'] },
                },
              },
              approvedHostedWorkspaces: [
                { provider: 'Example AI', workspace: 'Company' },
                { provider: 'Example AI', workspace: 'Company 2' },
              ],
              reviewers: [reviewer],
            },
          },
        }),
      ],
    });
    expect(scheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'governance-review-reminders',
        scope: 'global',
        frequency: { minutes: 15 },
      }),
    );
    const api = request(server);
    const now = Date.now();
    const day = 86_400_000;
    const dueAt = (days: number) => new Date(now + days * day).toISOString();
    const base = {
      purpose: 'Test scheduled review reminder.',
      type: 'app',
      platform: 'GitHub',
      owner,
      backupOwner,
      team: 'group:default/platform',
      lifecycle: 'experimental',
      audience: 'team',
      classification: 'internal',
      models: ['test-model'],
    };
    const hostedInput = {
      type: 'provider-hosted app',
      audience: 'personal',
      hosted: {
        provider: 'Example AI',
        workspace: 'Company',
        sharing: 'private',
        dataAccess: 'none',
      },
    };
    const fixtures = [
      { name: 'Critical renewal', critical: true },
      { ...hostedInput, name: 'Hosted confirmation' },
      { name: 'Due in a week' },
      { name: 'Due later' },
      { name: 'Inactive owner', owner: inactiveOwner },
      { name: 'Retired' },
      { name: 'Tier drift' },
      { ...hostedInput, name: 'New hosted app' },
      { ...hostedInput, name: 'Legacy hosted app' },
      {
        ...hostedInput,
        name: 'Unapproved hosted app',
        hosted: { ...hostedInput.hosted, workspace: 'Unapproved' },
      },
    ];
    const { body: apps } = await api
      .post('/api/governance/imports')
      .set('Authorization', mockCredentials.user.header(reviewer))
      .send({
        apps: fixtures.map((fixture, index) => ({
          ...base,
          ...fixture,
          sourceUrl: `https://example.com/reminder-${index}`,
        })),
      })
      .expect(201);
    const [
      critical,
      hosted,
      renewal,
      later,
      inactiveApp,
      retired,
      drift,
      initialHosted,
      legacyHosted,
      unapprovedHosted,
    ] = apps;
    const savePayload = async (record: { id: string }, changes: object) => {
      const row = db('governance_apps').where({ id: record.id });
      const { payload } = await row.clone().first('payload');
      await row.update({
        payload: JSON.stringify({ ...JSON.parse(payload), ...changes }),
      });
    };
    await savePayload(critical, {
      reviewStatus: 'approved',
      nextReview: dueAt(-3),
    });
    await savePayload(hosted, {
      hostedAttestation: { at: dueAt(-91), nextDue: dueAt(-1) },
    });
    await savePayload(renewal, { nextReview: dueAt(7) });
    await savePayload(later, { nextReview: dueAt(8) });
    await savePayload(inactiveApp, { nextReview: dueAt(1) });
    await savePayload(retired, { lifecycle: 'retired', nextReview: dueAt(1) });
    await savePayload(drift, {
      tier: 3,
      reviewStatus: 'approved',
      nextReview: dueAt(1),
    });
    inactive.add(inactiveOwner);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    const { fn } = scheduleTask.mock.calls[0][0];
    const run = () => fn(new AbortController().signal);
    catalog.mockClear();
    notifications.send.mockRejectedValueOnce(
      new Error('temporary notification failure'),
    );
    await run();
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(catalog.mock.calls[0][0].entityRefs.sort()).toEqual(
      [inactiveOwner, owner].sort(),
    );
    expect(notifications.send.mock.calls).toHaveLength(3);
    const messages = () =>
      notifications.send.mock.calls.map(([message]) => message);
    expect(messages().map(message => message.payload.link)).toEqual(
      [critical, renewal, hosted].map(
        app => `https://portal.example.com/internal/?app=${app.id}`,
      ),
    );
    expect(messages().map(message => message.recipients)).toEqual(
      Array.from({ length: 3 }, () => ({ type: 'entity', entityRef: owner })),
    );
    expect(messages().map(message => message.payload.title)).toEqual([
      'AI app review due',
      'AI app attestation due',
      'Hosted workspace confirmation due',
    ]);

    expect(
      await db('governance_review_reminders').whereNull('sent_at'),
    ).toHaveLength(1);
    const hour = 60 * 60 * 1000;
    clock.mockReturnValue(now + hour - 1);
    await run();
    expect(notifications.send).toHaveBeenCalledTimes(3);

    inactive.delete(inactiveOwner);
    clock.mockReturnValue(now + hour);
    await run();
    expect(notifications.send).toHaveBeenCalledTimes(5);
    expect(messages()[3].recipients).toEqual({
      type: 'entity',
      entityRef: inactiveOwner,
    });
    expect(messages()[4]).toEqual(messages()[0]);
    expect(
      await db('governance_review_reminders').whereNotNull('sent_at'),
    ).toHaveLength(4);
    await run();
    expect(notifications.send).toHaveBeenCalledTimes(5);

    await savePayload(renewal, { owner: nextOwner });
    await run();
    expect(notifications.send).toHaveBeenCalledTimes(6);
    expect(messages()[5].recipients).toEqual({
      type: 'entity',
      entityRef: nextOwner,
    });
    expect(messages()[5].payload.scope).not.toBe(messages()[1].payload.scope);

    const initialMessages = () =>
      messages().filter(
        message => message.payload.title === 'Confirm your hosted workspace',
      );
    expect(initialMessages()).toEqual([]);
    const setHostedLifecycle = (lifecycle: 'active' | 'deprecated') =>
      api
        .patch(`/api/governance/apps/${initialHosted.id}/lifecycle`)
        .set('Authorization', mockCredentials.user.header(owner))
        .send({ lifecycle })
        .expect(200);
    await setHostedLifecycle('active');
    await savePayload(legacyHosted, { lifecycle: 'active' });
    await savePayload(unapprovedHosted, { lifecycle: 'active' });
    await savePayload(hosted, { lifecycle: 'active' });
    await run();
    expect(initialMessages()).toHaveLength(2);
    const initialNotice = initialMessages().find(message =>
      message.payload.link?.endsWith(`?app=${initialHosted.id}`),
    );
    expect(initialNotice).toMatchObject({
      recipients: { type: 'entity', entityRef: owner },
      payload: {
        description:
          'Confirm the approved workspace and sharing settings for New hosted app.',
      },
    });
    await savePayload(legacyHosted, {
      name: 'Renamed legacy app',
      updatedAt: dueAt(1),
    });
    await run();
    expect(initialMessages()).toHaveLength(2);

    await setHostedLifecycle('deprecated');
    clock.mockReturnValue(now + hour + 1000);
    await setHostedLifecycle('active');
    await run();
    expect(initialMessages()).toHaveLength(3);
    expect(initialMessages()[2].payload.scope).not.toBe(
      initialNotice?.payload.scope,
    );

    await savePayload(legacyHosted, { owner: nextOwner });
    await run();
    expect(initialMessages()).toHaveLength(4);
    expect(initialMessages()[3].recipients).toEqual({
      type: 'entity',
      entityRef: nextOwner,
    });
    expect(initialMessages()[3].payload.link).toContain(
      `?app=${legacyHosted.id}`,
    );

    await savePayload(legacyHosted, {
      owner: reviewer,
      hostedAttestation: { at: dueAt(0), nextDue: dueAt(90) },
    });
    await run();
    expect(initialMessages()).toHaveLength(4);

    const path = `/api/governance/apps/${initialHosted.id}`;
    const ownerAuth = mockCredentials.user.header(owner);
    const confirmHosted = async (expectedUpdatedAt: string) => {
      const { body } = await api
        .post(`${path}/hosted-attestation`)
        .set('Authorization', ownerAuth)
        .send({ confirmed: true, expectedUpdatedAt })
        .expect(200);
      expect(body.hostedAttestation).toBeDefined();
      expect(body).not.toHaveProperty('hostedReconfirmationAt');
      return body;
    };
    const editHosted = async (
      record: { updatedAt: string },
      changes: object,
      editor = owner,
    ) => {
      const { body } = await api
        .put(path)
        .set('Authorization', mockCredentials.user.header(editor))
        .send({ ...record, ...changes, expectedUpdatedAt: record.updatedAt })
        .expect(200);
      return body;
    };
    const { body: currentHosted } = await api
      .get(path)
      .set('Authorization', ownerAuth)
      .expect(200);
    const confirmed = await confirmHosted(currentHosted.updatedAt);
    const invalidated = await editHosted(confirmed, {
      hosted: { ...confirmed.hosted, workspace: 'Company 2' },
    });
    expect(invalidated).not.toHaveProperty('hostedAttestation');
    const reconfirmationAt = invalidated.updatedAt;
    const beforeReminder = await editHosted(invalidated, {
      purpose: 'Updated purpose before the scheduled job.',
    });
    expect(beforeReminder.hostedReconfirmationAt).toBe(reconfirmationAt);
    const reconfirmations = () =>
      messages().filter(
        message => message.payload.title === 'Reconfirm your hosted workspace',
      );
    await run();
    expect(reconfirmations()).toHaveLength(1);
    expect(reconfirmations()[0]).toMatchObject({
      recipients: { type: 'entity', entityRef: owner },
      payload: {
        description:
          'Confirm the current workspace and sharing settings for New hosted app.',
        link: `https://portal.example.com/internal/?app=${initialHosted.id}`,
      },
    });
    const afterReminder = await editHosted(beforeReminder, {
      purpose: 'Updated purpose after reminder delivery.',
    });
    expect(afterReminder.hostedReconfirmationAt).toBe(reconfirmationAt);
    await run();
    expect(reconfirmations()).toHaveLength(1);
    expect(initialMessages()).toHaveLength(4);

    const reconfirmed = await confirmHosted(afterReminder.updatedAt);
    const invalidatedAgain = await editHosted(reconfirmed, {
      hosted: { ...reconfirmed.hosted, workspace: 'Company' },
    });
    expect(invalidatedAgain.hostedReconfirmationAt).not.toBe(reconfirmationAt);
    const confirmedAgain = await confirmHosted(invalidatedAgain.updatedAt);
    await run();
    expect(reconfirmations()).toHaveLength(1);
    expect(initialMessages()).toHaveLength(4);

    const transferred = await editHosted(confirmedAgain, { owner: nextOwner });
    expect(transferred).not.toHaveProperty('hostedAttestation');
    expect(transferred.hostedReconfirmationAt).toBe(transferred.updatedAt);
    await run();
    expect(reconfirmations()).toHaveLength(2);
    expect(reconfirmations()[1].recipients).toEqual({
      type: 'entity',
      entityRef: nextOwner,
    });

    const returned = await editHosted(transferred, { owner }, nextOwner);
    expect(returned.hostedReconfirmationAt).toBe(returned.updatedAt);
    expect(returned.hostedReconfirmationAt).not.toBe(
      transferred.hostedReconfirmationAt,
    );
    await run();
    expect(reconfirmations()).toHaveLength(3);
    expect(reconfirmations()[2].recipients).toEqual({
      type: 'entity',
      entityRef: owner,
    });
    expect(reconfirmations()[2].payload.scope).not.toBe(
      reconfirmations()[0].payload.scope,
    );
    await run();
    expect(reconfirmations()).toHaveLength(3);
    expect(initialMessages()).toHaveLength(4);

    const managerMessages = () =>
      messages().filter(
        message =>
          message.recipients.type === 'entity' &&
          message.recipients.entityRef === manager,
      );
    clock.mockReturnValue(now + 11 * day - 1);
    await run();
    expect(managerMessages()).toEqual([]);

    clock.mockReturnValue(now + 11 * day);
    inactive.add(manager);
    await run();
    expect(managerMessages()).toEqual([]);

    inactive.delete(manager);
    await run();
    expect(managerMessages()).toEqual([
      expect.objectContaining({
        recipients: { type: 'entity', entityRef: manager },
        payload: expect.objectContaining({
          title: 'AI app renewal overdue',
          link: `https://portal.example.com/internal/?app=${critical.id}`,
        }),
      }),
    ]);
    await run();
    expect(managerMessages()).toHaveLength(1);

    await savePayload(critical, { nextReview: dueAt(-4) });
    notifications.send.mockRejectedValueOnce(
      new Error('owner reminder temporarily unavailable'),
    );
    await run();
    expect(managerMessages()).toHaveLength(1);
    clock.mockReturnValue(now + 11 * day + hour);
    await run();
    await run();
    expect(managerMessages()).toHaveLength(2);

    const laterPath = `/api/governance/apps/${later.id}`;
    const { body: active } = await api
      .patch(`${laterPath}/lifecycle`)
      .set('Authorization', ownerAuth)
      .send({ lifecycle: 'active' })
      .expect(200);
    const { body: credential } = await api
      .post(`${laterPath}/gateway-key`)
      .set('Authorization', ownerAuth)
      .expect(201);
    const call = () =>
      api
        .post('/api/governance/gateway/chat')
        .set('Authorization', `Bearer ${credential.key}`)
        .send({ model: 'test-model', prompt: 'Synthetic test prompt' });

    const gatewayAccess = async () => {
      const { body } = await api
        .get(`${laterPath}/scorecard`)
        .set('Authorization', ownerAuth)
        .expect(200);
      return body.checks.find(
        ({ name }: { name: string }) => name === 'Gateway access',
      );
    };
    const pauseAt = now + 38 * day;
    clock.mockReturnValue(pauseAt);
    await call().expect(200);
    expect(await gatewayAccess()).toBeUndefined();
    clock.mockReturnValue(pauseAt - 1);
    await run();
    expect(managerMessages()).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          link: `https://portal.example.com/internal/?app=${later.id}`,
        }),
      }),
    );
    await call().expect(200);
    clock.mockReturnValue(pauseAt);
    await call()
      .expect(403)
      .expect(({ body }) => {
        expect(body.error.message).toContain('overdue attestation');
      });
    expect(await gatewayAccess()).toEqual({
      name: 'Gateway access',
      status: 'attention',
      detail:
        'Gateway access is paused until the app owner completes the overdue attestation.',
    });
    const usage = await api
      .get(`${laterPath}/usage`)
      .set('Authorization', ownerAuth)
      .expect(200);
    expect(usage.body.gatewayPause).toBe('attestation-overdue');
    expect(usage.body.blocks).toContainEqual({
      reason: 'attestation-overdue',
      calls: 1,
    });
    await api
      .post(`${laterPath}/attestation`)
      .set('Authorization', ownerAuth)
      .send({ confirmed: true, expectedUpdatedAt: active.updatedAt })
      .expect(200);
    await call().expect(200);
    expect(await gatewayAccess()).toBeUndefined();
    await api
      .get(`${laterPath}/usage`)
      .set('Authorization', ownerAuth)
      .expect(200)
      .expect(({ body }) => {
        expect(body).not.toHaveProperty('gatewayPause');
      });
  });

  it('summarizes only the current owner’s active scorecard issues', async () => {
    const owner = 'user:default/owner';
    const reviewer = 'user:default/reviewer';
    const backup = 'user:default/backup';
    const team = 'group:default/platform';
    const inactive = new Set<string>();
    const catalog = jest
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
    const appsPath = '/api/governance/apps';
    const summaryPath = '/api/governance/owner-scorecard';
    const auth = (user: string) => mockCredentials.user.header(user);
    const register = async (
      name: string,
      appOwner: string,
      lifecycle: 'active' | 'experimental',
    ) => {
      const { body } = await api
        .post(appsPath)
        .set('Authorization', auth(appOwner))
        .send({
          name,
          purpose: 'Test owner scorecard summary.',
          type: 'app',
          platform: 'GitHub',
          sourceUrl: `https://example.com/${name}`,
          owner: appOwner,
          backupOwner: backup,
          team,
          audience: 'personal',
          classification: 'internal',
          lifecycle,
          models: ['test-model'],
        })
        .expect(201);
      return body.id as string;
    };
    const monitored = await register('monitored', owner, 'active');
    const healthy = await register('healthy', owner, 'active');
    await register('experimental', owner, 'experimental');
    await register('other-owner', reviewer, 'active');
    await api
      .post(`${appsPath}/${healthy}/gateway-key`)
      .set('Authorization', auth(owner))
      .expect(201);

    const summary = () =>
      api.get(summaryPath).set('Authorization', auth(owner));
    catalog.mockClear();
    await summary()
      .expect('Cache-Control', 'no-store')
      .expect(200, {
        issues: [{ appId: monitored, checks: ['Gateway key'] }],
        catalogUnavailable: false,
      });
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(catalog.mock.calls[0][0].entityRefs.sort()).toEqual(
      [owner, backup, team].sort(),
    );
    await api.get(summaryPath).set('Authorization', auth(backup)).expect(200, {
      issues: [],
      catalogUnavailable: false,
    });
    await api
      .get(summaryPath)
      .set('Authorization', mockCredentials.service.header())
      .expect(403);

    inactive.add(backup);
    const { body: detail } = await api
      .get(`${appsPath}/${monitored}/scorecard`)
      .set('Authorization', auth(owner))
      .expect(200);
    const { body: degradedOwnership } = await summary().expect(200);
    expect(degradedOwnership.issues).toEqual(
      expect.arrayContaining([
        { appId: healthy, checks: ['Catalog ownership'] },
        {
          appId: monitored,
          checks: detail.checks
            .filter((check: { status: string }) => check.status === 'attention')
            .map((check: { name: string }) => check.name),
        },
      ]),
    );
    catalog.mockResolvedValueOnce({ items: [] });
    await summary().expect(200, {
      issues: [{ appId: monitored, checks: ['Gateway key'] }],
      catalogUnavailable: true,
    });
  });

  it('keeps durable directory access requests private and applies only permitted decisions', async () => {
    const owner = 'user:default/owner';
    const reviewer = 'user:default/reviewer';
    const requester = 'user:default/requester';
    const otherRequester = 'user:default/other-requester';
    const inactive = new Set<string>();
    const db = await databases.init('SQLITE_3');
    const catalog = jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockImplementation(async ({ entityRefs }) => {
        // Cold service authentication can use the governance connection pool.
        await db.raw('select 1');
        return {
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
        };
      });
    const { server } = await startTestBackend({
      features: [
        governancePlugin,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: { governance: { reviewers: [reviewer] } },
        }),
      ],
    });
    const api = request(server);
    const auth = (user: string) => mockCredentials.user.header(user);
    const collection = '/api/governance/apps';
    const create = (name: string, sourceUrl: string) =>
      api
        .post(collection)
        .set('Authorization', auth(owner))
        .send({
          name,
          sourceUrl,
          purpose: 'Assist with staff workflows.',
          type: 'app',
          platform: 'GitHub',
          owner,
          team: 'group:default/operations',
          lifecycle: 'active',
          audience: 'personal',
          classification: 'internal',
          usesAiAtRuntime: false,
        })
        .expect(201);
    const { body: app } = await create(
      'Staff tools',
      'https://example.com/staff-tools',
    );
    const { body: anotherApp } = await create(
      'Other app',
      'https://example.com/other-app',
    );
    const path = `${collection}/${app.id}`;
    const queue = `${path}/directory-requests`;
    const listing = {
      summary: 'Staff tools summary',
      url: 'https://tools.example.com/staff',
    };
    const requestMessage = 'Need access for support.';
    const createRequest = (user: string, message = requestMessage) =>
      api.post(queue).set('Authorization', auth(user)).send({ message });
    const feed = (user: string) =>
      api.get('/api/governance/directory').set('Authorization', auth(user));
    const publish = (expectedUpdatedAt: string) =>
      api
        .put(`${path}/directory`)
        .set('Authorization', auth(owner))
        .send({ ...listing, expectedUpdatedAt })
        .expect(200);
    const decide = (user: string, id: string, status: string) =>
      api
        .patch(`${queue}/${id}`)
        .set('Authorization', auth(user))
        .send({ status });

    await createRequest(requester).expect(404);
    let { body: published } = await publish(app.updatedAt);
    await api
      .post(queue)
      .set('Authorization', mockCredentials.none.header())
      .send({ message: requestMessage })
      .expect(401);
    await api
      .post(queue)
      .set('Authorization', mockCredentials.service.header())
      .send({ message: requestMessage })
      .expect(403);
    await createRequest(requester, '   ').expect(400);
    await createRequest(requester, 'x'.repeat(501)).expect(400);
    const attempts = await Promise.all([
      createRequest(requester, `  ${requestMessage}  `),
      createRequest(requester),
    ]);
    expect(attempts.map(result => result.status).sort()).toEqual([201, 409]);
    const created = attempts.find(result => result.status === 201)?.body;
    expect(created).toEqual({ id: expect.any(String), status: 'pending' });
    const { body: pending } = await createRequest(
      otherRequester,
      'Second private message.',
    ).expect(201);

    const unavailableEntry = { id: app.id, name: app.name };
    const entry = { ...unavailableEntry, ...listing };
    await feed(requester)
      .expect('Cache-Control', 'no-store')
      .expect(200, { apps: [{ ...entry, requestStatus: 'pending' }] });
    await feed(reviewer).expect(200, { apps: [entry] });
    await api.get(queue).set('Authorization', auth(requester)).expect(403);
    const { body: reviewerQueue } = await api
      .get(queue)
      .set('Authorization', auth(reviewer))
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(reviewerQueue.requests).toEqual(
      expect.arrayContaining([
        {
          id: created.id,
          requester,
          message: requestMessage,
          status: 'pending',
          requestedAt: expect.any(String),
        },
        {
          id: pending.id,
          requester: otherRequester,
          message: 'Second private message.',
          status: 'pending',
          requestedAt: expect.any(String),
        },
      ]),
    );
    const { body: ownerInventory } = await api
      .get(collection)
      .set('Authorization', auth(owner))
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(ownerInventory.appsWithPendingAccessRequests).toEqual([app.id]);
    expect(JSON.stringify(ownerInventory)).not.toContain(requestMessage);
    for (const credentials of [
      auth(requester),
      auth(reviewer),
      mockCredentials.service.header(),
    ]) {
      const { body } = await api
        .get(collection)
        .set('Authorization', credentials)
        .expect(200);
      expect(body).not.toHaveProperty('appsWithPendingAccessRequests');
    }
    expect(reviewerQueue.requests).toHaveLength(2);
    expect(reviewerQueue.canApprove).toBe(true);
    await api
      .get(queue)
      .set('Authorization', auth(owner))
      .expect(200, reviewerQueue);

    catalog.mockRejectedValueOnce(new Error('Catalog not available'));
    await api
      .get(queue)
      .set('Authorization', auth(reviewer))
      .expect(200, {
        ...reviewerQueue,
        canApprove: false,
        approvalCheckUnavailable: true,
      });
    catalog.mockRejectedValueOnce(new Error('Catalog not available'));
    await decide(reviewer, created.id, 'approved').expect(503);

    inactive.add(owner);
    await feed(requester)
      .expect('Cache-Control', 'no-store')
      .expect(200, {
        apps: [],
        unavailableRequests: [
          { ...unavailableEntry, requestStatus: 'pending' },
        ],
      });
    await feed(reviewer).expect(200, { apps: [] });
    await api
      .get(queue)
      .set('Authorization', auth(reviewer))
      .expect(200, { ...reviewerQueue, canApprove: false });
    await createRequest(reviewer).expect(404);
    await decide(reviewer, created.id, 'approved').expect(409);
    inactive.delete(owner);
    await feed(requester).expect(200, {
      apps: [{ ...entry, requestStatus: 'pending' }],
    });
    await api
      .get(queue)
      .set('Authorization', auth(reviewer))
      .expect(200, reviewerQueue);

    await decide(requester, created.id, 'approved').expect(403);
    await decide(owner, created.id, 'pending').expect(400);
    await api
      .patch(`${collection}/${anotherApp.id}/directory-requests/${created.id}`)
      .set('Authorization', auth(owner))
      .send({ status: 'declined' })
      .expect(404);
    const readCatalog = catalog.getMockImplementation()!;
    catalog.mockImplementationOnce(async (...args) => {
      ({ body: published } = await publish(published.updatedAt));
      return readCatalog(...args);
    });
    await decide(owner, created.id, 'approved').expect(409);
    await feed(requester).expect(200, {
      apps: [{ ...entry, requestStatus: 'pending' }],
    });

    const { body: approved } = await decide(
      owner,
      created.id,
      'approved',
    ).expect(200);
    expect(approved).toEqual({
      ...reviewerQueue.requests.find(
        (row: { id: string }) => row.id === created.id,
      ),
      status: 'approved',
      decidedBy: owner,
      decidedAt: expect.any(String),
    });
    catalog.mockRejectedValueOnce(new Error('Catalog not available'));
    await decide(reviewer, 'unknown-request', 'approved').expect(404);
    catalog.mockRejectedValueOnce(new Error('Catalog not available'));
    await decide(reviewer, created.id, 'approved').expect(409);
    await decide(reviewer, created.id, 'declined').expect(409);
    const { body: partiallyDecidedInventory } = await api
      .get(collection)
      .set('Authorization', auth(owner))
      .expect(200);
    expect(partiallyDecidedInventory.appsWithPendingAccessRequests).toEqual([
      app.id,
    ]);
    await feed(requester).expect(200, {
      apps: [{ ...entry, requestStatus: 'approved' }],
    });
    await feed(otherRequester).expect(200, {
      apps: [{ ...entry, requestStatus: 'pending' }],
    });

    const { body: unpublished } = await api
      .delete(`${path}/directory`)
      .set('Authorization', auth(owner))
      .send({ expectedUpdatedAt: published.updatedAt })
      .expect(200);
    await feed(requester).expect(200, {
      apps: [],
      unavailableRequests: [{ ...unavailableEntry, requestStatus: 'approved' }],
    });
    await feed(otherRequester).expect(200, {
      apps: [],
      unavailableRequests: [{ ...unavailableEntry, requestStatus: 'pending' }],
    });
    await feed(reviewer).expect(200, { apps: [] });
    await decide(reviewer, pending.id, 'approved').expect(409);
    const { body: declined } = await decide(
      reviewer,
      pending.id,
      'declined',
    ).expect(200);
    expect(declined).toMatchObject({ status: 'declined', decidedBy: reviewer });
    await feed(otherRequester).expect(200, {
      apps: [],
      unavailableRequests: [{ ...unavailableEntry, requestStatus: 'declined' }],
    });
    const { body: decidedInventory } = await api
      .get(collection)
      .set('Authorization', auth(owner))
      .expect(200);
    expect(decidedInventory).not.toHaveProperty(
      'appsWithPendingAccessRequests',
    );
    await api
      .get(queue)
      .set('Authorization', auth(owner))
      .expect(200)
      .expect(({ body }) => {
        expect(body.requests).toEqual(
          expect.arrayContaining([approved, declined]),
        );
        expect(body.canApprove).toBe(false);
      });

    await publish(unpublished.updatedAt);
    await createRequest(requester).expect(409);
    await createRequest(otherRequester).expect(409);
    await feed(requester).expect(200, {
      apps: [{ ...entry, requestStatus: 'approved' }],
    });
    await feed(otherRequester).expect(200, {
      apps: [{ ...entry, requestStatus: 'declined' }],
    });
  });

  it('lets a verified backup take ownership and reapplies the normal ownership safeguards', async () => {
    const owner = 'user:default/owner';
    const backup = 'user:default/backup';
    const replacement = 'user:default/replacement';
    const reviewer = 'user:default/reviewer';
    const engineer = 'user:default/engineer';
    const team = 'group:default/operations';
    const engineeringGroup = 'group:default/engineering';
    const inactive = new Set<string>();
    const missing = new Set<string>();
    const catalogEntity = (ref: string): Entity | undefined => {
      if (missing.has(ref)) return undefined;
      return {
        apiVersion: 'backstage.io/v1alpha1',
        kind: ref.startsWith('group:') ? 'Group' : 'User',
        metadata: {
          name: ref.split('/')[1],
          annotations: {
            'governance.backstage.io/active': inactive.has(ref)
              ? 'false'
              : 'true',
          },
        },
        relations:
          ref === engineer
            ? [{ type: 'memberOf', targetRef: engineeringGroup }]
            : [],
      };
    };
    const catalog = jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockImplementation(async ({ entityRefs }) => ({
        items: entityRefs.map(catalogEntity),
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
              graduationGroups: [engineeringGroup],
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
    const collection = '/api/governance/apps';
    const appInput = {
      purpose: 'Maintain a staff workflow.',
      type: 'app',
      platform: 'GitHub',
      owner,
      backupOwner: backup,
      team,
      lifecycle: 'active',
      audience: 'team',
      classification: 'internal',
      models: ['test-model'],
    };
    const create = (name: string, changes: Record<string, unknown> = {}) =>
      api
        .post(collection)
        .set('Authorization', auth(owner))
        .send({
          ...appInput,
          name,
          sourceUrl: `https://example.com/${name}`,
          ...changes,
        })
        .expect(201);
    const { body: shared } = await create('Shared');
    const criticalInput = {
      lifecycle: 'experimental',
      audience: 'external',
      deliveryStage: 'production',
    };
    const { body: critical } = await create('Critical', criticalInput);
    const { body: overlappingRoles } = await create('Overlapping-roles', {
      ...criticalInput,
      backupOwner: engineer,
    });
    const { body: personal } = await create('Personal', {
      audience: 'personal',
    });
    const { body: retiredApp } = await create('Retired', {
      audience: 'personal',
    });
    const priorHostedConfig = {
      type: 'provider-hosted app',
      lifecycle: 'experimental',
      hosted: {
        provider: 'Example AI',
        workspace: 'Removed workspace',
        sharing: 'private',
        dataAccess: 'none',
      },
    };
    const { body: oldHosted } = await create('Old-hosted', {
      ...priorHostedConfig,
      audience: 'personal',
    });
    const { body: oldCriticalHosted } = await create('Critical-hosted', {
      ...priorHostedConfig,
      audience: 'external',
    });
    for (const previouslyActive of [oldHosted, oldCriticalHosted]) {
      // Represent apps that were activated before their workspace approval was removed.
      await db('governance_apps')
        .where({ id: previouslyActive.id })
        .update({
          payload: JSON.stringify({ ...previouslyActive, lifecycle: 'active' }),
        });
    }
    const path = (id: string) => `${collection}/${id}`;
    const handover = (id: string) => `${path(id)}/backup-handover`;
    const status = (id: string, actor = backup) =>
      api.get(handover(id)).set('Authorization', auth(actor));
    const takeOwnership = (
      id: string,
      expectedUpdatedAt: string,
      newBackup?: string,
      actor = backup,
    ) =>
      api
        .post(handover(id))
        .set('Authorization', auth(actor))
        .send({ expectedUpdatedAt, backupOwner: newBackup });
    const issue = (id: string) =>
      api
        .post(`${path(id)}/gateway-key`)
        .set('Authorization', auth(owner))
        .expect(201);
    const { body: sharedKey } = await issue(shared.id);
    const { body: attested } = await api
      .post(`${path(shared.id)}/attestation`)
      .set('Authorization', auth(owner))
      .send({ confirmed: true, expectedUpdatedAt: shared.updatedAt })
      .expect(200);
    async function activateAndGraduate(app: { id: string; updatedAt: string }) {
      const { body: approved } = await api
        .post(`${path(app.id)}/reviews`)
        .set('Authorization', auth(reviewer))
        .send({
          status: 'approved',
          notes: 'Reviewed.',
          expectedUpdatedAt: app.updatedAt,
        })
        .expect(200);
      const { body: activated } = await api
        .patch(`${path(app.id)}/lifecycle`)
        .set('Authorization', auth(owner))
        .send({ lifecycle: 'active', expectedUpdatedAt: approved.updatedAt })
        .expect(200);
      const { body: key } = await issue(app.id);
      const { body: nomination } = await api
        .post(`${path(app.id)}/graduation`)
        .set('Authorization', auth(owner))
        .send({ nominee: engineer, expectedUpdatedAt: activated.updatedAt })
        .expect(200);
      const { body: graduated } = await api
        .patch(`${path(app.id)}/graduation`)
        .set('Authorization', auth(engineer))
        .send({ decision: 'accept', expectedUpdatedAt: nomination.updatedAt })
        .expect(200);
      return { key, graduated };
    }
    const { key: criticalKey, graduated } = await activateAndGraduate(critical);
    const { key: overlappingKey, graduated: overlappingGraduation } =
      await activateAndGraduate(overlappingRoles);
    const { body: retired } = await api
      .patch(`${path(retiredApp.id)}/lifecycle`)
      .set('Authorization', auth(owner))
      .send({ lifecycle: 'retired', expectedUpdatedAt: retiredApp.updatedAt })
      .expect(200);

    const day = 86_400_000;
    const startedAt = Date.parse(shared.activeSince);
    jest.spyOn(Date, 'now').mockReturnValue(startedAt + 91 * day);
    await db('governance_gateway_usage').insert({
      id: 'old-handover-usage',
      app_id: shared.id,
      model: 'test-model',
      execution_mode: 'openai',
      created_at: new Date(startedAt + 1),
      estimated_cost_nanos_usd: 0,
    });
    const { body: awaitingRetirement } = await api
      .post(`${path(shared.id)}/retirement-review`)
      .set('Authorization', auth(reviewer))
      .send({ expectedUpdatedAt: attested.updatedAt })
      .expect(200);
    expect(awaitingRetirement.retirementReview.status).toBe('pending');
    const before = awaitingRetirement.updatedAt;

    await status(shared.id, owner).expect(403);
    await status(shared.id, reviewer).expect(403);
    await takeOwnership(shared.id, before, replacement, reviewer).expect(403);
    await status(shared.id)
      .expect('Cache-Control', 'no-store')
      .expect(200, { available: false, backupRequired: true });
    await takeOwnership(shared.id, before, replacement).expect(409);

    catalog.mockImplementationOnce(async ({ entityRefs }) => ({
      items: entityRefs.map(ref =>
        ref === owner ? (false as unknown as Entity) : catalogEntity(ref),
      ),
    }));
    await status(shared.id).expect(503);
    catalog.mockImplementationOnce(async ({ entityRefs }) => ({
      items: entityRefs.map(ref =>
        ref === owner ? (false as unknown as Entity) : catalogEntity(ref),
      ),
    }));
    await takeOwnership(shared.id, before, replacement).expect(503);

    inactive.add(owner);
    inactive.add(team);
    await status(shared.id).expect(200, {
      available: false,
      backupRequired: true,
    });
    await takeOwnership(shared.id, before, replacement).expect(409);
    inactive.delete(team);
    inactive.add(backup);
    await status(shared.id).expect(200, {
      available: false,
      backupRequired: true,
    });
    await takeOwnership(shared.id, before, replacement).expect(409);
    inactive.delete(backup);
    catalog.mockRejectedValueOnce(new Error('Catalog not available'));
    await status(shared.id).expect(503);
    catalog.mockRejectedValueOnce(new Error('Catalog not available'));
    await takeOwnership(shared.id, before, replacement).expect(503);
    await status(shared.id).expect(200, {
      available: true,
      backupRequired: true,
    });
    await takeOwnership(shared.id, attested.updatedAt, replacement).expect(409);
    await takeOwnership(shared.id, before).expect(400);
    await takeOwnership(shared.id, before, backup).expect(400);
    await takeOwnership(shared.id, before, owner).expect(400);
    inactive.add(replacement);
    await takeOwnership(shared.id, before, replacement).expect(400);
    inactive.delete(replacement);

    const { body: transferred } = await takeOwnership(
      shared.id,
      before,
      replacement,
    ).expect(200);
    expect(transferred).toMatchObject({
      owner: backup,
      backupOwner: replacement,
      team,
      lifecycle: 'active',
      tier: 2,
      lastReview: null,
      nextReview: transferred.updatedAt,
      activeSince: shared.activeSince,
      classification: shared.classification,
      models: shared.models,
    });
    expect(transferred).not.toHaveProperty('retirementReview');
    await status(shared.id).expect(403);
    await status(shared.id, replacement).expect(200, {
      available: false,
      backupRequired: true,
    });

    inactive.delete(owner);
    missing.add(owner);
    await status(oldHosted.id).expect(200, {
      available: false,
      backupRequired: false,
    });
    await takeOwnership(oldHosted.id, oldHosted.updatedAt).expect(409);
    await status(oldCriticalHosted.id).expect(200, {
      available: true,
      backupRequired: true,
    });
    const { body: hostedReopened } = await takeOwnership(
      oldCriticalHosted.id,
      oldCriticalHosted.updatedAt,
      replacement,
    ).expect(200);
    expect(hostedReopened).toMatchObject({
      lifecycle: 'experimental',
      reviewStatus: 'pending',
      owner: backup,
    });
    const { body: reassigned } = await takeOwnership(
      critical.id,
      graduated.updatedAt,
      replacement,
    ).expect(200);
    expect(reassigned).toMatchObject({
      owner: backup,
      backupOwner: replacement,
      team,
      lifecycle: 'experimental',
      tier: 3,
      reviewStatus: 'pending',
      lastReview: null,
      nextReview: null,
      deliveryStage: 'production',
    });
    expect(reassigned).not.toHaveProperty('graduation');
    expect(reassigned).not.toHaveProperty('activeSince');

    await status(personal.id).expect(200, {
      available: true,
      backupRequired: false,
    });
    const { body: personalHandover } = await takeOwnership(
      personal.id,
      personal.updatedAt,
    ).expect(200);
    expect(personalHandover.owner).toBe(backup);
    expect(personalHandover).not.toHaveProperty('backupOwner');
    await status(retired.id).expect(200, {
      available: false,
      backupRequired: false,
    });
    await takeOwnership(retired.id, retired.updatedAt).expect(409);

    for (const { key } of [sharedKey, criticalKey]) {
      await api
        .post('/api/governance/gateway/chat')
        .set('Authorization', `Bearer ${key}`)
        .send({
          model: 'test-model',
          prompt: 'Verify the former key is closed.',
        })
        .expect(401);
    }
    const { body: history } = await api
      .get(`${path(shared.id)}/history`)
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(JSON.parse(history.events.at(-1).event)).toMatchObject({
      action: 'ownership-handover',
      actor: backup,
      record: { owner: backup, backupOwner: replacement, team },
    });
    expect(history.keyEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'revoked', actor: backup }),
      ]),
    );

    await status(overlappingRoles.id, engineer).expect(200, {
      available: false,
      backupRequired: true,
    });
    await takeOwnership(
      overlappingRoles.id,
      overlappingGraduation.updatedAt,
      replacement,
      engineer,
    ).expect(403);
    const { body: unchanged } = await api
      .get(path(overlappingRoles.id))
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(unchanged).toMatchObject({
      owner,
      backupOwner: engineer,
      updatedAt: overlappingGraduation.updatedAt,
      lifecycle: 'active',
      reviewStatus: 'approved',
      graduation: { nominee: engineer, status: 'accepted' },
    });

    missing.delete(owner);
    await api
      .post('/api/governance/gateway/chat')
      .set('Authorization', `Bearer ${overlappingKey.key}`)
      .send({
        model: 'test-model',
        prompt: 'Verify the existing key still works.',
      })
      .expect(200);
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
              graduationGroups: [group],
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
      models: ['test-model'],
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

    const removeHandoff = (
      expectedUpdatedAt: string,
      actor = owner,
      reason?: string,
    ) =>
      api
        .delete(route)
        .set('Authorization', auth(actor))
        .send({ expectedUpdatedAt, reason });
    await removeHandoff(before).expect(409);
    const abandoned = await nominate(engineer, before).expect(200);
    await removeHandoff(before).expect(409);
    await removeHandoff(abandoned.body.updatedAt, engineer).expect(403);
    activeEngineer = false;
    const cancelled = await removeHandoff(
      abandoned.body.updatedAt,
      reviewer,
    ).expect(200);
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
    await removeHandoff(accepted.body.updatedAt).expect(400);

    const renamed = await edit(
      { name: 'Renamed workflow', deliveryStage: 'production' },
      accepted.body.updatedAt,
    ).expect(200);
    expect(renamed.body.graduation).toEqual(accepted.body.graduation);
    const approved = await api
      .post(`${appPath}/reviews`)
      .set('Authorization', auth(reviewer))
      .send({
        status: 'approved',
        expectedUpdatedAt: renamed.body.updatedAt,
        notes: 'Production review completed.',
      })
      .expect(200);
    const activated = await api
      .patch(`${appPath}/lifecycle`)
      .set('Authorization', auth(owner))
      .send({ lifecycle: 'active', expectedUpdatedAt: approved.body.updatedAt })
      .expect(200);
    const {
      body: { key },
    } = await api
      .post(`${appPath}/gateway-key`)
      .set('Authorization', auth(owner))
      .expect(201);
    const ending = 'Engineering coverage changed.';
    await removeHandoff(activated.body.updatedAt, outside, ending).expect(403);
    await removeHandoff(activated.body.updatedAt, engineer, ending).expect(403);
    await removeHandoff(renamed.body.updatedAt, reviewer, ending).expect(409);
    await removeHandoff(activated.body.updatedAt, reviewer, '   ').expect(400);
    await removeHandoff(
      activated.body.updatedAt,
      reviewer,
      'x'.repeat(501),
    ).expect(400);
    const ended = await removeHandoff(
      activated.body.updatedAt,
      reviewer,
      `  ${ending}  `,
    ).expect(200);
    expect(ended.body).not.toHaveProperty('graduation');
    expect(ended.body).toMatchObject({
      owner,
      tier: activated.body.tier,
      lifecycle: 'active',
      activeSince: activated.body.activeSince,
      reviewStatus: 'approved',
      lastReview: approved.body.lastReview,
      nextReview: approved.body.nextReview,
      reviewNotes: 'Production review completed.',
    });
    await api
      .post('/api/governance/gateway/chat')
      .set('Authorization', `Bearer ${key}`)
      .send({ model: 'test-model', prompt: 'Check handoff continuity.' })
      .expect(200);
    const nextNomination = await nominate(
      engineer,
      ended.body.updatedAt,
    ).expect(200);
    expect(nextNomination.body.graduation).toMatchObject({
      status: 'pending',
      nominee: engineer,
    });
    const reverted = await edit(
      { deliveryStage: 'pilot' },
      nextNomination.body.updatedAt,
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
    const endAudit = history.events.find(
      (item: { event: string }) =>
        JSON.parse(item.event).action === 'graduation-ended',
    );
    expect(JSON.parse(endAudit.event)).toMatchObject({
      actor: reviewer,
      graduationNominee: engineer,
      graduationReason: ending,
    });
    expect(JSON.parse(endAudit.event).record).not.toHaveProperty('graduation');
    expect(endAudit.digest).toBe(
      createHash('sha256').update(endAudit.event).digest('hex'),
    );
    expect(
      events.find(
        (event: { action: string }) => event.action === 'graduation-cancelled',
      ),
    ).not.toHaveProperty('graduationReason');
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
      .delete(`${secondPath}/graduation`)
      .set('Authorization', auth(reviewer))
      .send({
        expectedUpdatedAt: handoff.body.updatedAt,
        reason: 'I want to end my handoff.',
      })
      .expect(403);
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
    await api
      .patch(`${secondPath}/lifecycle`)
      .set('Authorization', auth(reviewer))
      .send({ lifecycle: 'retired', expectedUpdatedAt: handoff.body.updatedAt })
      .expect(403);
    const editAsNominee = (changes: Record<string, unknown>) =>
      api
        .put(secondPath)
        .set('Authorization', auth(reviewer))
        .send({
          ...appInput,
          sourceUrl: second.body.sourceUrl,
          deliveryStage: 'production',
          expectedUpdatedAt: handoff.body.updatedAt,
          ...changes,
        });
    await editAsNominee({ deliveryStage: 'pilot' }).expect(403);
    await editAsNominee({ owner: outside }).expect(403);
    await editAsNominee({ audience: 'team' }).expect(403);
    const unrelated = await editAsNominee({
      name: 'Updated handoff title',
    }).expect(200);
    expect(unrelated.body.graduation).toEqual(handoff.body.graduation);
    const ownerEnded = await api
      .delete(`${secondPath}/graduation`)
      .set('Authorization', auth(owner))
      .send({
        expectedUpdatedAt: unrelated.body.updatedAt,
        reason: 'The owner reassigned engineering coverage.',
      })
      .expect(200);
    expect(ownerEnded.body).not.toHaveProperty('graduation');
  });

  it('previews hosted inventory for reviewers without creating app records', async () => {
    const reviewer = 'user:default/reviewer';
    const db = await databases.init('SQLITE_3');
    const { server } = await startTestBackend({
      features: [
        governancePlugin,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: { governance: { reviewers: [reviewer] } },
        }),
      ],
    });
    const api = request(server);
    const preview = (user: string) =>
      api
        .post('/api/governance/discovery/hosted/preview')
        .set('Authorization', mockCredentials.user.header(user));
    const known = {
      name: 'Existing hosted assistant',
      provider: 'Example AI',
      workspace: 'Enterprise',
      sourceUrl: 'https://example.com/apps/known',
    };
    const candidate = {
      ...known,
      name: 'Unregistered hosted assistant',
      sourceUrl: 'https://example.com/apps/new',
    };
    await db('governance_apps').insert({
      id: 'known',
      source_key: known.sourceUrl,
      payload: JSON.stringify({
        type: 'provider-hosted app',
        hosted: { provider: known.provider, workspace: known.workspace },
      }),
      revision: 0,
    });
    await preview('user:default/builder')
      .send({ apps: [known] })
      .expect(403);
    await preview(reviewer)
      .send({
        apps: [
          { ...candidate, sourceUrl: 'https://name:secret@example.com/app' },
        ],
      })
      .expect(400);
    await preview(reviewer)
      .send({
        apps: [
          known,
          { ...known, sourceUrl: 'https://EXAMPLE.com/apps/known' },
        ],
      })
      .expect(400);
    for (const apps of [
      [known, candidate],
      [candidate, known],
    ]) {
      await preview(reviewer)
        .send({ apps })
        .expect('Cache-Control', 'no-store')
        .expect(200, {
          apps: apps.map(app =>
            app === known ? { ...app, appId: 'known' } : app,
          ),
        });
    }
    const moved = { ...known, workspace: 'Different workspace' };
    await preview(reviewer)
      .send({ apps: [moved] })
      .expect(200, {
        apps: [
          {
            ...moved,
            appId: 'known',
            mismatch: 'workspace',
            registeredWorkspace: {
              provider: known.provider,
              workspace: known.workspace,
            },
          },
        ],
      });
    await db('governance_apps')
      .where({ id: 'known' })
      .update({ payload: JSON.stringify({ type: 'app' }) });
    await preview(reviewer)
      .send({ apps: [known] })
      .expect(200, {
        apps: [{ ...known, appId: 'known', mismatch: 'app-type' }],
      });
    expect(await db('governance_apps').pluck('id')).toEqual(['known']);
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
    const evidence = (id: number, user: string) =>
      api
        .get(`${discovery}/${id}/sdk-evidence`)
        .set('Authorization', auth(user));
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
      await evidence(id, owner).expect(404);
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
    await api
      .get(`${discovery}/100/sdk-evidence`)
      .set('Authorization', mockCredentials.none.header())
      .expect(401);
    await api
      .get(`${discovery}/100/sdk-evidence`)
      .set('Authorization', mockCredentials.service.header())
      .expect(403);
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

    github
      .mockResolvedValueOnce(
        Response.json(
          {
            dependencies: { openai: '^4', 'unrelated-package': '^1' },
            devDependencies: { '@anthropic-ai/sdk': '^1' },
          },
          {
            headers: {
              'Content-Type': 'application/vnd.github.raw+json; charset=utf-8',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response('google_genai>=1\n# langchain', {
          headers: { 'Content-Type': 'application/vnd.github.raw+json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          "[project]\ndependencies = ['anthropic']\n" +
            "[project.optional-dependencies]\nresearch = ['litellm']",
          { headers: { 'Content-Type': 'application/vnd.github.raw+json' } },
        ),
      );
    await evidence(100, owner)
      .expect('Cache-Control', 'no-store')
      .expect(200, {
        manifests: [
          {
            path: 'package.json',
            status: 'checked',
            packages: ['@anthropic-ai/sdk', 'openai'],
          },
          {
            path: 'requirements.txt',
            status: 'checked',
            packages: ['google-genai'],
          },
          {
            path: 'pyproject.toml',
            status: 'checked',
            packages: ['anthropic', 'litellm'],
          },
        ],
      });
    const evidencePaths = [
      'package.json',
      'requirements.txt',
      'pyproject.toml',
    ];
    expect(github.mock.calls.slice(-3)).toEqual(
      evidencePaths.map(path => [
        new URL(`https://api.github.com/repos/example/helper/contents/${path}`),
        expect.objectContaining({
          headers: {
            Accept: 'application/vnd.github.raw+json',
            'User-Agent': 'Frontstage',
          },
          redirect: 'error',
          signal: expect.any(AbortSignal),
        }),
      ]),
    );
    expect(await db('governance_apps')).toEqual([]);

    github
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await evidence(200, reviewer).expect(200, {
      manifests: [
        { path: 'package.json', status: 'missing', packages: [] },
        { path: 'requirements.txt', status: 'checked', packages: [] },
        { path: 'pyproject.toml', status: 'missing', packages: [] },
      ],
    });
    expect(github.mock.calls.slice(-3)).toEqual(
      evidencePaths.map(path => [
        new URL(
          `https://api.github.com/repos/example/private/contents/${path}`,
        ),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
          }),
          redirect: 'error',
        }),
      ]),
    );

    github
      .mockResolvedValueOnce(new Response('invalid JSON'))
      .mockResolvedValueOnce(new Response('x'.repeat(100_001)))
      .mockResolvedValueOnce(new Response('[project]\ndependencies = ['));
    await evidence(100, owner).expect(200, {
      manifests: [
        { path: 'package.json', status: 'unavailable', packages: [] },
        { path: 'requirements.txt', status: 'unavailable', packages: [] },
        { path: 'pyproject.toml', status: 'unavailable', packages: [] },
      ],
    });

    github
      .mockResolvedValueOnce(
        Response.json(
          { type: 'submodule', path: 'package.json' },
          {
            headers: { 'Content-Type': 'application/vnd.github.object+json' },
          },
        ),
      )
      .mockResolvedValueOnce(Response.json({ type: 'dir', entries: [] }))
      .mockResolvedValueOnce(Response.json({ type: 'dir', entries: [] }));
    await evidence(100, owner).expect(200, {
      manifests: [
        { path: 'package.json', status: 'unavailable', packages: [] },
        { path: 'requirements.txt', status: 'unavailable', packages: [] },
        { path: 'pyproject.toml', status: 'unavailable', packages: [] },
      ],
    });

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
    for (const id of [100, 300, 999]) await evidence(id, reviewer).expect(404);
    expect(github).not.toHaveBeenCalled();

    github
      .mockImplementationOnce(async () => {
        await db('governance_discovered_repositories')
          .where({ id: '400' })
          .update({ is_stale: true });
        return Response.json(
          { dependencies: { openai: '^4' } },
          { headers: { 'Content-Type': 'application/vnd.github.raw+json' } },
        );
      })
      .mockResolvedValueOnce(new Response('openai'))
      .mockResolvedValueOnce(
        new Response("[project]\ndependencies = ['openai']"),
      );
    await evidence(400, reviewer).expect(404);
    github.mockClear();
    await evidence(400, reviewer).expect(404);
    expect(github).not.toHaveBeenCalled();

    jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockImplementation(async ({ entityRefs }) => ({
        items: entityRefs.map(ref => ({
          apiVersion: 'backstage.io/v1alpha1',
          kind: ref.startsWith('group:') ? 'Group' : 'User',
          metadata: { name: ref.split('/')[1] },
        })),
      }));
    await api
      .post('/api/governance/apps')
      .set('Authorization', auth(owner))
      .send({
        ...descriptor.spec,
        sourceUrl: 'https://github.com/example/private',
      })
      .expect(201);
    await evidence(200, owner).expect(404);
    await api
      .post('/api/governance/apps')
      .set('Authorization', auth(owner))
      .send(descriptor.spec)
      .expect(201);
    await preview(100, owner).expect(200, { status: 'unavailable' });
    expect(github).not.toHaveBeenCalled();
    github
      .mockResolvedValueOnce(new Response('{"dependencies":{"openai":"^4"}}'))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await evidence(100, owner).expect(200, {
      manifests: [
        { path: 'package.json', status: 'checked', packages: ['openai'] },
        { path: 'requirements.txt', status: 'missing', packages: [] },
        { path: 'pyproject.toml', status: 'missing', packages: [] },
      ],
    });
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
    const detail = (actor = owner) =>
      api.get(path).set('Authorization', auth(actor)).expect(200);
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
    let start = app.body.updatedAt;
    const old = currentTime - 90 * day;
    await usage('simulation-only', old, 'simulation');
    await open(start).expect(400);
    await db('governance_gateway_keys').insert({
      app_id: app.body.id,
      environment: 'production',
      digest: 'a'.repeat(64),
    });
    const zeroTrafficCutoff = Date.parse(app.body.activeSince) + 90 * day;
    clock.mockReturnValue(zeroTrafficCutoff - 1);
    expect((await usageReport()).body.retirementReview.apps).toEqual([]);
    await open(start).expect(400);
    clock.mockReturnValue(zeroTrafficCutoff);
    expect((await usageReport()).body.retirementReview.apps).toEqual([
      {
        appId: app.body.id,
        lastLiveCall: null,
        activeSince: app.body.activeSince,
      },
    ]);
    const zeroTrafficReview = await open(start).expect(200);
    expect(zeroTrafficReview.body.retirementReview.lastLiveCall).toBeNull();
    expect((await detail()).body.retirementReview).not.toHaveProperty(
      'liveActivityChangedAt',
    );
    await usage('just-too-recent', old + 1);
    expect((await detail()).body.retirementReview).toMatchObject({
      lastLiveCall: null,
      liveActivityChangedAt: new Date(old + 1).toISOString(),
    });
    await decide('retire', zeroTrafficReview.body.updatedAt).expect(409);
    const keptAfterFirstCall = await decide(
      'keep',
      zeroTrafficReview.body.updatedAt,
    ).expect(200);
    start = keptAfterFirstCall.body.updatedAt;
    clock.mockReturnValue(currentTime);
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
    await usage('resumed-simulation', later + 1, 'simulation');
    const resumed = await detail(reviewer);
    expect(resumed.body).toMatchObject({
      updatedAt: reopened.body.updatedAt,
      retirementReview: {
        status: 'pending',
        lastLiveCall: candidate.lastLiveCall,
        liveActivityChangedAt: new Date(later).toISOString(),
      },
    });
    expect((await detail(teammate)).body).not.toHaveProperty(
      'retirementReview',
    );
    const list = await api
      .get('/api/governance/apps')
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(list.body.apps).toHaveLength(1);
    expect(list.body.apps[0].retirementReview).toEqual(
      reopened.body.retirementReview,
    );
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

  it('updates review ticket metadata without changing approval or gateway access', async () => {
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
    const api = request(server);
    const auth = (user: string) => mockCredentials.user.header(user);
    const collection = '/api/governance/apps';
    const appInput = {
      name: 'Workflow assistant',
      purpose: 'Support internal workflow approvals.',
      type: 'assistant',
      platform: 'GitHub',
      sourceUrl: 'https://example.com/workflow-assistant',
      owner,
      backupOwner: backup,
      team: 'group:default/engineering',
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
    const { body: approved } = await api
      .post(`${path}/reviews`)
      .set('Authorization', auth(reviewer))
      .send({
        status: 'approved',
        notes: 'Approved application.',
        expectedUpdatedAt: app.updatedAt,
      })
      .expect(200);
    const setLifecycle = (lifecycle: string, expectedUpdatedAt: string) =>
      api
        .patch(`${path}/lifecycle`)
        .set('Authorization', auth(owner))
        .send({ lifecycle, expectedUpdatedAt })
        .expect(200);
    const { body: active } = await setLifecycle('active', approved.updatedAt);
    const {
      body: { key },
    } = await api
      .post(`${path}/gateway-key`)
      .set('Authorization', auth(owner))
      .expect(201);
    const ticketPath = `${path}/review-ticket`;
    const patch = (
      url: string | null | undefined,
      expectedUpdatedAt: string,
      actor = owner,
    ) =>
      api
        .patch(ticketPath)
        .set('Authorization', auth(actor))
        .send({ url, expectedUpdatedAt });
    const firstUrl = 'https://tickets.example.com/FRONT-1';
    const secondUrl = 'http://tickets.example.com/FRONT-2';

    for (const credentials of [
      { header: mockCredentials.none.header(), status: 401 },
      { header: mockCredentials.service.header(), status: 403 },
    ]) {
      await api
        .patch(ticketPath)
        .set('Authorization', credentials.header)
        .send({ url: firstUrl, expectedUpdatedAt: active.updatedAt })
        .expect(credentials.status);
    }
    await patch(firstUrl, active.updatedAt, backup).expect(403);
    await patch(firstUrl, approved.updatedAt).expect(409);
    for (const value of [
      undefined,
      '  ',
      'mailto:support@example.com',
      'https://sample:private@tickets.example.com/FRONT-1',
      'https://sample@tickets.example.com/FRONT-1',
      `https://tickets.example.com/${'x'.repeat(2048)}`,
    ]) {
      await patch(value, active.updatedAt).expect(400);
    }

    const { body: linked } = await patch(
      `  ${firstUrl}  `,
      active.updatedAt,
    ).expect(200);
    expect(linked).toEqual({
      ...active,
      updatedAt: expect.any(String),
      reviewTicketUrl: firstUrl,
    });
    expect(linked.updatedAt).not.toBe(active.updatedAt);
    await patch(firstUrl, active.updatedAt).expect(409);
    await patch(`  ${firstUrl}  `, linked.updatedAt)
      .expect('Cache-Control', 'no-store')
      .expect(200, linked);
    const { body: unrelated } = await api
      .get(path)
      .set('Authorization', auth('user:default/teammate'))
      .expect(200);
    expect(unrelated).not.toHaveProperty('reviewTicketUrl');

    const { body: relinked } = await patch(
      secondUrl,
      linked.updatedAt,
      reviewer,
    ).expect(200);
    expect(relinked.reviewTicketUrl).toBe(secondUrl);
    const { body: cleared } = await patch(null, relinked.updatedAt).expect(200);
    expect(cleared).toEqual({ ...active, updatedAt: expect.any(String) });
    await patch(null, cleared.updatedAt).expect(200, cleared);
    await api
      .post('/api/governance/gateway/chat')
      .set('Authorization', `Bearer ${key}`)
      .send({
        model: 'test-model',
        prompt: 'Confirm the gateway remains available.',
      })
      .expect(200);
    const { body: history } = await api
      .get(`${path}/history`)
      .set('Authorization', auth(reviewer))
      .expect(200);
    const changes = history.events
      .map((row: { event: string; digest: string }) => ({
        ...JSON.parse(row.event),
        digest: row.digest,
      }))
      .filter(
        (row: { action: string }) => row.action === 'review-ticket-updated',
      );
    expect(
      changes.map(
        (row: { actor: string; record: { reviewTicketUrl?: string } }) => [
          row.actor,
          row.record.reviewTicketUrl,
        ],
      ),
    ).toEqual([
      [owner, firstUrl],
      [reviewer, secondUrl],
      [owner, undefined],
    ]);
    expect(changes[1].previousDigest).toBe(changes[0].digest);
    expect(changes[2].previousDigest).toBe(changes[1].digest);

    const { body: retired } = await setLifecycle('retired', cleared.updatedAt);
    await patch(firstUrl, retired.updatedAt).expect(400);
    const { body: lowRisk } = await api
      .post(collection)
      .set('Authorization', auth(owner))
      .send({
        ...appInput,
        audience: 'personal',
        sourceUrl: 'https://example.com/personal-workflow-assistant',
      })
      .expect(201);
    await api
      .patch(`${collection}/${lowRisk.id}/review-ticket`)
      .set('Authorization', auth(owner))
      .send({ url: firstUrl, expectedUpdatedAt: lowRisk.updatedAt })
      .expect(400);
  });

  it('records hosted workspace attestations independently and clears them when ownership or settings change', async () => {
    const owner = 'user:default/owner';
    const nextOwner = 'user:default/next';
    const reviewer = 'user:default/reviewer';
    let ownerActive = true;
    jest
      .spyOn(CatalogClient.prototype, 'getEntitiesByRefs')
      .mockImplementation(async ({ entityRefs }) => ({
        items: entityRefs.map(ref => ({
          apiVersion: 'backstage.io/v1alpha1',
          kind: ref.startsWith('group:') ? 'Group' : 'User',
          metadata: {
            name: ref.split('/')[1],
            annotations: {
              'governance.backstage.io/active': String(
                ref !== owner || ownerActive,
              ),
            },
          },
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
              approvedHostedWorkspaces: [
                { provider: 'Example AI', workspace: 'Company' },
                {
                  provider: 'Example AI',
                  workspace: 'Limited',
                  allowedSharing: ['private'],
                  allowedDataAccess: ['none'],
                },
              ],
            },
          },
        }),
      ],
    });
    const api = request(server);
    const auth = (user: string) => mockCredentials.user.header(user);
    const apps = '/api/governance/apps';
    const create = (workspace: string, actor = owner, fromSnapshot = false) =>
      api
        .post(fromSnapshot ? `${apps}?source=hosted-snapshot` : apps)
        .set('Authorization', auth(actor))
        .send({
          name: `Hosted ${workspace}`,
          purpose: 'Track workspace governance.',
          sourceUrl: `https://example.com/hosted-${workspace}`,
          type: 'provider-hosted app',
          platform: 'Example AI',
          owner,
          backupOwner: 'user:default/backup',
          team: 'group:default/platform',
          lifecycle: 'experimental',
          audience: 'team',
          classification: 'internal',
          models: ['test-model'],
          hosted: {
            provider: 'Example AI',
            workspace,
            sharing: 'private',
            dataAccess: 'none',
          },
        });
    await create('Company', owner, true).expect(403);
    const { body: original } = await create('Company', reviewer, true).expect(
      201,
    );
    const { body: unapproved } = await create('Other').expect(201);
    expect(original.discoverySource).toBe('hosted snapshot');
    expect(unapproved.discoverySource).toBe('registered');
    const initialHistory = await api
      .get(`${apps}/${original.id}/history`)
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(
      JSON.parse(initialHistory.body.events[0].event).record.discoverySource,
    ).toBe('hosted snapshot');
    expect(original.hostedWorkspaceAllowed).toBe(true);
    expect(unapproved.hostedWorkspaceAllowed).toBe(false);
    const attest = (
      app: { id: string; updatedAt: string },
      actor = owner,
      confirmed = true,
    ) =>
      api
        .post(`${apps}/${app.id}/hosted-attestation`)
        .set('Authorization', auth(actor))
        .send({ confirmed, expectedUpdatedAt: app.updatedAt });
    await attest(unapproved).expect(400);
    await attest(original, reviewer).expect(403);
    await attest(original, owner, false).expect(400);

    const path = `${apps}/${original.id}`;
    const { body: active } = await api
      .patch(`${path}/lifecycle`)
      .set('Authorization', auth(owner))
      .send({ lifecycle: 'active', expectedUpdatedAt: original.updatedAt })
      .expect(200);
    const scorecard = async () => {
      const { body } = await api
        .get(`${path}/scorecard`)
        .set('Authorization', auth(reviewer))
        .expect(200);
      return body.checks.find(
        (check: { name: string }) =>
          check.name === 'Hosted workspace attestation',
      );
    };
    expect(await scorecard()).toMatchObject({ status: 'attention' });
    await attest(original).expect(409);
    ownerActive = false;
    await attest(active).expect(400);
    expect(await scorecard()).toMatchObject({ status: 'attention' });
    ownerActive = true;
    const { body: confirmed } = await attest(active)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    expect(confirmed).toMatchObject({
      lifecycle: active.lifecycle,
      reviewStatus: active.reviewStatus,
      lastReview: active.lastReview,
      nextReview: active.nextReview,
      hostedAttestation: {
        at: confirmed.updatedAt,
        nextDue: new Date(
          Date.parse(confirmed.updatedAt) + 90 * 86_400_000,
        ).toISOString(),
      },
    });
    expect(await scorecard()).toMatchObject({ status: 'pass' });
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(confirmed.hostedAttestation.nextDue));
    expect(await scorecard()).toMatchObject({
      status: 'attention',
      detail: expect.stringContaining('Overdue'),
    });

    const edit = (
      record: { id: string; updatedAt: string },
      changes: Record<string, unknown>,
    ) =>
      api
        .put(`${apps}/${record.id}`)
        .set('Authorization', auth(owner))
        .send({ ...record, ...changes, expectedUpdatedAt: record.updatedAt })
        .expect(200);
    const { body: renamed } = await edit(confirmed, {
      name: 'Renamed hosted app',
    });
    expect(renamed.hostedAttestation).toEqual(confirmed.hostedAttestation);
    const { body: changed } = await edit(renamed, {
      hosted: {
        ...renamed.hosted,
        sharing: 'company',
        dataAccess: 'stores input',
        dataClassification: 'internal',
      },
    });
    expect(changed).not.toHaveProperty('hostedAttestation');
    expect(changed.hostedWorkspaceAllowed).toBe(true);
    const { body: renewed } = await attest(changed).expect(200);
    const { body: reassigned } = await edit(renewed, { owner: nextOwner });
    expect(reassigned).not.toHaveProperty('hostedAttestation');
    await attest(reassigned).expect(403);
    const { body: reattested } = await attest(reassigned, nextOwner).expect(
      200,
    );
    const { body: retired } = await api
      .patch(`${path}/lifecycle`)
      .set('Authorization', auth(nextOwner))
      .send({ lifecycle: 'retired', expectedUpdatedAt: reattested.updatedAt })
      .expect(200);
    expect(retired).not.toHaveProperty('hostedAttestation');
    await attest(retired, nextOwner).expect(400);

    const { body: corrected } = await edit(unapproved, {
      hosted: { ...unapproved.hosted, workspace: 'Company' },
    });
    const { body: otherAttested } = await attest(corrected).expect(200);
    const { body: converted } = await edit(otherAttested, {
      type: 'app',
      hosted: undefined,
    });
    expect(converted).not.toHaveProperty('hostedAttestation');
    expect(converted).not.toHaveProperty('hostedWorkspaceAllowed');
    await attest(converted).expect(400);

    const { body: limited } = await create('Limited').expect(201);
    const activate = (app: { id: string; updatedAt: string }) =>
      api
        .patch(`${apps}/${app.id}/lifecycle`)
        .set('Authorization', auth(owner))
        .send({ lifecycle: 'active', expectedUpdatedAt: app.updatedAt });
    const { body: shared } = await edit(limited, {
      hosted: { ...limited.hosted, sharing: 'company' },
    });
    expect(shared.hostedWorkspaceAllowed).toBe(false);
    await activate(shared).expect(400);
    await attest(shared).expect(400);
    const { body: workspaceIssues } = await api
      .get('/api/governance/reports/hosted-workspaces')
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(workspaceIssues.issues).toContainEqual(
      expect.objectContaining({ appId: shared.id, settingsMismatch: true }),
    );

    const { body: storesInput } = await edit(shared, {
      hosted: {
        ...limited.hosted,
        dataAccess: 'stores input',
        dataClassification: 'internal',
      },
    });
    expect(storesInput.hostedWorkspaceAllowed).toBe(false);
    await activate(storesInput).expect(400);
    await attest(storesInput).expect(400);

    const { body: compliant } = await edit(storesInput, {
      hosted: limited.hosted,
    });
    expect(compliant.hostedWorkspaceAllowed).toBe(true);
    const { body: compliantActive } = await activate(compliant).expect(200);
    await attest(compliantActive).expect(200);

    const { body: history } = await api
      .get(`${path}/history`)
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(
      history.events.map(({ event }: { event: string }) => JSON.parse(event)),
    ).toContainEqual(
      expect.objectContaining({
        action: 'hosted-attested',
        actor: nextOwner,
        record: expect.objectContaining({
          hostedAttestation: reattested.hostedAttestation,
        }),
      }),
    );
  });

  it('enforces evidence, history, and ownership permissions', async () => {
    const owner = 'user:default/owner';
    const backup = 'user:default/backup';
    const reviewer = 'user:default/reviewer';
    const teammate = 'user:default/teammate';
    const evidence = { tests: 'https://example.com/restricted-evidence' };
    const legacySourceUrl = 'https://example.com/purchase-orders ';
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
        sourceUrl: legacySourceUrl,
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

    const riskAssessment = { tier: 3, reasons: ['restricted-data'] };
    expect(created.body).toMatchObject({
      sourceUrl: legacySourceUrl,
      riskAssessment,
    });
    const path = `${apps}/${created.body.id}`;
    const credentialLink =
      'https://example-user:synthetic@example.com/evidence';
    await api
      .post(apps)
      .set('Authorization', auth(owner))
      .send({
        ...created.body,
        sourceUrl: 'https://example.com/rejected-review-link',
        reviewTicketUrl: credentialLink,
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.error.message).toContain('contain no credentials');
        expect(body.error.message).not.toContain(credentialLink);
      });
    await api
      .put(path)
      .set('Authorization', auth(owner))
      .send({ ...created.body, evidence: { tests: credentialLink } })
      .expect(400);
    await api
      .put(path)
      .set('Authorization', auth(owner))
      .send({
        ...created.body,
        evidence: { tests: `https://example.com/${'x'.repeat(2048)}` },
      })
      .expect(400);
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
    expect(linked.body.sourceUrl).toBe(legacySourceUrl);
    expect(linked.body).toMatchObject({
      reviewStatus: 'approved',
      reviewTicketUrl,
      riskAssessment,
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
        riskAssessment,
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
    expect(unrelated.body).not.toHaveProperty('riskAssessment');
    const service = await api
      .get(path)
      .set('Authorization', mockCredentials.service.header())
      .expect(200);
    expect(service.body).not.toHaveProperty('riskAssessment');
    const ownerList = await api
      .get(apps)
      .set('Authorization', auth(owner))
      .expect(200);
    expect(ownerList.body.apps).toMatchObject([{ riskAssessment }]);
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

    for (const { event } of history.body.events) {
      expect(JSON.parse(event).record).not.toHaveProperty('riskAssessment');
    }

    // Represent a record saved before the current risk policy was applied.
    const row = db('governance_apps').where({ id: created.body.id });
    const { payload: originalPayload } = await row.clone().first('payload');
    const legacyPayload = JSON.stringify({
      ...JSON.parse(originalPayload),
      tier: 2,
      lifecycle: 'active',
      reviewStatus: 'not required',
    });
    await row.clone().update({ payload: legacyPayload });
    const drift = await api
      .get(path)
      .set('Authorization', auth(owner))
      .expect(200);
    expect(drift.body).toMatchObject({
      tier: 2,
      lifecycle: 'active',
      reviewStatus: 'not required',
      updatedAt: linked.body.updatedAt,
      riskAssessment,
    });
    expect(await row.clone().first('payload')).toEqual({
      payload: legacyPayload,
    });
    const driftScorecard = await api
      .get(`${path}/scorecard`)
      .set('Authorization', auth(owner))
      .expect(200);
    expect(driftScorecard.body.checks).toContainEqual({
      name: 'Review status',
      status: 'attention',
      detail:
        'Current policy assigns Tier 3. Reassess this app to update its saved Tier 2.',
    });

    const { body: reassessed } = await api
      .put(path)
      .set('Authorization', auth(owner))
      .send({ ...drift.body, expectedUpdatedAt: drift.body.updatedAt })
      .expect(200);
    const reassessedState = {
      tier: 3,
      lifecycle: 'experimental',
      reviewStatus: 'pending',
      lastReview: null,
      nextReview: null,
    };
    expect(reassessed).toMatchObject({ ...reassessedState, riskAssessment });
    expect(reassessed.updatedAt).not.toBe(drift.body.updatedAt);

    const { body: reassessmentHistory } = await api
      .get(`${path}/history`)
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(reassessmentHistory.events).toHaveLength(
      history.body.events.length + 1,
    );
    const lastEvent = JSON.parse(reassessmentHistory.events.at(-1).event);
    expect(lastEvent).toMatchObject({
      action: 'updated',
      actor: owner,
      record: { ...reassessedState, updatedAt: reassessed.updatedAt },
    });
    expect(lastEvent.record).not.toHaveProperty('riskAssessment');

    const current = await api
      .get(path)
      .set('Authorization', auth(owner))
      .expect(200);
    expect(current.body).toMatchObject({
      ...reassessedState,
      updatedAt: reassessed.updatedAt,
    });
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
          unavailableDetails: [
            { role: 'owner', ref: backup, reason: 'inactive' },
            { role: 'backup', ref: owner, reason: 'missing' },
          ],
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
        unavailableDetails: [{ role: 'owner', ref: backup, reason: 'missing' }],
        availableBackupOwner: owner,
      },
    ]);
    catalog.mockResolvedValueOnce({ items: [] });
    await api.get(report).set('Authorization', auth(reviewer)).expect(503);

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
    await runtimeRow.clone().update({ payload });
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

    // Simulate a record saved under an earlier policy with its issued key intact.
    const { payload: currentRuntimePayload } = await runtimeRow
      .clone()
      .first('payload');
    await runtimeRow.clone().update({
      payload: JSON.stringify({
        ...JSON.parse(currentRuntimePayload),
        tier: 2,
      }),
    });
    const deniedByDrift = await call().expect(403);
    expect(deniedByDrift.body.error.message).toMatch(/owner to reassess/i);
    const driftReport = await api
      .get('/api/governance/reports/usage')
      .set('Authorization', auth(reviewer))
      .expect(200);
    expect(driftReport.body.usage).toMatchObject([
      { appId: runtime.body.id, calls: 1 },
    ]);
    expect(driftReport.body.blocks).toContainEqual(
      expect.objectContaining({
        appId: runtime.body.id,
        reason: 'tier-drift',
        calls: 1,
      }),
    );
    await runtimeRow.clone().update({ payload: currentRuntimePayload });

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
      .expect(200, {
        tier: 3,
        effectiveClassification: 'restricted',
        reasons: ['restricted-data'],
      });
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
    const sandboxPath = `${path}/gateway-key`;
    const productionPath = `${sandboxPath}?environment=production`;
    const issue = (keyPath: string) =>
      api.post(keyPath).set('Authorization', auth);
    const keyStatus = (keyPath: string) =>
      api.get(keyPath).set('Authorization', auth);
    const draft = await api
      .post('/api/governance/apps')
      .set('Authorization', auth)
      .send({ ...secondApp, lifecycle: 'experimental' })
      .expect(201);
    await issue(
      `/api/governance/apps/${draft.body.id}/gateway-key?environment=production`,
    ).expect(403);
    const scorecard = () =>
      api.get(`${path}/scorecard`).set('Authorization', auth).expect(200);
    const ownerScorecard = () =>
      api
        .get('/api/governance/owner-scorecard')
        .set('Authorization', auth)
        .expect(200);
    const sandbox = await issue(sandboxPath).expect(201);
    expect((await scorecard()).body.checks).toContainEqual({
      name: 'Gateway key',
      status: 'attention',
      detail:
        'Ask the app owner or a reviewer to issue a production gateway key.',
    });
    expect((await ownerScorecard()).body.issues).toContainEqual({
      appId: app.body.id,
      checks: ['Gateway key'],
    });
    const issued = await issue(productionPath).expect(201);
    expect((await scorecard()).body.checks).toContainEqual({
      name: 'Gateway key',
      status: 'pass',
      detail: 'A production gateway key is issued for this app.',
    });
    expect((await ownerScorecard()).body.issues).toEqual([]);
    expect(issued.body.key).not.toBe(sandbox.body.key);
    await keyStatus(sandboxPath).expect(200, { issued: true });
    await keyStatus(productionPath).expect(200, { issued: true });
    await keyStatus(`${sandboxPath}?environment=invalid`).expect(400);
    const call = (key = issued.body.key) =>
      api
        .post('/api/governance/gateway/chat')
        .set('Authorization', `Bearer ${key}`)
        .send({ model: 'test-model', prompt: 'Synthetic prompt' });
    await call(sandbox.body.key)
      .expect(200)
      .expect(({ body }) => {
        expect(body.simulated).toBe(true);
      });
    expect(provider).not.toHaveBeenCalled();
    for (const [key, expectedEnvironment] of [
      [issued.body.key, 'sandbox'],
      [sandbox.body.key, 'production'],
    ]) {
      await api
        .post('/api/governance/gateway/chat')
        .set('Authorization', `Bearer ${key}`)
        .send({
          model: 'test-model',
          prompt: 'Synthetic prompt',
          expectedEnvironment,
        })
        .expect(403);
    }
    expect(provider).not.toHaveBeenCalled();
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
    const rotated = await issue(sandboxPath).expect(201);
    await call(sandbox.body.key).expect(401);
    await call(rotated.body.key)
      .expect(200)
      .expect(({ body }) => {
        expect(body.simulated).toBe(true);
      });
    await api.delete(productionPath).set('Authorization', auth).expect(204);
    await keyStatus(sandboxPath).expect(200, { issued: true });
    await keyStatus(productionPath).expect(200, { issued: false });
    await call().expect(401);
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
      simulatedCalls: 2,
      liveTokens: { calls: 2, input: 2, output: 5 },
      monthlySpend: {
        liveEstimatedCostUsd: 2,
        thresholdUsd: 2,
        stopAtThreshold: true,
      },
      blocks: expect.arrayContaining([
        { reason: 'spend-threshold', calls: 1 },
        { reason: 'key-environment', calls: 2 },
      ]),
    });

    await issue(productionPath).expect(201);
    await api
      .patch(`${path}/lifecycle`)
      .set('Authorization', auth)
      .send({ lifecycle: 'retired' })
      .expect(200);
    await keyStatus(sandboxPath).expect(200, { issued: false });
    await keyStatus(productionPath).expect(200, { issued: false });
    await call(rotated.body.key).expect(401);
  });
});

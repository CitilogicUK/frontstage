import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type APIResponse } from '@playwright/test';

const demoOrigin = 'http://localhost:3000';
const constrainedAppSource = 'https://example.com/gateway-test/constrained';
const approvedModel = 'gpt-4.1-mini';
const lowerClassificationModel = 'gpt-4.1-nano';

async function reserveFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done, reject) =>
    server.close(error => (error ? reject(error) : done())),
  );
  return port;
}

async function expectStatus(
  response: APIResponse,
  status: number,
  action: string,
) {
  const received = response.status();
  expect(
    received,
    received === status ? action : `${action}: ${await response.text()}`,
  ).toBe(status);
}

test('a Tier 3 app needs approval and activation before its model calls are metered', async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'phone',
    'The gateway contract is independent of viewport.',
  );
  test.setTimeout(90_000);

  const port = await reserveFreePort();
  const dataDirectory = await mkdtemp(
    join(tmpdir(), 'frontstage-gateway-e2e-'),
  );
  const backendRoot = resolve(__dirname, '../packages/backend');
  const backendUrl = `http://127.0.0.1:${port}`;
  const api = `${backendUrl}/api/governance`;
  const startupEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('APP_CONFIG_'),
    ),
  );
  const backend = spawn(
    process.execPath,
    [
      resolve(
        backendRoot,
        '../../node_modules/@backstage/cli/bin/backstage-cli',
      ),
      'package',
      'start',
      '--config',
      '../../app-config.yaml',
      '--config',
      '../../app-config.development.yaml',
      '--config',
      '../../app-config.reviewer.yaml',
    ],
    {
      cwd: backendRoot,
      env: {
        ...startupEnv,
        NODE_ENV: 'development',
        APP_CONFIG_governance_gateway_requestsPerMinute: '30',
        APP_CONFIG_governance_gateway_appSpendThresholds: JSON.stringify([
          { sourceUrl: constrainedAppSource, monthlyUsd: 20 },
        ]),
        APP_CONFIG_governance_gateway_appRateLimits: JSON.stringify([
          { sourceUrl: constrainedAppSource, requestsPerMinute: 1 },
        ]),
        APP_CONFIG_backend_baseUrl: JSON.stringify(backendUrl),
        APP_CONFIG_backend_listen_host: JSON.stringify('127.0.0.1'),
        APP_CONFIG_backend_listen_port: JSON.stringify(port),
        APP_CONFIG_backend_database_connection_directory:
          JSON.stringify(dataDirectory),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let backendLog = '';
  backend.stdout.on('data', chunk => {
    backendLog += String(chunk);
  });
  backend.stderr.on('data', chunk => {
    backendLog += String(chunk);
  });
  backend.on('error', error => {
    backendLog += String(error);
  });
  const backendExited = new Promise<void>(done =>
    backend.once('close', () => done()),
  );

  try {
    await expect
      .poll(
        async () => {
          try {
            const response = await request.get(
              `${backendUrl}/.backstage/health/v1/readiness`,
              { timeout: 2_000 },
            );
            const status = response.status();
            await response.dispose();
            return status;
          } catch {
            return 'starting';
          }
        },
        { timeout: 30_000 },
      )
      .toBe(200);

    const auth = await request.get(`${backendUrl}/api/auth/guest/refresh`, {
      headers: { Origin: demoOrigin, 'X-Requested-With': 'XMLHttpRequest' },
    });
    await expectStatus(auth, 200, 'Sign in as demo reviewer');
    const identity = await auth.json();
    expect(identity.backstageIdentity.identity.userEntityRef).toBe(
      'user:default/reviewer',
    );
    const headers = {
      Authorization: `Bearer ${identity.backstageIdentity.token}`,
    };

    for (const owner of ['guest', 'backup']) {
      await expect
        .poll(
          async () => {
            const response = await request.get(
              `${backendUrl}/api/catalog/entities/by-name/user/default/${owner}`,
              { headers, timeout: 2_000 },
            );
            const status = response.status();
            await response.dispose();
            return status;
          },
          { timeout: 15_000 },
        )
        .toBe(200);
    }

    const models = await request.get(`${api}/gateway/models`, { headers });
    await expectStatus(models, 200, 'Read the approved model policy');
    expect(await models.json()).toEqual({
      enabled: true,
      models: [
        {
          id: approvedModel,
          maxCompletionTokens: 1024,
          allowedClassifications: [
            'public',
            'internal',
            'confidential',
            'restricted',
          ],
        },
        {
          id: lowerClassificationModel,
          maxCompletionTokens: 1024,
          allowedClassifications: ['public', 'internal'],
        },
      ],
    });

    const created = await request.post(`${api}/apps`, {
      headers,
      data: {
        name: 'Gateway contract test',
        purpose: 'Validate the local simulated gateway',
        type: 'assistant',
        platform: 'Code repo',
        sourceUrl: constrainedAppSource,
        owner: 'user:default/guest',
        backupOwner: 'user:default/backup',
        team: 'group:default/platform',
        lifecycle: 'experimental',
        audience: 'external',
        classification: 'restricted',
        models: [approvedModel, lowerClassificationModel],
      },
    });
    await expectStatus(created, 201, 'Register a critical app');
    const app = await created.json();
    expect(app).toMatchObject({ tier: 3, reviewStatus: 'pending' });

    const issued = await request.post(`${api}/apps/${app.id}/gateway-key`, {
      headers,
    });
    await expectStatus(issued, 201, 'Issue an app key');
    const { key } = await issued.json();
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);

    const callGateway = (model: string) =>
      request.post(`${api}/gateway/chat`, {
        headers: { Authorization: `Bearer ${key}` },
        data: { model, prompt: 'This text is synthetic gateway test data.' },
      });
    await expectStatus(
      await callGateway(approvedModel),
      403,
      'Block a pending critical app',
    );

    const review = await request.post(`${api}/apps/${app.id}/reviews`, {
      headers,
      data: {
        status: 'approved',
        notes: 'The simulated test uses synthetic data.',
        expectedUpdatedAt: app.updatedAt,
      },
    });
    await expectStatus(review, 200, 'Record the critical review');
    await expectStatus(
      await callGateway(approvedModel),
      403,
      'Block an approved app until activation',
    );

    const beforeActivationScorecard = await request.get(
      `${api}/apps/${app.id}/scorecard`,
      { headers },
    );
    await expectStatus(
      beforeActivationScorecard,
      200,
      'Read the scorecard before activation',
    );
    expect((await beforeActivationScorecard.json()).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Review status', status: 'pass' }),
        expect.objectContaining({
          name: 'Gateway lifecycle',
          status: 'attention',
        }),
      ]),
    );

    const active = await request.patch(`${api}/apps/${app.id}/lifecycle`, {
      headers,
      data: { lifecycle: 'active' },
    });
    await expectStatus(active, 200, 'Activate the reviewed app');
    await expectStatus(
      await callGateway(lowerClassificationModel),
      403,
      'Block a declared model from using restricted data',
    );

    const remaining = 60_000 - (Date.now() % 60_000);
    if (remaining < 5_000)
      await new Promise(resolve => setTimeout(resolve, remaining));
    const completion = await callGateway(approvedModel);
    await expectStatus(completion, 200, 'Run an approved simulated model');
    expect(await completion.json()).toMatchObject({
      model: approvedModel,
      simulated: true,
      output: expect.stringMatching(/\S/),
    });

    const throttled = await callGateway(approvedModel);
    await expectStatus(throttled, 429, 'Enforce the per-app request allowance');
    expect(Number(throttled.headers()['retry-after'])).toBeGreaterThan(0);

    const usage = await request.get(`${api}/apps/${app.id}/usage`, { headers });
    await expectStatus(usage, 200, 'Read metered usage for the app');
    const metered = await usage.json();
    expect(metered).toMatchObject({
      calls: 1,
      liveCalls: 0,
      simulatedCalls: 1,
      unclassifiedCalls: 0,
      liveEstimatedCostUsd: 0,
      blockedCalls: 4,
      requestsPerMinute: 1,
      monthlySpend: {
        monthStart: expect.stringMatching(/-01T00:00:00\.000Z$/),
        liveEstimatedCostUsd: 0,
        thresholdUsd: 20,
      },
      blocks: ['lifecycle', 'model', 'rate-limit', 'review'].map(reason => ({
        reason,
        calls: 1,
      })),
    });
    expect(metered.estimatedCostUsd).toBeGreaterThan(0);

    const scorecard = await request.get(`${api}/apps/${app.id}/scorecard`, {
      headers,
    });
    await expectStatus(scorecard, 200, 'Read the current app scorecard');
    expect((await scorecard.json()).checks).toEqual([
      expect.objectContaining({ name: 'Catalog ownership', status: 'pass' }),
      expect.objectContaining({ name: 'Review status', status: 'pass' }),
      expect.objectContaining({ name: 'Gateway lifecycle', status: 'pass' }),
      expect.objectContaining({
        name: 'Gateway model policy',
        status: 'attention',
        detail: expect.stringContaining(lowerClassificationModel),
      }),
      expect.objectContaining({
        name: 'Recent live gateway activity',
        status: 'unknown',
        detail: expect.stringContaining('Simulated calls were recorded.'),
      }),
      expect.objectContaining({ name: 'Gateway key', status: 'pass' }),
    ]);
    const report = await request.get(`${api}/reports/usage`, { headers });
    await expectStatus(report, 200, 'Read the portfolio usage report');
    const portfolio = await report.json();
    expect(portfolio.usage).toEqual([
      {
        appId: app.id,
        model: approvedModel,
        mode: 'simulation',
        calls: 1,
        estimatedCostUsd: metered.estimatedCostUsd,
        tokens: {
          calls: 1,
          input: expect.any(Number),
          output: expect.any(Number),
        },
      },
    ]);
    expect(portfolio.blocks).toEqual(
      expect.arrayContaining(
        ['review', 'lifecycle', 'model', 'rate-limit'].map(reason => ({
          appId: app.id,
          reason,
          mode: 'simulation',
          calls: 1,
        })),
      ),
    );
    expect(portfolio.blocks).toHaveLength(4);
    const activation = await active.json();
    const revised = await request.put(`${api}/apps/${app.id}`, {
      headers,
      data: {
        ...activation,
        purpose:
          'This app now processes a different restricted intake workflow.',
        evidence: { tests: 'https://example.com/evidence/test-results' },
        expectedUpdatedAt: activation.updatedAt,
      },
    });
    await expectStatus(revised, 200, 'Edit the approved app’s purpose');
    const changed = await revised.json();
    expect(changed).toMatchObject({
      reviewStatus: 'pending',
      lifecycle: 'experimental',
      nextReview: null,
    });
    expect(changed.evidence).toEqual({
      tests: 'https://example.com/evidence/test-results',
    });
    expect(changed.updatedAt).not.toEqual(activation.updatedAt);

    const stale = await request.post(`${api}/apps/${app.id}/reviews`, {
      headers,
      data: {
        status: 'approved',
        notes: 'Previous app purpose',
        expectedUpdatedAt: activation.updatedAt,
      },
    });
    await expectStatus(stale, 409, 'Reject a decision on the previous version');
    const missing = await request.post(`${api}/apps/${app.id}/reviews`, {
      headers,
      data: { status: 'approved', notes: 'No record version supplied' },
    });
    await expectStatus(
      missing,
      400,
      'Require the current version on review decisions',
    );
    await expectStatus(
      await callGateway(approvedModel),
      403,
      'Block the existing key while the edited app awaits review',
    );
    const fresh = await request.post(`${api}/apps/${app.id}/reviews`, {
      headers,
      data: {
        status: 'approved',
        notes: 'Reviewed the updated purpose',
        expectedUpdatedAt: changed.updatedAt,
      },
    });
    await expectStatus(fresh, 200, 'Approve the current version');
    const reviewed = await fresh.json();
    const handover = await request.put(`${api}/apps/${app.id}`, {
      headers,
      data: {
        ...reviewed,
        owner: reviewed.backupOwner,
        backupOwner: reviewed.owner,
        expectedUpdatedAt: reviewed.updatedAt,
      },
    });
    await expectStatus(handover, 200, 'Change the accountable owner');
    expect(await handover.json()).toMatchObject({
      owner: reviewed.backupOwner,
      reviewStatus: 'pending',
    });
    const keyPath = `${api}/apps/${app.id}/gateway-key`;
    const keyStatus = await request.get(keyPath, { headers });
    await expectStatus(keyStatus, 200, 'Inspect key status after handover');
    expect(await keyStatus.json()).toEqual({ issued: false });
    await expectStatus(
      await callGateway(approvedModel),
      401,
      'Reject the key revoked by the ownership transfer',
    );
    await expectStatus(
      await request.delete(keyPath, { headers }),
      204,
      'Repeat revocation safely',
    );
    expect(await (await request.get(keyPath, { headers })).json()).toEqual({
      issued: false,
    });
    const history = await request.get(`${api}/apps/${app.id}/history`, {
      headers,
    });
    await expectStatus(history, 200, 'Read reviewer audit history');
    const audit = await history.json();
    const exportPath = join(dataDirectory, 'audit-export.json');
    const verifier = resolve(backendRoot, '../../scripts/verify-audit.mjs');
    const head = audit.events.at(-1).digest;
    await writeFile(exportPath, JSON.stringify({ appId: app.id, ...audit }));
    const verification = spawnSync(
      process.execPath,
      [verifier, exportPath, head],
      { encoding: 'utf8' },
    );
    expect(verification.status, verification.stderr).toBe(0);
    expect(verification.stdout).toContain(head);
    const checkpoint = spawnSync(
      process.execPath,
      [verifier, exportPath, '--checkpoint', audit.events.at(-2).digest],
      { encoding: 'utf8' },
    );
    expect(checkpoint.status, checkpoint.stderr).toBe(0);
    expect(checkpoint.stdout).toContain('Saved checkpoint matched revision');
    await writeFile(
      exportPath,
      JSON.stringify({
        appId: app.id,
        ...audit,
        events: audit.events.slice(0, -1),
      }),
    );
    const truncated = spawnSync(
      process.execPath,
      [verifier, exportPath, head],
      { encoding: 'utf8' },
    );
    expect(truncated.status).toBe(1);
    expect(truncated.stderr).toContain('does not match the expected head');
    const missingCheckpoint = spawnSync(
      process.execPath,
      [verifier, exportPath, '--checkpoint', head],
      { encoding: 'utf8' },
    );
    expect(missingCheckpoint.status).toBe(1);
    expect(missingCheckpoint.stderr).toContain('saved checkpoint is absent');

    expect(
      audit.keyEvents.map((event: { action: string }) => event.action),
    ).toEqual(['issued', 'revoked']);
    expect(
      audit.keyEvents.every(
        (event: { actor: string }) => event.actor === 'user:default/reviewer',
      ),
    ).toBe(true);
    expect(
      audit.events.map(
        (entry: { event: string }) => JSON.parse(entry.event).action,
      ),
    ).toContain('reviewed');
    expect(JSON.stringify(audit)).not.toContain(key);
    const shared = await request.post(`${api}/apps`, {
      headers,
      data: {
        ...app,
        name: 'Shared attestation test',
        owner: 'user:default/reviewer',
        backupOwner: 'user:default/guest',
        sourceUrl: `https://example.com/gateway-test/${randomUUID()}`,
        lifecycle: 'active',
        audience: 'team',
        classification: 'internal',
      },
    });
    await expectStatus(shared, 201, 'Create a shared app for attestation');
    const sharedApp = await shared.json();
    expect(sharedApp.tier).toBe(2);
    const attest = () =>
      request.post(`${api}/apps/${sharedApp.id}/attestation`, {
        headers,
        data: { confirmed: true, expectedUpdatedAt: sharedApp.updatedAt },
      });
    const receipt = await attest();
    await expectStatus(receipt, 200, 'Attest to the current shared app');
    const attested = await receipt.json();
    expect(attested.lastReview).toBe(attested.updatedAt);
    expect(new Date(attested.nextReview).getUTCFullYear()).toBe(
      new Date(attested.lastReview).getUTCFullYear() + 1,
    );
    await expectStatus(
      await attest(),
      409,
      'Reject attestation on the old version',
    );
    const attestationAudit = await request.get(
      `${api}/apps/${sharedApp.id}/history`,
      { headers },
    );
    expect(
      (await attestationAudit.json()).events.map(
        (entry: { event: string }) => JSON.parse(entry.event).action,
      ),
    ).toEqual(['registered', 'attested']);
    const sharedPath = `${api}/apps/${sharedApp.id}`;
    async function issueSharedKey() {
      const issuedKey = await request.post(`${sharedPath}/gateway-key`, {
        headers,
      });
      await expectStatus(issuedKey, 201, 'Issue a key to the shared app');
      return (await issuedKey.json()).key;
    }
    async function checkRevokedKey(key: string) {
      const blocked = await request.post(`${api}/gateway/chat`, {
        headers: { Authorization: `Bearer ${key}` },
        data: {
          model: approvedModel,
          prompt: 'Synthetic revocation verification',
        },
      });
      await expectStatus(
        blocked,
        401,
        'Reject a key after automatic revocation',
      );
    }
    const retiredKey = await issueSharedKey();
    const retire = (expectedUpdatedAt: string) =>
      request.patch(`${sharedPath}/lifecycle`, {
        headers,
        data: {
          lifecycle: 'retired',
          expectedUpdatedAt,
          reason: 'Workflow replaced',
        },
      });
    await expectStatus(
      await retire(sharedApp.updatedAt),
      409,
      'Reject retirement based on a record opened before attestation',
    );
    await expectStatus(
      await request.post(`${api}/gateway/chat`, {
        headers: { Authorization: `Bearer ${retiredKey}` },
        data: { model: approvedModel, prompt: 'Synthetic lifecycle check' },
      }),
      200,
      'Keep the gateway key usable after the conflicting retirement',
    );
    await expectStatus(
      await retire(attested.updatedAt),
      200,
      'Retire the shared app and revoke its key',
    );
    await checkRevokedKey(retiredKey);
    await expectStatus(
      await request.post(`${sharedPath}/gateway-key`, { headers }),
      403,
      'Reject key issuance for a retired app',
    );
    const reactivate = await request.patch(`${sharedPath}/lifecycle`, {
      headers,
      data: { lifecycle: 'active' },
    });
    await expectStatus(reactivate, 200, 'Reactivate the shared app');
    await checkRevokedKey(retiredKey);
    const reactivatedScorecard = await request.get(`${sharedPath}/scorecard`, {
      headers,
    });
    await expectStatus(
      reactivatedScorecard,
      200,
      'Read the reactivated app scorecard',
    );
    expect((await reactivatedScorecard.json()).checks).toContainEqual(
      expect.objectContaining({ name: 'Gateway key', status: 'attention' }),
    );
    const optOutKey = await issueSharedKey();
    const noAi = await request.put(sharedPath, {
      headers,
      data: {
        ...(await reactivate.json()),
        usesAiAtRuntime: false,
        models: [],
      },
    });
    await expectStatus(noAi, 200, 'Turn off runtime AI');
    await checkRevokedKey(optOutKey);
    const keyAudit = await request.get(`${sharedPath}/history`, { headers });
    const sharedAudit = await keyAudit.json();
    expect(
      sharedAudit.events.map((entry: { event: string }) =>
        JSON.parse(entry.event),
      ),
    ).toContainEqual(
      expect.objectContaining({
        lifecycleReason: 'Workflow replaced',
        record: expect.objectContaining({ lifecycle: 'retired' }),
      }),
    );
    expect(
      sharedAudit.keyEvents.map((event: { action: string }) => event.action),
    ).toEqual(['issued', 'revoked', 'issued', 'revoked']);
    const sharedHead = sharedAudit.events.at(-1).digest;
    await writeFile(
      exportPath,
      JSON.stringify({ appId: sharedApp.id, ...sharedAudit }),
    );
    const verifiedRetirement = spawnSync(
      process.execPath,
      [verifier, exportPath, sharedHead],
      { encoding: 'utf8' },
    );
    expect(verifiedRetirement.status, verifiedRetirement.stderr).toBe(0);
    await writeFile(
      exportPath,
      JSON.stringify({
        appId: sharedApp.id,
        ...sharedAudit,
        events: sharedAudit.events.map((entry: { event: string }) => ({
          ...entry,
          event: entry.event.replace('Workflow replaced', 'Reason altered'),
        })),
      }),
    );
    const tamperedRetirement = spawnSync(
      process.execPath,
      [verifier, exportPath, sharedHead],
      { encoding: 'utf8' },
    );
    expect(tamperedRetirement.status).toBe(1);
    expect(tamperedRetirement.stderr).toContain('has a digest mismatch');
    const optedOut = await noAi.json();
    const sharedHandover = await request.put(sharedPath, {
      headers,
      data: {
        ...optedOut,
        owner: optedOut.backupOwner,
        backupOwner: optedOut.owner,
        expectedUpdatedAt: optedOut.updatedAt,
      },
    });
    await expectStatus(sharedHandover, 200, 'Transfer the shared app');
    const transferred = await sharedHandover.json();
    expect(transferred).toMatchObject({
      owner: optedOut.backupOwner,
      tier: 2,
      lastReview: null,
      nextReview: transferred.updatedAt,
    });

    const trial = await request.post(`${api}/apps`, {
      headers,
      data: {
        name: 'AI-assisted software trial',
        purpose: 'Synthetic non-AI workflow',
        type: 'app',
        platform: 'GitHub',
        sourceUrl: `https://example.com/trial/${randomUUID()}`,
        owner: 'user:default/guest',
        team: 'group:default/platform',
        lifecycle: 'experimental',
        audience: 'personal',
        classification: 'internal',
        usesAiAtRuntime: false,
        deliveryStage: 'trial',
      },
    });
    await expectStatus(trial, 201, 'Register software without runtime models');
    const trialApp = await trial.json();
    expect(trialApp).toMatchObject({
      usesAiAtRuntime: false,
      models: [],
      deliveryStage: 'trial',
      tier: 1,
    });
    await expectStatus(
      await request.post(`${api}/apps/${trialApp.id}/gateway-key`, { headers }),
      403,
      'Reject gateway key issuance for software without runtime AI',
    );
    const pilot = await request.post(`${api}/apps`, {
      headers,
      data: {
        name: 'Purchase order pilot',
        purpose: 'Synthetic purchase orders for a sandbox',
        type: 'app',
        platform: 'GitHub',
        sourceUrl: `https://example.com/purchase-orders/${randomUUID()}`,
        owner: 'user:default/guest',
        backupOwner: 'user:default/backup',
        team: 'group:default/platform',
        lifecycle: 'experimental',
        audience: 'personal',
        classification: 'internal',
        usesAiAtRuntime: false,
        deliveryStage: 'pilot',
        takesActions: true,
        actionDescription: 'Submits sandbox orders',
      },
    });
    await expectStatus(
      pilot,
      201,
      'Register software that acts in another system',
    );
    const pilotApp = await pilot.json();
    expect(pilotApp).toMatchObject({
      usesAiAtRuntime: false,
      models: [],
      deliveryStage: 'pilot',
      tier: 3,
      reviewStatus: 'pending',
    });
    const pilotPath = `${api}/apps/${pilotApp.id}`;
    const activatePilot = () =>
      request.patch(`${pilotPath}/lifecycle`, {
        headers,
        data: { lifecycle: 'active' },
      });
    await expectStatus(
      await activatePilot(),
      400,
      'Require review before activating the pilot',
    );
    const pilotReview = await request.post(`${pilotPath}/reviews`, {
      headers,
      data: {
        status: 'approved',
        notes: 'Reviewed sandbox scope and permissions.',
        expectedUpdatedAt: pilotApp.updatedAt,
      },
    });
    await expectStatus(pilotReview, 200, 'Approve the sandbox pilot');
    const activatedPilot = await activatePilot();
    await expectStatus(activatedPilot, 200, 'Activate the approved pilot');
    const activePilot = await activatedPilot.json();
    expect(activePilot).toMatchObject({
      lifecycle: 'active',
      reviewStatus: 'approved',
      usesAiAtRuntime: false,
    });
    await expectStatus(
      await request.post(`${pilotPath}/gateway-key`, { headers }),
      403,
      'Keep gateway keys unavailable after approval for a model-free app',
    );
    const production = await request.put(pilotPath, {
      headers,
      data: {
        ...activePilot,
        deliveryStage: 'production',
        expectedUpdatedAt: activePilot.updatedAt,
      },
    });
    await expectStatus(production, 200, 'Move the pilot to production review');
    expect(await production.json()).toMatchObject({
      deliveryStage: 'production',
      lifecycle: 'experimental',
      reviewStatus: 'pending',
      usesAiAtRuntime: false,
    });
    await expectStatus(
      await activatePilot(),
      400,
      'Require fresh approval before activating in production',
    );
  } catch (error) {
    await testInfo.attach('isolated backend output', {
      body: backendLog,
      contentType: 'text/plain',
    });
    throw error;
  } finally {
    backend.kill();
    await backendExited;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

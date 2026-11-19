import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type APIResponse } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
  page,
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

  async function waitForStatus(path: string, headers?: Record<string, string>) {
    await expect
      .poll(
        async () => {
          if (backend.exitCode !== null || backend.signalCode !== null) {
            throw new Error(
              `The isolated Backstage backend exited while waiting for ${path}.`,
            );
          }
          try {
            const response = await request.get(`${backendUrl}${path}`, {
              headers,
              timeout: 2_000,
            });
            const status = response.status();
            await response.dispose();
            return status;
          } catch {
            return 'unreachable';
          }
        },
        { timeout: 30_000, message: `Wait for Backstage endpoint ${path}` },
      )
      .toBe(200);
  }

  try {
    await waitForStatus('/.backstage/health/v1/readiness');

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

    await Promise.all(
      [
        'user/default/guest',
        'user/default/backup',
        'group/default/platform',
      ].map(ref =>
        waitForStatus(`/api/catalog/entities/by-name/${ref}`, headers),
      ),
    );

    const workspaces = await request.get(`${api}/hosted-workspaces`, {
      headers,
    });
    await expectStatus(
      workspaces,
      200,
      'Read the approved provider workspaces',
    );
    expect(await workspaces.json()).toEqual({
      configured: true,
      workspaces: [
        {
          provider: 'Example AI',
          workspace: 'Company sandbox',
          allowedSharing: ['private', 'named people'],
          allowedDataAccess: ['none'],
        },
      ],
    });

    const connectors = await request.get(`${api}/approved-connectors`, {
      headers,
    });
    await expectStatus(connectors, 200, 'Read the reviewer connector registry');
    expect(await connectors.json()).toMatchObject({
      configured: true,
      connectors: [
        {
          id: 'catalog-sandbox',
          kind: 'mcp',
          access: 'read',
          maxClassification: 'internal',
        },
        {
          id: 'inventory-sandbox',
          kind: 'data',
          access: 'write',
          maxClassification: 'public',
        },
      ],
    });

    const models = await request.get(`${api}/gateway/models`, { headers });
    await expectStatus(models, 200, 'Read the approved model policy');
    expect(await models.json()).toEqual({
      enabled: true,
      productionAvailable: false,
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
    const activeRecord = await active.json();
    const exceptionPath = `${api}/apps/${app.id}/renewal-exception`;
    const expiresAt = new Date(
      Date.parse(activeRecord.nextReview) + 7 * 86_400_000,
    ).toISOString();
    const reason = 'Allow seven days to complete the scheduled renewal.';
    async function grantException(expectedUpdatedAt: string) {
      const response = await request.post(exceptionPath, {
        headers,
        data: { reason, expiresAt, expectedUpdatedAt },
      });
      await expectStatus(response, 200, 'Grant a bounded renewal exception');
      const record = await response.json();
      expect(record).toMatchObject({
        nextReview: activeRecord.nextReview,
        renewalException: { reason, expiresAt, owner: 'user:default/guest' },
      });
      return record;
    }
    const extended = await grantException(activeRecord.updatedAt);
    const revoked = await request.delete(exceptionPath, {
      headers,
      data: { expectedUpdatedAt: extended.updatedAt },
    });
    await expectStatus(revoked, 200, 'Revoke the renewal exception');
    const revokedRecord = await revoked.json();
    expect(revokedRecord.renewalException).toBeUndefined();
    const activation = await grantException(revokedRecord.updatedAt);
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
    expect(changed.renewalException).toBeUndefined();
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
    const handedOver = await handover.json();
    expect(handedOver).toMatchObject({
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
    await page.route('**/api/governance/apps', route =>
      route.fulfill({
        json: {
          apps: [handedOver],
          actor: 'user:default/reviewer',
          canReview: true,
        },
      }),
    );
    let historyLoads = 0;
    await page.route(`**/api/governance/apps/${app.id}/history`, route => {
      historyLoads += 1;
      return historyLoads === 1
        ? route.fulfill({ status: 503 })
        : route.fulfill({ json: audit });
    });
    await page.goto(`/?app=${encodeURIComponent(app.id)}`);
    const details = page.getByRole('dialog', { name: handedOver.name });
    const guest = page.getByRole('button', { name: /enter|guest/i }).first();
    await expect(details.or(guest)).toBeVisible();
    if (await guest.isVisible()) await guest.click();
    await details.getByText('Audit history', { exact: true }).click();
    await expect(
      details.getByText('Audit history could not load.'),
    ).toBeVisible();
    const downloadAudit = details.getByRole('button', {
      name: 'Download audit JSON',
    });
    await expect(downloadAudit).toHaveCount(0);
    await details
      .getByRole('button', { name: 'Retry loading audit history' })
      .click();
    const downloadReady = page.waitForEvent('download');
    await downloadAudit.click();
    const download = await downloadReady;
    expect(download.suggestedFilename()).toBe(
      `frontstage-audit-${app.id}.json`,
    );
    await download.saveAs(exportPath);
    expect(JSON.parse(await readFile(exportPath, 'utf8'))).toEqual({
      appId: app.id,
      ...audit,
    });
    const displayedRecordDigest = details.getByRole('textbox', {
      name: 'Final record digest (SHA-256)',
    });
    const displayedKeyDigest = details.getByRole('textbox', {
      name: 'Final key event digest (SHA-256)',
    });
    await expect(displayedRecordDigest).toHaveValue(head);
    await expect(displayedKeyDigest).toHaveValue(audit.keyEvents.at(-1).digest);
    const verification = spawnSync(
      process.execPath,
      [
        verifier,
        exportPath,
        await displayedRecordDigest.inputValue(),
        '--key-head',
        await displayedKeyDigest.inputValue(),
      ],
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
      audit.keyEvents.map(
        ({ event }: { event: string }) => JSON.parse(event).environment,
      ),
    ).toEqual(['sandbox', 'sandbox']);
    expect(
      audit.keyEvents.every(
        (event: { actor: string }) => event.actor === 'user:default/reviewer',
      ),
    ).toBe(true);
    expect(
      audit.events.map(
        (entry: { event: string }) => JSON.parse(entry.event).action,
      ),
    ).toEqual(
      expect.arrayContaining([
        'reviewed',
        'renewal-exception-granted',
        'renewal-exception-revoked',
      ]),
    );
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
    const replacedKey = await issueSharedKey();
    const retiredKey = await issueSharedKey();
    await checkRevokedKey(replacedKey);
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
    const startersRoot = resolve(backendRoot, '../app/public/starters');
    const notes = join(dataDirectory, 'notes.txt');
    await Promise.all([
      writeFile(notes, 'Synthetic meeting notes. Sam will review the draft.'),
      copyFile(
        join(startersRoot, 'shared/gateway.mjs'),
        join(dataDirectory, 'gateway.mjs'),
      ),
    ]);
    for (const starter of [
      { name: 'assistant', args: [], calls: 1 },
      { name: 'agent', args: [], calls: 2 },
      { name: 'automation', args: [notes], calls: 1 },
    ]) {
      const script = join(dataDirectory, `${starter.name}.mjs`);
      await copyFile(
        join(startersRoot, `gateway-${starter.name}/${starter.name}.mjs`),
        script,
      );
      const starterRun = spawnSync(
        process.execPath,
        [script, ...starter.args],
        {
          encoding: 'utf8',
          input: 'Summarize a synthetic meeting.',
          env: {
            ...process.env,
            FRONTSTAGE_BACKEND_URL: backendUrl,
            FRONTSTAGE_GATEWAY_KEY: optOutKey,
            FRONTSTAGE_MODEL: approvedModel,
          },
          timeout: 10_000,
        },
      );
      expect(starterRun.status, starterRun.stderr).toBe(0);
      expect(
        starterRun.stderr.match(/Simulated gateway response\./g),
      ).toHaveLength(starter.calls);
      expect(starterRun.stdout.trim()).not.toBe('');
      if (starter.name === 'agent') {
        expect(starterRun.stdout).toContain('Draft answer');
      }
    }

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
    ).toEqual(['issued', 'rotated', 'revoked', 'issued', 'revoked']);
    const sharedHead = sharedAudit.events.at(-1).digest;
    const keyHead = sharedAudit.keyEvents.at(-1).digest;
    await writeFile(
      exportPath,
      JSON.stringify({ appId: sharedApp.id, ...sharedAudit }),
    );
    const verifiedRetirement = spawnSync(
      process.execPath,
      [verifier, exportPath, sharedHead, '--key-head', keyHead],
      { encoding: 'utf8' },
    );
    expect(verifiedRetirement.status, verifiedRetirement.stderr).toBe(0);
    const keyCheckpoint = spawnSync(
      process.execPath,
      [
        verifier,
        exportPath,
        '--key-checkpoint',
        sharedAudit.keyEvents[0].digest,
      ],
      { encoding: 'utf8' },
    );
    expect(keyCheckpoint.status, keyCheckpoint.stderr).toBe(0);
    expect(keyCheckpoint.stdout).toContain(
      'Saved key checkpoint matched revision 0',
    );

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
    await writeFile(
      exportPath,
      JSON.stringify({
        appId: sharedApp.id,
        ...sharedAudit,
        keyEvents: sharedAudit.keyEvents.slice(0, -1),
      }),
    );
    const truncatedKeys = spawnSync(
      process.execPath,
      [verifier, exportPath, sharedHead, '--key-head', keyHead],
      { encoding: 'utf8' },
    );
    expect(truncatedKeys.status).toBe(1);
    expect(truncatedKeys.stderr).toContain(
      'does not match the expected key head',
    );

    const missingKeyCheckpoint = spawnSync(
      process.execPath,
      [verifier, exportPath, '--key-checkpoint', keyHead],
      { encoding: 'utf8' },
    );
    expect(missingKeyCheckpoint.status).toBe(1);
    expect(missingKeyCheckpoint.stderr).toContain(
      'saved key checkpoint is absent',
    );

    const alteredKeys = sharedAudit.keyEvents.map(
      (event: { action: string }, index: number) =>
        index === 0 ? { ...event, action: 'rotated' } : event,
    );
    await writeFile(
      exportPath,
      JSON.stringify({
        appId: sharedApp.id,
        ...sharedAudit,
        keyEvents: alteredKeys,
      }),
    );
    const alteredKeyEvent = spawnSync(
      process.execPath,
      [verifier, exportPath, sharedHead, '--key-head', keyHead],
      { encoding: 'utf8' },
    );
    expect(alteredKeyEvent.status).toBe(1);
    expect(alteredKeyEvent.stderr).toContain(
      'inconsistent metadata or chain linkage',
    );
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
      humanApprovalEvidenceRequired: true,
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
    const reviewPilot = (proof: Record<string, unknown> = {}) =>
      request.post(`${pilotPath}/reviews`, {
        headers,
        data: {
          status: 'approved',
          notes: 'Reviewed sandbox scope and permissions.',
          expectedUpdatedAt: pilotApp.updatedAt,
          ...proof,
        },
      });
    await expectStatus(
      await reviewPilot(),
      400,
      'Require human approval evidence before approving the sandbox pilot',
    );
    const humanApprovalEvidenceUrl =
      'https://example.com/evidence/purchase-order-approval';
    const pilotReview = await reviewPilot({
      humanApprovalVerified: true,
      humanApprovalEvidenceUrl,
    });
    await expectStatus(pilotReview, 200, 'Approve the sandbox pilot');
    const pilotAudit = await request.get(`${pilotPath}/history`, { headers });
    await expectStatus(pilotAudit, 200, 'Read the sandbox pilot audit history');
    const { events: pilotEvents } = await pilotAudit.json();
    expect(
      pilotEvents.map(({ event }: { event: string }) => JSON.parse(event)),
    ).toContainEqual(
      expect.objectContaining({
        action: 'reviewed',
        humanApprovalEvidenceUrl,
      }),
    );
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
    const productionApp = await production.json();
    expect(productionApp).toMatchObject({
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
    await waitForStatus(
      '/api/catalog/entities/by-name/user/default/engineer',
      headers,
    );
    await waitForStatus(
      '/api/catalog/entities/by-name/group/default/engineering',
      headers,
    );
    const coOwnership = await request.post(`${pilotPath}/graduation`, {
      headers,
      data: {
        nominee: 'user:default/engineer',
        expectedUpdatedAt: productionApp.updatedAt,
      },
    });
    await expectStatus(
      coOwnership,
      200,
      'Nominate a catalog engineering co-owner',
    );
    expect(await coOwnership.json()).toMatchObject({
      owner: productionApp.owner,
      lifecycle: 'experimental',
      reviewStatus: 'pending',
      graduation: {
        nominee: 'user:default/engineer',
        status: 'pending',
      },
    });
    const softwareDescriptor = (
      await readFile(
        join(startersRoot, 'ai-assisted-software/catalog-info.yaml'),
        'utf8',
      )
    ).replace('deliveryStage: trial', 'deliveryStage: poc');
    const validateStarter = await request.post(
      `${api}/repository?dryRun=true`,
      {
        headers,
        data: { content: softwareDescriptor },
      },
    );
    await expectStatus(
      validateStarter,
      200,
      'Validate a software-only starter descriptor',
    );
    expect((await validateStarter.json()).apps).toEqual([
      expect.objectContaining({
        name: 'AI-assisted software',
        tier: 1,
        deliveryStage: 'poc',
        usesAiAtRuntime: false,
        effectiveClassification: 'internal',
      }),
    ]);
    const importStarter = await request.post(`${api}/repository`, {
      headers,
      data: { content: softwareDescriptor },
    });
    await expectStatus(
      importStarter,
      201,
      'Import the software-only starter descriptor',
    );
    const importedStarter = await importStarter.json();
    expect(importedStarter).toMatchObject({
      usesAiAtRuntime: false,
      models: [],
      deliveryStage: 'poc',
    });
    await expectStatus(
      await request.post(`${api}/apps/${importedStarter.id}/gateway-key`, {
        headers,
      }),
      403,
      'Keep gateway keys unavailable for the imported software-only starter',
    );

    const softwareScorecard = await request.get(
      `${api}/apps/${importedStarter.id}/scorecard`,
      { headers },
    );
    await expectStatus(
      softwareScorecard,
      200,
      'Read the software-only scorecard',
    );
    expect((await softwareScorecard.json()).checks).toContainEqual({
      name: 'Gateway model policy and activity',
      status: 'not-applicable',
      detail: 'This app has no runtime model calls.',
    });

    const seed = () =>
      spawnSync(
        process.execPath,
        [resolve(backendRoot, '../../scripts/seed-gateway-demo.mjs')],
        {
          encoding: 'utf8',
          env: { ...process.env, FRONTSTAGE_DEMO_BACKEND_PORT: String(port) },
          timeout: 35_000,
        },
      );
    const readSeededInventory = async () => {
      const response = await request.get(`${api}/apps`, { headers });
      await expectStatus(response, 200, 'Read the seeded demo inventory');
      return (await response.json()).apps.filter(
        (record: { sourceUrl: string }) =>
          record.sourceUrl.startsWith('https://example.com/frontstage-demo/'),
      );
    };
    const firstSeed = seed();
    expect(firstSeed.status, firstSeed.stderr).toBe(0);
    const initialSeeded = await readSeededInventory();
    const secondSeed = seed();
    expect(secondSeed.status, secondSeed.stderr).toBe(0);
    const seeded = await readSeededInventory();
    expect(seeded).toHaveLength(7);
    expect(seeded).toEqual(initialSeeded);
    expect(seeded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Stock count proof of concept',
          starterId: 'data-validation',
          tier: 1,
          usesAiAtRuntime: false,
        }),
        expect.objectContaining({
          name: 'Purchase order pilot',
          starterId: 'internal-api',
          tier: 3,
          usesAiAtRuntime: false,
          reviewStatus: 'pending',
        }),
        expect.objectContaining({
          name: 'Meeting summary demo',
          starterId: 'gateway-assistant',
          lifecycle: 'active',
        }),
        expect.objectContaining({
          name: 'Restricted intake demo',
          tier: 3,
          reviewStatus: 'pending',
        }),
      ]),
    );
    const meetingDemo = seeded.find(
      (record: { name: string }) => record.name === 'Meeting summary demo',
    );
    const catalogMcp = new Client({
      name: 'frontstage-gateway-e2e',
      version: '1.0.0',
    });
    try {
      await catalogMcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve(backendRoot, '../../scripts/catalog-mcp.mjs')],
          env: {
            FRONTSTAGE_MCP_BACKEND_URL: backendUrl,
            FRONTSTAGE_MCP_TOKEN: identity.backstageIdentity.token,
            FRONTSTAGE_MCP_WRITE_ENABLED: 'true',
          },
        }),
      );
      const search = await catalogMcp.callTool({
        name: 'search_apps',
        arguments: { query: 'Meeting summary' },
      });
      expect(search.isError).not.toBe(true);
      expect(search.structuredContent).toMatchObject({
        apps: [{ id: meetingDemo.id, name: meetingDemo.name }],
      });
      const detail = await catalogMcp.callTool({
        name: 'get_app',
        arguments: { id: meetingDemo.id },
      });
      expect(detail.isError).not.toBe(true);
      expect(detail.structuredContent).toMatchObject({
        app: {
          id: meetingDemo.id,
          name: 'Meeting summary demo',
          tier: meetingDemo.tier,
          lifecycle: 'active',
        },
      });
      expect(search.structuredContent).not.toHaveProperty('apps.0.reviewNotes');
      expect(search.structuredContent).not.toHaveProperty('apps.0.evidence');
      expect(detail.structuredContent).not.toHaveProperty('app.reviewNotes');
      expect(detail.structuredContent).not.toHaveProperty('app.evidence');

      const restrictedModels = await catalogMcp.callTool({
        name: 'list_approved_models',
        arguments: { classification: 'restricted' },
      });
      expect(restrictedModels.isError).not.toBe(true);
      expect(restrictedModels.structuredContent).toMatchObject({
        enabled: true,
        productionAvailable: false,
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
        ],
      });

      const internalConnectors = await catalogMcp.callTool({
        name: 'list_approved_connectors',
        arguments: { kind: 'mcp', classification: 'internal' },
      });
      expect(internalConnectors.isError).not.toBe(true);
      expect(internalConnectors.structuredContent).toMatchObject({
        configured: true,
        connectors: [
          {
            id: 'catalog-sandbox',
            kind: 'mcp',
            access: 'read',
            maxClassification: 'internal',
          },
        ],
      });
      const confidentialConnectors = await catalogMcp.callTool({
        name: 'list_approved_connectors',
        arguments: { kind: 'mcp', classification: 'confidential' },
      });
      expect(confidentialConnectors.isError).not.toBe(true);
      expect(confidentialConnectors.structuredContent).toMatchObject({
        configured: true,
        connectors: [],
      });

      const personalApp = { audience: 'personal', classification: 'internal' };
      const baselineRisk = await catalogMcp.callTool({
        name: 'preview_risk',
        arguments: personalApp,
      });
      expect(baselineRisk.isError).not.toBe(true);
      expect(baselineRisk.structuredContent).toMatchObject({
        tier: 1,
        reasons: [],
        effectiveClassification: 'internal',
      });
      const writeRisk = await catalogMcp.callTool({
        name: 'preview_risk',
        arguments: { ...personalApp, connections: [{ access: 'write' }] },
      });
      expect(writeRisk.isError).not.toBe(true);
      expect(writeRisk.structuredContent).toMatchObject({
        tier: 3,
        reasons: expect.arrayContaining(['write-connection']),
        effectiveClassification: 'internal',
      });

      const mcpAppName = 'MCP inventory reconciliation';
      const content = (
        await readFile(
          join(startersRoot, 'internal-api/catalog-info.yaml'),
          'utf8',
        )
      )
        .replace('  name: internal-api', '  name: mcp-inventory-reconciliation')
        .replace('  name: Internal API', `  name: ${mcpAppName}`)
        .replace(
          'https://github.com/example-org/internal-api',
          'https://example.com/gateway-test/mcp-inventory-reconciliation',
        )
        .replace(
          '  usesAiAtRuntime: false',
          '  usesAiAtRuntime: false\n  starterId: internal-api',
        );
      const appSummary = {
        name: mcpAppName,
        tier: 1,
        starterId: 'internal-api',
        usesAiAtRuntime: false,
      };
      const searchRegistered = () =>
        catalogMcp.callTool({
          name: 'search_apps',
          arguments: { query: mcpAppName },
        });
      const preview = await catalogMcp.callTool({
        name: 'preview_descriptor',
        arguments: { content },
      });
      expect(preview.isError).not.toBe(true);
      expect(preview.structuredContent).toMatchObject({ apps: [appSummary] });
      expect(preview.structuredContent).not.toHaveProperty('apps.0.id');
      const afterPreview = await searchRegistered();
      expect(afterPreview.isError).not.toBe(true);
      expect(afterPreview.structuredContent).toEqual({ apps: [] });

      const registration = await catalogMcp.callTool({
        name: 'register_descriptor',
        arguments: { content },
      });
      expect(registration.isError).not.toBe(true);
      expect(registration.structuredContent).toMatchObject({
        app: { ...appSummary, id: expect.any(String) },
      });
      const { app: registeredApp } = registration.structuredContent as {
        app: { id: string };
      };
      const afterRegistration = await searchRegistered();
      expect(afterRegistration.isError).not.toBe(true);
      expect(afterRegistration.structuredContent).toMatchObject({
        apps: [{ ...appSummary, id: registeredApp.id }],
      });
      const stored = await catalogMcp.callTool({
        name: 'get_app',
        arguments: { id: registeredApp.id },
      });
      expect(stored.isError).not.toBe(true);
      expect(stored.structuredContent).toMatchObject({
        app: { ...appSummary, id: registeredApp.id },
      });
    } finally {
      await catalogMcp.close();
    }
    const hostedRecords = seeded.filter(
      (record: { type: string }) => record.type === 'provider-hosted app',
    );
    expect(hostedRecords).toHaveLength(2);
    for (const record of hostedRecords)
      expect(record).not.toHaveProperty('starterId');
    const hostedSnapshot = JSON.parse(
      await readFile(
        resolve(backendRoot, '../app/public/examples/hosted-inventory.json'),
        'utf8',
      ),
    );
    const hostedPreview = await request.post(
      `${api}/discovery/hosted/preview`,
      { headers, data: hostedSnapshot },
    );
    await expectStatus(
      hostedPreview,
      200,
      'Preview the seeded hosted inventory',
    );
    const { apps: previewedApps } = await hostedPreview.json();
    expect(previewedApps).toMatchObject([
      { name: 'Hosted project briefs demo', appId: expect.any(String) },
      {
        name: 'Hosted workspace demo',
        appId: expect.any(String),
        mismatch: 'workspace',
      },
      { name: 'Hosted meeting notes demo' },
    ]);
    const [, , unregistered] = previewedApps;
    expect(unregistered).not.toHaveProperty('appId');
    const directoryDemo = seeded.find(
      (record: { name: string }) =>
        record.name === 'Warehouse reconciliation demo',
    );
    expect(directoryDemo).toMatchObject({
      lifecycle: 'active',
      usesAiAtRuntime: false,
      directoryListing: {
        url: 'https://example.com/frontstage-demo/warehouse-reconciliation',
      },
    });
    const directoryQueue = await request.get(
      `${api}/apps/${directoryDemo.id}/directory-requests`,
      { headers },
    );
    await expectStatus(
      directoryQueue,
      200,
      'Read the seeded Directory request',
    );
    expect((await directoryQueue.json()).requests).toEqual([
      expect.objectContaining({ status: 'pending' }),
    ]);
    const hostedDemo = seeded.find(
      (record: { name: string }) => record.name === 'Hosted workspace demo',
    );
    expect(hostedDemo).toMatchObject({
      lifecycle: 'experimental',
      hosted: { workspace: 'Personal sandbox' },
    });
    const hostedDemoScorecard = await request.get(
      `${api}/apps/${hostedDemo.id}/scorecard`,
      { headers },
    );
    await expectStatus(
      hostedDemoScorecard,
      200,
      'Read the seeded hosted workspace scorecard',
    );
    expect((await hostedDemoScorecard.json()).checks).toContainEqual(
      expect.objectContaining({
        name: 'Declared provider workspace',
        status: 'attention',
      }),
    );
    const hostedDemoPath = `${api}/apps/${hostedDemo.id}`;
    const activateHostedDemo = (expectedUpdatedAt: string) =>
      request.patch(`${hostedDemoPath}/lifecycle`, {
        headers,
        data: { lifecycle: 'active', expectedUpdatedAt },
      });
    await expectStatus(
      await activateHostedDemo(hostedDemo.updatedAt),
      400,
      'Block activation in the unlisted demo workspace',
    );
    const correctedHostedDemo = await request.put(hostedDemoPath, {
      headers,
      data: {
        ...hostedDemo,
        hosted: { ...hostedDemo.hosted, workspace: 'Company sandbox' },
        expectedUpdatedAt: hostedDemo.updatedAt,
      },
    });
    await expectStatus(
      correctedHostedDemo,
      200,
      'Save the approved demo workspace',
    );
    const activatedHostedDemo = await activateHostedDemo(
      (
        await correctedHostedDemo.json()
      ).updatedAt,
    );
    await expectStatus(
      activatedHostedDemo,
      200,
      'Activate the hosted app in the approved demo workspace',
    );
    expect(await activatedHostedDemo.json()).toMatchObject({
      lifecycle: 'active',
      hosted: { workspace: 'Company sandbox' },
    });
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

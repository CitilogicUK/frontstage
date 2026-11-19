import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { expect, test, type Page } from '@playwright/test';
import { workspaceBackendUrl, workspaceUrl } from './workspaceUrls';

const catalogPath =
  '/catalog?filters%5Bkind%5D=component&filters%5Buser%5D=all&limit=20';
const destinations = [
  { label: 'Inventory', heading: 'AI app inventory' },
  { label: 'Directory', heading: 'App directory' },
  { label: 'Discovery', heading: 'App discovery' },
  { label: 'Reviews', heading: 'Critical app reviews' },
  { label: 'Reports', heading: 'Portfolio reports' },
  { label: 'Import', heading: 'Import existing apps' },
  { label: 'Templates', heading: 'App templates' },
  { label: 'Builder guide', heading: 'Builder guide' },
  { label: 'Notifications', heading: 'Notifications' },
];

async function assertWorkspace(page: Page, heading: string, active?: string) {
  await expect(
    page.getByRole('heading', { level: 1, name: heading }),
  ).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'AI governance' });
  await expect(navigation).toHaveCount(1);
  await expect(
    page.getByRole('link', { name: 'Catalog', exact: true }),
  ).toHaveCount(1);
  await expect(navigation.getByRole('link')).toHaveText([
    'Inventory',
    'Directory',
    'Catalog',
    'Discovery',
    'Reviews',
    'Notifications',
    'Reports',
    'Import',
    'Templates',
    'Builder guide',
  ]);
  const activeLink = navigation.locator('[aria-current="page"]');
  if (active) await expect(activeLink).toHaveText(active);
  else await expect(activeLink).toHaveCount(0);

  const hasOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  );
  expect(hasOverflow).toBe(false);
}

test('Catalog finds and opens managed apps by governance fields', async ({
  page,
}) => {
  const actor = 'user:default/owner';
  const app = {
    id: 'catalog-app',
    name: 'Managed catalog app',
    purpose: 'Catalog navigation fixture',
    owner: actor,
    team: 'group:default/platform',
    platform: 'GitHub',
    classification: 'internal',
    lifecycle: 'active',
    tier: 1,
    models: [],
    usesAiAtRuntime: false,
    reviewStatus: 'not required',
    nextReview: null,
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  await page.route(/\/api\/catalog\/entities(?:\?|$)/, route =>
    route.fulfill({
      json: [
        {
          apiVersion: 'governance.backstage.io/v1alpha1',
          kind: 'AIApp',
          metadata: {
            name: app.id,
            title: app.name,
            annotations: {
              'backstage.io/managed-by-location': 'governance:inventory',
            },
          },
          spec: {
            platform: 'GitHub',
            tier: 3,
            classification: 'internal',
            effectiveClassification: 'restricted',
            models: ['example-model'],
          },
        },
        {
          apiVersion: 'governance.backstage.io/v1alpha1',
          kind: 'AIApp',
          metadata: { name: 'other-app', title: 'Other app' },
        },
        {
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Component',
          metadata: { name: 'sample-service', title: 'Sample service' },
        },
      ],
    }),
  );
  await page.route('**/api/governance/apps', route =>
    route.fulfill({ json: { actor, canReview: false, apps: [app] } }),
  );
  await page.goto(catalogPath);
  const heading = page.getByRole('heading', { name: 'Software catalog' });
  const guest = page.getByRole('button', { name: 'Enter', exact: true });
  await expect(heading.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(
    page.getByRole('link', { name: 'Sample service' }),
  ).toHaveAttribute('href', '/catalog/default/component/sample-service');
  await page.getByRole('button', { name: 'AI apps', exact: true }).click();
  const otherApp = page.getByRole('link', { name: 'Other app' });
  await expect(otherApp).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search catalog' });
  const managedApp = page.getByRole('link', { name: app.name });
  for (const query of ['Tier 3', 'RESTRICTED', 'example-model', 'GitHub']) {
    await search.fill(query);
    await expect(managedApp).toBeVisible();
    await expect(otherApp).toBeHidden();
  }
  await managedApp.click();
  await expect(page).toHaveURL(`${workspaceUrl}/?app=${app.id}`);
  await expect(page.getByRole('dialog', { name: app.name })).toBeVisible();
});

test('workspace screens share navigation and fit the viewport', async ({
  page,
  request,
}, testInfo) => {
  await expect
    .poll(
      async () => {
        const health = await request
          .get(`${workspaceBackendUrl}/.backstage/health/v1/readiness`, {
            timeout: 2_000,
          })
          .catch(() => undefined);
        if (!health) return 0;
        const status = health.status();
        await health.dispose();
        return status;
      },
      { timeout: 20_000 },
    )
    .toBe(200);
  await page.route('**/api/governance/discovery/github', route =>
    route.fulfill({
      json: {
        source: { organization: 'example', topic: 'governance' },
        lastScan: {
          at: '2026-11-18T11:00:00Z',
          status: 'completed',
          trigger: 'manual',
          partial: true,
        },
        intervalMinutes: null,
        repositories: ['registered', 'unowned', 'dismissed'].map(status => ({
          id: status,
          name: `${status} repository`,
          description: '',
          sourceUrl: `https://github.com/example/${status}`,
          appId: status === 'registered' ? 'existing-app' : null,
          dismissed: status === 'dismissed' ? 1 : 0,
        })),
      },
    }),
  );
  await page.route(
    /\/api\/catalog\/entities(?:\?|$)/,
    route => route.fulfill({ status: 503 }),
    { times: 1 },
  );
  await page.goto(catalogPath);
  const heading = page.getByRole('heading', {
    level: 1,
    name: 'Software catalog',
  });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(heading.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();

  await assertWorkspace(page, 'Software catalog', 'Catalog');
  await expect(
    page.getByRole('button', { name: 'Components', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');

  const catalogSearch = page.getByRole('searchbox', { name: 'Search catalog' });
  await expect(page.getByRole('alert')).toHaveText(
    'The catalog could not load.',
  );
  await catalogSearch.fill('component fixture');
  await page.getByRole('button', { name: 'Retry loading Catalog' }).click();
  await expect(
    page.getByRole('heading', { name: 'No matching records' }),
  ).toBeVisible();
  await expect(catalogSearch).toHaveValue('component fixture');
  await expect(page).toHaveURL(`${workspaceUrl}${catalogPath}`);

  await page.route('**/api/governance/directory', route =>
    route.fulfill({ json: { apps: [] } }),
  );
  const navigation = page.getByRole('navigation', { name: 'AI governance' });
  for (const destination of destinations) {
    await navigation
      .getByRole('link', { name: destination.label, exact: true })
      .click();
    await assertWorkspace(page, destination.heading, destination.label);
  }

  await page.route(
    '**/api/governance/discovery/github',
    route =>
      route.fulfill({
        status: 503,
        json: { error: { message: 'Unavailable' } },
      }),
    { times: 1 },
  );
  await navigation.getByRole('link', { name: 'Reports', exact: true }).click();
  const coverage = page.locator('.gov-report-summary > div').filter({
    hasText: 'GitHub discovery coverage',
  });
  await expect(coverage.getByRole('status')).toHaveText('Coverage unavailable');
  await expect(coverage).not.toContainText('50%');
  await coverage
    .getByRole('button', { name: 'Retry loading coverage' })
    .click();
  await expect(coverage).toContainText('50%');
  await expect(coverage).toContainText('Excludes dismissed repositories');
  await expect(coverage).toContainText('Partial scan results');
  await coverage
    .getByRole('link', { name: 'Review 1 unowned repository' })
    .click();
  await expect(
    page.getByText(/1 of 2 tracked repositories registered.*50% coverage/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unowned 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismissed 1' })).toBeVisible();
  await page.route('**/api/governance/hosted-workspaces', route =>
    route.fulfill({
      json: {
        configured: true,
        workspaces: [
          {
            provider: 'Example AI',
            workspace: 'Company sandbox',
            allowedSharing: ['private', 'named people'],
            allowedDataAccess: ['none'],
          },
          { provider: 'Example AI', workspace: 'Internal sandbox' },
        ],
      },
    }),
  );
  await navigation
    .getByRole('link', { name: 'Builder guide', exact: true })
    .click();
  await expect(
    page.getByText(/if AI only helps write the code/i),
  ).toBeVisible();
  const guide = page.getByRole('region', { name: 'Approved gateway models' });
  await expect(guide.getByText('1,024 tokens', { exact: true })).toHaveCount(2);
  const workspaces = page.getByRole('region', {
    name: 'Approved provider workspaces',
  });
  const scopedWorkspace = workspaces.getByRole('listitem').filter({
    hasText: 'Example AI · Company sandbox',
  });
  await expect(scopedWorkspace).toContainText(
    'Allowed sharing: private, named people',
  );
  await expect(scopedWorkspace).toContainText('Allowed data access: none');
  const unrestrictedWorkspace = workspaces.getByRole('listitem').filter({
    hasText: 'Example AI · Internal sandbox',
  });
  await expect(unrestrictedWorkspace).toBeVisible();
  await expect(unrestrictedWorkspace).not.toContainText('Allowed');
  await guide
    .getByRole('link', { name: 'View apps declaring gpt-4.1-mini' })
    .click();
  await expect(
    page.getByRole('combobox', { name: 'Declared model' }),
  ).toHaveValue('gpt-4.1-mini');
  await navigation
    .getByRole('link', { name: 'Builder guide', exact: true })
    .click();

  await page.getByRole('link', { name: 'Browse app templates' }).click();
  await assertWorkspace(page, 'App templates', 'Templates');
  await page.getByLabel('Delivery stage').selectOption('poc');
  await page
    .getByRole('combobox', { name: 'Approved model' })
    .selectOption('gpt-4.1-nano');
  await page
    .getByRole('combobox', { name: 'Starter data classification' })
    .selectOption('restricted');
  const starterModel = page.getByRole('combobox', { name: 'Approved model' });
  await expect(starterModel).toHaveValue('gpt-4.1-mini');
  await expect(
    starterModel.getByRole('option', { name: 'gpt-4.1-nano' }),
  ).toHaveCount(0);
  for (const [id, button, usesAi] of [
    ['gateway-assistant', 'assistant', true],
    ['gateway-agent', 'agent', true],
    ['gateway-automation', 'automation', true],
    ['ai-assisted-software', 'AI-assisted software', false],
    ['internal-api', 'internal API', false],
    ['internal-web-app', 'internal web app', false],
    ['data-validation', 'data validation', false],
  ] as const) {
    const pending = page.waitForEvent('download');
    await page
      .getByRole('button', { name: `Download ${button} starter` })
      .click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(`frontstage-${id}.zip`);
    const path = await download.path();
    if (!path) throw new Error('Starter download has no local path');
    const files = unzipSync(await readFile(path));
    const ignore = strFromU8(files[`${id}/.gitignore`]).trim().split('\n');
    expect(ignore.slice(1)).toEqual(['.env', '.env.*', '!.env.example']);
    expect(strFromU8(files[`${id}/CLAUDE.md`]).trim()).toBe('@AGENTS.md');
    const agentGuide = strFromU8(files[`${id}/AGENTS.md`]);
    expect(agentGuide).toContain('Proof of concept');
    for (const tool of [
      'search_apps',
      'get_app',
      'preview_risk',
      'list_approved_models',
      'list_approved_connectors',
      'preview_descriptor',
      'register_descriptor',
    ]) {
      expect(agentGuide).toContain(tool);
    }
    expect(agentGuide).toMatch(/only with the user['’]s authorization/);
    const brief = strFromU8(files[`${id}/PROJECT_BRIEF.md`]);
    expect(brief).toContain('Delivery stage: Proof of concept');
    expect(brief).toContain(
      'Record whether the evidence supports the hypothesis.',
    );
    expect(brief).toContain(
      usesAi
        ? 'calls models through the gateway'
        : 'No runtime model calls are planned',
    );
    const descriptor = strFromU8(files[`${id}/catalog-info.yaml`]);
    expect(descriptor).toContain('deliveryStage: poc');
    expect(descriptor).toContain(`starterId: ${id}`);
    expect(descriptor).toContain(`usesAiAtRuntime: ${usesAi}`);
    expect(Boolean(files[`${id}/gateway.mjs`])).toBe(usesAi);
    expect(Boolean(files[`${id}/gateway.test.mjs`])).toBe(usesAi);
    expect(descriptor).toContain('classification: restricted');
    expect(descriptor).toContain('backupOwner: user:default/backup');
    expect(brief).toContain('Highest data classification: restricted');
    if (
      id === 'internal-api' ||
      id === 'internal-web-app' ||
      id === 'data-validation'
    ) {
      const entryPoint = id === 'data-validation' ? 'validate' : 'server';
      const sourceFiles = [
        'package.json',
        `${entryPoint}.mjs`,
        `${entryPoint}.test.mjs`,
      ];
      if (id === 'data-validation') sourceFiles.push('sample.json');
      if (id === 'internal-web-app') {
        sourceFiles.push('styles.css');
        expect(files[`${id}/README.md`]).toBeDefined();
      }
      expect(descriptor).not.toMatch(/^\s+models:/m);
      const appPackage = JSON.parse(strFromU8(files[`${id}/package.json`]));
      expect(appPackage.scripts).toEqual({
        start: `node ${entryPoint}.mjs`,
        test: 'node --test',
      });
      for (const name of sourceFiles)
        expect(files[`${id}/${name}`]).toBeDefined();
      if (testInfo.project.name === 'desktop') {
        const projectDir = await mkdtemp(join(tmpdir(), `frontstage-${id}-`));
        try {
          await Promise.all(
            sourceFiles.map(name =>
              writeFile(join(projectDir, name), files[`${id}/${name}`]),
            ),
          );
          execFileSync(process.execPath, ['--test'], {
            cwd: projectDir,
            timeout: 10_000,
          });
          if (id === 'data-validation')
            execFileSync(process.execPath, ['validate.mjs', 'sample.json'], {
              cwd: projectDir,
              timeout: 10_000,
            });
        } finally {
          await rm(projectDir, { recursive: true, force: true });
        }
      }
    }
    if (id === 'gateway-assistant' && testInfo.project.name === 'desktop') {
      const projectDir = await mkdtemp(join(tmpdir(), 'frontstage-gateway-'));
      try {
        await Promise.all(
          ['gateway.mjs', 'gateway.test.mjs'].map(name =>
            writeFile(join(projectDir, name), files[`${id}/${name}`]),
          ),
        );
        execFileSync(process.execPath, ['--test'], {
          cwd: projectDir,
          timeout: 10_000,
        });
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    }
    if (usesAi) {
      expect(brief).toContain('Configured model: `gpt-4.1-mini`');
      expect(descriptor).toContain('models: ["gpt-4.1-mini"]');
      expect(strFromU8(files[`${id}/gateway.mjs`])).toContain(
        `FRONTSTAGE_BACKEND_URL ?? "${workspaceBackendUrl}"`,
      );
      expect(strFromU8(files[`${id}/README.md`])).toContain(
        'workspace that generated this starter',
      );

      expect(strFromU8(files[`${id}/gateway.mjs`])).toContain(
        'FRONTSTAGE_MODEL ?? "gpt-4.1-mini"',
      );
    }
  }
  await page
    .getByRole('link', { name: 'Register from internal web app' })
    .click();
  await expect(page.getByLabel('Purpose', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Does the app use AI at runtime?')).toHaveValue(
    'no',
  );
  await expect(
    page.getByLabel('Does the app use AI at runtime?'),
  ).toHaveAccessibleDescription(
    'Using a coding agent to build the app does not count as runtime AI.',
  );
  await expect(page.getByLabel('Delivery stage')).toHaveValue('poc');
  await expect(page.getByLabel('Highest data classification')).toHaveValue(
    'restricted',
  );
  await expect(page.getByLabel('Models', { exact: true })).toHaveCount(0);

  await page.route('**/api/governance/apps', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const payload = route.request().postDataJSON();
    expect(payload).toMatchObject({
      starterId: 'internal-web-app',
      usesAiAtRuntime: false,
    });
    return route.fulfill({
      status: 201,
      json: {
        ...payload,
        id: 'starter-registration',
        tier: 1,
        reviewStatus: 'not required',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    });
  });
  await page.getByLabel('Highest data classification').selectOption('internal');
  await page
    .getByLabel('Purpose', { exact: true })
    .fill('Review stock counts.');
  await page.getByLabel('Source URL').fill('https://github.com/example/stock');
  await page.getByLabel('Owner', { exact: true }).fill('user:default/guest');
  await page.getByLabel('Owning team').fill('group:default/operations');
  await page.getByRole('button', { name: 'Register app', exact: true }).click();
  await expect(
    page.getByText('App registered.', { exact: true }),
  ).toBeVisible();

  await navigation
    .getByRole('link', { name: 'Templates', exact: true })
    .click();

  for (const [stage, exitCriterion] of [
    ['trial', 'decide whether to stop or propose a proof of concept'],
    ['pilot', 'thresholds for expanding, pausing, or rolling back the pilot'],
    ['production', 'which checks must pass before rollout'],
  ]) {
    await page.getByLabel('Delivery stage').selectOption(stage);
    const pending = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Download AI-assisted software starter' })
      .click();
    const download = await pending;
    const files = unzipSync(await readFile(await download.path()));
    const brief = strFromU8(files['ai-assisted-software/PROJECT_BRIEF.md']);
    expect(brief).toContain('## Exit criteria');
    expect(brief).toContain(exitCriterion);
  }
  await page.getByLabel('Delivery stage').selectOption('pilot');
  await page
    .getByRole('combobox', { name: 'Approved model' })
    .selectOption('gpt-4.1-nano');
  await page
    .getByRole('combobox', { name: 'Starter data classification' })
    .selectOption('confidential');
  await page.getByRole('link', { name: 'Register from gateway agent' }).click();
  await expect(page.getByLabel('Delivery stage')).toHaveValue('pilot');
  await assertWorkspace(page, 'Register an AI app');
  await expect(page.getByLabel('App type')).toHaveValue('agent');
  await expect(page.getByLabel('App name')).toHaveValue('Gateway agent');
  await expect(page.getByLabel('Purpose', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Highest data classification')).toHaveValue(
    'confidential',
  );
  await expect(page.getByLabel('Models', { exact: true })).toHaveValue(
    'gpt-4.1-mini',
  );
  await expect(
    page.getByLabel('Backup owner (required for tiers 2 and 3)'),
  ).toHaveAttribute('required');
  const modelInput = page.getByLabel('Models', { exact: true });
  await modelInput.fill('gpt-4.1-nano');
  await expect(modelInput).toHaveAccessibleDescription(
    'The gateway does not approve gpt-4.1-nano for confidential data.',
  );
  await page.getByLabel('Highest data classification').selectOption('internal');
  await expect(modelInput).not.toHaveAttribute('aria-describedby');
  await expect(page.getByLabel('Source URL')).toHaveValue('');

  await navigation
    .getByRole('link', { name: 'Inventory', exact: true })
    .click();
  await page.getByRole('link', { name: 'Register app', exact: true }).click();
  await assertWorkspace(page, 'Register an AI app');
  await expect(page.getByLabel('App name')).toHaveValue('');
  await expect(page.getByLabel('Highest data classification')).toHaveValue(
    'public',
  );
});

test('templates recover runtime downloads after retrying approved models', async ({
  page,
}) => {
  const model = 'gpt-4.1-mini';
  let policyAvailable = false;
  await page.route('**/api/governance/gateway/models', route =>
    policyAvailable
      ? route.fulfill({
          json: {
            enabled: true,
            models: [
              {
                id: model,
                allowedClassifications: ['internal'],
                maxCompletionTokens: 1024,
              },
            ],
          },
        })
      : route.fulfill({
          status: 503,
          json: { error: { message: 'Unavailable' } },
        }),
  );

  await page.goto('/?view=templates');
  const heading = page.getByRole('heading', {
    level: 1,
    name: 'App templates',
  });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(heading.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();

  const failure = page.getByText('Approved models could not load.', {
    exact: true,
  });
  const runtimeDownload = page.getByRole('button', {
    name: 'Download assistant starter',
  });
  const localDownload = page.getByRole('button', {
    name: 'Download AI-assisted software starter',
  });
  const models = page.getByRole('combobox', { name: 'Approved model' });
  await expect(failure).toBeVisible();
  await expect(runtimeDownload).toBeDisabled();
  await expect(localDownload).toBeEnabled();
  await expect(models).toHaveCount(0);

  policyAvailable = true;
  await page
    .getByRole('button', { name: 'Retry loading approved models' })
    .click();
  await expect(models).toHaveValue(model);
  await expect(runtimeDownload).toBeEnabled();
  await expect(localDownload).toBeEnabled();
  await expect(failure).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Starter data classification' })
    .selectOption('restricted');
  await expect(
    page.getByText('No approved model is available for restricted data.'),
  ).toBeVisible();
  await expect(runtimeDownload).toBeDisabled();
  await expect(localDownload).toBeEnabled();
});

test('reviewers can match outside-gateway usage to registered apps', async ({
  page,
}) => {
  const app = {
    id: 'hosted-workspace',
    name: 'Hosted workspace demo',
    purpose: 'Summarizes synthetic notes.',
    owner: 'user:default/owner',
    team: 'group:default/platform',
    platform: 'GitHub',
    sourceUrl: 'https://example.com/frontstage-demo/hosted-workspace',
    lifecycle: 'active',
    classification: 'internal',
    tier: 1,
    reviewStatus: 'not required',
    models: ['gpt-4.1-mini'],
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
  const snapshot = {
    from: '2026-06-01T00:00:00Z',
    to: '2026-06-08T00:00:00Z',
    rows: [
      { sourceUrl: app.sourceUrl, model: 'gpt-4.1-mini', calls: 12 },
      {
        sourceUrl: 'https://example.com/frontstage-demo/unregistered-assistant',
        model: 'gpt-4.1-mini',
        calls: 3,
      },
    ],
  };
  await page.route('**/api/governance/apps', route => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({
      json: { apps: [app], actor: 'user:default/reviewer', canReview: true },
    });
  });
  await page.route(
    '**/api/governance/reports/outside-gateway/preview',
    route => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual(snapshot);
      return route.fulfill({
        json: {
          ...snapshot,
          rows: [
            { ...snapshot.rows[0], appId: app.id, appName: app.name },
            snapshot.rows[1],
          ],
        },
      });
    },
  );

  await page.goto('/?view=reports');
  const report = page.getByRole('region', { name: 'Outside-gateway usage' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(report.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();

  const usageJson = report.getByRole('textbox', {
    name: 'Outside-gateway usage JSON',
  });
  const preview = report.getByRole('button', {
    name: 'Preview outside-gateway usage',
  });
  await usageJson.fill(JSON.stringify(snapshot));
  await preview.click();
  const match = report.getByRole('link', { name: app.name });
  await expect(match).toBeVisible();
  await expect(report.getByText('No app matched')).toBeVisible();
  await expect(
    report.getByRole('row', { name: /Hosted workspace demo/ }),
  ).toContainText('12');
  await expect(
    report.getByText('15 reported calls · 2 rows · 1 unmatched'),
  ).toBeVisible();
  const pendingSample = page.waitForEvent('download');
  await report
    .getByRole('link', { name: 'Download sample usage JSON' })
    .click();
  const sample = await pendingSample;
  expect(sample.suggestedFilename()).toBe('outside-gateway-usage.json');
  await usageJson.clear();
  await report
    .getByLabel('Upload usage JSON')
    .setInputFiles(await sample.path());
  await expect(match).toBeHidden();
  const uploadedPreview = page.waitForResponse(
    response =>
      response.url().endsWith('/reports/outside-gateway/preview') &&
      response.request().method() === 'POST',
  );
  await preview.click();
  expect((await uploadedPreview).ok()).toBe(true);
  await expect(match).toBeVisible();
  const pendingCsv = page.waitForEvent('download');
  await report
    .getByRole('button', { name: 'Download outside-gateway usage CSV' })
    .click();
  const download = await pendingCsv;
  expect(download.suggestedFilename()).toBe(
    'frontstage-outside-gateway-usage.csv',
  );
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv.trimEnd().split(/\r?\n/)).toEqual([
    '\uFEFFwindow_start_utc,window_end_utc,source_url,model,calls,app_id,app_name',
    `"${snapshot.from}","${snapshot.to}","${app.sourceUrl}","gpt-4.1-mini",12,"${app.id}","${app.name}"`,
    `"${snapshot.from}","${snapshot.to}","${snapshot.rows[1].sourceUrl}","gpt-4.1-mini",3,"",""`,
  ]);
  await match.click();
  const details = page.getByRole('dialog', { name: app.name });
  await expect(details).toBeVisible();
  await expect(page).toHaveURL(/[?&]view=reports(?:&|$)/);
  await details.getByRole('button', { name: 'Close app details' }).click();
  await expect(match).toBeVisible();

  const unmatched = report.getByRole('row', { name: /No app matched/ });
  await unmatched.getByRole('button', { name: 'Start registration' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Register an AI app' }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Source URL' })).toHaveValue(
    snapshot.rows[1].sourceUrl,
  );
});

test('the owner inventory prioritizes upcoming and overdue reviews', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await expect
    .poll(
      async () => {
        const response = await request
          .get(`${workspaceBackendUrl}/.backstage/health/v1/readiness`, {
            timeout: 2_000,
          })
          .catch(() => undefined);
        if (!response) return 0;
        const status = response.status();
        await response.dispose();
        return status;
      },
      { timeout: 20_000 },
    )
    .toBe(200);
  const actor = 'user:default/demo-owner';
  let viewer = actor;
  const base = {
    owner: actor,
    purpose: 'Synthetic inventory fixture',
    team: 'group:default/platform',
    platform: 'GitHub',
    classification: 'internal',
    lifecycle: 'active',
    models: ['gpt-4.1-mini', 'unapproved-model'],
    tier: 2,
    reviewStatus: 'not required',
  };
  const now = Date.now();
  await page.clock.setFixedTime(now);
  const dateInDays = (days: number, offsetMs = 0) =>
    new Date(now + days * 86_400_000 + offsetMs).toISOString();
  let includeRetirementDecision = false;
  let attested = false;
  const overdue = {
    ...base,
    id: 'overdue',
    discoverySource: 'registered',
    name: 'Overdue app',
    deliveryStage: 'production',
    nextReview: dateInDays(0),
    updatedAt: dateInDays(-1),
  };
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor: viewer,
        canReview: viewer !== actor,
        gatewayEnabled: true,
        apps: [
          {
            ...base,
            id: 'current',
            discoverySource: 'bulk import',
            name: 'Current app',
            platform: 'Hosted workspace & tools',
            effectiveClassification: 'confidential',
            lifecycle: 'deprecated',
            deliveryStage: 'poc',
            usesAiAtRuntime: false,
            models: [],
            nextReview: dateInDays(30, 1),
          },
          {
            ...base,
            id: 'soon',
            discoverySource: 'git',
            name: 'Due soon app',
            starterId: 'internal-web-app',
            models: ['gpt-4.1-mini', 'gpt-4.1-mini'],
            nextReview: dateInDays(30),
          },
          {
            ...overdue,
            retirementReview: includeRetirementDecision
              ? { status: 'pending', owner: actor, requestedAt: dateInDays(-1) }
              : undefined,
          },
          {
            ...base,
            id: 'other',
            name: 'Another owner’s app',
            owner: includeRetirementDecision ? actor : 'user:default/another',
            backupOwner: actor,
            team: 'group:default/operations',
            nextReview: dateInDays(-5),
          },
        ],
      },
    }),
  );
  await page.route('**/api/governance/apps/*/gateway-key', route =>
    route.fulfill({ json: { issued: false } }),
  );
  await page.route('**/api/governance/apps/*/usage', route =>
    route.fulfill({
      json: {
        gatewayPause:
          !attested && route.request().url().endsWith('/overdue/usage')
            ? 'attestation-overdue'
            : undefined,
        liveCalls: 0,
        simulatedCalls: 0,
        unclassifiedCalls: 0,
        liveEstimatedCostUsd: 0,
        requestsPerMinute: 30,
        monthlySpend: {
          monthStart: '2025-01-01T00:00:00Z',
          liveEstimatedCostUsd: 2,
          thresholdUsd: 20,
          stopAtThreshold: false,
        },
        blockedCalls: 0,
        blocks: [],
      },
    }),
  );
  await page.route('**/api/governance/apps/other/scorecard', route =>
    route.fulfill({
      json: {
        checks: [
          {
            name: 'Review status',
            status: 'attention',
            detail: 'The app needs a current attestation.',
          },
        ],
      },
    }),
  );
  await page.goto('/?owner=me');
  const heading = page.getByRole('heading', { name: 'AI app inventory' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(heading.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(page.getByLabel('Ownership')).toHaveValue('me');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Attestation overdue');
  const reviewCell = rows.first().getByRole('cell', {
    name: /^Attestation overdue\b/,
  });
  await expect(reviewCell).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Review', exact: true }),
  ).toHaveCount(1);
  if (await page.evaluate(() => matchMedia('(max-width: 780px)').matches)) {
    const cardLabel = await reviewCell.evaluate(
      cell => getComputedStyle(cell, '::before').content,
    );
    expect(cardLabel).toContain('Review');
  }
  await expect(rows.nth(1)).toContainText('Attestation due soon');
  await expect(rows.nth(2)).toContainText('Attestation current');
  await expect(rows.nth(0)).toContainText('Less than a day overdue');
  await expect(rows.nth(1)).not.toContainText('days overdue');
  const reviewStatus = page.getByRole('combobox', { name: 'Review status' });
  await page
    .getByRole('link', { name: '2 of your apps need review attention' })
    .click();
  await expect(reviewStatus).toHaveValue('attention');
  await expect(page).toHaveURL(/owner=me&review=attention$/);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Attestation overdue');
  await expect(rows.nth(1)).toContainText('Attestation due soon');
  await reviewStatus.selectOption('upcoming');
  await expect(page).toHaveURL(/owner=me&review=upcoming$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Due soon app');
  await page.reload();
  await expect(reviewStatus).toHaveValue('upcoming');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Due soon app');
  const upcomingDownload = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download my review calendar' })
    .click();
  const upcomingCalendar = await readFile(
    await (await upcomingDownload).path(),
    'utf8',
  );
  expect(upcomingCalendar.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  expect(upcomingCalendar).toContain('SUMMARY:App attestation: Due soon app');
  expect(upcomingCalendar).toContain(`URL:${workspaceUrl}/?app=soon`);
  await reviewStatus.selectOption('');
  const lifecycle = page.getByRole('combobox', {
    name: 'Lifecycle',
    exact: true,
  });
  await lifecycle.selectOption('deprecated');
  await expect(page).toHaveURL(/owner=me&lifecycle=deprecated$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Current app');
  await lifecycle.selectOption('');
  await expect(rows).toHaveCount(3);
  const model = page.getByRole('combobox', { name: 'Declared model' });
  await model.selectOption('gpt-4.1-mini');
  await expect(page).toHaveURL(/owner=me&model=gpt-4.1-mini$/);
  await expect(rows).toHaveCount(2);
  await lifecycle.selectOption('deprecated');
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/owner=me$/);
  await expect(model).toHaveValue('');
  await expect(rows).toHaveCount(3);

  await rows
    .nth(0)
    .getByRole('button', { name: /Overdue app/ })
    .click();
  await expect(page).toHaveURL(/owner=me&app=overdue/);
  await expect(page.getByRole('dialog', { name: 'Overdue app' })).toBeVisible();
  const playground = page.getByRole('region', { name: 'Gateway playground' });
  await expect(playground).toContainText('$18.00 until threshold');
  await expect(
    playground.getByText('Unavailable for internal data: unapproved-model.'),
  ).toBeVisible();
  await expect(
    playground.getByRole('option', { name: 'unapproved-model' }),
  ).toHaveCount(0);
  await expect(
    playground.getByRole('option', { name: 'gpt-4.1-mini' }),
  ).toHaveCount(1);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy app link' }).click();
  await expect(
    page.getByText('App link copied.', { exact: true }),
  ).toBeVisible();
  const copiedLink = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedLink).toBe(`${workspaceUrl}/?app=overdue`);

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: () => Promise.reject(new Error('Clipboard permission denied')),
    });
  });
  await page.getByRole('button', { name: 'Copy app link' }).click();
  const manualLink = page.getByRole('textbox', { name: 'Copy this app link' });
  await expect(manualLink).toHaveValue(copiedLink);
  await expect(manualLink).toBeFocused();
  await expect(manualLink).toHaveJSProperty('selectionStart', 0);
  await expect(manualLink).toHaveJSProperty('selectionEnd', copiedLink.length);

  const reminderPending = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download calendar reminder' })
    .click();
  const reminder = await reminderPending;
  expect(reminder.suggestedFilename()).toBe('frontstage-review.ics');
  const calendar = await readFile(await reminder.path(), 'utf8');
  expect(calendar).toContain('SUMMARY:App attestation: Overdue app');
  expect(calendar).toContain(`URL:${workspaceUrl}/?app=overdue`);
  expect(calendar).toContain('TRIGGER:-P7D');
  await page.goBack();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.goForward();
  await expect(page.getByRole('dialog', { name: 'Overdue app' })).toBeVisible();
  await page.getByRole('button', { name: 'Close app details' }).click();
  await expect(page).toHaveURL(/owner=me$/);
  await page.getByLabel('Delivery stage').selectOption('poc');
  await expect(page).toHaveURL(/owner=me&stage=poc$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Proof of concept');
  const bulkPending = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download my review calendar' })
    .click();
  const bulkCalendar = await bulkPending;
  expect(bulkCalendar.suggestedFilename()).toBe('frontstage-my-reviews.ics');
  const calendarText = await readFile(await bulkCalendar.path(), 'utf8');
  expect(calendarText.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  expect(calendarText).toContain('SUMMARY:App attestation: Current app');
  expect(calendarText).not.toContain('Another owner');

  const csvPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download inventory CSV' }).click();
  const csvDownload = await csvPending;
  expect(csvDownload.suggestedFilename()).toBe('frontstage-inventory.csv');
  const csv = await readFile(await csvDownload.path(), 'utf8');
  expect(csv).toContain('delivery_stage,uses_ai_at_runtime');
  expect(csv).toContain('"Current app"');
  expect(csv).toContain('"poc","No"');
  expect(csv.trimEnd()).toContain(`,"","${workspaceUrl}/?app=current"`);
  expect(csv).not.toContain('Overdue app');

  await page.getByLabel('Delivery stage').selectOption('unset');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Due soon app');
  await page.getByLabel('Delivery stage').selectOption('trial');
  await expect(page.getByText('No matching apps')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/owner=me$/);
  await expect(rows).toHaveCount(3);
  await page.getByLabel('Ownership').selectOption('backup');
  await expect(page).toHaveURL(/owner=backup$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Another owner’s app');
  await expect(rows.first()).toContainText('Attestation overdue');
  await expect(rows.first()).toContainText('5 days overdue');
  await rows
    .first()
    .getByRole('button', { name: /Another owner/ })
    .click();
  const backupDetails = page.getByRole('dialog', {
    name: 'Another owner’s app',
  });
  await backupDetails.getByText('App scorecard', { exact: true }).click();
  await expect(
    backupDetails.getByText('Review status · Needs attention'),
  ).toBeVisible();
  await expect(
    backupDetails.getByRole('button', { name: 'Record attestation' }),
  ).toHaveCount(0);
  await backupDetails
    .getByRole('button', { name: 'Close app details' })
    .click();
  await page.getByLabel('Ownership').selectOption('all');
  await expect(rows).toHaveCount(4);
  const appSearch = page.getByRole('searchbox', { name: 'Search apps' });
  await appSearch.fill('group:default/operations');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Another owner’s app');
  await appSearch.fill('user:default/demo-owner');
  await expect(rows).toHaveCount(4);
  await appSearch.clear();
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  const lifecycleReport = page.getByRole('region', {
    name: 'Apps by lifecycle',
  });
  await lifecycleReport
    .getByRole('link', { name: 'Deprecated: 1 app' })
    .click();
  await expect(page).toHaveURL(/lifecycle=deprecated$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Current app');
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Group inventory by' })
    .selectOption('registrationSource');
  const sourceReport = page.getByRole('region', {
    name: 'Apps by registration source',
  });
  await expect(
    sourceReport.getByRole('link', { name: 'Unrecorded: 1 app' }),
  ).toBeVisible();
  await sourceReport.getByRole('link', { name: 'Bulk import: 1 app' }).click();
  await expect(
    page.getByRole('combobox', { name: 'Registration source' }),
  ).toHaveValue('bulk import');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Current app');
  const sourceDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download inventory CSV' }).click();
  const sourceCsv = await readFile(await (await sourceDownload).path(), 'utf8');
  expect(sourceCsv.split('\r\n')[0]).toContain('registration_source');
  expect(sourceCsv.trimEnd().endsWith(',"bulk import","",""')).toBe(true);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Group inventory by' })
    .selectOption('starter');
  const starterReport = page.getByRole('region', { name: 'Apps by starter' });
  await expect(
    starterReport.getByRole('link', { name: 'No starter recorded: 3 apps' }),
  ).toBeVisible();
  await starterReport
    .getByRole('link', { name: 'Internal web app: 1 app' })
    .click();
  await expect(page).toHaveURL(`${workspaceUrl}/?starter=internal-web-app`);
  await expect(
    page.getByRole('combobox', { name: 'Starter', exact: true }),
  ).toHaveValue('internal-web-app');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Due soon app');
  const starterDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download inventory CSV' }).click();
  const starterCsv = await readFile(
    await (await starterDownload).path(),
    'utf8',
  );
  const [starterColumns, starterRow, ...additionalRows] = starterCsv
    .trimEnd()
    .split(/\r?\n/);
  expect(starterColumns).toMatch(/,starter_id$/);
  expect(starterRow).toContain('"Due soon app"');
  expect(starterRow).toMatch(/,"internal-web-app"$/);
  expect(additionalRows).toHaveLength(0);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Group inventory by' })
    .selectOption('starter');
  await starterReport
    .getByRole('link', { name: 'No starter recorded: 3 apps' })
    .click();
  await expect(page).toHaveURL(`${workspaceUrl}/?starter=none`);
  await expect(
    page.getByRole('combobox', { name: 'Starter', exact: true }),
  ).toHaveValue('none');
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'Due soon app' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Group inventory by' })
    .selectOption('classification');
  const classificationReport = page.getByRole('region', {
    name: 'Apps by data classification',
  });
  await classificationReport
    .getByRole('link', { name: 'Confidential: 1 app' })
    .click();
  await expect(
    page.getByRole('combobox', { name: 'Data classification', exact: true }),
  ).toHaveValue('confidential');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Current app');
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Group inventory by' })
    .selectOption('platform');
  const platformReport = page.getByRole('region', { name: 'Apps by platform' });
  await platformReport
    .getByRole('link', { name: 'Hosted workspace & tools: 1 app' })
    .click();
  await expect(
    page.getByRole('combobox', { name: 'Platform', exact: true }),
  ).toHaveValue('Hosted workspace & tools');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Current app');
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Group inventory by' })
    .selectOption('tier');
  const riskReport = page.getByRole('region', { name: 'Apps by risk tier' });
  await riskReport.getByRole('link', { name: 'Shared: 4 apps' }).click();
  await expect(page).toHaveURL(/tier=2$/);
  await expect(page.getByRole('button', { name: 'Shared 4' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rows).toHaveCount(4);
  await page.getByRole('button', { name: 'Personal 0' }).click();
  await expect(page.getByText('No matching apps')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(`${workspaceUrl}/`);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Group inventory by' })
    .selectOption('team');
  await page
    .getByRole('region', { name: 'Apps by team' })
    .getByRole('link', { name: 'group:default/operations: 1 app' })
    .click();
  await expect(page.getByRole('combobox', { name: 'Owning team' })).toHaveValue(
    'group:default/operations',
  );
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Another owner’s app');
  const teamFilter = page.getByRole('combobox', { name: 'Owning team' });
  await teamFilter.selectOption('');
  const accountableOwner = page.getByRole('combobox', {
    name: 'Accountable owner',
  });
  await accountableOwner.selectOption('user:default/another');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Another owner’s app');
  await page.reload();
  await expect(accountableOwner).toHaveValue('user:default/another');
  await expect(rows).toHaveCount(1);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Group inventory by' })
    .selectOption('accountableOwner');
  const byOwner = page.getByRole('region', {
    name: 'Apps by accountable owner',
  });
  await expect(
    byOwner.getByRole('link', { name: 'user:default/demo-owner: 3 apps' }),
  ).toBeVisible();
  await byOwner
    .getByRole('link', { name: 'user:default/another: 1 app' })
    .click();
  await expect(accountableOwner).toHaveValue('user:default/another');
  await expect(rows).toHaveCount(1);
  const ownerExport = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download inventory CSV' }).click();
  const ownerCsv = await readFile(await (await ownerExport).path(), 'utf8');
  expect(ownerCsv).toContain('"user:default/another"');
  expect(ownerCsv).not.toContain('"user:default/demo-owner"');
  await assertWorkspace(page, 'AI app inventory', 'Inventory');
  await teamFilter.selectOption('group:default/platform');
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(accountableOwner).toHaveValue('');
  await expect(rows).toHaveCount(4);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Group inventory by' })
    .selectOption('model');
  await page
    .getByRole('region', { name: 'Apps by declared model' })
    .getByRole('link', { name: 'gpt-4.1-mini: 3 apps' })
    .click();
  await expect(
    page.getByRole('combobox', { name: 'Declared model' }),
  ).toHaveValue('gpt-4.1-mini');
  await expect(rows).toHaveCount(3);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  const overdueMetric = page.locator('.gov-report-summary > div').filter({
    hasText: 'Overdue reviews and attestations',
  });
  await expect(overdueMetric).toContainText('50%');
  await expect(overdueMetric).toContainText(
    '2 of 4 non-retired Tier 2 and Tier 3 apps',
  );
  await overdueMetric.getByRole('link', { name: 'View overdue apps' }).click();
  await expect(page).toHaveURL(/review=overdue$/);
  await expect(reviewStatus).toHaveValue('overdue');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Another owner’s app');
  await expect(rows.first()).toContainText('5 days overdue');
  await expect(rows.last()).toContainText('Overdue app');
  const overdueCsvPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download inventory CSV' }).click();
  const overdueDownload = await overdueCsvPending;
  const overdueCsv = await readFile(await overdueDownload.path(), 'utf8');
  const [columns, oldest, newest] = overdueCsv.trimEnd().split(/\r?\n/);
  expect(columns).toMatch(
    /next_review_utc,days_overdue,app_url,registration_source,current_policy_tier,starter_id$/,
  );
  expect(
    oldest.endsWith(`,5,"${workspaceUrl}/?app=other","unrecorded","",""`),
  ).toBe(true);
  expect(
    newest.endsWith(`,0,"${workspaceUrl}/?app=overdue","registered","",""`),
  ).toBe(true);
  await reviewStatus.selectOption('');
  await expect(rows).toHaveCount(4);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  const portfolio = page.getByRole('region', {
    name: 'Apps by delivery stage',
  });
  const poc = portfolio
    .getByRole('row')
    .filter({ hasText: 'Proof of concept' });
  await expect(poc.locator('td')).toHaveText(['Proof of concept', '0', '1']);
  const production = portfolio
    .getByRole('row')
    .filter({ hasText: 'Production' });
  await expect(production.locator('td')).toHaveText(['Production', '1', '0']);
  await poc
    .getByRole('link', { name: 'Proof of concept, No runtime AI, 1 app' })
    .click();
  await expect(page.getByLabel('Delivery stage')).toHaveValue('poc');
  await expect(
    page.getByRole('combobox', { name: 'Runtime AI', exact: true }),
  ).toHaveValue('no');
  await expect(rows).toHaveCount(1);
  await page
    .getByRole('combobox', { name: 'Runtime AI', exact: true })
    .selectOption('yes');
  await expect(page.getByText('No matching apps')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows).toHaveCount(4);

  viewer = 'user:default/reviewer';
  await page.goto(copiedLink);
  const sharedApp = page.getByRole('dialog', { name: 'Overdue app' });
  await expect(sharedApp).toBeVisible();
  await expect(
    sharedApp.getByRole('button', { name: 'Record attestation' }),
  ).toHaveCount(0);

  await sharedApp.getByRole('button', { name: 'Close app details' }).click();
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page.getByRole('link', { name: 'View upcoming reviews' }).click();
  await expect(page).toHaveURL(/review=upcoming$/);
  const portfolioDownloadPending = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download upcoming review calendar' })
    .click();
  const portfolioDownload = await portfolioDownloadPending;
  expect(portfolioDownload.suggestedFilename()).toBe(
    'frontstage-upcoming-reviews.ics',
  );
  const portfolioCalendar = await readFile(
    await portfolioDownload.path(),
    'utf8',
  );
  expect(portfolioCalendar.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  expect(portfolioCalendar).toContain('SUMMARY:App attestation: Due soon app');
  expect(portfolioCalendar).not.toContain('Overdue app');

  viewer = actor;
  includeRetirementDecision = true;
  await page.goto('/?owner=me&review=overdue');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Another owner’s app');
  await expect(rows.last()).toContainText('Overdue app');

  await page.route('**/api/governance/apps/overdue/gateway-key', route =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 201, json: { key: 'synthetic-sandbox-key' } })
      : route.fallback(),
  );
  await page.route('**/api/governance/apps/overdue/attestation', route => {
    expect(route.request().postDataJSON()).toEqual({
      confirmed: true,
      expectedUpdatedAt: overdue.updatedAt,
    });
    attested = true;
    return route.fulfill({
      json: {
        ...overdue,
        updatedAt: dateInDays(0),
        nextReview: dateInDays(365),
      },
    });
  });
  await page.goto(copiedLink);
  const pause = playground.getByText('Gateway access is paused', {
    exact: false,
  });
  await expect(pause).toBeVisible();
  await playground.getByRole('button', { name: 'Issue gateway key' }).click();
  await expect(
    playground.getByText('Gateway key issued and hidden.'),
  ).toBeVisible();
  await playground
    .getByRole('textbox', { name: 'Prompt' })
    .fill('Synthetic prompt');
  const send = playground.getByRole('button', { name: 'Send prompt' });
  await expect(send).toBeDisabled();
  await expect(
    playground.getByRole('button', { name: 'Refresh usage' }),
  ).toBeVisible();
  await sharedApp.getByRole('checkbox', { name: /I confirm/ }).check();
  await sharedApp.getByRole('button', { name: 'Record attestation' }).click();
  await expect(pause).toHaveCount(0);
  await expect(send).toBeEnabled();
  await expect(
    sharedApp.getByText('Owner attestation recorded.'),
  ).toBeVisible();
});

test('owners can find active apps with failed scorecard checks', async ({
  page,
}) => {
  const actor = 'user:default/owner';
  const app = {
    id: 'needs-scorecard',
    name: 'Needs scorecard attention',
    purpose: 'Synthetic owner queue fixture',
    owner: actor,
    team: 'group:default/platform',
    platform: 'GitHub',
    classification: 'internal',
    lifecycle: 'active',
    tier: 1,
    models: ['fixture'],
    usesAiAtRuntime: true,
    reviewStatus: 'not required',
    nextReview: null,
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor,
        canReview: false,
        gatewayEnabled: true,
        apps: [
          app,
          { ...app, id: 'clear-scorecard', name: 'Current scorecard' },
          {
            ...app,
            id: 'other-scorecard',
            name: 'Another owner scorecard',
            owner: 'user:default/other',
          },
          {
            ...app,
            id: 'inactive-scorecard',
            name: 'Inactive scorecard',
            lifecycle: 'retired',
          },
        ],
      },
    }),
  );
  await page.route('**/api/governance/gateway/models', route =>
    route.fulfill({
      json: {
        enabled: true,
        models: [{ id: 'fixture', allowedClassifications: ['internal'] }],
      },
    }),
  );
  let unavailable = true;
  let keyIssued = false;
  await page.route('**/api/governance/owner-scorecard', route => {
    if (unavailable)
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Unavailable' } },
      });
    return route.fulfill({
      json: {
        issues: keyIssued ? [] : [{ appId: app.id, checks: ['Gateway key'] }],
        catalogUnavailable: true,
      },
    });
  });
  await page.route(
    '**/api/governance/apps/needs-scorecard/gateway-key',
    route => {
      if (route.request().method() === 'POST') {
        keyIssued = true;
        return route.fulfill({
          status: 201,
          json: { key: 'synthetic-gateway-key' },
        });
      }
      if (route.request().method() === 'DELETE') {
        keyIssued = false;
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({ json: { issued: keyIssued } });
    },
  );
  await page.route('**/api/governance/apps/needs-scorecard/scorecard', route =>
    route.fulfill({
      json: {
        checks: [
          {
            name: 'Gateway key',
            status: keyIssued ? 'pass' : 'attention',
            detail: keyIssued
              ? 'A gateway key is issued for this app.'
              : 'Issue a key to enable eligible calls.',
          },
        ],
      },
    }),
  );

  await page.goto('/?owner=me&review=scorecard');
  const inventory = page.getByRole('region', { name: 'AI app inventory' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(inventory.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  const retry = inventory.getByRole('button', { name: /Retry.*scorecard/i });
  await expect(retry).toBeVisible();
  unavailable = false;
  await retry.click();
  await expect(
    inventory.getByText(/Catalog unavailable.*scorecard checks/i),
  ).toBeVisible();
  const rows = inventory.getByRole('row');
  await expect(rows).toHaveCount(2);
  await expect(rows.last()).toContainText('Gateway key');
  await expect(rows.last()).toContainText(app.name);
  await rows
    .last()
    .getByRole('button', { name: /Needs scorecard attention/ })
    .click();
  const details = page.getByRole('dialog', { name: app.name });
  await details.getByText('App scorecard', { exact: true }).click();
  await expect(
    details.getByText('Issue a key to enable eligible calls.'),
  ).toBeVisible();
  await details.getByRole('button', { name: 'Issue gateway key' }).click();
  await expect(
    details.getByRole('button', { name: 'Rotate key' }),
  ).toBeVisible();
  await expect(details.getByText('Gateway key · Pass')).toBeVisible();
  await details.getByRole('button', { name: 'Revoke gateway key' }).click();
  await expect(
    details.getByText('Gateway key · Needs attention'),
  ).toBeVisible();
  await details.getByRole('button', { name: 'Issue gateway key' }).click();
  await expect(details.getByText('Gateway key · Pass')).toBeVisible();
  await details.getByRole('button', { name: 'Close app details' }).click();
  await expect(page).toHaveURL(/owner=me&review=scorecard$/);
  await expect(
    inventory.getByText(/Catalog unavailable.*scorecard checks/i),
  ).toBeVisible();
  await expect(inventory.getByText(app.name, { exact: true })).toHaveCount(0);
  await inventory
    .getByRole('combobox', { name: 'Ownership', exact: true })
    .selectOption('backup');
  await expect(
    inventory.getByRole('combobox', { name: 'Review status' }),
  ).toHaveValue('');
});

test('reviewers can download the spreadsheet import sample', async ({
  page,
}) => {
  const descriptorApp = {
    id: 'local-app',
    name: 'Imported local app',
    purpose: 'Synthetic proof of concept',
    owner: 'user:default/demo-owner',
    team: 'group:default/platform',
    platform: 'GitHub',
    classification: 'internal',
    deliveryStage: 'poc',
    lifecycle: 'experimental',
    tier: 1,
    models: [],
    usesAiAtRuntime: false,
    reviewStatus: 'not required',
  };
  let descriptorImported = false;
  await page.route('**/api/governance/apps', route =>
    descriptorImported
      ? route.fulfill({
          status: 503,
          json: { error: { message: 'Inventory unavailable' } },
        })
      : route.fulfill({
          json: {
            actor: 'user:default/demo-owner',
            canReview: true,
            gatewayEnabled: false,
            apps: [],
          },
        }),
  );
  let importWrites = 0;
  let validatedImport: unknown;
  await page.route('**/api/governance/imports?dryRun=true', route => {
    validatedImport = route.request().postDataJSON();
    return route.fulfill({
      json: {
        apps: [
          {
            name: 'Imported sample',
            starterId: 'internal-api',
            tier: 2,
            deliveryStage: 'poc',
            usesAiAtRuntime: false,
            effectiveClassification: 'internal',
            owner: 'user:default/demo-owner',
            backupOwner: 'user:default/backup',
            team: 'group:default/platform',
          },
        ],
      },
    });
  });
  await page.route('**/api/governance/imports', route => {
    expect(route.request().postDataJSON()).toEqual(validatedImport);
    importWrites += 1;
    return route.fulfill({ status: 201, json: [] });
  });
  await page.goto('/?view=import');
  const heading = page.getByRole('heading', { name: 'Import existing apps' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(heading.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();

  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download sample CSV' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('frontstage-app-import.csv');
  const path = await download.path();
  expect(await readFile(path, 'utf8')).toContain(
    'deliveryStage,usesAiAtRuntime',
  );
  await page.getByLabel('App file').setInputFiles({
    name: 'sample.csv',
    mimeType: 'text/csv',
    buffer: await readFile(path),
  });
  await page.getByRole('button', { name: 'Validate file' }).click();
  await expect(
    page.getByRole('region', { name: 'Import preview' }),
  ).toContainText(
    'Imported sample · Tier 2 · Proof of concept · No runtime AI · internal',
  );
  await expect(
    page.getByRole('region', { name: 'Import preview' }),
  ).toContainText(
    'Owner: user:default/demo-owner · Backup owner: user:default/backup · Team: group:default/platform',
  );
  await expect(
    page.getByRole('region', { name: 'Import preview' }),
  ).toContainText('Starter: Internal API');
  expect(importWrites).toBe(0);
  await page.getByRole('button', { name: 'Import apps' }).click();
  await expect(page.getByText('Import complete.')).toBeVisible();
  expect(importWrites).toBe(1);

  await page.route('**/api/governance/repository?dryRun=true', route =>
    route.fulfill({ json: { apps: [descriptorApp] } }),
  );
  await page.route('**/api/governance/repository', route => {
    descriptorImported = true;
    return route.fulfill({ status: 201, json: descriptorApp });
  });
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.getByLabel('App file').setInputFiles({
    name: 'catalog-info.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from('kind: AIApp'),
  });
  await page.getByRole('button', { name: 'Validate file' }).click();
  await expect(
    page.getByRole('region', { name: 'Import preview' }),
  ).toContainText(descriptorApp.name);
  await page.getByRole('button', { name: 'Import apps' }).click();
  await expect(page).toHaveURL(/app=local-app$/);
  await expect(
    page.getByRole('dialog', { name: descriptorApp.name }),
  ).toBeVisible();
});

test('consequential action reviews ask for human approval evidence', async ({
  page,
}) => {
  const app = {
    id: 'manual-control',
    name: 'Sandbox order submission',
    purpose: 'Creates test orders in a sandbox.',
    owner: 'user:default/owner',
    team: 'group:default/platform',
    platform: 'GitHub',
    sourceUrl: 'https://example.com/orders',
    lifecycle: 'experimental',
    classification: 'internal',
    tier: 3,
    reviewStatus: 'pending',
    usesAiAtRuntime: false,
    takesActions: true,
    humanApprovalEvidenceRequired: true,
    models: [],
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
  const evidence = 'https://example.com/evidence/order-approval';
  let submission: unknown;
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: { apps: [app], actor: 'user:default/reviewer', canReview: true },
    }),
  );
  await page.route('**/api/governance/apps/manual-control/reviews', route => {
    submission = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ...app,
        updatedAt: '2026-06-01T00:01:00.000Z',
        reviewStatus: 'approved',
      },
    });
  });
  await page.route('**/api/governance/apps/manual-control/history', route =>
    route.fulfill({
      json: {
        events: [
          {
            digest: 'approval',
            event: JSON.stringify({
              action: 'reviewed',
              actor: 'user:default/reviewer',
              record: app,
              humanApprovalEvidenceUrl: evidence,
            }),
          },
        ],
        keyEvents: [],
      },
    }),
  );
  await page.goto('/?app=manual-control');
  const details = page.getByRole('dialog', { name: app.name });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(details.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();

  const decision = details.getByRole('combobox', { name: 'Decision' });
  const verification = details.getByRole('checkbox', {
    name: 'I verified human approval for consequential actions',
  });
  const link = details.getByRole('textbox', {
    name: 'Human approval evidence URL',
  });
  await decision.selectOption('changes needed');
  await expect(verification).toHaveCount(0);
  await decision.selectOption('approved');
  await expect(verification).toBeVisible();
  await verification.check();
  await link.fill(evidence);
  await details
    .getByRole('textbox', { name: 'Review notes' })
    .fill('Verified.');
  await details.getByRole('button', { name: 'Record decision' }).click();
  await expect(details.getByText('Review recorded.')).toBeVisible();
  await expect(verification).not.toBeChecked();
  await expect(link).toHaveValue('');
  expect(submission).toMatchObject({
    status: 'approved',
    humanApprovalVerified: true,
    humanApprovalEvidenceUrl: evidence,
  });
  await details.getByText('Audit history', { exact: true }).click();
  await expect(
    details.getByText(`Human approval verified · ${evidence}`),
  ).toBeVisible();
});

test('reviewers can find required reviews without a linked ticket', async ({
  page,
}) => {
  const app = {
    id: 'missing-ticket',
    name: 'Missing ticket app',
    purpose: 'Synthetic critical review fixture',
    owner: 'user:default/owner',
    team: 'group:default/platform',
    tier: 3,
    lifecycle: 'experimental',
    reviewStatus: 'pending',
    nextReview: null,
    classification: 'internal',
    platform: 'GitHub',
    models: [],
  };
  const overdueApp = {
    ...app,
    id: 'overdue-ticket',
    name: 'Overdue renewal app',
    lifecycle: 'active',
    reviewStatus: 'approved',
    nextReview: '2025-01-01T00:00:00.000Z',
  };
  let canReview = true;
  let reviewTicketUrl: string | undefined;
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        canReview,
        actor: 'user:default/reviewer',
        apps: [
          { ...app, reviewTicketUrl },
          { ...overdueApp, reviewTicketUrl },
          {
            ...app,
            id: 'linked-ticket',
            name: 'Linked ticket app',
            reviewTicketUrl: 'https://tickets.example.com/reviews/linked',
          },
          { ...app, id: 'retired', name: 'Retired app', lifecycle: 'retired' },
          {
            ...app,
            id: 'current',
            name: 'Current review app',
            lifecycle: 'active',
            reviewStatus: 'approved',
            nextReview: new Date(Date.now() + 10 * 86_400_000).toISOString(),
          },
        ],
      },
    }),
  );
  await page.goto('/?view=reports');
  const queueLink = page.getByRole('link', {
    name: '2 missing a review ticket',
  });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(queueLink.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await queueLink.click();
  await expect(page).toHaveURL(/view=reviews&review=missing-ticket$/);
  const filter = page.getByRole('combobox', { name: 'Review status' });
  await expect(filter).toHaveValue('missing-ticket');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: app.name })).toHaveCount(1);
  await expect(rows.filter({ hasText: overdueApp.name })).toHaveCount(1);

  const search = page.getByRole('searchbox', { name: 'Search apps' });
  await search.fill('no matching review tickets');
  await expect(
    page.getByRole('heading', { name: 'No matching apps' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'No missing review tickets' }),
  ).toHaveCount(0);
  await search.clear();
  await expect(rows).toHaveCount(2);

  reviewTicketUrl = 'https://tickets.example.com/reviews/assigned';
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'No missing review tickets' }),
  ).toBeVisible();

  canReview = false;
  await page.reload();
  await expect(filter).toHaveValue('attention');
  await expect(
    filter.getByRole('option', { name: 'Missing review ticket' }),
  ).toHaveCount(0);
});

test('the risk reassessment queue shows both tiers and prioritizes increases', async ({
  page,
}) => {
  const base = {
    owner: 'user:default/demo-owner',
    team: 'group:default/platform',
    purpose: 'Synthetic reassessment fixture',
    platform: 'GitHub',
    classification: 'internal',
    lifecycle: 'experimental',
    models: [],
    usesAiAtRuntime: false,
    updatedAt: '2025-01-01T10:00:00.000Z',
    reviewStatus: 'pending',
  };
  let reviewer = true;
  const increase = {
    ...base,
    id: 'increase',
    name: 'Tier increase',
    tier: 1,
    riskAssessment: { tier: 2, reasons: ['configured-minimum'] },
  };
  await page.route('**/api/governance/apps/increase', route => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().postDataJSON()).toMatchObject({
      expectedUpdatedAt: base.updatedAt,
      backupOwner: 'user:default/backup',
    });
    return route.fulfill({
      json: {
        ...increase,
        tier: 2,
        backupOwner: 'user:default/backup',
        reviewStatus: 'not required',
        updatedAt: '2025-01-02T10:00:00.000Z',
      },
    });
  });
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor: reviewer ? 'user:default/reviewer' : base.owner,
        canReview: reviewer,
        apps: [
          {
            ...base,
            id: 'decrease',
            name: 'Tier decrease',
            owner: 'user:default/other-owner',
            backupOwner: base.owner,
            tier: 3,
            riskAssessment: { tier: 2, reasons: [] },
          },
          increase,
        ],
      },
    }),
  );
  await page.goto('/?review=reassess');
  const rows = page.locator('tbody tr');
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(rows.first().or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Tier increase');
  await expect(rows.first()).toContainText('T1 · Personal');
  await expect(rows.first()).toContainText('Current policy tier 2');
  await expect(rows.last()).toContainText('Tier decrease');
  await expect(rows.last()).toContainText('T3 · Critical');
  await expect(rows.last()).toContainText('Current policy tier 2');
  await rows
    .first()
    .getByRole('button', { name: 'Reassess Tier increase' })
    .click();
  const details = page.getByRole('dialog', { name: 'Tier increase' });
  const editor = details.getByText('Edit app details', { exact: true });
  await expect(editor).toBeFocused();
  await expect(
    details.getByRole('button', { name: 'Save app details' }),
  ).toBeVisible();
  await details
    .getByLabel('Backup owner', { exact: true })
    .fill('user:default/backup');
  await details.getByRole('button', { name: 'Save app details' }).click();
  await expect(details.getByRole('status')).toHaveText(
    'Risk tier updated to Tier 2.',
  );
  await details.getByRole('button', { name: 'Close app details' }).click();
  await expect(page).toHaveURL(/review=reassess$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Tier decrease');

  reviewer = false;
  await page.goto('/');
  await page
    .getByRole('link', { name: '1 of your apps needs risk reassessment' })
    .click();
  await expect(page).toHaveURL(/owner=me&review=reassess$/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Tier increase');
  await rows
    .first()
    .getByRole('button', { name: 'Reassess Tier increase' })
    .click();
  await expect(
    details.getByRole('button', { name: 'Save app details' }),
  ).toBeVisible();
  await details.getByRole('button', { name: 'Close app details' }).click();
  await page
    .getByRole('combobox', { name: 'Ownership', exact: true })
    .selectOption('backup');
  await expect(page).toHaveURL(/owner=backup$/);
  await expect(rows.first()).toContainText('Tier decrease');
  await expect(
    page.getByRole('button', { name: 'Reassess Tier decrease' }),
  ).toHaveCount(0);
});

test('audit history shows production review and ownership handoff', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const pilot = {
    id: 'purchase-order',
    name: 'Purchase order pilot',
    owner: 'user:default/demo-owner',
    team: 'group:default/procurement',
    purpose: 'Sandbox purchase orders',
    platform: 'GitHub',
    classification: 'internal',
    lifecycle: 'active',
    models: [],
    usesAiAtRuntime: false,
    deliveryStage: 'pilot',
    tier: 3,
    reviewStatus: 'approved',
    updatedAt: '2025-01-01T10:00:00.000Z',
  };
  const production = {
    ...pilot,
    deliveryStage: 'production',
    lifecycle: 'experimental',
    reviewStatus: 'pending',
    updatedAt: '2025-01-02T10:00:00.000Z',
  };
  const handoff = {
    ...production,
    reviewTicketUrl: 'https://tickets.example.com/review/123',
    riskAssessment: { tier: 2, reasons: ['configured-minimum'] },
    owner: 'user:default/new-owner',
    updatedAt: '2025-01-03T10:00:00.000Z',
  };
  const securityReview = {
    ...handoff,
    updatedAt: '2025-01-04T10:00:00.000Z',
    signoffs: {
      security: { status: 'approved', at: '2025-01-04T10:00:00.000Z' },
    },
  };
  const renewal = {
    ...pilot,
    id: 'renewal',
    name: 'Upcoming renewal',
    usesAiAtRuntime: true,
    deliveryStage: 'production',
    nextReview: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  };
  await page.route('**/api/governance/reports/review-turnaround', route =>
    route.fulfill({
      json: {
        decisions: 2,
        medianWorkingDays: 1.5,
        target: { workingDays: 3, pendingAtOrOver: 1 },
        pending: 1,
        pendingAppIds: [handoff.id],
        pendingApps: [{ appId: handoff.id, workingDays: 3.5 }],
        oldestPending: { appId: handoff.id, workingDays: 3.5 },
      },
    }),
  );
  let currentHandoff = handoff;
  let currentRenewal = renewal;
  await page.route('**/api/governance/apps/renewal/lifecycle', async route => {
    expect(route.request().method()).toBe('PATCH');
    const update = route.request().postDataJSON();
    expect(update.reason).toBe('Replaced by the shared workflow');
    currentRenewal = { ...renewal, lifecycle: update.lifecycle };
    await route.fulfill({ json: currentRenewal });
  });
  await page.route('**/api/governance/apps/purchase-order', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const update = route.request().postDataJSON();
    currentHandoff = { ...handoff, owner: update.owner, team: update.team };
    await route.fulfill({ json: currentHandoff });
  });
  await page.route('**/api/governance/apps', route =>
    currentHandoff !== handoff || currentRenewal !== renewal
      ? route.fulfill({
          status: 503,
          json: { error: { message: 'Inventory unavailable after the save' } },
        })
      : route.fulfill({
          json: {
            actor: pilot.owner,
            canReview: true,
            reviewTracks: ['security', 'dataProtection'],
            reviewerTracks: ['security'],
            apps: [renewal, handoff],
          },
        }),
  );
  await page.route('**/api/governance/apps/purchase-order/history', route =>
    route.fulfill({
      json: {
        keyEvents: [
          {
            action: 'issued',
            actor: pilot.owner,
            at: pilot.updatedAt,
            digest: 'b'.repeat(64),
            event: JSON.stringify({ environment: 'production' }),
          },
          {
            action: 'revoked',
            actor: pilot.owner,
            at: handoff.updatedAt,
            digest: 'a'.repeat(64),
          },
        ],
        events: [
          { ...pilot, tier: 2 },
          production,
          handoff,
          securityReview,
        ].map((record, revision) => ({
          digest: String(revision).padStart(64, '0'),
          event: JSON.stringify({
            action: ['registered', 'updated', 'updated', 'reviewed'][revision],
            actor: pilot.owner,
            record,
          }),
        })),
      },
    }),
  );
  const reportedTeam = 'group:default/reassigned-team';
  let failOwnershipLookup = false;
  await page.route('**/api/governance/reports/ownership', route => {
    if (failOwnershipLookup) {
      failOwnershipLookup = false;
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Catalog unavailable' } },
      });
    }
    return route.fulfill({
      json: {
        issues:
          currentHandoff.owner === handoff.owner
            ? [
                {
                  appId: handoff.id,
                  name: handoff.name,
                  unavailable: [handoff.owner, reportedTeam],
                  unavailableDetails: [
                    { role: 'owner', ref: handoff.owner, reason: 'inactive' },
                    { role: 'team', ref: reportedTeam, reason: 'missing' },
                  ],
                  availableBackupOwner: pilot.owner,
                },
              ]
            : [],
      },
    });
  });
  await page.route('**/api/governance/reports/usage', route =>
    route.fulfill({
      json: {
        from: '2025-01-01T00:00:00.000Z',
        retirementReview: {
          days: 90,
          apps:
            currentRenewal.lifecycle === 'retired'
              ? []
              : [
                  {
                    appId: renewal.id,
                    lastLiveCall: '2024-09-01T00:00:00.000Z',
                  },
                ],
        },
        monthlySpendAlerts: {
          monthStart: '2025-01-01T00:00:00.000Z',
          apps: [
            {
              appId: handoff.id,
              liveEstimatedCostUsd: 21.5,
              thresholdUsd: 20,
              stopAtThreshold: true,
            },
          ],
        },

        usage: [
          {
            appId: handoff.id,
            model: 'fixture',
            mode: 'openai',
            calls: 2,
            estimatedCostUsd: 0.12,
          },
          {
            appId: renewal.id,
            model: 'fixture',
            mode: 'simulation',
            calls: 3,
            estimatedCostUsd: 9,
          },
        ],
        blocks: [
          { appId: renewal.id, mode: 'simulation', reason: 'review', calls: 4 },
          {
            appId: 'missing-app',
            mode: 'simulation',
            reason: 'tier-drift',
            calls: 1,
          },
        ],
      },
    }),
  );
  await page.route('**/api/governance/reports/usage?days=7', route =>
    route.fulfill({
      json: { from: '2025-01-24T00:00:00.000Z', usage: [], blocks: [] },
    }),
  );
  await page.goto('/?view=reviews&stage=production');
  const dialog = page.getByRole('dialog', { name: pilot.name });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  const heading = page.getByRole('heading', { name: 'Critical app reviews' });
  await expect(heading.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  const stage = page.getByRole('combobox', { name: 'Delivery stage' });
  await expect(stage).toHaveValue('production');
  const reviewRows = page.locator('tbody tr');
  await expect(reviewRows).toHaveCount(2);
  await expect(
    reviewRows.first().getByRole('link', {
      name: 'Open review ticket for Purchase order pilot',
    }),
  ).toHaveAttribute('href', handoff.reviewTicketUrl);
  await expect(reviewRows.first()).toContainText('Purchase order pilot');
  await expect(reviewRows.last()).toContainText('Review due soon');

  await stage.selectOption('pilot');
  await expect(page.getByText('No matching apps')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/view=reviews$/);
  await stage.selectOption('production');
  await page.getByRole('button', { name: /Purchase order pilot/ }).click();
  await expect(
    dialog.getByRole('link', { name: 'Open review ticket' }),
  ).toHaveAttribute('href', handoff.reviewTicketUrl);
  await dialog.getByText('Audit history', { exact: true }).click();
  await expect(
    dialog.getByRole('textbox', { name: 'Final record digest (SHA-256)' }),
  ).toHaveValue('3'.padStart(64, '0'));
  await expect(
    dialog.getByRole('textbox', { name: 'Final key event digest (SHA-256)' }),
  ).toHaveValue('a'.repeat(64));
  await expect(dialog.getByText('Key revoked', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText('Production gateway key', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText('Security: approved')).toBeVisible();
  await expect(
    dialog.getByText('Lifecycle changed to experimental', { exact: false }),
  ).toBeVisible();
  await expect(dialog.getByText('Overall review: pending')).toBeVisible();
  await expect(
    dialog.getByText('Risk tier changed from Tier 2 to Tier 3', {
      exact: false,
    }),
  ).toBeVisible();
  await dialog.getByText('Current risk assessment', { exact: true }).click();
  await expect(
    dialog.getByText('Tier 2 · Shared', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('list', { name: 'Reasons for this tier' }),
  ).toContainText('A workspace policy rule requires at least this tier.');
  await expect(
    dialog.getByText(
      'This record was saved as Tier 3. Complete any required fields and save the app details to apply the current policy.',
    ),
  ).toBeVisible();

  await expect(
    dialog.getByText(
      'Owner changed from user:default/demo-owner to user:default/new-owner · Review ticket linked',
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText('Delivery stage: Production · Approval reopened'),
  ).toBeVisible();
  await expect(
    dialog.getByText('Delivery stage: Pilot · No runtime AI'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close app details' }).click();
  await page.route(
    '**/api/governance/reports/review-turnaround',
    route => route.fulfill({ status: 503, json: {} }),
    { times: 1 },
  );
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('button', { name: 'Retry loading review turnaround' })
    .click();
  await expect(
    page
      .locator('dl > div')
      .filter({ hasText: 'Median time to first Tier 3 decision' }),
  ).toContainText('1.5 weekdays');
  const oldestPending = page.getByRole('link', {
    name: 'Oldest pending first decision',
  });
  await expect(oldestPending).toHaveAttribute(
    'href',
    '/?view=reports&app=purchase-order',
  );
  await expect(
    page.getByText('3.5 weekdays waiting · 1 awaiting a first decision'),
  ).toBeVisible();

  const windowSelect = page.getByRole('combobox', { name: 'Reporting window' });
  await expect(windowSelect).toHaveValue('30');
  const outsideSpend = page.getByRole('spinbutton', {
    name: 'Model spend outside the gateway (USD)',
  });
  await page.getByText('Estimate gateway spend share', { exact: true }).click();
  await outsideSpend.fill('0.08');
  await expect(page.getByText('60% estimated gateway share')).toBeVisible();
  const spendExportPending = page.waitForEvent('download');
  const downloadSpend = page.getByRole('button', {
    name: 'Download spend share CSV',
  });
  await downloadSpend.click();
  const spendExport = await spendExportPending;
  expect(spendExport.suggestedFilename()).toBe(
    'frontstage-gateway-spend-share.csv',
  );
  expect(await readFile(await spendExport.path(), 'utf8')).toBe(
    '\uFEFFwindow_start_utc,window_days,estimated_gateway_cost_usd,reported_outside_cost_usd,estimated_gateway_share\r\n' +
      '"2025-01-01T00:00:00.000Z",30,0.12,0.08,0.6\r\n',
  );
  await outsideSpend.fill('-1');
  await expect(
    page.getByText('Enter a non-negative USD amount.'),
  ).toBeVisible();
  await page.route(
    '**/api/governance/reports/usage?days=7',
    route => route.fulfill({ status: 503, json: {} }),
    { times: 1 },
  );
  await windowSelect.selectOption('7');
  await expect(page).toHaveURL(/view=reports&days=7$/);
  await expect(page.getByText('Live estimated cost · 7 days')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Retry loading gateway usage' })
    .click();
  await expect(windowSelect).toHaveValue('7');
  await expect(page.getByText('No gateway calls recorded')).toBeVisible();
  await expect(page.getByText('Live estimated cost · 7 days')).toBeVisible();
  await page.getByText('Estimate gateway spend share', { exact: true }).click();
  await expect(outsideSpend).toHaveValue('');
  await outsideSpend.fill('0');
  await expect(page.getByText('No spend in this window.')).toBeVisible();
  await windowSelect.selectOption('30');
  const thresholds = page.getByRole('region', {
    name: 'Monthly spend thresholds',
  });
  await expect(thresholds).toContainText('$21.50 estimated live cost');
  await expect(thresholds).toContainText('Live calls blocked');
  await expect(
    thresholds.getByRole('link', { name: handoff.name }),
  ).toHaveAttribute('href', '/?view=reports&app=purchase-order');
  const retirementReview = page.getByRole('region', {
    name: 'Retirement review',
  });
  await expect(retirementReview).toContainText('Last live call 2024-09-01');
  await expect(
    retirementReview.getByRole('link', { name: renewal.name }),
  ).toHaveAttribute('href', '/?view=reports&app=renewal');
  const teamUsage = page.getByRole('region', { name: 'Gateway usage by team' });
  const procurement = teamUsage
    .getByRole('row')
    .filter({ hasText: 'group:default/procurement' });
  await expect(procurement.locator('td')).toHaveText([
    'group:default/procurement',
    '2',
    '3',
    '4',
    '$0.12',
  ]);
  const groupUsage = page.getByRole('combobox', {
    name: 'Group gateway usage',
  });
  await groupUsage.selectOption('model');
  await expect(page).toHaveURL(/view=reports&usageGroup=model$/);
  const modelUsage = page.getByRole('region', {
    name: 'Gateway usage by model',
  });
  const fixtureModel = modelUsage
    .getByRole('row')
    .filter({ hasText: 'fixture' });
  await expect(fixtureModel.locator('td')).toHaveText([
    'fixture',
    '2',
    '3',
    '$0.12',
  ]);
  await groupUsage.selectOption('team');
  const blockReport = page.getByRole('region', {
    name: 'Gateway policy blocks',
  });
  const missingAppRow = blockReport
    .getByRole('row')
    .filter({ hasText: 'missing-app' });
  await expect(missingAppRow).toContainText('Record unavailable');
  await expect(missingAppRow).toContainText('Risk reassessment required');
  await expect(missingAppRow.getByRole('link')).toHaveCount(0);
  const searchBlocks = blockReport.getByRole('searchbox', {
    name: 'Search policy blocks',
  });
  await searchBlocks.fill(renewal.name.toUpperCase());
  await expect(missingAppRow).toHaveCount(0);
  await expect(
    blockReport.getByRole('link', { name: renewal.name }),
  ).toBeVisible();
  const searchDownloadPending = page.waitForEvent('download');
  await blockReport
    .getByRole('button', { name: 'Download policy blocks CSV' })
    .click();
  const searchDownload = await searchDownloadPending;
  const searchCsv = await readFile(await searchDownload.path(), 'utf8');
  expect(searchCsv).toContain(renewal.id);
  expect(searchCsv).not.toContain('missing-app');
  await searchBlocks.fill('missing-app');
  await expect(missingAppRow).toBeVisible();
  await expect(
    blockReport.getByRole('link', { name: renewal.name }),
  ).toHaveCount(0);
  const blockReason = blockReport.getByRole('combobox', {
    name: 'Block reason',
  });
  await blockReason.selectOption('review');
  await expect(page).toHaveURL(/blockReason=review/);
  await page.reload();
  await expect(blockReason).toHaveValue('review');
  await expect(searchBlocks).toHaveValue('missing-app');
  await expect(
    blockReport.getByText('No matching policy blocks'),
  ).toBeVisible();
  await searchBlocks.clear();
  await expect(page).not.toHaveURL(/blockApp=/);
  await expect(
    blockReport.getByText(
      'Open the app record and resolve any outstanding review requirements.',
    ),
  ).toBeVisible();
  await expect(missingAppRow).toHaveCount(0);
  await expect(
    blockReport.getByRole('link', { name: renewal.name }),
  ).toBeVisible();
  const blockDownloadPending = page.waitForEvent('download');
  const exportBlocks = blockReport.getByRole('button', {
    name: 'Download policy blocks CSV',
  });
  await exportBlocks.click();
  const blockDownload = await blockDownloadPending;
  expect(blockDownload.suggestedFilename()).toBe(
    'frontstage-gateway-policy-blocks.csv',
  );
  const blockCsv = await readFile(await blockDownload.path(), 'utf8');
  expect(blockCsv.trimEnd().split('\r\n')).toHaveLength(2);
  expect(blockCsv).toContain(`"${renewal.id}","${renewal.name}"`);
  expect(blockCsv).toContain('"simulation","","review",0,4,0');
  expect(blockCsv).not.toContain('missing-app');
  await blockReason.selectOption('tier-drift');
  await expect(
    blockReport.getByText(
      'Ask the app owner to reassess the app against the current risk policy.',
    ),
  ).toBeVisible();
  await expect(missingAppRow).toBeVisible();
  await expect(
    blockReport.getByRole('link', { name: renewal.name }),
  ).toHaveCount(0);
  await procurement.getByRole('button').click();
  await expect(
    blockReport.getByText('No policy blocks match this reason'),
  ).toBeVisible();
  await expect(blockReason).toHaveValue('tier-drift');
  await expect(exportBlocks).toHaveCount(0);
  await blockReason.selectOption('');
  await expect(page).toHaveURL(/usageTeam=group%3Adefault%2Fprocurement$/);
  await expect(page.getByRole('combobox', { name: 'Usage team' })).toHaveValue(
    'group:default/procurement',
  );
  await expect(blockReport.getByText('missing-app')).toBeHidden();
  const teamCsvPending = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download selected team CSV' })
    .click();
  const teamCsvDownload = await teamCsvPending;
  expect(teamCsvDownload.suggestedFilename()).toBe(
    'frontstage-gateway-team.csv',
  );
  const teamCsv = await readFile(await teamCsvDownload.path(), 'utf8');
  expect(teamCsv).toContain('"group:default/procurement"');
  expect(teamCsv).toContain('"review"');
  expect(teamCsv).not.toContain('missing-app');
  await page
    .getByRole('region', { name: 'Gateway usage', exact: true })
    .getByRole('link', { name: handoff.name })
    .click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close app details' }).click();
  await expect(page).toHaveURL(/usageTeam=group%3Adefault%2Fprocurement$/);
  await expect(page.getByRole('combobox', { name: 'Usage team' })).toHaveValue(
    'group:default/procurement',
  );

  await page.getByRole('combobox', { name: 'Usage team' }).selectOption('');
  await expect(blockReport.getByText('missing-app')).toBeVisible();
  await page.route(
    '**/api/governance/reports/review-turnaround',
    route => route.fulfill({ status: 503, json: {} }),
    { times: 1 },
  );
  await page.getByRole('link', { name: '1 awaiting a first decision' }).click();
  await page
    .getByRole('button', { name: 'Retry loading first decisions' })
    .click();
  await expect(page).toHaveURL(/view=reviews&review=first$/);
  await expect(reviewRows).toHaveCount(1);
  await expect(reviewRows.first()).toContainText(handoff.name);
  await expect(reviewRows.first()).toContainText('3.5 weekdays waiting');
  await expect(reviewRows.first()).toContainText('At or over review target');
  const decisionsExportPending = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download first decisions CSV' })
    .click();
  const decisionsExport = await decisionsExportPending;
  expect(decisionsExport.suggestedFilename()).toBe(
    'frontstage-first-decisions.csv',
  );
  const decisionsCsv = await readFile(await decisionsExport.path(), 'utf8');
  expect(decisionsCsv).toContain(
    `"${handoff.id}","${handoff.name}","${handoff.owner}","${handoff.team}",3.5,3`,
  );
  expect(decisionsCsv).not.toContain(renewal.name);

  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page
    .getByRole('link', { name: '1 at or over the 3-weekday target' })
    .click();
  await expect(page).toHaveURL(/view=reviews&review=first-target$/);
  await expect(reviewRows).toHaveCount(1);
  await expect(reviewRows.first()).toContainText(handoff.name);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  const reassessment = page.locator('.gov-report-summary > div').filter({
    hasText: 'Apps needing risk reassessment',
  });
  await expect(reassessment.locator('dd')).toHaveText('1');
  await reassessment
    .getByRole('link', { name: 'View apps needing reassessment' })
    .click();
  await expect(page).toHaveURL(/review=reassess$/);
  await expect(
    page.getByRole('combobox', { name: 'Review status' }),
  ).toHaveValue('reassess');
  await expect(reviewRows).toHaveCount(1);
  await expect(reviewRows.first()).toContainText(handoff.name);
  const reassessmentDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download inventory CSV' }).click();
  const reassessmentCsv = await readFile(
    await (await reassessmentDownload).path(),
    'utf8',
  );
  expect(reassessmentCsv.split('\r\n')[0]).toContain('risk_tier,lifecycle');
  expect(reassessmentCsv.split('\r\n')[0]).toMatch(
    /current_policy_tier,starter_id$/,
  );
  expect(reassessmentCsv.split('\r\n')[1]).toContain(',3,"experimental",');
  expect(reassessmentCsv.split('\r\n')[1]).toMatch(/,2,""$/);

  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page.getByRole('link', { name: 'View required reviews' }).click();
  await expect(page).toHaveURL(/view=reviews&review=required$/);
  await expect(reviewRows).toHaveCount(1);
  await expect(
    page.getByRole('combobox', { name: 'Review status' }),
  ).toHaveValue('required');
  await expect(
    page.getByRole('button', { name: /Purchase order pilot/ }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Review status' })
    .selectOption('mine');
  await expect(page).toHaveURL(/view=reviews&review=mine$/);
  await expect(reviewRows).toHaveCount(1);
  await expect(reviewRows.first()).toContainText('Purchase order pilot');
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  const ownership = page.getByRole('region', { name: 'Ownership issues' });
  await expect(
    ownership.getByText(
      `Accountable owner: ${handoff.owner} (inactive) · Team: ${reportedTeam} (missing)`,
    ),
  ).toBeVisible();
  await expect(
    ownership.getByText(`Active backup owner: ${pilot.owner}`),
  ).toBeVisible();
  const ownershipDownloadPending = page.waitForEvent('download');
  await ownership
    .getByRole('button', { name: 'Download ownership issues CSV' })
    .click();
  const ownershipDownload = await ownershipDownloadPending;
  expect(ownershipDownload.suggestedFilename()).toBe(
    'frontstage-ownership-issues.csv',
  );
  const ownershipCsv = await readFile(await ownershipDownload.path(), 'utf8');
  expect(ownershipCsv).toContain(
    `"Accountable owner","${handoff.owner}","${pilot.owner}","inactive"`,
  );
  expect(ownershipCsv).toContain(
    `"Team","${reportedTeam}","${pilot.owner}","missing"`,
  );
  const ownershipRole = ownership.getByRole('combobox', {
    name: 'Affected ownership role',
  });
  await ownershipRole.selectOption('backup');
  await expect(
    ownership.getByText('No ownership issues match this role.'),
  ).toBeVisible();
  await expect(
    ownership.getByRole('button', { name: 'Download ownership issues CSV' }),
  ).toHaveCount(0);
  await ownershipRole.selectOption('owner');
  await expect(page).toHaveURL(/ownershipRole=owner/);
  failOwnershipLookup = true;
  await page.reload();
  await expect(ownership.getByRole('alert')).toHaveText(
    'Ownership status could not be checked.',
  );
  await expect(
    ownership.getByRole('button', { name: 'Download ownership issues CSV' }),
  ).toHaveCount(0);
  await ownership
    .getByRole('button', { name: 'Retry ownership check' })
    .click();
  await expect(ownershipRole).toHaveValue('owner');
  await expect(ownership.getByRole('alert')).toHaveCount(0);
  await expect(
    ownership.getByText(`Accountable owner: ${handoff.owner} (inactive)`),
  ).toBeVisible();
  await expect(
    ownership.getByText(`Team: ${reportedTeam} (missing)`),
  ).toHaveCount(0);
  const filteredDownload = page.waitForEvent('download');
  await ownership
    .getByRole('button', { name: 'Download ownership issues CSV' })
    .click();
  const filteredCsv = await readFile(
    await (await filteredDownload).path(),
    'utf8',
  );
  expect(filteredCsv).toContain(`"Accountable owner","${handoff.owner}"`);
  expect(filteredCsv).not.toContain(`"Team","${reportedTeam}"`);
  await ownership.getByRole('link', { name: handoff.name }).click();
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('textbox', { name: 'Owner', exact: true })
    .fill(pilot.owner);
  await dialog
    .getByRole('textbox', { name: 'Backup owner' })
    .fill('user:default/backup');
  await dialog
    .getByRole('textbox', { name: 'Owning team' })
    .fill('group:default/platform');
  await dialog.getByRole('button', { name: 'Save app details' }).click();
  await expect(dialog.getByText('App updated.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close app details' }).click();
  await expect(page).toHaveURL(/view=reports&ownershipRole=owner$/);
  await expect(ownership.getByText('No ownership issues found.')).toBeVisible();
  await retirementReview.getByRole('link', { name: renewal.name }).click();
  const retirementDialog = page.getByRole('dialog', { name: renewal.name });
  await retirementDialog
    .getByRole('combobox', { name: 'Lifecycle' })
    .selectOption('retired');
  await retirementDialog
    .getByRole('textbox', { name: 'Reason for lifecycle change (optional)' })
    .fill('Replaced by the shared workflow');
  await retirementDialog
    .getByRole('button', { name: 'Update lifecycle' })
    .click();
  await expect(retirementDialog.getByText('Lifecycle updated.')).toBeVisible();
  await retirementDialog
    .getByRole('button', { name: 'Close app details' })
    .click();
  await expect(page).toHaveURL(/view=reports&ownershipRole=owner$/);
  await expect(
    retirementReview.getByText(
      'No apps match this gateway activity threshold.',
    ),
  ).toBeVisible();
});

test('a hosted app owner can correct and attest to the declared workspace', async ({
  page,
}) => {
  const initialApp = {
    id: 'hosted-app',
    name: 'Hosted demo app',
    owner: 'user:default/demo-owner',
    team: 'group:default/platform',
    purpose: 'Synthetic demo',
    type: 'provider-hosted app',
    hostedWorkspaceAllowed: false,
    platform: 'Hosted workspace & tools',
    classification: 'internal',
    lifecycle: 'experimental',
    models: ['fixture'],
    usesAiAtRuntime: true,
    tier: 1,
    reviewStatus: 'not required',
    updatedAt: '2025-01-01T00:00:00.000Z',
    hosted: {
      provider: 'Example AI',
      workspace: 'Personal',
      sharing: 'private',
      dataAccess: 'none',
    },
  };
  let app: typeof initialApp & {
    hostedAttestation?: { at: string; nextDue: string };
  } = initialApp;
  const overdueApp = {
    ...app,
    id: 'overdue-hosted-app',
    name: 'Overdue hosted app',
    tier: 2,
    nextReview: '2025-05-01T00:00:00.000Z',
    hostedAttestation: {
      at: '2025-01-01T00:00:00.000Z',
      nextDue: '2025-04-01T00:00:00.000Z',
    },
  };
  const backedUpApp = {
    ...initialApp,
    id: 'backup-hosted-app',
    name: 'Backup hosted app',
    owner: 'user:default/other-owner',
    backupOwner: initialApp.owner,
    hostedAttestation: {
      at: new Date().toISOString(),
      nextDue: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    },
  };
  const retiredApp = {
    ...initialApp,
    id: 'retired-hosted-app',
    name: 'Retired hosted app',
    lifecycle: 'retired',
  };
  const regularApp = {
    ...initialApp,
    id: 'regular-app',
    name: 'Regular app',
    type: 'app',
    hosted: undefined,
  };
  let canReviewHostedApps = true;
  const history = [{ action: 'registered', record: app }];
  await page.route('**/api/governance/apps/hosted-app/history', route =>
    route.fulfill({
      json: {
        keyEvents: [],
        events: history.map(({ action, record }, index) => ({
          digest: String(index).padStart(64, '0'),
          event: JSON.stringify({
            action,
            actor: app.owner,
            record,
          }),
        })),
      },
    }),
  );
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor: app.owner,
        gatewayEnabled: true,
        canReview: canReviewHostedApps,
        apps: [app, overdueApp, retiredApp, regularApp, backedUpApp],
      },
    }),
  );
  let saveAttempts = 0;
  await page.route('**/api/governance/apps/hosted-app', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: app });
    const update = route.request().postDataJSON();
    expect(update.expectedUpdatedAt).toBe(app.updatedAt);
    expect(update.hosted).toEqual({
      ...app.hosted,
      workspace: 'Company',
      sharing: 'named people',
      dataAccess: 'stores input',
      dataClassification: 'internal',
    });
    saveAttempts += 1;
    if (saveAttempts === 1) {
      app = {
        ...app,
        purpose: 'Updated by another reviewer',
        updatedAt: '2025-01-01T12:00:00.000Z',
      };
      return route.fulfill({
        status: 409,
        json: { error: { message: 'The app changed.' } },
      });
    }
    app = {
      ...app,
      hosted: update.hosted,
      hostedWorkspaceAllowed: true,
      updatedAt: '2025-01-02T00:00:00.000Z',
    };
    history.push({ action: 'updated', record: app });
    return route.fulfill({ json: app });
  });
  await page.route(
    '**/api/governance/apps/hosted-app/hosted-attestation',
    route => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({
        confirmed: true,
        expectedUpdatedAt: app.updatedAt,
      });
      const at = Date.now();
      app = {
        ...app,
        updatedAt: new Date(at).toISOString(),
        hostedAttestation: {
          at: new Date(at).toISOString(),
          nextDue: new Date(at + 90 * 86_400_000).toISOString(),
        },
      };
      history.push({ action: 'hosted-attested', record: app });
      return route.fulfill({ json: app });
    },
  );
  await page.route('**/api/governance/reports/hosted-workspaces', route =>
    route.fulfill({
      json: {
        configured: true,
        issues:
          app.hosted.workspace === 'Personal'
            ? [
                {
                  appId: app.id,
                  name: app.name,
                  lifecycle: app.lifecycle,
                  ...app.hosted,
                },
              ]
            : [],
      },
    }),
  );
  await page.goto('/?view=reports');
  const details = page.getByRole('dialog', { name: app.name });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  const hostedIssues = page.getByRole('region', {
    name: 'Provider workspace issues',
  });
  await expect(hostedIssues.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  const attestationQueue = page.getByRole('region', {
    name: 'Hosted workspace attestations',
  });
  const missing = attestationQueue.getByRole('link', { name: app.name });
  await expect(missing).toHaveAttribute('href', /app=hosted-app/);
  await expect(attestationQueue.getByRole('link')).toHaveText([
    overdueApp.name,
    app.name,
  ]);
  await expect(attestationQueue).toContainText('Confirmation missing');
  await expect(attestationQueue).toContainText('Overdue since 2025-04-01 UTC');
  await page.getByRole('link', { name: 'Inventory', exact: true }).click();
  const workspaceQueue = page.getByRole('link', {
    name: /of your apps need.*workspace confirmation/,
  });
  await expect(workspaceQueue).toHaveText(
    '2 of your apps need workspace confirmations',
  );
  await workspaceQueue.click();
  await expect(page).toHaveURL(/owner=me&review=workspace/);
  const inventory = page.getByRole('region', { name: 'AI app inventory' });
  await expect(inventory.getByRole('row').nth(1)).toContainText(
    overdueApp.name,
  );
  await expect(inventory.getByRole('row').nth(1)).toContainText(
    'Workspace confirmation overdue',
  );
  await expect(inventory.getByRole('row').nth(2)).toContainText(
    'Workspace confirmation missing',
  );
  await expect(inventory.getByRole('row')).toHaveCount(3);
  const combinedDownload = page.waitForEvent('download');
  await inventory
    .getByRole('button', { name: 'Download my review calendar' })
    .click();
  const combined = await readFile(
    await (await combinedDownload).path(),
    'utf8',
  );
  expect(combined.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  expect(combined).toContain('UID:overdue-hosted-app-review@');
  expect(combined).toContain('SUMMARY:App attestation: Overdue hosted app');
  expect(combined).toContain('DTSTART;VALUE=DATE:20250501');
  expect(combined).toContain('UID:overdue-hosted-app-hosted-attestation@');
  expect(combined).toContain(
    'SUMMARY:Hosted workspace attestation: Overdue hosted app',
  );
  expect(combined).toContain('DTSTART;VALUE=DATE:20250401');
  const ownership = inventory.getByRole('combobox', {
    name: 'Ownership',
    exact: true,
  });
  const statusFilter = inventory.getByRole('combobox', {
    name: 'Review status',
    exact: true,
  });
  await ownership.selectOption('backup');
  await expect(statusFilter).toHaveValue('');
  const backupDownload = page.waitForEvent('download');
  await inventory
    .getByRole('button', { name: 'Download my review calendar' })
    .click();
  const backupCalendar = await readFile(
    await (await backupDownload).path(),
    'utf8',
  );
  expect(backupCalendar.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  expect(backupCalendar).toContain('UID:backup-hosted-app-hosted-attestation@');
  await statusFilter.selectOption('workspace');
  await expect(ownership).toHaveValue('me');
  await expect(inventory.getByRole('row')).toHaveCount(3);

  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await missing.click();
  await expect(details).toBeVisible();
  await details.getByRole('button', { name: 'Close app details' }).click();
  await hostedIssues.getByRole('link', { name: app.name }).click();
  await expect(
    details.getByRole('link', { name: 'View approved workspaces (new tab)' }),
  ).toHaveAttribute('href', '/?view=guide#hosted-workspaces-title');

  const attestation = details.getByRole('region', {
    name: 'Hosted workspace attestation',
  });
  await expect(attestation).toContainText('Choose an approved workspace');
  await expect(attestation.getByRole('checkbox')).toHaveCount(0);

  async function saveWorkspaceCorrection() {
    await details
      .getByRole('textbox', { name: 'Workspace', exact: true })
      .fill('Company');
    await details.getByLabel('Sharing scope').selectOption('named people');
    await details
      .getByRole('combobox', { name: 'Data access', exact: true })
      .selectOption('stores input');
    await details
      .getByLabel('Highest hosted data classification')
      .selectOption('internal');
    await details.getByRole('button', { name: 'Save app details' }).click();
  }
  await saveWorkspaceCorrection();
  await expect(details.getByRole('alert')).toContainText(
    'Review the refreshed record before trying again.',
  );
  await expect(details.getByRole('textbox', { name: 'Purpose' })).toHaveValue(
    'Updated by another reviewer',
  );
  await saveWorkspaceCorrection();
  await expect(
    details.getByText('App updated.', { exact: true }),
  ).toBeVisible();
  await expect(
    details.getByRole('region', { name: 'Gateway playground' }),
  ).toHaveCount(0);

  await expect(attestation).toContainText('Example AI · Company');
  await expect(attestation).toContainText(
    'Workspace settings have not been confirmed.',
  );
  await attestation.getByRole('checkbox').check();
  await attestation
    .getByRole('button', {
      name: 'Record workspace attestation',
    })
    .click();
  await expect(attestation).toContainText('Last confirmed');
  await expect(attestation).toContainText('Next due');

  const reminderPending = page.waitForEvent('download');
  await attestation
    .getByRole('button', { name: 'Download workspace reminder' })
    .click();
  const reminder = await reminderPending;
  expect(reminder.suggestedFilename()).toBe(
    'frontstage-workspace-attestation.ics',
  );
  const calendar = await readFile(await reminder.path(), 'utf8');
  const dueDate = app.hostedAttestation?.nextDue.slice(0, 10).replace(/-/g, '');
  expect(calendar).toContain(`DTSTART;VALUE=DATE:${dueDate}`);
  expect(calendar).toContain('UID:hosted-app-hosted-attestation@');
  expect(calendar).toContain(
    'SUMMARY:Hosted workspace attestation: Hosted demo app',
  );
  expect(calendar).toContain(`URL:${workspaceUrl}/?app=hosted-app`);
  expect(calendar).toContain('TRIGGER:-P7D');

  await details.getByText('Audit history', { exact: true }).click();
  await expect(
    details.getByText(/Next workspace attestation due/),
  ).toBeVisible();
  await expect(
    details.getByText(/Workspace changed from Personal to Company/),
  ).toBeVisible();
  await expect(
    details.getByText(/Sharing scope changed from private to named people/),
  ).toBeVisible();

  await details.getByRole('button', { name: 'Close app details' }).click();
  await expect(
    hostedIssues.getByText('No provider workspace issues found.'),
  ).toBeVisible();
  await expect(missing).toHaveCount(0);
  await expect(
    attestationQueue.getByRole('link', { name: overdueApp.name }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Inventory', exact: true }).click();
  await expect(workspaceQueue).toHaveText(
    '1 of your apps needs a workspace confirmation',
  );
  await workspaceQueue.click();
  await expect(inventory.getByRole('row')).toHaveCount(2);
  await expect(inventory.getByRole('row').nth(1)).toContainText(
    overdueApp.name,
  );

  canReviewHostedApps = false;
  await page.goto('/?view=reports');
  await expect(
    page.getByText('Non-retired apps', { exact: true }),
  ).toBeVisible();
  await expect(attestationQueue).toHaveCount(0);
  await page.goto('/?view=register');
  await page.getByLabel('App type').selectOption('provider-hosted app');
  await expect(
    page.getByRole('link', { name: 'View approved workspaces (new tab)' }),
  ).toHaveAttribute('target', '_blank');

  await page
    .getByRole('combobox', { name: 'Data access', exact: true })
    .selectOption('stores input');
  await page
    .getByLabel('Highest hosted data classification')
    .selectOption('restricted');
  await expect(
    page.getByRole('complementary', { name: 'Registration requirements' }),
  ).toContainText(
    'Estimated risk tier 3 · Critical · Effective data classification: restricted',
  );
});

test('registration explains the highest matching tier and clears outdated reasons', async ({
  page,
}) => {
  await page.goto('/?view=register');
  const risk = page.getByRole('complementary', {
    name: 'Registration requirements',
  });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(risk.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();

  const classification = page.getByRole('combobox', {
    name: 'Highest data classification',
    exact: true,
  });
  const reasons = risk.getByRole('list', { name: 'Reasons for this tier' });
  let riskRequestFailed = false;
  await page.route('**/api/governance/tier-preview', route => {
    if (
      !riskRequestFailed &&
      route.request().postDataJSON().classification === 'restricted'
    ) {
      riskRequestFailed = true;
      return route.fulfill({ status: 503, json: {} });
    }
    return route.fallback();
  });
  await classification.selectOption('restricted');
  await expect(risk).toContainText('Risk preview unavailable');
  await risk.getByRole('button', { name: 'Retry risk assessment' }).click();
  await expect(classification).toHaveValue('restricted');
  await expect(risk).toContainText('Estimated risk tier 3 · Critical');
  await expect(reasons).toContainText('handles restricted data');

  await classification.selectOption('internal');
  await expect(risk).toContainText('Estimated risk tier 1 · Personal');
  await expect(reasons).toHaveCount(0);
});

test('reviewers reconcile a hosted snapshot and register an unmatched app', async ({
  page,
}) => {
  const reviewer = 'user:default/reviewer';
  const candidate = {
    name: 'Hosted notes',
    provider: 'Example AI',
    workspace: 'Enterprise',
    sourceUrl: 'https://example.com/apps/notes',
  };
  const known = {
    ...candidate,
    name: 'Hosted review',
    sourceUrl: 'https://example.com/apps/review',
  };
  const snapshot = { apps: [known, candidate] };
  let registered = false;
  let previewCount = 0;
  await page.route(/\/api\/governance\/apps(?:\?|$)/, async route => {
    if (route.request().method() === 'POST') {
      expect(new URL(route.request().url()).searchParams.get('source')).toBe(
        'hosted-snapshot',
      );
      const body = route.request().postDataJSON();
      expect(body).toMatchObject({
        name: candidate.name,
        sourceUrl: candidate.sourceUrl,
        type: 'provider-hosted app',
        platform: candidate.provider,
        hosted: {
          provider: candidate.provider,
          workspace: candidate.workspace,
        },
      });
      registered = true;
      return route.fulfill({
        status: 201,
        json: {
          ...body,
          id: 'new-hosted-app',
          discoverySource: 'hosted snapshot',
          tier: 1,
          reviewStatus: 'not required',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      });
    }
    return route.fulfill({
      json: { actor: reviewer, canReview: true, apps: [] },
    });
  });
  await page.route('**/api/governance/discovery/github', route =>
    route.fulfill({
      json: {
        source: null,
        lastScan: null,
        intervalMinutes: null,
        repositories: [],
      },
    }),
  );
  await page.route('**/api/governance/discovery/hosted/preview', route => {
    expect(route.request().postDataJSON()).toEqual(snapshot);
    previewCount += 1;
    const knownMatch = { ...known, appId: 'known-hosted-app' };
    return route.fulfill({
      json: {
        apps: [
          previewCount === 1
            ? {
                ...knownMatch,
                mismatch: 'workspace',
                registeredWorkspace: {
                  provider: 'Example AI',
                  workspace: 'Previous workspace',
                },
              }
            : knownMatch,
          candidate,
        ],
      },
    });
  });
  await page.route('**/api/governance/tier-preview', route =>
    route.fulfill({ json: { tier: 1, reasons: [] } }),
  );

  await page.goto('/?view=discovery');
  const heading = page.getByRole('heading', { name: 'App discovery' });
  const guest = page.getByRole('button', { name: 'Enter', exact: true });
  await expect(heading.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  const sampleDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download sample JSON' }).click();
  const sample = await sampleDownload;
  expect(sample.suggestedFilename()).toBe('hosted-inventory.json');
  const sampleJson = JSON.parse(await readFile(await sample.path(), 'utf8'));
  expect(sampleJson.apps).toHaveLength(3);
  const file = page.getByLabel('Snapshot file');
  const preview = page.getByRole('button', { name: 'Preview hosted snapshot' });
  await file.setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{'),
  });
  await preview.click();
  await expect(page.getByText('Enter a valid JSON snapshot.')).toBeVisible();
  await file.setInputFiles({
    name: 'hosted-inventory.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(snapshot)),
  });
  await preview.click();
  await expect(
    page.getByRole('link', { name: 'View app record' }),
  ).toHaveAttribute('href', /app=known-hosted-app/);
  const knownRow = page.getByRole('row', { name: /Hosted review/ });
  await expect(
    knownRow.getByText('Snapshot: Example AI · Enterprise'),
  ).toBeVisible();
  await expect(
    knownRow.getByText('Registered: Example AI · Previous workspace'),
  ).toBeVisible();
  await expect(
    knownRow.getByText('Provider or workspace mismatch'),
  ).toBeVisible();
  await expect(
    knownRow.getByRole('button', { name: 'Register app' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Recheck snapshot' }).click();
  await expect(knownRow.getByText('Registered', { exact: true })).toBeVisible();
  await expect(knownRow.getByText('Previous workspace')).toHaveCount(0);
  expect(previewCount).toBe(2);
  await page.getByRole('button', { name: 'Register app', exact: true }).click();

  const form = page.getByRole('region', { name: 'App registration' });
  await expect(form.getByLabel('App name')).toHaveValue(candidate.name);
  await expect(form.getByLabel('App type')).toHaveValue('provider-hosted app');
  await expect(form.getByLabel('App type')).toBeDisabled();
  await expect(form.getByLabel('Built on')).toHaveValue(candidate.provider);
  await expect(form.getByLabel('Source URL')).toHaveValue(candidate.sourceUrl);
  await expect(form.getByLabel('Provider', { exact: true })).toHaveValue(
    candidate.provider,
  );
  await expect(form.getByLabel('Enterprise workspace')).toHaveValue(
    candidate.workspace,
  );
  await expect(page).not.toHaveURL(/example\.com|Enterprise/);
  expect(registered).toBe(false);
  await form.getByLabel('Purpose').fill('Summarizes synthetic meeting notes.');
  await form.getByLabel('Models', { exact: true }).fill('example-model');
  await form.getByLabel('Owning team').fill('group:default/platform');
  await form.getByRole('button', { name: 'Register app', exact: true }).click();
  const record = page.getByRole('dialog', { name: candidate.name });
  await expect(record).toBeVisible();
  await record.getByRole('button', { name: 'Close app details' }).click();
  await expect(
    page.getByRole('row', { name: /Hosted notes/ }).getByRole('link', {
      name: 'View app record',
    }),
  ).toHaveAttribute('href', /app=new-hosted-app/);
  expect(registered).toBe(true);
});

test('Discovery refreshes after a stale dismissal', async ({ page }) => {
  let registered = false;
  let discoveryUnavailable = true;
  await page.route('**/api/governance/apps/registered-app', route =>
    route.fulfill({
      json: {
        id: 'registered-app',
        name: 'Registered sample app',
        owner: 'user:default/owner',
        team: 'group:default/platform',
        purpose: 'Sample repository',
        lifecycle: 'experimental',
        classification: 'internal',
        platform: 'GitHub',
        tier: 1,
        models: [],
        usesAiAtRuntime: false,
        reviewStatus: 'not required',
      },
    }),
  );
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: { actor: 'user:default/reviewer', canReview: true, apps: [] },
    }),
  );
  await page.route('**/api/governance/discovery/github', route => {
    if (discoveryUnavailable) {
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Discovery is temporarily unavailable.' } },
      });
    }
    return route.fulfill({
      json: {
        source: { organization: 'example', topic: 'governance' },
        lastScan: null,
        intervalMinutes: null,
        repositories: [
          {
            id: 'sample',
            name: 'Sample repository',
            description: '',
            sourceUrl: 'https://github.com/example/sample',
            appId: registered ? 'registered-app' : null,
            dismissed: 0,
          },
        ],
      },
    });
  });
  await page.route(
    '**/api/governance/discovery/github/sample/sdk-evidence',
    route =>
      route.fulfill({
        json: {
          manifests: [
            { path: 'package.json', status: 'checked', packages: ['openai'] },
            { path: 'requirements.txt', status: 'missing', packages: [] },
            {
              path: 'pyproject.toml',
              status: 'checked',
              packages: ['anthropic'],
            },
          ],
        },
      }),
  );
  await page.route(
    '**/api/governance/discovery/github/sample/decision',
    route => {
      registered = true;
      return route.fulfill({
        status: 409,
        json: {
          error: {
            message: 'The repository is no longer available for this decision.',
          },
        },
      });
    },
  );

  await page.goto('/?view=discovery');
  const heading = page.getByRole('heading', { name: 'App discovery' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(heading.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(page.getByRole('alert')).toContainText(
    'temporarily unavailable',
  );
  discoveryUnavailable = false;
  await page.getByRole('button', { name: 'Retry loading Discovery' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const discoveryRow = page.getByRole('row', { name: /Sample repository/ });
  await discoveryRow
    .getByRole('button', { name: 'Check AI SDK dependencies' })
    .click();
  await expect(discoveryRow.getByText(/openai/i)).toBeVisible();
  await expect(discoveryRow.getByText(/requirements\.txt/i)).toBeVisible();
  await expect(
    discoveryRow.getByText('pyproject.toml', { exact: true }),
  ).toBeVisible();
  await expect(
    discoveryRow.getByText('anthropic', { exact: true }),
  ).toBeVisible();
  await expect(
    discoveryRow.getByRole('link', { name: 'Claim repository' }),
  ).toBeVisible();
  await page.getByText('Dismiss repository', { exact: true }).click();
  await page.getByLabel('Dismissal reason').fill('Not an app');
  await page.getByRole('button', { name: 'Confirm dismissal' }).click();
  await expect(page.getByRole('alert')).toContainText('no longer available');
  await expect(page.getByRole('button', { name: 'Unowned 0' })).toBeVisible();
  await page.getByRole('button', { name: 'Registered 1' }).click();
  await discoveryRow
    .getByRole('button', { name: 'Check AI SDK dependencies' })
    .click();
  await expect(
    discoveryRow.getByText('anthropic', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Open app record' }),
  ).toHaveAttribute(
    'href',
    '/?view=discovery&discoveryStatus=registered&app=registered-app',
  );
  await page
    .getByRole('searchbox', { name: 'Search discoveries' })
    .fill('Sample');
  await page.getByRole('link', { name: 'Open app record' }).click();
  const record = page.getByRole('dialog', { name: 'Registered sample app' });
  await expect(record).toBeVisible();
  await record.getByRole('button', { name: 'Close app details' }).click();
  await expect(page).toHaveURL(/view=discovery&discoveryStatus=registered$/);
  await expect(
    page.getByRole('searchbox', { name: 'Search discoveries' }),
  ).toHaveValue('Sample');
  await expect(
    page.getByRole('button', { name: 'Registered 1' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  if (await guest.isVisible()) await guest.click();
  await expect(
    page.getByRole('button', { name: 'Registered 1' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('link', { name: 'Open app record' }),
  ).toBeVisible();
});

test('Discovery paginates search results and preserves the page when reopening a record', async ({
  page,
}) => {
  const records = Array.from({ length: 26 }, (_, index) => ({
    id: `repository-${index + 1}`,
    name: `Repository ${index + 1}`,
    description: 'Discovery fixture',
    sourceUrl: `https://github.com/example/repository-${index + 1}`,
    appId: index === 25 ? 'registered-page-two' : null,
    dismissed: 0,
  }));
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: { actor: 'user:default/reviewer', canReview: true, apps: [] },
    }),
  );
  await page.route('**/api/governance/discovery/github', route =>
    route.fulfill({
      json: {
        source: { organization: 'example', topic: 'governance' },
        lastScan: null,
        intervalMinutes: null,
        repositories: records,
      },
    }),
  );
  await page.route('**/api/governance/apps/registered-page-two', route =>
    route.fulfill({
      json: {
        id: 'registered-page-two',
        name: 'Registered page two',
        owner: 'user:default/owner',
        team: 'group:default/platform',
        purpose: 'Page two fixture',
        lifecycle: 'experimental',
        classification: 'internal',
        platform: 'GitHub',
        tier: 1,
        models: [],
        usesAiAtRuntime: false,
        reviewStatus: 'not required',
      },
    }),
  );
  await page.goto('/?view=discovery&discoveryStatus=all');
  const queue = page.getByRole('region', { name: 'Discovered repositories' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(queue.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  const pages = queue.getByRole('group', { name: 'Repository pages' });
  await expect(pages.getByRole('status')).toHaveText('1–25 of 26');
  await expect(queue.getByRole('row')).toHaveCount(26);
  await expect(
    pages.getByRole('button', { name: 'Previous page' }),
  ).toBeDisabled();
  await pages.getByRole('button', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/discoveryPage=2$/);
  await expect(pages.getByRole('status')).toHaveText('26 of 26');
  await expect(pages.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await queue.getByRole('link', { name: 'Open app record' }).click();
  const details = page.getByRole('dialog', { name: 'Registered page two' });
  await details.getByRole('button', { name: 'Close app details' }).click();
  await expect(page).toHaveURL(/discoveryPage=2$/);
  await queue
    .getByRole('searchbox', { name: 'Search discoveries' })
    .fill('Repository 26');
  await expect(page).toHaveURL(/view=discovery&discoveryStatus=all$/);
  await expect(queue.getByRole('row')).toHaveCount(2);
  await expect(pages).toHaveCount(0);
  await page.reload();
  await expect(
    queue.getByRole('searchbox', { name: 'Search discoveries' }),
  ).toHaveValue('');
  await expect(queue.getByRole('row')).toHaveCount(26);
});

test('claiming a repository opens its app in the registered Discovery queue', async ({
  page,
}) => {
  const repository = {
    id: 'claimable',
    name: 'Example workbook',
    description: 'A prototype for stock counts',
    sourceUrl: 'https://github.com/example/workbook',
    dismissed: 0,
  };
  const actor = 'user:default/demo-owner';
  const claimed = {
    id: 'claimed-app',
    name: repository.name,
    sourceUrl: repository.sourceUrl,
    purpose: repository.description,
    platform: 'GitHub',
    owner: actor,
    team: 'group:default/platform',
    classification: 'internal',
    lifecycle: 'experimental',
    tier: 1,
    models: [],
    usesAiAtRuntime: false,
    reviewStatus: 'not required',
  };
  let registered = false;
  await page.route('**/api/governance/apps', route =>
    registered
      ? route.fulfill({
          status: 503,
          json: { error: { message: 'Inventory unavailable' } },
        })
      : route.fulfill({ json: { actor, canReview: false, apps: [] } }),
  );
  await page.route('**/api/governance/discovery/github', route =>
    route.fulfill({
      json: {
        source: { organization: 'example', topic: 'governance' },
        lastScan: null,
        intervalMinutes: null,
        repositories: [
          { ...repository, appId: registered ? claimed.id : null },
        ],
      },
    }),
  );
  await page.route(
    '**/api/governance/discovery/github/claimable/descriptor',
    route => route.fulfill({ json: { status: 'unavailable' } }),
  );
  await page.route(
    '**/api/governance/discovery/github/claimable/claim',
    route => {
      const body = route.request().postDataJSON();
      expect(body).toMatchObject({
        sourceUrl: repository.sourceUrl,
        usesAiAtRuntime: false,
      });
      registered = true;
      return route.fulfill({ status: 201, json: claimed });
    },
  );
  await page.goto('/?view=discovery');
  const claim = page.getByRole('link', { name: 'Claim repository' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(claim.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await claim.click();
  await page.getByRole('button', { name: 'Preview descriptor' }).click();
  await expect(
    page.getByText('No usable descriptor is available.'),
  ).toBeVisible();

  await page
    .getByLabel('Purpose', { exact: true })
    .fill(repository.description);
  await page.getByLabel('App type').selectOption('app');
  await page.getByLabel('Does the app use AI at runtime?').selectOption('no');
  await page.getByLabel('Owning team').fill(claimed.team);
  await page.getByRole('button', { name: 'Register app' }).click();
  const record = page.getByRole('dialog', { name: claimed.name });
  await expect(
    record.getByText('Repository claimed and app registered.'),
  ).toBeVisible();
  const feedback = record.getByRole('group', { name: /how satisfied/i });
  await expect(feedback).toBeVisible();
  await feedback.getByRole('button', { name: 'Skip feedback' }).click();
  await expect(feedback).toHaveCount(0);
  await record.getByRole('button', { name: 'Close app details' }).click();
  await expect(page).toHaveURL(/view=discovery&discoveryStatus=registered$/);
  await expect(
    page.getByRole('link', { name: 'Open app record' }),
  ).toBeVisible();
});

test('repository descriptor preview requires an explicit apply and keeps claim identity', async ({
  page,
}) => {
  const repository = {
    id: 'descriptor-ready',
    name: 'Example workbook',
    sourceUrl: 'https://github.com/example/workbook',
    dismissed: 0,
    appId: null,
  };
  const actor = 'user:default/demo-owner';
  const app = {
    name: 'Stock count assistant',
    starterId: 'gateway-assistant',
    purpose: 'Reconcile sandbox stock counts.',
    type: 'assistant',
    platform: 'Declared platform',
    sourceUrl: 'https://example.com/other-repository',
    owner: 'user:default/declared-owner',
    backupOwner: 'user:default/backup',
    team: 'group:default/platform',
    lifecycle: 'active',
    audience: 'team',
    classification: 'confidential',
    usesAiAtRuntime: true,
    deliveryStage: 'pilot',
    models: ['gpt-4.1-mini'],
    connections: [
      { name: 'Warehouse inventory', access: 'read' },
      { name: 'Purchase orders sandbox', access: 'write' },
    ],
    takesActions: false,
    affectsPeople: false,
    critical: false,
    personalData: false,
  };
  let previews = 0;
  let opened = false;
  await page.route('**/api/governance/apps', route =>
    route.fulfill({ json: { actor, canReview: false, apps: [] } }),
  );
  await page.route('**/api/governance/discovery/github', route =>
    route.fulfill({
      json: {
        source: { organization: 'example', topic: 'governance' },
        repositories: [{ ...repository, appId: opened ? 'registered' : null }],
      },
    }),
  );
  await page.route(
    '**/api/governance/discovery/github/descriptor-ready/descriptor',
    route => {
      expect(route.request().method()).toBe('GET');
      previews++;
      return route.fulfill({ json: { status: 'ready', app } });
    },
  );
  await page.route('**/api/governance/tier-preview', route =>
    route.fulfill({
      json: {
        tier: route
          .request()
          .postDataJSON()
          .connections.some(
            (connection: { access: string }) => connection.access === 'write',
          )
          ? 3
          : 1,
        effectiveClassification: 'confidential',
      },
    }),
  );
  await page.route(
    '**/api/governance/discovery/github/descriptor-ready/claim',
    route => {
      const payload = route.request().postDataJSON();
      expect(payload).toMatchObject({
        ...app,
        owner: actor,
        lifecycle: 'experimental',
        sourceUrl: repository.sourceUrl,
        platform: 'GitHub',
        purpose: 'Reconcile stock counts in the pilot.',
        connections: [
          { name: 'Reconciled warehouse inventory', access: 'read' },
          app.connections[1],
        ],
      });
      opened = true;
      return route.fulfill({
        status: 201,
        json: {
          ...payload,
          id: 'registered',
          tier: 3,
          reviewStatus: 'pending',
        },
      });
    },
  );

  await page.goto('/?view=discovery');
  const claim = page.getByRole('link', { name: 'Claim repository' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(claim.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await claim.click();

  const purpose = page.getByRole('textbox', { name: 'Purpose', exact: true });
  await purpose.fill('Manual draft');
  expect(previews).toBe(0);
  await page.getByRole('button', { name: 'Preview descriptor' }).click();
  const preview = page.getByRole('region', { name: 'Repository descriptor' });
  await expect(preview.getByText(app.name)).toBeVisible();
  await expect(purpose).toHaveValue('Manual draft');
  expect(previews).toBe(1);

  await preview.getByRole('button', { name: 'Apply descriptor' }).click();
  await expect(purpose).toHaveValue(app.purpose);
  await expect(page.getByLabel('Source URL')).toHaveValue(repository.sourceUrl);
  await expect(page.getByLabel('Owner', { exact: true })).toHaveValue(actor);
  await expect(
    page.getByLabel('Connected system 2', { exact: true }),
  ).toHaveValue(app.connections[1].name);
  await expect(page.getByText('Estimated risk tier 3')).toBeVisible();
  await purpose.fill('Reconcile stock counts in the pilot.');
  await page
    .getByLabel('Connected system', { exact: true })
    .fill('Reconciled warehouse inventory');
  await page.getByRole('button', { name: 'Register app' }).click();
  const registeredApp = page.getByRole('dialog', { name: app.name });
  await expect(registeredApp).toBeVisible();
  await expect(
    registeredApp.getByText('Registered from starter Gateway assistant'),
  ).toBeVisible();
});

test('an independent reviewer can grant and revoke a renewal exception', async ({
  page,
}) => {
  const reviewer = 'user:default/reviewer';
  const start = new Date(Math.floor(Date.now() / 1000) * 1000);
  const dateAfterDays = (days: number) =>
    new Date(+start + days * 86_400_000).toISOString();
  const app = {
    id: 'renewal-demo',
    name: 'Renewal exception app',
    owner: 'user:default/demo-owner',
    backupOwner: 'user:default/backup',
    team: 'group:default/platform',
    purpose: 'Demonstrate a bounded review extension.',
    platform: 'GitHub',
    sourceUrl: 'https://example.com/renewal-demo',
    classification: 'internal',
    deliveryStage: 'pilot',
    lifecycle: 'active',
    tier: 3,
    models: [],
    usesAiAtRuntime: false,
    reviewStatus: 'approved',
    nextReview: dateAfterDays(5),
    updatedAt: start.toISOString(),
  };
  const expiry = dateAfterDays(25);
  const reason = 'Complete the final sandbox acceptance test.';
  const exception = {
    owner: app.owner,
    actor: reviewer,
    grantedAt: start.toISOString(),
    expiresAt: expiry,
    reason,
  };
  const grantedApp = {
    ...app,
    updatedAt: new Date(+start + 1).toISOString(),
    renewalException: exception,
  };
  const expiredApp = {
    ...grantedApp,
    id: 'expired-renewal-demo',
    name: 'Expired renewal app',
    renewalException: { ...exception, expiresAt: dateAfterDays(-1) },
  };
  let current: typeof app | typeof grantedApp = app;
  let actor = reviewer;
  let split = false;
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor,
        canReview: actor === reviewer,
        reviewTracks: split ? ['security', 'dataProtection'] : [],
        reviewerTracks: split ? ['security'] : [],
        apps: [current, expiredApp],
      },
    }),
  );
  await page.route(
    '**/api/governance/apps/renewal-demo/renewal-exception',
    route => {
      const request = route.request();
      if (request.method() === 'POST') {
        expect(request.postDataJSON()).toEqual({
          reason,
          expiresAt: expiry,
          expectedUpdatedAt: app.updatedAt,
        });
        current = grantedApp;
      } else {
        expect(request.method()).toBe('DELETE');
        expect(request.postDataJSON()).toEqual({
          expectedUpdatedAt: grantedApp.updatedAt,
        });
        current = { ...app, updatedAt: new Date(+start + 2).toISOString() };
      }
      return route.fulfill({ json: current });
    },
  );
  const details = page.getByRole('dialog', { name: app.name });
  const section = details.getByRole('region', { name: 'Renewal exception' });
  const open = async () => {
    await page.goto('/?app=renewal-demo');
    const guest = page.getByRole('button', { name: /enter|guest/i }).first();
    await expect(details.or(guest)).toBeVisible();
    if (await guest.isVisible()) await guest.click();
    await expect(details).toBeVisible();
  };
  const grant = section.getByRole('button', {
    name: 'Grant renewal exception',
  });
  const revoke = section.getByRole('button', {
    name: 'Revoke renewal exception',
  });

  await open();
  const dateInput = section.getByLabel('Exception expiry (UTC)');
  await expect(dateInput).toHaveAttribute(
    'max',
    dateAfterDays(35).slice(0, 19),
  );
  await dateInput.fill(expiry.slice(0, 19));
  await section.getByLabel('Exception reason').fill(reason);
  await grant.click();
  await expect(section.getByText(reason)).toBeVisible();
  await expect(
    section.getByText(`Accountable owner ${app.owner}`),
  ).toBeVisible();
  await expect(section.locator('time')).toHaveAttribute('datetime', expiry);
  await expect(
    details.getByText(`Next review due ${app.nextReview.slice(0, 10)}.`),
  ).toBeVisible();
  const closeDetails = details.getByRole('button', {
    name: 'Close app details',
  });
  await closeDetails.click();
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  const exceptions = page.getByRole('region', { name: 'Renewal exceptions' });
  await expect(exceptions.getByText(/Expires/)).toBeVisible();
  await expect(exceptions.getByRole('link')).toHaveText([
    expiredApp.name,
    app.name,
  ]);
  await expect(exceptions.getByText(/Expired .*UTC/)).toBeVisible();
  await expect(exceptions.locator('time').last()).toHaveAttribute(
    'datetime',
    expiry,
  );
  await exceptions.getByRole('link', { name: app.name }).click();
  await revoke.click();
  await expect(details.getByText('Renewal exception revoked.')).toBeVisible();
  await expect(grant).toBeVisible();
  await closeDetails.click();
  await expect(exceptions.getByRole('link')).toHaveText([expiredApp.name]);

  actor = app.owner;
  current = {
    ...grantedApp,
    nextReview: dateAfterDays(-3),
    renewalException: { ...exception, expiresAt: dateAfterDays(-1) },
  };
  await open();
  await expect(section.getByText('Expired', { exact: false })).toBeVisible();
  await expect(revoke).toHaveCount(0);
  await expect(grant).toHaveCount(0);
  await closeDetails.click();
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(
    page.getByText('Non-retired apps', { exact: true }),
  ).toBeVisible();
  await expect(exceptions).toHaveCount(0);

  actor = reviewer;
  current = app;
  split = true;
  await open();
  await expect(
    details.getByText('Required sign-offs', { exact: true }),
  ).toBeVisible();
  await expect(grant).toHaveCount(0);
});

test('Builder guide shows connector approval limits and registry states', async ({
  page,
}) => {
  const docsUrl = 'https://docs.example.com/connectors/catalog-search';
  const connectors = [
    {
      id: 'catalog-search',
      name: 'Catalog search',
      kind: 'mcp',
      description: 'Search approved records in the internal catalog.',
      access: 'read',
      maxClassification: 'internal',
      docsUrl,
    },
    {
      id: 'sandbox-orders',
      name: 'Sandbox orders',
      kind: 'data',
      description: 'Write synthetic orders into the test workspace.',
      access: 'write',
      maxClassification: 'confidential',
    },
  ];
  let releaseRegistry: () => void = () => {};
  const releaseResponse = new Promise<void>(resolve => {
    releaseRegistry = resolve;
  });
  let state: 'ready' | 'unconfigured' | 'empty' | 'error' = 'ready';

  await page.route('**/api/governance/approved-connectors', async route => {
    expect(route.request().method()).toBe('GET');
    if (state === 'error') return route.fulfill({ status: 503 });
    if (state === 'ready') await releaseResponse;
    return route.fulfill({
      json: {
        configured: state !== 'unconfigured',
        connectors: state === 'ready' ? connectors : [],
      },
    });
  });

  await page.goto('/?view=guide');
  const registry = page.getByRole('region', { name: 'Approved connectors' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(registry.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  const guidance = page.getByRole('region', { name: 'Guidance for builders' });
  await expect(
    guidance.getByRole('link', { name: 'registration', exact: true }),
  ).toHaveAttribute('href', '/?view=register');
  await expect(
    guidance.getByRole('link', { name: 'Check my apps for reassessment' }),
  ).toHaveAttribute('href', '/?owner=me&review=reassess');
  try {
    await expect(registry.getByRole('status')).toHaveText(
      'Loading approved connectors…',
    );
  } finally {
    releaseRegistry();
  }
  await expect(
    registry.getByRole('columnheader', { name: 'Maximum data classification' }),
  ).toHaveCount(1);
  const catalogSearch = registry
    .getByRole('row')
    .filter({ hasText: 'Catalog search' });
  await expect(catalogSearch).toContainText(
    'Search approved records in the internal catalog.',
  );
  await expect(
    catalogSearch.getByRole('cell', { name: 'MCP server' }),
  ).toBeVisible();
  await expect(catalogSearch.getByRole('cell', { name: 'Read' })).toBeVisible();
  await expect(
    catalogSearch.locator('td[data-label="Maximum data classification"]'),
  ).toHaveText('internal');
  await expect(
    catalogSearch.getByRole('link', { name: 'Catalog search documentation' }),
  ).toHaveAttribute('href', docsUrl);
  const sandbox = registry
    .getByRole('row')
    .filter({ hasText: 'Sandbox orders' });
  await expect(
    sandbox.getByRole('cell', { name: 'Data connector' }),
  ).toBeVisible();
  await expect(sandbox.locator('td[data-label="Access"]')).toHaveText('Write');
  await expect(
    sandbox.locator('td[data-label="Maximum data classification"]'),
  ).toHaveText('confidential');
  await expect(sandbox.getByRole('link')).toHaveCount(0);
  await assertWorkspace(page, 'Builder guide', 'Builder guide');

  const navigation = page.getByRole('navigation', { name: 'AI governance' });
  async function reopenGuide() {
    await navigation
      .getByRole('link', { name: 'Inventory', exact: true })
      .click();
    await navigation
      .getByRole('link', { name: 'Builder guide', exact: true })
      .click();
  }
  state = 'unconfigured';
  await reopenGuide();
  await expect(
    registry.getByText('No connector registry is configured.'),
  ).toBeVisible();
  state = 'empty';
  await reopenGuide();
  await expect(registry.getByText('No connectors are approved.')).toBeVisible();
  state = 'error';
  await reopenGuide();
  await expect(registry.getByRole('alert')).toHaveText(
    'The connector registry could not load.',
  );
});

test('a retirement candidate goes from reviewer request to owner confirmation', async ({
  page,
}) => {
  const reviewer = 'user:default/reviewer';
  const lastLiveCall = '2025-01-01T00:00:00.000Z';
  const app = {
    id: 'retirement-candidate',
    name: 'Legacy invoice assistant',
    purpose: 'Summarize invoices for an archived workflow.',
    owner: 'user:default/owner',
    platform: 'GitHub',
    sourceUrl: 'https://example.com/invoices',
    classification: 'internal',
    lifecycle: 'active',
    tier: 1,
    models: ['gpt-4.1-mini'],
    reviewStatus: 'not required',
    updatedAt: '2025-05-01T00:00:00.000Z',
  };
  const requestedAt = '2025-05-02T00:00:00.000Z';
  const decidedAt = '2025-05-03T00:00:00.000Z';
  const pending = {
    requestedAt,
    requestedBy: reviewer,
    owner: app.owner,
    lastLiveCall,
    status: 'pending',
  };
  const reason = 'The finance team moved to the shared workflow.';
  let current: typeof app & {
    retirementReview?: typeof pending & { reason?: string; decidedAt?: string };
  } = app;
  let actor = reviewer;

  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor,
        canReview: actor === reviewer,
        apps: [current, { ...app, id: 'other-app', name: 'Another workflow' }],
      },
    }),
  );
  await page.route('**/api/governance/reports/usage', route =>
    route.fulfill({
      json: {
        from: requestedAt,
        retirementReview: {
          days: 90,
          apps:
            current.lifecycle === 'active'
              ? [{ appId: app.id, lastLiveCall }]
              : [],
        },
        usage: [],
        blocks: [],
      },
    }),
  );
  await page.route(
    '**/api/governance/apps/retirement-candidate/retirement-review',
    route => {
      const request = route.request();
      if (request.method() === 'POST') {
        expect(actor).toBe(reviewer);
        expect(request.postDataJSON()).toEqual({
          expectedUpdatedAt: app.updatedAt,
        });
        current = { ...app, updatedAt: requestedAt, retirementReview: pending };
      } else {
        expect(actor).toBe(app.owner);
        expect(request.method()).toBe('PATCH');
        expect(request.postDataJSON()).toEqual({
          decision: 'retire',
          reason,
          expectedUpdatedAt: requestedAt,
        });
        current = {
          ...app,
          lifecycle: 'retired',
          updatedAt: decidedAt,
          retirementReview: {
            ...pending,
            status: 'retired',
            decidedAt,
            reason,
          },
        };
      }
      return route.fulfill({ json: current });
    },
  );
  const details = page.getByRole('dialog', { name: app.name });
  const review = details.getByRole('region', { name: 'Retirement review' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();

  await page.goto('/?view=reports');
  const candidateLink = page
    .getByRole('region', { name: 'Retirement review' })
    .getByRole('link', { name: app.name });
  await expect(candidateLink.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await candidateLink.click();
  await expect(
    review.getByText('Last live gateway call 2025-01-01.'),
  ).toBeVisible();
  await review
    .getByRole('button', { name: 'Request retirement review' })
    .click();
  await expect(
    review.getByText(`Awaiting a decision from ${app.owner}.`),
  ).toBeVisible();
  await expect(
    review.getByRole('combobox', { name: 'Retirement decision' }),
  ).toHaveCount(0);

  await expect(
    review.getByText(`Requested by ${reviewer} on 2025-05-02.`),
  ).toBeVisible();

  actor = app.owner;
  await page.goto('/');
  await expect(
    page.getByText('Retirement decision requested').or(guest),
  ).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(page.getByText('Retirement decision requested')).toBeVisible();
  await page
    .getByRole('link', { name: '1 app needs your retirement decision' })
    .click();
  await expect(page).toHaveURL(/owner=me&review=retirement$/);
  await expect(
    page.getByRole('combobox', { name: 'Review status' }),
  ).toHaveValue('retirement');
  await expect(
    page.getByRole('button', { name: /Another workflow/ }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: new RegExp(app.name) }).click();
  await review
    .getByRole('combobox', { name: 'Retirement decision' })
    .selectOption('retire');
  const submitDecision = review.getByRole('button', {
    name: 'Record retirement decision',
  });
  const confirm = review.getByRole('checkbox', {
    name: /retiring this app revokes its gateway key/,
  });
  await expect(submitDecision).toBeDisabled();
  await review
    .getByRole('textbox', { name: 'Reason for decision' })
    .fill(reason);
  await confirm.check();
  await submitDecision.click();

  await expect(
    review.getByText('Retired by owner on 2025-05-03.'),
  ).toBeVisible();
  await expect(review.getByText(reason)).toBeVisible();
  await expect(
    details.getByRole('combobox', { name: 'Lifecycle' }),
  ).toHaveValue('retired');
  await details.getByRole('button', { name: 'Close app details' }).click();
  await expect(page.getByText('Retirement decision requested')).toHaveCount(0);
});

test('the assigned owner can act on a scheduled retirement request', async ({
  page,
}) => {
  const requestedAt = '2025-05-02T00:00:00.000Z';
  const owner = 'user:default/owner';
  const app = {
    id: 'scheduled-retirement',
    name: 'Scheduled retirement candidate',
    purpose: 'Summarize invoices for an archived workflow.',
    owner,
    platform: 'GitHub',
    sourceUrl: 'https://example.com/scheduled-retirement',
    classification: 'internal',
    lifecycle: 'active',
    tier: 1,
    models: ['gpt-4.1-mini'],
    reviewStatus: 'not required',
    updatedAt: requestedAt,
    activeSince: '2025-01-01T00:00:00.000Z',
    retirementReview: {
      owner,
      requestedBy: 'plugin:governance',
      requestedAt,
      lastLiveCall: null,
      status: 'pending',
    },
  };
  await page.route('**/api/governance/apps', route =>
    route.fulfill({ json: { actor: owner, canReview: false, apps: [app] } }),
  );
  await page.goto('/?app=scheduled-retirement');
  const details = page.getByRole('dialog', { name: app.name });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(details.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  const review = details.getByRole('region', { name: 'Retirement review' });
  await expect(
    review.getByText(/No live calls since activation/),
  ).toBeVisible();
  await expect(review.locator('time').first()).toHaveAttribute(
    'datetime',
    app.activeSince,
  );
  await expect(
    review.getByText('Requested by Scheduled inactivity check on 2025-05-02.'),
  ).toBeVisible();
  await review
    .getByRole('combobox', { name: 'Retirement decision' })
    .selectOption('keep');
  await expect(
    review.getByRole('button', { name: 'Record retirement decision' }),
  ).toBeEnabled();
});

test('resumed live gateway activity leaves only the keep decision available', async ({
  page,
}) => {
  const owner = 'user:default/owner';
  const requestedAt = '2025-05-02T00:00:00.000Z';
  const app = {
    id: 'resumed-retirement',
    name: 'Resumed invoice assistant',
    purpose: 'Summarize invoices for the finance team.',
    owner,
    platform: 'GitHub',
    sourceUrl: 'https://example.com/resumed-retirement',
    classification: 'internal',
    lifecycle: 'active',
    tier: 1,
    models: ['gpt-4.1-mini'],
    reviewStatus: 'not required',
    updatedAt: requestedAt,
    activeSince: '2025-01-01T00:00:00.000Z',
    retirementReview: {
      owner,
      requestedBy: 'plugin:governance',
      requestedAt,
      lastLiveCall: null,
      status: 'pending',
    },
  };
  await page.route('**/api/governance/apps', route =>
    route.fulfill({ json: { actor: owner, canReview: false, apps: [app] } }),
  );
  await page.route('**/api/governance/apps/resumed-retirement', route =>
    route.fulfill({
      json: {
        ...app,
        retirementReview: {
          ...app.retirementReview,
          liveActivityChangedAt: '2025-05-03T00:00:00.000Z',
        },
      },
    }),
  );

  await page.goto('/?app=resumed-retirement');
  const details = page.getByRole('dialog', { name: app.name });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(details.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();

  const review = details.getByRole('region', { name: 'Retirement review' });
  await expect(review.getByText(/Live gateway activity resumed/)).toBeVisible();
  const decision = review.getByRole('combobox', {
    name: 'Retirement decision',
  });
  await expect(
    decision.getByRole('option', { name: 'Retire app' }),
  ).toHaveCount(0);
  await decision.selectOption({ label: 'Keep active' });
  await expect(decision).toHaveValue('keep');
  await review
    .getByRole('textbox', { name: 'Reason for decision' })
    .fill('The app is serving live requests again.');
  await expect(
    review.getByRole('button', { name: 'Record retirement decision' }),
  ).toBeEnabled();
});

test('an engineering co-owner nominee can accept without gaining app controls', async ({
  page,
}) => {
  const owner = 'user:default/owner';
  const nominee = 'user:default/engineering';
  const reviewer = 'user:default/reviewer';
  const requestedAt = '2025-05-02T00:00:00.000Z';
  const decidedAt = '2025-05-03T00:00:00.000Z';
  const reason = 'I can support this production app.';
  const endReason = 'The app is moving to a different engineering team.';
  const endedAt = '2025-05-04T00:00:00.000Z';
  const app = {
    id: 'graduation-candidate',
    name: 'Production invoice assistant',
    purpose: 'Summarize new invoices for finance.',
    owner,
    team: 'group:default/platform',
    platform: 'GitHub',
    sourceUrl: 'https://example.com/production-invoices',
    classification: 'internal',
    lifecycle: 'experimental',
    deliveryStage: 'production',
    tier: 3,
    type: 'assistant',
    models: ['gpt-4.1-mini'],
    reviewStatus: 'pending',
    updatedAt: '2025-05-01T00:00:00.000Z',
  };
  const pending = {
    nominee,
    requestedBy: owner,
    requestedAt,
    status: 'pending',
  };
  let actor = owner;
  let current: typeof app & {
    graduation?: typeof pending & { reason?: string; decidedAt?: string };
  } = app;

  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor,
        canReview:
          actor === reviewer ||
          (actor === nominee && current.graduation?.status === 'accepted'),
        gatewayEnabled: true,
        graduationEnabled: true,
        apps: [current],
      },
    }),
  );
  await page.route(
    '**/api/governance/apps/graduation-candidate/graduation',
    route => {
      const request = route.request();
      if (request.method() === 'POST') {
        expect(actor).toBe(owner);
        expect(request.postDataJSON()).toEqual({
          nominee,
          expectedUpdatedAt: current.updatedAt,
        });
        current = { ...app, updatedAt: requestedAt, graduation: pending };
      } else if (request.method() === 'DELETE') {
        if (current.graduation?.status === 'accepted') {
          expect(actor).toBe(reviewer);
          expect(request.postDataJSON()).toEqual({
            expectedUpdatedAt: decidedAt,
            reason: endReason,
          });
          current = { ...app, updatedAt: endedAt };
        } else {
          expect(actor).toBe(owner);
          expect(request.postDataJSON()).toEqual({
            expectedUpdatedAt: requestedAt,
          });
          current = { ...app, updatedAt: '2025-05-02T00:00:00.001Z' };
        }
      } else {
        expect(actor).toBe(nominee);
        expect(request.method()).toBe('PATCH');
        expect(request.postDataJSON()).toEqual({
          decision: 'accept',
          reason,
          expectedUpdatedAt: requestedAt,
        });
        current = {
          ...app,
          updatedAt: decidedAt,
          graduation: { ...pending, status: 'accepted', decidedAt, reason },
        };
      }
      return route.fulfill({ json: current });
    },
  );
  await page.route(
    '**/api/governance/apps/graduation-candidate/history',
    route =>
      route.fulfill({
        json: {
          keyEvents: [],
          events: [
            {
              digest: 'd'.repeat(64),
              event: JSON.stringify({
                action: 'graduation-ended',
                actor: reviewer,
                graduationNominee: nominee,
                graduationReason: endReason,
                record: current,
              }),
            },
          ],
        },
      }),
  );
  const details = page.getByRole('dialog', { name: app.name });
  const panel = details.getByRole('region', { name: 'Engineering co-owner' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();

  await page.goto('/?app=graduation-candidate');
  await expect(details.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await panel.getByRole('textbox', { name: 'Co-owner nominee' }).fill(nominee);
  await panel
    .getByRole('button', { name: 'Nominate engineering co-owner' })
    .click();
  await expect(
    panel.getByText(`Awaiting a decision from ${nominee}.`),
  ).toBeVisible();
  await expect(
    panel.getByRole('combobox', { name: 'Co-owner decision' }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole('button', { name: 'Nominate engineering co-owner' }),
  ).toHaveCount(0);

  await panel.getByRole('button', { name: 'Cancel nomination' }).click();
  await expect(
    details.getByText('Engineering nomination cancelled.'),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Cancel nomination' }),
  ).toHaveCount(0);
  await panel.getByRole('textbox', { name: 'Co-owner nominee' }).fill(nominee);
  await panel
    .getByRole('button', { name: 'Nominate engineering co-owner' })
    .click();
  await expect(
    panel.getByText(`Awaiting a decision from ${nominee}.`),
  ).toBeVisible();

  actor = nominee;
  await page.goto('/');
  const notice = page.getByText('Engineering co-owner decision requested');
  await expect(notice.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(notice).toBeVisible();
  await page.goto(`/?app=${encodeURIComponent(app.id)}`);
  await expect(details).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Cancel nomination' }),
  ).toHaveCount(0);
  await panel
    .getByRole('combobox', { name: 'Co-owner decision' })
    .selectOption('accept');
  await panel.getByRole('textbox', { name: 'Reason (optional)' }).fill(reason);
  await panel.getByRole('button', { name: 'Record co-owner decision' }).click();
  await expect(
    panel.getByText(`Accepted by ${nominee} on 2025-05-03.`),
  ).toBeVisible();
  await expect(panel.getByText(reason)).toBeVisible();
  await expect(
    details.getByText('Edit app details', { exact: true }),
  ).toHaveCount(0);
  await expect(
    details.getByRole('button', { name: 'Update lifecycle' }),
  ).toHaveCount(0);
  await expect(
    details.getByRole('region', { name: 'Gateway playground' }),
  ).toHaveCount(0);
  await details.getByRole('button', { name: 'Close app details' }).click();
  await expect(notice).toHaveCount(0);

  await page.goto('/?app=graduation-candidate');
  await expect(details.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(
    panel.getByText(`Accepted by ${nominee} on 2025-05-03.`),
  ).toBeVisible();
  await expect(
    details.getByText('Audit history', { exact: true }),
  ).toBeVisible();
  const end = panel.getByRole('button', { name: 'End engineering handoff' });
  await expect(end).toHaveCount(0);
  const lifecycle = details.getByRole('combobox', { name: 'Lifecycle' });
  await expect(lifecycle).toBeVisible();
  const retireOption = lifecycle.getByRole('option', { name: 'retired' });
  await expect(retireOption).toHaveCount(0);
  const editor = details.getByText('Edit app details', { exact: true });
  const ownerInput = details.getByRole('textbox', {
    name: 'Owner',
    exact: true,
  });
  const stageInput = details.getByRole('combobox', { name: 'Delivery stage' });
  await editor.click();
  await expect(ownerInput).not.toBeEditable();
  await expect(stageInput).toBeDisabled();

  actor = reviewer;
  await page.goto('/?app=graduation-candidate');
  await expect(details.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(retireOption).toHaveCount(1);
  await editor.click();
  await expect(ownerInput).toBeEditable();
  await expect(stageInput).toBeEnabled();
  await expect(
    panel.getByText(
      `Ending this handoff removes ${nominee} as engineering co-owner.`,
    ),
  ).toBeVisible();
  const endingReason = panel.getByRole('textbox', {
    name: 'Reason for ending the handoff',
  });
  await expect(endingReason).toHaveAttribute('required', '');
  await endingReason.fill(endReason);
  await end.click();
  await expect(details.getByText('Engineering handoff ended.')).toBeVisible();
  await expect(
    panel.getByRole('textbox', { name: 'Co-owner nominee' }),
  ).toBeVisible();
  await details.getByText('Audit history', { exact: true }).click();
  await expect(
    details.getByText('Graduation ended', { exact: true }),
  ).toBeVisible();
  await expect(details.getByText(endReason, { exact: false })).toBeVisible();
});

test('the playground clears a revealed key after environment or ownership changes', async ({
  page,
}) => {
  const reviewer = 'user:default/reviewer';
  const newOwner = 'user:default/new-owner';
  const key = 'synthetic-gateway-key';
  const productionKey = 'synthetic-production-key';
  const issued = { sandbox: false, production: false };
  let statusReads = 0;
  const now = new Date();
  await page.clock.setFixedTime(now);
  const monthlySpend = {
    monthStart: `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`,
    liveEstimatedCostUsd: 2,
    thresholdUsd: 2,
    stopAtThreshold: true,
  };
  let app = {
    id: 'key-transfer',
    name: 'Key transfer assistant',
    owner: 'user:default/owner',
    backupOwner: 'user:default/backup',
    team: 'group:default/platform',
    purpose: 'Summarize synthetic notes.',
    type: 'assistant',
    platform: 'GitHub',
    sourceUrl: 'https://example.com/key-transfer',
    classification: 'internal',
    models: ['gpt-4.1-mini'],
    audience: 'team',
    lifecycle: 'experimental',
    tier: 3,
    reviewStatus: 'pending',
    nextReview: null as string | null,
    updatedAt: '2025-05-01T00:00:00.000Z',
  };
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor: reviewer,
        canReview: true,
        gatewayEnabled: true,
        apps: [app],
      },
    }),
  );
  await page.route('**/api/governance/gateway/models', route =>
    route.fulfill({
      json: {
        enabled: true,
        productionAvailable: true,
        models: [
          {
            id: 'gpt-4.1-mini',
            allowedClassifications: ['internal'],
            maxCompletionTokens: 1024,
          },
        ],
      },
    }),
  );
  await page.route(/\/key-transfer\/gateway-key(?:\?|$)/, route => {
    const environment =
      new URL(route.request().url()).searchParams.get('environment') ===
      'production'
        ? 'production'
        : 'sandbox';
    if (route.request().method() === 'POST') {
      issued[environment] = true;
      return route.fulfill({
        status: 201,
        json: { key: environment === 'production' ? productionKey : key },
      });
    }
    expect(route.request().method()).toBe('GET');
    statusReads += 1;
    return route.fulfill({ json: { issued: issued[environment] } });
  });
  await page.route('**/api/governance/apps/key-transfer/usage', route =>
    route.fulfill({
      json: {
        liveCalls: 1,
        simulatedCalls: 0,
        unclassifiedCalls: 0,
        liveEstimatedCostUsd: 2,
        liveTokens: { calls: 1, input: 10, output: 5 },
        requestsPerMinute: null,
        monthlySpend,
        blockedCalls: 0,
        blocks: [],
      },
    }),
  );
  await page.route('**/api/governance/gateway/chat', route => {
    const request = route.request();
    const production =
      request.headers().authorization === `Bearer ${productionKey}`;
    expect(request.headers().authorization).toBe(
      `Bearer ${production ? productionKey : key}`,
    );
    expect(request.postDataJSON()).toEqual({
      model: 'gpt-4.1-mini',
      prompt: 'Synthetic playground prompt',
      expectedEnvironment: production ? 'production' : 'sandbox',
    });
    return route.fulfill({
      json: {
        output: production ? 'Synthetic production reply' : 'Sandbox reply',
        model: 'gpt-4.1-mini',
        simulated: !production,
      },
    });
  });
  await page.route('**/api/governance/apps/key-transfer/reviews', route => {
    expect(route.request().postDataJSON()).toMatchObject({
      status: 'approved',
      expectedUpdatedAt: app.updatedAt,
    });
    app = {
      ...app,
      reviewStatus: 'approved',
      nextReview: '2025-11-02T00:00:00.000Z',
      updatedAt: '2025-05-02T00:00:00.000Z',
    };
    return route.fulfill({ json: app });
  });
  await page.route('**/api/governance/apps/key-transfer/lifecycle', route => {
    expect(route.request().postDataJSON()).toMatchObject({
      lifecycle: 'active',
      expectedUpdatedAt: app.updatedAt,
    });
    app = {
      ...app,
      lifecycle: 'active',
      updatedAt: '2025-05-03T00:00:00.000Z',
    };
    return route.fulfill({ json: app });
  });
  await page.route('**/api/governance/apps/key-transfer', route => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().postDataJSON()).toMatchObject({
      owner: newOwner,
      expectedUpdatedAt: app.updatedAt,
    });
    issued.sandbox = false;
    issued.production = false;
    app = {
      ...app,
      owner: newOwner,
      lifecycle: 'experimental',
      reviewStatus: 'pending',
      nextReview: null,
      updatedAt: '2025-05-04T00:00:00.000Z',
    };
    return route.fulfill({ json: app });
  });

  await page.goto('/?app=key-transfer');
  const details = page.getByRole('dialog', { name: app.name });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(details.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  const playground = details.getByRole('region', {
    name: 'Gateway playground',
  });
  const issue = playground.getByRole('button', { name: 'Issue gateway key' });
  const revealed = playground.getByText(key, { exact: true });
  await issue.click();
  await playground.getByRole('button', { name: 'Show key' }).click();
  await expect(revealed).toBeVisible();

  await details
    .getByRole('textbox', { name: 'Review notes' })
    .fill('Approved for synthetic use.');
  await details.getByRole('button', { name: 'Record decision' }).click();
  await expect(details.getByText('Review recorded.')).toBeVisible();
  await expect(revealed).toBeVisible();

  await details
    .getByRole('combobox', { name: 'Lifecycle' })
    .selectOption('active');
  await details.getByRole('button', { name: 'Update lifecycle' }).click();
  await expect(details.getByText('Lifecycle updated.')).toBeVisible();
  await expect(revealed).toBeVisible();

  const prompt = playground.getByRole('textbox', { name: 'Prompt' });
  const send = playground.getByRole('button', { name: 'Send prompt' });
  await prompt.fill('Synthetic playground prompt');
  await expect(playground.getByText(/Threshold reached/)).toBeVisible();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    playground.getByText('Sandbox reply', { exact: true }),
  ).toBeVisible();

  const environment = playground.getByRole('combobox', {
    name: 'Gateway key environment',
  });
  await environment.selectOption('production');
  await expect(revealed).toHaveCount(0);
  await issue.click();
  await playground.getByRole('button', { name: 'Show key' }).click();
  const productionRevealed = playground.getByText(productionKey, {
    exact: true,
  });
  await expect(productionRevealed).toBeVisible();

  await expect(prompt).toHaveValue('');
  await prompt.fill('Synthetic playground prompt');
  const pause = playground.getByText(
    'Production prompts are paused at the monthly spend threshold.',
    { exact: true },
  );
  await expect(pause).toBeVisible();
  await expect(send).toBeDisabled();

  monthlySpend.stopAtThreshold = false;
  await playground.getByRole('button', { name: 'Refresh usage' }).click();
  await expect(pause).toHaveCount(0);
  await expect(playground.getByText(/Threshold reached/)).toBeVisible();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    playground.getByText('Synthetic production reply', { exact: true }),
  ).toBeVisible();

  const readsBeforeTransfer = statusReads;
  await details.getByText('Edit app details', { exact: true }).click();
  await details
    .getByRole('textbox', { name: 'Owner', exact: true })
    .fill(newOwner);
  await details.getByRole('button', { name: 'Save app details' }).click();
  await expect(issue).toBeEnabled();
  expect(statusReads).toBeGreaterThan(readsBeforeTransfer);
  await expect(productionRevealed).toHaveCount(0);
  await expect(revealed).toHaveCount(0);
  await expect(
    playground.getByRole('button', { name: /Show key|Hide key|Rotate key/ }),
  ).toHaveCount(0);
  await expect(
    playground.getByRole('button', { name: 'Send prompt' }),
  ).toBeDisabled();
});

test('an owner can publish a searchable directory listing and remove it', async ({
  page,
}) => {
  const owner = 'user:default/owner';
  const app = {
    id: 'listed-app',
    name: 'Inventory reconciliation',
    purpose: 'Private implementation notes for the operations team.',
    owner,
    team: 'group:default/operations',
    platform: 'GitHub',
    sourceUrl: 'https://example.com/private-source',
    classification: 'internal',
    lifecycle: 'active',
    tier: 1,
    usesAiAtRuntime: false,
    directoryLaunchEligible: true,
    models: [],
    reviewStatus: 'not required',
    updatedAt: '2025-05-01T00:00:00.000Z',
  };
  const listing = {
    summary: 'Reconcile stock discrepancies.',
    url: 'https://example.com/launch/reconciliation',
  };
  let current: typeof app & { directoryListing?: typeof listing } = app;
  let inventoryReads = 0;
  await page.route('**/api/governance/apps', route => {
    inventoryReads += 1;
    if (inventoryReads === 1)
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Inventory temporarily unavailable.' } },
      });
    return route.fulfill({
      json: { actor: owner, canReview: false, apps: [current] },
    });
  });
  let directoryReads = 0;
  await page.route('**/api/governance/directory', route => {
    directoryReads += 1;
    if (directoryReads === 1) return route.fulfill({ status: 503 });
    return route.fulfill({
      json: {
        apps:
          current.directoryLaunchEligible && current.directoryListing
            ? [{ id: app.id, name: app.name, ...current.directoryListing }]
            : [],
      },
    });
  });
  await page.route('**/api/governance/apps/listed-app/directory', route => {
    const request = route.request();
    if (request.method() === 'PUT') {
      expect(request.postDataJSON()).toEqual({
        ...listing,
        expectedUpdatedAt: app.updatedAt,
      });
      current = {
        ...app,
        updatedAt: '2025-05-02T00:00:00.000Z',
        directoryListing: listing,
      };
    } else {
      expect(request.method()).toBe('DELETE');
      expect(request.postDataJSON()).toEqual({
        expectedUpdatedAt: '2025-05-02T00:00:00.000Z',
      });
      current = { ...app, updatedAt: '2025-05-03T00:00:00.000Z' };
    }
    return route.fulfill({ json: current });
  });

  const nav = page.getByRole('navigation', { name: 'AI governance' });
  const directory = page.getByRole('region', { name: 'Directory apps' });
  const empty = directory.getByRole('heading', {
    name: 'No apps listed',
  });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await page.goto('/?view=directory');
  const directoryError = directory.getByRole('alert');
  await expect(directoryError.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(directoryError).toHaveText('The app directory could not load.');
  await directory
    .getByRole('button', { name: 'Retry loading Directory' })
    .click();
  await expect(empty).toBeVisible();
  expect(directoryReads).toBe(2);
  expect(inventoryReads).toBe(0);

  await nav.getByRole('link', { name: 'Inventory', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Error: Inventory temporarily unavailable.',
  );
  await nav.getByRole('link', { name: 'Directory', exact: true }).click();
  await expect(empty).toBeVisible();
  expect(inventoryReads).toBe(1);

  const details = page.getByRole('dialog', { name: app.name });
  async function openPublisher() {
    await nav.getByRole('link', { name: 'Inventory', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(app.name) }).click();
    await details.getByText('Directory listing', { exact: true }).click();
  }
  await openPublisher();
  const summary = details.getByRole('textbox', { name: 'Directory summary' });
  const url = details.getByRole('textbox', { name: 'Launch URL' });
  await expect(summary).toHaveValue('');
  await expect(url).toHaveValue('');
  await summary.fill(listing.summary);
  await url.fill(listing.url);
  await details.getByRole('button', { name: 'Publish in Directory' }).click();
  await expect(
    details.getByRole('button', { name: 'Update directory listing' }),
  ).toBeVisible();
  await details.getByRole('button', { name: 'Close app details' }).click();

  await nav.getByRole('link', { name: 'Directory', exact: true }).click();
  const launch = directory
    .locator('td[data-label="Launch"]')
    .getByRole('link', { name: `Open ${app.name}` });
  await expect(launch).toHaveAttribute('href', listing.url);
  await expect(launch).toHaveAttribute('rel', 'noreferrer');
  await expect(directory.getByText(app.purpose)).toHaveCount(0);
  const search = directory.getByRole('searchbox', { name: 'Search directory' });
  await search.fill('unmatched');
  await expect(
    directory.getByRole('heading', { name: 'No matching apps' }),
  ).toBeVisible();
  await search.fill('discrepancies');
  await expect(launch).toBeVisible();
  await assertWorkspace(page, 'App directory', 'Directory');

  current = { ...current, directoryLaunchEligible: false };
  await page.reload();
  await expect(empty).toBeVisible();
  await openPublisher();
  await expect(
    details.getByText(
      'This listing is hidden until the app meets current launch requirements.',
    ),
  ).toBeVisible();
  await expect(
    details.getByRole('button', { name: 'Update directory listing' }),
  ).toBeDisabled();
  await details
    .getByRole('button', { name: 'Unpublish from Directory' })
    .click();
  await expect(details.getByText('Directory listing removed.')).toBeVisible();
  await details.getByRole('button', { name: 'Close app details' }).click();
  await nav.getByRole('link', { name: 'Directory', exact: true }).click();
  await expect(empty).toBeVisible();
  expect(inventoryReads).toBe(3);
});

test('a directory access request receives a recorded owner decision', async ({
  page,
}) => {
  const requester = 'user:default/requester';
  const owner = 'user:default/owner';
  const summary = 'Reconcile stock discrepancies.';
  const message = 'I reconcile the warehouse inventory each week.';
  const listing = { summary, url: 'https://example.com/launch/reconciliation' };
  const app = {
    id: 'access-app',
    name: 'Inventory reconciliation',
    purpose: 'Private operations context.',
    owner,
    team: 'group:default/operations',
    platform: 'GitHub',
    sourceUrl: 'https://example.com/private-source',
    classification: 'internal',
    lifecycle: 'active',
    tier: 1,
    usesAiAtRuntime: false,
    models: [],
    reviewStatus: 'not required',
    directoryListing: listing,
    updatedAt: '2025-05-01T00:00:00.000Z',
  };
  const seed = {
    id: 'request-1',
    requester,
    message,
    requestedAt: app.updatedAt,
  };
  let actor = requester;
  let status: 'pending' | 'approved' | undefined;
  let canApprove = true;
  let approvalCheckUnavailable = true;
  const conflictMessage =
    'This app no longer has an eligible directory listing.';
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor,
        canReview: actor === owner,
        apps: [app],
        appsWithPendingAccessRequests:
          actor === owner && status === 'pending' ? [app.id] : undefined,
      },
    }),
  );
  await page.route('**/api/governance/apps/access-app/directory', route => {
    expect(route.request().method()).toBe('PUT');
    canApprove = true;
    return route.fulfill({
      json: {
        ...app,
        directoryLaunchEligible: true,
        updatedAt: '2025-05-02T00:00:00.000Z',
      },
    });
  });
  await page.route('**/api/governance/directory', route =>
    route.fulfill({
      json: {
        apps: [
          {
            id: app.id,
            name: app.name,
            ...listing,
            requestStatus: actor === requester ? status : undefined,
          },
          {
            id: 'unrequested-app',
            name: 'Shipping labels',
            ...listing,
          },
        ],
      },
    }),
  );
  await page.route(
    '**/api/governance/apps/access-app/directory-requests',
    route => {
      const request = route.request();
      if (request.method() === 'POST') {
        expect(actor).toBe(requester);
        expect(request.postDataJSON()).toEqual({ message });
        status = 'pending';
        return route.fulfill({ status: 201, json: { id: seed.id, status } });
      }
      expect(actor).toBe(owner);
      expect(request.method()).toBe('GET');
      return route.fulfill({
        json: {
          requests: [{ ...seed, status }],
          canApprove: canApprove && !approvalCheckUnavailable,
          approvalCheckUnavailable,
        },
      });
    },
  );
  await page.route(
    '**/api/governance/apps/access-app/directory-requests/request-1',
    route => {
      expect(actor).toBe(owner);
      expect(route.request().method()).toBe('PATCH');
      expect(route.request().postDataJSON()).toEqual({ status: 'approved' });
      if (!canApprove)
        return route.fulfill({
          status: 409,
          json: { error: { message: conflictMessage } },
        });
      status = 'approved';
      return route.fulfill({
        json: { ...seed, status, decidedBy: owner, decidedAt: app.updatedAt },
      });
    },
  );

  const declinedAt = '2025-05-03T10:00:00.000Z';
  const approvedAt = '2025-05-04T10:00:00.000Z';
  await page.route('**/api/governance/apps/access-app/history', route =>
    route.fulfill({
      json: {
        events: [
          { action: 'registered' },
          { action: 'directory-access-declined', at: declinedAt },
          { action: 'directory-access-approved', at: approvedAt },
        ].map((event, index) => ({
          event: JSON.stringify({ actor: owner, record: app, ...event }),
          digest: String(index).repeat(64),
        })),
        keyEvents: [],
      },
    }),
  );

  const directory = page.getByRole('region', { name: 'Directory apps' });
  const details = page.getByRole('dialog', { name: app.name });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await page.goto('/?view=directory');
  await expect(directory.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  const myRequests = directory.getByRole('button', { name: /My requests/ });
  const allApps = directory.getByRole('button', { name: /All apps/ });
  await myRequests.click();
  await expect(directory.getByText('No access requests')).toBeVisible();
  await allApps.click();
  await directory
    .getByRole('row', { name: /Inventory reconciliation/ })
    .getByText('Request access', { exact: true })
    .click();
  await directory
    .getByRole('textbox', { name: 'Why do you need access?' })
    .fill(message);
  await directory.getByRole('button', { name: 'Send access request' }).click();
  await expect(
    directory.getByText('Access request pending', { exact: true }),
  ).toBeVisible();
  await myRequests.click();
  await expect(page).toHaveURL(/directoryAccess=mine/);
  await expect(directory.getByText('Shipping labels')).toHaveCount(0);
  await expect(
    directory.getByText('Access request pending', { exact: true }),
  ).toBeVisible();
  await expect(
    directory.getByText('Request access', { exact: true }),
  ).toHaveCount(0);

  actor = owner;
  await page.goto('/');
  const workQueue = page.getByRole('link', {
    name: '1 of your apps has pending access requests',
  });
  await expect(workQueue.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await workQueue.click();
  await expect(page).toHaveURL(/owner=me&review=access/);
  await page.getByRole('button', { name: app.name }).click();
  await expect(details).toBeVisible();
  await details.getByText('Directory access requests', { exact: true }).click();
  await expect(details.getByText(requester, { exact: true })).toBeVisible();
  await expect(details.getByText(message, { exact: true })).toBeVisible();
  await expect(
    details.getByText(/grant approved access in the destination app/),
  ).toBeVisible();
  const approve = details.getByRole('option', { name: 'Approve' });
  await expect(approve).toBeDisabled();
  await expect(
    details.getByText('Catalog ownership could not be verified.'),
  ).toBeVisible();
  await expect(details.getByRole('option', { name: 'Decline' })).toBeEnabled();
  approvalCheckUnavailable = false;
  await details.getByRole('button', { name: 'Retry ownership check' }).click();
  await expect(approve).toBeEnabled();
  canApprove = false;
  await details
    .getByRole('combobox', { name: 'Access decision' })
    .selectOption('approved');
  await details.getByRole('button', { name: 'Record access decision' }).click();
  await expect(details.getByRole('alert')).toHaveText(conflictMessage);
  await expect(approve).toBeDisabled();
  await details.getByText('Directory listing', { exact: true }).click();
  await details
    .getByRole('button', { name: 'Update directory listing' })
    .click();
  await expect(approve).toBeEnabled();
  await details
    .getByRole('combobox', { name: 'Access decision' })
    .selectOption('approved');
  await details.getByRole('button', { name: 'Record access decision' }).click();
  await expect(
    details.getByText('Access request approved', { exact: true }),
  ).toBeVisible();
  await expect(
    details.getByRole('button', { name: 'Record access decision' }),
  ).toHaveCount(0);

  await details.getByText('Audit history', { exact: true }).click();
  const auditHistory = details.getByRole('listitem').filter({
    hasText:
      /^(Directory access approved|Directory access declined|App registered)/,
  });
  await expect(auditHistory.locator('strong')).toHaveText([
    'Directory access approved',
    'Directory access declined',
    'App registered',
  ]);
  await expect(auditHistory.nth(0).locator('time')).toHaveAttribute(
    'datetime',
    approvedAt,
  );
  await expect(auditHistory.nth(1).locator('time')).toHaveAttribute(
    'datetime',
    declinedAt,
  );
  await expect(auditHistory.nth(2).locator('time')).toHaveAttribute(
    'datetime',
    app.updatedAt,
  );

  await details.getByRole('button', { name: 'Close app details' }).click();
  await expect(workQueue).toHaveCount(0);
  await expect(page.getByRole('button', { name: app.name })).toHaveCount(0);

  actor = requester;
  await page.goto('/?view=directory&directoryAccess=mine');
  await expect(directory.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(
    directory.getByText('Access request approved', { exact: true }),
  ).toBeVisible();
  await expect(
    directory.getByText('The app owner handles access in the destination app.'),
  ).toBeVisible();
  await expect(directory.getByText(message, { exact: true })).toHaveCount(0);
  await assertWorkspace(page, 'App directory', 'Directory');

  await page.route('**/api/governance/directory', route =>
    route.fulfill({
      json: {
        apps: [],
        unavailableRequests: [
          {
            id: 'archived-labels',
            name: 'Archived shipping labels',
            requestStatus: 'declined',
          },
        ],
      },
    }),
  );
  await page.goto('/?view=directory');
  await expect(allApps.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await myRequests.click();
  const unavailableRequest = directory.getByRole('row', {
    name: /Archived shipping labels/,
  });
  await expect(unavailableRequest).toContainText('Access request declined');
  await expect(unavailableRequest).toContainText('Listing unavailable');
  await expect(unavailableRequest.getByRole('link')).toHaveCount(0);
  await allApps.click();
  await expect(unavailableRequest).toHaveCount(0);
});

test('pending sign-offs CSV follows assigned tracks, review independence, and filters', async ({
  page,
}) => {
  const reviewer = 'user:default/security-reviewer';
  const owner = 'user:default/owner';
  const team = 'group:default/operations';
  const base = {
    purpose: 'Support a critical production workflow.',
    owner,
    backupOwner: 'user:default/backup',
    team,
    platform: 'GitHub',
    classification: 'internal',
    lifecycle: 'experimental',
    tier: 3,
    deliveryStage: 'pilot',
    usesAiAtRuntime: false,
    models: [],
    reviewStatus: 'pending',
    nextReview: null,
  };
  const apps = [
    { ...base, id: 'matching-pilot', name: 'Matching pilot' },
    { ...base, id: 'other-pilot', name: 'Stock count pilot' },
    {
      ...base,
      id: 'matching-production',
      name: 'Matching production',
      deliveryStage: 'production',
    },
    {
      ...base,
      id: 'signed',
      name: 'Matching security signed',
      signoffs: { security: { status: 'approved' } },
    },
    {
      ...base,
      id: 'owner-conflict',
      name: 'Matching owner conflict',
      owner: reviewer,
    },
    {
      ...base,
      id: 'backup-conflict',
      name: 'Matching backup owner conflict',
      backupOwner: reviewer,
    },
    {
      ...base,
      id: 'engineering-conflict',
      name: 'Matching engineering conflict',
      graduation: { nominee: reviewer, status: 'accepted' },
    },
  ];
  let canReview = true;
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor: canReview ? reviewer : 'user:default/viewer',
        canReview,
        reviewTracks: ['security', 'dataProtection'],
        reviewerTracks: ['security'],
        apps,
      },
    }),
  );

  await page.route('**/api/governance/reports/review-turnaround', route =>
    route.fulfill({
      json: {
        pendingApps: [
          { appId: 'other-pilot', workingDays: 9 },
          { appId: 'matching-pilot', workingDays: 6.5 },
        ],
      },
    }),
  );

  const reviews = page.getByRole('region', { name: 'Critical app reviews' });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  const exportButton = reviews.getByRole('button', {
    name: 'Download pending sign-offs CSV',
  });
  const reviewFilter = reviews.getByRole('combobox', { name: 'Review status' });
  async function openReviews() {
    await page.goto('/?view=reviews&review=mine');
    await expect(reviews.or(guest)).toBeVisible();
    if (await guest.isVisible()) await guest.click();
  }
  await openReviews();
  await expect(reviewFilter).toHaveValue('mine');
  const rows = reviews.getByRole('row').filter({ has: page.getByRole('cell') });
  await expect(rows.nth(0)).toContainText('Stock count pilot');
  await expect(rows.nth(0)).toContainText(
    '9 weekdays waiting for first decision',
  );
  await expect(rows.nth(1)).toContainText('Matching pilot');
  await expect(rows.nth(1)).toContainText(
    '6.5 weekdays waiting for first decision',
  );
  await expect(
    reviews.getByRole('row').filter({
      hasText: /Matching pilot|Stock count pilot|Matching production/,
    }),
  ).toHaveCount(3);
  await expect(
    reviews.getByRole('row').filter({
      hasText: /security signed|owner conflict|engineering conflict/,
    }),
  ).toHaveCount(0);

  await reviews
    .getByRole('combobox', { name: 'Delivery stage' })
    .selectOption('pilot');
  await expect(
    reviews.getByRole('row').filter({ hasText: 'Matching production' }),
  ).toHaveCount(0);
  const search = reviews.getByRole('searchbox', { name: 'Search apps' });
  await search.fill('Matching');
  await expect(
    reviews.getByRole('row').filter({ hasText: 'Stock count pilot' }),
  ).toHaveCount(0);

  const downloadPromise = page.waitForEvent('download');
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('frontstage-pending-signoffs.csv');
  const csv = await readFile(await download.path(), 'utf8');
  expect(
    csv
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split(/\r?\n/),
  ).toEqual([
    'app_id,app_name,owner,team,pending_sign_offs,next_review_utc,app_url,first_decision_wait_weekdays',
    `"matching-pilot","Matching pilot","${owner}","${team}","Security","","${workspaceUrl}/?app=matching-pilot",6.5`,
  ]);

  await search.fill('no matching records');
  await expect(exportButton).toHaveCount(0);

  const exportedAppUrl = csv.match(/"(https?:[^"]+)",/)?.[1];
  if (!exportedAppUrl) throw new Error('Export did not include an app URL');
  await page.goto(exportedAppUrl);
  const record = page.getByRole('dialog', { name: 'Matching pilot' });
  await expect(record).toBeVisible();
  const goToDecision = record.getByRole('button', {
    name: 'Go to review decision',
  });
  await goToDecision.click();
  await expect(
    record.getByRole('combobox', { name: 'Decision' }),
  ).toBeFocused();

  await page.goto('/?app=owner-conflict');
  const owned = page.getByRole('dialog', { name: 'Matching owner conflict' });
  await expect(owned).toBeVisible();
  await expect(
    owned.getByRole('button', { name: 'Go to review decision' }),
  ).toHaveCount(0);

  canReview = false;
  await openReviews();
  await expect(reviewFilter).toHaveValue('attention');
  await expect(
    reviewFilter.getByRole('option', { name: 'My pending sign-offs' }),
  ).toHaveCount(0);
  await expect(exportButton).toHaveCount(0);
});

test('the focused review ticket form saves and removes the link without reopening review', async ({
  page,
}) => {
  const reviewer = 'user:default/reviewer';
  const owner = 'user:default/owner';
  const ticket = 'https://tickets.example.com/reviews/123';
  const replacement = 'https://tickets.example.com/reviews/456';
  const app = {
    id: 'quick-ticket',
    name: 'Critical app with its review ticket',
    owner,
    backupOwner: 'user:default/backup',
    team: 'group:default/operations',
    purpose: 'Assist with priority operations decisions.',
    platform: 'GitHub',
    sourceUrl: 'https://example.com/source',
    classification: 'internal',
    lifecycle: 'active',
    tier: 3,
    usesAiAtRuntime: false,
    models: [],
    reviewStatus: 'approved',
    nextReview: '2099-01-01T00:00:00.000Z',
    updatedAt: '2025-05-01T00:00:00.000Z',
  };
  let current: typeof app & { reviewTicketUrl?: string } = app;
  const events = [
    {
      digest: 'a'.repeat(64),
      event: JSON.stringify({
        action: 'registered',
        actor: owner,
        record: app,
      }),
    },
  ];

  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: { actor: reviewer, canReview: true, apps: [current] },
    }),
  );
  await page.route(
    '**/api/governance/apps/quick-ticket/review-ticket',
    route => {
      const request = route.request();
      const url = [ticket, replacement, null][events.length - 1];
      expect(request.method()).toBe('PATCH');
      expect(request.postDataJSON()).toEqual({
        url,
        expectedUpdatedAt: current.updatedAt,
      });
      current = {
        ...app,
        reviewTicketUrl: url ?? undefined,
        updatedAt: new Date(Date.parse(current.updatedAt) + 1000).toISOString(),
      };
      events.push({
        digest: String(events.length).repeat(64),
        event: JSON.stringify({
          action: 'review-ticket-updated',
          actor: reviewer,
          record: current,
        }),
      });
      return route.fulfill({ json: current });
    },
  );
  await page.route('**/api/governance/apps/quick-ticket/history', route =>
    route.fulfill({ json: { events, keyEvents: [] } }),
  );

  await page.goto('/?app=quick-ticket');
  const details = page.getByRole('dialog', { name: app.name });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(details.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await details.getByText('Edit review ticket', { exact: true }).click();
  const url = details.getByRole('textbox', { name: 'Ticket URL', exact: true });
  const save = details.getByRole('button', { name: 'Save review ticket' });
  const open = details.getByRole('link', { name: 'Open review ticket' });

  await expect(url).toHaveValue('');
  await url.fill(ticket);
  await save.click();
  await expect(open).toHaveAttribute('href', ticket);
  await expect(details.getByText('Review ticket saved.')).toBeVisible();
  await details.getByText('Edit app details', { exact: true }).click();
  await expect(
    details.getByRole('textbox', { name: 'Review ticket URL', exact: true }),
  ).toHaveValue(ticket);

  await expect(save).toBeDisabled();
  await details.getByText('Edit app details', { exact: true }).click();
  await expect(save).toBeEnabled();
  await url.fill(replacement);
  await save.click();
  await expect(open).toHaveAttribute('href', replacement);
  await url.clear();
  await save.click();
  await expect(open).toHaveCount(0);
  await expect(details.getByText('Review ticket removed.')).toBeVisible();
  await expect(
    details.getByRole('combobox', { name: 'Lifecycle' }),
  ).toHaveValue('active');

  await details.getByText('Audit history', { exact: true }).click();
  await expect(
    details.getByText('Review ticket linked', { exact: true }),
  ).toBeVisible();
  await expect(
    details.getByText('Review ticket link updated', { exact: true }),
  ).toBeVisible();
  await expect(
    details.getByText('Review ticket link removed', { exact: true }),
  ).toBeVisible();
});

test('a backup owner can confirm handover when the app is eligible', async ({
  page,
}) => {
  const actor = 'user:default/backup';
  const replacement = 'user:default/replacement';
  const app = {
    id: 'backup-handover-app',
    name: 'Shared fulfilment app',
    owner: 'user:default/owner',
    backupOwner: actor,
    team: 'group:default/operations',
    purpose: 'Support fulfilment decisions.',
    platform: 'GitHub',
    sourceUrl: 'https://example.com/source',
    classification: 'internal',
    lifecycle: 'active',
    tier: 2,
    usesAiAtRuntime: false,
    models: [],
    reviewStatus: 'not required',
    nextReview: '2099-01-01T00:00:00.000Z',
    updatedAt: '2025-05-01T00:00:00.000Z',
  };
  let current = app;
  let available = false;
  let catalogUnavailable = true;

  await page.route('**/api/governance/apps', route =>
    route.fulfill({ json: { actor, canReview: false, apps: [current] } }),
  );
  await page.route(
    '**/api/governance/apps/backup-handover-app/backup-handover',
    route => {
      const request = route.request();
      if (request.method() === 'GET') {
        if (catalogUnavailable) return route.fulfill({ status: 503 });
        return route.fulfill({ json: { available, backupRequired: true } });
      }
      expect(available).toBe(true);
      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toEqual({
        backupOwner: replacement,
        expectedUpdatedAt: app.updatedAt,
      });
      current = {
        ...app,
        owner: actor,
        backupOwner: replacement,
        updatedAt: '2025-05-02T00:00:00.000Z',
        nextReview: '2025-05-02T00:00:00.000Z',
      };
      return route.fulfill({ json: current });
    },
  );

  await page.goto('/?app=backup-handover-app');
  const details = page.getByRole('dialog', { name: app.name });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(details.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  const handover = details.getByText('Backup owner handover', { exact: true });
  const take = details.getByRole('button', { name: 'Take ownership' });
  const unavailable = details.getByText(
    'Backup handover is unavailable for this app.',
  );
  await handover.click();
  await expect(details.getByRole('alert')).toHaveText(
    'Handover availability could not load.',
  );
  await expect(take).toHaveCount(0);
  catalogUnavailable = false;
  await details.getByRole('button', { name: 'Retry handover check' }).click();
  await expect(unavailable).toBeVisible();
  await expect(take).toHaveCount(0);
  await handover.click();
  await expect(unavailable).toHaveCount(0);
  available = true;
  await handover.click();

  await expect(
    details.getByText(/Any existing gateway key will be revoked/),
  ).toBeVisible();
  await expect(
    details.getByText('Your first owner attestation will be due immediately.'),
  ).toBeVisible();
  await expect(take).toBeDisabled();
  const backup = details.getByRole('textbox', {
    name: /Replacement backup owner/,
  });
  await expect(backup).toHaveAttribute('required', '');
  await backup.fill(replacement);
  await details
    .getByRole('checkbox', { name: 'I accept responsibility for this app.' })
    .check();
  await take.click();
  await expect(
    details.getByText('You are now the accountable owner.'),
  ).toBeVisible();
  await expect(handover).toHaveCount(0);
  await expect(
    details.getByText('Edit app details', { exact: true }),
  ).toBeVisible();
  await expect(details.getByText('Next review due 2025-05-02.')).toBeVisible();

  await page.reload();
  await expect(details.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(handover).toHaveCount(0);
  await expect(
    details.getByRole('button', { name: 'Record attestation' }),
  ).toBeVisible();
});

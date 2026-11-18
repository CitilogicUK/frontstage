import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { expect, test, type Page } from '@playwright/test';

const catalogPath =
  '/catalog?filters%5Bkind%5D=component&filters%5Buser%5D=all&limit=20';
const destinations = [
  { label: 'Inventory', heading: 'AI app inventory' },
  { label: 'Discovery', heading: 'App discovery' },
  { label: 'Reviews', heading: 'Critical app reviews' },
  { label: 'Reports', heading: 'Portfolio reports' },
  { label: 'Import', heading: 'Import existing apps' },
  { label: 'Templates', heading: 'App templates' },
  { label: 'Builder guide', heading: 'Builder guide' },
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
    'Catalog',
    'Discovery',
    'Reviews',
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

test('workspace screens share navigation and fit the viewport', async ({
  page,
  request,
}) => {
  await expect
    .poll(
      async () => {
        const health = await request
          .get('http://localhost:7007/.backstage/health/v1/readiness', {
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

  const navigation = page.getByRole('navigation', { name: 'AI governance' });
  for (const destination of destinations) {
    await navigation
      .getByRole('link', { name: destination.label, exact: true })
      .click();
    await assertWorkspace(page, destination.heading, destination.label);
  }

  await navigation.getByRole('link', { name: 'Reports', exact: true }).click();
  const coverage = page.locator('.gov-report-summary > div').filter({
    hasText: 'GitHub discovery coverage',
  });
  await expect(coverage).toContainText('50%');
  await expect(coverage).toContainText('Excludes dismissed repositories');
  await expect(coverage).toContainText('Partial scan results');
  await coverage.getByRole('link', { name: 'View Discovery queue' }).click();
  await expect(
    page.getByText(/1 of 2 tracked repositories registered.*50% coverage/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unowned 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismissed 1' })).toBeVisible();
  await page.route('**/api/governance/hosted-workspaces', route =>
    route.fulfill({
      json: {
        configured: true,
        workspaces: [{ provider: 'Example AI', workspace: 'Company sandbox' }],
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
  await expect(
    page.getByRole('region', { name: 'Approved provider workspaces' }),
  ).toContainText('Example AI · Company sandbox');
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
    expect(strFromU8(files[`${id}/CLAUDE.md`]).trim()).toBe('@AGENTS.md');
    expect(strFromU8(files[`${id}/AGENTS.md`])).toContain('Proof of concept');
    const brief = strFromU8(files[`${id}/PROJECT_BRIEF.md`]);
    expect(brief).toContain('Delivery stage: Proof of concept');
    expect(brief).toContain(
      usesAi
        ? 'calls models through the gateway'
        : 'No runtime model calls are planned',
    );
    const descriptor = strFromU8(files[`${id}/catalog-info.yaml`]);
    expect(descriptor).toContain('deliveryStage: poc');
    expect(descriptor).toContain(`usesAiAtRuntime: ${usesAi}`);
    expect(Boolean(files[`${id}/gateway.mjs`])).toBe(usesAi);
    expect(descriptor).toContain('classification: restricted');
    expect(descriptor).toContain('backupOwner: user:default/backup');
    expect(brief).toContain('Highest data classification: restricted');
    if (usesAi) {
      expect(brief).toContain('Configured model: `gpt-4.1-mini`');
      expect(descriptor).toContain('models: ["gpt-4.1-mini"]');
      expect(strFromU8(files[`${id}/gateway.mjs`])).toContain(
        'FRONTSTAGE_BACKEND_URL ?? "http://localhost:7007"',
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
    .getByRole('link', { name: 'Register from ai-assisted software' })
    .click();
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
  await navigation
    .getByRole('link', { name: 'Templates', exact: true })
    .click();

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

test('the owner inventory prioritizes upcoming and overdue reviews', async ({
  page,
}) => {
  const actor = 'user:default/demo-owner';
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
  const dateInDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString();
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor,
        canReview: false,
        gatewayEnabled: true,
        apps: [
          {
            ...base,
            id: 'current',
            name: 'Current app',
            platform: 'Hosted workspace & tools',
            effectiveClassification: 'confidential',
            lifecycle: 'deprecated',
            deliveryStage: 'poc',
            usesAiAtRuntime: false,
            models: [],
            nextReview: dateInDays(60),
          },
          {
            ...base,
            id: 'soon',
            name: 'Due soon app',
            models: ['gpt-4.1-mini', 'gpt-4.1-mini'],
            nextReview: dateInDays(15),
          },
          {
            ...base,
            id: 'overdue',
            name: 'Overdue app',
            deliveryStage: 'production',
            nextReview: dateInDays(-1),
          },
          {
            ...base,
            id: 'other',
            name: 'Another owner’s app',
            owner: 'user:default/another',
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
  await expect(rows.nth(1)).toContainText('Attestation due soon');
  await expect(rows.nth(2)).toContainText('Attestation current');
  const reviewStatus = page.getByRole('combobox', { name: 'Review status' });
  await page
    .getByRole('link', { name: '2 of your apps need review attention' })
    .click();
  await expect(reviewStatus).toHaveValue('attention');
  await expect(page).toHaveURL(/owner=me&review=attention$/);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Attestation overdue');
  await expect(rows.nth(1)).toContainText('Attestation due soon');
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
  const reminderPending = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download calendar reminder' })
    .click();
  const reminder = await reminderPending;
  expect(reminder.suggestedFilename()).toBe('frontstage-review.ics');
  const calendar = await readFile(await reminder.path(), 'utf8');
  expect(calendar).toContain('SUMMARY:App attestation: Overdue app');
  expect(calendar).toContain('URL:http://localhost:3000/?app=overdue');
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
  await expect(page).toHaveURL(/localhost:3000\/$/);
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
  await expect(rows.first()).toContainText('Overdue app');
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

test('audit history shows production review and ownership handoff', async ({
  page,
}) => {
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
            action: 'revoked',
            actor: pilot.owner,
            at: handoff.updatedAt,
            digest: 'a'.repeat(64),
          },
        ],
        events: [pilot, production, handoff, securityReview].map(
          (record, revision) => ({
            digest: String(revision).padStart(64, '0'),
            event: JSON.stringify({
              action: ['registered', 'updated', 'updated', 'reviewed'][
                revision
              ],
              actor: pilot.owner,
              record,
            }),
          }),
        ),
      },
    }),
  );
  await page.route('**/api/governance/reports/ownership', route =>
    route.fulfill({
      json: {
        issues:
          currentHandoff.owner === handoff.owner
            ? [
                {
                  appId: handoff.id,
                  name: handoff.name,
                  unavailable: [handoff.owner, handoff.team],
                  availableBackupOwner: pilot.owner,
                },
              ]
            : [],
      },
    }),
  );
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
            reason: 'review',
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
  await expect(dialog.getByText('Security: approved')).toBeVisible();
  await expect(
    dialog.getByText('Lifecycle changed to experimental', { exact: false }),
  ).toBeVisible();
  await expect(dialog.getByText('Overall review: pending')).toBeVisible();

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
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
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
  await windowSelect.selectOption('7');
  await expect(page).toHaveURL(/view=reports&days=7$/);
  await expect(page.getByText('No gateway calls recorded')).toBeVisible();
  await expect(page.getByText('Live estimated cost · 7 days')).toBeVisible();
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
  await expect(missingAppRow.getByRole('link')).toHaveCount(0);
  await procurement.getByRole('button').click();
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
  await page.getByRole('link', { name: '1 awaiting a first decision' }).click();
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
      `Accountable owner: ${handoff.owner} · Team: ${handoff.team}`,
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
    `"Accountable owner","${handoff.owner}","${pilot.owner}"`,
  );
  expect(ownershipCsv).toContain(`"Team","${handoff.team}","${pilot.owner}"`);
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
  await expect(page).toHaveURL(/view=reports$/);
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
  await expect(page).toHaveURL(/view=reports$/);
  await expect(
    retirementReview.getByText(
      'No apps match this gateway activity threshold.',
    ),
  ).toBeVisible();
});

test('a hosted app owner can correct the declared workspace', async ({
  page,
}) => {
  let app = {
    id: 'hosted-app',
    name: 'Hosted demo app',
    owner: 'user:default/demo-owner',
    team: 'group:default/platform',
    purpose: 'Synthetic demo',
    type: 'provider-hosted app',
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
  const original = app;
  await page.route('**/api/governance/apps/hosted-app/history', route =>
    route.fulfill({
      json: {
        keyEvents: [],
        events: [original, app].map((record, index) => ({
          digest: String(index).padStart(64, '0'),
          event: JSON.stringify({
            action: index === 0 ? 'registered' : 'updated',
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
        canReview: true,
        apps: [app],
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
      updatedAt: '2025-01-02T00:00:00.000Z',
    };
    return route.fulfill({ json: app });
  });
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
  await hostedIssues.getByRole('link', { name: app.name }).click();
  await expect(
    details.getByRole('link', { name: 'View approved workspaces (new tab)' }),
  ).toHaveAttribute('href', '/?view=guide#hosted-workspaces-title');

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

  await details.getByText('Audit history', { exact: true }).click();
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

test('Discovery refreshes after a stale dismissal', async ({ page }) => {
  let registered = false;
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
  await page.route('**/api/governance/discovery/github', route =>
    route.fulfill({
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
  await page.getByText('Dismiss repository', { exact: true }).click();
  await page.getByLabel('Dismissal reason').fill('Not an app');
  await page.getByRole('button', { name: 'Confirm dismissal' }).click();
  await expect(page.getByRole('alert')).toContainText('no longer available');
  await expect(page.getByRole('button', { name: 'Unowned 0' })).toBeVisible();
  await page.getByRole('button', { name: 'Registered 1' }).click();
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
  await expect(page.getByRole('dialog', { name: app.name })).toBeVisible();
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
  let current: typeof app | typeof grantedApp = app;
  let actor = reviewer;
  let split = false;
  await page.route('**/api/governance/apps', route =>
    route.fulfill({
      json: {
        actor,
        canReview: true,
        reviewTracks: split ? ['security', 'dataProtection'] : [],
        reviewerTracks: split ? ['security'] : [],
        apps: [current],
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
  await revoke.click();
  await expect(details.getByText('Renewal exception revoked.')).toBeVisible();
  await expect(grant).toBeVisible();

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
      json: { actor, canReview: actor === reviewer, apps: [current] },
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

  actor = app.owner;
  await page.goto('/');
  await expect(
    page.getByText('Retirement decision requested').or(guest),
  ).toBeVisible();
  if (await guest.isVisible()) await guest.click();
  await expect(page.getByText('Retirement decision requested')).toBeVisible();
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

import { setTimeout as delay } from 'node:timers/promises';

function localPort(variable, fallback) {
  const port = Number(process.env[variable] ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Set ${variable} to a valid local port.`);
  return port;
}

const appPort = localPort('FRONTSTAGE_DEMO_APP_PORT', 3000);
const backendPort = localPort('FRONTSTAGE_DEMO_BACKEND_PORT', 7007);
const origin = `http://localhost:${appPort}`;
const backend = `http://localhost:${backendPort}`;
const governance = `${backend}/api/governance`;
const demoOwner = 'user:default/guest';

const identity = await fetch(`${backend}/api/auth/guest/refresh`, {
  headers: { Origin: origin, 'X-Requested-With': 'XMLHttpRequest' },
});
if (!identity.ok)
  throw new Error('Start Backstage with the local reviewer profile first.');
const { backstageIdentity } = await identity.json();
const token = backstageIdentity?.token;
if (!token)
  throw new Error('Backstage did not return local reviewer credentials.');

async function request(path, body) {
  const response = await fetch(`${governance}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body && JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message ?? `HTTP ${response.status}`);
  return result;
}

const { apps, actor, canReview } = await request('/apps');
if (!canReview || !actor || actor === demoOwner)
  throw new Error(
    'Restart Backstage with app-config.reviewer.yaml and a reviewer identity other than the demo app owner.',
  );
async function waitForDemoCatalog() {
  const refs = [
    'user/default/guest',
    'user/default/backup',
    'group/default/platform',
  ];
  const deadline = Date.now() + 30_000;
  while (true) {
    const pending = [];
    for (const ref of refs) {
      const response = await fetch(
        `${backend}/api/catalog/entities/by-name/${ref}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3_000),
        },
      );
      await response.body?.cancel();
      if (response.status === 404) pending.push(ref);
      else if (!response.ok)
        throw new Error(
          `Catalog lookup for ${ref} failed (HTTP ${response.status}).`,
        );
    }
    if (!pending.length) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Demo catalog entries were not ready: ${pending.join(', ')}.`,
      );
    await delay(500);
  }
}

await waitForDemoCatalog();

const base = {
  type: 'assistant',
  platform: 'Code repo',
  owner: demoOwner,
  team: 'group:default/platform',
  models: ['gpt-4.1-mini', 'gpt-4.1-nano'],
  audience: 'personal',
};
const software = { ...base, type: 'app', usesAiAtRuntime: false, models: [] };
const scenarios = [
  {
    ...software,
    name: 'Stock count proof of concept',
    purpose:
      'Reconciles synthetic inventory spreadsheets without calling models.',
    sourceUrl: 'https://example.com/frontstage-demo/stock-count',
    classification: 'internal',
    deliveryStage: 'poc',
    lifecycle: 'experimental',
  },
  {
    ...software,
    name: 'Purchase order pilot',
    purpose:
      'Demonstrates submitting purchase orders to a sandbox without calling models.',
    sourceUrl: 'https://example.com/frontstage-demo/purchase-orders',
    classification: 'internal',
    deliveryStage: 'pilot',
    lifecycle: 'experimental',
    backupOwner: 'user:default/backup',
    takesActions: true,
    actionDescription: 'Submits synthetic purchase orders to a sandbox.',
  },
  {
    ...base,
    name: 'Meeting summary demo',
    purpose: 'Summarizes synthetic notes from an internal meeting.',
    sourceUrl: 'https://example.com/frontstage-demo/meeting-summary',
    classification: 'internal',
    deliveryStage: 'pilot',
    lifecycle: 'active',
  },
  {
    ...base,
    name: 'Restricted intake demo',
    purpose: 'Classifies a synthetic submission in a restricted-data workflow.',
    sourceUrl: 'https://example.com/frontstage-demo/restricted-intake',
    classification: 'restricted',
    deliveryStage: 'trial',
    backupOwner: 'user:default/backup',
    lifecycle: 'experimental',
  },
  {
    ...base,
    name: 'Hosted workspace demo',
    purpose:
      'Demonstrates declared provider workspace checks with synthetic data.',
    type: 'provider-hosted app',
    platform: 'Hosted workspace & tools',
    sourceUrl: 'https://example.com/frontstage-demo/hosted-workspace',
    classification: 'internal',
    deliveryStage: 'trial',
    lifecycle: 'experimental',
    hosted: {
      provider: 'Example AI',
      workspace: 'Personal sandbox',
      sharing: 'private',
      dataAccess: 'none',
    },
  },
];

for (const scenario of scenarios) {
  const existing = apps.find(app => app.sourceUrl === scenario.sourceUrl);
  const record = existing ?? (await request('/apps', scenario));
  console.log(
    `${record.name} — Tier ${record.tier}, ${record.lifecycle}, review ${record.reviewStatus}`,
  );
}

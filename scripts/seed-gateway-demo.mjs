const origin = 'http://localhost:3000';
const backend = 'http://localhost:7007';
const governance = `${backend}/api/governance`;

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

const { apps, canReview } = await request('/apps');
if (!canReview)
  throw new Error(
    'Restart Backstage with app-config.reviewer.yaml to seed the demo scenarios.',
  );
const base = {
  type: 'assistant',
  platform: 'Code repo',
  owner: 'user:default/guest',
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
];

for (const scenario of scenarios) {
  const existing = apps.find(app => app.sourceUrl === scenario.sourceUrl);
  const record = existing ?? (await request('/apps', scenario));
  console.log(
    `${record.name} — Tier ${record.tier}, ${record.lifecycle}, review ${record.reviewStatus}`,
  );
}

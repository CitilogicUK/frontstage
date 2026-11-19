import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const script = fileURLToPath(new URL('./catalog-mcp.mjs', import.meta.url));
const token = 'synthetic-governance-token';

const hiddenFields = {
  reviewTicketUrl: 'https://example.invalid/sensitive-ticket',
  reviewNotes: 'Sensitive approval notes',
  evidence: { tests: 'https://example.invalid/sensitive-evidence' },
  riskAssessment: { tier: 3, reasons: ['sensitive-reason'] },
  apiKey: 'never-include-this-key',
};

const records = [
  {
    id: 'order-workflow',
    name: 'Order workflow',
    purpose: 'Review synthetic warehouse orders',
    type: 'app',
    platform: 'GitHub',
    owner: 'user:default/owner',
    team: 'group:default/operations',
    lifecycle: 'active',
    classification: 'internal',
    tier: 2,
    reviewStatus: 'not required',
    usesAiAtRuntime: false,
    models: [],
    ...hiddenFields,
  },
  {
    id: 'staff-handbook',
    name: 'Staff handbook',
    purpose: 'Find guidance for synthetic staff',
    type: 'app',
    platform: 'GitHub',
    owner: 'user:default/owner',
    team: 'group:default/operations',
    lifecycle: 'experimental',
    classification: 'internal',
    tier: 1,
    reviewStatus: 'not required',
    usesAiAtRuntime: false,
    models: [],
  },
];

function assertPrivateFieldsAbsent(result) {
  const serialized = JSON.stringify(result);
  for (const key of Object.keys(hiddenFields))
    assert.ok(!serialized.includes(key), `Unexpected exposed field: ${key}`);
  for (const value of [
    hiddenFields.reviewTicketUrl,
    hiddenFields.reviewNotes,
    hiddenFields.evidence.tests,
    hiddenFields.apiKey,
    token,
  ])
    assert.ok(!serialized.includes(value), 'Unexpected exposed fixture secret');
}

test(
  'catalog MCP tools read a scoped API and return only the public summary',
  { timeout: 15_000 },
  async () => {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({
        path: request.url,
        method: request.method,
        bearer: request.headers.authorization,
      });
      response.setHeader('Content-Type', 'application/json');
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401);
        response.end(JSON.stringify({ message: 'Authorization required' }));
        return;
      }
      switch (request.url) {
        case '/workspace/api/governance/apps':
          response.end(
            JSON.stringify({ apps: records, internal: hiddenFields }),
          );
          break;
        case '/workspace/api/governance/apps/order-workflow':
          response.end(JSON.stringify(records[0]));
          break;
        case '/workspace/api/governance/apps/denied':
          response.writeHead(403);
          response.end(JSON.stringify({ message: hiddenFields.reviewNotes }));
          break;
        case '/workspace/api/governance/apps/unavailable':
          response.writeHead(503);
          response.end(JSON.stringify({ message: hiddenFields.reviewNotes }));
          break;
        case '/workspace/api/governance/apps/redirected':
          response.writeHead(302, { Location: '/redirect-target' });
          response.end();
          break;
        default:
          response.writeHead(404);
          response.end(JSON.stringify({ message: hiddenFields.reviewNotes }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [script],
      env: {
        FRONTSTAGE_MCP_BACKEND_URL: `http://127.0.0.1:${
          server.address().port
        }/workspace`,
        FRONTSTAGE_MCP_TOKEN: token,
      },
    });
    const client = new Client({ name: 'catalog-smoke-test', version: '1.0.0' });
    const call = (name, args) => client.callTool({ name, arguments: args });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(tool => tool.name).sort(), [
        'get_app',
        'search_apps',
      ]);

      const search = await call('search_apps', {
        query: 'ORDER',
        limit: 1,
      });
      assert.equal(search.isError ?? false, false);
      assert.deepEqual(
        search.structuredContent.apps.map(app => app.id),
        ['order-workflow'],
      );
      assert.deepEqual(
        JSON.parse(search.content[0].text),
        search.structuredContent,
      );
      assertPrivateFieldsAbsent(search);

      const detail = await call('get_app', { id: 'order-workflow' });
      assert.equal(detail.isError ?? false, false);
      assert.deepEqual(detail.structuredContent.app, {
        id: 'order-workflow',
        name: 'Order workflow',
        type: 'app',
        platform: 'GitHub',
        owner: 'user:default/owner',
        team: 'group:default/operations',
        lifecycle: 'active',
        classification: 'internal',
        tier: 2,
        reviewStatus: 'not required',
        usesAiAtRuntime: false,
      });
      assertPrivateFieldsAbsent(detail);

      const beforeInvalidInput = requests.length;
      const invalidLimit = await call('search_apps', { limit: 51 });
      assert.equal(invalidLimit.isError, true);
      const invalidId = await call('get_app', { id: '../order-workflow' });
      assert.equal(invalidId.isError, true);
      assert.equal(requests.length, beforeInvalidInput);

      const missing = await call('get_app', { id: 'missing' });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /App not found/);
      assertPrivateFieldsAbsent(missing);

      const denied = await call('get_app', { id: 'denied' });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /Frontstage authentication failed/);
      assertPrivateFieldsAbsent(denied);

      const unavailable = await call('get_app', { id: 'unavailable' });
      assert.equal(unavailable.isError, true);
      assert.match(unavailable.content[0].text, /503/);
      assertPrivateFieldsAbsent(unavailable);

      const redirected = await call('get_app', { id: 'redirected' });
      assert.equal(redirected.isError, true);
      assert.match(redirected.content[0].text, /unexpected redirect/);
      assert.deepEqual(
        requests.map(request => request.path),
        [
          '/workspace/api/governance/apps',
          '/workspace/api/governance/apps/order-workflow',
          '/workspace/api/governance/apps/missing',
          '/workspace/api/governance/apps/denied',
          '/workspace/api/governance/apps/unavailable',
          '/workspace/api/governance/apps/redirected',
        ],
      );
      assert.ok(
        requests.every(
          request =>
            request.method === 'GET' && request.bearer === `Bearer ${token}`,
        ),
      );
    } finally {
      try {
        await client.close();
      } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve())),
        );
      }
    }
  },
);

test('catalog MCP refuses a plaintext remote backend without exposing the token', () => {
  const child = spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      FRONTSTAGE_MCP_BACKEND_URL: 'http://example.invalid',
      FRONTSTAGE_MCP_TOKEN: token,
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /HTTPS/i);
  assert.ok(!child.stderr.includes(token));
});

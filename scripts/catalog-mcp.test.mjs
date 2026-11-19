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
    const riskRequests = [];
    const riskAssessment = {
      tier: 3,
      reasons: ['takes-actions'],
      effectiveClassification: 'confidential',
    };
    const models = [
      {
        id: 'example-basic',
        allowedClassifications: ['public', 'internal'],
        maxCompletionTokens: 1_024,
      },
      {
        id: 'example-restricted',
        allowedClassifications: ['public', 'internal', 'restricted'],
        maxCompletionTokens: 2_048,
      },
    ];
    const connectors = [
      {
        id: 'mcp-internal',
        name: 'Internal MCP',
        kind: 'mcp',
        description: 'Read internal fixture records.',
        access: 'read',
        maxClassification: 'internal',
      },
      {
        id: 'mcp-restricted',
        name: 'Restricted MCP',
        kind: 'mcp',
        description: 'Read restricted fixture records.',
        access: 'read',
        maxClassification: 'restricted',
        docsUrl: 'https://example.invalid/connectors/restricted-mcp',
      },
      {
        id: 'data-restricted',
        name: 'Restricted data',
        kind: 'data',
        description: 'Write restricted fixture records.',
        access: 'write',
        maxClassification: 'restricted',
      },
    ];
    const server = createServer(async (request, response) => {
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
        case '/workspace/api/governance/approved-connectors':
          response.end(
            JSON.stringify({
              configured: true,
              ...hiddenFields,
              connectors: connectors.map(connector => ({
                ...connector,
                ...hiddenFields,
              })),
            }),
          );
          break;
        case '/workspace/api/governance/gateway/models':
          response.end(
            JSON.stringify({
              enabled: true,
              productionAvailable: false,
              ...hiddenFields,
              models: models.map(model => ({ ...model, ...hiddenFields })),
            }),
          );
          break;
        case '/workspace/api/governance/tier-preview': {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          riskRequests.push({
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            contentType: request.headers['content-type'],
          });
          response.end(JSON.stringify({ ...riskAssessment, ...hiddenFields }));
          break;
        }
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
        'list_approved_connectors',
        'list_approved_models',
        'preview_risk',
        'search_apps',
      ]);
      const riskInput = {
        audience: 'team',
        classification: 'internal',
        takesActions: true,
        connections: [{ access: 'write' }],
        hosted: { sharing: 'private', dataClassification: 'confidential' },
      };
      const invalidRisk = await call('preview_risk', {
        ...riskInput,
        classification: 'not-a-classification',
      });
      assert.equal(invalidRisk.isError, true);
      assert.deepEqual(requests, []);
      const risk = await call('preview_risk', riskInput);
      assert.equal(risk.isError ?? false, false);
      assert.deepEqual(risk.structuredContent, riskAssessment);
      assert.deepEqual(JSON.parse(risk.content[0].text), riskAssessment);
      assertPrivateFieldsAbsent(risk);
      assert.deepEqual(riskRequests, [
        { body: riskInput, contentType: 'application/json' },
      ]);
      const invalidModels = await call('list_approved_models', {
        classification: 'secret',
      });
      assert.equal(invalidModels.isError, true);
      assert.equal(requests.length, 1);
      for (const [args, expected] of [
        [{}, models],
        [{ classification: 'restricted' }, [models[1]]],
      ]) {
        const listed = await call('list_approved_models', args);
        assert.equal(listed.isError ?? false, false);
        assert.deepEqual(listed.structuredContent, {
          enabled: true,
          productionAvailable: false,
          models: expected,
        });
        assert.deepEqual(
          JSON.parse(listed.content[0].text),
          listed.structuredContent,
        );
        assertPrivateFieldsAbsent(listed);
      }
      const invalidConnectors = await call('list_approved_connectors', {
        kind: 'invalid',
      });
      assert.equal(invalidConnectors.isError, true);
      assert.equal(requests.length, 3);
      for (const [args, expected] of [
        [{}, connectors],
        [{ kind: 'mcp', classification: 'confidential' }, [connectors[1]]],
      ]) {
        const listed = await call('list_approved_connectors', args);
        assert.equal(listed.isError ?? false, false);
        assert.deepEqual(listed.structuredContent, {
          configured: true,
          connectors: expected,
        });
        assert.deepEqual(
          JSON.parse(listed.content[0].text),
          listed.structuredContent,
        );
        assertPrivateFieldsAbsent(listed);
      }

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
          '/workspace/api/governance/tier-preview',
          '/workspace/api/governance/gateway/models',
          '/workspace/api/governance/gateway/models',
          '/workspace/api/governance/approved-connectors',
          '/workspace/api/governance/approved-connectors',
          '/workspace/api/governance/apps',
          '/workspace/api/governance/apps/order-workflow',
          '/workspace/api/governance/apps/missing',
          '/workspace/api/governance/apps/denied',
          '/workspace/api/governance/apps/unavailable',
          '/workspace/api/governance/apps/redirected',
        ],
      );
      assert.deepEqual(
        requests.map(request => request.method),
        ['POST', ...Array(10).fill('GET')],
      );
      assert.ok(
        requests.every(request => request.bearer === `Bearer ${token}`),
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

test(
  'catalog MCP explicitly opts in to previewing and registering bounded descriptors',
  { timeout: 15_000 },
  async () => {
    const content = 'kind: AIApp\nspec:\n  name: Order workflow\n';
    const requests = [];
    const previewApp = {
      name: records[0].name,
      tier: records[0].tier,
      owner: records[0].owner,
      team: records[0].team,
      starterId: 'internal-api',
    };
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        path: request.url,
        method: request.method,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.setHeader('Content-Type', 'application/json');
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401);
        response.end('{}');
      } else if (
        request.url === '/workspace/api/governance/repository?dryRun=true'
      ) {
        response.end(
          JSON.stringify({ apps: [{ ...previewApp, ...hiddenFields }] }),
        );
      } else if (requests.length === 2) {
        response.writeHead(201);
        response.end(
          JSON.stringify({ ...records[0], starterId: 'internal-api' }),
        );
      } else {
        response.writeHead(409);
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
        FRONTSTAGE_MCP_WRITE_ENABLED: 'true',
      },
    });
    const client = new Client({ name: 'catalog-write-test', version: '1.0.0' });
    const call = (name, args) => client.callTool({ name, arguments: args });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(tool => tool.name).sort(), [
        'get_app',
        'list_approved_connectors',
        'list_approved_models',
        'preview_descriptor',
        'preview_risk',
        'register_descriptor',
        'search_apps',
      ]);
      for (const name of ['preview_descriptor', 'register_descriptor']) {
        const { inputSchema } = tools.find(tool => tool.name === name);
        assert.equal(inputSchema.properties.content.type, 'string');
        assert.deepEqual(inputSchema.required, ['content']);
        const empty = await call(name, { content: '' });
        assert.equal(empty.isError, true);
        const oversized = await call(name, { content: 'é'.repeat(32_769) });
        assert.equal(oversized.isError, true);
      }
      assert.equal(requests.length, 0);

      const preview = await call('preview_descriptor', { content });
      assert.equal(preview.isError ?? false, false);
      assert.deepEqual(preview.structuredContent, { apps: [previewApp] });
      assert.deepEqual(
        JSON.parse(preview.content[0].text),
        preview.structuredContent,
      );
      assertPrivateFieldsAbsent(preview);
      assert.equal(requests.length, 1);

      const registration = await call('register_descriptor', { content });
      assert.equal(registration.isError ?? false, false);
      assert.equal(registration.structuredContent.app.id, records[0].id);
      assert.equal(
        registration.structuredContent.app.starterId,
        'internal-api',
      );
      assertPrivateFieldsAbsent(registration);

      const conflict = await call('register_descriptor', { content });
      assert.equal(conflict.isError, true);
      assert.match(conflict.content[0].text, /conflicting app registration/);
      assertPrivateFieldsAbsent(conflict);
      assert.deepEqual(
        requests,
        [
          '/workspace/api/governance/repository?dryRun=true',
          '/workspace/api/governance/repository',
          '/workspace/api/governance/repository',
        ].map(path => ({
          path,
          method: 'POST',
          authorization: `Bearer ${token}`,
          contentType: 'application/json',
          body: { content },
        })),
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

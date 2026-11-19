import assert from 'node:assert/strict';
import { once } from 'node:events';
// eslint-disable-next-line no-restricted-imports -- The standalone starter uses Node's test runner.
import { after, before, test } from 'node:test';
import { createInternalApi } from './server.mjs';

const server = createInternalApi();
let baseUrl;

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  const closed = once(server, 'close');
  server.close();
  await closed;
});

test('GET /healthz returns JSON health status', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-type'),
    'application/json; charset=utf-8',
  );
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('GET /api/status returns synthetic service status', async () => {
  const response = await fetch(`${baseUrl}/api/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    service: 'internal-api',
    status: 'ready',
    data: 'synthetic',
  });
});

test('rejects unsupported methods on known routes', async () => {
  const response = await fetch(`${baseUrl}/api/status`, { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.deepEqual(await response.json(), { error: 'Method not allowed.' });
});

test('rejects unknown routes', async () => {
  const response = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Not found.' });
});

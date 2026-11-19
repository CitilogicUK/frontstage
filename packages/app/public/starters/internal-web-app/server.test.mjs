import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
// eslint-disable-next-line no-restricted-imports -- The standalone starter uses Node's test runner.
import { after, before, test } from 'node:test';
import { createInternalWebApp } from './server.mjs';

const server = createInternalWebApp();
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

test('renders the equipment inventory with local assets and security headers', async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-type'),
    'text/html; charset=utf-8',
  );
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  const html = await response.text();
  assert.match(html, /<h1>Equipment availability<\/h1>/);
  assert.match(html, /Sample inventory/);
  assert.match(html, /6 of 6 shown/);
  assert.match(html, /href="\/styles\.css"/);

  const cssResponse = await fetch(`${baseUrl}/styles.css`);
  assert.equal(cssResponse.status, 200);
  assert.equal(
    cssResponse.headers.get('content-type'),
    'text/css; charset=utf-8',
  );
  assert.match(await cssResponse.text(), /prefers-reduced-motion/);
});

test('combines search and status filters', async () => {
  const response = await fetch(`${baseUrl}/?q=Recording&status=maintenance`);
  const html = await response.text();
  assert.match(html, /1 of 6 shown/);
  assert.match(html, /Wireless microphone/);
  assert.doesNotMatch(html, /Tripod and phone mount/);
  assert.match(html, /value="maintenance" selected/);
  assert.match(html, /href="\/">Clear filters/);
});

test('shows an empty state and escapes search text in HTML', async () => {
  const raw = '<img src=x onerror="alert(1)">';
  const search = new URLSearchParams({ q: raw });
  const response = await fetch(`${baseUrl}/?${search}`);
  const html = await response.text();
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /No equipment matches your filters/);
});

test('serves health status and rejects writes and unknown paths', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });

  const write = await fetch(baseUrl, { method: 'POST' });
  assert.equal(write.status, 405);
  assert.equal(write.headers.get('allow'), 'GET');
  await write.text();

  const unknown = await fetch(`${baseUrl}/missing`);
  assert.equal(unknown.status, 404);
  await unknown.text();
});

test('rejects a non-loopback Host header', async () => {
  const status = await new Promise((resolve, reject) => {
    get(baseUrl, { headers: { Host: 'external.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 400);
});

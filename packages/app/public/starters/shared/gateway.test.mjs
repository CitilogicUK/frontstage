import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
// eslint-disable-next-line no-restricted-imports -- The standalone starter uses Node's test runner.
import { test } from 'node:test';
import { readText, runModel } from './gateway.mjs';

test('gateway requests stay within the configured endpoint and propagate failures', async t => {
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    FRONTSTAGE_GATEWAY_KEY: 'synthetic-test-key',
    FRONTSTAGE_BACKEND_URL: 'http://127.0.0.1:7007/frontstage',
    FRONTSTAGE_MODEL: 'test-model',
  };
  t.after(() => {
    process.env = originalEnv;
  });

  const request = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ output: 'Synthetic answer' }),
  );
  assert.equal(await runModel('Synthetic prompt'), 'Synthetic answer');
  const [url, options] = request.mock.calls[0].arguments;
  assert.equal(
    url.href,
    'http://127.0.0.1:7007/frontstage/api/governance/gateway/chat',
  );
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-test-key');
  assert.deepEqual(JSON.parse(options.body), {
    model: 'test-model',
    prompt: 'Synthetic prompt',
  });

  request.mock.mockImplementation(async () =>
    Response.json({ error: { message: 'Model unavailable' } }, { status: 503 }),
  );
  await assert.rejects(runModel('Synthetic prompt'), /Model unavailable/);
  request.mock.mockImplementation(async () => Response.json({ output: 42 }));
  await assert.rejects(
    runModel('Synthetic prompt'),
    /did not return a model response/,
  );

  await assert.rejects(runModel('   '), /Supply a prompt/);
  assert.equal(request.mock.callCount(), 3);

  process.env.FRONTSTAGE_BACKEND_URL = 'http://example.invalid';
  await assert.rejects(
    runModel('Synthetic prompt'),
    /HTTPS Frontstage backend URL/,
  );
  assert.equal(request.mock.callCount(), 3);
});

test('input is trimmed and rejects blank or oversized streams', async () => {
  assert.equal(await readText(Readable.from(['  one', ' two  '])), 'one two');
  await assert.rejects(readText(Readable.from(['  '])), /Enter some text/);
  await assert.rejects(readText(Readable.from(['12', '34']), 3), /at most 3/);
});

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
  delete process.env.FRONTSTAGE_GATEWAY_ENVIRONMENT;
  delete process.env.FRONTSTAGE_GATEWAY_TIMEOUT_MS;
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
    expectedEnvironment: 'sandbox',
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

  process.env.FRONTSTAGE_GATEWAY_ENVIRONMENT = 'invalid';
  await assert.rejects(runModel('Synthetic prompt'), /sandbox or production/);
  assert.equal(request.mock.callCount(), 3);

  process.env.FRONTSTAGE_GATEWAY_ENVIRONMENT = 'production';
  request.mock.mockImplementation(async () =>
    Response.json({ output: 'Synthetic answer' }),
  );
  await runModel('Synthetic prompt');
  const [, productionOptions] = request.mock.calls[3].arguments;
  assert.equal(
    JSON.parse(productionOptions.body).expectedEnvironment,
    'production',
  );

  process.env.FRONTSTAGE_BACKEND_URL = 'http://example.invalid';
  await assert.rejects(
    runModel('Synthetic prompt'),
    /HTTPS Frontstage backend URL/,
  );
  assert.equal(request.mock.callCount(), 4);

  process.env.FRONTSTAGE_BACKEND_URL = 'http://127.0.0.1:7007/frontstage';
  process.env.FRONTSTAGE_GATEWAY_TIMEOUT_MS = '70000';
  const deadline = t.mock.method(AbortSignal, 'timeout', () =>
    AbortSignal.abort(),
  );
  request.mock.mockImplementation(async (_endpoint, init) => {
    init.signal.throwIfAborted();
  });
  await assert.rejects(
    runModel('Synthetic prompt'),
    /gateway request timed out/,
  );
  assert.deepEqual(deadline.mock.calls[0].arguments, [70000]);
  assert.equal(request.mock.callCount(), 5);
  deadline.mock.restore();

  process.env.FRONTSTAGE_GATEWAY_TIMEOUT_MS = 'invalid';
  await assert.rejects(
    runModel('Synthetic prompt'),
    /integer from 1000 to 120000/,
  );
  assert.equal(request.mock.callCount(), 5);

  delete process.env.FRONTSTAGE_GATEWAY_TIMEOUT_MS;
  const reference = '12345678-1234-4123-8123-123456789abc';
  request.mock.mockImplementation(async () =>
    Response.json(
      { error: { message: 'Model unavailable.' } },
      {
        status: 503,
        headers: {
          'Retry-After': '12',
          'X-Frontstage-Request-Id': reference,
        },
      },
    ),
  );
  await assert.rejects(runModel('Synthetic prompt'), {
    message: `Model unavailable. Wait 12 seconds before trying again. Support reference ${reference}.`,
  });
  assert.equal(request.mock.callCount(), 6);

  for (const [status, header] of [
    [503, 'invalid-reference'],
    [429, reference],
  ]) {
    request.mock.mockImplementation(async () =>
      Response.json(
        { error: { message: 'Gateway unavailable.' } },
        { status, headers: { 'X-Frontstage-Request-Id': header } },
      ),
    );
    await assert.rejects(runModel('Synthetic prompt'), {
      message: 'Gateway unavailable.',
    });
  }
});

test('input is trimmed and rejects blank or oversized streams', async () => {
  assert.equal(await readText(Readable.from(['  one', ' two  '])), 'one two');
  await assert.rejects(readText(Readable.from(['  '])), /Enter some text/);
  await assert.rejects(readText(Readable.from(['12', '34']), 3), /at most 3/);
});

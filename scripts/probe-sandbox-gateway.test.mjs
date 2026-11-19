import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(
  new URL('./probe-sandbox-gateway.mjs', import.meta.url),
);
const run = promisify(execFile);
const key = 'synthetic-sandbox-key-for-testing';
const model = 'fixture-model';
const responseBody = 'synthetic response body that must stay out of output';

async function mockGateway(t, respond) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      path: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    respond(response, requests.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    probe: (targets = {}) =>
      run(process.execPath, [script], {
        env: {
          ...process.env,
          FRONTSTAGE_PROBE_URL: origin,
          FRONTSTAGE_PROBE_SANDBOX_KEY: key,
          FRONTSTAGE_PROBE_MODEL: model,
          FRONTSTAGE_PROBE_SAMPLES: '3',
          FRONTSTAGE_PROBE_MAX_CLIENT_P95_MS: undefined,
          FRONTSTAGE_PROBE_MAX_FRONTSTAGE_P95_MS: undefined,
          ...targets,
        },
        timeout: 8_000,
      }),
  };
}

function respondWithCompletion(
  response,
  timing,
  simulated = true,
  replyModel = model,
) {
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Server-Timing': timing,
  });
  response.end(
    JSON.stringify({ model: replyModel, simulated, output: responseBody }),
  );
}

function assertRedacted(...messages) {
  const output = messages.join('\n');
  assert.ok(!output.includes(key), 'Probe output included the sandbox key');
  assert.ok(
    !output.includes(responseBody),
    'Probe output included the response body',
  );
}

async function assertProbeFailure(probe) {
  await assert.rejects(probe, error => {
    assert.equal(typeof error.code, 'number');
    assert.notEqual(error.code, 0);
    assert.ok(error.stderr.trim(), 'Probe should explain the failure');
    assertRedacted(error.stdout, error.stderr);
    return true;
  });
}

test('sandbox probe reports client and Frontstage percentiles from simulated requests', async t => {
  const durations = [5, 20, 20];
  const { requests, probe } = await mockGateway(t, (response, count) => {
    respondWithCompletion(response, `frontstage;dur=${durations[count - 1]}`);
  });

  const { stdout, stderr } = await probe();
  assertRedacted(stdout, stderr);
  const result = JSON.parse(stdout);
  assert.deepEqual(result, {
    samples: 3,
    clientMilliseconds: result.clientMilliseconds,
    frontstageMilliseconds: { p50: 20, p95: 20, max: 20 },
  });
  const { p50, p95, max } = result.clientMilliseconds;
  assert.ok(
    [p50, p95, max].every(value => Number.isFinite(value) && value >= 0),
  );
  assert.ok(p50 <= p95 && p95 <= max);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.path, '/api/governance/gateway/chat');
    assert.equal(request.method, 'POST');
    assert.equal(request.authorization, `Bearer ${key}`);
    const body = JSON.parse(request.body);
    assert.equal(body.model, model);
    assert.equal(body.expectedEnvironment, 'sandbox');
  }
});

for (const [failure, respond] of [
  [
    'rate limit',
    response => {
      response.writeHead(429);
      response.end(responseBody);
    },
  ],
  [
    'invalid timing',
    response => respondWithCompletion(response, 'frontstage;dur=invalid'),
  ],
  [
    'duplicate timing',
    response =>
      respondWithCompletion(response, 'frontstage;dur=3, frontstage;dur=9'),
  ],
  [
    'provider timing',
    response =>
      respondWithCompletion(response, 'frontstage;dur=3, provider;dur=9'),
  ],
  [
    'live response',
    response => respondWithCompletion(response, 'frontstage;dur=3', false),
  ],
  [
    'unexpected model',
    response =>
      respondWithCompletion(
        response,
        'frontstage;dur=3',
        true,
        'unexpected-model',
      ),
  ],
]) {
  test(`sandbox probe fails fast on ${failure} and redacts credentials and body`, async t => {
    const { requests, probe } = await mockGateway(t, respond);
    await assertProbeFailure(probe);
    assert.equal(requests.length, 1);
  });
}

test('sandbox probe rejects a redirect without sending a follow-up request', async t => {
  const { requests, probe } = await mockGateway(t, (response, count) => {
    if (count > 1) {
      respondWithCompletion(response, 'frontstage;dur=5');
      return;
    }
    response.writeHead(307, { Location: '/redirect-target' });
    response.end(responseBody);
  });
  await assertProbeFailure(probe);
  assert.deepEqual(
    requests.map(request => request.path),
    ['/api/governance/gateway/chat'],
  );
});

test('sandbox probe reports configured targets and passes at the exact limit', async t => {
  const { requests, probe } = await mockGateway(t, response => {
    respondWithCompletion(response, 'frontstage;dur=20');
  });
  const { stdout, stderr } = await probe({
    FRONTSTAGE_PROBE_MAX_CLIENT_P95_MS: '60000',
    FRONTSTAGE_PROBE_MAX_FRONTSTAGE_P95_MS: '20',
  });
  const report = JSON.parse(stdout);
  assert.equal(report.frontstageMilliseconds.p95, 20);
  assert.deepEqual(report.targets, {
    clientP95MaxMs: 60_000,
    frontstageP95MaxMs: 20,
    passed: true,
  });
  assertRedacted(stdout, stderr);
  assert.equal(requests.length, 3);
});

test('sandbox probe exits 2 with a completed report when a target is exceeded', async t => {
  const { requests, probe } = await mockGateway(t, response => {
    respondWithCompletion(response, 'frontstage;dur=20');
  });
  await assert.rejects(
    probe({ FRONTSTAGE_PROBE_MAX_FRONTSTAGE_P95_MS: '19' }),
    error => {
      assert.equal(error.code, 2);
      assert.ok(error.stderr.trim());
      const report = JSON.parse(error.stdout);
      assert.equal(report.samples, 3);
      assert.equal(report.frontstageMilliseconds.p95, 20);
      assert.deepEqual(report.targets, {
        frontstageP95MaxMs: 19,
        passed: false,
      });
      assertRedacted(error.stdout, error.stderr);
      return true;
    },
  );
  assert.equal(requests.length, 3);
});

test('sandbox probe validates targets before attempting a request', async t => {
  const { requests, probe } = await mockGateway(t, response => {
    respondWithCompletion(response, 'frontstage;dur=20');
  });
  for (const targets of [
    { FRONTSTAGE_PROBE_MAX_CLIENT_P95_MS: '0' },
    { FRONTSTAGE_PROBE_MAX_CLIENT_P95_MS: '9007199254740992' },
    { FRONTSTAGE_PROBE_MAX_FRONTSTAGE_P95_MS: '1.5' },
  ]) {
    await assert.rejects(probe(targets), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout.trim(), '');
      assert.ok(error.stderr.trim());
      assertRedacted(error.stdout, error.stderr);
      return true;
    });
  }
  assert.equal(requests.length, 0);
});

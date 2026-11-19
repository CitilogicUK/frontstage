import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(
  new URL('./probe-pilot-roles.mjs', import.meta.url),
);
const run = promisify(execFile);
const builderToken = 'synthetic-builder-probe-token';
const reviewerToken = 'synthetic-reviewer-probe-token';
const builderRef = 'user:default/pilot-builder';
const reviewerRef = 'user:default/pilot-reviewer';
const privateBody = 'synthetic private response detail';
const appsPath = '/api/governance/apps';
const feedbackPath = '/api/governance/reports/registration-feedback';
const timingPath = '/api/governance/reports/registration-timing';

async function mockPilot(t, override) {
  const requests = [];
  const server = createServer((request, response) => {
    const { url: path, method, headers } = request;
    requests.push({ path, method, authorization: headers.authorization });
    const builder = headers.authorization === `Bearer ${builderToken}`;
    const reviewer = headers.authorization === `Bearer ${reviewerToken}`;
    response.setHeader('Content-Type', 'application/json');

    if (override?.(request, response)) return;
    if (method !== 'GET' || (!builder && !reviewer)) {
      response.writeHead(401).end();
    } else if (path === appsPath) {
      response.end(
        JSON.stringify({
          actor: builder ? builderRef : reviewerRef,
          canReview: reviewer,
          apps: [{ name: privateBody }],
        }),
      );
    } else if ((path === feedbackPath || path === timingPath) && reviewer) {
      response.end(JSON.stringify({ enabled: true, privateBody }));
    } else if (path === feedbackPath || path === timingPath) {
      response.writeHead(403).end(JSON.stringify({ message: privateBody }));
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  return {
    requests,
    probe: (overrides = {}) =>
      run(process.execPath, [script], {
        env: {
          ...process.env,
          FRONTSTAGE_PILOT_URL: `http://127.0.0.1:${server.address().port}`,
          FRONTSTAGE_PILOT_BUILDER_TOKEN: builderToken,
          FRONTSTAGE_PILOT_BUILDER_REF: builderRef,
          FRONTSTAGE_PILOT_REVIEWER_TOKEN: reviewerToken,
          FRONTSTAGE_PILOT_REVIEWER_REF: reviewerRef,
          ...overrides,
        },
        timeout: 8_000,
      }),
  };
}

function assertRedacted(...messages) {
  const output = messages.join('\n');
  for (const secret of [builderToken, reviewerToken, privateBody]) {
    assert.ok(!output.includes(secret));
  }
}

async function assertFailure(promise) {
  await assert.rejects(promise, error => {
    assert.equal(typeof error.code, 'number');
    assert.notEqual(error.code, 0);
    assert.ok(error.stderr.trim());
    assertRedacted(error.stdout, error.stderr);
    return true;
  });
}

test('pilot probe checks both roles and reports only role check results', async t => {
  const { requests, probe } = await mockPilot(t);
  const { stdout, stderr } = await probe();
  assertRedacted(stdout, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    checks: [
      {
        role: 'builder',
        inventoryStatus: 200,
        registrationReportStatus: 403,
        registrationTimingReportStatus: 403,
      },
      {
        role: 'reviewer',
        inventoryStatus: 200,
        registrationReportStatus: 200,
        registrationTimingReportStatus: 200,
      },
    ],
  });
  assert.deepEqual(
    requests,
    [builderToken, reviewerToken].flatMap(token =>
      [appsPath, feedbackPath, timingPath].map(path => ({
        path,
        method: 'GET',
        authorization: `Bearer ${token}`,
      })),
    ),
  );
});

test('pilot probe rejects role and identity mismatches', async t => {
  for (const mismatched of [
    { actor: reviewerRef, canReview: false },
    { actor: builderRef, canReview: true },
  ]) {
    const { probe } = await mockPilot(t, (request, response) => {
      if (
        request.url !== appsPath ||
        request.headers.authorization !== `Bearer ${builderToken}`
      )
        return false;
      response.end(JSON.stringify({ ...mismatched, privateBody }));
      return true;
    });
    await assertFailure(probe());
  }
});

test('pilot probe rejects unexpected report statuses without leaking responses', async t => {
  for (const reportPath of [feedbackPath, timingPath]) {
    const { probe } = await mockPilot(t, (request, response) => {
      if (request.url !== reportPath) return false;
      response.writeHead(503).end(JSON.stringify({ message: privateBody }));
      return true;
    });
    await assertFailure(probe());
  }
});

test('pilot probe rejects a malformed reviewer timing report', async t => {
  const { probe } = await mockPilot(t, (request, response) => {
    if (
      request.url !== timingPath ||
      request.headers.authorization !== `Bearer ${reviewerToken}`
    )
      return false;
    response.end(JSON.stringify({ enabled: 'true', privateBody }));
    return true;
  });
  await assertFailure(probe());
});

test('pilot probe rejects a redirect without following it', async t => {
  const { requests, probe } = await mockPilot(t, (request, response) => {
    if (request.url !== appsPath) return false;
    response.writeHead(307, { Location: '/redirected' }).end(privateBody);
    return true;
  });
  await assertFailure(probe());
  assert.ok(requests.length > 0);
  assert.ok(!requests.some(request => request.path === '/redirected'));
});

test('pilot probe rejects duplicate role tokens or references before fetching', async t => {
  const { requests, probe } = await mockPilot(t);
  await assertFailure(probe({ FRONTSTAGE_PILOT_REVIEWER_TOKEN: builderToken }));
  await assertFailure(probe({ FRONTSTAGE_PILOT_REVIEWER_REF: builderRef }));
  assert.deepEqual(requests, []);
});

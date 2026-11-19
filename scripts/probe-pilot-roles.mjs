const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const timeoutMs = 10_000;
const feedbackPath = '/api/governance/reports/registration-feedback';
const timingPath = '/api/governance/reports/registration-timing';

function readConfig(env) {
  let origin;
  try {
    origin = new URL(env.FRONTSTAGE_PILOT_URL ?? '');
  } catch {
    throw new Error('Set FRONTSTAGE_PILOT_URL to the Frontstage origin.');
  }
  if (
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && loopbackHosts.has(origin.hostname))) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('Use an HTTPS origin or a loopback HTTP origin.');
  }

  const roles = ['builder', 'reviewer'].map(role => {
    const prefix = `FRONTSTAGE_PILOT_${role.toUpperCase()}`;
    const token = env[`${prefix}_TOKEN`]?.trim();
    const expectedActor = env[`${prefix}_REF`]?.trim();
    if (!token || /\s/.test(token) || !expectedActor?.startsWith('user:')) {
      throw new Error(
        `Set ${prefix}_TOKEN and ${prefix}_REF for the test user.`,
      );
    }
    return { role, token, expectedActor, canReview: role === 'reviewer' };
  });
  if (
    roles[0].token === roles[1].token ||
    roles[0].expectedActor === roles[1].expectedActor
  ) {
    throw new Error('Use two distinct pilot identities and credentials.');
  }
  return { origin, roles };
}

async function check(origin, { role, token }, path, expectedStatus) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`${role} GET ${path} failed or timed out.`);
  }
  if (response.status !== expectedStatus || expectedStatus !== 200) {
    void response.body?.cancel().catch(() => {});
    if (response.status !== expectedStatus) {
      throw new Error(
        `${role} GET ${path} expected HTTP ${expectedStatus}, received ${response.status}.`,
      );
    }
    return undefined;
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${role} GET ${path} did not return valid JSON.`);
  }
}

async function checkRegistrationReport(origin, identity, path) {
  const expected = identity.canReview ? 200 : 403;
  const report = await check(origin, identity, path, expected);
  if (identity.canReview && typeof report?.enabled !== 'boolean') {
    throw new Error(`${identity.role} GET ${path} did not match the API.`);
  }
  return expected;
}

try {
  const { origin, roles } = readConfig(process.env);
  const results = [];
  for (const identity of roles) {
    const apps = await check(origin, identity, '/api/governance/apps', 200);
    if (
      apps?.actor !== identity.expectedActor ||
      apps?.canReview !== identity.canReview ||
      !Array.isArray(apps?.apps)
    ) {
      throw new Error(
        `${identity.role} Inventory identity or role did not match.`,
      );
    }

    const registrationReportStatus = await checkRegistrationReport(
      origin,
      identity,
      feedbackPath,
    );
    const registrationTimingReportStatus = await checkRegistrationReport(
      origin,
      identity,
      timingPath,
    );
    results.push({
      role: identity.role,
      inventoryStatus: 200,
      registrationReportStatus,
      registrationTimingReportStatus,
    });
  }
  console.log(JSON.stringify({ checks: results }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

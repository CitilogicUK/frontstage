import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const appId = 'fixture-app';
const verifier = fileURLToPath(new URL('./verify-audit.mjs', import.meta.url));

function hashEvent(payload) {
  const event = JSON.stringify(payload);
  return { event, digest: createHash('sha256').update(event).digest('hex') };
}

const events = [
  hashEvent({ record: { id: appId }, previousDigest: null, revision: 0 }),
];
const metadata = {
  actor: 'user:default/reviewer',
  at: '2026-11-18T12:00:00Z',
};
const issued = {
  action: 'issued',
  ...metadata,
  ...hashEvent({
    appId,
    action: 'issued',
    ...metadata,
    revision: 0,
    previousDigest: null,
  }),
};
const revoked = {
  action: 'revoked',
  ...metadata,
  ...hashEvent({
    appId,
    action: 'revoked',
    ...metadata,
    revision: 1,
    previousDigest: issued.digest,
  }),
};

async function verify(audit, ...args) {
  const directory = await mkdtemp(join(tmpdir(), 'frontstage-audit-'));
  try {
    const file = join(directory, 'export.json');
    await writeFile(file, JSON.stringify({ appId, events, ...audit }));
    const result = spawnSync(process.execPath, [verifier, file, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('distinguishes an empty key chain from a legacy export', async () => {
  const versioned = await verify({ keyAuditVersion: 1, keyEvents: [] });
  assert.equal(versioned.status, 0, versioned.stderr);
  assert.match(versioned.stdout, /Verified 0 gateway key events/);

  const legacy = await verify({
    keyEvents: [{ action: issued.action, ...metadata }],
  });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stdout, /no verifiable gateway key audit chain/);
  assert.match(legacy.stdout, /Verified 1 record events/);

  const missingList = await verify({ keyAuditVersion: 1 });
  assert.equal(missingList.status, 1);
  assert.match(missingList.stderr, /Invalid gateway key event list/);

  const unknownVersion = await verify({ keyAuditVersion: 2, keyEvents: [] });
  assert.equal(unknownVersion.status, 1);
  assert.match(unknownVersion.stderr, /Unsupported gateway key audit version/);
});

test('checks the saved key checkpoint and rejects a truncated or edited chain', async () => {
  const audit = { keyAuditVersion: 1, keyEvents: [issued, revoked] };
  const checkpoint = await verify(audit, '--key-checkpoint', issued.digest);
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  assert.match(checkpoint.stdout, /Saved key checkpoint matched revision 0/);

  const truncated = await verify(
    { ...audit, keyEvents: [issued] },
    '--key-head',
    revoked.digest,
  );
  assert.equal(truncated.status, 1);
  assert.match(truncated.stderr, /does not match the expected key head/);

  const edited = await verify({
    ...audit,
    keyEvents: [issued, { ...revoked, actor: 'user:default/other' }],
  });
  assert.equal(edited.status, 1);
  assert.match(edited.stderr, /inconsistent metadata or chain linkage/);
});

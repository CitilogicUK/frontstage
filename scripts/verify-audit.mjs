import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

function parseJson(text, message) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(message);
  }
}

try {
  const {
    positionals: [filename, expectedHead, ...extra],
    values: { checkpoint },
  } = parseArgs({
    allowPositionals: true,
    options: { checkpoint: { type: 'string' } },
  });
  const suppliedDigest = expectedHead ?? checkpoint;
  if (
    !filename ||
    extra.length ||
    (expectedHead !== undefined && checkpoint !== undefined) ||
    (suppliedDigest !== undefined && !/^[a-f0-9]{64}$/i.test(suppliedDigest))
  ) {
    throw new Error(
      'Usage: yarn audit:verify <export.json> [expected-head-sha256 | --checkpoint sha256]',
    );
  }
  const checkpointDigest = checkpoint?.toLowerCase();
  const audit = parseJson(
    await readFile(filename, 'utf8'),
    'The audit export is not valid JSON.',
  );
  if (
    typeof audit?.appId !== 'string' ||
    !audit.appId ||
    !Array.isArray(audit.events) ||
    !audit.events.length
  ) {
    throw new Error(
      'Expected a Frontstage app audit export with at least one record event.',
    );
  }

  let previousDigest = null;
  let previousRevision;
  let firstRevision;
  let checkpointRevision;
  for (const [index, entry] of audit.events.entries()) {
    const position = index + 1;
    if (typeof entry?.event !== 'string')
      throw new Error(
        `Record event ${position} is missing its original payload.`,
      );
    const digest = createHash('sha256').update(entry.event).digest('hex');
    if (entry.digest !== digest)
      throw new Error(`Record event ${position} has a digest mismatch.`);
    const event = parseJson(
      entry.event,
      `Record event ${position} contains invalid JSON.`,
    );
    if (
      event?.record?.id !== audit.appId ||
      event.previousDigest !== previousDigest ||
      !Number.isSafeInteger(event.revision) ||
      event.revision < 0 ||
      (previousRevision !== undefined &&
        event.revision !== previousRevision + 1)
    ) {
      throw new Error(
        `Record event ${position} has an invalid app ID, revision, or previous digest.`,
      );
    }
    if (digest === checkpointDigest) checkpointRevision = event.revision;
    firstRevision ??= event.revision;
    previousRevision = event.revision;
    previousDigest = digest;
  }
  if (expectedHead && expectedHead.toLowerCase() !== previousDigest)
    throw new Error('The final digest does not match the expected head.');

  if (checkpointDigest && checkpointRevision === undefined)
    throw new Error('The saved checkpoint is absent from this export.');

  console.log(
    `Verified ${audit.events.length} record events (revisions ${firstRevision}–${previousRevision}).`,
  );
  if (checkpointRevision !== undefined)
    console.log(`Saved checkpoint matched revision ${checkpointRevision}.`);
  console.log(`Head SHA-256: ${previousDigest}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

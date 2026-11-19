import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line no-restricted-imports -- The standalone starter uses Node's test runner.
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function validate(...args) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./validate.mjs', import.meta.url)), ...args],
    { encoding: 'utf8', timeout: 5000 },
  );
}

async function fixture(context, contents) {
  const directory = await mkdtemp(join(tmpdir(), 'data-validation-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const input = join(directory, 'input.json');
  await writeFile(input, contents);
  return input;
}

test('validates the included synthetic sample', () => {
  const sample = fileURLToPath(new URL('./sample.json', import.meta.url));
  const { status, stdout, stderr } = validate(sample);
  assert.equal(status, 0);
  assert.equal(stdout, 'Validated 2 inventory rows.\n');
  assert.equal(stderr, '');
});

test('reports invalid rows without printing their values', async t => {
  const input = await fixture(
    t,
    JSON.stringify([
      { itemId: 'synthetic-private-value', quantity: 4 },
      { itemId: 'synthetic-private-value ', quantity: -1 },
      null,
    ]),
  );
  const { status, stdout, stderr } = validate(input);
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /3 validation issues in 3 inventory rows/);
  assert.match(stderr, /Row 2: itemId must be unique/);
  assert.match(stderr, /Row 2: quantity must be a nonnegative safe integer/);
  assert.match(stderr, /Row 3: use an object/);
  assert.doesNotMatch(stderr, /synthetic-private-value/);
});

test('rejects malformed JSON without printing the parser diagnostic', async t => {
  const input = await fixture(t, '{ "synthetic-private-value": }');
  const { status, stderr } = validate(input);
  assert.equal(status, 2);
  assert.match(stderr, /not valid UTF-8 JSON/);
  assert.doesNotMatch(stderr, /synthetic-private-value/);
});

test('rejects oversized files and directories', async t => {
  const input = await fixture(t, '[]');
  await truncate(input, 1024 * 1024 + 1);
  const oversized = validate(input);
  assert.equal(oversized.status, 2);
  assert.match(oversized.stderr, /exceeds 1 MiB/);

  const directory = validate(fileURLToPath(new URL('.', import.meta.url)));
  assert.equal(directory.status, 2);
  assert.match(directory.stderr, /regular JSON file|Could not read the input/);
});

test('provides usage when a file path is missing', () => {
  const { status, stderr } = validate();
  assert.equal(status, 2);
  assert.match(stderr, /npm start -- <input.json>/);
});

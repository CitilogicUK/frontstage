import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const maxBytes = 1024 * 1024;
const maxReportedIssues = 10;

class InputError extends Error {}

async function readInput(path) {
  // Open nonblocking so a named pipe is rejected by the file check immediately.
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new InputError('Supply a regular JSON file.');
    }
    if (stat.size > maxBytes) {
      throw new InputError('Input exceeds 1 MiB. Use a smaller JSON file.');
    }

    // The extra byte detects growth after the size check without an unbounded read.
    const bytes = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        total,
        bytes.length - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw new InputError('Input exceeds 1 MiB. Use a smaller JSON file.');
    }
    return bytes.subarray(0, total);
  } finally {
    await file.close();
  }
}

function validateRows(rows) {
  const seenItemIds = new Set();
  const messages = [];
  let issues = 0;

  function report(message) {
    issues += 1;
    if (messages.length < maxReportedIssues) messages.push(message);
  }

  for (const [index, row] of rows.entries()) {
    const location = `Row ${index + 1}`;
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      report(`${location}: use an object with itemId and quantity.`);
      continue;
    }

    const { itemId, quantity } = row;
    if (typeof itemId !== 'string' || itemId.trim().length === 0) {
      report(`${location}: itemId must be a nonempty string.`);
    } else {
      const key = itemId.trim();
      if (seenItemIds.has(key)) {
        report(`${location}: itemId must be unique after trimming.`);
      }
      seenItemIds.add(key);
    }
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      report(`${location}: quantity must be a nonnegative safe integer.`);
    }
  }
  return { issues, messages };
}

async function run(args) {
  if (args.length !== 1) {
    process.stderr.write('Usage: npm start -- <input.json>\n');
    return 2;
  }

  let bytes;
  try {
    bytes = await readInput(args[0]);
  } catch (error) {
    const message =
      error instanceof InputError
        ? error.message
        : 'Could not read the input. Check the file path and read permissions.';
    process.stderr.write(`${message}\n`);
    return 2;
  }

  let rows;
  try {
    rows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    process.stderr.write(
      'Input is not valid UTF-8 JSON. Check the file encoding and syntax.\n',
    );
    return 2;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    process.stderr.write(
      'Input must contain a nonempty JSON array of inventory rows.\n',
    );
    return 1;
  }

  const { issues, messages } = validateRows(rows);
  if (issues > 0) {
    process.stderr.write(
      `Found ${issues} validation issues in ${rows.length} inventory rows.\n`,
    );
    for (const message of messages) process.stderr.write(`${message}\n`);
    if (issues > messages.length) {
      process.stderr.write(
        `${issues - messages.length} further issues omitted.\n`,
      );
    }
    return 1;
  }
  process.stdout.write(`Validated ${rows.length} inventory rows.\n`);
  return 0;
}

process.exitCode = await run(process.argv.slice(2));

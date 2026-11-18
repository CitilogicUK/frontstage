import { createReadStream } from 'node:fs';
import { readText, runModel, showError } from './gateway.mjs';

async function main() {
  const [file] = process.argv.slice(2);
  if (!file) throw new Error('Usage: node automation.mjs input.txt');
  const notes = await readText(createReadStream(file), 15_000);
  const summary = await runModel(
    `Summarize the supplied notes in three bullets and list any explicit action items. Do not invent an owner or deadline.\n\nNotes:\n${notes}`,
  );
  process.stdout.write(`${summary}\n`);
}

main().catch(showError);

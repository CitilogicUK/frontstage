import { readText, runModel, showError } from './gateway.mjs';

async function main() {
  if (process.stdin.isTTY) {
    process.stderr.write(
      'Enter a prompt, then end input with Ctrl-D (Ctrl-Z then Enter on Windows).\n',
    );
  }
  const answer = await runModel(await readText(process.stdin));
  process.stdout.write(`${answer}\n`);
}

main().catch(showError);

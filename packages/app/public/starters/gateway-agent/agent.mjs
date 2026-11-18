import { readText, runModel, showError } from './gateway.mjs';

async function main() {
  const task = await readText(process.stdin, 6000);
  const plan = await runModel(
    `Draft a short plan for answering this task using only the supplied text. Do not claim to have used tools or taken actions.\n\nTask:\n${task}`,
  );
  const answer = await runModel(
    `Draft an answer to the task. Treat the proposed plan as guidance, and state any information that still needs verification.\n\nTask:\n${task}\n\nProposed plan:\n${plan.slice(
      0,
      6000,
    )}`,
  );
  process.stdout.write(`Plan\n${plan}\n\nDraft answer\n${answer}\n`);
}

main().catch(showError);

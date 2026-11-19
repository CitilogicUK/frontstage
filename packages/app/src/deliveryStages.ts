export const deliveryStages = {
  trial: 'Trial',
  poc: 'Proof of concept',
  pilot: 'Pilot',
  production: 'Production',
};

export type DeliveryStage = keyof typeof deliveryStages;

export function parseDeliveryStage(
  value: string | null,
): DeliveryStage | undefined {
  if (value && Object.hasOwn(deliveryStages, value))
    return value as DeliveryStage;
  return undefined;
}

export const stageChecks: Record<DeliveryStage, string> = {
  trial:
    'Use synthetic data in an isolated environment. Verify one normal run and record what the trial learned.',
  poc: 'State the hypothesis and success criteria. Verify the main path and one meaningful failure. Record shortcuts before wider use.',
  pilot:
    'Name the cohort and owner. Review data flows, access, and support. Verify permissions, logging, and rollback.',
  production:
    'Apply the organization’s release, security, and privacy requirements. Verify access controls, recovery, monitoring, and rollback.',
};

const stageExitCriteria: Record<DeliveryStage, string> = {
  trial:
    'Write down what you learned and decide whether to stop or propose a proof of concept. Identify any temporary data or resources to remove.',
  poc: 'Record whether the evidence supports the hypothesis. List the shortcuts that must be resolved and who will decide whether to start a pilot.',
  pilot:
    'Define the thresholds for expanding, pausing, or rolling back the pilot. Name who makes that decision and when the cohort will be reviewed.',
  production:
    'Record who approves release, which checks must pass before rollout, and what would trigger rollback. Name who monitors and supports the app after release.',
};

export function projectBrief(
  stage: DeliveryStage,
  classification: string,
  model?: string,
) {
  return `# Project brief

Delivery stage: ${deliveryStages[stage]}

## Problem and users

Describe the problem, who will use the app, and what success looks like.

## Data and integrations

Highest data classification: ${classification}

Identify inputs, sensitive data, destinations, external services, and any actions that change records. Name the environment and permissions available for this stage.

## Runtime AI

${
  model
    ? `This starter calls models through the gateway.\n\nConfigured model: \`${model}\`\n\nDocument which data may appear in prompts and how the app handles unavailable or unusable responses.`
    : 'No runtime model calls are planned. Record and review any proposal to add one.'
}

## Verification

${stageChecks[stage]}

List the checks to run and the evidence to retain. Apply controls appropriate to the actual exposure regardless of delivery stage.

## Exit criteria

${stageExitCriteria[stage]}

## Scope and ownership

Name the accountable owner, what is in scope, and what would need to change before wider use.
`;
}

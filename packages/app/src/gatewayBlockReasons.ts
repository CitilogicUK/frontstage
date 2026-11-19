const blockReasons: Record<string, string> = {
  'provider-hosted': 'Provider-hosted app',
  review: 'Review required',
  'tier-drift': 'Risk reassessment required',
  lifecycle: 'App inactive',
  ownership: 'Inactive or missing catalog ownership',
  model: 'Model or data policy',
  'spend-threshold': 'Monthly spend threshold reached',
  'rate-limit': 'Rate limit reached',
  environment: 'Production gateway unavailable',
};

export function gatewayBlockReason(reason: string) {
  return Object.hasOwn(blockReasons, reason) ? blockReasons[reason] : reason;
}

const nextSteps: Record<string, string> = {
  environment:
    'Use a sandbox key for simulation or retry once the production gateway is available.',
  'provider-hosted':
    'Use the approved provider workspace and verify its sharing and connector settings.',
  review:
    'Open the app record and resolve any outstanding review requirements.',
  'tier-drift':
    'Ask the app owner to reassess the app against the current risk policy.',
  lifecycle:
    'Check whether the app should be returned to Active before retrying.',
  ownership:
    'Check the app’s owner, backup owner and team in the Catalog. Restore any missing or inactive assignments.',
  model:
    'Check that the app uses AI at runtime and that its model is approved for its effective data classification.',
  'spend-threshold':
    'Review the monthly spend and threshold with the app owner before retrying live calls.',
  'rate-limit':
    'Reduce the request rate and retry after the gateway’s Retry-After interval.',
};

export function gatewayBlockNextStep(reason: string) {
  return Object.hasOwn(nextSteps, reason) ? nextSteps[reason] : undefined;
}

const blockReasons: Record<string, string> = {
  'provider-hosted': 'Provider-hosted app',
  review: 'Review required',
  'tier-drift': 'Risk reassessment required',
  lifecycle: 'App inactive',
  ownership: 'Inactive or missing catalog ownership',
  model: 'Model or data policy',
  'spend-threshold': 'Monthly spend threshold reached',
  'rate-limit': 'Rate limit reached',
};

export function gatewayBlockReason(reason: string) {
  return Object.hasOwn(blockReasons, reason) ? blockReasons[reason] : reason;
}

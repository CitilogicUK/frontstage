export const appLifecycles = [
  'experimental',
  'active',
  'deprecated',
  'retired',
];

export const appClassifications = [
  'public',
  'internal',
  'confidential',
  'restricted',
];

export const appRiskTierNames = ['Personal', 'Shared', 'Critical'];

export const appRegistrationSources = {
  registered: 'Direct registration',
  git: 'Git repository',
  'bulk import': 'Bulk import',
  'hosted snapshot': 'Hosted snapshot',
  unrecorded: 'Unrecorded',
};

export function registrationSource(source?: string) {
  return source && Object.hasOwn(appRegistrationSources, source)
    ? (source as keyof typeof appRegistrationSources)
    : 'unrecorded';
}

export function needsRiskReassessment(app: {
  tier: number;
  lifecycle: string;
  riskAssessment?: { tier: number };
}) {
  return (
    app.lifecycle !== 'retired' &&
    app.riskAssessment !== undefined &&
    app.riskAssessment.tier !== app.tier
  );
}

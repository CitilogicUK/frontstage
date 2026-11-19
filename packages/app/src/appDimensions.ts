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
  unrecorded: 'Unrecorded',
};

export function registrationSource(source?: string) {
  return source && Object.hasOwn(appRegistrationSources, source)
    ? (source as keyof typeof appRegistrationSources)
    : 'unrecorded';
}

const coveragePercent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});

export function formatDiscoveryCoverage(registered: number, eligible: number) {
  if (eligible === 0) return undefined;
  if (registered > 0 && registered * 1000 < eligible) return '<0.1%';
  if (registered < eligible && (eligible - registered) * 1000 < eligible)
    return '>99.9%';
  return coveragePercent.format(registered / eligible);
}

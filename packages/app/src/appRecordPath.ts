export function appRecordPath(id: string, currentParams?: URLSearchParams) {
  const params = new URLSearchParams(currentParams);
  params.set('app', id);
  return `/?${params}`;
}

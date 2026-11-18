export function appRecordPath(id: string, view?: 'discovery') {
  const params = new URLSearchParams();
  if (view) params.set('view', view);
  params.set('app', id);
  return `/?${params}`;
}

import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

type Check = {
  name: string;
  status: 'pass' | 'attention' | 'unknown' | 'not-applicable';
  detail: string;
};
const labels = {
  pass: 'Pass',
  attention: 'Needs attention',
  unknown: 'No evidence',
  'not-applicable': 'Not applicable',
};

export function AppScorecard({
  appId,
  refreshVersion,
}: {
  appId: string;
  refreshVersion: number;
}) {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>();

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setChecks(undefined);
    discovery
      .getBaseUrl('governance')
      .then(base =>
        fetch(`${base}/apps/${encodeURIComponent(appId)}/scorecard`, {
          signal: controller.signal,
        }),
      )
      .then(async response => {
        if (!response.ok) throw new Error('Could not load scorecard');
        const data: { checks: Check[] } = await response.json();
        if (!controller.signal.aborted) setChecks(data.checks);
      })
      .catch(() => {
        if (!controller.signal.aborted) setChecks(null);
      });
    return () => controller.abort();
  }, [appId, discovery, fetch, open, refreshVersion]);

  return (
    <details
      className="gov-app-editor"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary>App scorecard</summary>
      {open && checks === null && (
        <p role="alert">
          The scorecard could not load. Close and reopen to retry.
        </p>
      )}
      {open && checks === undefined && <p role="status">Checking this app…</p>}
      {open && checks && (
        <ul className="gov-audit-events">
          {checks.map(check => (
            <li key={check.name}>
              <strong>
                {check.name} · {labels[check.status]}
              </strong>
              <p>{check.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

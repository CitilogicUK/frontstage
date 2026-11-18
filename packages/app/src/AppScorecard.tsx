import { useState } from 'react';
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

export function AppScorecard({ appId }: { appId: string }) {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [checks, setChecks] = useState<Check[]>();
  const [error, setError] = useState(false);

  async function load() {
    setChecks(undefined);
    setError(false);
    try {
      const base = await discovery.getBaseUrl('governance');
      const response = await fetch(
        `${base}/apps/${encodeURIComponent(appId)}/scorecard`,
      );
      if (!response.ok) throw new Error('Could not load scorecard');
      const data: { checks: Check[] } = await response.json();
      setChecks(data.checks);
    } catch {
      setError(true);
    }
  }

  return (
    <details
      className="gov-app-editor"
      onToggle={event => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>App scorecard</summary>
      {error && (
        <p role="alert">
          The scorecard could not load. Close and reopen to retry.
        </p>
      )}
      {!error && !checks && <p role="status">Checking this app…</p>}
      {checks && (
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

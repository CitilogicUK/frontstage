import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { Link, type To } from 'react-router-dom';

type Escalation = {
  appId: string;
  name: string;
  owner: string;
  due: string;
};

export function ManagerEscalations({
  appLink,
}: {
  appLink: (appId: string) => To;
}) {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [attempt, setAttempt] = useState(0);
  const [escalations, setEscalations] = useState<Escalation[] | null>();

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const baseUrl = await discovery.getBaseUrl('governance');
        const response = await fetch(`${baseUrl}/reports/manager-escalations`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Manager escalations unavailable');
        const { apps }: { apps: Escalation[] } = await response.json();
        if (!controller.signal.aborted) setEscalations(apps);
      } catch {
        if (!controller.signal.aborted) setEscalations(null);
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt, discovery, fetch]);

  return (
    <section
      className="gov-panel gov-stage-report"
      aria-labelledby="manager-escalations"
    >
      <div className="gov-report-heading">
        <h2 id="manager-escalations">Manager escalations</h2>
        <p>Manager notifications sent for currently overdue renewals.</p>
      </div>
      <button
        type="button"
        className="gov-button"
        disabled={escalations === undefined}
        onClick={() => {
          setEscalations(undefined);
          setAttempt(value => value + 1);
        }}
      >
        Refresh manager escalations
      </button>
      {escalations === undefined && (
        <p role="status">Loading manager escalations…</p>
      )}
      {escalations === null && (
        <p role="alert">Manager escalations could not load.</p>
      )}
      {escalations?.length === 0 && <p>No current manager escalations.</p>}
      {!!escalations?.length && (
        <ul>
          {escalations.map(app => (
            <li key={app.appId}>
              <Link to={appLink(app.appId)}>{app.name}</Link>
              <p>
                Renewal due{' '}
                <time dateTime={app.due}>{app.due.slice(0, 10)}</time>
                {' · '}
                {app.owner}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

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

type EscalationReport = {
  escalationDays: number | null;
  apps: Escalation[];
};

export function ManagerEscalations({
  appLink,
}: {
  appLink: (appId: string) => To;
}) {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [attempt, setAttempt] = useState(0);
  const [report, setReport] = useState<EscalationReport | null>();

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const baseUrl = await discovery.getBaseUrl('governance');
        const response = await fetch(`${baseUrl}/reports/manager-escalations`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Manager escalations unavailable');
        const result: EscalationReport = await response.json();
        if (!controller.signal.aborted) setReport(result);
      } catch {
        if (!controller.signal.aborted) setReport(null);
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
        {report?.escalationDays != null && (
          <p>
            Manager notifications are scheduled after {report.escalationDays}{' '}
            overdue calendar {report.escalationDays === 1 ? 'day' : 'days'}.
          </p>
        )}
      </div>
      <button
        type="button"
        className="gov-button"
        disabled={report === undefined}
        onClick={() => {
          setReport(undefined);
          setAttempt(value => value + 1);
        }}
      >
        Refresh manager escalations
      </button>
      {report === undefined && (
        <p role="status">Loading manager escalations…</p>
      )}
      {report === null && (
        <p role="alert">Manager escalations could not load.</p>
      )}
      {report?.escalationDays === null && (
        <p>Scheduled manager escalations are disabled.</p>
      )}
      {report?.escalationDays != null && report.apps.length === 0 && (
        <p>No current manager escalations.</p>
      )}
      {!!report?.apps.length && (
        <ul>
          {report.apps.map(app => (
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

import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

type RegistrationTiming = {
  enabled: boolean;
  days: number;
  sampleCount: number;
  medianSeconds: number | null;
};

export function RegistrationTimingReport() {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [attempt, setAttempt] = useState(0);
  const [report, setReport] = useState<RegistrationTiming | null>();

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const base = await discovery.getBaseUrl('governance');
        const response = await fetch(`${base}/reports/registration-timing`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Registration timing unavailable');
        const result: RegistrationTiming = await response.json();
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
      aria-labelledby="registration-timing-title"
    >
      <div className="gov-report-heading">
        <h2 id="registration-timing-title">Tier 1 registration time</h2>
      </div>
      {report === undefined && (
        <p role="status">Loading registration timing…</p>
      )}
      {report === null && (
        <>
          <p role="alert">Registration timing could not load.</p>
          <button
            type="button"
            onClick={() => {
              setReport(undefined);
              setAttempt(value => value + 1);
            }}
          >
            Retry loading registration timing
          </button>
        </>
      )}
      {report?.enabled === false && <p>Registration timing is disabled.</p>}
      {report?.enabled && report.medianSeconds === null && (
        <p>No timed Tier 1 registrations in the last {report.days} days.</p>
      )}
      {report?.enabled && report.medianSeconds !== null && (
        <>
          <p>
            Median: {report.medianSeconds.toLocaleString()}{' '}
            {report.medianSeconds === 1 ? 'second' : 'seconds'}
          </p>
          <p>
            {report.sampleCount.toLocaleString()} timed{' '}
            {report.sampleCount === 1 ? 'registration' : 'registrations'} in the
            last {report.days} days.
          </p>
        </>
      )}
    </section>
  );
}

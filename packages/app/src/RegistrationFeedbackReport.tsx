import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

import {
  downloadCsv,
  registrationFeedbackCsv,
  type RegistrationFeedbackTotals,
} from './portfolioExport';

type RegistrationFeedback = Omit<
  RegistrationFeedbackTotals,
  'windowStartUtc' | 'windowEndUtc'
> & {
  enabled: boolean;
  windowStartUtc?: string;
  windowEndUtc?: string;
};

export function RegistrationFeedbackReport() {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [attempt, setAttempt] = useState(0);
  const [report, setReport] = useState<RegistrationFeedback | null>();

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const base = await discovery.getBaseUrl('governance');
        const response = await fetch(`${base}/reports/registration-feedback`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Registration feedback unavailable');
        const result: RegistrationFeedback = await response.json();
        if (!controller.signal.aborted) setReport(result);
      } catch {
        if (!controller.signal.aborted) setReport(null);
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt, discovery, fetch]);

  const { windowStartUtc, windowEndUtc } = report ?? {};

  return (
    <section
      className="gov-panel gov-stage-report"
      aria-labelledby="registration-feedback-title"
    >
      <div className="gov-report-heading">
        <h2 id="registration-feedback-title">Registration feedback</h2>
        {report?.enabled && windowStartUtc && windowEndUtc && (
          <button
            type="button"
            onClick={() =>
              downloadCsv(
                registrationFeedbackCsv({
                  ...report,
                  windowStartUtc,
                  windowEndUtc,
                }),
                'frontstage-registration-feedback.csv',
              )
            }
          >
            Download registration feedback CSV
          </button>
        )}
      </div>
      {report === undefined && (
        <p role="status">Loading registration feedback…</p>
      )}
      {report === null && (
        <>
          <p role="alert">Registration feedback could not load.</p>
          <button
            type="button"
            onClick={() => {
              setReport(undefined);
              setAttempt(value => value + 1);
            }}
          >
            Retry loading registration feedback
          </button>
        </>
      )}
      {report?.enabled === false && <p>Registration feedback is disabled.</p>}
      {report?.enabled && report.eligibleCount === 0 && (
        <p>No feedback offers in the last {report.days} days.</p>
      )}
      {report?.enabled && report.eligibleCount > 0 && (
        <>
          <p>
            {report.responseCount.toLocaleString()} of{' '}
            {report.eligibleCount.toLocaleString()} feedback offers received a
            response in the last {report.days} days (
            {(report.responseCount / report.eligibleCount).toLocaleString(
              undefined,
              { style: 'percent', maximumFractionDigits: 1 },
            )}
            ).
          </p>
          <p>
            {report.responseCount > 0
              ? `${report.satisfiedCount.toLocaleString()} of ${report.responseCount.toLocaleString()} responses were satisfied (${(
                  report.satisfiedCount / report.responseCount
                ).toLocaleString(undefined, {
                  style: 'percent',
                  maximumFractionDigits: 1,
                })}).`
              : 'No responses yet.'}
          </p>
        </>
      )}
    </section>
  );
}

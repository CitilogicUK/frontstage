import { useState, type FormEvent } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { Link, type To } from 'react-router-dom';
import {
  downloadCsv,
  outsideGatewayUsageCsv,
  type OutsideGatewayUsagePreview,
} from './portfolioExport';

export function OutsideGatewayUsage({
  appLink,
}: {
  appLink: (appId: string) => To;
}) {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [preview, setPreview] = useState<OutsideGatewayUsagePreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const callCount = preview?.rows.reduce((total, row) => total + row.calls, 0);

  async function loadPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreview(undefined);
    setError(undefined);
    let payload: unknown;
    try {
      payload = JSON.parse(
        String(new FormData(event.currentTarget).get('usage')),
      );
    } catch {
      setError('Enter valid JSON for the usage preview.');
      return;
    }

    setBusy(true);
    try {
      const base = await discovery.getBaseUrl('governance');
      const response = await fetch(`${base}/reports/outside-gateway/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.status === 400) {
        setError(
          'Use a UTC start before the end, with 1 to 100 rows and one positive call count per source and model.',
        );
        return;
      }
      if (!response.ok) throw new Error('Usage preview failed');
      setPreview(await response.json());
    } catch {
      setError('Outside-gateway usage could not be previewed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="gov-panel gov-stage-report"
      aria-labelledby="outside-gateway-usage-title"
    >
      <h2 id="outside-gateway-usage-title">Outside-gateway usage</h2>
      <p id="outside-gateway-usage-help">
        Paste JSON with UTC timestamps in <code>from</code> and <code>to</code>{' '}
        and up to 100 <code>rows</code> with <code>sourceUrl</code>,{' '}
        <code>model</code>, and <code>calls</code> for each entry.
      </p>
      <form onSubmit={loadPreview}>
        <label>
          Outside-gateway usage JSON
          <textarea
            name="usage"
            aria-describedby="outside-gateway-usage-help"
            rows={5}
            required
            disabled={busy}
          />
        </label>
        <button type="submit" disabled={busy}>
          Preview outside-gateway usage
        </button>
      </form>
      {busy && <p role="status">Loading usage preview…</p>}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <>
          <p>
            Reporting window <time dateTime={preview.from}>{preview.from}</time>
            {' to '}
            <time dateTime={preview.to}>{preview.to}</time>
          </p>
          <p>
            {callCount?.toLocaleString()} reported{' '}
            {callCount === 1 ? 'call' : 'calls'} · {preview.rows.length}{' '}
            {preview.rows.length === 1 ? 'row' : 'rows'} ·{' '}
            {preview.rows.filter(row => !row.appId).length} unmatched
          </p>
          <button
            type="button"
            onClick={() =>
              downloadCsv(
                outsideGatewayUsageCsv(preview),
                'frontstage-outside-gateway-usage.csv',
              )
            }
          >
            Download outside-gateway usage CSV
          </button>
          {preview.rows.length ? (
            <div className="governance-table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">App</th>
                    <th scope="col">Source</th>
                    <th scope="col">Model</th>
                    <th scope="col">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, index) => (
                    <tr key={JSON.stringify([row.sourceUrl, row.model, index])}>
                      <td className="gov-app-cell">
                        {row.appId ? (
                          <Link to={appLink(row.appId)}>
                            {row.appName ?? row.appId}
                          </Link>
                        ) : (
                          'No app matched'
                        )}
                      </td>
                      <td data-label="Source">{row.sourceUrl}</td>
                      <td data-label="Model">{row.model}</td>
                      <td data-label="Calls">{row.calls.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No usage rows to preview.</p>
          )}
        </>
      )}
    </section>
  );
}

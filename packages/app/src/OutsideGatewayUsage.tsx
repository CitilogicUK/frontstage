import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  configApiRef,
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

const maxUsageFileSize = 1024 * 1024;

export function OutsideGatewayUsage({
  appLink,
  onRegister,
  preview,
  onPreview,
}: {
  appLink: (appId: string) => To;
  onRegister: (sourceUrl: string) => void;
  preview?: OutsideGatewayUsagePreview;
  onPreview: (preview: OutsideGatewayUsagePreview | undefined) => void;
}) {
  const config = useApi(configApiRef);
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File>();
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  const sampleUrl = `${config
    .getString('app.baseUrl')
    .replace(/\/$/, '')}/examples/outside-gateway-usage.json`;
  const callCount = preview?.rows.reduce((total, row) => total + row.calls, 0);

  function selectFile(nextFile: File | undefined) {
    setFile(nextFile);
    onPreview(undefined);
    setError(undefined);
  }

  async function loadPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onPreview(undefined);
    setError(undefined);
    if (file && file.size > maxUsageFileSize) {
      setError('Choose a JSON file that is 1 MB or smaller.');
      return;
    }

    const pastedUsage = String(new FormData(event.currentTarget).get('usage'));
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      let input = pastedUsage;
      if (file) {
        try {
          input = await file.text();
        } catch {
          setError('The selected JSON file could not be read.');
          return;
        }
      }
      let payload: unknown;
      try {
        payload = JSON.parse(input);
      } catch {
        setError('Enter valid JSON for the usage preview.');
        return;
      }

      const base = await discovery.getBaseUrl('governance');
      const response = await fetch(`${base}/reports/outside-gateway/preview`, {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.status === 413) {
        setError('The usage preview request must be 1 MB or smaller.');
        return;
      }
      if (response.status === 400) {
        setError(
          'Use a UTC start before the end, with 1 to 100 rows and one positive call count per source and model.',
        );
        return;
      }
      if (!response.ok) throw new Error('Usage preview failed');
      const result: OutsideGatewayUsagePreview = await response.json();
      if (!controller.signal.aborted) onPreview(result);
    } catch {
      if (!controller.signal.aborted)
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
        Upload or paste JSON with UTC timestamps in <code>from</code> and{' '}
        <code>to</code> and up to 100 <code>rows</code> with{' '}
        <code>sourceUrl</code>, <code>model</code>, and <code>calls</code> for
        each entry.
      </p>
      <a href={sampleUrl} download>
        Download sample usage JSON
      </a>
      <form onSubmit={loadPreview}>
        <label>
          Upload usage JSON
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            aria-describedby="outside-gateway-usage-help"
            disabled={busy}
            onChange={event => selectFile(event.target.files?.[0])}
          />
        </label>
        {file && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (fileInput.current) {
                fileInput.current.value = '';
                fileInput.current.focus();
              }
              selectFile(undefined);
            }}
          >
            Clear selected file
          </button>
        )}
        <label>
          Outside-gateway usage JSON
          <textarea
            name="usage"
            aria-describedby="outside-gateway-usage-help"
            rows={5}
            required={!file}
            disabled={busy || Boolean(file)}
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
                          <>
                            No app matched{' '}
                            <button
                              type="button"
                              onClick={() => onRegister(row.sourceUrl)}
                            >
                              Start registration
                            </button>
                          </>
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

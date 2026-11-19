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
const reconciliationPath = '/reports/outside-gateway/reconciliations';

type SavedReconciliation = {
  id: string;
  confirmedAt: string;
  confirmedBy: string;
  preview: OutsideGatewayUsagePreview;
};

type ReconciliationSummary = Omit<SavedReconciliation, 'preview'> & {
  from: string;
  to: string;
  rowCount: number;
};

export function OutsideGatewayUsage({
  appLink,
  onRegister,
  preview: livePreview,
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
  const [saved, setSaved] = useState<SavedReconciliation>();
  const [history, setHistory] = useState<ReconciliationSummary[] | null>();
  const [historyVersion, setHistoryVersion] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    discovery
      .getBaseUrl('governance')
      .then(base =>
        fetch(base + reconciliationPath, { signal: controller.signal }),
      )
      .then(async response => {
        if (!response.ok) throw new Error('Reconciliation history unavailable');
        const result: { reconciliations: ReconciliationSummary[] } =
          await response.json();
        if (!controller.signal.aborted) setHistory(result.reconciliations);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistory(null);
      });
    return () => controller.abort();
  }, [discovery, fetch, historyVersion]);
  const sampleUrl = `${config
    .getString('app.baseUrl')
    .replace(/\/$/, '')}/examples/outside-gateway-usage.json`;
  const preview = saved?.preview ?? livePreview;
  const callCount = preview?.rows.reduce((total, row) => total + row.calls, 0);

  function clearPreview() {
    setSaved(undefined);
    onPreview(undefined);
    setError(undefined);
  }

  function selectFile(nextFile: File | undefined) {
    setFile(nextFile);
    clearPreview();
  }

  async function loadPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearPreview();
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

  async function accessReconciliation(id?: string) {
    const controller = new AbortController();
    request.current = controller;
    setError(undefined);
    setBusy(true);
    try {
      const base = await discovery.getBaseUrl('governance');
      let response: Response;
      if (id) {
        response = await fetch(
          `${base}${reconciliationPath}/${encodeURIComponent(id)}`,
          { signal: controller.signal },
        );
      } else {
        if (!livePreview) return;
        const { from, to, rows } = livePreview;
        response = await fetch(base + reconciliationPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            from,
            to,
            rows: rows.map(({ sourceUrl, model, calls }) => ({
              sourceUrl,
              model,
              calls,
            })),
          }),
        });
        if (response.status === 400) {
          setError(
            'Saved reconciliations require source URLs without query strings or fragments.',
          );
          return;
        }
      }
      if (!response.ok) throw new Error('Reconciliation unavailable');
      const result: SavedReconciliation = await response.json();
      if (controller.signal.aborted) return;
      setSaved(result);
      onPreview(undefined);
      if (!id) setHistoryVersion(version => version + 1);
    } catch {
      if (!controller.signal.aborted)
        setError(
          id
            ? 'The saved reconciliation could not load.'
            : 'The reconciliation could not be saved.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
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
            onChange={clearPreview}
          />
        </label>
        <button type="submit" disabled={busy}>
          Preview outside-gateway usage
        </button>
      </form>
      {busy && <p role="status">Working on outside-gateway usage…</p>}
      {error && <p role="alert">{error}</p>}
      <h3>Saved reconciliations</h3>
      {history === undefined && (
        <p role="status">Loading saved reconciliations…</p>
      )}
      {history === null && <p>Saved reconciliations could not load.</p>}
      {history?.length === 0 && <p>No saved reconciliations.</p>}
      {!!history?.length && (
        <ul>
          {history.map(item => (
            <li key={item.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void accessReconciliation(item.id)}
              >
                Open saved reconciliation from {item.from} to {item.to}
              </button>{' '}
              · <time dateTime={item.confirmedAt}>{item.confirmedAt}</time>
            </li>
          ))}
        </ul>
      )}
      {preview && (
        <>
          {saved ? (
            <p role="status">
              Saved reconciliation ·{' '}
              <time dateTime={saved.confirmedAt}>{saved.confirmedAt}</time> ·{' '}
              {saved.confirmedBy}. Matches reflect Inventory at save time.
            </p>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void accessReconciliation()}
            >
              Save reconciliation
            </button>
          )}
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
                            {!saved && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => onRegister(row.sourceUrl)}
                              >
                                Start registration
                              </button>
                            )}
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

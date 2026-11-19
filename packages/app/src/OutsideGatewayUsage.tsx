import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { Link, useSearchParams, type To } from 'react-router-dom';
import {
  downloadCsv,
  outsideGatewayUsageCsv,
  type OutsideGatewayUsagePreview,
} from './portfolioExport';

const maxUsageFileSize = 1024 * 1024;
const reconciliationPath = '/reports/outside-gateway/reconciliations';
const reconciliationParam = 'usageReconciliation';

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

type ReconciliationPage = {
  reconciliations: ReconciliationSummary[];
  nextCursor?: string;
};

function usageInput({ from, to, rows }: OutsideGatewayUsagePreview) {
  return {
    from,
    to,
    rows: rows.map(({ sourceUrl, model, calls }) => ({
      sourceUrl,
      model,
      calls,
    })),
  };
}

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
  const [params, setParams] = useSearchParams();
  const routeId = params.get(reconciliationParam);
  const previousRouteId = useRef<string | null>(null);
  const [routeAttempt, setRouteAttempt] = useState(0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File>();
  const [saved, setSaved] = useState<SavedReconciliation>();
  const [history, setHistory] = useState<ReconciliationPage | null>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const loadOlderButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController>();
  const requestRoute = useRef<string | null>(null);
  const historyRequest = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const previous = previousRouteId.current;
    previousRouteId.current = routeId;
    if (routeId === null) {
      if (previous !== null) setSaved(undefined);
      if (requestRoute.current !== null) {
        request.current?.abort();
        requestRoute.current = null;
        setError(undefined);
        setBusy(false);
      }
      return undefined;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    requestRoute.current = routeId;
    setSaved(undefined);
    onPreview(undefined);
    setError(undefined);
    setBusy(true);
    discovery
      .getBaseUrl('governance')
      .then(base =>
        fetch(`${base}${reconciliationPath}/${encodeURIComponent(routeId)}`, {
          signal: controller.signal,
        }),
      )
      .then(async response => {
        if (!response.ok) throw new Error('Reconciliation unavailable');
        const result: SavedReconciliation = await response.json();
        if (!controller.signal.aborted) setSaved(result);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('The saved reconciliation could not load.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      if (request.current === controller) setBusy(false);
    };
  }, [discovery, fetch, onPreview, routeAttempt, routeId]);
  const readHistory = useCallback(
    async (signal: AbortSignal, before?: string) => {
      const base = await discovery.getBaseUrl('governance');
      const query = before ? `?${new URLSearchParams({ before })}` : '';
      const response = await fetch(base + reconciliationPath + query, {
        signal,
      });
      if (!response.ok) throw new Error('Reconciliation history unavailable');
      return (await response.json()) as ReconciliationPage;
    },
    [discovery, fetch],
  );
  useEffect(() => {
    const controller = new AbortController();
    setHistory(undefined);
    setLoadingOlder(false);
    setOlderError(false);
    readHistory(controller.signal)
      .then(result => {
        if (!controller.signal.aborted) setHistory(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistory(null);
      });
    return () => {
      controller.abort();
      historyRequest.current?.abort();
    };
  }, [readHistory, historyVersion]);
  const sampleUrl = `${config
    .getString('app.baseUrl')
    .replace(/\/$/, '')}/examples/outside-gateway-usage`;
  const preview = saved?.preview ?? livePreview;
  const callCount = preview?.rows.reduce((total, row) => total + row.calls, 0);

  async function loadOlder(before: string) {
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const result = await readHistory(controller.signal, before);
      if (!controller.signal.aborted) {
        if (
          !result.nextCursor &&
          (document.activeElement === loadOlderButton.current ||
            document.activeElement === document.body)
        )
          historyHeading.current?.focus();
        setHistory(previous => ({
          ...result,
          reconciliations: [
            ...(previous?.reconciliations ?? []),
            ...result.reconciliations,
          ],
        }));
      }
    } catch {
      if (!controller.signal.aborted) setOlderError(true);
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }

  function clearPreview() {
    setSaved(undefined);
    onPreview(undefined);
    setError(undefined);
    clearReconciliationRoute();
  }

  function clearReconciliationRoute() {
    if (routeId !== null) {
      const next = new URLSearchParams(params);
      next.delete(reconciliationParam);
      setParams(next, { replace: true });
    }
  }

  function openReconciliation(id: string) {
    if (id === routeId) {
      setRouteAttempt(attempt => attempt + 1);
    } else {
      const next = new URLSearchParams(params);
      next.set(reconciliationParam, id);
      setParams(next);
    }
  }

  function selectFile(nextFile: File | undefined) {
    setFile(nextFile);
    clearPreview();
  }

  async function requestPreview(
    payload: unknown,
    signal: AbortSignal,
    csv = false,
  ) {
    const base = await discovery.getBaseUrl('governance');
    const response = await fetch(`${base}/reports/outside-gateway/preview`, {
      signal,
      method: 'POST',
      headers: { 'Content-Type': csv ? 'text/csv' : 'application/json' },
      body: csv ? String(payload) : JSON.stringify(payload),
    });
    if (signal.aborted) return undefined;
    if (response.status === 413) {
      setError('The usage preview request must be 1 MB or smaller.');
      return undefined;
    }
    if (response.status === 400) {
      setError(
        csv
          ? 'Use the sample CSV columns, one shared UTC reporting window, and 1 to 100 distinct usage rows with positive whole call counts.'
          : 'Use a UTC start before the end, with 1 to 100 rows and one positive call count per source and model.',
      );
      return undefined;
    }
    if (!response.ok) throw new Error('Usage preview failed');
    const result: OutsideGatewayUsagePreview = await response.json();
    return signal.aborted ? undefined : result;
  }

  async function loadPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearPreview();
    if (file && file.size > maxUsageFileSize) {
      setError('Choose a usage file that is 1 MB or smaller.');
      return;
    }

    const pastedUsage = String(new FormData(event.currentTarget).get('usage'));
    const controller = new AbortController();
    request.current = controller;
    requestRoute.current = null;
    setBusy(true);
    try {
      let input = pastedUsage;
      if (file) {
        try {
          input = await file.text();
        } catch {
          setError('The selected usage file could not be read.');
          return;
        }
      }
      const csv = Boolean(
        file && (/\.csv$/i.test(file.name) || file.type === 'text/csv'),
      );
      let payload: unknown = input;
      try {
        if (!csv) payload = JSON.parse(input);
      } catch {
        setError('Enter valid JSON for the usage preview.');
        return;
      }

      const result = await requestPreview(payload, controller.signal, csv);
      if (result) onPreview(result);
    } catch {
      if (!controller.signal.aborted)
        setError('Outside-gateway usage could not be previewed.');
    } finally {
      setBusy(false);
    }
  }

  async function recheckSaved(reconciliation: SavedReconciliation) {
    const controller = new AbortController();
    request.current = controller;
    requestRoute.current = routeId;
    setError(undefined);
    setBusy(true);
    try {
      const result = await requestPreview(
        usageInput(reconciliation.preview),
        controller.signal,
      );
      if (result) {
        setSaved(undefined);
        clearReconciliationRoute();
        onPreview({ ...result, savedReconciliationId: reconciliation.id });
      }
    } catch {
      if (!controller.signal.aborted)
        setError('The saved usage could not be rechecked against Inventory.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function saveReconciliation() {
    if (!livePreview) return;
    const controller = new AbortController();
    request.current = controller;
    requestRoute.current = null;
    setError(undefined);
    setBusy(true);
    try {
      const base = await discovery.getBaseUrl('governance');
      const response = await fetch(base + reconciliationPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(usageInput(livePreview)),
      });
      if (response.status === 400) {
        setError(
          'Saved reconciliations require source URLs without query strings or fragments.',
        );
        return;
      }
      if (!response.ok) throw new Error('Reconciliation unavailable');
      const result: SavedReconciliation = await response.json();
      if (controller.signal.aborted) return;
      setSaved(result);
      onPreview(undefined);
      setHistoryVersion(version => version + 1);
    } catch {
      if (!controller.signal.aborted)
        setError('The reconciliation could not be saved.');
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
        Upload CSV using the sample columns, or upload or paste JSON with UTC
        timestamps in <code>from</code> and <code>to</code> and up to 100{' '}
        <code>rows</code> with <code>sourceUrl</code>, <code>model</code>, and{' '}
        <code>calls</code> for each entry.
      </p>
      <a href={`${sampleUrl}.json`} download>
        Download sample usage JSON
      </a>
      {' · '}
      <a href={`${sampleUrl}.csv`} download>
        Download sample usage CSV
      </a>
      <form onSubmit={loadPreview}>
        <label>
          Upload usage file
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv,.json,application/json"
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
      <h3 ref={historyHeading} tabIndex={-1}>
        Saved reconciliations
      </h3>
      {history === undefined && (
        <p role="status">Loading saved reconciliations…</p>
      )}
      {history === null && <p>Saved reconciliations could not load.</p>}
      {history?.reconciliations.length === 0 && (
        <p>No saved reconciliations.</p>
      )}
      {!!history?.reconciliations.length && (
        <ul>
          {history.reconciliations.map(item => (
            <li key={item.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => openReconciliation(item.id)}
              >
                Open saved reconciliation from {item.from} to {item.to}
              </button>{' '}
              · <time dateTime={item.confirmedAt}>{item.confirmedAt}</time>
            </li>
          ))}
        </ul>
      )}
      {history?.nextCursor && (
        <button
          ref={loadOlderButton}
          type="button"
          disabled={loadingOlder}
          onClick={() => {
            if (history.nextCursor) void loadOlder(history.nextCursor);
          }}
        >
          {loadingOlder
            ? 'Loading older reconciliations…'
            : 'Load older reconciliations'}
        </button>
      )}
      {olderError && <p role="alert">Older reconciliations could not load.</p>}
      {preview && (
        <>
          {saved ? (
            <>
              <p role="status">
                Saved reconciliation ·{' '}
                <time dateTime={saved.confirmedAt}>{saved.confirmedAt}</time> ·{' '}
                {saved.confirmedBy}. Matches reflect Inventory at save time.
              </p>
              <Link
                to={{
                  pathname: '/',
                  search: new URLSearchParams({
                    view: 'reports',
                    [reconciliationParam]: saved.id,
                  }).toString(),
                }}
              >
                Direct link to saved reconciliation
              </Link>
              <button
                type="button"
                disabled={busy}
                onClick={() => void recheckSaved(saved)}
              >
                Recheck against current Inventory
              </button>
            </>
          ) : (
            <>
              <p>Current Inventory matches</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (livePreview?.savedReconciliationId)
                    openReconciliation(livePreview.savedReconciliationId);
                  else void saveReconciliation();
                }}
              >
                {livePreview?.savedReconciliationId
                  ? 'Open original reconciliation'
                  : 'Save reconciliation'}
              </button>
            </>
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

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { appRecordPath } from './appRecordPath';

export type HostedSnapshotApp = {
  name: string;
  provider: string;
  workspace: string;
  sourceUrl: string;
  appId?: string;
};

export function HostedSnapshotPreview({
  apps,
  onPreview,
  onRegister,
}: {
  apps: HostedSnapshotApp[] | undefined;
  onPreview: (snapshot: unknown, signal: AbortSignal) => Promise<void>;
  onRegister: (app: HostedSnapshotApp) => void;
}) {
  const [params] = useSearchParams();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError('');
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(String(new FormData(form).get('snapshot')));
    } catch {
      setError('Enter a valid JSON snapshot.');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      await onPreview(snapshot, controller.signal);
      if (!controller.signal.aborted) form.reset();
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(
        reason instanceof Error
          ? reason.message
          : 'The hosted snapshot could not be previewed.',
      );
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <section className="gov-panel" aria-labelledby="hosted-snapshot-title">
      <div className="gov-report-heading">
        <h2 id="hosted-snapshot-title">Hosted inventory snapshot</h2>
        <p>
          Paste a JSON object with an <code>apps</code> array. Each app needs a
          name, provider, workspace, and source URL (<code>sourceUrl</code>).
        </p>
      </div>
      <form onSubmit={preview}>
        <fieldset className="gov-fieldset" disabled={pending}>
          <legend>Preview snapshot</legend>
          <label>
            Snapshot JSON
            <textarea name="snapshot" required rows={4} spellCheck={false} />
          </label>
          <div>
            <button className="gov-button" type="submit">
              {pending ? 'Previewing snapshot…' : 'Preview hosted snapshot'}
            </button>
          </div>
        </fieldset>
      </form>
      {error && (
        <p className="gov-notice" role="alert">
          {error}
        </p>
      )}
      {apps && (
        <p role="status">
          {apps.length} {apps.length === 1 ? 'app' : 'apps'} in preview.
        </p>
      )}
      {!!apps?.length && (
        <div className="governance-table">
          <table aria-label="Hosted snapshot apps">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Workspace</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {apps.map(app => (
                <tr key={app.sourceUrl}>
                  <th scope="row">{app.name}</th>
                  <td data-label="Workspace">
                    {app.provider} · {app.workspace}
                  </td>
                  <td data-label="Status">
                    <span
                      className="gov-status"
                      data-status={app.appId ? 'approved' : 'pending'}
                    >
                      {app.appId ? 'Registered' : 'Unregistered'}
                    </span>
                  </td>
                  <td data-label="Action">
                    {app.appId ? (
                      <Link
                        className="gov-button"
                        to={appRecordPath(app.appId, params)}
                      >
                        View app record
                      </Link>
                    ) : (
                      <button
                        className="gov-button"
                        type="button"
                        onClick={() => onRegister(app)}
                      >
                        Register app
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

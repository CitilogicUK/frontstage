import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { appRecordPath } from './appRecordPath';

const settingLabels = {
  sharing: 'Sharing',
  dataAccess: 'Data access',
  dataClassification: 'Data classification',
};
const observedApprovalLabels = {
  approved: 'Observed settings meet workspace policy',
  'settings-mismatch': 'Observed settings outside workspace policy',
  unconfigured: 'Workspace policy is not configured',
  unlisted: 'Observed workspace is not listed in policy',
};
type Setting = keyof typeof settingLabels;
const settings = Object.keys(settingLabels) as Setting[];

export type HostedSnapshotApp = {
  name: string;
  provider: string;
  workspace: string;
  sourceUrl: string;
  sharing?: string;
  dataAccess?: string;
  dataClassification?: string;
  settingDifferences?: { field: Setting; registered: string | null }[];
  observedWorkspaceApproval?: keyof typeof observedApprovalLabels;
  appId?: string;
  mismatch?: 'app-type' | 'workspace';
  registeredWorkspace?: { provider: string; workspace: string };
};

export function HostedSnapshotPreview({
  apps,
  sampleUrl,
  onPreview,
  onRegister,
}: {
  apps: HostedSnapshotApp[] | undefined;
  sampleUrl: string;
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
    const data = new FormData(form);
    const pasted = String(data.get('snapshot') ?? '').trim();
    const selection = data.get('snapshotFile');
    const file =
      selection instanceof File && selection.name ? selection : undefined;
    if (file && pasted) {
      setError('Choose a snapshot file or paste JSON.');
      return;
    }
    if (!file && !pasted) {
      setError('Choose a snapshot file or enter JSON.');
      return;
    }
    if (file && file.size > 1024 * 1024) {
      setError('Choose a snapshot file no larger than 1 MB.');
      return;
    }
    await runPreview(async () => {
      const raw = file ? await file.text() : pasted;
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error('Enter a valid JSON snapshot.');
      }
    }, form);
  }

  async function runPreview(
    readSnapshot: () => unknown | Promise<unknown>,
    form?: HTMLFormElement,
  ) {
    const controller = new AbortController();
    request.current = controller;
    setError('');
    setPending(true);
    try {
      const snapshot = await readSnapshot();
      if (controller.signal.aborted) return;
      await onPreview(snapshot, controller.signal);
      if (!controller.signal.aborted) form?.reset();
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
          Upload or paste a JSON object with an <code>apps</code> array. Each
          app needs a name, provider, workspace, and source URL (
          <code>sourceUrl</code>). Include observed <code>sharing</code>,{' '}
          <code>dataAccess</code>, or <code>dataClassification</code> to compare
          settings.
        </p>
      </div>
      <a
        className="gov-button"
        href={sampleUrl}
        download="hosted-inventory.json"
      >
        Download sample JSON
      </a>
      <form onSubmit={preview}>
        <fieldset className="gov-fieldset" disabled={pending}>
          <legend>Preview snapshot</legend>
          <label>
            Snapshot file
            <input
              name="snapshotFile"
              type="file"
              accept=".json,application/json"
            />
          </label>
          <label>
            Snapshot JSON
            <textarea name="snapshot" rows={4} spellCheck={false} />
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
      {apps && (
        <button
          className="gov-button"
          type="button"
          disabled={pending}
          onClick={() =>
            runPreview(() => ({
              apps: apps.map(
                ({
                  name,
                  provider,
                  workspace,
                  sourceUrl,
                  sharing,
                  dataAccess,
                  dataClassification,
                }) => ({
                  name,
                  provider,
                  workspace,
                  sourceUrl,
                  sharing,
                  dataAccess,
                  dataClassification,
                }),
              ),
            }))
          }
        >
          Recheck snapshot
        </button>
      )}
      {!!apps?.length && (
        <div className="governance-table">
          <table aria-label="Hosted snapshot apps">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Workspace</th>
                <th scope="col">Observed settings</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {apps.map(app => (
                <tr key={app.sourceUrl}>
                  <th scope="row">{app.name}</th>
                  <td data-label="Workspace">
                    {app.registeredWorkspace ? (
                      <>
                        <div>
                          Snapshot: {app.provider} · {app.workspace}
                        </div>
                        <div>
                          Registered: {app.registeredWorkspace.provider} ·{' '}
                          {app.registeredWorkspace.workspace}
                        </div>
                      </>
                    ) : (
                      `${app.provider} · ${app.workspace}`
                    )}
                  </td>
                  <td data-label="Observed settings">
                    {settings.every(field => app[field] === undefined) &&
                      'No settings supplied'}
                    {settings.map(field => {
                      const observed = app[field];
                      if (observed === undefined) return null;
                      const difference = app.settingDifferences?.find(
                        item => item.field === field,
                      );
                      const label = settingLabels[field];
                      return (
                        <div key={field}>
                          <div>
                            {label}: {observed}
                          </div>
                          {difference && (
                            <div>
                              Registered {label.toLowerCase()}:{' '}
                              {difference.registered ?? 'Unrecorded'}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {app.observedWorkspaceApproval && (
                      <div>
                        {observedApprovalLabels[app.observedWorkspaceApproval]}
                      </div>
                    )}
                    {!app.observedWorkspaceApproval &&
                      settings.some(field => app[field] !== undefined) && (
                        <div>
                          Supply sharing and data access to check workspace
                          policy.
                        </div>
                      )}
                  </td>
                  <td data-label="Status">
                    <span
                      className="gov-status"
                      data-status={
                        app.appId &&
                        !app.mismatch &&
                        !app.settingDifferences?.length &&
                        app.observedWorkspaceApproval !== 'settings-mismatch' &&
                        app.observedWorkspaceApproval !== 'unlisted'
                          ? 'approved'
                          : 'pending'
                      }
                    >
                      {app.mismatch === 'app-type' && 'App type mismatch'}
                      {app.mismatch === 'workspace' &&
                        'Provider or workspace mismatch'}
                      {!app.mismatch &&
                        !!app.settingDifferences?.length &&
                        'Settings differ from record'}
                      {!app.mismatch &&
                        !app.settingDifferences?.length &&
                        (app.appId ? 'Registered' : 'Unregistered')}
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

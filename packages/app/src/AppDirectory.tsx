import { useEffect, useState, type FormEvent } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { WorkspaceEmptyState, WorkspaceSearch } from './WorkspaceLayout';

export type DirectoryListing = { summary: string; url: string };
type DirectoryApp = DirectoryListing & { id: string; name: string };

export function AppDirectory() {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [apps, setApps] = useState<DirectoryApp[]>();
  const [query, setQuery] = useState('');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    discovery
      .getBaseUrl('governance')
      .then(base => fetch(`${base}/directory`, { signal: controller.signal }))
      .then(async response => {
        if (!response.ok) throw new Error('Could not load the app directory.');
        const result: { apps: DirectoryApp[] } = await response.json();
        if (!controller.signal.aborted) setApps(result.apps);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [attempt, discovery, fetch]);

  const needle = query.trim().toLowerCase();
  const matches = apps?.filter(app =>
    [app.name, app.summary].some(value => value.toLowerCase().includes(needle)),
  );

  return (
    <section className="gov-panel" aria-label="Directory apps">
      <WorkspaceSearch
        label="Search directory"
        placeholder="Search apps"
        value={query}
        onChange={setQuery}
        count={matches?.length}
      />
      {failed && (
        <div className="gov-empty">
          <p role="alert">The app directory could not load.</p>
          <button type="button" onClick={() => setAttempt(value => value + 1)}>
            Retry loading Directory
          </button>
        </div>
      )}
      {!failed && !apps && (
        <p className="gov-empty" role="status">
          Loading apps…
        </p>
      )}
      {matches?.length === 0 && (
        <WorkspaceEmptyState
          icon={null}
          title={needle ? 'No matching apps' : 'No apps listed'}
          description={needle ? 'Try a different name or summary.' : undefined}
        />
      )}
      {!!matches?.length && (
        <div className="governance-table">
          <table>
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Launch</th>
              </tr>
            </thead>
            <tbody>
              {matches.map(app => (
                <tr key={app.id}>
                  <td className="gov-app-cell">
                    <strong>{app.name}</strong>
                    <p>{app.summary}</p>
                  </td>
                  <td data-label="Launch">
                    <a
                      className="gov-button"
                      href={app.url}
                      aria-label={`Open ${app.name}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open app
                    </a>
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

export function AppDirectoryPublisher({
  listing,
  updatedAt,
  busy,
  onPublish,
  onUnpublish,
}: {
  listing?: DirectoryListing;
  updatedAt: string;
  busy: boolean;
  onPublish: (event: FormEvent<HTMLFormElement>) => void;
  onUnpublish: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <details className="gov-app-editor">
      <summary>Directory listing</summary>
      <p>
        Signed-in users can see the app name, directory summary and launch URL.
        Access is managed by the destination app.
      </p>
      {listing && <p>Directory listing saved.</p>}
      <form key={updatedAt} onSubmit={onPublish}>
        <label>
          Directory summary
          <textarea
            name="summary"
            required
            maxLength={500}
            defaultValue={listing?.summary}
          />
        </label>
        <label>
          Launch URL
          <input
            name="url"
            type="url"
            required
            maxLength={2048}
            placeholder="https://…"
            defaultValue={listing?.url}
          />
          <small>Use an HTTPS URL.</small>
        </label>
        <button disabled={busy}>
          {listing ? 'Update directory listing' : 'Publish in Directory'}
        </button>
      </form>
      {listing && (
        <form onSubmit={onUnpublish}>
          <button disabled={busy}>Unpublish from Directory</button>
        </form>
      )}
    </details>
  );
}

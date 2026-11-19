import { useEffect, useState, type FormEvent } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { useSearchParams } from 'react-router-dom';
import {
  WorkspaceEmptyState,
  WorkspaceFilterTabs,
  WorkspaceSearch,
} from './WorkspaceLayout';
import {
  DirectoryRequestAction,
  type DirectoryRequestStatus,
} from './DirectoryAccessRequests';

export type DirectoryListing = { summary: string; url: string };
type DirectoryApp = DirectoryListing & {
  id: string;
  name: string;
  requestStatus?: DirectoryRequestStatus;
  requestId?: string;
};
type UnavailableRequest = Pick<DirectoryApp, 'id' | 'name' | 'requestId'> & {
  requestStatus: DirectoryRequestStatus;
};
type DirectoryFeed = {
  apps: DirectoryApp[];
  unavailableRequests?: UnavailableRequest[];
};

export function AppDirectory() {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [feed, setFeed] = useState<DirectoryFeed>();
  const apps = feed?.apps;
  const [query, setQuery] = useState('');
  const [params, setParams] = useSearchParams();
  const requestView = params.get('directoryAccess') === 'mine';
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    discovery
      .getBaseUrl('governance')
      .then(base => fetch(`${base}/directory`, { signal: controller.signal }))
      .then(async response => {
        if (!response.ok) throw new Error('Could not load the app directory.');
        const result: DirectoryFeed = await response.json();
        if (!controller.signal.aborted) setFeed(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [attempt, discovery, fetch]);

  const needle = query.trim().toLowerCase();
  const myRequests =
    feed &&
    [
      ...feed.apps.filter(app => app.requestStatus),
      ...(feed.unavailableRequests ?? []),
    ].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const matches = (requestView ? myRequests : apps)?.filter(
    app =>
      app.name.toLowerCase().includes(needle) ||
      ('summary' in app && app.summary.toLowerCase().includes(needle)),
  );
  let emptyTitle = 'No apps listed';
  let emptyDescription;
  if (requestView) {
    emptyTitle = 'No access requests';
    emptyDescription = 'Open All apps to find an app and request access.';
  }
  if (needle && (requestView ? myRequests?.length : apps?.length)) {
    emptyTitle = 'No matching apps';
    emptyDescription = 'Try a different name or summary.';
  }

  return (
    <section className="gov-panel" aria-label="Directory apps">
      <WorkspaceSearch
        label="Search directory"
        placeholder="Search apps"
        value={query}
        onChange={setQuery}
        count={matches?.length}
      />
      {apps && (
        <WorkspaceFilterTabs
          label="Directory view"
          value={requestView ? 'mine' : 'all'}
          onChange={value =>
            setParams(previous => {
              const next = new URLSearchParams(previous);
              if (value === 'mine') next.set('directoryAccess', 'mine');
              else next.delete('directoryAccess');
              return next;
            })
          }
          options={[
            { value: 'all', label: 'All apps', count: apps.length },
            { value: 'mine', label: 'My requests', count: myRequests?.length },
          ]}
        />
      )}
      {notice && <p role="status">{notice}</p>}
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
          title={emptyTitle}
          description={emptyDescription}
        />
      )}
      {!!matches?.length && (
        <div className="governance-table">
          <table>
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Launch</th>
                <th scope="col">Access</th>
              </tr>
            </thead>
            <tbody>
              {matches.map(app => (
                <tr key={app.id}>
                  <td className="gov-app-cell">
                    <strong>{app.name}</strong>
                    {'summary' in app && <p>{app.summary}</p>}
                  </td>
                  <td data-label="Launch">
                    {'url' in app ? (
                      <a
                        className="gov-button"
                        href={app.url}
                        aria-label={`Open ${app.name}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open app
                      </a>
                    ) : (
                      'Listing unavailable'
                    )}
                  </td>
                  <td
                    className="gov-directory-request-cell"
                    data-label="Access"
                  >
                    <DirectoryRequestAction
                      appId={app.id}
                      status={app.requestStatus}
                      withdrawRequestId={
                        requestView ? app.requestId : undefined
                      }
                      onSaved={({ id, status }) => {
                        setNotice('');
                        setFeed(
                          previous =>
                            previous && {
                              ...previous,
                              apps: previous.apps.map(item =>
                                item.id === app.id
                                  ? {
                                      ...item,
                                      requestId: id,
                                      requestStatus: status,
                                    }
                                  : item,
                              ),
                            },
                        );
                      }}
                      onWithdrawn={() => {
                        setFeed(
                          previous =>
                            previous && {
                              ...previous,
                              apps: previous.apps.map(item =>
                                item.id === app.id
                                  ? {
                                      ...item,
                                      requestStatus: undefined,
                                      requestId: undefined,
                                    }
                                  : item,
                              ),
                              unavailableRequests:
                                previous.unavailableRequests?.filter(
                                  item => item.id !== app.id,
                                ),
                            },
                        );
                        setNotice(`Access request withdrawn for ${app.name}.`);
                      }}
                    />
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
  launchEligible,
  updatedAt,
  busy,
  onPublish,
  onUnpublish,
}: {
  listing?: DirectoryListing;
  launchEligible: boolean;
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
      {!launchEligible && (
        <p>
          {listing
            ? 'This listing is hidden until the app meets current launch requirements.'
            : 'Meet the current launch requirements to publish this app.'}
        </p>
      )}
      {listing && launchEligible && <p>Directory listing saved.</p>}
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
        <button disabled={busy || !launchEligible}>
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

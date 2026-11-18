import { useState } from 'react';
import { Link } from 'react-router-dom';
import { appRecordPath } from './appRecordPath';
import SearchIcon from '@material-ui/icons/Search';
import {
  WorkspaceEmptyState,
  WorkspaceFilterTabs,
  WorkspaceRecordTitle,
  WorkspaceSearch,
} from './WorkspaceLayout';

export type DiscoveryResult = {
  source: { organization: string; topic: string } | null;
  intervalMinutes: number | null;
  lastScan: {
    at: string;
    status: 'completed' | 'failed';
    trigger: 'manual' | 'scheduled';
    found?: number;
    partial?: boolean;
  } | null;
  repositories: Array<{
    id: string;
    sourceUrl: string;
    name: string;
    description: string;
    appId: string | null;
    dismissed: 0 | 1;
    dismissalReason?: string | null;
  }>;
};

export function DiscoveryQueue({
  result,
  canReview,
  busy,
  onScan,
  onDecision,
}: {
  result?: DiscoveryResult;
  canReview: boolean;
  busy: boolean;
  onScan: () => void;
  onDecision: (id: string, reason: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('unowned');
  const counts = { unowned: 0, dismissed: 0, registered: 0 };
  const search = query.trim().toLowerCase();
  const matches = result?.repositories.filter(repository => {
    let status: keyof typeof counts = 'unowned';
    if (repository.appId) status = 'registered';
    else if (repository.dismissed) status = 'dismissed';
    counts[status] += 1;
    return (
      (filter === 'all' || filter === status) &&
      [repository.name, repository.description].some(value =>
        value.toLowerCase().includes(search),
      )
    );
  });
  const eligible = counts.registered + counts.unowned;

  return (
    <section className="gov-panel" aria-label="Discovered repositories">
      {result?.source && (
        <div className="gov-discovery-source">
          <div>
            <p>
              GitHub · {result.source.organization} · {result.source.topic}
            </p>
            {result.intervalMinutes && (
              <p>Scheduled every {result.intervalMinutes} minutes</p>
            )}
            {result.lastScan ? (
              <p>
                Last {result.lastScan.trigger} scan {result.lastScan.status} ·{' '}
                {new Date(result.lastScan.at).toLocaleString()}
                {result.lastScan.partial && ' · Partial results'}
              </p>
            ) : (
              <p>No scans recorded yet.</p>
            )}
            {eligible > 0 && (
              <p>
                {counts.registered} of {eligible} tracked repositories
                registered
                {' · '}
                {Math.round((counts.registered / eligible) * 100)}% coverage
                {counts.dismissed > 0 && ' · Excludes dismissed repositories'}
              </p>
            )}
          </div>
          {canReview && (
            <button
              type="button"
              className="gov-primary"
              disabled={busy}
              onClick={onScan}
            >
              {busy ? 'Scanning GitHub…' : 'Scan GitHub'}
            </button>
          )}
        </div>
      )}
      {result?.source && (
        <WorkspaceSearch
          label="Search discoveries"
          placeholder="Search repositories…"
          value={query}
          onChange={setQuery}
          count={matches?.length}
        />
      )}
      {result?.source && (
        <WorkspaceFilterTabs
          label="Discovery status"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'unowned', label: 'Unowned', count: counts.unowned },
            { value: 'dismissed', label: 'Dismissed', count: counts.dismissed },
            {
              value: 'registered',
              label: 'Registered',
              count: counts.registered,
            },
            {
              value: 'all',
              label: 'All repositories',
              count: eligible + counts.dismissed,
            },
          ]}
        />
      )}
      {!result && (
        <p className="gov-empty" role="status">
          Loading discovery…
        </p>
      )}
      {result && !result.source && (
        <WorkspaceEmptyState
          icon={<SearchIcon aria-hidden="true" />}
          title="GitHub discovery is disabled"
          description="No GitHub source is configured for this workspace."
        />
      )}
      {result?.source && matches?.length === 0 && (
        <WorkspaceEmptyState
          icon={<SearchIcon aria-hidden="true" />}
          title="No matching repositories"
          description="Try another status or search."
        />
      )}
      {!!matches?.length && (
        <div className="governance-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {matches.map(repository => (
                <tr key={repository.id}>
                  <td className="gov-app-cell">
                    <a className="gov-app-link" href={repository.sourceUrl}>
                      <WorkspaceRecordTitle
                        title={repository.name}
                        description={repository.description}
                        icon={<SearchIcon />}
                      />
                    </a>
                  </td>
                  <td data-label="Status">
                    <span
                      className="gov-status"
                      data-status={repository.appId ? 'approved' : 'pending'}
                    >
                      {repository.appId && 'Registered'}
                      {!repository.appId &&
                        (repository.dismissed ? 'Dismissed' : 'Unowned')}
                    </span>
                  </td>
                  <td data-label="Action">
                    {repository.appId && (
                      <Link
                        className="gov-button"
                        to={appRecordPath(repository.appId, 'discovery')}
                      >
                        Open app record
                      </Link>
                    )}
                    {!repository.appId && !repository.dismissed && (
                      <Link
                        className="gov-button"
                        to={`/?view=register&repository=${encodeURIComponent(
                          repository.id,
                        )}`}
                      >
                        Claim repository
                      </Link>
                    )}
                    {!repository.appId &&
                      canReview &&
                      !!repository.dismissed && (
                        <>
                          {repository.dismissalReason && (
                            <p>{repository.dismissalReason}</p>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onDecision(repository.id, null)}
                          >
                            Reopen repository
                          </button>
                        </>
                      )}
                    {!repository.appId &&
                      canReview &&
                      !repository.dismissed && (
                        <details>
                          <summary>Dismiss repository</summary>
                          <form
                            onSubmit={event => {
                              event.preventDefault();
                              const reason = String(
                                new FormData(event.currentTarget).get(
                                  'reason',
                                ) ?? '',
                              ).trim();
                              if (reason) onDecision(repository.id, reason);
                            }}
                          >
                            <label>
                              Dismissal reason
                              <input name="reason" required maxLength={500} />
                            </label>
                            <button disabled={busy}>Confirm dismissal</button>
                          </form>
                        </details>
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

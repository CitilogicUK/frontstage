import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { appRecordPath } from './appRecordPath';
import { formatDiscoveryCoverage } from './discoveryCoverage';
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

type SdkEvidenceResult = {
  manifests: Array<{
    path: 'package.json' | 'requirements.txt' | 'pyproject.toml';
    status: 'checked' | 'missing' | 'unavailable';
    packages: string[];
  }>;
};

function manifestSummary(manifest: SdkEvidenceResult['manifests'][number]) {
  if (manifest.status === 'missing') return 'Manifest missing.';
  if (manifest.status === 'unavailable') return 'Manifest unavailable.';
  return manifest.packages.length
    ? manifest.packages.join(', ')
    : 'No recognized AI SDK dependencies.';
}

function RepositorySdkEvidence({
  load,
}: {
  load: () => Promise<SdkEvidenceResult>;
}) {
  const [check, setCheck] = useState<
    | { status: 'loading' | 'error' }
    | { status: 'checked'; result: SdkEvidenceResult }
  >();

  async function checkDependencies() {
    setCheck({ status: 'loading' });
    try {
      setCheck({ status: 'checked', result: await load() });
    } catch {
      setCheck({ status: 'error' });
    }
  }

  return (
    <section
      className="gov-discovery-sdk"
      aria-label="AI SDK dependency evidence"
    >
      <button
        type="button"
        onClick={checkDependencies}
        disabled={check?.status === 'loading'}
      >
        Check AI SDK dependencies
      </button>
      {check?.status === 'loading' && (
        <p role="status">Checking AI SDK dependencies…</p>
      )}
      {check?.status === 'error' && (
        <p role="alert">
          The AI SDK dependency check could not be completed. Try again.
        </p>
      )}
      {check?.status === 'checked' && (
        <div role="status">
          <dl>
            {check.result.manifests.map(manifest => (
              <div key={manifest.path}>
                <dt>{manifest.path}</dt>
                <dd>{manifestSummary(manifest)}</dd>
              </div>
            ))}
          </dl>
          <p>Dependency evidence does not establish runtime AI use.</p>
        </div>
      )}
    </section>
  );
}

function repositoryStatus(repository: DiscoveryResult['repositories'][number]) {
  if (repository.appId) return 'registered';
  return repository.dismissed ? 'dismissed' : 'unowned';
}

export function discoveryCounts(repositories: DiscoveryResult['repositories']) {
  const counts = { unowned: 0, dismissed: 0, registered: 0 };
  for (const repository of repositories)
    counts[repositoryStatus(repository)] += 1;
  return { ...counts, eligible: counts.registered + counts.unowned };
}

const repositoriesPerPage = 25;

export function DiscoveryQueue({
  result,
  canReview,
  busy,
  onScan,
  onDecision,
  onCheckSdkEvidence,
}: {
  result?: DiscoveryResult;
  canReview: boolean;
  busy: boolean;
  onScan: () => void;
  onDecision: (id: string, reason: string | null) => void;
  onCheckSdkEvidence: (id: string) => Promise<SdkEvidenceResult>;
}) {
  const [query, setQuery] = useState('');
  const [params, setParams] = useSearchParams();
  const requestedFilter = params.get('discoveryStatus');
  const filter =
    requestedFilter === 'registered' ||
    requestedFilter === 'dismissed' ||
    requestedFilter === 'all'
      ? requestedFilter
      : 'unowned';
  function setFilter(value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value === 'unowned') next.delete('discoveryStatus');
      else next.set('discoveryStatus', value);
      next.delete('discoveryPage');
      return next;
    });
  }
  const counts = discoveryCounts(result?.repositories ?? []);
  const search = query.trim().toLowerCase();
  const matches = result?.repositories.filter(repository => {
    const status = repositoryStatus(repository);
    return (
      (filter === 'all' || filter === status) &&
      [repository.name, repository.description].some(value =>
        value.toLowerCase().includes(search),
      )
    );
  });
  const totalMatches = matches?.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalMatches / repositoriesPerPage));
  const requestedPage = params.get('discoveryPage') ?? '';
  const page = /^[1-9]\d*$/.test(requestedPage)
    ? Math.min(pageCount, Number(requestedPage))
    : 1;
  const start = (page - 1) * repositoriesPerPage;
  const end = Math.min(start + repositoriesPerPage, totalMatches);
  const shownRange = start + 1 === end ? end : `${start + 1}–${end}`;
  const visibleRepositories = matches?.slice(start, end);
  const { eligible } = counts;

  function searchRepositories(value: string) {
    setQuery(value);
    if (!params.has('discoveryPage')) return;
    const next = new URLSearchParams(params);
    next.delete('discoveryPage');
    setParams(next, { replace: true });
  }

  function setPage(value: number) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value <= 1) next.delete('discoveryPage');
      else next.set('discoveryPage', String(value));
      return next;
    });
  }

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
                {formatDiscoveryCoverage(counts.registered, eligible)} coverage
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
          onChange={searchRepositories}
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
      {pageCount > 1 && (
        <div
          className="gov-discovery-pagination"
          role="group"
          aria-label="Repository pages"
        >
          <button
            type="button"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Previous page
          </button>
          <span role="status">
            {shownRange} of {totalMatches}
          </span>
          <button
            type="button"
            disabled={page === pageCount}
            onClick={() => setPage(page + 1)}
          >
            Next page
          </button>
        </div>
      )}
      {!!visibleRepositories?.length && (
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
              {visibleRepositories.map(repository => (
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
                        to={appRecordPath(repository.appId, params)}
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
                    {(repository.appId || !repository.dismissed) && (
                      <RepositorySdkEvidence
                        load={() => onCheckSdkEvidence(repository.id)}
                      />
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

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import AppsIcon from '@material-ui/icons/Apps';
import CloseIcon from '@material-ui/icons/Close';
import { useSearchParams } from 'react-router-dom';
import {
  WorkspaceEmptyState,
  WorkspaceFilterTabs,
  WorkspaceLayout,
  WorkspaceRecordTitle,
  WorkspaceSearch,
  workspaceViews,
} from './WorkspaceLayout';

type App = {
  id: string;
  name: string;
  purpose: string;
  platform: string;
  sourceUrl: string;
  owner: string;
  backupOwner?: string;
  classification: string;
  effectiveClassification?: string;
  models: string[];
  tier: number;
  reviewStatus: string;
  lifecycle: string;
  nextReview: string | null;
  updatedAt: string;
  reviewNotes?: string;
};

const classes = ['public', 'internal', 'confidential', 'restricted'];
const audiences = ['personal', 'team', 'company', 'external'];
const sharing = ['private', 'named people', 'company', 'public link'];

type View = Exclude<keyof typeof workspaceViews, 'Catalog'>;

const viewParameters = new Map<string, View>([
  ['register', 'Register'],
  ['reviews', 'Reviews'],
  ['import', 'Import'],
  ['guide', 'Builder guide'],
]);

const tierNames = ['Personal', 'Shared', 'Critical'];

function appOwner(ref: string) {
  return ref.replace(/^user:default\//, '');
}

function RiskBadge({ tier }: { tier: number }) {
  return (
    <span className="gov-badge" data-tier={tier}>
      T{tier} · {tierNames[tier - 1]}
    </span>
  );
}

function options(values: string[]) {
  return values.map(value => <option key={value}>{value}</option>);
}

export function GovernancePage() {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [apps, setApps] = useState<App[]>([]);
  const [actor, setActor] = useState('');
  const [canReview, setCanReview] = useState(false);
  const [params, setParams] = useSearchParams();
  const view = viewParameters.get(params.get('view') ?? '') ?? 'Inventory';
  const [query, setQuery] = useState('');
  const [tier, setTier] = useState('');
  const [reviewFilter, setReviewFilter] = useState('attention');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [riskPreview, setRiskPreview] = useState<{
    answers: string;
    tier?: number;
  }>();
  const [selected, setSelected] = useState<App>();
  const [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const detailOpen = Boolean(selected);

  useEffect(() => {
    if (detailOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [detailOpen]);

  const api = useCallback(
    async (path: string, body?: unknown, method = 'POST') => {
      const base = await discovery.getBaseUrl('governance');
      const response = await fetch(
        base + path,
        body === undefined
          ? undefined
          : {
              method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? 'The request failed.');
      return result;
    },
    [discovery, fetch],
  );

  async function refresh() {
    const result = await api('/apps');
    setApps(result.apps);
    setActor(result.actor ?? '');
    setCanReview(result.canReview);
  }

  useEffect(() => {
    refresh()
      .catch(reason => setError(String(reason)))
      .finally(() => setLoading(false));
    // The Backstage APIs are stable for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetView() {
    setQuery('');
    setTier('');
    setReviewFilter('attention');
    setError('');
    setMessage('');
    setSelected(undefined);
    setDraft({});
  }

  function navigate(target: View) {
    if (target === view) return;
    resetView();
    setParams(workspaceViews[target].path.split('?')[1] ?? '');
  }

  useEffect(() => {
    setQuery('');
    setTier('');
    setReviewFilter('attention');
    setSelected(undefined);
    setDraft({});
  }, [view]);

  async function submit(
    event: FormEvent<HTMLFormElement>,
    action: (data: FormData) => Promise<void>,
  ) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action(new FormData(event.currentTarget));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const hosted = draft.type === 'provider-hosted app';
  const answers = JSON.stringify({
    audience: draft.audience || audiences[0],
    classification: draft.classification || classes[0],
    connections: draft.connections ? [{ access: draft.connections }] : [],
    takesActions: !!draft.takesActions,
    affectsPeople: !!draft.affectsPeople,
    personalData: !!draft.personalData,
    critical: !!draft.critical,
    hosted: hosted
      ? {
          sharing: draft.sharing || sharing[0],
          dataClassification: draft.hostedClass || undefined,
        }
      : undefined,
  });
  const preview = riskPreview?.answers === answers ? riskPreview : undefined;

  useEffect(() => {
    if (view !== 'Register') return undefined;
    let current = true;
    const timer = window.setTimeout(() => {
      api('/tier-preview', JSON.parse(answers)).then(
        result => {
          if (current) setRiskPreview({ answers, tier: result.tier });
        },
        () => {
          if (current) setRiskPreview({ answers });
        },
      );
    }, 200);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [answers, api, view]);

  const needsReview = (app: App) =>
    app.reviewStatus !== 'approved' ||
    Boolean(app.nextReview && Date.parse(app.nextReview) <= Date.now());
  const matching = apps.filter(
    app =>
      (view !== 'Reviews' ||
        (app.tier === 3 &&
          app.lifecycle !== 'retired' &&
          (reviewFilter !== 'attention' || needsReview(app)))) &&
      (!tier || view === 'Reviews' || String(app.tier) === tier) &&
      [
        app.name,
        app.purpose,
        app.owner,
        app.platform,
        app.effectiveClassification ?? app.classification,
        ...app.models,
      ].some(value => value.toLowerCase().includes(query.trim().toLowerCase())),
  );

  let emptyTitle = 'No registered apps';
  let emptyMessage = 'Register an app to add it to the inventory.';
  if (view === 'Reviews') {
    emptyTitle =
      reviewFilter === 'attention'
        ? 'No reviews need attention'
        : 'No critical apps';
    emptyMessage = 'Critical apps appear here after registration.';
  }
  if (query || tier) {
    emptyTitle = 'No matching apps';
    emptyMessage = 'Try another search or clear the filters.';
  }

  return (
    <WorkspaceLayout view={view} onNavigate={resetView}>
      {error && !selected && (
        <p className="gov-notice" role="alert">
          {error}
        </p>
      )}
      {message && !selected && (
        <p className="gov-notice" role="status">
          {message}
        </p>
      )}
      {(view === 'Inventory' || view === 'Reviews') && (
        <section
          aria-label={workspaceViews[view].title}
          className="gov-inventory"
        >
          <div className="gov-panel">
            <WorkspaceSearch
              label="Search apps"
              placeholder="Search apps, owners, models…"
              value={query}
              onChange={setQuery}
              count={loading ? undefined : matching.length}
            >
              {view === 'Reviews' && (
                <label>
                  <span className="gov-visually-hidden">Review status</span>
                  <select
                    value={reviewFilter}
                    onChange={event => setReviewFilter(event.target.value)}
                  >
                    <option value="attention">Needs attention</option>
                    <option value="all">All critical apps</option>
                  </select>
                </label>
              )}
            </WorkspaceSearch>
            {view === 'Inventory' && !loading && !error && (
              <WorkspaceFilterTabs
                label="Risk tiers"
                value={tier}
                onChange={setTier}
                options={[
                  { value: '', label: 'All apps', count: apps.length },
                  ...tierNames.map((label, index) => ({
                    value: String(index + 1),
                    label,
                    count: apps.filter(app => app.tier === index + 1).length,
                  })),
                ]}
              />
            )}
            {loading && (
              <div className="gov-empty" role="status">
                Loading apps…
              </div>
            )}
            {!loading && matching.length === 0 && (
              <WorkspaceEmptyState
                icon={<AppsIcon aria-hidden="true" />}
                title={emptyTitle}
                description={emptyMessage}
              >
                {(query || tier) && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      setTier('');
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </WorkspaceEmptyState>
            )}
            {!loading && matching.length > 0 && (
              <div className="governance-table">
                <table>
                  <thead>
                    <tr>
                      <th>App</th>
                      <th>Owner</th>
                      <th>Platform</th>
                      <th>Data</th>
                      <th>Risk</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matching.map(app => (
                      <tr key={app.id}>
                        <td className="gov-app-cell">
                          <button
                            type="button"
                            className="gov-app-link"
                            aria-haspopup="dialog"
                            onClick={() => {
                              setError('');
                              setMessage('');
                              setSelected(app);
                            }}
                          >
                            <WorkspaceRecordTitle
                              title={app.name}
                              description={app.purpose}
                              icon={<AppsIcon />}
                            />
                          </button>
                        </td>
                        <td data-label="Owner" title={app.owner}>
                          {appOwner(app.owner)}
                        </td>
                        <td data-label="Platform">{app.platform}</td>
                        <td data-label="Data">
                          {app.effectiveClassification ?? app.classification}
                        </td>
                        <td data-label="Risk">
                          <RiskBadge tier={app.tier} />
                        </td>
                        <td data-label="Review">
                          <span
                            className="gov-status"
                            data-status={app.reviewStatus}
                          >
                            {app.reviewStatus}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <dialog
            ref={dialog}
            className="governance-detail"
            aria-labelledby="gov-detail-title"
            onClose={() => {
              setSelected(undefined);
              setError('');
            }}
          >
            {selected && (
              <article>
                <div className="gov-dialog-heading">
                  <RiskBadge tier={selected.tier} />
                  <button
                    type="button"
                    className="gov-icon-button"
                    aria-label="Close app details"
                    onClick={() => dialog.current?.close()}
                  >
                    <CloseIcon aria-hidden="true" />
                  </button>
                </div>
                <h2 id="gov-detail-title">{selected.name}</h2>
                <p>{selected.purpose}</p>
                {error && (
                  <p className="gov-notice" role="alert">
                    {error}
                  </p>
                )}
                {message && (
                  <p className="gov-notice" role="status">
                    {message}
                  </p>
                )}
                <p>
                  {selected.lifecycle} · {selected.models.join(', ')} ·{' '}
                  <a href={selected.sourceUrl}>Open source</a>
                </p>
                {selected.nextReview && (
                  <p>Next review due {selected.nextReview.slice(0, 10)}.</p>
                )}
                {selected.reviewNotes && <p>{selected.reviewNotes}</p>}
                {(actor === selected.owner || canReview) && (
                  <form
                    key={`${selected.id}-lifecycle`}
                    onSubmit={event =>
                      submit(event, async data => {
                        setSelected(
                          await api(
                            `/apps/${selected.id}/lifecycle`,
                            { lifecycle: data.get('lifecycle') },
                            'PATCH',
                          ),
                        );
                        await refresh();
                        setMessage('Lifecycle updated.');
                      })
                    }
                  >
                    <label>
                      Lifecycle
                      <select
                        name="lifecycle"
                        defaultValue={selected.lifecycle}
                      >
                        {options([
                          'experimental',
                          'active',
                          'deprecated',
                          'retired',
                        ])}
                      </select>
                    </label>
                    <button disabled={busy}>Update lifecycle</button>
                  </form>
                )}
                {canReview &&
                  actor !== selected.owner &&
                  actor !== selected.backupOwner &&
                  selected.tier === 3 && (
                    <form
                      key={selected.id}
                      onSubmit={event =>
                        submit(event, async data => {
                          setSelected(
                            await api(`/apps/${selected.id}/reviews`, {
                              status: data.get('status'),
                              notes: data.get('notes'),
                              expectedUpdatedAt: selected.updatedAt,
                            }),
                          );
                          await refresh();
                          setMessage('Review recorded.');
                        })
                      }
                    >
                      <label>
                        Decision
                        <select name="status">
                          {options(['approved', 'changes needed'])}
                        </select>
                      </label>
                      <label>
                        Review notes
                        <textarea name="notes" required />
                      </label>
                      <button disabled={busy}>Record decision</button>
                    </form>
                  )}
              </article>
            )}
          </dialog>
        </section>
      )}
      {view === 'Register' && (
        <section className="gov-registration" aria-label="App registration">
          <aside className="gov-risk" aria-label="Registration requirements">
            <h2>Risk assessment</h2>
            <p aria-live="polite">
              {!preview && 'Calculating risk tier…'}
              {preview &&
                !preview.tier &&
                'Risk preview unavailable. The tier is calculated at registration.'}
              {preview?.tier &&
                `Estimated risk tier ${preview.tier} · ${
                  ['Personal', 'Shared', 'Critical'][preview.tier - 1]
                }`}
            </p>
            {preview?.tier === 2 && (
              <p>Shared apps need a backup owner and a yearly attestation.</p>
            )}
            {preview?.tier === 3 && (
              <p>
                Add a backup owner. This app must be approved before it can go
                live.
              </p>
            )}
          </aside>
          <form
            className="gov-register-form"
            onChange={event => {
              const target = event.target as HTMLInputElement;
              if (target.name)
                setDraft(previous => ({
                  ...previous,
                  ...(target.name === 'type'
                    ? { sharing: '', dataAccess: '', hostedClass: '' }
                    : {}),
                  ...(target.name === 'dataAccess' && target.value === 'none'
                    ? { hostedClass: '' }
                    : {}),
                  [target.name]:
                    target.type === 'checkbox' && !target.checked
                      ? ''
                      : target.value,
                }));
            }}
            onSubmit={event =>
              submit(event, async data => {
                const value = (key: string) =>
                  String(data.get(key) ?? '').trim();
                await api('/apps', {
                  name: value('name'),
                  purpose: value('purpose'),
                  type: value('type'),
                  platform: value('platform'),
                  sourceUrl: value('sourceUrl'),
                  owner: value('owner'),
                  backupOwner: value('backupOwner') || undefined,
                  team: value('team'),
                  lifecycle: 'experimental',
                  audience: value('audience'),
                  classification: value('classification'),
                  models: value('models')
                    .split(',')
                    .map(model => model.trim()),
                  connections: value('connections')
                    ? [
                        {
                          name: value('system'),
                          access: value('connections'),
                        },
                      ]
                    : [],
                  takesActions: data.has('takesActions'),
                  actionDescription: value('actionDescription') || undefined,
                  affectsPeople: data.has('affectsPeople'),
                  critical: data.has('critical'),
                  personalData: data.has('personalData'),
                  hosted: hosted
                    ? {
                        provider: value('provider'),
                        workspace: value('workspace'),
                        sharing: value('sharing'),
                        dataAccess: value('dataAccess'),
                        dataClassification: value('hostedClass') || undefined,
                      }
                    : undefined,
                });
                await refresh();
                setDraft({});
                navigate('Inventory');
                setMessage('App registered.');
              })
            }
          >
            <fieldset className="gov-fieldset">
              <legend>App details</legend>
              <label>
                App name
                <input required name="name" maxLength={100} />
              </label>
              <label>
                Purpose
                <textarea required name="purpose" maxLength={1000} />
              </label>
              <div className="governance-fields">
                <label>
                  App type
                  <select name="type">
                    {options([
                      'assistant',
                      'agent',
                      'automation',
                      'app',
                      'provider-hosted app',
                      'integration',
                    ])}
                  </select>
                </label>
                <label>
                  Built on
                  <input
                    required
                    name="platform"
                    placeholder="Code repo, Copilot Studio, Claude…"
                  />
                </label>
                <label>
                  Source URL
                  <input required name="sourceUrl" type="url" />
                </label>
                <label>
                  Models
                  <input
                    required
                    name="models"
                    placeholder="Enter model names separated by commas"
                  />
                </label>
              </div>
            </fieldset>
            <fieldset className="gov-fieldset">
              <legend>Ownership</legend>
              <div className="governance-fields">
                <label>
                  Owner
                  <input
                    required
                    name="owner"
                    defaultValue={actor}
                    placeholder="user:default/name"
                  />
                </label>
                <label>
                  Owning team
                  <input
                    required
                    name="team"
                    placeholder="group:default/team"
                  />
                </label>
                <label>
                  Backup owner (required for tiers 2 and 3)
                  <input
                    required={(preview?.tier ?? 1) >= 2}
                    name="backupOwner"
                    placeholder="user:default/name"
                  />
                </label>
              </div>
            </fieldset>
            <fieldset className="gov-fieldset">
              <legend>Audience and data</legend>
              <div className="governance-fields">
                <label>
                  Who uses it?
                  <select name="audience">{options(audiences)}</select>
                </label>
                <label>
                  Highest data classification
                  <select name="classification">{options(classes)}</select>
                </label>
                <label>
                  Connected system access
                  <select name="connections">
                    <option value="">None</option>
                    {options(['read', 'write'])}
                  </select>
                </label>
                {draft.connections && (
                  <label>
                    Connected system
                    <input required name="system" />
                  </label>
                )}
                {hosted && (
                  <>
                    <label>
                      Provider
                      <input required name="provider" />
                    </label>
                    <label>
                      Enterprise workspace
                      <input required name="workspace" />
                    </label>
                    <label>
                      Sharing scope
                      <select name="sharing">{options(sharing)}</select>
                    </label>
                    <label>
                      Data access
                      <select name="dataAccess">
                        {options([
                          'none',
                          'stores input',
                          'reads connected data',
                          'both',
                        ])}
                      </select>
                    </label>
                    {draft.dataAccess && draft.dataAccess !== 'none' && (
                      <label>
                        Highest hosted data classification
                        <select required name="hostedClass">
                          <option value="">Select classification</option>
                          {options(classes)}
                        </select>
                      </label>
                    )}
                  </>
                )}
              </div>
              <label>
                <input type="checkbox" name="takesActions" /> Takes actions in
                other systems
              </label>
              {draft.takesActions && (
                <label>
                  Describe the actions
                  <input required name="actionDescription" />
                </label>
              )}
              <label>
                <input type="checkbox" name="affectsPeople" /> Affects decisions
                about people
              </label>
              <label>
                <input type="checkbox" name="personalData" /> Processes personal
                data
              </label>
              <label>
                <input type="checkbox" name="critical" /> The business depends
                on it
              </label>
            </fieldset>
            <div className="gov-form-actions">
              <button type="button" onClick={() => navigate('Inventory')}>
                Cancel
              </button>
              <button className="gov-primary" disabled={busy}>
                {busy ? 'Registering…' : 'Register app'}
              </button>
            </div>
          </form>
        </section>
      )}
      {view === 'Import' && (
        <section className="gov-panel gov-single" aria-label="Import file">
          <h2>Upload a file</h2>
          <p>
            {canReview
              ? 'Upload a YAML descriptor or a CSV or JSON batch of up to 100 apps.'
              : 'Upload the YAML descriptor from your app’s repository. Bulk imports require a reviewer.'}
          </p>
          <form
            onSubmit={event =>
              submit(event, async data => {
                const file = data.get('file') as File;
                const content = await file.text();
                const name = file.name.toLowerCase();
                if (name.endsWith('.csv')) {
                  await api('/imports', { csv: content });
                } else if (name.endsWith('.json')) {
                  await api('/imports', JSON.parse(content));
                } else {
                  await api('/repository', { content });
                }
                await refresh();
                navigate('Inventory');
                setMessage('Import complete.');
              })
            }
          >
            <label>
              App file
              <input
                type="file"
                name="file"
                accept={canReview ? '.yaml,.yml,.csv,.json' : '.yaml,.yml'}
                required
              />
            </label>
            <button className="gov-primary" disabled={busy}>
              {busy ? 'Importing…' : 'Import apps'}
            </button>
          </form>
        </section>
      )}
      {view === 'Builder guide' && (
        <section
          className="gov-panel gov-single gov-guide"
          aria-label="Guidance for builders"
        >
          <h2>Before you build</h2>
          <p>
            Search the inventory before creating a new tool. Register the app
            with a named owner, its platform, the models it uses, and the
            highest classification of any data it handles.
          </p>
          <h2>Before you share</h2>
          <p>
            Use your organization’s approved models and enterprise workspaces.
            Shared apps need a backup owner and a yearly attestation. Critical
            apps need security and data protection approval before launch.
          </p>
          <h2>Register from a repository</h2>
          <p>
            Engineers can commit an AI app descriptor to their source repository
            and upload it from Import. Reviewers can import a CSV or JSON batch
            of known apps.
          </p>
        </section>
      )}
    </WorkspaceLayout>
  );
}

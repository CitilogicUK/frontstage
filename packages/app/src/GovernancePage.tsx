import { useAnalytics } from '@backstage/frontend-plugin-api';
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
import AppsIcon from '@material-ui/icons/Apps';
import CloseIcon from '@material-ui/icons/Close';
import { Link, useSearchParams } from 'react-router-dom';
import { DiscoveryQueue, type DiscoveryResult } from './DiscoveryQueue';
import { AppScorecard } from './AppScorecard';
import { AppTemplates, findStarter, starterDefaults } from './AppTemplates';
import {
  appClassifications as classes,
  appLifecycles,
  appRiskTierNames as tierNames,
} from './appDimensions';
import { deliveryStages, parseDeliveryStage } from './deliveryStages';
import {
  isReviewOverdue,
  requiresCriticalReview,
  reviewCalendar,
  scheduledReviewDate,
} from './reviewDue';
import { downloadCsv, inventoryCsv } from './portfolioExport';
import { reviewTrackLabels, type ReviewTrack } from './reviewTracks';
import { AppAuditHistory } from './AppAuditHistory';
import { GatewayModelGuide, useGatewayModelPolicy } from './GatewayModelGuide';
import { GatewayPlayground } from './GatewayPlayground';
import {
  PortfolioReport,
  type OwnershipReport,
  type UsageReport,
} from './PortfolioReport';
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
  type?: string;
  platform: string;
  sourceUrl: string;
  owner: string;
  team: string;
  backupOwner?: string;
  classification: string;
  effectiveClassification?: string;
  models: string[];
  usesAiAtRuntime?: boolean;
  deliveryStage?: string;
  tier: number;
  reviewStatus: string;
  lifecycle: string;
  nextReview: string | null;
  lastReview: string | null;
  updatedAt: string;
  reviewNotes?: string;
  reviewTicketUrl?: string;
  signoffs?: Partial<Record<ReviewTrack, { status: string }>>;
  evidence?: Partial<Record<'tests' | 'dataFlow' | 'incidentPlan', string>>;
};

function deliveryStageOptions() {
  return Object.entries(deliveryStages).map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));
}

const evidenceFields = [
  ['tests', 'Test evidence'],
  ['dataFlow', 'Data-flow diagram'],
  ['incidentPlan', 'Incident plan'],
] as const;

const audiences = ['personal', 'team', 'company', 'external'];
const sharing = ['private', 'named people', 'company', 'public link'];

type View = Exclude<keyof typeof workspaceViews, 'Catalog'>;

const viewParameters = new Map<string, View>([
  ['register', 'Register'],
  ['discovery', 'Discovery'],
  ['reviews', 'Reviews'],
  ['reports', 'Reports'],
  ['import', 'Import'],
  ['guide', 'Builder guide'],
  ['templates', 'Templates'],
]);

function appOwner(ref: string) {
  return ref.replace(/^user:default\//, '');
}

function appReview(app: App, now: number) {
  if (app.lifecycle === 'retired' || app.tier === 1) {
    return { label: 'Not required', status: 'not required', priority: 3 };
  }
  if (app.tier === 3 && app.reviewStatus !== 'approved') {
    let label = isReviewOverdue(app, now) ? 'Review overdue' : 'Review pending';
    if (app.reviewStatus === 'changes needed') label = 'Changes needed';
    return {
      label,
      status: app.reviewStatus,
      priority: 0,
    };
  }
  if (isReviewOverdue(app, now)) {
    return {
      label: app.tier === 2 ? 'Attestation overdue' : 'Review overdue',
      status: 'changes needed',
      priority: 0,
    };
  }
  const due = scheduledReviewDate(app);
  if (due && due.getTime() <= now + 30 * 86_400_000) {
    return {
      label: app.tier === 2 ? 'Attestation due soon' : 'Review due soon',
      status: 'pending',
      priority: 1,
    };
  }
  return {
    label: app.tier === 2 ? 'Attestation current' : 'Approved',
    status: 'approved',
    priority: 2,
  };
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
  const analytics = useAnalytics();
  const config = useApi(configApiRef);
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [apps, setApps] = useState<App[]>([]);
  const [actor, setActor] = useState('');
  const [canReview, setCanReview] = useState(false);
  const [reviewTracks, setReviewTracks] = useState<ReviewTrack[]>([]);
  const [reviewerTracks, setReviewerTracks] = useState<ReviewTrack[]>([]);
  const [gatewayEnabled, setGatewayEnabled] = useState(false);
  const [params, setParams] = useSearchParams();
  const view = viewParameters.get(params.get('view') ?? '') ?? 'Inventory';
  const ownerParam = params.get('owner');
  const ownershipScope =
    view === 'Inventory' && (ownerParam === 'me' || ownerParam === 'backup')
      ? ownerParam
      : 'all';
  function setOwnershipScope(value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value === 'me' || value === 'backup') next.set('owner', value);
      else next.delete('owner');
      return next;
    });
  }
  const starter =
    view === 'Register' && !params.has('repository')
      ? findStarter(params.get('template'))
      : undefined;
  const templateClassification = starter
    ? classes.find(value => value === params.get('classification'))
    : undefined;
  const initialClassification = starter
    ? templateClassification ?? starterDefaults.classification
    : classes[0];
  const repositoryId = view === 'Register' ? params.get('repository') : null;
  const [usageReport, setUsageReport] = useState<{
    days: number;
    data: UsageReport;
  }>();
  const daysParam = params.get('days');
  const usageDays =
    daysParam === '1' || daysParam === '7' ? Number(daysParam) : 30;
  const [ownershipReport, setOwnershipReport] = useState<OwnershipReport>();
  const [ownershipError, setOwnershipError] = useState(false);
  const [reportError, setReportError] = useState('');
  const [discoveries, setDiscoveries] = useState<DiscoveryResult>();
  const [discoveryError, setDiscoveryError] = useState('');
  const candidate = discoveries?.repositories.find(
    item => item.id === repositoryId && !item.appId && !item.dismissed,
  );
  const [query, setQuery] = useState('');
  const tierParam = params.get('tier');
  const tier =
    view === 'Inventory' && ['1', '2', '3'].includes(tierParam ?? '')
      ? tierParam ?? ''
      : '';
  const reviewParam = params.get('review');
  const reviewFilter =
    reviewParam === 'all' ||
    reviewParam === 'required' ||
    (reviewParam === 'mine' && reviewerTracks.length > 0)
      ? reviewParam
      : 'attention';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [importPreview, setImportPreview] = useState<{
    endpoint: '/imports' | '/repository';
    payload: unknown;
    apps: Array<
      Pick<
        App,
        | 'name'
        | 'tier'
        | 'owner'
        | 'backupOwner'
        | 'team'
        | 'deliveryStage'
        | 'usesAiAtRuntime'
        | 'effectiveClassification'
      >
    >;
  }>();
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [riskPreview, setRiskPreview] = useState<{
    answers: string;
    tier?: number;
  }>();
  const detailId =
    view === 'Inventory' || view === 'Reviews' || view === 'Reports'
      ? params.get('app')
      : null;
  const [selectedRecord, setSelected] = useState<App>();
  const selected =
    selectedRecord?.id === detailId
      ? selectedRecord
      : apps.find(app => app.id === detailId);
  const [message, setMessage] = useState('');

  const reviewDate = selected && scheduledReviewDate(selected);
  const canDownloadReminder =
    selected &&
    reviewDate &&
    (actor === selected.owner || actor === selected.backupOwner || canReview);

  function downloadReviewReminders(
    reminders: Array<{ app: App; due: Date }>,
    filename: string,
  ) {
    const calendar = reviewCalendar(reminders, config.getString('app.baseUrl'));
    const url = URL.createObjectURL(
      new Blob([calendar], {
        type: 'text/calendar;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function setAppInUrl(id?: string) {
    setParams(
      previous => {
        const next = new URLSearchParams(previous);
        if (id) next.set('app', id);
        else next.delete('app');
        next.delete('edit');
        return next;
      },
      { replace: !id },
    );
  }

  function closeApp() {
    setSelected(undefined);
    setError('');
    setMessage('');
    setAppInUrl();
  }
  const [runtimeEdit, setRuntimeEdit] = useState<boolean>();
  const editingUsesAi = runtimeEdit ?? selected?.usesAiAtRuntime !== false;

  useEffect(() => {
    setRuntimeEdit(undefined);
  }, [selected]);
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
    setReviewTracks(result.reviewTracks ?? []);
    setReviewerTracks(result.reviewerTracks ?? []);
    setGatewayEnabled(result.gatewayEnabled === true);
  }

  useEffect(() => {
    refresh()
      .catch(reason => setError(String(reason)))
      .finally(() => setLoading(false));
    // The Backstage APIs are stable for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view !== 'Discovery' && !repositoryId) return undefined;
    let current = true;
    setDiscoveryError('');
    api('/discovery/github')
      .then(result => {
        if (current) setDiscoveries(result);
      })
      .catch(reason => {
        if (current)
          setDiscoveryError(
            reason instanceof Error ? reason.message : String(reason),
          );
      });
    return () => {
      current = false;
    };
  }, [api, repositoryId, view]);

  useEffect(() => {
    if (view !== 'Reports' || !canReview) return undefined;
    let active = true;
    setReportError('');
    setOwnershipReport(undefined);
    setOwnershipError(false);
    api('/reports/ownership')
      .then(result => {
        if (active) setOwnershipReport(result);
      })
      .catch(() => {
        if (active) setOwnershipError(true);
      });
    return () => {
      active = false;
    };
  }, [api, apps, canReview, view]);

  useEffect(() => {
    if (view !== 'Reports' || !canReview) return undefined;
    let active = true;
    setReportError('');
    setUsageReport(undefined);
    api(
      usageDays === 30 ? '/reports/usage' : `/reports/usage?days=${usageDays}`,
    )
      .then(result => {
        if (active) setUsageReport({ days: usageDays, data: result });
      })
      .catch(reason => {
        if (active)
          setReportError(
            reason instanceof Error ? reason.message : String(reason),
          );
      });
    return () => {
      active = false;
    };
  }, [api, apps, canReview, usageDays, view]);

  async function scanGithub() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const scan = await api('/discovery/github/scan', {});
      setDiscoveries(await api('/discovery/github'));
      setMessage(
        `Found ${scan.found} repositories.${
          scan.partial ? ' Results are partial.' : ''
        }`,
      );
    } catch (reason) {
      const result = await api('/discovery/github').catch(() => undefined);
      if (result) setDiscoveries(result);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function decideDiscovery(id: string, reason: string | null) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api(
        `/discovery/github/${encodeURIComponent(id)}/decision`,
        reason ? { action: 'dismiss', reason } : { action: 'reopen' },
      );
      setDiscoveries(await api('/discovery/github'));
      setMessage(reason ? 'Repository dismissed.' : 'Repository reopened.');
    } catch (decisionError) {
      const updated = await api('/discovery/github').catch(() => undefined);
      if (updated) setDiscoveries(updated);
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : String(decisionError),
      );
    } finally {
      setBusy(false);
    }
  }

  function resetView() {
    setImportPreview(undefined);
    setQuery('');
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
    setImportPreview(undefined);
    setQuery('');
    setSelected(undefined);
    setDraft({});
  }, [view, repositoryId, starter?.id]);

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

  const runtimeDefault = starter?.runtime === false ? 'no' : 'yes';
  const hosted = draft.type === 'provider-hosted app';
  const usesAiAtRuntime =
    hosted || (draft.usesAiAtRuntime ?? runtimeDefault) === 'yes';
  const initialModels = starter?.runtime
    ? params.get('model') ?? starterDefaults.model
    : '';
  const registrationClass = draft.classification || initialClassification;
  const { policy: starterPolicy } = useGatewayModelPolicy(
    view === 'Register' &&
      starter?.runtime === true &&
      usesAiAtRuntime &&
      !hosted,
  );
  const ineligibleModels =
    starter?.runtime && usesAiAtRuntime && !hosted && starterPolicy?.enabled
      ? (draft.models ?? initialModels)
          .split(',')
          .map(value => value.trim())
          .filter(
            value =>
              value &&
              !starterPolicy.models.some(
                model =>
                  model.id === value &&
                  model.allowedClassifications.includes(registrationClass),
              ),
          )
      : [];
  const answers = JSON.stringify({
    audience: draft.audience || audiences[0],
    classification: registrationClass,
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

  const now = Date.now();
  const myReviewAttentionCount =
    view === 'Inventory' && actor
      ? apps.filter(
          app => app.owner === actor && appReview(app, now).priority <= 1,
        ).length
      : 0;
  const scopedApps =
    ownershipScope === 'all'
      ? apps
      : apps.filter(
          app =>
            (ownershipScope === 'me' ? app.owner : app.backupOwner) === actor,
        );
  const stageFilter = params.get('stage');
  const stage = parseDeliveryStage(stageFilter);
  const filterByStage =
    (view === 'Inventory' || view === 'Reviews') &&
    (stage !== undefined || stageFilter === 'unset');
  const runtimeFilter = params.get('runtime');
  const filterByRuntime =
    view === 'Inventory' && (runtimeFilter === 'yes' || runtimeFilter === 'no');
  const lifecycleParam = params.get('lifecycle');
  const lifecycleFilter =
    view === 'Inventory'
      ? appLifecycles.find(value => value === lifecycleParam)
      : undefined;
  const inventoryReview = params.get('review');
  const inventoryReviewFilter =
    view === 'Inventory' &&
    (inventoryReview === 'overdue' || inventoryReview === 'attention')
      ? inventoryReview
      : '';

  const classificationParam = params.get('classification');
  const classificationFilter =
    view === 'Inventory'
      ? classes.find(value => value === classificationParam)
      : undefined;
  const platformFilter = view === 'Inventory' ? params.get('platform') : null;
  const teamFilter = view === 'Inventory' ? params.get('team') : null;
  const owningTeams = [
    ...new Set(apps.map(app => app.team).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  const platforms = [...new Set(apps.map(app => app.platform))].sort((a, b) =>
    a.localeCompare(b),
  );
  const hasListFilters = Boolean(
    query ||
      tier ||
      filterByStage ||
      filterByRuntime ||
      inventoryReviewFilter ||
      lifecycleFilter ||
      classificationFilter ||
      platformFilter ||
      teamFilter,
  );
  const filteredApps = scopedApps.filter(
    app =>
      (!filterByStage ||
        parseDeliveryStage(app.deliveryStage ?? null) === stage) &&
      (!filterByRuntime ||
        (app.usesAiAtRuntime !== false) === (runtimeFilter === 'yes')) &&
      (inventoryReviewFilter !== 'overdue' || isReviewOverdue(app, now)) &&
      (inventoryReviewFilter !== 'attention' ||
        appReview(app, now).priority <= 1) &&
      (!lifecycleFilter || app.lifecycle === lifecycleFilter) &&
      (!classificationFilter ||
        (app.effectiveClassification ?? app.classification) ===
          classificationFilter) &&
      (!platformFilter || app.platform === platformFilter) &&
      (!teamFilter || app.team === teamFilter),
  );

  function setAppListFilter(
    key:
      | 'stage'
      | 'runtime'
      | 'review'
      | 'lifecycle'
      | 'classification'
      | 'platform'
      | 'team'
      | 'tier',
    value: string,
  ) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }

  function matchesReviewFilter(app: App) {
    if (app.tier !== 3 || app.lifecycle === 'retired') return false;
    if (reviewFilter === 'attention') return appReview(app, now).priority <= 1;
    if (reviewFilter === 'required') return requiresCriticalReview(app, now);
    if (reviewFilter === 'mine') {
      return (
        actor !== app.owner &&
        actor !== app.backupOwner &&
        requiresCriticalReview(app, now) &&
        reviewerTracks.some(track => !app.signoffs?.[track])
      );
    }
    return true;
  }

  const matching = filteredApps.filter(
    app =>
      (view !== 'Reviews' || matchesReviewFilter(app)) &&
      (!tier || view === 'Reviews' || String(app.tier) === tier) &&
      [
        app.name,
        app.purpose,
        app.owner,
        app.backupOwner ?? '',
        app.team,
        app.platform,
        app.effectiveClassification ?? app.classification,
        ...app.models,
      ].some(value => value.toLowerCase().includes(query.trim().toLowerCase())),
  );

  if (view === 'Reviews' || ownershipScope !== 'all') {
    matching.sort((a, b) => {
      const priority = appReview(a, now).priority - appReview(b, now).priority;
      const aDue =
        scheduledReviewDate(a)?.getTime() ?? Number.POSITIVE_INFINITY;
      const bDue =
        scheduledReviewDate(b)?.getTime() ?? Number.POSITIVE_INFINITY;
      return priority || aDue - bDue || a.name.localeCompare(b.name);
    });
  }

  const reminderEntries =
    ownershipScope !== 'all'
      ? matching.flatMap(app => {
          const due = scheduledReviewDate(app);
          return due ? [{ app, due }] : [];
        })
      : [];

  let emptyTitle = 'No registered apps';
  let emptyMessage = 'Register an app to add it to the inventory.';
  if (ownershipScope === 'me') {
    emptyTitle = 'You don’t own any apps';
    emptyMessage = 'Register an app or switch ownership to all owners.';
  }
  if (ownershipScope === 'backup') {
    emptyTitle = 'No apps list you as backup owner';
    emptyMessage = 'Switch ownership to all owners to see the full inventory.';
  }
  if (view === 'Reviews') {
    emptyTitle =
      reviewFilter === 'all' ? 'No critical apps' : 'No reviews need attention';
    emptyMessage = 'Critical apps appear here after registration.';
    if (reviewFilter === 'mine') {
      emptyTitle = 'No pending sign-offs for you';
      emptyMessage = 'Check all critical apps to see the rest of the queue.';
    }
  }
  if (hasListFilters) {
    emptyTitle = 'No matching apps';
    emptyMessage = 'Try another search or clear the filters.';
  }

  return (
    <WorkspaceLayout view={view} onNavigate={resetView}>
      {detailId && !loading && !error && !selected && (
        <p className="gov-notice" role="status">
          This app record is unavailable.
        </p>
      )}
      {error && !selected && (
        <p
          className={
            view === 'Import' ? 'gov-notice gov-import-error' : 'gov-notice'
          }
          role="alert"
        >
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
          {!loading && !error && myReviewAttentionCount > 0 && (
            <p className="gov-notice">
              <Link to="/?owner=me&review=attention">
                {myReviewAttentionCount === 1
                  ? '1 of your apps needs review attention'
                  : `${myReviewAttentionCount} of your apps need review attention`}
              </Link>
            </p>
          )}
          <div className="gov-panel">
            <WorkspaceSearch
              label="Search apps"
              placeholder="Search apps, owners, teams, models…"
              value={query}
              onChange={setQuery}
              count={loading ? undefined : matching.length}
            >
              {view === 'Inventory' && (
                <>
                  <label>
                    <span className="gov-visually-hidden">Ownership</span>
                    <select
                      value={ownershipScope}
                      onChange={event => setOwnershipScope(event.target.value)}
                    >
                      <option value="all">All owners</option>
                      <option value="me">My apps</option>
                      <option value="backup">Apps I back up</option>
                    </select>
                  </label>
                  <label>
                    <span className="gov-visually-hidden">Runtime AI</span>
                    <select
                      value={filterByRuntime ? runtimeFilter ?? '' : ''}
                      onChange={event =>
                        setAppListFilter('runtime', event.target.value)
                      }
                    >
                      <option value="">All runtime AI settings</option>
                      <option value="yes">Uses runtime AI</option>
                      <option value="no">No runtime AI</option>
                    </select>
                  </label>
                  <label>
                    <span className="gov-visually-hidden">Lifecycle</span>
                    <select
                      value={lifecycleFilter ?? ''}
                      onChange={event =>
                        setAppListFilter('lifecycle', event.target.value)
                      }
                    >
                      <option value="">All lifecycle statuses</option>
                      {options(appLifecycles)}
                    </select>
                  </label>
                  <label>
                    <span className="gov-visually-hidden">
                      Data classification
                    </span>
                    <select
                      value={classificationFilter ?? ''}
                      onChange={event =>
                        setAppListFilter('classification', event.target.value)
                      }
                    >
                      <option value="">All data classifications</option>
                      {options(classes)}
                    </select>
                  </label>
                  <label>
                    <span className="gov-visually-hidden">Platform</span>
                    <select
                      value={platformFilter ?? ''}
                      onChange={event =>
                        setAppListFilter('platform', event.target.value)
                      }
                    >
                      <option value="">All platforms</option>
                      {platformFilter &&
                        !platforms.includes(platformFilter) && (
                          <option>{platformFilter}</option>
                        )}
                      {options(platforms)}
                    </select>
                  </label>
                  <label>
                    <span className="gov-visually-hidden">Owning team</span>
                    <select
                      value={teamFilter ?? ''}
                      onChange={event =>
                        setAppListFilter('team', event.target.value)
                      }
                    >
                      <option value="">All teams</option>
                      {teamFilter && !owningTeams.includes(teamFilter) && (
                        <option>{teamFilter}</option>
                      )}
                      {options(owningTeams)}
                    </select>
                  </label>
                  <label>
                    <span className="gov-visually-hidden">Review status</span>
                    <select
                      value={inventoryReviewFilter}
                      onChange={event =>
                        setAppListFilter('review', event.target.value)
                      }
                    >
                      <option value="">All review statuses</option>
                      <option value="attention">Needs review attention</option>
                      <option value="overdue">
                        Overdue reviews and attestations
                      </option>
                    </select>
                  </label>
                </>
              )}
              {view === 'Reviews' && (
                <label>
                  <span className="gov-visually-hidden">Review status</span>
                  <select
                    value={reviewFilter}
                    onChange={event =>
                      setAppListFilter(
                        'review',
                        event.target.value === 'attention'
                          ? ''
                          : event.target.value,
                      )
                    }
                  >
                    <option value="attention">Needs attention</option>
                    <option value="required">Review required now</option>
                    {reviewerTracks.length > 0 && (
                      <option value="mine">My pending sign-offs</option>
                    )}
                    <option value="all">All critical apps</option>
                  </select>
                </label>
              )}
              <label>
                <span className="gov-visually-hidden">Delivery stage</span>
                <select
                  value={filterByStage ? stageFilter ?? '' : ''}
                  onChange={event =>
                    setAppListFilter('stage', event.target.value)
                  }
                >
                  <option value="">All delivery stages</option>
                  {deliveryStageOptions()}
                  <option value="unset">Stage unspecified</option>
                </select>
              </label>
              {view === 'Inventory' &&
                !loading &&
                !error &&
                matching.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      downloadCsv(
                        inventoryCsv(matching),
                        'frontstage-inventory.csv',
                      )
                    }
                  >
                    Download inventory CSV
                  </button>
                )}
              {!loading && !error && reminderEntries.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    downloadReviewReminders(
                      reminderEntries,
                      'frontstage-my-reviews.ics',
                    )
                  }
                >
                  Download my review calendar
                </button>
              )}
            </WorkspaceSearch>
            {view === 'Inventory' && !loading && !error && (
              <WorkspaceFilterTabs
                label="Risk tiers"
                value={tier}
                onChange={value => setAppListFilter('tier', value)}
                options={[
                  { value: '', label: 'All apps', count: filteredApps.length },
                  ...tierNames.map((label, index) => ({
                    value: String(index + 1),
                    label,
                    count: filteredApps.filter(app => app.tier === index + 1)
                      .length,
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
                {hasListFilters && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      if (
                        filterByStage ||
                        filterByRuntime ||
                        inventoryReviewFilter ||
                        lifecycleFilter ||
                        classificationFilter ||
                        platformFilter ||
                        teamFilter ||
                        tier
                      ) {
                        setParams(previous => {
                          const next = new URLSearchParams(previous);
                          next.delete('stage');
                          next.delete('runtime');
                          next.delete('lifecycle');
                          next.delete('classification');
                          next.delete('platform');
                          next.delete('team');
                          next.delete('tier');
                          if (inventoryReviewFilter) next.delete('review');
                          return next;
                        });
                      }
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
                      <th>Delivery stage</th>
                      <th>Lifecycle</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matching.map(app => {
                      const appStage = parseDeliveryStage(
                        app.deliveryStage ?? null,
                      );
                      const review = appReview(app, now);
                      return (
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
                                setAppInUrl(app.id);
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
                          <td data-label="Delivery stage">
                            {appStage
                              ? deliveryStages[appStage]
                              : 'Unspecified'}
                          </td>
                          <td data-label="Lifecycle">{app.lifecycle}</td>
                          <td data-label="Review">
                            <span
                              className="gov-status"
                              data-status={review.status}
                            >
                              {review.label}
                            </span>
                            {app.tier >= 2 &&
                              app.lifecycle !== 'retired' &&
                              app.nextReview && (
                                <small>{app.nextReview.slice(0, 10)}</small>
                              )}
                            {view === 'Reviews' && app.reviewTicketUrl && (
                              <small>
                                <a
                                  href={app.reviewTicketUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`Open review ticket for ${app.name}`}
                                >
                                  Open review ticket
                                </a>
                              </small>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
      <dialog
        ref={dialog}
        className="governance-detail"
        aria-labelledby="gov-detail-title"
        onCancel={event => {
          event.preventDefault();
          closeApp();
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
                onClick={closeApp}
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
              {selected.lifecycle} ·{' '}
              {selected.usesAiAtRuntime === false
                ? 'No runtime AI'
                : selected.models.join(', ')}{' '}
              · <a href={selected.sourceUrl}>Open source</a>
            </p>
            {selected.deliveryStage && (
              <p>
                Delivery stage:{' '}
                {selected.deliveryStage === 'poc'
                  ? 'proof of concept'
                  : selected.deliveryStage}
              </p>
            )}
            {selected.nextReview && (
              <p>Next review due {selected.nextReview.slice(0, 10)}.</p>
            )}
            {canDownloadReminder && (
              <button
                type="button"
                onClick={() =>
                  downloadReviewReminders(
                    [{ app: selected, due: reviewDate }],
                    'frontstage-review.ics',
                  )
                }
              >
                Download calendar reminder
              </button>
            )}
            {selected.tier === 2 && selected.lastReview && (
              <p>Last owner attestation {selected.lastReview.slice(0, 10)}.</p>
            )}
            {selected.tier === 2 &&
              actor === selected.owner &&
              selected.lifecycle !== 'retired' && (
                <form
                  key={`${selected.id}-attest-${selected.updatedAt}`}
                  onSubmit={event =>
                    submit(event, async data => {
                      const updated = await api(
                        `/apps/${selected.id}/attestation`,
                        {
                          confirmed: data.get('confirmed') === 'on',
                          expectedUpdatedAt: selected.updatedAt,
                        },
                      );
                      setSelected(updated);
                      await refresh();
                      setMessage('Owner attestation recorded.');
                    })
                  }
                >
                  <h3>Yearly owner attestation</h3>
                  <label>
                    <input type="checkbox" name="confirmed" required />I confirm
                    the app’s purpose, ownership, and declared risk inputs are
                    current.
                  </label>
                  <button disabled={busy}>Record attestation</button>
                </form>
              )}
            {selected.evidence &&
              evidenceFields.some(([field]) => selected.evidence?.[field]) && (
                <section aria-label="Review evidence">
                  <h3>Review evidence</h3>
                  <ul>
                    {evidenceFields.map(([field, label]) => {
                      const url = selected.evidence?.[field];
                      return (
                        url && (
                          <li key={field}>
                            <a href={url} target="_blank" rel="noreferrer">
                              {label}
                            </a>
                          </li>
                        )
                      );
                    })}
                  </ul>
                </section>
              )}
            {selected.reviewTicketUrl && (
              <p>
                <a
                  href={selected.reviewTicketUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open review ticket
                </a>
              </p>
            )}
            {selected.reviewNotes && <p>{selected.reviewNotes}</p>}
            {(actor === selected.owner || canReview) && (
              <details
                className="gov-app-editor"
                key={`${selected.id}-edit-${selected.updatedAt}`}
                open={params.get('edit') === '1' || undefined}
              >
                <summary>Edit app details</summary>
                {selected.tier === 3 && (
                  <p>
                    Changes to purpose, ownership, or review evidence require a
                    new review. Moving to production also requires a new review.
                  </p>
                )}
                <form
                  onSubmit={event =>
                    submit(event, async data => {
                      const updated = await api(
                        `/apps/${selected.id}`,
                        {
                          ...selected,
                          purpose: data.get('purpose'),
                          usesAiAtRuntime: editingUsesAi,
                          models: editingUsesAi
                            ? String(data.get('models') ?? '')
                                .split(',')
                                .map(model => model.trim())
                                .filter(Boolean)
                            : [],
                          deliveryStage: data.get('deliveryStage') || undefined,
                          reviewTicketUrl: data.get('reviewTicketUrl') || null,
                          evidence: Object.fromEntries(
                            evidenceFields.map(([field]) => [
                              field,
                              String(data.get(field) ?? '').trim() || undefined,
                            ]),
                          ),
                          owner: data.get('owner'),
                          backupOwner: data.get('backupOwner') || undefined,
                          team: data.get('team'),
                          expectedUpdatedAt: selected.updatedAt,
                        },
                        'PUT',
                      );
                      setSelected(updated);
                      await refresh();
                      setMessage(
                        updated.reviewStatus === 'pending' &&
                          selected.reviewStatus === 'approved'
                          ? 'App updated. A new review is required before launch.'
                          : 'App updated.',
                      );
                    })
                  }
                >
                  <label>
                    Purpose
                    <textarea
                      required
                      name="purpose"
                      maxLength={1000}
                      defaultValue={selected.purpose}
                    />
                  </label>
                  <label>
                    <span id="app-editor-owner-label">Owner</span>
                    <input
                      aria-labelledby="app-editor-owner-label"
                      required
                      name="owner"
                      aria-describedby={
                        selected.usesAiAtRuntime !== false
                          ? 'ownership-handoff-help'
                          : undefined
                      }
                      defaultValue={selected.owner}
                    />
                    {selected.usesAiAtRuntime !== false && (
                      <small id="ownership-handoff-help">
                        Changing the owner revokes the current gateway key.
                      </small>
                    )}
                  </label>
                  <label>
                    Backup owner
                    <input
                      required={selected.tier >= 2}
                      name="backupOwner"
                      defaultValue={selected.backupOwner}
                    />
                  </label>
                  <label>
                    Owning team
                    <input required name="team" defaultValue={selected.team} />
                  </label>
                  <label>
                    Delivery stage
                    <select
                      name="deliveryStage"
                      defaultValue={selected.deliveryStage ?? ''}
                    >
                      <option value="">Select a stage</option>
                      {deliveryStageOptions()}
                    </select>
                  </label>
                  <label>
                    Does the app use AI at runtime?
                    <select
                      value={editingUsesAi ? 'yes' : 'no'}
                      disabled={selected.type === 'provider-hosted app'}
                      onChange={event =>
                        setRuntimeEdit(event.target.value === 'yes')
                      }
                    >
                      <option value="yes">Yes, it calls AI</option>
                      <option value="no">No runtime AI</option>
                    </select>
                  </label>
                  {editingUsesAi ? (
                    <label>
                      Models
                      <input
                        name="models"
                        required
                        defaultValue={selected.models.join(', ')}
                      />
                    </label>
                  ) : (
                    <p>
                      Saving with no runtime AI revokes the app’s existing
                      gateway key.
                    </p>
                  )}
                  <fieldset className="gov-fieldset">
                    <legend>Review evidence</legend>
                    {evidenceFields.map(([field, label]) => (
                      <label key={field}>
                        {label}
                        <input
                          type="url"
                          name={field}
                          defaultValue={selected.evidence?.[field]}
                        />
                      </label>
                    ))}
                  </fieldset>
                  <label>
                    Review ticket URL
                    <input
                      type="url"
                      name="reviewTicketUrl"
                      defaultValue={selected.reviewTicketUrl}
                    />
                  </label>
                  <button disabled={busy}>Save app details</button>
                </form>
              </details>
            )}
            {(actor === selected.owner || canReview) && (
              <form
                key={`${selected.id}-lifecycle-${selected.lifecycle}`}
                onSubmit={event =>
                  submit(event, async data => {
                    setSelected(
                      await api(
                        `/apps/${selected.id}/lifecycle`,
                        {
                          lifecycle: data.get('lifecycle'),
                          reason:
                            String(data.get('reason') ?? '').trim() ||
                            undefined,
                          expectedUpdatedAt: selected.updatedAt,
                        },
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
                  <select name="lifecycle" defaultValue={selected.lifecycle}>
                    {options(appLifecycles)}
                  </select>
                </label>
                <label>
                  Reason for lifecycle change (optional)
                  <textarea name="reason" maxLength={500} />
                </label>
                <p>Retiring an app also revokes its gateway key.</p>
                <button disabled={busy}>Update lifecycle</button>
              </form>
            )}
            {selected.tier === 3 &&
              reviewTracks.length > 0 &&
              (canReview ||
                actor === selected.owner ||
                actor === selected.backupOwner) && (
                <section aria-label="Required sign-offs">
                  <h3>Required sign-offs</h3>
                  <ul>
                    {reviewTracks.map(track => (
                      <li key={track}>
                        {reviewTrackLabels[track]} ·{' '}
                        {selected.signoffs?.[track]?.status ?? 'Pending'}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            {canReview &&
              actor !== selected.owner &&
              actor !== selected.backupOwner &&
              (!reviewTracks.length || reviewerTracks.length > 0) &&
              selected.tier === 3 && (
                <form
                  key={selected.id}
                  onSubmit={event =>
                    submit(event, async data => {
                      setSelected(
                        await api(`/apps/${selected.id}/reviews`, {
                          status: data.get('status'),
                          track: data.get('track') ?? undefined,
                          notes: data.get('notes'),
                          expectedUpdatedAt: selected.updatedAt,
                        }),
                      );
                      await refresh();
                      setMessage('Review recorded.');
                    })
                  }
                >
                  {reviewerTracks.length > 0 && (
                    <label>
                      Review track
                      <select name="track">
                        {reviewerTracks.map(track => (
                          <option key={track} value={track}>
                            {reviewTrackLabels[track]}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
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
            {(actor === selected.owner ||
              actor === selected.backupOwner ||
              canReview) && (
              <AppScorecard key={selected.updatedAt} appId={selected.id} />
            )}
            {canReview && (
              <AppAuditHistory key={selected.updatedAt} appId={selected.id} />
            )}
            {gatewayEnabled &&
              selected.usesAiAtRuntime !== false &&
              (actor === selected.owner || canReview) && (
                <GatewayPlayground
                  key={`${selected.id}-${selected.lifecycle === 'retired'}`}
                  app={selected}
                />
              )}
          </article>
        )}
      </dialog>
      {view === 'Reports' && (
        <PortfolioReport
          apps={apps}
          report={
            usageReport?.days === usageDays ? usageReport.data : undefined
          }
          usageDays={usageDays}
          ownership={ownershipReport}
          ownershipError={ownershipError}
          canReview={canReview}
          loading={loading}
          error={reportError}
        />
      )}
      {view === 'Discovery' &&
        (discoveryError ? (
          <p role="alert" className="gov-notice">
            {discoveryError}
          </p>
        ) : (
          <DiscoveryQueue
            result={discoveries}
            canReview={canReview}
            busy={busy}
            onScan={scanGithub}
            onDecision={decideDiscovery}
          />
        ))}
      {view === 'Register' && repositoryId && !candidate && (
        <p
          role={discoveries || discoveryError ? 'alert' : 'status'}
          className="gov-notice"
        >
          {discoveryError ||
            (discoveries
              ? 'This repository is already registered or no longer available.'
              : 'Loading repository…')}
        </p>
      )}
      {view === 'Register' && (!repositoryId || candidate) && (
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
            key={
              repositoryId ??
              (starter ? `${starter.id}:${params.get('stage')}` : 'register')
            }
            className="gov-register-form"
            onChange={event => {
              const target = event.target as HTMLInputElement;
              if (target.name && target.name !== 'models')
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
                const endpoint = candidate
                  ? `/discovery/github/${encodeURIComponent(
                      candidate.id,
                    )}/claim`
                  : '/apps';
                const deliveryStage = parseDeliveryStage(
                  value('deliveryStage'),
                );
                await api(endpoint, {
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
                  usesAiAtRuntime,
                  deliveryStage,
                  models: usesAiAtRuntime
                    ? value('models')
                        .split(',')
                        .map(model => model.trim())
                        .filter(Boolean)
                    : [],
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
                let source = 'intake';
                if (candidate) source = 'discovery';
                else if (starter) source = 'template';
                analytics.captureEvent('register-app', 'governance-app', {
                  attributes: {
                    source,
                    deliveryStage: deliveryStage ?? 'unspecified',
                    usesAiAtRuntime,
                  },
                });
                await refresh();
                setDraft({});
                navigate('Inventory');
                setMessage(
                  candidate
                    ? 'Repository claimed and app registered.'
                    : 'App registered.',
                );
              })
            }
          >
            <fieldset className="gov-fieldset">
              <legend>App details</legend>
              <label>
                App name
                <input
                  required
                  name="name"
                  maxLength={100}
                  defaultValue={candidate?.name.slice(0, 100) ?? starter?.name}
                />
              </label>
              <label>
                Purpose
                <textarea
                  required
                  name="purpose"
                  maxLength={1000}
                  defaultValue={starter?.description}
                />
              </label>
              <div className="governance-fields">
                <label>
                  App type
                  <select name="type" defaultValue={starter?.type}>
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
                    defaultValue={
                      candidate || starter
                        ? starterDefaults.platform
                        : undefined
                    }
                    readOnly={!!candidate}
                    placeholder="Code repo, Copilot Studio, Claude…"
                  />
                </label>
                <label>
                  Source URL
                  <input
                    required
                    name="sourceUrl"
                    type="url"
                    defaultValue={candidate?.sourceUrl}
                    readOnly={!!candidate}
                  />
                </label>
                <label>
                  <span id="registration-runtime-ai-label">
                    Does the app use AI at runtime?
                  </span>
                  <select
                    name="usesAiAtRuntime"
                    aria-labelledby="registration-runtime-ai-label"
                    aria-describedby="registration-runtime-ai-help"
                    value={usesAiAtRuntime ? 'yes' : 'no'}
                    disabled={hosted}
                    onChange={event =>
                      setDraft(previous => ({
                        ...previous,
                        usesAiAtRuntime: event.target.value,
                      }))
                    }
                  >
                    <option value="yes">Yes, it calls AI</option>
                    <option value="no">No runtime AI</option>
                  </select>
                  <small id="registration-runtime-ai-help">
                    Using a coding agent to build the app does not count as
                    runtime AI.
                  </small>
                </label>
                {usesAiAtRuntime && (
                  <label>
                    <span id="registration-models-label">Models</span>
                    <input
                      required
                      name="models"
                      aria-labelledby="registration-models-label"
                      aria-describedby={
                        ineligibleModels.length
                          ? 'registration-model-guidance'
                          : undefined
                      }
                      value={draft.models ?? initialModels}
                      onChange={event =>
                        setDraft(previous => ({
                          ...previous,
                          models: event.target.value,
                        }))
                      }
                      placeholder="Enter model names separated by commas"
                    />
                    {ineligibleModels.length > 0 && (
                      <small id="registration-model-guidance" role="status">
                        The gateway does not approve{' '}
                        {ineligibleModels.join(', ')} for {registrationClass}{' '}
                        data.
                      </small>
                    )}
                  </label>
                )}
                <label>
                  Delivery stage
                  <select
                    name="deliveryStage"
                    defaultValue={
                      starter
                        ? parseDeliveryStage(params.get('stage')) ?? 'trial'
                        : ''
                    }
                  >
                    <option value="">Select a stage</option>
                    {deliveryStageOptions()}
                  </select>
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
                  <select
                    name="classification"
                    defaultValue={initialClassification}
                  >
                    {options(classes)}
                  </select>
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
              <button
                type="button"
                onClick={() => navigate(candidate ? 'Discovery' : 'Inventory')}
              >
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
          {canReview && (
            <a
              className="gov-button"
              href={`${config
                .getString('app.baseUrl')
                .replace(/\/$/, '')}/examples/ai-apps.csv`}
              download="frontstage-app-import.csv"
            >
              Download sample CSV
            </a>
          )}
          <form
            onSubmit={event =>
              submit(event, async data => {
                if (!importPreview) {
                  const file = data.get('file') as File;
                  const content = await file.text();
                  const name = file.name.toLowerCase();
                  const bulk = name.endsWith('.csv') || name.endsWith('.json');
                  const endpoint = bulk ? '/imports' : '/repository';
                  let payload: unknown = { content };
                  if (name.endsWith('.csv')) payload = { csv: content };
                  if (name.endsWith('.json')) payload = JSON.parse(content);
                  const result = await api(`${endpoint}?dryRun=true`, payload);
                  setImportPreview({ endpoint, payload, apps: result.apps });
                  return;
                }
                const imported = await api(
                  importPreview.endpoint,
                  importPreview.payload,
                );
                await refresh();
                if (importPreview.endpoint === '/repository') {
                  resetView();
                  setParams({ app: imported.id });
                } else {
                  navigate('Inventory');
                }
                setMessage('Import complete.');
              })
            }
          >
            <label>
              App file
              <input
                type="file"
                name="file"
                disabled={busy}
                onChange={() => {
                  setImportPreview(undefined);
                  setError('');
                }}
                accept={canReview ? '.yaml,.yml,.csv,.json' : '.yaml,.yml'}
                required
              />
            </label>
            {importPreview && (
              <section aria-label="Import preview">
                <h3>Ready to import</h3>
                <ul>
                  {importPreview.apps.map((app, index) => {
                    const appStage = parseDeliveryStage(
                      app.deliveryStage ?? null,
                    );
                    return (
                      <li key={`${index}-${app.name}`}>
                        {app.name} · Tier {app.tier}
                        {appStage && ` · ${deliveryStages[appStage]}`}
                        {app.usesAiAtRuntime === true && ' · Uses runtime AI'}
                        {app.usesAiAtRuntime === false && ' · No runtime AI'}
                        {app.effectiveClassification &&
                          ` · ${app.effectiveClassification}`}
                        <div>
                          Owner: {app.owner}
                          {app.backupOwner &&
                            ` · Backup owner: ${app.backupOwner}`}
                          {' · '}Team: {app.team}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            <button className="gov-primary" disabled={busy}>
              {importPreview ? 'Import apps' : 'Validate file'}
            </button>
          </form>
        </section>
      )}
      {view === 'Templates' && <AppTemplates />}
      {view === 'Builder guide' && (
        <>
          <section
            className="gov-panel gov-single gov-guide"
            aria-label="Guidance for builders"
          >
            <h2>Before you build</h2>
            <p>
              Check the inventory for an existing tool. Then choose a starter
              and a delivery stage. Every starter includes instructions for
              coding agents and a project brief to fill in before building.
            </p>
            <Link className="gov-button" to="/?view=templates">
              Browse app templates
            </Link>
            <h2>Choose how the app runs</h2>
            <p>
              If AI only helps write the code, choose the AI-assisted software
              starter. If the app calls a model after it starts running, use a
              gateway starter and check the model and data rules below.
            </p>
            <h2>Before you share</h2>
            <p>
              Review the intended audience, data, and permissions before moving
              beyond a trial or proof of concept. Register the app with a named
              owner, platform, and its highest data classification. Shared apps
              need a backup owner and yearly attestation. Critical apps need
              approval before launch.
            </p>
            <h2>Register from a repository</h2>
            <p>
              Commit the catalog descriptor to your source repository and upload
              it through Import. Reviewers can also import CSV or JSON batches
              of known apps.
            </p>
            <Link className="gov-button" to="/?view=import">
              Import an app descriptor
            </Link>
          </section>
          <GatewayModelGuide />
        </>
      )}
    </WorkspaceLayout>
  );
}

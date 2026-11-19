import { useAnalytics } from '@backstage/frontend-plugin-api';
import {
  Fragment,
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
import {
  DiscoveryQueue,
  discoveryRouteParams,
  type DiscoveryResult,
} from './DiscoveryQueue';
import {
  RepositoryDescriptorPreview,
  type RepositoryDescriptor,
} from './RepositoryDescriptorPreview';
import { AppScorecard } from './AppScorecard';
import { AppTemplates, findStarter, starterDefaults } from './AppTemplates';
import {
  appClassifications as classes,
  appLifecycles,
  appRiskTierNames as tierNames,
  appRegistrationSources,
  registrationSource,
  needsRiskReassessment,
} from './appDimensions';
import { deliveryStages, parseDeliveryStage } from './deliveryStages';
import {
  isReviewOverdue,
  requiresCriticalReview,
  reviewCalendar,
  reviewDaysOverdue,
  scheduledReviewDate,
  scheduledWorkspaceAttestationDate,
} from './reviewDue';
import {
  downloadCsv,
  firstDecisionsCsv,
  inventoryCsv,
  missingReviewTicketsCsv,
  pendingSignoffsCsv,
  type OutsideGatewayUsagePreview,
} from './portfolioExport';
import { reviewTrackLabels, type ReviewTrack } from './reviewTracks';
import { ReviewTicketContext } from './ReviewTicketContext';
import { EditConnections } from './EditConnections';
import { AppAuditHistory } from './AppAuditHistory';
import {
  AppDirectory,
  AppDirectoryPublisher,
  type DirectoryListing,
} from './AppDirectory';
import { DirectoryRequestQueue } from './DirectoryAccessRequests';
import { AppBackupHandover } from './AppBackupHandover';
import { AppGraduation, type Graduation } from './AppGraduation';
import {
  AppRetirementReview,
  type RetirementReview,
} from './AppRetirementReview';
import {
  AppRenewalException,
  type RenewalException,
} from './AppRenewalException';
import {
  ApprovedConnectorsGuide,
  DeclaredConnections,
  RegistrationConnectorGuidance,
} from './ApprovedConnectorsGuide';
import { HostedWorkspaceGuide } from './HostedWorkspaceGuide';
import {
  HostedSnapshotPreview,
  type HostedSnapshotApp,
} from './HostedSnapshotPreview';
import { ApprovedCodingToolsGuide } from './ApprovedCodingToolsGuide';
import { GatewayModelGuide, useGatewayModelPolicy } from './GatewayModelGuide';
import { GatewayPlayground } from './GatewayPlayground';
import {
  PortfolioReport,
  type OwnershipReport,
  type HostedWorkspaceReport,
  type ReviewTurnaroundReport,
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

type OwnerScorecard = {
  issues: Array<{ appId: string; checks: string[] }>;
  catalogUnavailable: boolean;
};

type App = {
  id: string;
  name: string;
  purpose: string;
  type?: string;
  platform: string;
  sourceUrl: string;
  discoverySource?: string;
  owner: string;
  team: string;
  backupOwner?: string;
  classification: string;
  effectiveClassification?: string;
  models: string[];
  connections?: Array<{ name: string; access: string }>;
  usesAiAtRuntime?: boolean;
  hosted?: {
    provider: string;
    workspace: string;
    sharing: string;
    dataAccess: string;
    dataClassification?: string;
  };
  hostedWorkspaceAllowed?: boolean;
  hostedAttestation?: { at: string; nextDue: string };
  deliveryStage?: string;
  starterId?: string;
  tier: number;
  riskAssessment?: { tier: number; reasons: string[] };
  reviewStatus: string;
  lifecycle: string;
  nextReview: string | null;
  lastReview: string | null;
  updatedAt: string;
  activeSince?: string;
  reviewNotes?: string;
  renewalException?: RenewalException;
  retirementReview?: RetirementReview;
  graduation?: Graduation;
  requiresProductionEngineeringCoOwner?: true;
  directoryListing?: DirectoryListing;
  directoryLaunchEligible?: boolean;
  reviewTicketUrl?: string;
  humanApprovalEvidenceRequired?: boolean;
  missingCriticalReviewEvidence?: Array<'tests' | 'dataFlow' | 'incidentPlan'>;
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

const hostedWorkspaceGuidePath = '/?view=guide#hosted-workspaces-title';
const audiences = ['personal', 'team', 'company', 'external'];
const sharing = ['private', 'named people', 'company', 'public link'];
const riskReasons = new Map([
  ['external-audience', 'People outside the company can use the app.'],
  ['public-hosted-sharing', 'The hosted workspace uses a public link.'],
  ['restricted-data', 'The app or hosted workspace handles restricted data.'],
  ['personal-data', 'The app handles personal data.'],
  ['business-critical', 'The app is critical to a business process.'],
  ['affects-people', 'The app affects decisions about people.'],
  ['takes-actions', 'The app takes actions in other systems.'],
  ['write-connection', 'The app has write access to a connected system.'],
  ['shared-audience', 'The app is shared with other people.'],
  ['shared-hosted-workspace', 'Other people can access the hosted workspace.'],
  [
    'confidential-data',
    'The app or hosted workspace handles confidential data.',
  ],
  ['read-connection', 'The app has read access to a connected system.'],
  [
    'configured-minimum',
    'A workspace policy rule requires at least this tier.',
  ],
]);
const hostedAccessOptions = [
  'none',
  'stores input',
  'reads connected data',
  'both',
];

type View = Exclude<keyof typeof workspaceViews, 'Catalog' | 'Notifications'>;

const viewParameters = new Map<string, View>([
  ['register', 'Register'],
  ['directory', 'Directory'],
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

function isAcceptedEngineeringCoOwner(app: App, actor: string) {
  return (
    app.graduation?.status === 'accepted' && actor === app.graduation.nominee
  );
}

function isIndependentReviewer(app: App, actor: string) {
  return (
    actor !== app.owner &&
    actor !== app.backupOwner &&
    !isAcceptedEngineeringCoOwner(app, actor)
  );
}

function isGraduationEligible(app: App) {
  return (
    app.tier === 3 &&
    app.deliveryStage === 'production' &&
    app.lifecycle !== 'retired'
  );
}

function nomineeCanDecideGraduation(app: App, actor: string) {
  return (
    isGraduationEligible(app) &&
    app.graduation?.status === 'pending' &&
    app.graduation.nominee === actor
  );
}

function ownerCanDecideRetirement(app: App, actor: string) {
  return (
    actor === app.owner &&
    app.lifecycle === 'active' &&
    app.retirementReview?.owner === actor &&
    app.retirementReview.status === 'pending'
  );
}

function workspaceAttestationIssue(app: App, now: number) {
  if (!app.hosted || app.lifecycle === 'retired') return undefined;
  const due = scheduledWorkspaceAttestationDate(app)?.getTime();
  if (due === undefined)
    return {
      due: Number.POSITIVE_INFINITY,
      label: 'Workspace confirmation missing',
    };
  if (due > now) return undefined;
  return { due, label: 'Workspace confirmation overdue' };
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

function TierReasons({ codes }: { codes: string[] }) {
  const reasons = codes.flatMap(code => riskReasons.get(code) ?? []);
  return reasons.length > 0 ? (
    <ul aria-label="Reasons for this tier">
      {reasons.map(reason => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  ) : null;
}

function options(values: string[]) {
  return values.map(value => <option key={value}>{value}</option>);
}

function CopyAppLink({ appId }: { appId: string }) {
  const [copied, setCopied] = useState(false);
  const [manualLink, setManualLink] = useState('');
  const manualLinkInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (manualLink) manualLinkInput.current?.focus();
  }, [manualLink]);

  async function copy() {
    const link = new URL(window.location.href);
    link.search = new URLSearchParams({ app: appId }).toString();
    link.hash = '';
    try {
      await navigator.clipboard.writeText(link.href);
      setCopied(true);
      setManualLink('');
    } catch {
      setCopied(false);
      setManualLink(link.href);
      manualLinkInput.current?.focus();
    }
  }

  return (
    <div>
      <button type="button" onClick={copy}>
        Copy app link
      </button>
      {copied && <p role="status">App link copied.</p>}
      {manualLink && (
        <label>
          Copy this app link
          <input
            ref={manualLinkInput}
            value={manualLink}
            readOnly
            onFocus={event => event.currentTarget.select()}
          />
        </label>
      )}
    </div>
  );
}

export function GovernancePage() {
  const [auditVersion, setAuditVersion] = useState(0);
  const analytics = useAnalytics();
  const config = useApi(configApiRef);
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [apps, setApps] = useState<App[]>([]);
  const [appSaveVersion, setAppSaveVersion] = useState(0);
  const [appsWithPendingAccessRequests, setAppsWithPendingAccessRequests] =
    useState<Set<string>>(new Set());
  const updatePendingAccessRequests = useCallback(
    (id: string, hasPending: boolean) => {
      setAppsWithPendingAccessRequests(previous => {
        if (previous.has(id) === hasPending) return previous;
        const next = new Set(previous);
        if (hasPending) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [],
  );
  const [actor, setActor] = useState('');
  const [canReview, setCanReview] = useState(false);
  const [graduationEnabled, setGraduationEnabled] = useState(false);
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
      const review = next.get('review');
      if (
        value !== 'me' &&
        (review === 'workspace' ||
          review === 'scorecard' ||
          (review === 'reassess' && !canReview))
      )
        next.delete('review');
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
  const [reviewTurnaround, setReviewTurnaround] =
    useState<ReviewTurnaroundReport | null>();
  const [reviewTurnaroundAttempt, setReviewTurnaroundAttempt] = useState(0);
  function retryReviewTurnaround() {
    setReviewTurnaroundAttempt(attempt => attempt + 1);
  }
  const [ownershipReport, setOwnershipReport] =
    useState<OwnershipReport | null>();
  const [ownershipLoadAttempt, setOwnershipLoadAttempt] = useState(0);
  const [hostedWorkspaceReport, setHostedWorkspaceReport] =
    useState<HostedWorkspaceReport | null>();
  const [usageReportError, setUsageReportError] = useState('');
  const [usageLoadAttempt, setUsageLoadAttempt] = useState(0);
  const [discoveries, setDiscoveries] = useState<DiscoveryResult>();
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryLoadAttempt, setDiscoveryLoadAttempt] = useState(0);
  const candidate = discoveries?.repositories.find(
    item => item.id === repositoryId && !item.appId && !item.dismissed,
  );
  const [hostedSnapshot, setHostedSnapshot] = useState<HostedSnapshotApp[]>();
  const [hostedSnapshotSelection, setHostedSnapshotSelection] =
    useState<HostedSnapshotApp>();
  const [usageSelection, setUsageSelection] = useState<{
    sourceUrl: string;
    model: string;
  }>();
  const [usagePreview, setUsagePreview] =
    useState<OutsideGatewayUsagePreview>();
  const usageRegistration =
    view === 'Register' &&
    canReview &&
    params.get('source') === 'outside-gateway'
      ? usageSelection
      : undefined;
  const usageRegistrationSource = usageRegistration?.sourceUrl;
  const usageRegistrationSession = useRef<AbortController>();
  useEffect(() => {
    if (!usageRegistrationSource) return undefined;
    const controller = new AbortController();
    usageRegistrationSession.current = controller;
    return () => {
      controller.abort();
      usageRegistrationSession.current = undefined;
    };
  }, [usageRegistrationSource]);
  const hostedRegistration =
    view === 'Register' &&
    canReview &&
    params.get('source') === 'hosted-snapshot'
      ? hostedSnapshotSelection
      : undefined;
  useEffect(() => {
    if (view !== 'Register' || !canReview) setUsageSelection(undefined);
    if (view !== 'Register' || !canReview)
      setHostedSnapshotSelection(undefined);
    if ((view !== 'Discovery' && view !== 'Register') || !canReview)
      setHostedSnapshot(undefined);
  }, [view, canReview]);
  useEffect(() => {
    if (!canReview || (view !== 'Reports' && !usageRegistrationSource))
      setUsagePreview(undefined);
  }, [view, canReview, usageRegistrationSource]);
  const registrationFormKey =
    view === 'Register' && (!repositoryId || candidate)
      ? repositoryId ??
        (hostedRegistration ? 'hosted-snapshot' : undefined) ??
        (usageRegistrationSource ? 'outside-gateway' : undefined) ??
        (starter ? `${starter.id}:${params.get('stage')}` : 'register')
      : undefined;
  const registrationStartedAt = useRef<number>();
  useEffect(() => {
    registrationStartedAt.current =
      registrationFormKey === undefined ? undefined : performance.now();
  }, [registrationFormKey]);
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
    ((reviewParam === 'first' ||
      reviewParam === 'first-target' ||
      reviewParam === 'missing-ticket' ||
      reviewParam === 'missing-evidence') &&
      canReview) ||
    (reviewParam === 'mine' && canReview && reviewerTracks.length > 0)
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
        | 'starterId'
        | 'deliveryStage'
        | 'usesAiAtRuntime'
        | 'effectiveClassification'
      >
    >;
  }>();
  const [scorecardLoadAttempt, setScorecardLoadAttempt] = useState(0);
  const [scorecardResponse, setScorecardResponse] = useState<{
    actor: string;
    apps: App[];
    attempt: number;
    result?: OwnerScorecard | null;
  }>();
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [appliedDescriptor, setAppliedDescriptor] = useState<{
    repositoryId: string;
    app: RepositoryDescriptor;
  }>();
  const descriptor =
    candidate && appliedDescriptor?.repositoryId === candidate.id
      ? appliedDescriptor?.app
      : undefined;
  const [riskPreviewAttempt, setRiskPreviewAttempt] = useState(0);
  const [riskPreview, setRiskPreview] = useState<{
    answers: string;
    tier?: number;
    effectiveClassification?: string;
    reasons?: string[];
  }>();
  const detailId =
    view === 'Inventory' ||
    view === 'Reviews' ||
    view === 'Reports' ||
    view === 'Discovery'
      ? params.get('app')
      : null;
  const [selectedRecord, setSelected] = useState<App>();
  const [discoveryApp, setDiscoveryApp] = useState<{ id: string; app?: App }>();
  const inventoryRecord = apps.find(app => app.id === detailId);
  const selected =
    selectedRecord?.id === detailId
      ? selectedRecord
      : inventoryRecord ??
        (discoveryApp?.id === detailId ? discoveryApp.app : undefined);
  const loadingDiscoveryApp =
    view === 'Discovery' &&
    Boolean(detailId && !selected && discoveryApp?.id !== detailId);
  const [message, setMessage] = useState('');
  const [registrationFeedback, setRegistrationFeedback] = useState<{
    source: 'intake' | 'discovery' | 'template';
    tier: number;
    detailId?: string;
    answered?: boolean;
  }>();
  const [appEditorToggle, setAppEditorToggle] = useState<{
    key: string;
    open: boolean;
  }>();

  const appEditorKey = `${selected?.id}-edit-${selected?.updatedAt}`;
  const connectionsEditorRequested = params.get('edit') === 'connections';
  const appEditorRequested =
    connectionsEditorRequested || params.get('edit') === '1';
  const appEditorOpen =
    appEditorToggle?.key === appEditorKey
      ? appEditorToggle.open
      : appEditorRequested;
  const decisionField = useRef<HTMLSelectElement>(null);
  const [reviewDecision, setReviewDecision] = useState<{
    appId: string;
    status: string;
  }>();
  const reviewStatus =
    reviewDecision?.appId === selected?.id ? reviewDecision?.status : undefined;
  const missingReviewEvidence = selected?.missingCriticalReviewEvidence ?? [];
  const approvalBlocked = missingReviewEvidence.length > 0;
  const decisionStatus =
    approvalBlocked && reviewStatus !== 'changes needed'
      ? ''
      : reviewStatus ?? 'approved';
  const requiresHumanApproval =
    selected?.humanApprovalEvidenceRequired && decisionStatus === 'approved';
  const canRecordReview =
    selected &&
    canReview &&
    isIndependentReviewer(selected, actor) &&
    (!reviewTracks.length || reviewerTracks.length > 0) &&
    selected.tier === 3 &&
    selected.lifecycle !== 'retired';
  const reviewDate = selected && scheduledReviewDate(selected);
  const actorIsAcceptedCoOwner =
    selected !== undefined && isAcceptedEngineeringCoOwner(selected, actor);
  const needsProductionHandoff =
    selected?.requiresProductionEngineeringCoOwner === true &&
    selected.lifecycle !== 'active' &&
    selected.graduation?.status !== 'accepted';
  const canNominateCoOwner =
    selected &&
    graduationEnabled &&
    isGraduationEligible(selected) &&
    (actor === selected.owner || canReview) &&
    (!selected.graduation || selected.graduation.status === 'declined');
  const retirementCandidate =
    canReview &&
    view === 'Reports' &&
    selected?.lifecycle === 'active' &&
    usageReport?.days === usageDays
      ? usageReport.data.retirementReview?.apps.find(
          entry => entry.appId === selected.id,
        )
      : undefined;
  const canManageRenewalException =
    canReview && !!selected && isIndependentReviewer(selected, actor);
  const canDownloadReminders =
    selected &&
    (actor === selected.owner || actor === selected.backupOwner || canReview);
  const hostedAttestationDue =
    selected && scheduledWorkspaceAttestationDate(selected);

  function downloadReviewReminders(
    reminders: Parameters<typeof reviewCalendar>[0],
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

  function setAppInUrl(id?: string, edit = false) {
    setParams(
      previous => {
        const next = new URLSearchParams(previous);
        if (id) next.set('app', id);
        else next.delete('app');
        if (id && edit) next.set('edit', '1');
        else next.delete('edit');
        return next;
      },
      { replace: !id },
    );
  }

  function openAppRecord(app: App, edit = false) {
    setError('');
    setMessage('');
    setSelected(app);
    setAppInUrl(app.id, edit);
  }

  const reviewStatusSelect = useRef<HTMLSelectElement>(null);
  const restoreReviewFilterFocus = useRef(false);
  const restoreConnectorReportFocus = useRef(false);
  const ticketEditorRequested =
    view === 'Reviews' && reviewFilter === 'missing-ticket' && canReview;

  function closeApp() {
    restoreReviewFilterFocus.current = Boolean(
      ticketEditorRequested && selected?.reviewTicketUrl,
    );
    restoreConnectorReportFocus.current =
      view === 'Reports' && connectionsEditorRequested;
    setReviewDecision(undefined);
    setRegistrationFeedback(undefined);
    setAppEditorToggle(undefined);
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
  const editorSummary = useRef<HTMLElement>(null);
  const connectionsEditor = useRef<HTMLFieldSetElement>(null);
  const ticketEditor = useRef<HTMLDetailsElement>(null);
  const selectedAppId = selected?.id;

  useEffect(() => {
    if (selectedAppId) {
      dialog.current?.showModal();
      if (connectionsEditorRequested && connectionsEditor.current)
        connectionsEditor.current.focus();
      else if (appEditorRequested) editorSummary.current?.focus();
      else if (ticketEditorRequested && ticketEditor.current) {
        ticketEditor.current.open = true;
        ticketEditor.current.querySelector('summary')?.focus();
      }
    } else {
      dialog.current?.close();
      if (restoreReviewFilterFocus.current) {
        restoreReviewFilterFocus.current = false;
        reviewStatusSelect.current?.focus();
      }
      if (restoreConnectorReportFocus.current) {
        restoreConnectorReportFocus.current = false;
        if (document.activeElement === document.body)
          document.getElementById('connector-discrepancies-title')?.focus();
      }
    }
  }, [
    selectedAppId,
    appEditorRequested,
    connectionsEditorRequested,
    ticketEditorRequested,
  ]);

  const api = useCallback(
    async (
      path: string,
      body?: unknown,
      method = 'POST',
      signal?: AbortSignal,
    ) => {
      const base = await discovery.getBaseUrl('governance');
      const response = await fetch(
        base + path,
        body === undefined
          ? { signal }
          : {
              method,
              signal,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            },
      );
      const result = await response.json();
      if (!response.ok) {
        throw Object.assign(
          new Error(result.error?.message ?? 'The request failed.'),
          { status: response.status },
        );
      }
      return result;
    },
    [discovery, fetch],
  );

  const pendingRetirementAppId =
    selected?.retirementReview?.status === 'pending' ? selected.id : undefined;
  const pendingRetirementRevision = pendingRetirementAppId
    ? selected?.updatedAt
    : undefined;
  const [retirementActivity, setRetirementActivity] = useState<{
    id: string;
    revision: string;
    changedAt: string;
  }>();
  const liveActivityChangedAt =
    retirementActivity?.id === pendingRetirementAppId &&
    retirementActivity?.revision === pendingRetirementRevision
      ? retirementActivity?.changedAt
      : undefined;

  useEffect(() => {
    if (!pendingRetirementAppId || !pendingRetirementRevision) return undefined;
    const controller = new AbortController();
    api(
      `/apps/${encodeURIComponent(pendingRetirementAppId)}`,
      undefined,
      'GET',
      controller.signal,
    ).then(
      (app: App) => {
        const changedAt = app.retirementReview?.liveActivityChangedAt;
        if (
          !controller.signal.aborted &&
          app.updatedAt === pendingRetirementRevision &&
          changedAt
        )
          setRetirementActivity({
            id: pendingRetirementAppId,
            revision: pendingRetirementRevision,
            changedAt,
          });
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [api, pendingRetirementAppId, pendingRetirementRevision]);

  useEffect(() => {
    if (view !== 'Discovery' || !detailId || loading || inventoryRecord)
      return undefined;
    let active = true;
    api(`/apps/${encodeURIComponent(detailId)}`).then(
      app => {
        if (active) setDiscoveryApp({ id: detailId, app });
      },
      () => {
        if (active) setDiscoveryApp({ id: detailId });
      },
    );
    return () => {
      active = false;
    };
  }, [api, detailId, inventoryRecord, loading, view]);

  function mergeSavedApps(records: App[]) {
    const ids = new Set(records.map(record => record.id));
    setApps(previous => [
      ...records,
      ...previous.filter(app => !ids.has(app.id)),
    ]);
    setAppSaveVersion(version => version + 1);
  }

  function applySavedApp(record: App) {
    setSelected(record);
    mergeSavedApps([record]);
  }

  const inventoryRequested = useRef(false);
  useEffect(() => {
    if (view === 'Directory' || inventoryRequested.current) return;
    inventoryRequested.current = true;
    setLoading(true);
    setError('');
    api('/apps')
      .then(result => {
        setApps(result.apps);
        setAppsWithPendingAccessRequests(
          new Set(result.appsWithPendingAccessRequests ?? []),
        );
        setActor(result.actor ?? '');
        setCanReview(result.canReview);
        setGraduationEnabled(result.graduationEnabled === true);
        setReviewTracks(result.reviewTracks ?? []);
        setReviewerTracks(result.reviewerTracks ?? []);
        setGatewayEnabled(result.gatewayEnabled === true);
      })
      .catch(reason => {
        inventoryRequested.current = false;
        setError(String(reason));
      })
      .finally(() => setLoading(false));
  }, [api, view]);

  useEffect(() => {
    if (view !== 'Discovery' && view !== 'Reports' && !repositoryId)
      return undefined;
    let current = true;
    setDiscoveryError('');
    api('/discovery/github')
      .then(result => {
        if (current) setDiscoveries(result);
      })
      .catch(reason => {
        if (current) {
          if (view === 'Reports') setDiscoveries(undefined);
          setDiscoveryError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      });
    return () => {
      current = false;
    };
  }, [api, discoveryLoadAttempt, repositoryId, view]);

  useEffect(() => {
    if (view !== 'Inventory' || loading || !actor) return undefined;
    let active = true;
    const scope = { actor, apps, attempt: scorecardLoadAttempt };
    setScorecardResponse(scope);
    api('/owner-scorecard').then(
      result => {
        if (active) setScorecardResponse({ ...scope, result });
      },
      () => {
        if (active) setScorecardResponse({ ...scope, result: null });
      },
    );
    return () => {
      active = false;
    };
  }, [actor, api, apps, loading, scorecardLoadAttempt, view]);

  useEffect(() => {
    if (view !== 'Reports' || !canReview) return undefined;
    let active = true;
    setHostedWorkspaceReport(undefined);
    api('/reports/hosted-workspaces').then(
      result => {
        if (active) setHostedWorkspaceReport(result);
      },
      () => {
        if (active) setHostedWorkspaceReport(null);
      },
    );
    return () => {
      active = false;
    };
  }, [api, apps, canReview, view]);

  useEffect(() => {
    if (view !== 'Reports' || !canReview) return undefined;
    let active = true;
    setOwnershipReport(undefined);
    api('/reports/ownership').then(
      result => {
        if (active) setOwnershipReport(result);
      },
      () => {
        if (active) setOwnershipReport(null);
      },
    );
    return () => {
      active = false;
    };
  }, [api, apps, canReview, ownershipLoadAttempt, view]);

  const firstDecisionTargetQueue =
    view === 'Reviews' && reviewFilter === 'first-target';
  const firstDecisionQueue =
    (view === 'Reviews' && reviewFilter === 'first') ||
    firstDecisionTargetQueue;
  const pendingSignoffsQueue = view === 'Reviews' && reviewFilter === 'mine';
  const missingTicketQueue =
    view === 'Reviews' && reviewFilter === 'missing-ticket';
  const showFirstDecisionWait =
    firstDecisionQueue || pendingSignoffsQueue || missingTicketQueue;
  useEffect(() => {
    if (!canReview || (view !== 'Reports' && !showFirstDecisionWait))
      return undefined;
    let active = true;
    setReviewTurnaround(undefined);
    api('/reports/review-turnaround').then(
      result => {
        if (active) setReviewTurnaround(result);
      },
      () => {
        if (active) setReviewTurnaround(null);
      },
    );
    return () => {
      active = false;
    };
  }, [
    api,
    apps,
    canReview,
    showFirstDecisionWait,
    reviewTurnaroundAttempt,
    view,
  ]);

  useEffect(() => {
    if (view !== 'Reports' || !canReview) return undefined;
    let active = true;
    setUsageReportError('');
    setUsageReport(undefined);
    api(
      usageDays === 30 ? '/reports/usage' : `/reports/usage?days=${usageDays}`,
    )
      .then(result => {
        if (active) setUsageReport({ days: usageDays, data: result });
      })
      .catch(reason => {
        if (active)
          setUsageReportError(
            reason instanceof Error ? reason.message : String(reason),
          );
      });
    return () => {
      active = false;
    };
  }, [api, apps, canReview, usageDays, usageLoadAttempt, view]);

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
    setReviewDecision(undefined);
    setRegistrationFeedback(undefined);
    setImportPreview(undefined);
    setQuery('');
    setError('');
    setMessage('');
    setSelected(undefined);
    setDraft({});
    setAppliedDescriptor(undefined);
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
    setAppliedDescriptor(undefined);
    if (view === 'Register') setRegistrationFeedback(undefined);
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
      let description =
        reason instanceof Error ? reason.message : String(reason);
      if (
        detailId &&
        reason instanceof Error &&
        'status' in reason &&
        reason.status === 409
      ) {
        const current = await api(
          `/apps/${encodeURIComponent(detailId)}`,
        ).catch(() => undefined);
        if (current) {
          applySavedApp(current);
          description =
            'The app changed. Review the refreshed record before trying again.';
        }
      }
      setError(description);
    } finally {
      setBusy(false);
    }
  }

  function applyRepositoryDescriptor(app: RepositoryDescriptor) {
    if (!candidate) return;
    setAppliedDescriptor({ repositoryId: candidate.id, app });
    setDraft(previous => ({
      owner: previous.owner ?? actor,
      type: app.type,
      audience: app.audience,
      classification: app.classification,
      usesAiAtRuntime: app.usesAiAtRuntime ? 'yes' : 'no',
      models: app.models.join(', '),
      connections: app.connections[0]?.access ?? '',
      takesActions: app.takesActions ? 'on' : '',
      affectsPeople: app.affectsPeople ? 'on' : '',
      personalData: app.personalData ? 'on' : '',
      critical: app.critical ? 'on' : '',
      sharing: app.hosted?.sharing ?? '',
      dataAccess: app.hosted?.dataAccess ?? '',
      hostedClass: app.hosted?.dataClassification ?? '',
    }));
  }

  const additionalConnections = descriptor?.connections.slice(1) ?? [];
  const primarySystemField = useRef<HTMLInputElement>(null);
  const runtimeDefault = starter?.runtime === false ? 'no' : 'yes';
  const registerType = hostedRegistration
    ? 'provider-hosted app'
    : starter?.type;
  const hosted = (draft.type ?? registerType) === 'provider-hosted app';
  const registrationSharing =
    draft.sharing || hostedRegistration?.sharing || sharing[0];
  const registrationDataAccess =
    draft.dataAccess ||
    hostedRegistration?.dataAccess ||
    hostedAccessOptions[0];
  const registrationHostedClass =
    draft.hostedClass ??
    descriptor?.hosted?.dataClassification ??
    hostedRegistration?.dataClassification ??
    '';
  const usesAiAtRuntime =
    hosted || (draft.usesAiAtRuntime ?? runtimeDefault) === 'yes';
  const observedModel = usageRegistration?.model;
  // Preserve the observed identifier only when the single-line, comma-separated field can represent it.
  const observedModelDefault =
    observedModel && !/[,\r\n]/.test(observedModel) ? observedModel : '';
  const initialModels = starter?.runtime
    ? params.get('model') ?? starterDefaults.model
    : observedModelDefault;
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
  const registrationAccesses = [
    draft.connections,
    ...additionalConnections.map(
      ({ access }, index) => draft[`connectionAccess-${index}`] ?? access,
    ),
  ].filter(Boolean);
  const answers = JSON.stringify({
    audience: draft.audience || audiences[0],
    classification: registrationClass,
    connections: registrationAccesses.map(access => ({ access })),
    takesActions: !!draft.takesActions,
    affectsPeople: !!draft.affectsPeople,
    personalData: !!draft.personalData,
    critical: !!draft.critical,
    hosted: hosted
      ? {
          sharing: registrationSharing,
          dataClassification:
            registrationDataAccess === 'none'
              ? undefined
              : registrationHostedClass || undefined,
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
          if (current) {
            setRiskPreview({
              answers,
              tier: result.tier,
              effectiveClassification: result.effectiveClassification,
              reasons: result.reasons,
            });
          }
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
  }, [answers, api, riskPreviewAttempt, view]);

  const now = Date.now();
  const myReviewAttentionCount =
    view === 'Inventory' && actor
      ? apps.filter(
          app => app.owner === actor && appReview(app, now).priority <= 1,
        ).length
      : 0;
  const myRetirementDecisionCount =
    view === 'Inventory' && actor
      ? apps.filter(app => ownerCanDecideRetirement(app, actor)).length
      : 0;
  const myAccessRequestAppCount =
    view === 'Inventory' && actor
      ? apps.filter(
          app =>
            app.owner === actor && appsWithPendingAccessRequests.has(app.id),
        ).length
      : 0;
  const ownerScorecard =
    view === 'Inventory' &&
    scorecardResponse?.actor === actor &&
    scorecardResponse.apps === apps &&
    scorecardResponse.attempt === scorecardLoadAttempt
      ? scorecardResponse.result
      : undefined;
  const ownerActiveApps = new Set(
    apps
      .filter(app => app.owner === actor && app.lifecycle === 'active')
      .map(app => app.id),
  );
  const ownerScorecardIssues = new Map(
    ownerScorecard?.issues
      .filter(
        issue => ownerActiveApps.has(issue.appId) && issue.checks.length > 0,
      )
      .map(issue => [issue.appId, issue.checks]),
  );
  const scorecardQueueParams = new URLSearchParams(params);
  scorecardQueueParams.set('owner', 'me');
  scorecardQueueParams.set('review', 'scorecard');
  const ownerWorkspaceIssues = new Map(
    apps.flatMap(app => {
      if (!actor || app.owner !== actor) return [];
      const issue = workspaceAttestationIssue(app, now);
      return issue ? [[app.id, issue] as const] : [];
    }),
  );
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
  const canFilterReassessment =
    canReview || (Boolean(actor) && ownershipScope === 'me');
  const myReassessmentCount =
    view === 'Inventory' && actor
      ? apps.filter(app => app.owner === actor && needsRiskReassessment(app))
          .length
      : 0;
  const inventoryReview = params.get('review');
  const inventoryReviewFilter =
    view === 'Inventory' &&
    (inventoryReview === 'overdue' ||
      inventoryReview === 'attention' ||
      inventoryReview === 'upcoming' ||
      inventoryReview === 'retirement' ||
      inventoryReview === 'access' ||
      inventoryReview === 'workspace' ||
      inventoryReview === 'scorecard' ||
      (inventoryReview === 'reassess' && canFilterReassessment))
      ? inventoryReview
      : '';

  const classificationParam = params.get('classification');
  const classificationFilter =
    view === 'Inventory'
      ? classes.find(value => value === classificationParam)
      : undefined;
  const platformFilter = view === 'Inventory' ? params.get('platform') : null;
  const teamFilter = view === 'Inventory' ? params.get('team') : null;
  const starterFilter = view === 'Inventory' ? params.get('starter') : null;
  const accountableOwnerFilter =
    view === 'Inventory' ? params.get('accountableOwner') : null;
  const modelFilter = view === 'Inventory' ? params.get('model') : null;
  const registrationSourceFilter =
    view === 'Inventory'
      ? Object.keys(appRegistrationSources).find(
          value => value === params.get('registrationSource'),
        )
      : undefined;
  const declaredModels = [...new Set(apps.flatMap(app => app.models))].sort(
    (a, b) => a.localeCompare(b),
  );
  const accountableOwners = [...new Set(apps.map(app => app.owner))].sort(
    (a, b) => a.localeCompare(b),
  );
  const owningTeams = [
    ...new Set(apps.map(app => app.team).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  const platforms = [...new Set(apps.map(app => app.platform))].sort((a, b) =>
    a.localeCompare(b),
  );
  const recordedStarters = [
    ...new Set(apps.flatMap(app => (app.starterId ? [app.starterId] : []))),
  ].sort((a, b) => a.localeCompare(b));
  const hasListFilters = Boolean(
    query ||
      tier ||
      filterByStage ||
      filterByRuntime ||
      inventoryReviewFilter ||
      lifecycleFilter ||
      classificationFilter ||
      platformFilter ||
      teamFilter ||
      accountableOwnerFilter ||
      registrationSourceFilter ||
      starterFilter ||
      modelFilter,
  );
  const filteredApps = scopedApps.filter(
    app =>
      (!filterByStage ||
        parseDeliveryStage(app.deliveryStage ?? null) === stage) &&
      (!filterByRuntime ||
        (app.usesAiAtRuntime !== false) === (runtimeFilter === 'yes')) &&
      (inventoryReviewFilter !== 'overdue' || isReviewOverdue(app, now)) &&
      (inventoryReviewFilter !== 'reassess' || needsRiskReassessment(app)) &&
      (inventoryReviewFilter !== 'attention' ||
        appReview(app, now).priority <= 1) &&
      (inventoryReviewFilter !== 'upcoming' ||
        appReview(app, now).priority === 1) &&
      (inventoryReviewFilter !== 'retirement' ||
        ownerCanDecideRetirement(app, actor)) &&
      (inventoryReviewFilter !== 'access' ||
        (app.owner === actor && appsWithPendingAccessRequests.has(app.id))) &&
      (inventoryReviewFilter !== 'workspace' ||
        ownerWorkspaceIssues.has(app.id)) &&
      (inventoryReviewFilter !== 'scorecard' ||
        ownerScorecardIssues.has(app.id)) &&
      (!lifecycleFilter || app.lifecycle === lifecycleFilter) &&
      (!classificationFilter ||
        (app.effectiveClassification ?? app.classification) ===
          classificationFilter) &&
      (!platformFilter || app.platform === platformFilter) &&
      (!teamFilter || app.team === teamFilter) &&
      (!accountableOwnerFilter || app.owner === accountableOwnerFilter) &&
      (!registrationSourceFilter ||
        registrationSource(app.discoverySource) === registrationSourceFilter) &&
      (!starterFilter || (app.starterId ?? 'none') === starterFilter) &&
      (!modelFilter || app.models.includes(modelFilter)),
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
      | 'accountableOwner'
      | 'registrationSource'
      | 'starter'
      | 'model'
      | 'tier',
    value: string,
  ) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key === 'review' && (value === 'workspace' || value === 'scorecard'))
        next.set('owner', 'me');
      return next;
    });
  }

  const pendingFirstDecisions = new Map(
    reviewTurnaround?.pendingAppIds?.map((appId, index) => [appId, index]),
  );
  const firstDecisionWait = new Map(
    reviewTurnaround?.pendingApps?.map(app => [app.appId, app.workingDays]),
  );
  function missingSignoffs(app: App) {
    return isIndependentReviewer(app, actor) && requiresCriticalReview(app, now)
      ? reviewerTracks.filter(track => !app.signoffs?.[track])
      : [];
  }

  function matchesReviewFilter(app: App) {
    if (app.tier !== 3 || app.lifecycle === 'retired') return false;
    if (reviewFilter === 'attention') return appReview(app, now).priority <= 1;
    if (reviewFilter === 'required') return requiresCriticalReview(app, now);
    if (reviewFilter === 'missing-ticket')
      return !app.reviewTicketUrl && requiresCriticalReview(app, now);
    if (reviewFilter === 'missing-evidence')
      return (
        !!app.missingCriticalReviewEvidence?.length &&
        requiresCriticalReview(app, now)
      );
    if (firstDecisionQueue) {
      if (!pendingFirstDecisions.has(app.id)) return false;
      if (!firstDecisionTargetQueue) return true;
      const wait = firstDecisionWait.get(app.id);
      const target = reviewTurnaround?.target?.workingDays;
      return wait !== undefined && target !== undefined && wait >= target;
    }
    if (reviewFilter === 'mine') return missingSignoffs(app).length > 0;
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

  if (firstDecisionQueue) {
    matching.sort(
      (a, b) =>
        (pendingFirstDecisions.get(a.id) ?? 0) -
        (pendingFirstDecisions.get(b.id) ?? 0),
    );
  } else if (inventoryReviewFilter === 'reassess') {
    matching.sort((a, b) => {
      const currentA = a.riskAssessment?.tier ?? a.tier;
      const currentB = b.riskAssessment?.tier ?? b.tier;
      return (
        Number(currentB > b.tier) - Number(currentA > a.tier) ||
        currentB - currentA ||
        a.name.localeCompare(b.name)
      );
    });
  } else if (inventoryReviewFilter === 'workspace') {
    matching.sort(
      (a, b) =>
        (ownerWorkspaceIssues.get(a.id)?.due ?? Number.POSITIVE_INFINITY) -
          (ownerWorkspaceIssues.get(b.id)?.due ?? Number.POSITIVE_INFINITY) ||
        a.name.localeCompare(b.name),
    );
  } else if (
    view === 'Reviews' ||
    ownershipScope !== 'all' ||
    inventoryReviewFilter === 'overdue'
  ) {
    matching.sort((a, b) => {
      if (
        view === 'Inventory' &&
        ownershipScope === 'me' &&
        inventoryReviewFilter !== 'overdue'
      ) {
        const retirementPriority =
          Number(ownerCanDecideRetirement(b, actor)) -
          Number(ownerCanDecideRetirement(a, actor));
        if (retirementPriority) return retirementPriority;
      }
      const priority = appReview(a, now).priority - appReview(b, now).priority;
      const aDue =
        scheduledReviewDate(a)?.getTime() ?? Number.POSITIVE_INFINITY;
      const bDue =
        scheduledReviewDate(b)?.getTime() ?? Number.POSITIVE_INFINITY;
      const waitPriority = showFirstDecisionWait
        ? (firstDecisionWait.get(b.id) ?? -1) -
          (firstDecisionWait.get(a.id) ?? -1)
        : 0;
      return (
        priority || aDue - bDue || waitPriority || a.name.localeCompare(b.name)
      );
    });
  }

  const portfolioReviewCalendar =
    canReview &&
    ownershipScope === 'all' &&
    inventoryReviewFilter === 'upcoming';
  const reminderEntries =
    ownershipScope !== 'all' || portfolioReviewCalendar
      ? matching.flatMap((app): Parameters<typeof reviewCalendar>[0] => {
          const entries: Parameters<typeof reviewCalendar>[0] = [];
          const reviewDue = scheduledReviewDate(app);
          const workspaceDue = scheduledWorkspaceAttestationDate(app);
          if (reviewDue) entries.push({ app, due: reviewDue });
          if (workspaceDue && !portfolioReviewCalendar)
            entries.push({
              app,
              due: workspaceDue,
              kind: 'hosted-attestation',
            });
          return entries;
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
    if (firstDecisionTargetQueue) {
      emptyTitle = 'No apps at or over the review target';
      emptyMessage = reviewTurnaround?.target
        ? 'Check all first decisions to see the rest of the queue.'
        : 'No first-decision target is configured.';
    }
    if (reviewFilter === 'missing-ticket') {
      emptyTitle = 'No missing review tickets';
      emptyMessage =
        'Every app that currently requires review has a linked ticket.';
    }
    if (reviewFilter === 'missing-evidence') {
      emptyTitle = 'No missing required evidence';
      emptyMessage =
        'No apps currently requiring review are missing required evidence.';
    }
    if (reviewFilter === 'mine') {
      emptyTitle = 'No pending sign-offs for you';
      emptyMessage = 'Check all critical apps to see the rest of the queue.';
    }
  }
  if (hasListFilters) {
    emptyTitle = 'No matching apps';
    emptyMessage = 'Try another search or clear the filters.';
  }

  const showRegistrationFeedback =
    registrationFeedback &&
    (registrationFeedback.detailId
      ? view === 'Discovery' && selected?.id === registrationFeedback.detailId
      : view === 'Inventory' && !detailId);
  const registrationFeedbackPrompt = showRegistrationFeedback && (
    <div className="gov-notice gov-registration-feedback">
      {registrationFeedback.answered ? (
        <p role="status">Thanks for your feedback.</p>
      ) : (
        <fieldset>
          <legend>How satisfied were you with registration?</legend>
          <div className="gov-feedback-actions">
            {(['Dissatisfied', 'Neutral', 'Satisfied'] as const).map(
              (label, index) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    analytics.captureEvent(
                      'rate-registration',
                      'governance-app',
                      {
                        value: index + 1,
                        attributes: {
                          source: registrationFeedback.source,
                          tier: registrationFeedback.tier,
                        },
                      },
                    );
                    setRegistrationFeedback({
                      ...registrationFeedback,
                      answered: true,
                    });
                  }}
                >
                  {label}
                </button>
              ),
            )}
            <button
              type="button"
              onClick={() => setRegistrationFeedback(undefined)}
            >
              Skip feedback
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );

  return (
    <WorkspaceLayout view={view} onNavigate={resetView}>
      {loadingDiscoveryApp && !loading && (
        <p className="gov-notice" role="status">
          Loading app record…
        </p>
      )}
      {detailId && !loading && !loadingDiscoveryApp && !error && !selected && (
        <p className="gov-notice" role="status">
          This app record is unavailable.
        </p>
      )}
      {view !== 'Directory' && error && !selected && (
        <p
          className={
            view === 'Import' ? 'gov-notice gov-import-error' : 'gov-notice'
          }
          role="alert"
        >
          {error}
        </p>
      )}
      {view !== 'Directory' && message && !selected && (
        <p className="gov-notice" role="status">
          {message}
        </p>
      )}
      {!selected && registrationFeedbackPrompt}
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
          {!loading && !error && myRetirementDecisionCount > 0 && (
            <p className="gov-notice">
              <Link to="/?owner=me&review=retirement">
                {myRetirementDecisionCount === 1
                  ? '1 app needs your retirement decision'
                  : `${myRetirementDecisionCount} apps need your retirement decision`}
              </Link>
            </p>
          )}
          {!loading && !error && myAccessRequestAppCount > 0 && (
            <p className="gov-notice">
              <Link to="/?owner=me&review=access">
                {myAccessRequestAppCount === 1
                  ? '1 of your apps has pending access requests'
                  : `${myAccessRequestAppCount} of your apps have pending access requests`}
              </Link>
            </p>
          )}
          {view === 'Inventory' &&
            !loading &&
            !error &&
            ownerWorkspaceIssues.size > 0 && (
              <p className="gov-notice">
                <Link to="/?owner=me&review=workspace">
                  {ownerWorkspaceIssues.size === 1
                    ? '1 of your apps needs a workspace confirmation'
                    : `${ownerWorkspaceIssues.size} of your apps need workspace confirmations`}
                </Link>
              </p>
            )}
          {view === 'Inventory' && !loading && !error && actor && (
            <>
              {myReassessmentCount > 0 &&
                inventoryReviewFilter !== 'reassess' && (
                  <p className="gov-notice">
                    <Link to="/?owner=me&review=reassess">
                      {myReassessmentCount === 1
                        ? '1 of your apps needs risk reassessment'
                        : `${myReassessmentCount} of your apps need risk reassessment`}
                    </Link>
                  </p>
                )}
              {ownerScorecardIssues.size > 0 && (
                <p className="gov-notice">
                  <Link to={`/?${scorecardQueueParams}`}>
                    {ownerScorecardIssues.size === 1
                      ? '1 of your active apps needs scorecard attention'
                      : `${ownerScorecardIssues.size} of your active apps need scorecard attention`}
                  </Link>
                </p>
              )}
              {(ownerScorecard === null ||
                ownerScorecard?.catalogUnavailable) && (
                <div className="gov-notice">
                  {ownerScorecard === null ? (
                    <p role="alert">Scorecard issues could not be loaded.</p>
                  ) : (
                    <p role="status">
                      Catalog unavailable. Some scorecard checks could not be
                      completed.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setScorecardLoadAttempt(attempt => attempt + 1)
                    }
                  >
                    Retry loading scorecard issues
                  </button>
                </div>
              )}
            </>
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
                    <span className="gov-visually-hidden">
                      Accountable owner
                    </span>
                    <select
                      value={accountableOwnerFilter ?? ''}
                      onChange={event =>
                        setAppListFilter('accountableOwner', event.target.value)
                      }
                    >
                      <option value="">Any accountable owner</option>
                      {accountableOwnerFilter &&
                        !accountableOwners.includes(accountableOwnerFilter) && (
                          <option>{accountableOwnerFilter}</option>
                        )}
                      {options(accountableOwners)}
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
                    <span className="gov-visually-hidden">
                      Registration source
                    </span>
                    <select
                      value={registrationSourceFilter ?? ''}
                      onChange={event =>
                        setAppListFilter(
                          'registrationSource',
                          event.target.value,
                        )
                      }
                    >
                      <option value="">All registration sources</option>
                      {Object.entries(appRegistrationSources).map(
                        ([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    <span className="gov-visually-hidden">Starter</span>
                    <select
                      value={starterFilter ?? ''}
                      onChange={event =>
                        setAppListFilter('starter', event.target.value)
                      }
                    >
                      <option value="">All starters</option>
                      <option value="none">No starter recorded</option>
                      {starterFilter &&
                        starterFilter !== 'none' &&
                        !recordedStarters.includes(starterFilter) && (
                          <option value={starterFilter}>
                            {findStarter(starterFilter)?.name ?? starterFilter}
                          </option>
                        )}
                      {recordedStarters.map(id => (
                        <option key={id} value={id}>
                          {findStarter(id)?.name ?? id}
                        </option>
                      ))}
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
                    <span className="gov-visually-hidden">Declared model</span>
                    <select
                      value={modelFilter ?? ''}
                      onChange={event =>
                        setAppListFilter('model', event.target.value)
                      }
                    >
                      <option value="">All declared models</option>
                      {modelFilter && !declaredModels.includes(modelFilter) && (
                        <option>{modelFilter}</option>
                      )}
                      {options(declaredModels)}
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
                      {canFilterReassessment && (
                        <option value="reassess">
                          Needs risk reassessment
                        </option>
                      )}
                      <option value="overdue">
                        Overdue reviews and attestations
                      </option>
                      <option value="upcoming">Due in the next 30 days</option>
                      <option value="workspace">
                        My workspace confirmations
                      </option>
                      <option value="scorecard">My scorecard issues</option>
                      <option value="access">My pending access requests</option>
                      <option value="retirement">
                        My retirement decisions
                      </option>
                    </select>
                  </label>
                </>
              )}
              {view === 'Reviews' && (
                <label>
                  <span className="gov-visually-hidden">Review status</span>
                  <select
                    ref={reviewStatusSelect}
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
                    {canReview && (
                      <option value="first">Awaiting first decision</option>
                    )}
                    {canReview && (
                      <option value="missing-ticket">
                        Missing review ticket
                      </option>
                    )}
                    {canReview && (
                      <option value="missing-evidence">
                        Missing required evidence
                      </option>
                    )}
                    {canReview &&
                      (reviewTurnaround?.target ||
                        firstDecisionTargetQueue) && (
                        <option value="first-target">
                          At or over first-decision target
                        </option>
                      )}
                    {canReview && reviewerTracks.length > 0 && (
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
                        inventoryCsv(
                          matching,
                          now,
                          config.getString('app.baseUrl'),
                        ),
                        'frontstage-inventory.csv',
                      )
                    }
                  >
                    Download inventory CSV
                  </button>
                )}
              {firstDecisionQueue &&
                !loading &&
                !error &&
                matching.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      downloadCsv(
                        firstDecisionsCsv(
                          matching.map(app => ({
                            ...app,
                            workingDays: firstDecisionWait.get(app.id),
                          })),
                          reviewTurnaround?.target?.workingDays,
                        ),
                        'frontstage-first-decisions.csv',
                      )
                    }
                  >
                    Download first decisions CSV
                  </button>
                )}
              {missingTicketQueue &&
                !loading &&
                !error &&
                matching.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      downloadCsv(
                        missingReviewTicketsCsv(
                          matching.map(app => ({
                            ...app,
                            firstDecisionWait: firstDecisionWait.get(app.id),
                          })),
                          config.getString('app.baseUrl'),
                          reviewTracks,
                        ),
                        'frontstage-missing-review-tickets.csv',
                      )
                    }
                  >
                    Download missing review tickets CSV
                  </button>
                )}
              {view === 'Reviews' &&
                reviewFilter === 'mine' &&
                !loading &&
                !error &&
                matching.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      downloadCsv(
                        pendingSignoffsCsv(
                          matching.map(app => ({
                            ...app,
                            missingTracks: missingSignoffs(app),
                            firstDecisionWait: firstDecisionWait.get(app.id),
                          })),
                          config.getString('app.baseUrl'),
                        ),
                        'frontstage-pending-signoffs.csv',
                      )
                    }
                  >
                    Download pending sign-offs CSV
                  </button>
                )}
              {!loading && !error && reminderEntries.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    downloadReviewReminders(
                      reminderEntries,
                      portfolioReviewCalendar
                        ? 'frontstage-upcoming-reviews.ics'
                        : 'frontstage-my-reviews.ics',
                    )
                  }
                >
                  {portfolioReviewCalendar
                    ? 'Download upcoming review calendar'
                    : 'Download my review calendar'}
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
            {firstDecisionQueue &&
              reviewTurnaround === undefined &&
              !loading && (
                <p className="gov-empty" role="status">
                  Loading first decisions…
                </p>
              )}
            {firstDecisionQueue && reviewTurnaround === null && (
              <div className="gov-notice">
                <p role="alert">First decisions could not be loaded.</p>
                <button type="button" onClick={retryReviewTurnaround}>
                  Retry loading first decisions
                </button>
              </div>
            )}
            {!loading &&
              actor &&
              inventoryReviewFilter === 'scorecard' &&
              ownerScorecard === undefined && (
                <p className="gov-empty" role="status">
                  Loading scorecard issues…
                </p>
              )}
            {!loading &&
              (!firstDecisionQueue || reviewTurnaround) &&
              (inventoryReviewFilter !== 'scorecard' ||
                (ownerScorecard && !ownerScorecard.catalogUnavailable)) &&
              matching.length === 0 && (
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
                          accountableOwnerFilter ||
                          registrationSourceFilter ||
                          starterFilter ||
                          modelFilter ||
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
                            next.delete('accountableOwner');
                            next.delete('registrationSource');
                            next.delete('starter');
                            next.delete('model');
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
                      const daysOverdue = reviewDaysOverdue(app, now);
                      const waitingDays = showFirstDecisionWait
                        ? firstDecisionWait.get(app.id)
                        : undefined;
                      return (
                        <tr key={app.id}>
                          <td className="gov-app-cell">
                            <button
                              type="button"
                              className="gov-app-link"
                              aria-haspopup="dialog"
                              onClick={() => openAppRecord(app)}
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
                            {inventoryReviewFilter === 'reassess' &&
                              app.riskAssessment && (
                                <>
                                  <small className="gov-current-tier">
                                    Current policy tier{' '}
                                    {app.riskAssessment.tier}
                                  </small>
                                  <button
                                    type="button"
                                    aria-haspopup="dialog"
                                    aria-label={`Reassess ${app.name}`}
                                    onClick={() => openAppRecord(app, true)}
                                  >
                                    Reassess
                                  </button>
                                </>
                              )}
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
                            {inventoryReviewFilter === 'scorecard' && (
                              <small>
                                {ownerScorecardIssues.get(app.id)?.join(' · ')}
                              </small>
                            )}
                            {view === 'Inventory' &&
                              ownerWorkspaceIssues.has(app.id) && (
                                <small>
                                  {ownerWorkspaceIssues.get(app.id)?.label}
                                </small>
                              )}
                            {view === 'Inventory' &&
                              ownerCanDecideRetirement(app, actor) && (
                                <small>Retirement decision requested</small>
                              )}
                            {view === 'Inventory' &&
                              graduationEnabled &&
                              nomineeCanDecideGraduation(app, actor) && (
                                <small>
                                  Engineering co-owner decision requested
                                </small>
                              )}
                            {daysOverdue !== undefined && (
                              <small>
                                {daysOverdue === 0
                                  ? 'Less than a day overdue'
                                  : `${daysOverdue} ${
                                      daysOverdue === 1 ? 'day' : 'days'
                                    } overdue`}
                              </small>
                            )}
                            {waitingDays !== undefined && (
                              <small>
                                {waitingDays.toLocaleString('en-US', {
                                  maximumFractionDigits: 1,
                                })}{' '}
                                weekdays waiting
                                {!firstDecisionQueue && ' for first decision'}
                              </small>
                            )}
                            {waitingDays !== undefined &&
                              reviewTurnaround?.target &&
                              waitingDays >=
                                reviewTurnaround.target.workingDays && (
                                <small>At or over review target</small>
                              )}
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
            <CopyAppLink
              key={`copy-app-link-${selected.id}`}
              appId={selected.id}
            />
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
            {registrationFeedbackPrompt}
            <p>
              {selected.lifecycle} ·{' '}
              {selected.usesAiAtRuntime === false
                ? 'No runtime AI'
                : selected.models.join(', ')}{' '}
              · <a href={selected.sourceUrl}>Open source</a>
            </p>
            <p>
              Registration source ·{' '}
              {
                appRegistrationSources[
                  registrationSource(selected.discoverySource)
                ]
              }
            </p>
            {canRecordReview &&
              selected &&
              requiresCriticalReview(selected, now) && (
                <button
                  className="gov-button"
                  type="button"
                  onClick={() => decisionField.current?.focus()}
                >
                  Go to review decision
                </button>
              )}
            {selected.deliveryStage && (
              <p>
                Delivery stage:{' '}
                {selected.deliveryStage === 'poc'
                  ? 'proof of concept'
                  : selected.deliveryStage}
              </p>
            )}
            {selected.starterId && (
              <p>
                Registered from starter{' '}
                {findStarter(selected.starterId)?.name ?? selected.starterId}
              </p>
            )}
            {!!selected.connections?.length &&
              (actor === selected.owner || canReview) && (
                <DeclaredConnections
                  connections={selected.connections}
                  classification={
                    selected.effectiveClassification ?? selected.classification
                  }
                />
              )}
            {selected.riskAssessment && (
              <details className="gov-app-editor" key={selected.id}>
                <summary>Current risk assessment</summary>
                <p>
                  Tier {selected.riskAssessment.tier} ·{' '}
                  {tierNames[selected.riskAssessment.tier - 1]}
                </p>
                <TierReasons codes={selected.riskAssessment.reasons} />
                {selected.riskAssessment.tier !== selected.tier && (
                  <p>
                    This record was saved as Tier {selected.tier}.{' '}
                    {actor === selected.owner || canReview
                      ? 'Complete any required fields and save the app details to apply the current policy.'
                      : 'Ask the accountable owner or a reviewer to update this record.'}
                  </p>
                )}
              </details>
            )}
            {selected.nextReview && (
              <p>Next review due {selected.nextReview.slice(0, 10)}.</p>
            )}
            {canDownloadReminders && reviewDate && (
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
                      applySavedApp(updated);
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
            {selected.hosted && selected.lifecycle !== 'retired' && (
              <section aria-label="Hosted workspace attestation">
                <h3>Quarterly hosted workspace attestation</h3>
                <p>
                  {selected.hosted.provider} · {selected.hosted.workspace} ·
                  Sharing: {selected.hosted.sharing} · Data access:{' '}
                  {selected.hosted.dataAccess}
                  {selected.hosted.dataClassification &&
                    ` (${selected.hosted.dataClassification})`}
                </p>
                {selected.hostedAttestation ? (
                  <p>
                    Last confirmed {selected.hostedAttestation.at.slice(0, 10)}.{' '}
                    {Date.parse(selected.hostedAttestation.nextDue) <= now
                      ? 'Overdue since'
                      : 'Next due'}{' '}
                    {selected.hostedAttestation.nextDue.slice(0, 10)}.
                  </p>
                ) : (
                  <p>Workspace settings have not been confirmed.</p>
                )}
                {canDownloadReminders && hostedAttestationDue && (
                  <button
                    type="button"
                    onClick={() =>
                      downloadReviewReminders(
                        [
                          {
                            app: selected,
                            due: hostedAttestationDue,
                            kind: 'hosted-attestation',
                          },
                        ],
                        'frontstage-workspace-attestation.ics',
                      )
                    }
                  >
                    Download workspace reminder
                  </button>
                )}
                {actor === selected.owner &&
                  selected.hostedWorkspaceAllowed === false && (
                    <p>
                      Choose an approved workspace and use its permitted sharing
                      and data access settings in Edit app details before
                      confirming.
                    </p>
                  )}
                {actor === selected.owner &&
                  selected.hostedWorkspaceAllowed !== false && (
                    <form
                      key={`hosted-attest-${selected.id}-${selected.updatedAt}`}
                      onSubmit={event =>
                        submit(event, async data => {
                          const updated = await api(
                            `/apps/${selected.id}/hosted-attestation`,
                            {
                              confirmed: data.get('confirmed') === 'on',
                              expectedUpdatedAt: selected.updatedAt,
                            },
                          );
                          applySavedApp(updated);
                          setMessage('Hosted workspace attestation recorded.');
                        })
                      }
                    >
                      <label>
                        <input type="checkbox" name="confirmed" required />I
                        checked the provider and confirm the workspace, sharing,
                        and data access match this record.
                      </label>
                      <button disabled={busy}>
                        Record workspace attestation
                      </button>
                    </form>
                  )}
              </section>
            )}
            {(approvalBlocked ||
              evidenceFields.some(([field]) => selected.evidence?.[field])) && (
              <section aria-label="Review evidence">
                <h3>Review evidence</h3>
                {approvalBlocked && (
                  <p id="critical-review-evidence-requirements">
                    Add the missing links under Review evidence in Edit app
                    details before approving this app.
                  </p>
                )}
                <ul>
                  {evidenceFields.map(([field, label]) => {
                    if (missingReviewEvidence.includes(field))
                      return (
                        <li key={field}>
                          <span>{label}</span> · Required before approval
                        </li>
                      );
                    const url = selected.evidence?.[field];
                    return url ? (
                      <li key={field}>
                        <a href={url} target="_blank" rel="noreferrer">
                          {label}
                        </a>
                      </li>
                    ) : null;
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
            {selected.tier === 3 &&
              selected.lifecycle !== 'retired' &&
              (actor === selected.owner || canReview) && (
                <details
                  className="gov-app-editor"
                  key={`review-ticket-${selected.id}`}
                  ref={ticketEditor}
                >
                  <summary>Edit review ticket</summary>
                  <ReviewTicketContext
                    key={selected.updatedAt}
                    app={selected}
                    tracks={reviewTracks}
                  />
                  <p>Clear the URL and save to remove the ticket link.</p>
                  <form
                    key={selected.updatedAt}
                    onSubmit={event => {
                      if (appEditorOpen) {
                        event.preventDefault();
                        return;
                      }
                      submit(event, async data => {
                        const url =
                          String(data.get('ticket-url') ?? '').trim() || null;
                        applySavedApp(
                          await api(
                            `/apps/${selected.id}/review-ticket`,
                            { url, expectedUpdatedAt: selected.updatedAt },
                            'PATCH',
                          ),
                        );
                        setMessage(
                          url
                            ? 'Review ticket saved.'
                            : 'Review ticket removed.',
                        );
                      });
                    }}
                  >
                    <label>
                      Ticket URL
                      <input
                        name="ticket-url"
                        type="url"
                        defaultValue={selected.reviewTicketUrl}
                      />
                    </label>
                    {appEditorOpen && (
                      <p>
                        Save any changes to the app details and close that
                        editor to use this shortcut.
                      </p>
                    )}
                    <button disabled={busy || appEditorOpen}>
                      Save review ticket
                    </button>
                  </form>
                </details>
              )}
            {selected.reviewNotes && <p>{selected.reviewNotes}</p>}
            {(actor === selected.owner || canReview) && (
              <details
                className="gov-app-editor"
                key={appEditorKey}
                onToggle={event =>
                  setAppEditorToggle({
                    key: appEditorKey,
                    open: event.currentTarget.open,
                  })
                }
                open={appEditorOpen}
              >
                <summary ref={editorSummary}>Edit app details</summary>
                {selected.tier === 3 && (
                  <p>
                    Changes to purpose, ownership, connected systems, or review
                    evidence require a new review. Moving to production also
                    requires a new review.
                  </p>
                )}
                {actorIsAcceptedCoOwner && (
                  <p id="engineering-handoff-edit-help">
                    Ask the accountable owner or another reviewer to change the
                    owner or delivery stage. These changes end your engineering
                    handoff.
                  </p>
                )}
                <form
                  onSubmit={event =>
                    submit(event, async data => {
                      const connectionAccesses =
                        data.getAll('connectionAccess');
                      const updated = await api(
                        `/apps/${selected.id}`,
                        {
                          ...selected,
                          purpose: data.get('purpose'),
                          connections: data
                            .getAll('connectionName')
                            .map((name, index) => ({
                              name: String(name).trim(),
                              access: connectionAccesses[index],
                            })),
                          hosted: selected.hosted && {
                            ...selected.hosted,
                            provider: data.get('hostedProvider'),
                            workspace: data.get('hostedWorkspace'),
                            sharing: data.get('hostedSharing'),
                            dataAccess: data.get('hostedDataAccess'),
                            dataClassification:
                              data.get('hostedDataAccess') === 'none'
                                ? undefined
                                : data.get('hostedDataClassification') ||
                                  undefined,
                          },
                          usesAiAtRuntime: editingUsesAi,
                          models: editingUsesAi
                            ? String(data.get('models') ?? '')
                                .split(',')
                                .map(model => model.trim())
                                .filter(Boolean)
                            : [],
                          deliveryStage: actorIsAcceptedCoOwner
                            ? selected.deliveryStage
                            : data.get('deliveryStage') || undefined,
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
                      applySavedApp(updated);
                      const tierChanged = updated.tier !== selected.tier;
                      const outcome = tierChanged
                        ? `Risk tier updated to Tier ${updated.tier}.`
                        : 'App updated.';
                      const reviewRequired =
                        updated.reviewStatus === 'pending' &&
                        (tierChanged || selected.reviewStatus === 'approved');
                      setMessage(
                        reviewRequired
                          ? `${outcome} A new review is required before launch.`
                          : outcome,
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
                  {selected.hosted && (
                    <fieldset className="gov-fieldset">
                      <legend>Provider workspace</legend>
                      <Link
                        to={hostedWorkspaceGuidePath}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View approved workspaces (new tab)
                      </Link>
                      <label>
                        Provider
                        <input
                          required
                          name="hostedProvider"
                          defaultValue={selected.hosted.provider}
                        />
                      </label>
                      <label>
                        Workspace
                        <input
                          required
                          name="hostedWorkspace"
                          defaultValue={selected.hosted.workspace}
                        />
                      </label>
                      <label>
                        Sharing scope
                        <select
                          name="hostedSharing"
                          defaultValue={selected.hosted.sharing}
                        >
                          {options(sharing)}
                        </select>
                      </label>
                      <label>
                        Data access
                        <select
                          name="hostedDataAccess"
                          defaultValue={selected.hosted.dataAccess}
                        >
                          {options(hostedAccessOptions)}
                        </select>
                      </label>
                      <label>
                        Highest hosted data classification
                        <select
                          name="hostedDataClassification"
                          aria-describedby="hosted-edit-classification-help"
                          defaultValue={
                            selected.hosted.dataClassification ?? ''
                          }
                        >
                          <option value="">Select classification</option>
                          {options(classes)}
                        </select>
                      </label>
                      <small id="hosted-edit-classification-help">
                        Required when the app stores input or reads connected
                        data.
                      </small>
                    </fieldset>
                  )}
                  <label>
                    <span id="app-editor-owner-label">Owner</span>
                    <input
                      aria-labelledby="app-editor-owner-label"
                      required
                      name="owner"
                      readOnly={actorIsAcceptedCoOwner}
                      aria-describedby={
                        [
                          actorIsAcceptedCoOwner &&
                            'engineering-handoff-edit-help',
                          selected.usesAiAtRuntime !== false &&
                            'ownership-handoff-help',
                        ]
                          .filter(Boolean)
                          .join(' ') || undefined
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
                      disabled={actorIsAcceptedCoOwner}
                      aria-describedby={
                        actorIsAcceptedCoOwner
                          ? 'engineering-handoff-edit-help'
                          : undefined
                      }
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
                  <EditConnections
                    connections={selected.connections}
                    fieldsetRef={connectionsEditor}
                  />
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
            {selected.lifecycle === 'active' &&
              (actor === selected.owner || canReview) && (
                <AppDirectoryPublisher
                  key={`directory-publisher-${selected.id}`}
                  listing={selected.directoryListing}
                  launchEligible={selected.directoryLaunchEligible !== false}
                  updatedAt={selected.updatedAt}
                  busy={busy}
                  onPublish={event =>
                    submit(event, async data => {
                      applySavedApp(
                        await api(
                          `/apps/${selected.id}/directory`,
                          {
                            summary: String(data.get('summary') ?? '').trim(),
                            url: String(data.get('url') ?? '').trim(),
                            expectedUpdatedAt: selected.updatedAt,
                          },
                          'PUT',
                        ),
                      );
                      setMessage('Directory listing saved.');
                    })
                  }
                  onUnpublish={event =>
                    submit(event, async () => {
                      applySavedApp(
                        await api(
                          `/apps/${selected.id}/directory`,
                          { expectedUpdatedAt: selected.updatedAt },
                          'DELETE',
                        ),
                      );
                      setMessage('Directory listing removed.');
                    })
                  }
                />
              )}
            {(actor === selected.owner || canReview) && (
              <DirectoryRequestQueue
                key={`directory-requests-${selected.id}`}
                appId={selected.id}
                appRevision={selected.updatedAt}
                canRecordFulfillment={actor === selected.owner}
                onPendingChange={updatePendingAccessRequests}
                onDecisionSaved={() => setAuditVersion(version => version + 1)}
                listingMeetsLaunchRequirements={
                  selected.lifecycle === 'active' &&
                  selected.directoryLaunchEligible !== false &&
                  !!selected.directoryListing
                }
              />
            )}
            {actor === selected.backupOwner && (
              <AppBackupHandover
                key={`backup-handover-${selected.id}`}
                appId={selected.id}
                updatedAt={selected.updatedAt}
                tier={selected.tier}
                busy={busy}
                onTakeOwnership={event =>
                  submit(event, async data => {
                    applySavedApp(
                      await api(`/apps/${selected.id}/backup-handover`, {
                        backupOwner:
                          String(data.get('backupOwner') ?? '').trim() ||
                          undefined,
                        expectedUpdatedAt: selected.updatedAt,
                      }),
                    );
                    setMessage('You are now the accountable owner.');
                  })
                }
              />
            )}
            {(canNominateCoOwner ||
              selected.graduation ||
              needsProductionHandoff) && (
              <AppGraduation
                key={`graduation-${selected.updatedAt}`}
                graduation={selected.graduation}
                needsProductionHandoff={needsProductionHandoff}
                canNominate={canNominateCoOwner === true}
                canRemove={
                  (actor === selected.owner || canReview) &&
                  !actorIsAcceptedCoOwner
                }
                canDecide={
                  graduationEnabled &&
                  nomineeCanDecideGraduation(selected, actor)
                }
                busy={busy}
                onNominate={event =>
                  submit(event, async data => {
                    applySavedApp(
                      await api(`/apps/${selected.id}/graduation`, {
                        nominee: String(data.get('nominee') ?? '').trim(),
                        expectedUpdatedAt: selected.updatedAt,
                      }),
                    );
                    setMessage('Engineering co-owner nominated.');
                  })
                }
                onRemove={event =>
                  submit(event, async data => {
                    const ending = selected.graduation?.status === 'accepted';
                    applySavedApp(
                      await api(
                        `/apps/${selected.id}/graduation`,
                        {
                          expectedUpdatedAt: selected.updatedAt,
                          reason: ending
                            ? String(data.get('reason') ?? '').trim()
                            : undefined,
                        },
                        'DELETE',
                      ),
                    );
                    setMessage(
                      ending
                        ? 'Engineering handoff ended.'
                        : 'Engineering nomination cancelled.',
                    );
                  })
                }
                onDecide={event =>
                  submit(event, async data => {
                    applySavedApp(
                      await api(
                        `/apps/${selected.id}/graduation`,
                        {
                          decision: data.get('decision'),
                          reason:
                            String(data.get('reason') ?? '').trim() ||
                            undefined,
                          expectedUpdatedAt: selected.updatedAt,
                        },
                        'PATCH',
                      ),
                    );
                    setMessage('Co-owner decision recorded.');
                  })
                }
              />
            )}
            {(retirementCandidate || selected.retirementReview) && (
              <AppRetirementReview
                key={`retirement-review-${selected.id}-${selected.updatedAt}-${
                  liveActivityChangedAt ??
                  selected.retirementReview?.liveActivityChangedAt ??
                  ''
                }`}
                owner={selected.owner}
                candidateLastLiveCall={retirementCandidate?.lastLiveCall}
                activeSince={
                  retirementCandidate?.activeSince ?? selected.activeSince
                }
                review={
                  selected.retirementReview && liveActivityChangedAt
                    ? { ...selected.retirementReview, liveActivityChangedAt }
                    : selected.retirementReview
                }
                canDecide={ownerCanDecideRetirement(selected, actor)}
                busy={busy}
                onRequest={event =>
                  submit(event, async () => {
                    applySavedApp(
                      await api(`/apps/${selected.id}/retirement-review`, {
                        expectedUpdatedAt: selected.updatedAt,
                      }),
                    );
                    setMessage('Retirement review requested.');
                  })
                }
                onDecide={event =>
                  submit(event, async data => {
                    applySavedApp(
                      await api(
                        `/apps/${selected.id}/retirement-review`,
                        {
                          decision: data.get('decision'),
                          reason: String(data.get('reason') ?? '').trim(),
                          expectedUpdatedAt: selected.updatedAt,
                        },
                        'PATCH',
                      ),
                    );
                    setMessage('Retirement decision recorded.');
                  })
                }
              />
            )}
            {(actor === selected.owner || canReview) && (
              <form
                key={`${selected.id}-lifecycle-${selected.lifecycle}`}
                onSubmit={event =>
                  submit(event, async data => {
                    applySavedApp(
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
                    setMessage('Lifecycle updated.');
                  })
                }
              >
                <label>
                  Lifecycle
                  <select name="lifecycle" defaultValue={selected.lifecycle}>
                    {options(
                      actorIsAcceptedCoOwner
                        ? appLifecycles.filter(value => value !== 'retired')
                        : appLifecycles,
                    )}
                  </select>
                </label>
                <label>
                  Reason for lifecycle change (optional)
                  <textarea name="reason" maxLength={500} />
                </label>
                <p>
                  {actorIsAcceptedCoOwner
                    ? 'Ask the owner or another reviewer to retire this app.'
                    : 'Retiring an app also revokes its gateway key.'}
                </p>
                <button disabled={busy}>Update lifecycle</button>
              </form>
            )}
            {selected.tier === 3 &&
              selected.lifecycle !== 'retired' &&
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
            {canRecordReview && (
              <form
                key={selected.id}
                onSubmit={event =>
                  submit(event, async data => {
                    const status = data.get('status');
                    if (approvalBlocked && status !== 'changes needed') {
                      throw new Error(
                        'Add the required review evidence before approving.',
                      );
                    }
                    applySavedApp(
                      await api(`/apps/${selected.id}/reviews`, {
                        status,
                        ...(status === 'approved' &&
                          selected.humanApprovalEvidenceRequired && {
                            humanApprovalVerified:
                              data.get('humanApprovalVerified') === 'on',
                            humanApprovalEvidenceUrl: String(
                              data.get('humanApprovalEvidenceUrl') ?? '',
                            ).trim(),
                          }),
                        track: data.get('track') ?? undefined,
                        notes: data.get('notes'),
                        expectedUpdatedAt: selected.updatedAt,
                      }),
                    );
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
                  <select
                    name="status"
                    ref={decisionField}
                    value={decisionStatus}
                    aria-describedby={
                      approvalBlocked
                        ? 'critical-review-evidence-requirements'
                        : undefined
                    }
                    required
                    onChange={event =>
                      setReviewDecision({
                        appId: selected.id,
                        status: event.target.value,
                      })
                    }
                  >
                    {approvalBlocked && (
                      <option value="">Choose a decision</option>
                    )}
                    <option value="approved" disabled={approvalBlocked}>
                      approved
                    </option>
                    <option value="changes needed">changes needed</option>
                  </select>
                </label>
                <label>
                  Review notes
                  <textarea name="notes" required />
                </label>
                {requiresHumanApproval && (
                  <Fragment key={selected.updatedAt}>
                    <label>
                      <input
                        type="checkbox"
                        name="humanApprovalVerified"
                        required
                      />
                      I verified human approval for consequential actions
                    </label>
                    <label>
                      Human approval evidence URL
                      <input
                        type="url"
                        name="humanApprovalEvidenceUrl"
                        maxLength={2048}
                        pattern="[hH][tT][tT][pP][sS]://.+"
                        title="Enter an HTTPS URL"
                        required
                      />
                    </label>
                  </Fragment>
                )}
                <button disabled={busy}>Record decision</button>
              </form>
            )}
            {selected.tier === 3 && selected.lifecycle === 'active' && (
              <AppRenewalException
                key={`renewal-exception-${selected.updatedAt}`}
                nextReview={selected.nextReview}
                reviewStatus={selected.reviewStatus}
                exception={selected.renewalException}
                canManage={canManageRenewalException}
                separateSignoffs={reviewTracks.length > 0}
                busy={busy}
                onGrant={event =>
                  submit(event, async data => {
                    applySavedApp(
                      await api(`/apps/${selected.id}/renewal-exception`, {
                        expiresAt: new Date(
                          `${data.get('expiresAt')}Z`,
                        ).toISOString(),
                        reason: String(data.get('reason') ?? '').trim(),
                        expectedUpdatedAt: selected.updatedAt,
                      }),
                    );
                    setMessage('Renewal exception granted.');
                  })
                }
                onRevoke={event =>
                  submit(event, async () => {
                    applySavedApp(
                      await api(
                        `/apps/${selected.id}/renewal-exception`,
                        { expectedUpdatedAt: selected.updatedAt },
                        'DELETE',
                      ),
                    );
                    setMessage('Renewal exception revoked.');
                  })
                }
              />
            )}
            {(actor === selected.owner ||
              actor === selected.backupOwner ||
              canReview) && (
              <AppScorecard
                key={`scorecard-${selected.updatedAt}`}
                appId={selected.id}
                refreshVersion={scorecardLoadAttempt}
              />
            )}
            {canReview && (
              <AppAuditHistory
                key={`audit-${selected.updatedAt}`}
                appId={selected.id}
                refreshVersion={auditVersion}
              />
            )}
            {gatewayEnabled &&
              selected.type !== 'provider-hosted app' &&
              selected.usesAiAtRuntime !== false &&
              (actor === selected.owner || canReview) && (
                <GatewayPlayground
                  key={`${selected.id}-${selected.owner}-${
                    selected.lifecycle === 'retired'
                  }`}
                  app={selected}
                  onKeyChanged={() =>
                    setScorecardLoadAttempt(attempt => attempt + 1)
                  }
                />
              )}
          </article>
        )}
      </dialog>
      {view === 'Reports' && (
        <PortfolioReport
          apps={apps}
          appSaveVersion={appSaveVersion}
          discoveries={discoveries}
          discoveryUnavailable={Boolean(discoveryError)}
          onRetryDiscovery={() =>
            setDiscoveryLoadAttempt(attempt => attempt + 1)
          }
          report={
            usageReport?.days === usageDays ? usageReport.data : undefined
          }
          usageDays={usageDays}
          ownership={ownershipReport}
          onRetryOwnership={() =>
            setOwnershipLoadAttempt(attempt => attempt + 1)
          }
          hostedWorkspaces={hostedWorkspaceReport}
          reviewTurnaround={reviewTurnaround}
          onRetryReviewTurnaround={retryReviewTurnaround}
          canReview={canReview}
          loading={loading}
          usageError={usageReportError}
          onRetryUsage={() => setUsageLoadAttempt(attempt => attempt + 1)}
          usagePreview={usagePreview}
          onUsagePreview={setUsagePreview}
          onRegisterUsageSource={(sourceUrl, model) => {
            resetView();
            setUsageSelection({ sourceUrl, model });
            setParams({ view: 'register', source: 'outside-gateway' });
          }}
        />
      )}
      {view === 'Directory' && <AppDirectory />}
      {view === 'Discovery' && canReview && (
        <HostedSnapshotPreview
          apps={hostedSnapshot}
          sampleUrl={`${config
            .getString('app.baseUrl')
            .replace(/\/$/, '')}/examples/hosted-inventory.json`}
          onPreview={async (snapshot, signal) => {
            const result: { apps: HostedSnapshotApp[] } = await api(
              '/discovery/hosted/preview',
              snapshot,
              'POST',
              signal,
            );
            if (!signal.aborted) setHostedSnapshot(result.apps);
          }}
          onRegister={app => {
            resetView();
            setHostedSnapshotSelection(app);
            setParams({ view: 'register', source: 'hosted-snapshot' });
          }}
        />
      )}
      {view === 'Discovery' &&
        (discoveryError ? (
          <div className="gov-notice">
            <p role="alert">{discoveryError}</p>
            <button
              type="button"
              onClick={() => setDiscoveryLoadAttempt(attempt => attempt + 1)}
            >
              Retry loading Discovery
            </button>
          </div>
        ) : (
          <DiscoveryQueue
            result={discoveries}
            canReview={canReview}
            busy={busy}
            onScan={scanGithub}
            onDecision={decideDiscovery}
            onCheckSdkEvidence={id =>
              api(`/discovery/github/${encodeURIComponent(id)}/sdk-evidence`)
            }
          />
        ))}
      {view === 'Register' && repositoryId && !candidate && (
        <div className="gov-notice">
          <p role={discoveries || discoveryError ? 'alert' : 'status'}>
            {discoveryError ||
              (discoveries
                ? 'This repository is already registered or no longer available.'
                : 'Loading repository…')}
          </p>
          {discoveryError && (
            <button
              type="button"
              onClick={() => setDiscoveryLoadAttempt(attempt => attempt + 1)}
            >
              Retry loading repository
            </button>
          )}
          {(discoveries || discoveryError) && (
            <Link
              className="gov-button"
              to={{
                pathname: '/',
                search: discoveryRouteParams(params).toString(),
              }}
            >
              Back to Discovery
            </Link>
          )}
        </div>
      )}
      {registrationFormKey !== undefined && (
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
              {preview?.effectiveClassification &&
                preview.effectiveClassification !== registrationClass &&
                ` · Effective data classification: ${preview.effectiveClassification}`}
            </p>
            {preview && !preview.tier && (
              <button
                type="button"
                onClick={() => {
                  setRiskPreview(undefined);
                  setRiskPreviewAttempt(attempt => attempt + 1);
                }}
              >
                Retry risk assessment
              </button>
            )}
            {preview?.reasons && <TierReasons codes={preview.reasons} />}
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
            key={registrationFormKey}
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
                let endpoint = '/apps';
                if (candidate) {
                  endpoint = `/discovery/github/${encodeURIComponent(
                    candidate.id,
                  )}/claim`;
                } else if (hostedRegistration) {
                  endpoint = '/apps?source=hosted-snapshot';
                } else if (usageRegistrationSource) {
                  endpoint = '/apps?source=outside-gateway';
                }
                const deliveryStage = parseDeliveryStage(
                  value('deliveryStage'),
                );
                const startedAt = registrationStartedAt.current;
                const usageSignal = usageRegistrationSession.current?.signal;
                const registered: App = await api(endpoint, {
                  name: value('name'),
                  purpose: value('purpose'),
                  type: hostedRegistration
                    ? 'provider-hosted app'
                    : value('type'),
                  platform: value('platform'),
                  sourceUrl: candidate?.sourceUrl ?? value('sourceUrl'),
                  owner: value('owner'),
                  backupOwner: value('backupOwner') || undefined,
                  team: value('team'),
                  lifecycle: 'experimental',
                  audience: value('audience'),
                  classification: value('classification'),
                  usesAiAtRuntime,
                  deliveryStage,
                  starterId: descriptor?.starterId ?? starter?.id,
                  models: usesAiAtRuntime
                    ? value('models')
                        .split(',')
                        .map(model => model.trim())
                        .filter(Boolean)
                    : [],
                  connections: [
                    { name: value('system'), access: value('connections') },
                    ...additionalConnections.map((_, index) => ({
                      name: value(`connectionName-${index}`),
                      access: value(`connectionAccess-${index}`),
                    })),
                  ].filter(connection => connection.access),
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
                let source: 'intake' | 'discovery' | 'template' = 'intake';
                if (candidate || hostedRegistration) source = 'discovery';
                else if (starter) source = 'template';
                analytics.captureEvent('register-app', 'governance-app', {
                  value:
                    startedAt === undefined
                      ? undefined
                      : (performance.now() - startedAt) / 1000,
                  attributes: {
                    source,
                    tier: registered.tier,
                    deliveryStage: deliveryStage ?? 'unspecified',
                    usesAiAtRuntime,
                  },
                });
                mergeSavedApps([registered]);
                if (usageSignal?.aborted) return;
                let registrationMessage = candidate
                  ? 'Repository claimed and app registered.'
                  : 'App registered.';
                if (usageRegistrationSource && usagePreview) {
                  try {
                    const refreshed: OutsideGatewayUsagePreview = await api(
                      '/reports/outside-gateway/preview',
                      {
                        from: usagePreview.from,
                        to: usagePreview.to,
                        rows: usagePreview.rows.map(
                          ({ sourceUrl, model, calls }) => ({
                            sourceUrl,
                            model,
                            calls,
                          }),
                        ),
                      },
                      'POST',
                      usageSignal,
                    );
                    if (usageSignal?.aborted) return;
                    setUsagePreview({
                      ...refreshed,
                      savedReconciliationId: usagePreview.savedReconciliationId,
                    });
                  } catch {
                    if (usageSignal?.aborted) return;
                    setUsagePreview(undefined);
                    registrationMessage =
                      'App registered. Reload the usage file to refresh matches.';
                  }
                }
                if (hostedRegistration) {
                  setHostedSnapshot(previous =>
                    previous?.map(app =>
                      app.sourceUrl === registered.sourceUrl
                        ? { ...app, appId: registered.id }
                        : app,
                    ),
                  );
                }
                if (candidate || hostedRegistration) {
                  resetView();
                  setParams({
                    view: 'discovery',
                    ...(candidate && { discoveryStatus: 'registered' }),
                    app: registered.id,
                  });
                } else if (usageRegistrationSource) {
                  navigate('Reports');
                } else {
                  navigate('Inventory');
                }
                setRegistrationFeedback({
                  source,
                  tier: registered.tier,
                  detailId:
                    candidate || hostedRegistration ? registered.id : undefined,
                });
                setMessage(registrationMessage);
              })
            }
          >
            {candidate && (
              <RepositoryDescriptorPreview
                key={candidate.id}
                load={() =>
                  api(
                    `/discovery/github/${encodeURIComponent(
                      candidate.id,
                    )}/descriptor`,
                  )
                }
                apply={applyRepositoryDescriptor}
                applied={!!descriptor}
              />
            )}
            {hostedRegistration &&
              (hostedRegistration.sharing ||
                hostedRegistration.dataAccess ||
                hostedRegistration.dataClassification) && (
                <p className="gov-notice">
                  Confirm the settings from the provider snapshot before
                  registering this app.
                </p>
              )}
            <fieldset className="gov-fieldset" key={`app-${!!descriptor}`}>
              <legend>App details</legend>
              <label>
                App name
                <input
                  required
                  name="name"
                  maxLength={100}
                  defaultValue={
                    descriptor?.name ??
                    hostedRegistration?.name ??
                    candidate?.name.slice(0, 100) ??
                    starter?.name
                  }
                />
              </label>
              <label>
                Purpose
                <textarea
                  required
                  name="purpose"
                  maxLength={1000}
                  defaultValue={descriptor?.purpose}
                  placeholder={
                    starter
                      ? 'Describe what your app does and who will use it.'
                      : undefined
                  }
                />
              </label>
              <div className="governance-fields">
                <label>
                  App type
                  <select
                    name="type"
                    defaultValue={descriptor?.type ?? registerType}
                    disabled={!!hostedRegistration}
                  >
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
                      hostedRegistration?.provider ??
                      (candidate || starter
                        ? starterDefaults.platform
                        : undefined)
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
                    defaultValue={
                      candidate?.sourceUrl ??
                      hostedRegistration?.sourceUrl ??
                      usageRegistrationSource
                    }
                    readOnly={!!candidate || !!hostedRegistration}
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
                      descriptor?.deliveryStage ??
                      (starter
                        ? parseDeliveryStage(params.get('stage')) ?? 'trial'
                        : '')
                    }
                  >
                    <option value="">Select a stage</option>
                    {deliveryStageOptions()}
                  </select>
                </label>
              </div>
            </fieldset>
            <fieldset className="gov-fieldset" key={`owner-${!!descriptor}`}>
              <legend>Ownership</legend>
              <div className="governance-fields">
                <label>
                  Owner
                  <input
                    required
                    name="owner"
                    defaultValue={descriptor ? draft.owner : actor}
                    placeholder="user:default/name"
                  />
                </label>
                <label>
                  Owning team
                  <input
                    required
                    name="team"
                    defaultValue={descriptor?.team}
                    placeholder="group:default/team"
                  />
                </label>
                <label>
                  Backup owner (required for tiers 2 and 3)
                  <input
                    required={(preview?.tier ?? 1) >= 2}
                    name="backupOwner"
                    defaultValue={descriptor?.backupOwner}
                    placeholder="user:default/name"
                  />
                </label>
              </div>
            </fieldset>
            <fieldset className="gov-fieldset" key={`risk-${!!descriptor}`}>
              <legend>Audience and data</legend>
              <div className="governance-fields">
                <label>
                  Who uses it?
                  <select name="audience" defaultValue={descriptor?.audience}>
                    {options(audiences)}
                  </select>
                </label>
                <label>
                  Highest data classification
                  <select
                    name="classification"
                    defaultValue={
                      descriptor?.classification ?? initialClassification
                    }
                  >
                    {options(classes)}
                  </select>
                </label>
                <label>
                  Connected system access
                  <select
                    name="connections"
                    defaultValue={descriptor?.connections[0]?.access}
                  >
                    <option value="">None</option>
                    {options(['read', 'write'])}
                  </select>
                </label>
                {draft.connections && (
                  <label>
                    Connected system
                    <input
                      ref={primarySystemField}
                      required
                      name="system"
                      value={
                        draft.system ?? descriptor?.connections[0]?.name ?? ''
                      }
                    />
                  </label>
                )}
                {additionalConnections.map((connection, index) => (
                  <div
                    key={index}
                    className="governance-fields gov-claim-connection"
                  >
                    <label>
                      Connected system {index + 2} access
                      <select
                        name={`connectionAccess-${index}`}
                        defaultValue={connection.access}
                      >
                        <option value="">None</option>
                        {options(['read', 'write'])}
                      </select>
                    </label>
                    <label>
                      Connected system {index + 2}
                      <input
                        name={`connectionName-${index}`}
                        defaultValue={connection.name}
                        required={
                          !!(
                            draft[`connectionAccess-${index}`] ??
                            connection.access
                          )
                        }
                      />
                    </label>
                  </div>
                ))}
                {hosted && (
                  <>
                    <label>
                      Provider
                      <input
                        required
                        name="provider"
                        defaultValue={
                          descriptor?.hosted?.provider ??
                          hostedRegistration?.provider
                        }
                      />
                    </label>
                    <label>
                      Enterprise workspace
                      <input
                        required
                        name="workspace"
                        defaultValue={
                          descriptor?.hosted?.workspace ??
                          hostedRegistration?.workspace
                        }
                      />
                    </label>
                    <Link
                      to={hostedWorkspaceGuidePath}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View approved workspaces (new tab)
                    </Link>
                    <label>
                      Sharing scope
                      <select name="sharing" value={registrationSharing}>
                        {options(sharing)}
                      </select>
                    </label>
                    <label>
                      Data access
                      <select name="dataAccess" value={registrationDataAccess}>
                        {options(hostedAccessOptions)}
                      </select>
                    </label>
                    {registrationDataAccess !== 'none' && (
                      <label>
                        Highest hosted data classification
                        <select
                          required
                          name="hostedClass"
                          value={registrationHostedClass}
                        >
                          <option value="">Select classification</option>
                          {options(classes)}
                        </select>
                      </label>
                    )}
                  </>
                )}
              </div>
              {registrationAccesses.length > 0 && (
                <RegistrationConnectorGuidance
                  accesses={registrationAccesses}
                  primaryAccess={draft.connections}
                  onUseConnector={name => {
                    setDraft(previous => ({ ...previous, system: name }));
                    primarySystemField.current?.focus();
                  }}
                  classification={
                    hosted &&
                    registrationDataAccess !== 'none' &&
                    classes.indexOf(registrationHostedClass) >
                      classes.indexOf(registrationClass)
                      ? registrationHostedClass
                      : registrationClass
                  }
                />
              )}
              <label>
                <input
                  type="checkbox"
                  name="takesActions"
                  defaultChecked={descriptor?.takesActions}
                />{' '}
                Takes actions in other systems
              </label>
              {draft.takesActions && (
                <label>
                  Describe the actions
                  <input
                    required
                    name="actionDescription"
                    defaultValue={descriptor?.actionDescription}
                  />
                </label>
              )}
              <label>
                <input
                  type="checkbox"
                  name="affectsPeople"
                  defaultChecked={descriptor?.affectsPeople}
                />{' '}
                Affects decisions about people
              </label>
              <label>
                <input
                  type="checkbox"
                  name="personalData"
                  defaultChecked={descriptor?.personalData}
                />{' '}
                Processes personal data
              </label>
              <label>
                <input
                  type="checkbox"
                  name="critical"
                  defaultChecked={descriptor?.critical}
                />{' '}
                The business depends on it
              </label>
            </fieldset>
            <div className="gov-form-actions">
              <button
                type="button"
                onClick={() => {
                  if (usageRegistrationSource) navigate('Reports');
                  else if (candidate) {
                    resetView();
                    setParams(discoveryRouteParams(params));
                  } else if (hostedRegistration) navigate('Discovery');
                  else navigate('Inventory');
                }}
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
                const isDescriptor = importPreview.endpoint === '/repository';
                mergeSavedApps(isDescriptor ? [imported] : imported);
                if (isDescriptor) {
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
                          {app.starterId &&
                            ` · Starter: ${
                              findStarter(app.starterId)?.name ?? app.starterId
                            }`}
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
            <h2>Check your risk tier</h2>
            <p>
              In <Link to="/?view=register">registration</Link>, Risk assessment
              shows which answers or workspace rules determine the estimated
              tier. For an existing app, open Current risk assessment on its
              record. If policy has changed the tier, update any required
              details and save the record to apply it.
            </p>
            <Link className="gov-button" to="/?owner=me&review=reassess">
              Check my apps for reassessment
            </Link>
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
          <ApprovedCodingToolsGuide />
          <GatewayModelGuide />
          <ApprovedConnectorsGuide />
          <HostedWorkspaceGuide />
        </>
      )}
    </WorkspaceLayout>
  );
}

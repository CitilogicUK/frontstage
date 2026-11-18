import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  appClassifications,
  appLifecycles,
  appRiskTierNames,
} from './appDimensions';
import { deliveryStages, parseDeliveryStage } from './deliveryStages';
import AssessmentOutlinedIcon from '@material-ui/icons/AssessmentOutlined';
import { isReviewOverdue, requiresCriticalReview } from './reviewDue';
import {
  downloadCsv,
  ownershipIssuesCsv,
  portfolioCsv,
  type PortfolioExportRow,
} from './portfolioExport';
import { gatewayBlockReason } from './gatewayBlockReasons';
import { WorkspaceEmptyState, WorkspaceSearch } from './WorkspaceLayout';

type AppSummary = {
  id: string;
  name: string;
  team: string;
  owner: string;
  backupOwner?: string;
  tier: number;
  lifecycle: string;
  platform: string;
  classification: string;
  effectiveClassification?: string;
  deliveryStage?: string;
  usesAiAtRuntime?: boolean;
  reviewStatus: string;
  nextReview: string | null;
};

export type OwnershipReport = {
  issues: Array<{
    appId: string;
    name: string;
    unavailable: string[];
    availableBackupOwner?: string;
  }>;
};

export type UsageReport = {
  from: string;
  retirementReview?: {
    days: number;
    apps: Array<{ appId: string; lastLiveCall: string }>;
  };
  monthlySpendAlerts?: {
    monthStart: string;
    apps: Array<{
      appId: string;
      liveEstimatedCostUsd: number;
      thresholdUsd: number;
    }>;
  };
  blocks: Array<{
    appId: string;
    reason: string;
    mode: 'simulation' | 'openai';
    calls: number;
  }>;
  usage: Array<{
    appId: string;
    model: string;
    mode: 'simulation' | 'openai' | 'unclassified';
    calls: number;
    estimatedCostUsd: number;
    tokens?: PortfolioExportRow['tokens'];
  }>;
};

const modeLabels = {
  openai: 'Live OpenAI',
  simulation: 'Simulated',
  unclassified: 'Mode not recorded',
};

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 8,
});

export function PortfolioReport({
  apps,
  report,
  usageDays,
  ownership,
  ownershipError,
  canReview,
  loading,
  error,
}: {
  apps: AppSummary[];
  report?: UsageReport;
  usageDays: number;
  ownership?: OwnershipReport;
  ownershipError: boolean;
  canReview: boolean;
  loading: boolean;
  error: string;
}) {
  const windowLabel = usageDays === 1 ? '24 hours' : `${usageDays} days`;
  const [query, setQuery] = useState('');
  const [params, setParams] = useSearchParams();
  const selectedTeam = params.get('usageTeam') ?? '';
  const groupByModel = params.get('usageGroup') === 'model';
  const inventoryGroups = {
    lifecycle: {
      label: 'Lifecycle',
      values: appLifecycles,
      valueOf: (app: AppSummary) => app.lifecycle,
    },
    classification: {
      label: 'Data classification',
      values: appClassifications,
      valueOf: (app: AppSummary) =>
        app.effectiveClassification ?? app.classification,
    },
    tier: {
      label: 'Risk tier',
      values: appRiskTierNames.map((_, index) => String(index + 1)),
      valueOf: (app: AppSummary) => String(app.tier),
    },
    team: {
      label: 'Team',
      values: [...new Set(apps.map(app => app.team).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b),
      ),
      valueOf: (app: AppSummary) => app.team,
    },
    platform: {
      label: 'Platform',
      values: [...new Set(apps.map(app => app.platform))].sort((a, b) =>
        a.localeCompare(b),
      ),
      valueOf: (app: AppSummary) => app.platform,
    },
  };
  const requestedGroup = params.get('inventoryGroup');
  const inventoryGroup =
    requestedGroup && Object.hasOwn(inventoryGroups, requestedGroup)
      ? (requestedGroup as keyof typeof inventoryGroups)
      : 'lifecycle';
  const inventoryBreakdown = inventoryGroups[inventoryGroup];
  const inventoryCounts = new Map<string, number>();
  for (const app of apps) {
    const value = inventoryBreakdown.valueOf(app);
    inventoryCounts.set(value, (inventoryCounts.get(value) ?? 0) + 1);
  }

  function reportAppLink(appId: string, edit = false) {
    const next = new URLSearchParams(params);
    next.set('app', appId);
    if (edit) next.set('edit', '1');
    else next.delete('edit');
    return { search: next.toString() };
  }

  function setReportFilter(
    key: 'days' | 'usageTeam' | 'usageGroup' | 'inventoryGroup',
    value: string,
  ) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }
  const byId = new Map(apps.map(app => [app.id, app]));
  const ownershipIssues =
    ownership?.issues.map(issue => {
      const app = byId.get(issue.appId);
      const unavailable = issue.unavailable.map(ref => {
        let role = '';
        if (ref === app?.owner) role = 'Accountable owner';
        else if (ref === app?.backupOwner) role = 'Backup owner';
        else if (ref === app?.team) role = 'Team';
        return { role, ref };
      });
      return { ...issue, unavailable };
    }) ?? [];
  const inventory = apps.filter(app => app.lifecycle !== 'retired');
  const stages = new Map(
    [...Object.entries(deliveryStages), ['unset', 'Unspecified']].map(
      ([key, label]) => [key, { label, withAi: 0, withoutAi: 0 }],
    ),
  );
  for (const app of apps) {
    const key = parseDeliveryStage(app.deliveryStage ?? null) ?? 'unset';
    const stage = stages.get(key);
    if (stage) {
      if (app.usesAiAtRuntime === false) stage.withoutAi += 1;
      else stage.withAi += 1;
    }
  }
  const now = Date.now();
  const reviewable = inventory.filter(app => app.tier === 2 || app.tier === 3);
  const overdue = reviewable.filter(app => isReviewOverdue(app, now)).length;
  const critical = inventory.filter(app => requiresCriticalReview(app, now));
  const liveCost = report?.usage.reduce(
    (sum, row) => sum + (row.mode === 'openai' ? row.estimatedCostUsd : 0),
    0,
  );
  type UsageTotal = {
    liveCalls: number;
    otherCalls: number;
    blocked: number;
    liveCost: number;
  };
  const teamTotals = new Map<string, UsageTotal>();
  const modelTotals = new Map<string, UsageTotal>();

  function teamOf(appId: string) {
    return byId.get(appId)?.team ?? 'Unassigned';
  }

  function bucket(totals: Map<string, UsageTotal>, key: string) {
    const existing = totals.get(key);
    if (existing) return existing;
    const total = { liveCalls: 0, otherCalls: 0, blocked: 0, liveCost: 0 };
    totals.set(key, total);
    return total;
  }

  function addUsage(total: UsageTotal, row: UsageReport['usage'][number]) {
    if (row.mode === 'openai') {
      total.liveCalls += row.calls;
      total.liveCost += row.estimatedCostUsd;
    } else {
      total.otherCalls += row.calls;
    }
  }

  for (const row of report?.usage ?? []) {
    const team = teamOf(row.appId);
    addUsage(bucket(teamTotals, team), row);
    if (!selectedTeam || team === selectedTeam)
      addUsage(bucket(modelTotals, row.model), row);
  }
  for (const row of report?.blocks ?? [])
    bucket(teamTotals, teamOf(row.appId)).blocked += row.calls;
  const teams = [...teamTotals].sort(
    ([a, left], [b, right]) =>
      right.liveCost - left.liveCost || a.localeCompare(b),
  );
  const summaryRows = groupByModel
    ? [...modelTotals].sort(
        ([a, left], [b, right]) =>
          right.liveCost - left.liveCost || a.localeCompare(b),
      )
    : teams;
  const blocks = report?.blocks
    .filter(row => !selectedTeam || teamOf(row.appId) === selectedTeam)
    .sort((a, b) => b.calls - a.calls);
  const rows = report?.usage
    .map(row => ({
      ...row,
      name: byId.get(row.appId)?.name ?? row.appId,
      team: teamOf(row.appId),
    }))
    .filter(
      row =>
        (!selectedTeam || row.team === selectedTeam) &&
        [row.name, row.team, row.model, modeLabels[row.mode]].some(value =>
          value.toLowerCase().includes(query.trim().toLowerCase()),
        ),
    )
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);

  function downloadReport(team?: string) {
    if (!report) return;
    const baseFields = (row: { appId: string; mode: string }) => ({
      from: report.from,
      appId: row.appId,
      appName: byId.get(row.appId)?.name ?? row.appId,
      team: teamOf(row.appId),
      mode: row.mode,
    });
    const exportRows = [
      ...report.usage.map(row => ({
        ...baseFields(row),
        model: row.model,
        successfulCalls: row.calls,
        blockedCalls: 0,
        estimatedCostUsd: row.estimatedCostUsd,
        tokens: row.tokens,
      })),
      ...report.blocks.map(row => ({
        ...baseFields(row),
        reason: row.reason,
        successfulCalls: 0,
        blockedCalls: row.calls,
        estimatedCostUsd: 0,
      })),
    ];
    const csv = portfolioCsv(
      team ? exportRows.filter(row => row.team === team) : exportRows,
    );
    downloadCsv(
      csv,
      team ? 'frontstage-gateway-team.csv' : 'frontstage-gateway-report.csv',
    );
  }

  if (loading)
    return (
      <p className="gov-empty" role="status">
        Loading portfolio…
      </p>
    );

  return (
    <>
      <dl className="gov-report-summary">
        <div className="gov-panel">
          <dt>Non-retired apps</dt>
          <dd>{inventory.length}</dd>
        </div>
        <div className="gov-panel">
          <dt>Critical apps needing review</dt>
          <dd>{critical.length}</dd>
          {critical.length > 0 && (
            <div>
              <Link to="/?view=reviews&review=required">
                View required reviews
              </Link>
            </div>
          )}
        </div>
        <div className="gov-panel">
          <dt>Overdue reviews and attestations</dt>
          <dd>
            {reviewable.length
              ? `${Math.round((overdue / reviewable.length) * 100)}%`
              : '—'}
          </dd>
          <small>
            {overdue} of {reviewable.length} non-retired Tier 2 and Tier 3 apps
          </small>
          {overdue > 0 && (
            <div>
              <Link to="/?review=overdue">View overdue apps</Link>
            </div>
          )}
        </div>
        {liveCost !== undefined && (
          <div className="gov-panel">
            <dt>Live estimated cost · {windowLabel}</dt>
            <dd>{dollars.format(liveCost)}</dd>
          </div>
        )}
        {report && (
          <div className="gov-panel">
            <dt>Policy blocks · {windowLabel}</dt>
            <dd>{report.blocks.reduce((sum, row) => sum + row.calls, 0)}</dd>
          </div>
        )}
      </dl>
      <section
        className="gov-panel gov-stage-report"
        aria-labelledby="portfolio-inventory-breakdown"
      >
        <div className="gov-report-heading">
          <h2 id="portfolio-inventory-breakdown">
            Apps by {inventoryBreakdown.label.toLowerCase()}
          </h2>
          <label>
            Group inventory by
            <select
              value={inventoryGroup}
              onChange={event =>
                setReportFilter(
                  'inventoryGroup',
                  event.target.value === 'lifecycle' ? '' : event.target.value,
                )
              }
            >
              {Object.entries(inventoryGroups).map(([value, group]) => (
                <option key={value} value={value}>
                  {group.label}
                </option>
              ))}
            </select>
          </label>
          <dl className="gov-report-summary">
            {inventoryBreakdown.values.map(value => {
              const count = inventoryCounts.get(value) ?? 0;
              let label = value[0].toUpperCase() + value.slice(1);
              if (inventoryGroup === 'platform' || inventoryGroup === 'team')
                label = value;
              if (inventoryGroup === 'tier')
                label = appRiskTierNames[Number(value) - 1];
              return (
                <div key={value}>
                  <dt>{label}</dt>
                  <dd>
                    {count > 0 ? (
                      <Link
                        to={`/?${inventoryGroup}=${encodeURIComponent(value)}`}
                        aria-label={`${label}: ${count} ${
                          count === 1 ? 'app' : 'apps'
                        }`}
                      >
                        {count}
                      </Link>
                    ) : (
                      count
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      </section>
      <section
        className="gov-panel gov-stage-report"
        aria-labelledby="portfolio-stages"
      >
        <div className="gov-report-heading">
          <h2 id="portfolio-stages">Apps by delivery stage</h2>
          <p>
            All registered apps, including retired apps, grouped by runtime AI
            use.
          </p>
        </div>
        <div className="governance-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Delivery stage</th>
                <th scope="col">Uses runtime AI</th>
                <th scope="col">No runtime AI</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(stages, ([key, stage]) => (
                <tr key={key}>
                  <td className="gov-app-cell">
                    {stage.withAi + stage.withoutAi > 0 ? (
                      <Link to={`/?stage=${key}`}>{stage.label}</Link>
                    ) : (
                      stage.label
                    )}
                  </td>
                  {[
                    {
                      value: 'yes',
                      count: stage.withAi,
                      label: 'Uses runtime AI',
                    },
                    {
                      value: 'no',
                      count: stage.withoutAi,
                      label: 'No runtime AI',
                    },
                  ].map(({ value, count, label }) => (
                    <td key={value} data-label={label}>
                      {count > 0 ? (
                        <Link
                          to={`/?stage=${key}&runtime=${value}`}
                          aria-label={`${stage.label}, ${label}, ${count} ${
                            count === 1 ? 'app' : 'apps'
                          }`}
                        >
                          {count}
                        </Link>
                      ) : (
                        count
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {canReview && (
        <section
          className="gov-panel gov-stage-report"
          aria-labelledby="portfolio-ownership"
        >
          <div className="gov-report-heading">
            <h2 id="portfolio-ownership">Ownership issues</h2>
            <p>
              Non-retired apps with an inactive or missing catalog owner, backup
              owner, or team.
            </p>
            {ownershipError && (
              <p role="alert">Ownership status could not be checked.</p>
            )}
            {!ownership && !ownershipError && (
              <p role="status">Checking catalog ownership…</p>
            )}
            {ownership?.issues.length === 0 && (
              <p>No ownership issues found.</p>
            )}
            {ownershipIssues.length > 0 && (
              <>
                <button
                  type="button"
                  className="gov-button"
                  onClick={() =>
                    downloadCsv(
                      ownershipIssuesCsv(ownershipIssues),
                      'frontstage-ownership-issues.csv',
                    )
                  }
                >
                  Download ownership issues CSV
                </button>
                <ul>
                  {ownershipIssues.map(issue => (
                    <li key={issue.appId}>
                      <Link to={reportAppLink(issue.appId, true)}>
                        {issue.name}
                      </Link>
                      <p>
                        {issue.unavailable
                          .map(({ role, ref }) =>
                            role ? `${role}: ${ref}` : ref,
                          )
                          .join(' · ')}
                      </p>
                      {issue.availableBackupOwner && (
                        <p>Active backup owner: {issue.availableBackupOwner}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>
      )}
      {report?.monthlySpendAlerts && (
        <section
          className="gov-panel gov-stage-report"
          aria-labelledby="portfolio-spend-alerts"
        >
          <div className="gov-report-heading">
            <h2 id="portfolio-spend-alerts">Monthly spend thresholds</h2>
            <p>
              UTC month starting{' '}
              {report.monthlySpendAlerts.monthStart.slice(0, 10)}.
            </p>
            {report.monthlySpendAlerts.apps.length === 0 ? (
              <p>No apps have reached their threshold.</p>
            ) : (
              <ul>
                {report.monthlySpendAlerts.apps.map(app => (
                  <li key={app.appId}>
                    <Link to={reportAppLink(app.appId)}>
                      {byId.get(app.appId)?.name ?? app.appId}
                    </Link>
                    {' · '}
                    {dollars.format(app.liveEstimatedCostUsd)} estimated live
                    cost
                    {' · '}
                    {dollars.format(app.thresholdUsd)} threshold
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      {report?.retirementReview && (
        <section
          className="gov-panel gov-stage-report"
          aria-labelledby="portfolio-retirement-review"
        >
          <div className="gov-report-heading">
            <h2 id="portfolio-retirement-review">Retirement review</h2>
            <p>
              Active apps whose last recorded live gateway call was at least{' '}
              {report.retirementReview.days} days ago. Confirm usage outside the
              gateway with the app owner before deciding whether to retire it.
            </p>
            {report.retirementReview.apps.length === 0 ? (
              <p>No apps match this gateway activity threshold.</p>
            ) : (
              <ul>
                {report.retirementReview.apps.map(app => (
                  <li key={app.appId}>
                    <Link to={reportAppLink(app.appId)}>
                      {byId.get(app.appId)?.name ?? app.appId}
                    </Link>
                    {' · Last live call '}
                    <time dateTime={app.lastLiveCall}>
                      {app.lastLiveCall.slice(0, 10)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      {teams.length > 0 && (
        <section
          className="gov-panel gov-stage-report"
          aria-labelledby="portfolio-teams"
        >
          <div className="gov-report-heading">
            <h2 id="portfolio-teams">
              Gateway usage by {groupByModel ? 'model' : 'team'}
            </h2>
            <p>
              Last {windowLabel}. Other calls include simulation and unknown
              execution modes.
              {groupByModel && selectedTeam && ` Showing ${selectedTeam}.`}
            </p>
            <label>
              Group gateway usage
              <select
                value={groupByModel ? 'model' : 'team'}
                onChange={event =>
                  setReportFilter(
                    'usageGroup',
                    event.target.value === 'model' ? 'model' : '',
                  )
                }
              >
                <option value="team">Team</option>
                <option value="model">Model</option>
              </select>
            </label>
          </div>
          {summaryRows.length === 0 && (
            <p className="gov-empty">No successful calls for this selection.</p>
          )}
          <div className="governance-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">{groupByModel ? 'Model' : 'Team'}</th>
                  <th scope="col">Live calls</th>
                  <th scope="col">Other calls</th>
                  {!groupByModel && <th scope="col">Blocked calls</th>}
                  <th scope="col">Live estimated cost</th>
                </tr>
              </thead>
              <tbody>
                {summaryRows.map(([name, total]) => (
                  <tr key={name}>
                    <td className="gov-app-cell">
                      {groupByModel ? (
                        name
                      ) : (
                        <button
                          type="button"
                          aria-pressed={selectedTeam === name}
                          onClick={() =>
                            setReportFilter(
                              'usageTeam',
                              selectedTeam === name ? '' : name,
                            )
                          }
                        >
                          {name}
                        </button>
                      )}
                    </td>
                    <td data-label="Live calls">{total.liveCalls}</td>
                    <td data-label="Other calls">{total.otherCalls}</td>
                    {!groupByModel && (
                      <td data-label="Blocked calls">{total.blocked}</td>
                    )}
                    <td data-label="Live estimated cost">
                      {dollars.format(total.liveCost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="gov-panel" aria-label="Gateway usage">
        <div className="gov-report-heading">
          <h2>Gateway usage</h2>
          <p>
            Successful calls from the last {windowLabel}. Cost is estimated per
            app and model.
          </p>
          {canReview && (
            <label>
              Reporting window
              <select
                value={usageDays}
                onChange={event =>
                  setReportFilter(
                    'days',
                    event.target.value === '30' ? '' : event.target.value,
                  )
                }
              >
                <option value="1">Last 24 hours</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
              </select>
            </label>
          )}
        </div>
        {!canReview && (
          <p className="gov-empty">Usage details are available to reviewers.</p>
        )}
        {canReview && error && (
          <p className="gov-empty" role="alert">
            {error}
          </p>
        )}
        {canReview && !error && !report && (
          <p className="gov-empty" role="status">
            Loading usage…
          </p>
        )}
        {report && (
          <div className="gov-report-heading">
            <button type="button" onClick={() => downloadReport()}>
              Download report CSV
            </button>
            {selectedTeam && (
              <button
                type="button"
                onClick={() => downloadReport(selectedTeam)}
              >
                Download selected team CSV
              </button>
            )}
          </div>
        )}
        {report && (
          <WorkspaceSearch
            label="Search usage"
            placeholder="Search apps, teams, models, or mode…"
            value={query}
            onChange={setQuery}
            count={rows?.length}
          >
            <label>
              <span className="gov-visually-hidden">Usage team</span>
              <select
                value={selectedTeam}
                onChange={event =>
                  setReportFilter('usageTeam', event.target.value)
                }
              >
                <option value="">All teams</option>
                {selectedTeam && !teamTotals.has(selectedTeam) && (
                  <option value={selectedTeam}>{selectedTeam}</option>
                )}
                {teams.map(([team]) => (
                  <option key={team}>{team}</option>
                ))}
              </select>
            </label>
          </WorkspaceSearch>
        )}
        {rows?.length === 0 && (
          <WorkspaceEmptyState
            icon={<AssessmentOutlinedIcon aria-hidden="true" />}
            title={
              query || selectedTeam
                ? 'No matching usage'
                : 'No gateway calls recorded'
            }
          />
        )}
        {!!rows?.length && (
          <div className="governance-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">App</th>
                  <th scope="col">Team</th>
                  <th scope="col">Model</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Calls</th>
                  <th scope="col">Estimated cost</th>
                  <th scope="col">Recorded tokens</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={JSON.stringify([row.appId, row.model, row.mode])}>
                    <td className="gov-app-cell">
                      <Link to={reportAppLink(row.appId)}>{row.name}</Link>
                    </td>
                    <td data-label="Team">{row.team}</td>
                    <td data-label="Model">{row.model}</td>
                    <td data-label="Mode">{modeLabels[row.mode]}</td>
                    <td data-label="Calls">{row.calls}</td>
                    <td data-label="Estimated cost">
                      {dollars.format(row.estimatedCostUsd)}
                    </td>
                    <td data-label="Recorded tokens">
                      {row.tokens ? (
                        <>
                          {row.tokens.input.toLocaleString()} in ·{' '}
                          {row.tokens.output.toLocaleString()} out
                          {row.tokens.calls < row.calls && (
                            <small>
                              {' '}
                              · {row.tokens.calls} of {row.calls} calls
                            </small>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {blocks && (
        <section
          className="gov-panel gov-block-report"
          aria-label="Gateway policy blocks"
        >
          <div className="gov-report-heading">
            <h2>Gateway policy blocks</h2>
            <p>
              Requests blocked in the last {windowLabel}
              {selectedTeam && ` for ${selectedTeam}`}.
            </p>
          </div>
          {blocks.length === 0 && (
            <WorkspaceEmptyState
              icon={<AssessmentOutlinedIcon aria-hidden="true" />}
              title={
                selectedTeam
                  ? 'No policy blocks for this team'
                  : 'No policy blocks recorded'
              }
            />
          )}
          {blocks.length > 0 && (
            <div className="governance-table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">App</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Mode</th>
                    <th scope="col">Blocked calls</th>
                  </tr>
                </thead>
                <tbody>
                  {blocks.map(row => (
                    <tr key={JSON.stringify([row.appId, row.reason, row.mode])}>
                      <td className="gov-app-cell">
                        <Link to={reportAppLink(row.appId)}>
                          {byId.get(row.appId)?.name ?? row.appId}
                        </Link>
                      </td>
                      <td data-label="Reason">
                        {gatewayBlockReason(row.reason)}
                      </td>
                      <td data-label="Mode">{modeLabels[row.mode]}</td>
                      <td data-label="Blocked calls">{row.calls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

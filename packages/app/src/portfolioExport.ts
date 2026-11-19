import { registrationSource } from './appDimensions';
import { appRecordUrl, reviewDaysOverdue } from './reviewDue';
import { reviewTrackLabels, type ReviewTrack } from './reviewTracks';

const usageColumns = [
  'window_start_utc',
  'app_id',
  'app_name',
  'team',
  'mode',
  'model',
  'block_reason',
  'successful_calls',
  'blocked_calls',
  'estimated_cost_usd',
  'calls_with_token_counts',
  'input_tokens',
  'output_tokens',
];

export type PortfolioExportRow = {
  from: string;
  appId: string;
  appName: string;
  team: string;
  mode: string;
  model?: string;
  reason?: string;
  successfulCalls: number;
  blockedCalls: number;
  estimatedCostUsd: number;
  tokens?: { calls: number; input: number; output: number };
};

function csvCell(value: string | number) {
  if (typeof value === 'number') return String(value);
  const spreadsheetSafe = /^[\t\r\n]|^\s*[=+@＝＋－＠-]/u.test(value)
    ? `'${value}`
    : value;
  return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
}

function encodeCsv(columns: string[], rows: Array<Array<string | number>>) {
  return [
    columns.join(','),
    ...rows.map(row => row.map(csvCell).join(',')),
    '',
  ].join('\r\n');
}

export function portfolioCsv(rows: PortfolioExportRow[]) {
  return encodeCsv(
    usageColumns,
    rows.map(row => [
      row.from,
      row.appId,
      row.appName,
      row.team,
      row.mode,
      row.model ?? '',
      row.reason ?? '',
      row.successfulCalls,
      row.blockedCalls,
      row.estimatedCostUsd,
      row.tokens?.calls ?? '',
      row.tokens?.input ?? '',
      row.tokens?.output ?? '',
    ]),
  );
}

export function gatewaySpendShareCsv(
  from: string,
  windowDays: number,
  liveCost: number,
  outsideCost: number,
  share: number,
) {
  return encodeCsv(
    [
      'window_start_utc',
      'window_days',
      'estimated_gateway_cost_usd',
      'reported_outside_cost_usd',
      'estimated_gateway_share',
    ],
    [[from, windowDays, liveCost, outsideCost, share]],
  );
}

export function ownershipIssuesCsv(
  issues: Array<{
    appId: string;
    name: string;
    unavailable: Array<{ role: string; ref: string; reason?: string }>;
    availableBackupOwner?: string;
  }>,
) {
  return encodeCsv(
    [
      'app_id',
      'app_name',
      'unavailable_role',
      'unavailable_entity',
      'active_backup_owner',
      'unavailable_reason',
    ],
    issues.flatMap(issue =>
      issue.unavailable.map(({ role, ref, reason }) => [
        issue.appId,
        issue.name,
        role,
        ref,
        issue.availableBackupOwner ?? '',
        reason ?? '',
      ]),
    ),
  );
}

const inventoryColumns = [
  'app_id',
  'app_name',
  'owner',
  'team',
  'platform',
  'classification',
  'risk_tier',
  'lifecycle',
  'delivery_stage',
  'uses_ai_at_runtime',
  'models',
  'review_status',
  'next_review_utc',
  'days_overdue',
  'app_url',
  'registration_source',
  'current_policy_tier',
  'starter_id',
];

export function inventoryCsv(
  apps: Array<{
    id: string;
    name: string;
    owner: string;
    team: string;
    platform: string;
    classification: string;
    effectiveClassification?: string;
    tier: number;
    riskAssessment?: { tier: number };
    lifecycle: string;
    deliveryStage?: string;
    discoverySource?: string;
    starterId?: string;
    usesAiAtRuntime?: boolean;
    models: string[];
    reviewStatus: string;
    nextReview: string | null;
  }>,
  now: number,
  baseUrl: string,
) {
  return encodeCsv(
    inventoryColumns,
    apps.map(app => [
      app.id,
      app.name,
      app.owner,
      app.team,
      app.platform,
      app.effectiveClassification ?? app.classification,
      app.tier,
      app.lifecycle,
      app.deliveryStage ?? '',
      app.usesAiAtRuntime === false ? 'No' : 'Yes',
      app.models.join(' | '),
      app.reviewStatus,
      app.nextReview ?? '',
      reviewDaysOverdue(app, now) ?? '',
      appRecordUrl(baseUrl, app.id).href,
      registrationSource(app.discoverySource),
      app.riskAssessment?.tier ?? '',
      app.starterId ?? '',
    ]),
  );
}

export function firstDecisionsCsv(
  apps: Array<{
    id: string;
    name: string;
    owner: string;
    team: string;
    workingDays?: number;
  }>,
  target?: number,
) {
  return encodeCsv(
    [
      'app_id',
      'app_name',
      'owner',
      'team',
      'utc_weekdays_waiting',
      'target_utc_weekdays',
    ],
    apps.map(app => [
      app.id,
      app.name,
      app.owner,
      app.team,
      app.workingDays ?? '',
      target ?? '',
    ]),
  );
}

export function pendingSignoffsCsv(
  apps: Array<{
    id: string;
    name: string;
    owner: string;
    team: string;
    missingTracks: ReviewTrack[];
    nextReview: string | null;
    firstDecisionWait?: number;
  }>,
  baseUrl: string,
) {
  return encodeCsv(
    [
      'app_id',
      'app_name',
      'owner',
      'team',
      'pending_sign_offs',
      'next_review_utc',
      'app_url',
      'first_decision_wait_weekdays',
    ],
    apps.map(app => [
      app.id,
      app.name,
      app.owner,
      app.team,
      app.missingTracks.map(track => reviewTrackLabels[track]).join(' | '),
      app.nextReview ?? '',
      appRecordUrl(baseUrl, app.id).href,
      app.firstDecisionWait ?? '',
    ]),
  );
}

export function downloadCsv(csv: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

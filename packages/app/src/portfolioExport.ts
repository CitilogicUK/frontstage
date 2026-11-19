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

export function ownershipIssuesCsv(
  issues: Array<{
    appId: string;
    name: string;
    unavailable: Array<{ role: string; ref: string }>;
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
    ],
    issues.flatMap(issue =>
      issue.unavailable.map(({ role, ref }) => [
        issue.appId,
        issue.name,
        role,
        ref,
        issue.availableBackupOwner ?? '',
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
    lifecycle: string;
    deliveryStage?: string;
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
    ],
    apps.map(app => [
      app.id,
      app.name,
      app.owner,
      app.team,
      app.missingTracks.map(track => reviewTrackLabels[track]).join(' | '),
      app.nextReview ?? '',
      appRecordUrl(baseUrl, app.id).href,
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

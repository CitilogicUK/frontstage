import { createHash } from 'node:crypto';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { NotificationService } from '@backstage/plugin-notifications-node';
import type { Knex } from 'knex';
import type { GovernanceRecord } from './plugin';

const remindersTable = 'governance_review_reminders';
const reminderBatchSize = 50;
const leadTimeMs = 7 * 24 * 60 * 60 * 1000;
const retryDelayMs = 60 * 60 * 1000;

export function reviewRemindersMigration() {
  return {
    async up(db: Knex) {
      await db.schema.createTable(remindersTable, table => {
        table.string('reminder_key', 64).primary();
        table.timestamp('sent_at').nullable();
        table.timestamp('retry_after').notNullable();
      });
    },
    async down(db: Knex) {
      await db.schema.dropTable(remindersTable);
    },
  };
}

type ReminderKind =
  | 'risk-renewal'
  | 'hosted-confirmation'
  | 'initial-hosted-confirmation';
type Reminder = {
  appId: string;
  owner: string;
  tier: number;
  kind: ReminderKind;
  due: string | null;
  key: string;
};

type ReminderPolicy = {
  evaluateTier: (record: GovernanceRecord) => number;
  reviewDue: (record: GovernanceRecord, now: number) => string | null;
  hostedWorkspaceApproved: (record: GovernanceRecord) => boolean | undefined;
};

function candidatesFor(
  record: GovernanceRecord,
  policy: ReminderPolicy,
  now: number,
): Reminder[] {
  if (record.lifecycle === 'retired') return [];
  const tier = policy.evaluateTier(record);
  const workspaceApproved =
    record.type === 'provider-hosted app'
      ? policy.hostedWorkspaceApproved(record)
      : false;
  const deadlines: Array<[ReminderKind, string | null | undefined]> = [
    [
      'risk-renewal',
      tier >= 2 && tier === record.tier ? policy.reviewDue(record, now) : null,
    ],
    [
      'hosted-confirmation',
      workspaceApproved !== false ? record.hostedAttestation?.nextDue : null,
    ],
  ];
  const createReminder = (
    kind: ReminderKind,
    due: string | null,
    identity: string | null,
  ): Reminder => ({
    appId: record.id,
    owner: record.owner,
    tier,
    kind,
    due,
    key: createHash('sha256')
      .update(JSON.stringify([record.id, kind, identity, record.owner]))
      .digest('hex'),
  });
  const reminders = deadlines.flatMap(([kind, deadline]) => {
    const dueTime = Date.parse(deadline ?? '');
    if (!Number.isFinite(dueTime) || dueTime > now + leadTimeMs) return [];
    const due = new Date(dueTime).toISOString();
    return [createReminder(kind, due, due)];
  });
  if (
    record.lifecycle === 'active' &&
    workspaceApproved === true &&
    !record.hostedAttestation
  ) {
    reminders.push(
      createReminder(
        'initial-hosted-confirmation',
        null,
        record.activeSince ?? null,
      ),
    );
  }
  return reminders;
}

export async function sendReviewReminders(options: {
  db: Knex;
  appsTable: string;
  policy: ReminderPolicy;
  load: (appId: string) => Promise<{ record: GovernanceRecord }>;
  unavailableOwners: (refs: string[]) => Promise<Set<string>>;
  notifications: NotificationService;
  logger: LoggerService;
  appBaseUrl: string;
  signal: AbortSignal;
  now?: number;
}) {
  const {
    db,
    appsTable,
    policy,
    load,
    unavailableOwners,
    notifications,
    logger,
    appBaseUrl,
    signal,
    now = Date.now(),
  } = options;
  if (signal.aborted) return;
  const rows = await db(appsTable).select<{ payload: string }[]>('payload');
  const candidates = rows
    .flatMap(({ payload }) =>
      candidatesFor(JSON.parse(payload) as GovernanceRecord, policy, now),
    )
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        Number(!a.due) - Number(!b.due) ||
        (a.due ?? '').localeCompare(b.due ?? '') ||
        a.key.localeCompare(b.key),
    );
  const scanTime = new Date(now);
  const unattempted: Reminder[] = [];
  const retries: Reminder[] = [];
  for (
    let offset = 0;
    offset < candidates.length;
    offset += reminderBatchSize
  ) {
    if (signal.aborted) return;
    const batch = candidates.slice(offset, offset + reminderBatchSize);
    const ledger = await db(remindersTable)
      .whereIn(
        'reminder_key',
        batch.map(reminder => reminder.key),
      )
      .select<{ reminder_key: string; can_retry: boolean | number }[]>(
        'reminder_key',
        db.raw('sent_at is null and retry_after <= ? as can_retry', [scanTime]),
      );
    const canRetryByKey = new Map(
      ledger.map(row => [row.reminder_key, Boolean(row.can_retry)]),
    );
    for (const reminder of batch) {
      if (!canRetryByKey.has(reminder.key)) unattempted.push(reminder);
      else if (canRetryByKey.get(reminder.key)) retries.push(reminder);
    }
  }

  const eligible = [...unattempted, ...retries];
  let attempts = 0;
  for (let offset = 0; offset < eligible.length; offset += reminderBatchSize) {
    if (signal.aborted || attempts >= reminderBatchSize) return;
    const batch = eligible.slice(offset, offset + reminderBatchSize);
    // Fail closed when the catalog cannot verify ownership.
    const unavailable = await unavailableOwners([
      ...new Set(batch.map(reminder => reminder.owner)),
    ]);
    for (const reminder of batch) {
      if (signal.aborted || attempts >= reminderBatchSize) return;
      if (unavailable.has(reminder.owner)) continue;
      const { appId, due, key, kind, owner } = reminder;
      try {
        const { record } = await load(appId);
        if (signal.aborted) return;
        if (!candidatesFor(record, policy, now).some(item => item.key === key))
          continue;
        const link = new URL(appBaseUrl);
        link.search = new URLSearchParams({ app: appId }).toString();
        const riskTitle =
          reminder.tier === 3 ? 'AI app review due' : 'AI app attestation due';
        const titles = {
          'risk-renewal': riskTitle,
          'hosted-confirmation': 'Hosted workspace confirmation due',
          'initial-hosted-confirmation': 'Confirm your hosted workspace',
        };
        const retryAfter = new Date(now + retryDelayMs);
        const claimed = await db(remindersTable)
          .insert({ reminder_key: key, retry_after: retryAfter })
          .onConflict('reminder_key')
          .merge({ retry_after: retryAfter })
          .whereNull(`${remindersTable}.sent_at`)
          .andWhere(`${remindersTable}.retry_after`, '<=', scanTime)
          .returning('reminder_key');
        if (!claimed.length || signal.aborted) continue;
        attempts += 1;
        await notifications.send({
          recipients: { type: 'entity', entityRef: owner },
          payload: {
            title: titles[kind],
            description: due
              ? `${record.name} is due on ${due.slice(0, 10)} UTC.`
              : `Confirm the approved workspace and sharing settings for ${record.name}.`,
            link: link.toString(),
            topic: 'AI App Governance',
            scope: `governance-review-reminder-${key}`,
          },
        });
        await db(remindersTable)
          .where({ reminder_key: key })
          .update({ sent_at: new Date() });
      } catch {
        logger.warn('Could not deliver governance review reminder', {
          appId,
          kind,
        });
      }
    }
  }
}

import { createHash } from 'node:crypto';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import type { NotificationService } from '@backstage/plugin-notifications-node';
import type { Knex } from 'knex';
import { readOwnerObservations } from './ownershipObservation';
import type { GovernanceRecord } from './plugin';
import {
  claimReminderDelivery,
  markReminderDelivered,
  readReminderDeliveries,
} from './reviewReminders';

const deliveryBatchSize = 50;

export async function sendBackupHandoverNotifications({
  db,
  appsTable,
  apps,
  unavailableOwners,
  activeCatalogEntities,
  canHandOver,
  notifications,
  logger,
  appBaseUrl,
  signal,
  scanTime,
}: {
  db: Knex;
  appsTable: string;
  apps: Array<{ record: GovernanceRecord; revision: number }>;
  unavailableOwners: ReadonlySet<string>;
  activeCatalogEntities: (
    refs: string[],
  ) => Promise<ReadonlyMap<string, Entity>>;
  canHandOver: (
    record: GovernanceRecord,
    backup: string,
    active: ReadonlyMap<string, Entity>,
  ) => boolean;
  notifications: NotificationService;
  logger: LoggerService;
  appBaseUrl: string;
  signal: AbortSignal;
  scanTime: Date;
}) {
  if (signal.aborted) return;
  const observedApps = apps.flatMap(app => {
    const { owner, backupOwner } = app.record;
    return backupOwner && backupOwner !== owner && unavailableOwners.has(owner)
      ? [{ ...app, backup: backupOwner }]
      : [];
  });
  const observations = await readOwnerObservations(
    db,
    observedApps.map(({ record }) => record.id),
  );
  const candidates = observedApps.flatMap(app => {
    const { id, owner } = app.record;
    const observation = observations.get(id);
    if (!observation || observation.owner_ref !== owner) return [];
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          'backup-owner-handover',
          id,
          owner,
          app.backup,
          observation.unavailable_since,
        ]),
      )
      .digest('hex');
    return [{ ...app, observation, key }];
  });

  const unattempted: typeof candidates = [];
  const retries: typeof candidates = [];
  for (
    let offset = 0;
    offset < candidates.length;
    offset += deliveryBatchSize
  ) {
    if (signal.aborted) return;
    const batch = candidates.slice(offset, offset + deliveryBatchSize);
    const delivery = await readReminderDeliveries(
      db,
      batch.map(({ key }) => key),
      scanTime,
    );
    const byKey = new Map(delivery.map(row => [row.reminder_key, row]));
    for (const candidate of batch) {
      const previous = byKey.get(candidate.key);
      if (!previous) unattempted.push(candidate);
      else if (previous.can_retry) retries.push(candidate);
    }
  }

  const eligible = [...unattempted, ...retries];
  let attempts = 0;
  for (let offset = 0; offset < eligible.length; offset += deliveryBatchSize) {
    if (signal.aborted || attempts >= deliveryBatchSize) return;
    const pending = eligible.slice(offset, offset + deliveryBatchSize);
    const active = await activeCatalogEntities([
      ...new Set(
        pending.flatMap(({ record, backup }) => [
          record.owner,
          backup,
          record.team,
        ]),
      ),
    ]);
    for (const { record, revision, backup, observation, key } of pending) {
      if (signal.aborted || attempts >= deliveryBatchSize) return;
      if (!canHandOver(record, backup, active)) continue;
      try {
        const claimed = await db.transaction(async transaction => {
          const current = await transaction(appsTable)
            .where({ id: record.id, revision })
            .forUpdate()
            .first('id');
          if (!current || signal.aborted) return false;
          const latest = (
            await readOwnerObservations(transaction, [record.id])
          ).get(record.id);
          if (
            latest?.owner_ref !== observation.owner_ref ||
            latest?.unavailable_since !== observation.unavailable_since ||
            signal.aborted
          )
            return false;
          return claimReminderDelivery(transaction, key, scanTime);
        });
        if (!claimed || signal.aborted) continue;
        attempts += 1;
        const link = new URL(appBaseUrl);
        link.search = new URLSearchParams({ app: record.id }).toString();
        link.hash = '';
        await notifications.send({
          recipients: { type: 'entity', entityRef: backup },
          payload: {
            title: 'Backup owner handover available',
            description: 'Open the app in Inventory to review the handover.',
            link: link.toString(),
            topic: 'AI App Governance',
            scope: `governance-backup-owner-handover-${key}`,
          },
        });
        await markReminderDelivered(db, key);
      } catch {
        logger.warn('Could not deliver backup owner handover notification', {
          appId: record.id,
        });
      }
    }
  }
}

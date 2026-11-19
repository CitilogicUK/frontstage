import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

import { deliveryStages, parseDeliveryStage } from './deliveryStages';
import { findStarter } from './AppTemplates';
import { reviewTrackLabels, type ReviewTrack } from './reviewTracks';

const hostedFields = {
  provider: 'Provider',
  workspace: 'Workspace',
  sharing: 'Sharing scope',
  dataAccess: 'Hosted data access',
  dataClassification: 'Hosted data classification',
} as const;

type RenewalException = {
  reason: string;
  expiresAt: string;
};

type AuditRecord = {
  hostedAttestation?: { at: string; nextDue: string };
  hosted?: Partial<Record<keyof typeof hostedFields, string>>;
  owner: string;
  lifecycle?: string;
  tier?: number;
  nextReview?: string | null;
  deliveryStage?: string;
  starterId?: string;
  usesAiAtRuntime?: boolean;
  reviewStatus: string;
  reviewTicketUrl?: string;
  renewalException?: RenewalException;
  retirementReview?: {
    owner: string;
    lastLiveCall: string;
    reason?: string;
  };
  graduation?: {
    nominee: string;
    reason?: string;
  };
  updatedAt: string;
  signoffs?: Partial<Record<ReviewTrack, { status: string; at: string }>>;
};

type Audit = {
  events: Array<{ event: string; digest: string }>;
  keyEvents: Array<{
    action: string;
    actor: string;
    at: string | number;
    digest?: string;
    event?: string;
  }>;
  keyAuditVersion?: number;
};

function keyEnvironmentLabel(event?: string) {
  if (!event) return undefined;
  try {
    const environment = JSON.parse(event)?.environment;
    if (environment === 'sandbox') return 'Sandbox gateway key';
    if (environment === 'production') return 'Production gateway key';
  } catch {
    return undefined;
  }
  return undefined;
}

export function AppAuditHistory({
  appId,
  refreshVersion,
}: {
  appId: string;
  refreshVersion: number;
}) {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [open, setOpen] = useState(false);
  const [audit, setAudit] = useState<Audit>();
  const [error, setError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setAudit(undefined);
    setError(false);
    discovery
      .getBaseUrl('governance')
      .then(base =>
        fetch(`${base}/apps/${encodeURIComponent(appId)}/history`, {
          signal: controller.signal,
        }),
      )
      .then(async response => {
        if (!response.ok) throw new Error('Audit request failed.');
        const data: Audit = await response.json();
        if (!controller.signal.aborted) setAudit(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [appId, discovery, fetch, loadAttempt, open, refreshVersion]);

  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ appId, ...audit }, null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `frontstage-audit-${appId}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  let previous: AuditRecord | undefined;
  const recordEvents =
    audit?.events.map(({ event, digest }) => {
      const entry: {
        action: string;
        actor: string;
        at?: string;
        record: AuditRecord;
        lifecycleReason?: string;
        renewalException?: RenewalException;
        graduationNominee?: string;
        graduationReason?: string;
        humanApprovalEvidenceUrl?: string;
      } = JSON.parse(event);
      const { record } = entry;
      const details = [];
      let action =
        entry.action === 'review-ticket-updated'
          ? 'Review ticket updated'
          : `App ${entry.action}`;
      if (entry.action === 'registered' && record.starterId) {
        details.push(
          `Registered from starter ${
            findStarter(record.starterId)?.name ?? record.starterId
          }`,
        );
      }
      if (entry.action === 'reviewed' && entry.humanApprovalEvidenceUrl) {
        details.push(
          `Human approval verified · ${entry.humanApprovalEvidenceUrl}`,
        );
      }
      if (previous && previous.owner !== record.owner) {
        details.push(`Owner changed from ${previous.owner} to ${record.owner}`);
        if (record.tier === 2 && record.nextReview === record.updatedAt) {
          details.push('Attestation due from the new owner');
        }
      }
      if (
        previous &&
        record.lifecycle &&
        previous.lifecycle !== record.lifecycle
      ) {
        details.push(`Lifecycle changed to ${record.lifecycle}`);
      }
      if (
        previous?.tier !== undefined &&
        record.tier !== undefined &&
        previous.tier !== record.tier
      ) {
        details.push(
          `Risk tier changed from Tier ${previous.tier} to Tier ${record.tier}`,
        );
      }
      if (previous && (previous.hosted || record.hosted)) {
        for (const field of Object.keys(hostedFields) as Array<
          keyof typeof hostedFields
        >) {
          const before = previous.hosted?.[field];
          const after = record.hosted?.[field];
          if (before !== after) {
            details.push(
              `${hostedFields[field]} changed from ${
                before ?? 'unspecified'
              } to ${after ?? 'unspecified'}`,
            );
          }
        }
      }
      if (entry.lifecycleReason)
        details.push(`Reason: ${entry.lifecycleReason}`);
      if (previous?.reviewTicketUrl !== record.reviewTicketUrl) {
        let change = 'Review ticket linked';
        if (!record.reviewTicketUrl) change = 'Review ticket link removed';
        else if (previous?.reviewTicketUrl)
          change = 'Review ticket link updated';
        if (entry.action === 'review-ticket-updated') action = change;
        else details.push(change);
      }
      const stage = parseDeliveryStage(record.deliveryStage ?? null);
      if (!previous || previous.deliveryStage !== record.deliveryStage)
        details.push(
          `Delivery stage: ${stage ? deliveryStages[stage] : 'Unspecified'}`,
        );
      const runtime = record.usesAiAtRuntime !== false;
      if (!previous || (previous.usesAiAtRuntime !== false) !== runtime)
        details.push(runtime ? 'Uses runtime AI' : 'No runtime AI');
      if (
        previous?.reviewStatus === 'approved' &&
        record.reviewStatus === 'pending'
      )
        details.push('Approval reopened');
      if (entry.action === 'ownership-handover')
        action = 'Backup owner took ownership';
      if (entry.action === 'reviewed') {
        action = `Review: ${record.reviewStatus}`;
        for (const track of Object.keys(reviewTrackLabels) as ReviewTrack[]) {
          const signoff = record.signoffs?.[track];
          if (signoff && signoff.at !== previous?.signoffs?.[track]?.at) {
            action = `${reviewTrackLabels[track]}: ${signoff.status}`;
            details.push(`Overall review: ${record.reviewStatus}`);
            break;
          }
        }
      }
      if (entry.action === 'attested') {
        action = 'Owner attestation recorded';
        if (record.nextReview) {
          details.push(
            `Next attestation due ${record.nextReview.slice(0, 10)}`,
          );
        }
      }
      if (entry.action === 'hosted-attested') {
        action = 'Hosted workspace attestation recorded';
        if (record.hostedAttestation) {
          details.push(
            `Next workspace attestation due ${record.hostedAttestation.nextDue.slice(
              0,
              10,
            )}`,
          );
        }
      }
      if (
        entry.action === 'renewal-exception-granted' ||
        entry.action === 'renewal-exception-revoked'
      ) {
        const granted = entry.action === 'renewal-exception-granted';
        action = granted
          ? 'Tier 3 renewal exception granted'
          : 'Tier 3 renewal exception revoked';
        const exception =
          entry.renewalException ??
          record.renewalException ??
          previous?.renewalException;
        if (exception?.reason)
          details.push(`Exception granted because “${exception.reason}”`);
        if (exception?.expiresAt) {
          const expiry = new Date(exception.expiresAt);
          if (!Number.isNaN(+expiry))
            details.push(`Scheduled expiry ${expiry.toLocaleString()}`);
        }
      }
      if (entry.action === 'retirement-review-requested') {
        action = 'Retirement review requested';
        if (record.retirementReview) {
          details.push(
            `Requested confirmation from ${record.retirementReview.owner}`,
          );
          const lastCall = new Date(record.retirementReview.lastLiveCall);
          if (!Number.isNaN(+lastCall))
            details.push(`Last live gateway call ${lastCall.toLocaleString()}`);
        }
      }
      if (
        entry.action === 'retirement-review-kept' ||
        entry.action === 'retirement-review-retired'
      ) {
        action =
          entry.action === 'retirement-review-kept'
            ? 'Owner kept app active'
            : 'Owner confirmed retirement';
        const reason = record.retirementReview?.reason;
        if (reason && reason !== entry.lifecycleReason)
          details.push(`Owner response “${reason}”`);
      }
      if (
        entry.action === 'graduation-requested' ||
        entry.action === 'graduation-accepted' ||
        entry.action === 'graduation-declined' ||
        entry.action === 'graduation-cancelled' ||
        entry.action === 'graduation-ended'
      ) {
        action = `Graduation ${entry.action.slice('graduation-'.length)}`;
        const nominee = entry.graduationNominee ?? record.graduation?.nominee;
        if (nominee) details.push(`Nominated owner ${nominee}`);
        const reason = entry.graduationReason ?? record.graduation?.reason;
        if (reason) details.push(`Recorded reason “${reason}”`);
      }
      if (entry.action === 'directory-published')
        action = 'Directory listing published';
      if (entry.action === 'directory-unpublished')
        action = 'Directory listing unpublished';
      if (entry.action === 'directory-access-approved')
        action = 'Directory access approved';
      if (entry.action === 'directory-access-declined')
        action = 'Directory access declined';
      previous = record;
      return {
        id: digest,
        action,
        actor: entry.actor,
        details,
        at: new Date(entry.at ?? record.updatedAt),
      };
    }) ?? [];
  const keyEvents =
    audit?.keyEvents.map((event, index) => {
      const environment = keyEnvironmentLabel(event.event);
      return {
        id: `key-${index}`,
        action: `Key ${event.action}`,
        actor: event.actor,
        details: environment ? [environment] : [],
        at: new Date(event.at),
      };
    }) ?? [];
  const events = [...recordEvents, ...keyEvents].sort((a, b) => +b.at - +a.at);
  const headDigest = audit?.events.at(-1)?.digest;
  const keyHeadDigest = audit?.keyEvents.at(-1)?.digest;

  return (
    <details
      className="gov-app-editor"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary>Audit history</summary>
      {open && error && (
        <>
          <p role="alert">Audit history could not load.</p>
          <button
            type="button"
            onClick={() => setLoadAttempt(attempt => attempt + 1)}
          >
            Retry loading audit history
          </button>
        </>
      )}
      {open && !error && !audit && <p role="status">Loading audit history…</p>}
      {open && audit && (
        <>
          <ul className="gov-audit-events">
            {events.map(event => (
              <li key={event.id}>
                <strong>{event.action}</strong>
                {event.details.length > 0 && <p>{event.details.join(' · ')}</p>}
                <p>
                  {event.actor} ·{' '}
                  <time
                    dateTime={
                      Number.isNaN(+event.at)
                        ? undefined
                        : event.at.toISOString()
                    }
                  >
                    {event.at.toLocaleString()}
                  </time>
                </p>
              </li>
            ))}
          </ul>
          {headDigest && (
            <label>
              Final record digest (SHA-256)
              <input
                readOnly
                value={headDigest}
                onFocus={event => event.currentTarget.select()}
                spellCheck={false}
              />
            </label>
          )}
          {keyHeadDigest && (
            <label>
              Final key event digest (SHA-256)
              <input
                readOnly
                value={keyHeadDigest}
                onFocus={event => event.currentTarget.select()}
                spellCheck={false}
              />
            </label>
          )}
          <button type="button" onClick={download}>
            Download audit JSON
          </button>
        </>
      )}
    </details>
  );
}

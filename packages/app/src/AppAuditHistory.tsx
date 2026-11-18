import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

import { deliveryStages, parseDeliveryStage } from './deliveryStages';
import { reviewTrackLabels, type ReviewTrack } from './reviewTracks';

const hostedFields = {
  provider: 'Provider',
  workspace: 'Workspace',
  sharing: 'Sharing scope',
  dataAccess: 'Hosted data access',
  dataClassification: 'Hosted data classification',
} as const;

type AuditRecord = {
  hosted?: Partial<Record<keyof typeof hostedFields, string>>;
  owner: string;
  lifecycle?: string;
  tier?: number;
  nextReview?: string | null;
  deliveryStage?: string;
  usesAiAtRuntime?: boolean;
  reviewStatus: string;
  reviewTicketUrl?: string;
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
  }>;
  keyAuditVersion?: number;
};

export function AppAuditHistory({ appId }: { appId: string }) {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [open, setOpen] = useState(false);
  const [audit, setAudit] = useState<Audit>();
  const [error, setError] = useState(false);

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
  }, [appId, discovery, fetch, open]);

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
        record: AuditRecord;
        lifecycleReason?: string;
      } = JSON.parse(event);
      const { record } = entry;
      const details = [];
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
        details.push(change);
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
      let action = `App ${entry.action}`;
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
      previous = record;
      if (entry.action === 'attested') {
        action = 'Owner attestation recorded';
        if (record.nextReview) {
          details.push(
            `Next attestation due ${record.nextReview.slice(0, 10)}`,
          );
        }
      }
      return {
        id: digest,
        action,
        actor: entry.actor,
        details,
        at: new Date(entry.record.updatedAt),
      };
    }) ?? [];
  const keyEvents =
    audit?.keyEvents.map((event, index) => ({
      id: `key-${index}`,
      action: `Key ${event.action}`,
      actor: event.actor,
      details: [],
      at: new Date(event.at),
    })) ?? [];
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
        <p role="alert">
          Audit history could not load. Close and reopen to retry.
        </p>
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
                  {event.actor} · {event.at.toLocaleString()}
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

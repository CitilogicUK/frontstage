import { useEffect, useState, type FormEvent } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

type HandoverAvailability = { available: boolean; backupRequired: boolean };

export function AppBackupHandover({
  appId,
  updatedAt,
  tier,
  busy,
  onTakeOwnership,
}: {
  appId: string;
  updatedAt: string;
  tier: number;
  busy: boolean;
  onTakeOwnership: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState<HandoverAvailability>();
  const [failed, setFailed] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setAvailability(undefined);
    setFailed(false);
    setConfirmed(false);
    discovery
      .getBaseUrl('governance')
      .then(base =>
        fetch(`${base}/apps/${encodeURIComponent(appId)}/backup-handover`, {
          signal: controller.signal,
        }),
      )
      .then(async response => {
        if (!response.ok) throw new Error('Handover check failed.');
        const result: HandoverAvailability = await response.json();
        if (!controller.signal.aborted) setAvailability(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [appId, checkAttempt, discovery, fetch, open, updatedAt]);

  return (
    <details
      className="gov-app-editor"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary>Backup owner handover</summary>
      {open && (
        <>
          {failed && (
            <>
              <p role="alert">Handover availability could not load.</p>
              <button
                type="button"
                onClick={() => setCheckAttempt(attempt => attempt + 1)}
              >
                Retry handover check
              </button>
            </>
          )}
          {!failed && !availability && (
            <p role="status">Checking handover availability…</p>
          )}
          {availability?.available === false && (
            <p>Backup handover is unavailable for this app.</p>
          )}
          {availability?.available && (
            <form onSubmit={onTakeOwnership}>
              <p>
                You will become the accountable owner. Any existing gateway key
                will be revoked.
              </p>
              {tier === 2 && (
                <p>Your first owner attestation will be due immediately.</p>
              )}
              {tier === 3 && (
                <p>A new review will be required before launch.</p>
              )}
              <label>
                Replacement backup owner
                {availability.backupRequired ? '' : ' (optional)'}
                <input
                  name="backupOwner"
                  placeholder="user:default/name"
                  required={availability.backupRequired}
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <small>Use the Backstage reference of an active user.</small>
              </label>
              <label>
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  onChange={event => setConfirmed(event.target.checked)}
                />
                I accept responsibility for this app.
              </label>
              <button disabled={busy || !confirmed}>Take ownership</button>
            </form>
          )}
        </>
      )}
    </details>
  );
}

import type { FormEvent } from 'react';

export type OwnerHandover = {
  nominee: string;
  requestedAt: string;
  backupRequired?: boolean;
};

export function AppOwnerHandover({
  handover,
  canManage,
  canRespond,
  requiresBackup,
  busy,
  onRequest,
  onAccept,
  onDecline,
  onCancel,
}: {
  handover?: OwnerHandover;
  canManage: boolean;
  canRespond: boolean;
  requiresBackup: boolean;
  busy: boolean;
  onRequest: (event: FormEvent<HTMLFormElement>) => void;
  onAccept: (event: FormEvent<HTMLFormElement>) => void;
  onDecline: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="gov-graduation" aria-labelledby="owner-handover-title">
      <h3 id="owner-handover-title">Planned owner handover</h3>
      {handover ? (
        <p>
          Awaiting a decision from {handover.nominee}. Requested on{' '}
          <time dateTime={handover.requestedAt}>
            {handover.requestedAt.slice(0, 10)}
          </time>
          .
        </p>
      ) : (
        <p>The current owner remains accountable until the nominee accepts.</p>
      )}
      {canManage && !handover && (
        <form onSubmit={onRequest}>
          <label>
            New accountable owner
            <input
              name="nominee"
              required
              placeholder="user:default/name"
              autoCapitalize="none"
              spellCheck={false}
            />
            <small>Use the Backstage reference of an active user.</small>
          </label>
          <button disabled={busy}>Request owner handover</button>
        </form>
      )}
      {canManage && handover && (
        <form onSubmit={onCancel}>
          <button disabled={busy}>Cancel owner handover</button>
        </form>
      )}
      {canRespond && (
        <>
          <form onSubmit={onAccept}>
            <p>Accepting makes you the accountable owner of this app.</p>
            {requiresBackup && (
              <label>
                Replacement backup owner
                <input
                  name="backupOwner"
                  required
                  placeholder="user:default/name"
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <small>
                  Use the Backstage reference of a different active user.
                </small>
              </label>
            )}
            <button disabled={busy}>Accept owner handover</button>
          </form>
          <form onSubmit={onDecline}>
            <button disabled={busy}>Decline owner handover</button>
          </form>
        </>
      )}
    </section>
  );
}

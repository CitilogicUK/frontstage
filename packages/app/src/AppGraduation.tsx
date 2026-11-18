import type { FormEvent } from 'react';

export type Graduation = {
  nominee: string;
  requestedBy: string;
  requestedAt: string;
  status: 'pending' | 'accepted' | 'declined';
  decidedAt?: string;
  reason?: string;
};

export function AppGraduation({
  graduation,
  canNominate,
  canDecide,
  canCancel,
  busy,
  onNominate,
  onDecide,
  onCancel,
}: {
  graduation?: Graduation;
  canNominate: boolean;
  canDecide: boolean;
  canCancel: boolean;
  busy: boolean;
  onNominate: (event: FormEvent<HTMLFormElement>) => void;
  onDecide: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section
      className="gov-graduation"
      aria-labelledby="engineering-co-owner-title"
    >
      <h3 id="engineering-co-owner-title">Engineering co-owner</h3>
      {graduation?.status === 'pending' && (
        <>
          <p>Awaiting a decision from {graduation.nominee}.</p>
          <p>
            Nominated by {graduation.requestedBy} on{' '}
            <time dateTime={graduation.requestedAt}>
              {graduation.requestedAt.slice(0, 10)}
            </time>
            .
          </p>
          {canCancel && (
            <form onSubmit={onCancel}>
              <button disabled={busy}>Cancel nomination</button>
            </form>
          )}
        </>
      )}
      {graduation && graduation.status !== 'pending' && (
        <>
          <p>
            {graduation.status === 'accepted' ? 'Accepted' : 'Declined'} by{' '}
            {graduation.nominee}
            {graduation.decidedAt && (
              <>
                {' on '}
                <time dateTime={graduation.decidedAt}>
                  {graduation.decidedAt.slice(0, 10)}
                </time>
              </>
            )}
            .
          </p>
          {graduation.reason && <p>{graduation.reason}</p>}
        </>
      )}
      {canNominate && (
        <form onSubmit={onNominate}>
          <p>
            Choose a different active user in an approved engineering or IT
            group.
          </p>
          <label>
            Co-owner nominee
            <input
              name="nominee"
              required
              placeholder="user:default/name"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <button disabled={busy}>Nominate engineering co-owner</button>
        </form>
      )}
      {canDecide && (
        <form onSubmit={onDecide}>
          <label>
            Co-owner decision
            <select name="decision" required defaultValue="">
              <option value="">Choose a decision</option>
              <option value="accept">Accept nomination</option>
              <option value="decline">Decline nomination</option>
            </select>
          </label>
          <label>
            Reason (optional)
            <textarea name="reason" maxLength={500} />
          </label>
          <button disabled={busy}>Record co-owner decision</button>
        </form>
      )}
    </section>
  );
}

import { useEffect, useState, type FormEvent } from 'react';

export type RenewalException = {
  reason: string;
  expiresAt: string;
  grantedAt: string;
  actor: string;
  owner: string;
};

const maxExtensionMs = 30 * 24 * 60 * 60 * 1000;

function renewalExceptionUtc(value: string) {
  return `${new Date(value).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function AppRenewalException({
  nextReview,
  reviewStatus,
  exception,
  canManage,
  separateSignoffs,
  busy,
  onGrant,
  onRevoke,
}: {
  nextReview: string | null;
  reviewStatus: string;
  exception?: RenewalException;
  canManage: boolean;
  separateSignoffs: boolean;
  busy: boolean;
  onGrant: (event: FormEvent<HTMLFormElement>) => void;
  onRevoke: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [now, setNow] = useState(Date.now);
  const due = nextReview ? Date.parse(nextReview) : 0;
  const expiry = exception ? Date.parse(exception.expiresAt) : 0;
  const grantAvailable =
    canManage && !separateSignoffs && reviewStatus === 'approved' && due > now;

  useEffect(() => {
    const upcoming = [due, expiry].filter(value => value > now);
    if (!upcoming.length) return undefined;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.min(...upcoming) - now, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [due, expiry, now]);

  if (!exception && !grantAvailable) return null;

  return (
    <section
      className="gov-renewal-exception"
      aria-labelledby="renewal-exception-title"
    >
      <h3 id="renewal-exception-title">Renewal exception</h3>
      {exception ? (
        <>
          <p>
            {expiry <= now ? 'Expired ' : 'Expires '}
            <time dateTime={exception.expiresAt}>
              {renewalExceptionUtc(exception.expiresAt)}
            </time>
          </p>
          <p>Accountable owner {exception.owner}</p>
          <p>{exception.reason}</p>
          {separateSignoffs && expiry > now && (
            <p>Separate sign-offs are required for renewal.</p>
          )}
          {canManage && (
            <form onSubmit={onRevoke}>
              <button disabled={busy}>Revoke renewal exception</button>
            </form>
          )}
        </>
      ) : (
        <form onSubmit={onGrant}>
          <p>
            Set an expiry within 30 days after the original review due date.
          </p>
          <label>
            Exception expiry (UTC)
            <input
              type="datetime-local"
              name="expiresAt"
              required
              step={1}
              min={new Date(Math.floor(due / 1000) * 1000 + 1000)
                .toISOString()
                .slice(0, 19)}
              max={new Date(due + maxExtensionMs).toISOString().slice(0, 19)}
            />
          </label>
          <label>
            Exception reason
            <textarea name="reason" required maxLength={1000} />
          </label>
          <button disabled={busy}>Grant renewal exception</button>
        </form>
      )}
    </section>
  );
}

import { useState, type FormEvent } from 'react';

export type RetirementReview = {
  requestedAt: string;
  requestedBy: string;
  owner: string;
  lastLiveCall: string;
  status: 'pending' | 'kept' | 'retired';
  decidedAt?: string;
  reason?: string;
};

export function AppRetirementReview({
  owner,
  candidateLastLiveCall,
  review,
  canDecide,
  busy,
  onRequest,
  onDecide,
}: {
  owner: string;
  candidateLastLiveCall?: string;
  review?: RetirementReview;
  canDecide: boolean;
  busy: boolean;
  onRequest: (event: FormEvent<HTMLFormElement>) => void;
  onDecide: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [retiring, setRetiring] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const lastLiveCall = candidateLastLiveCall ?? review?.lastLiveCall;
  if (!lastLiveCall) return null;

  return (
    <section
      className="gov-retirement-review"
      aria-labelledby="app-retirement-review"
    >
      <h3 id="app-retirement-review">Retirement review</h3>
      <p>
        Last live gateway call{' '}
        <time dateTime={lastLiveCall}>{lastLiveCall.slice(0, 10)}</time>.
      </p>
      {review?.status === 'pending' && (
        <>
          <p>Awaiting a decision from {review.owner}.</p>
          <p>
            Requested by{' '}
            {review.requestedBy === 'plugin:governance'
              ? 'Scheduled inactivity check'
              : review.requestedBy}{' '}
            on{' '}
            <time dateTime={review.requestedAt}>
              {review.requestedAt.slice(0, 10)}
            </time>
            .
          </p>
          {canDecide && (
            <form onSubmit={onDecide}>
              <label>
                Retirement decision
                <select
                  name="decision"
                  required
                  defaultValue=""
                  onChange={event => {
                    setRetiring(event.target.value === 'retire');
                    setConfirmed(false);
                  }}
                >
                  <option value="">Choose a decision</option>
                  <option value="keep">Keep active</option>
                  <option value="retire">Retire app</option>
                </select>
              </label>
              <label>
                Reason for decision
                <textarea name="reason" required maxLength={500} />
              </label>
              {retiring && (
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={event => setConfirmed(event.target.checked)}
                    required
                  />
                  I confirm that retiring this app revokes its gateway key.
                </label>
              )}
              <button disabled={busy || (retiring && !confirmed)}>
                Record retirement decision
              </button>
            </form>
          )}
        </>
      )}
      {review && review.status !== 'pending' && (
        <>
          <p>
            {review.status === 'kept' ? 'Kept active' : 'Retired by owner'}
            {review.decidedAt && (
              <>
                {' on '}
                <time dateTime={review.decidedAt}>
                  {review.decidedAt.slice(0, 10)}
                </time>
              </>
            )}
            .
          </p>
          {review.reason && <p>{review.reason}</p>}
        </>
      )}
      {candidateLastLiveCall && review?.status !== 'pending' && (
        <form onSubmit={onRequest}>
          <p>Request a decision from {owner} to keep or retire this app.</p>
          <button disabled={busy}>Request retirement review</button>
        </form>
      )}
    </section>
  );
}

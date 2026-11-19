import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

export type DirectoryRequestStatus = 'pending' | 'approved' | 'declined';

type AccessRequest = {
  id: string;
  requester: string;
  message: string;
  status: DirectoryRequestStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
};

type AccessRequestQueue = {
  requests: AccessRequest[];
  canApprove: boolean;
  approvalCheckUnavailable?: boolean;
};

const statusLabels = {
  pending: 'Access request pending',
  approved: 'Access request approved',
  declined: 'Access request declined',
};

function useDirectoryRequestApi(appId: string) {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  return useCallback(
    async <Result,>(path = '', options?: RequestInit): Promise<Result> => {
      const base = await discovery.getBaseUrl('governance');
      const response = await fetch(
        `${base}/apps/${encodeURIComponent(appId)}/directory-requests${path}`,
        options,
      );
      const data = await response.json().catch(() => undefined);
      if (!response.ok)
        throw Object.assign(
          new Error(
            data?.error?.message ??
              'The access request could not be processed.',
          ),
          { status: response.status },
        );
      return data;
    },
    [appId, discovery, fetch],
  );
}

export function DirectoryRequestAction({
  appId,
  status,
  onSaved,
}: {
  appId: string;
  status?: DirectoryRequestStatus;
  onSaved: (status: DirectoryRequestStatus) => void;
}) {
  const api = useDirectoryRequestApi(appId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function requestAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = String(
      new FormData(event.currentTarget).get('message') ?? '',
    ).trim();
    if (!message) {
      setError('Explain why you need access.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const saved = await api<{ status: DirectoryRequestStatus }>('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      onSaved(saved.status);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  }

  if (status) {
    return (
      <div role="status">
        <p>{statusLabels[status]}</p>
        {status === 'approved' && (
          <p>The app owner handles access in the destination app.</p>
        )}
      </div>
    );
  }

  return (
    <details className="gov-app-editor">
      <summary>Request access</summary>
      <form onSubmit={requestAccess}>
        <label>
          Why do you need access?
          <textarea name="message" required maxLength={500} />
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={submitting}>Send access request</button>
      </form>
    </details>
  );
}

export function DirectoryRequestQueue({
  appId,
  listingMeetsLaunchRequirements,
  appRevision,
  onPendingChange,
  onDecisionSaved,
}: {
  appId: string;
  listingMeetsLaunchRequirements: boolean;
  appRevision: string;
  onPendingChange: (appId: string, hasPending: boolean) => void;
  onDecisionSaved: () => void;
}) {
  const api = useDirectoryRequestApi(appId);
  const [open, setOpen] = useState(false);
  const [queue, setQueue] = useState<AccessRequestQueue>();
  const [queueVersion, setQueueVersion] = useState(0);
  const requests = queue?.requests;
  const canApprove =
    listingMeetsLaunchRequirements && queue?.canApprove === true;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setQueue(undefined);
    api<AccessRequestQueue>('', { signal: controller.signal }).then(
      result => {
        if (!controller.signal.aborted) {
          setQueue(result);
          onPendingChange(
            appId,
            result.requests.some(item => item.status === 'pending'),
          );
        }
      },
      reason => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => controller.abort();
  }, [api, appId, appRevision, onPendingChange, open, queueVersion]);

  async function decide(event: FormEvent<HTMLFormElement>, requestId: string) {
    event.preventDefault();
    const status = new FormData(event.currentTarget).get('status');
    if (status !== 'approved' && status !== 'declined') return;
    setSubmitting(true);
    setError('');
    try {
      await api<AccessRequest>(`/${encodeURIComponent(requestId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      onDecisionSaved();
      setQueueVersion(version => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      if (
        reason instanceof Error &&
        'status' in reason &&
        reason.status === 409
      ) {
        setQueue(undefined);
        setQueueVersion(version => version + 1);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <details
      className="gov-app-editor"
      onToggle={event => {
        const isOpen = event.currentTarget.open;
        if (isOpen) setError('');
        setOpen(isOpen);
      }}
    >
      <summary>Directory access requests</summary>
      {open && (
        <>
          <p>
            Record a decision here, then grant approved access in the
            destination app.
          </p>
          {error && <p role="alert">{error}</p>}
          {!error && !requests && <p role="status">Loading access requests…</p>}
          {requests?.length === 0 && <p>No access requests.</p>}
          {!canApprove &&
            requests?.some(item => item.status === 'pending') &&
            (queue?.approvalCheckUnavailable ? (
              <>
                <p role="status">Catalog ownership could not be verified.</p>
                <button
                  type="button"
                  onClick={() => setQueueVersion(version => version + 1)}
                >
                  Retry ownership check
                </button>
              </>
            ) : (
              <p>Approvals require an eligible directory listing.</p>
            ))}
          {requests && requests.length > 0 && (
            <ul className="gov-directory-requests">
              {requests.map(item => (
                <li key={item.id}>
                  <strong>{item.requester}</strong>
                  <p>{item.message}</p>
                  <p>{statusLabels[item.status]}</p>
                  {item.status === 'pending' && (
                    <form onSubmit={event => decide(event, item.id)}>
                      <label>
                        Access decision
                        <select name="status" required defaultValue="">
                          <option value="">Choose a decision</option>
                          <option value="approved" disabled={!canApprove}>
                            Approve
                          </option>
                          <option value="declined">Decline</option>
                        </select>
                      </label>
                      <button disabled={submitting}>
                        Record access decision
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </details>
  );
}

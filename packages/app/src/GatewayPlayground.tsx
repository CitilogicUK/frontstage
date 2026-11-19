import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import {
  gatewayBlockNextStep,
  gatewayBlockReason,
} from './gatewayBlockReasons';
import { useGatewayModelPolicy } from './GatewayModelGuide';

type Usage = {
  liveCalls: number;
  simulatedCalls: number;
  unclassifiedCalls: number;
  liveEstimatedCostUsd: number;
  liveTokens: { calls: number; input: number; output: number };
  requestsPerMinute: number | null;
  monthlySpend?: {
    monthStart: string;
    liveEstimatedCostUsd: number;
    thresholdUsd: number;
    stopAtThreshold: boolean;
  };
  gatewayPause?: 'attestation-overdue';
  blockedCalls: number;
  blocks: Array<{ reason: string; calls: number }>;
};

type GatewayResponse = {
  output: string;
  model: string;
  simulated: boolean;
};

type GatewayApp = {
  id: string;
  models: string[];
  classification: string;
  effectiveClassification?: string;
  lifecycle: string;
  updatedAt: string;
};

const estimate = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 8,
});

async function readResponse<T>(response: Response): Promise<T> {
  if (response.ok) return response.json();
  const body = await response.json().catch(() => undefined);
  throw new Error(
    body?.error?.message ?? `Gateway request failed (HTTP ${response.status}).`,
  );
}

type GatewayEnvironment = 'sandbox' | 'production';

type GatewayPlaygroundProps = {
  app: GatewayApp;
  onKeyChanged: () => void;
};

export function GatewayPlayground({
  app,
  onKeyChanged,
}: GatewayPlaygroundProps) {
  const { policy } = useGatewayModelPolicy();
  const [environment, setEnvironment] = useState<GatewayEnvironment>('sandbox');
  const productionAvailable = policy?.productionAvailable === true;
  const selectedEnvironment = productionAvailable ? environment : 'sandbox';
  const classification = app.effectiveClassification ?? app.classification;
  const approvedModels = policy
    ? app.models.filter(id =>
        policy.models.some(
          model =>
            model.id === id &&
            model.allowedClassifications.includes(classification),
        ),
      )
    : app.models;

  return (
    <section className="gov-gateway" aria-label="Gateway playground">
      <h3>Gateway playground</h3>
      {productionAvailable && (
        <label>
          Gateway key environment
          <select
            value={selectedEnvironment}
            onChange={event =>
              setEnvironment(
                event.currentTarget.value === 'production'
                  ? 'production'
                  : 'sandbox',
              )
            }
          >
            <option value="sandbox">Sandbox</option>
            <option value="production">Production</option>
          </select>
        </label>
      )}
      {selectedEnvironment === 'production' && (
        <p>
          Production prompts are sent to the live provider and can incur costs.
        </p>
      )}
      <GatewayEnvironmentPanel
        key={selectedEnvironment}
        app={app}
        environment={selectedEnvironment}
        classification={classification}
        approvedModels={approvedModels}
        onKeyChanged={onKeyChanged}
      />
    </section>
  );
}

function GatewayEnvironmentPanel({
  app,
  environment,
  classification,
  approvedModels,
  onKeyChanged,
}: GatewayPlaygroundProps & {
  environment: GatewayEnvironment;
  classification: string;
  approvedModels: string[];
}) {
  const discovery = useApi(discoveryApiRef);
  const { fetch: backstageFetch } = useApi(fetchApiRef);
  const keyPath = `/apps/${encodeURIComponent(app.id)}/gateway-key${
    environment === 'production' ? '?environment=production' : ''
  }`;
  const [key, setKey] = useState<string>();
  const [readingKeyStatus, setReadingKeyStatus] = useState(true);
  const [notice, setNotice] = useState('');
  const [issued, setIssued] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [usage, setUsage] = useState<Usage>();
  const [usageError, setUsageError] = useState(false);
  const [reply, setReply] = useState<GatewayResponse>();
  const [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState<
    'issue' | 'send' | 'revoke'
  >();

  const readUsage = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const base = await discovery.getBaseUrl('governance');
        const response = await backstageFetch(
          `${base}/apps/${encodeURIComponent(app.id)}/usage`,
          { signal },
        );
        const result = await readResponse<Usage>(response);
        if (signal?.aborted) return;
        setUsage(result);
        setUsageError(false);
      } catch {
        if (!signal?.aborted) setUsageError(true);
      }
    },
    [app.id, backstageFetch, discovery],
  );

  useEffect(() => {
    const controller = new AbortController();
    void readUsage(controller.signal);
    return () => controller.abort();
  }, [app.updatedAt, readUsage]);

  useEffect(() => {
    const controller = new AbortController();
    discovery
      .getBaseUrl('governance')
      .then(base =>
        backstageFetch(`${base}${keyPath}`, { signal: controller.signal }),
      )
      .then(readResponse<{ issued: boolean }>)
      .then(result => {
        if (!controller.signal.aborted) setIssued(result.issued);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setNotice('Gateway key status is unavailable.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setReadingKeyStatus(false);
      });

    return () => controller.abort();
  }, [backstageFetch, discovery, keyPath]);

  async function issueKey() {
    setPendingAction('issue');
    setNotice('');
    setError('');
    setRevealed(false);
    try {
      const base = await discovery.getBaseUrl('governance');
      const response = await backstageFetch(`${base}${keyPath}`, {
        method: 'POST',
      });
      const result = await readResponse<{ key: string }>(response);
      setKey(result.key);
      setIssued(true);
      onKeyChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function revokeKey() {
    setPendingAction('revoke');
    setNotice('');
    setError('');
    try {
      const base = await discovery.getBaseUrl('governance');
      const response = await backstageFetch(`${base}${keyPath}`, {
        method: 'DELETE',
      });
      if (!response.ok) await readResponse(response);
      setIssued(false);
      setKey(undefined);
      setRevealed(false);
      setReply(undefined);
      setNotice('Gateway key revoked.');
      onKeyChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function sendPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!key) return;
    const data = new FormData(event.currentTarget);
    const prompt = String(data.get('prompt') ?? '').trim();
    if (!prompt) {
      setError('Enter a prompt.');
      return;
    }
    setPendingAction('send');
    setError('');
    setReply(undefined);
    try {
      const base = await discovery.getBaseUrl('governance');
      const response = await globalThis.fetch(`${base}/gateway/chat`, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: data.get('model'),
          prompt,
          expectedEnvironment: environment,
        }),
      });
      setReply(await readResponse<GatewayResponse>(response));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      await readUsage();
      setPendingAction(undefined);
    }
  }

  const unavailableModels = app.models.filter(
    id => !approvedModels.includes(id),
  );
  const keyAction = issued ? 'Rotate key' : 'Issue gateway key';
  let usageText = 'Loading usage…';
  if (usage) {
    const counts = [
      `${usage.liveCalls} live`,
      `${usage.simulatedCalls} simulated`,
      `${usage.blockedCalls} blocked`,
    ];
    if (usage.unclassifiedCalls)
      counts.push(`${usage.unclassifiedCalls} with unknown mode`);
    usageText = `All-time gateway requests: ${counts.join(
      ' · ',
    )} · ${estimate.format(usage.liveEstimatedCostUsd)} live estimated cost`;
  }
  if (usageError) usageText = 'Usage is unavailable.';

  return (
    <>
      {app.lifecycle !== 'active' && (
        <p>The app must be active to use the gateway.</p>
      )}
      {unavailableModels.length > 0 && (
        <p>
          Unavailable for {classification} data: {unavailableModels.join(', ')}.
        </p>
      )}
      {!usageError && usage?.gatewayPause === 'attestation-overdue' && (
        <p className="gov-notice" role="status">
          Gateway access is paused until the app owner completes the overdue
          attestation.
        </p>
      )}
      <div className="gov-gateway-key">
        <button
          type="button"
          disabled={
            readingKeyStatus ||
            Boolean(pendingAction) ||
            app.lifecycle === 'retired' ||
            approvedModels.length === 0
          }
          onClick={issueKey}
        >
          {pendingAction === 'issue' ? 'Issuing key…' : keyAction}
        </button>
        {issued && (
          <button
            type="button"
            disabled={Boolean(pendingAction)}
            onClick={revokeKey}
          >
            {pendingAction === 'revoke'
              ? 'Revoking key…'
              : 'Revoke gateway key'}
          </button>
        )}
        {key && (
          <button type="button" onClick={() => setRevealed(value => !value)}>
            {revealed ? 'Hide key' : 'Show key'}
          </button>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {issued && !key && (
        <p>A gateway key is issued. Rotate it to use it in this playground.</p>
      )}
      {key && (
        <p className="gov-gateway-secret">
          {revealed ? <code>{key}</code> : 'Gateway key issued and hidden.'}
        </p>
      )}
      <form onSubmit={sendPrompt}>
        <label>
          Model
          <select name="model" required disabled={approvedModels.length === 0}>
            {approvedModels.map(model => (
              <option key={model}>{model}</option>
            ))}
          </select>
        </label>
        <label>
          Prompt
          <textarea name="prompt" required />
        </label>
        <button
          disabled={
            !key || Boolean(pendingAction) || approvedModels.length === 0
          }
        >
          {pendingAction === 'send' ? 'Sending…' : 'Send prompt'}
        </button>
      </form>
      {error && (
        <p className="gov-notice" role="alert">
          {error}
        </p>
      )}
      {reply && (
        <div className="gov-gateway-output" role="status">
          <p>
            {reply.model} ·{' '}
            {reply.simulated ? 'Simulated response' : 'Live response'}
          </p>
          <pre>{reply.output}</pre>
        </div>
      )}
      <p aria-live="polite">{usageText}</p>
      {!usageError && !!usage?.liveTokens?.calls && (
        <p>
          Live tokens: {usage.liveTokens.input.toLocaleString()} input ·{' '}
          {usage.liveTokens.output.toLocaleString()} output
          {usage.liveTokens.calls < usage.liveCalls &&
            ` · Counts available for ${usage.liveTokens.calls} of ${usage.liveCalls} live calls`}
        </p>
      )}
      {!usageError && usage?.requestsPerMinute && (
        <p>Request limit: {usage.requestsPerMinute} per minute.</p>
      )}
      {!usageError && usage?.monthlySpend && (
        <p>
          UTC month starting {usage.monthlySpend.monthStart.slice(0, 10)} ·{' '}
          {estimate.format(usage.monthlySpend.liveEstimatedCostUsd)} estimated
          live cost
          {' · '}
          {estimate.format(usage.monthlySpend.thresholdUsd)} threshold
          {usage.monthlySpend.liveEstimatedCostUsd <
            usage.monthlySpend.thresholdUsd &&
            ` · ${estimate.format(
              usage.monthlySpend.thresholdUsd -
                usage.monthlySpend.liveEstimatedCostUsd,
            )} until threshold`}
          {usage.monthlySpend.liveEstimatedCostUsd >=
            usage.monthlySpend.thresholdUsd && ' · Threshold reached'}
          {usage.monthlySpend.stopAtThreshold &&
            ' · Live requests stop at threshold'}
        </p>
      )}
      {!usageError && !!usage?.blocks.length && (
        <details>
          <summary>Blocked requests by reason</summary>
          <ul>
            {usage.blocks.map(block => {
              const nextStep = gatewayBlockNextStep(block.reason);
              return (
                <li key={block.reason}>
                  {gatewayBlockReason(block.reason)} · {block.calls}
                  {nextStep && <p>{nextStep}</p>}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </>
  );
}

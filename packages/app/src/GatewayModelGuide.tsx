import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

type ModelPolicy = {
  enabled: boolean;
  productionAvailable?: boolean;
  models: Array<{
    id: string;
    allowedClassifications: string[];
    maxCompletionTokens: number;
  }>;
};

export function useGatewayModelPolicy(enabled = true) {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [policy, setPolicy] = useState<ModelPolicy>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    discovery
      .getBaseUrl('governance')
      .then(base =>
        fetch(`${base}/gateway/models`, { signal: controller.signal }),
      )
      .then(async response => {
        if (!response.ok) throw new Error('The model policy could not load.');
        const result: ModelPolicy = await response.json();
        if (!controller.signal.aborted) setPolicy(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [discovery, enabled, fetch]);

  return { policy, failed };
}

export function GatewayModelGuide() {
  const { policy, failed } = useGatewayModelPolicy();
  return (
    <section
      className="gov-panel gov-model-guide"
      aria-labelledby="gateway-models-title"
    >
      <div className="gov-report-heading">
        <h2 id="gateway-models-title">Approved gateway models</h2>
        <p>
          Choose a model allowed for the highest data classification your app
          handles.
        </p>
      </div>
      {failed && (
        <p className="gov-empty" role="alert">
          The model policy could not load.
        </p>
      )}
      {!failed && !policy && (
        <p className="gov-empty" role="status">
          Loading model policy…
        </p>
      )}
      {policy && !policy.enabled && (
        <p className="gov-empty">The gateway is disabled in this workspace.</p>
      )}
      {!!policy?.models.length && (
        <div className="governance-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Allowed data classifications</th>
                <th scope="col">Live output limit</th>
              </tr>
            </thead>
            <tbody>
              {policy.models.map(model => (
                <tr key={model.id}>
                  <td className="gov-app-cell">
                    <Link
                      to={`/?model=${encodeURIComponent(model.id)}`}
                      aria-label={`View apps declaring ${model.id}`}
                    >
                      {model.id}
                    </Link>
                  </td>
                  <td data-label="Allowed data classifications">
                    {model.allowedClassifications.join(', ')}
                  </td>
                  <td data-label="Live output limit">
                    {model.maxCompletionTokens.toLocaleString('en-US')} tokens
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

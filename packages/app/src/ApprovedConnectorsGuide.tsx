import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

type ApprovedConnectors = {
  configured: boolean;
  connectors: Array<{
    id: string;
    name: string;
    kind: 'mcp' | 'data';
    description: string;
    access: 'read' | 'write';
    maxClassification: 'public' | 'internal' | 'confidential' | 'restricted';
    docsUrl?: string;
  }>;
};

export function ApprovedConnectorsGuide() {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [registry, setRegistry] = useState<ApprovedConnectors>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    discovery
      .getBaseUrl('governance')
      .then(base =>
        fetch(`${base}/approved-connectors`, { signal: controller.signal }),
      )
      .then(async response => {
        if (!response.ok)
          throw new Error('Could not load approved connectors.');
        const result: ApprovedConnectors = await response.json();
        if (!controller.signal.aborted) setRegistry(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [discovery, fetch]);

  return (
    <section
      className="gov-panel gov-connectors-guide"
      aria-labelledby="approved-connectors-title"
    >
      <div className="gov-report-heading">
        <h2 id="approved-connectors-title">Approved connectors</h2>
        {failed && <p role="alert">The connector registry could not load.</p>}
        {!failed && !registry && (
          <p role="status">Loading approved connectors…</p>
        )}
        {registry && !registry.configured && (
          <p>No connector registry is configured.</p>
        )}
        {registry?.configured && registry.connectors.length === 0 && (
          <p>No connectors are approved.</p>
        )}
      </div>
      {!!registry?.connectors.length && (
        <div className="governance-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Connector</th>
                <th scope="col">Type</th>
                <th scope="col">Access</th>
                <th scope="col">Maximum data classification</th>
              </tr>
            </thead>
            <tbody>
              {registry.connectors.map(connector => (
                <tr key={connector.id}>
                  <td className="gov-app-cell">
                    <strong>{connector.name}</strong>
                    <p>{connector.description}</p>
                    {connector.docsUrl && (
                      <a
                        href={connector.docsUrl}
                        aria-label={`${connector.name} documentation`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Documentation
                      </a>
                    )}
                  </td>
                  <td data-label="Type">
                    {connector.kind === 'mcp' ? 'MCP server' : 'Data connector'}
                  </td>
                  <td data-label="Access">
                    {connector.access === 'read' ? 'Read' : 'Write'}
                  </td>
                  <td data-label="Maximum data classification">
                    {connector.maxClassification}
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

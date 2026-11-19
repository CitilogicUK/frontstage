import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { Link } from 'react-router-dom';
import { appClassifications } from './appDimensions';

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

function connectorSupports(
  connector: ApprovedConnectors['connectors'][number],
  access: string,
  classification: string,
) {
  const classificationIndex = appClassifications.indexOf(classification);
  return (
    classificationIndex >= 0 &&
    connector.access === access &&
    appClassifications.indexOf(connector.maxClassification) >=
      classificationIndex
  );
}

function useApprovedConnectors() {
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

  return { registry, failed };
}

export function RegistrationConnectorGuidance({
  accesses,
  classification,
  primaryAccess,
  onUseConnector,
}: {
  accesses: string[];
  classification: string;
  primaryAccess?: string;
  onUseConnector: (name: string) => void;
}) {
  const { registry, failed } = useApprovedConnectors();
  const matches = registry?.connectors.filter(connector =>
    accesses.some(access =>
      connectorSupports(connector, access, classification),
    ),
  );
  return (
    <section aria-labelledby="registration-connectors-title">
      <h3 id="registration-connectors-title">
        Approved connectors for this app
      </h3>
      {failed && <p role="status">The connector registry could not load.</p>}
      {!failed && !registry && (
        <p role="status">Loading approved connectors…</p>
      )}
      {registry && !registry.configured && (
        <p>No connector registry is configured.</p>
      )}
      {registry?.configured && matches?.length === 0 && (
        <p>
          No approved connectors match the selected access and data
          classification.
        </p>
      )}
      {!!matches?.length && (
        <ul>
          {matches.map(connector => (
            <li key={connector.id}>
              <strong>{connector.name}</strong> ·{' '}
              {connector.access === 'read' ? 'Read' : 'Write'}
              {connector.access === primaryAccess && (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => onUseConnector(connector.name)}
                  >
                    Use {connector.name}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <Link to="/?view=guide" target="_blank" rel="noreferrer">
        View approved connector registry (new tab)
      </Link>
    </section>
  );
}

export function DeclaredConnections({
  connections,
  classification,
}: {
  connections: Array<{ name: string; access: string }>;
  classification: string;
}) {
  const { registry, failed } = useApprovedConnectors();

  function registryStatus(connection: { name: string; access: string }) {
    if (!registry?.configured) return undefined;
    const name = connection.name.trim().toLowerCase();
    const entries = registry.connectors.filter(
      connector => connector.name.trim().toLowerCase() === name,
    );
    if (!entries.length) return 'No matching registry entry';
    if (
      entries.some(connector =>
        connectorSupports(connector, connection.access, classification),
      )
    )
      return 'Matches registry limits';
    const limits = [
      ...new Set(
        entries.map(
          connector =>
            `${connector.access === 'read' ? 'Read' : 'Write'} · ${
              connector.maxClassification
            }`,
        ),
      ),
    ];
    return (
      <>
        Access or classification differs from registry
        <br />
        Registry limits · {limits.join(' / ')}
      </>
    );
  }

  return (
    <section aria-labelledby="declared-connections-title">
      <h3 id="declared-connections-title">Declared connections</h3>
      {registry?.configured && (
        <p>Compared by declared connection name for {classification} data.</p>
      )}
      {failed && <p role="status">The connector registry could not load.</p>}
      {!failed && !registry && (
        <p role="status">Loading approved connectors…</p>
      )}
      {registry && !registry.configured && (
        <p>No connector registry is configured.</p>
      )}
      <ul>
        {connections.map((connection, index) => {
          const status = registryStatus(connection);
          return (
            <li key={`${connection.name}-${index}`}>
              <strong>{connection.name}</strong> · {connection.access}
              {status && (
                <small>
                  {' · '}
                  {status}
                </small>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ApprovedConnectorsGuide() {
  const { registry, failed } = useApprovedConnectors();

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

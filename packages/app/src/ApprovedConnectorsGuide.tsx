import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { Link, type To } from 'react-router-dom';
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

type Connection = { name: string; access: string };
type Connector = ApprovedConnectors['connectors'][number];

function entriesForConnection(connectors: Connector[], name: string) {
  const declaredName = name.trim().toLowerCase();
  return connectors.filter(
    connector => connector.name.trim().toLowerCase() === declaredName,
  );
}

function connectionStatus(
  entries: Connector[],
  connection: Connection,
  classification: string,
) {
  if (!entries.length) return 'No matching registry entry';
  return entries.some(connector =>
    connectorSupports(connector, connection.access, classification),
  )
    ? 'Matches registry limits'
    : 'Access or classification differs from registry';
}

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
  connections: Connection[];
  classification: string;
}) {
  const { registry, failed } = useApprovedConnectors();

  function registryStatus(connection: Connection) {
    if (!registry?.configured) return undefined;
    const entries = entriesForConnection(registry.connectors, connection.name);
    const status = connectionStatus(entries, connection, classification);
    if (status !== 'Access or classification differs from registry')
      return status;
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
        {status}
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

export function ConnectorDiscrepancies({
  apps,
  appLink,
}: {
  apps: Array<{
    id: string;
    name: string;
    lifecycle: string;
    classification: string;
    effectiveClassification?: string;
    connections?: Connection[];
  }>;
  appLink: (appId: string) => To;
}) {
  const { registry, failed } = useApprovedConnectors();
  const issues = registry?.configured
    ? apps
        .flatMap(app => {
          if (app.lifecycle === 'retired') return [];
          const classification =
            app.effectiveClassification ?? app.classification;
          const discrepancies = (app.connections ?? []).flatMap(connection => {
            const entries = entriesForConnection(
              registry.connectors,
              connection.name,
            );
            const status = connectionStatus(
              entries,
              connection,
              classification,
            );
            return status === 'Matches registry limits'
              ? []
              : [{ ...connection, status }];
          });
          return discrepancies.length ? [{ app, discrepancies }] : [];
        })
        .sort((a, b) => a.app.name.localeCompare(b.app.name))
    : [];
  return (
    <section
      className="gov-panel gov-stage-report"
      aria-labelledby="connector-discrepancies-title"
    >
      <div className="gov-report-heading">
        <h2 id="connector-discrepancies-title" tabIndex={-1}>
          Connector discrepancies
        </h2>
        {failed && <p role="alert">The connector registry could not load.</p>}
        {!failed && !registry && (
          <p role="status">Loading approved connectors…</p>
        )}
        {registry && !registry.configured && (
          <p>No connector registry is configured.</p>
        )}
        {registry?.configured && !issues.length && (
          <p>No connector discrepancies found.</p>
        )}
      </div>
      {!!issues.length && (
        <ul>
          {issues.map(({ app, discrepancies }) => (
            <li key={app.id}>
              <Link to={appLink(app.id)}>{app.name}</Link>
              <ul>
                {discrepancies.map(({ name, access, status }, index) => (
                  <li key={`${name}-${index}`}>
                    {name} · {access} · {status}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
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

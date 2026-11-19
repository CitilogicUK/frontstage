import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

type CodingToolPolicy = {
  configured: boolean;
  tools: Array<{
    id: string;
    name: string;
    description: string;
    maxClassification: string;
    docsUrl?: string;
  }>;
};

export function ApprovedCodingToolsGuide() {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [policy, setPolicy] = useState<CodingToolPolicy | null>();

  useEffect(() => {
    const controller = new AbortController();
    discovery
      .getBaseUrl('governance')
      .then(base =>
        fetch(`${base}/approved-coding-tools`, { signal: controller.signal }),
      )
      .then(async response => {
        if (!response.ok) throw new Error('Could not load coding tool policy.');
        const result: CodingToolPolicy = await response.json();
        if (!controller.signal.aborted) setPolicy(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPolicy(null);
      });
    return () => controller.abort();
  }, [discovery, fetch]);

  return (
    <section
      className="gov-panel gov-model-guide"
      aria-labelledby="approved-coding-tools-title"
    >
      <div className="gov-report-heading">
        <h2 id="approved-coding-tools-title">Approved AI coding tools</h2>
        <p>
          Use this policy when choosing an AI tool to write or review code.
          Check the highest classification of code or data you share with it.
        </p>
      </div>
      {policy === undefined && (
        <p className="gov-empty" role="status">
          Loading approved coding tools…
        </p>
      )}
      {policy === null && (
        <p className="gov-empty" role="alert">
          The coding tool policy could not load.
        </p>
      )}
      {policy && !policy.configured && (
        <p className="gov-empty">No coding tool policy is configured.</p>
      )}
      {policy?.configured && !policy.tools.length && (
        <p className="gov-empty">No AI coding tools are approved.</p>
      )}
      {policy?.configured && !!policy.tools.length && (
        <div className="governance-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Maximum data classification</th>
                <th scope="col">Documentation</th>
              </tr>
            </thead>
            <tbody>
              {policy.tools.map(tool => (
                <tr key={tool.id}>
                  <td className="gov-app-cell">
                    <strong>{tool.name}</strong>
                    <small>{tool.description}</small>
                  </td>
                  <td data-label="Maximum data classification">
                    {tool.maxClassification}
                  </td>
                  <td data-label="Documentation">
                    {tool.docsUrl ? (
                      <a
                        href={tool.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`${tool.name} documentation (new tab)`}
                      >
                        Open documentation
                      </a>
                    ) : (
                      '—'
                    )}
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

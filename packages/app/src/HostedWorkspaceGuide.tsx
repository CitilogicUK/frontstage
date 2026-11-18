import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';

type WorkspacePolicy = {
  configured: boolean;
  workspaces: Array<{ provider: string; workspace: string }>;
};

export function HostedWorkspaceGuide() {
  const discovery = useApi(discoveryApiRef);
  const { fetch } = useApi(fetchApiRef);
  const [policy, setPolicy] = useState<WorkspacePolicy>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    discovery
      .getBaseUrl('governance')
      .then(base =>
        fetch(`${base}/hosted-workspaces`, { signal: controller.signal }),
      )
      .then(async response => {
        if (!response.ok) throw new Error('Could not load workspace policy.');
        const result: WorkspacePolicy = await response.json();
        if (!controller.signal.aborted) setPolicy(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [discovery, fetch]);

  return (
    <section
      className="gov-panel gov-guide"
      aria-labelledby="hosted-workspaces-title"
    >
      <h2 id="hosted-workspaces-title">Approved provider workspaces</h2>
      {failed && <p role="alert">The workspace policy could not load.</p>}
      {!failed && !policy && <p role="status">Loading workspace policy…</p>}
      {policy && !policy.configured && (
        <p>No approved workspace list is configured.</p>
      )}
      {policy?.configured && policy.workspaces.length === 0 && (
        <p>No provider workspaces are approved for activation.</p>
      )}
      {!!policy?.workspaces.length && (
        <ul>
          {policy.workspaces.map(({ provider, workspace }, index) => (
            <li key={`${provider}-${workspace}-${index}`}>
              {provider} · {workspace}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

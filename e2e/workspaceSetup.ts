import { setTimeout as delay } from 'node:timers/promises';
import { workspaceBackendUrl, workspaceUrl } from './workspaceUrls';

export default async function waitForWorkspace() {
  const deadline = Date.now() + 30_000;
  let status: number | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${workspaceBackendUrl}/api/auth/guest/refresh`,
      {
        headers: {
          Origin: workspaceUrl,
          'X-Requested-With': 'XMLHttpRequest',
        },
        signal: AbortSignal.timeout(2_000),
      },
    ).catch(() => undefined);
    status = response?.status;
    const ready =
      status === 200 &&
      response?.headers.get('content-type')?.includes('application/json');
    await response?.body?.cancel().catch(() => undefined);
    if (ready) return;
    await delay(250);
  }
  throw new Error(
    `Backstage guest sign-in did not become ready at ${workspaceBackendUrl} (${
      status ?? 'no response'
    }).`,
  );
}

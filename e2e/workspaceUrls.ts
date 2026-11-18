const appPort = process.env.FRONTSTAGE_E2E_APP_PORT;
const backendPort = process.env.FRONTSTAGE_E2E_BACKEND_PORT;

export const workspaceUrl = `http://localhost:${appPort ?? '3000'}`;
export const workspaceBackendUrl = `http://localhost:${backendPort ?? '7007'}`;
export const usesIsolatedPorts =
  appPort !== undefined || backendPort !== undefined;

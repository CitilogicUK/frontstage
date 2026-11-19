import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const routes = new Map([
  ['/healthz', { status: 'ok' }],
  [
    '/api/status',
    { service: 'internal-api', status: 'ready', data: 'synthetic' },
  ],
]);

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function createInternalApi() {
  return createServer((request, response) => {
    const path = request.url?.split('?')[0];
    const payload = routes.get(path);
    if (!payload) {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    if (request.method !== 'GET') {
      sendJson(
        response,
        405,
        { error: 'Method not allowed.' },
        { Allow: 'GET' },
      );
      return;
    }
    sendJson(response, 200, payload);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT || 8080);
  const server = createInternalApi();
  server.listen(port, '127.0.0.1', () => {
    const { port: listeningPort } = server.address();
    process.stdout.write(
      `Internal API listening at http://127.0.0.1:${listeningPort}\n`,
    );
  });
}

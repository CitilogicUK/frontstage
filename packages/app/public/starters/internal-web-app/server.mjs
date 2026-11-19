import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const host = '127.0.0.1';
const styles = readFileSync(new URL('./styles.css', import.meta.url));
const statusLabels = {
  available: 'Available',
  checkedOut: 'Checked out',
  maintenance: 'Maintenance',
};
const inventory = [
  {
    name: 'Portable projector',
    category: 'Presentation',
    location: 'Media cabinet',
    status: 'available',
  },
  {
    name: 'USB-C adapter kit',
    category: 'Presentation',
    location: 'Welcome desk',
    status: 'available',
  },
  {
    name: 'Tripod and phone mount',
    category: 'Recording',
    location: 'Media cabinet',
    status: 'checkedOut',
  },
  {
    name: 'Wireless microphone',
    category: 'Recording',
    location: 'Media cabinet',
    status: 'maintenance',
  },
  {
    name: 'Meeting speakerphone',
    category: 'Hybrid meetings',
    location: 'Meeting room store',
    status: 'available',
  },
  {
    name: 'Portable whiteboard',
    category: 'Workshops',
    location: 'Meeting room store',
    status: 'available',
  },
];
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function escapeHtml(value) {
  const entities = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, char => entities[char]);
}

function renderInventory(searchParams) {
  const query = (searchParams.get('q') ?? '').trim().slice(0, 80);
  const requestedStatus = searchParams.get('status');
  const status = Object.hasOwn(statusLabels, requestedStatus)
    ? requestedStatus
    : '';
  const matches = inventory.filter(
    item =>
      (!status || item.status === status) &&
      [item.name, item.category, item.location].some(value =>
        value.toLowerCase().includes(query.toLowerCase()),
      ),
  );
  const options = Object.entries(statusLabels)
    .map(
      ([value, label]) =>
        `<option value="${value}"${
          status === value ? ' selected' : ''
        }>${label}</option>`,
    )
    .join('');
  const rows = matches
    .map(
      item => `
            <tr>
              <th scope="row"><strong>${item.name}</strong><span>${
        item.category
      }</span></th>
              <td>${item.location}</td>
              <td><span class="status" data-status="${item.status}">${
        statusLabels[item.status]
      }</span></td>
            </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en" data-type="software">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="page-type" content="software">
  <meta name="site-kind" content="software">
  <title>Equipment availability</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <a class="skip" href="#inventory">Skip to inventory</a>
  <header class="masthead">
    <div class="frame masthead-inner">
      <a href="/">Equipment desk</a>
      <span>Sample inventory</span>
    </div>
  </header>
  <main class="frame" id="inventory" tabindex="-1">
    <div class="intro" data-enter>
      <h1>Equipment availability</h1>
      <p>Find out what’s ready to borrow and where to pick it up.</p>
    </div>
    <form action="/" method="get" aria-label="Filter equipment">
      <label for="equipment-search">
        Search equipment
        <input id="equipment-search" name="q" type="search" maxlength="80" value="${escapeHtml(
          query,
        )}" placeholder="Name, category or location">
      </label>
      <label for="equipment-status">
        Status
        <select id="equipment-status" name="status">
          <option value="">All statuses</option>${options}
        </select>
      </label>
      <button type="submit">Apply filters</button>
    </form>
    <section class="results" aria-labelledby="results-title">
      <div class="results-heading">
        <h2 id="results-title">Equipment</h2>
        <span>${matches.length} of ${inventory.length} shown</span>
        ${query || status ? '<a href="/">Clear filters</a>' : ''}
      </div>
      ${
        matches.length
          ? `<table aria-labelledby="results-title">
        <thead><tr><th scope="col">Item</th><th scope="col">Location</th><th scope="col">Status</th></tr></thead>
        <tbody>${rows}
        </tbody>
      </table>`
          : '<p class="empty">No equipment matches your filters.</p>'
      }
    </section>
  </main>
</body>
</html>`;
}

function send(response, status, contentType, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': contentSecurityPolicy,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  response.end(body);
}

export function createInternalWebApp() {
  return createServer((request, response) => {
    const text = 'text/plain; charset=utf-8';
    const port = request.socket.localPort;
    const allowedHosts = [`${host}:${port}`, `localhost:${port}`];
    if (port === 80) allowedHosts.push(host, 'localhost');
    if (!allowedHosts.includes(request.headers.host?.toLowerCase())) {
      send(response, 400, text, 'A loopback host is required.');
      return;
    }
    const origin = `http://${host}:${port}`;
    const base = new URL(origin);
    const target = URL.parse(request.url ?? '', base);
    if (!request.url?.startsWith('/') || target?.origin !== base.origin) {
      send(response, 400, text, 'Invalid request target.');
      return;
    }
    if (!['/', '/styles.css', '/healthz'].includes(target.pathname)) {
      send(response, 404, text, 'Not found.');
      return;
    }
    if (request.method !== 'GET') {
      send(response, 405, text, 'Method not allowed.', { Allow: 'GET' });
      return;
    }
    if (target.pathname === '/styles.css') {
      send(response, 200, 'text/css; charset=utf-8', styles);
    } else if (target.pathname === '/healthz') {
      send(response, 200, 'application/json; charset=utf-8', '{"status":"ok"}');
    } else {
      send(
        response,
        200,
        'text/html; charset=utf-8',
        renderInventory(target.searchParams),
      );
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT || 8080);
  const server = createInternalWebApp();
  server.listen(port, host, () => {
    process.stdout.write(
      `Equipment desk listening at http://${host}:${server.address().port}\n`,
    );
  });
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const timeoutMs = 5_000;
const maxDescriptorBytes = 64 * 1024;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function readConfig() {
  const rawBackend = process.env.FRONTSTAGE_MCP_BACKEND_URL ?? '';
  const backend = URL.parse(rawBackend);
  if (
    !backend ||
    !/^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/i.test(rawBackend) ||
    /[\s\\]/.test(rawBackend) ||
    (backend.protocol !== 'https:' &&
      !(backend.protocol === 'http:' && loopbackHosts.has(backend.hostname)))
  ) {
    throw new Error(
      'Set FRONTSTAGE_MCP_BACKEND_URL to an HTTPS or loopback HTTP backend URL without credentials, query, or fragment.',
    );
  }
  const token = process.env.FRONTSTAGE_MCP_TOKEN;
  if (!token || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
    throw new Error('Set FRONTSTAGE_MCP_TOKEN to a valid bearer token.');
  }
  backend.pathname = backend.pathname.replace(/\/?$/, '/');
  return {
    appsUrl: new URL('api/governance/apps', backend),
    repositoryUrl: new URL('api/governance/repository', backend),
    tierPreviewUrl: new URL('api/governance/tier-preview', backend),
    token,
    writeEnabled: process.env.FRONTSTAGE_MCP_WRITE_ENABLED === 'true',
  };
}

const appId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const appSummary = z.object({
  id: appId,
  name: z.string(),
  owner: z.string().optional(),
  team: z.string().optional(),
  type: z.string().optional(),
  platform: z.string().optional(),
  tier: z.number().optional(),
  lifecycle: z.string().optional(),
  classification: z.string().optional(),
  effectiveClassification: z.string().optional(),
  reviewStatus: z.string().optional(),
  usesAiAtRuntime: z.boolean().optional(),
  starterId: z.string().optional(),
  sourceUrl: z.string().optional(),
  deliveryStage: z.string().optional(),
});
const inventory = z.object({ apps: z.array(appSummary) });
const appResult = z.object({ app: appSummary });

const descriptorInput = z.object({
  content: z
    .string()
    .refine(
      value => value.trim().length > 0,
      'Supply a nonblank YAML descriptor.',
    )
    .refine(
      value => Buffer.byteLength(value, 'utf8') <= maxDescriptorBytes,
      'The YAML descriptor must be at most 64 KiB.',
    ),
});
const descriptorPreview = z.object({
  apps: z.array(
    appSummary
      .pick({
        name: true,
        tier: true,
        owner: true,
        team: true,
        deliveryStage: true,
        usesAiAtRuntime: true,
        effectiveClassification: true,
        starterId: true,
      })
      .required({ tier: true, owner: true, team: true }),
  ),
});

const classification = z.enum([
  'public',
  'internal',
  'confidential',
  'restricted',
]);
const riskInput = z.object({
  audience: z.enum(['personal', 'team', 'company', 'external']),
  classification,
  takesActions: z.boolean().optional(),
  affectsPeople: z.boolean().optional(),
  critical: z.boolean().optional(),
  personalData: z.boolean().optional(),
  connections: z
    .array(z.object({ access: z.enum(['read', 'write']) }))
    .max(50)
    .optional(),
  hosted: z
    .object({
      sharing: z.enum(['private', 'named people', 'company', 'public link']),
      dataClassification: classification.optional(),
    })
    .optional(),
});
const riskResult = z.object({
  tier: z.literal([1, 2, 3]),
  reasons: z.array(z.string()),
  effectiveClassification: classification,
});

function safeSummary(app) {
  if (!app.sourceUrl) return app;
  // Legacy registration allowed URLs with embedded credentials.
  const url = URL.parse(app.sourceUrl);
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    const summary = { ...app };
    delete summary.sourceUrl;
    return summary;
  }
  return app;
}

async function fetchCatalog(
  url,
  token,
  schema,
  { body, badRequest, conflict } = {},
) {
  const submitting = body !== undefined;
  let response;
  try {
    response = await fetch(url, {
      method: submitting ? 'POST' : 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(submitting && { 'Content-Type': 'application/json' }),
      },
      ...(submitting && { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('Frontstage is unavailable.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400)
      throw new Error('Frontstage returned an unexpected redirect.');
    if (response.status === 401 || response.status === 403)
      throw new Error('Frontstage authentication failed.');
    if (response.status === 400 && badRequest) throw new Error(badRequest);
    if (response.status === 409 && conflict) throw new Error(conflict);
    if (!submitting && response.status === 404 && schema === appSummary)
      throw new Error('App not found.');
    throw new Error(`Frontstage request failed (HTTP ${response.status}).`);
  }

  const responseBody = await response.json().catch(() => undefined);
  const parsed = schema.safeParse(responseBody);
  if (!parsed.success)
    throw new Error('Frontstage returned an invalid catalog response.');
  return parsed.data;
}

function fetchDescriptor(url, token, schema, content) {
  return fetchCatalog(url, token, schema, {
    body: { content },
    badRequest: 'Frontstage could not validate the descriptor.',
    conflict: 'Frontstage found a conflicting app registration.',
  });
}

function toolResult(structuredContent) {
  return {
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  };
}

async function start() {
  const { appsUrl, repositoryUrl, tierPreviewUrl, token, writeEnabled } =
    readConfig();
  const server = new McpServer({
    name: 'frontstage-catalog',
    version: '1.0.0',
  });
  server.registerTool(
    'search_apps',
    {
      description: 'Search registered Frontstage apps by name or ID.',
      inputSchema: z.object({
        query: z.string().trim().max(100).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: inventory,
      annotations: { readOnlyHint: true },
    },
    async ({ query = '', limit }) => {
      const term = query.toLowerCase();
      const { apps } = await fetchCatalog(appsUrl, token, inventory);
      return toolResult({
        apps: apps
          .filter(app =>
            [app.id, app.name].some(value =>
              value.toLowerCase().includes(term),
            ),
          )
          .slice(0, limit)
          .map(safeSummary),
      });
    },
  );
  server.registerTool(
    'get_app',
    {
      description: 'Read a registered Frontstage app summary by ID.',
      inputSchema: z.object({ id: appId }),
      outputSchema: appResult,
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const url = new URL(appsUrl);
      url.pathname += `/${encodeURIComponent(id)}`;
      const app = await fetchCatalog(url, token, appSummary);
      return toolResult({ app: safeSummary(app) });
    },
  );
  server.registerTool(
    'preview_risk',
    {
      description:
        'Estimate an app risk tier from questionnaire answers using the current Frontstage policy.',
      inputSchema: riskInput,
      outputSchema: riskResult,
      annotations: { readOnlyHint: true },
    },
    async answers =>
      toolResult(
        await fetchCatalog(tierPreviewUrl, token, riskResult, {
          body: answers,
          badRequest: 'Frontstage could not validate the risk questionnaire.',
        }),
      ),
  );
  if (writeEnabled) {
    const previewUrl = new URL(repositoryUrl);
    previewUrl.searchParams.set('dryRun', 'true');
    server.registerTool(
      'preview_descriptor',
      {
        description:
          'Validate an AIApp repository descriptor and preview its registration.',
        inputSchema: descriptorInput,
        outputSchema: descriptorPreview,
        annotations: { readOnlyHint: true },
      },
      async ({ content }) =>
        toolResult(
          await fetchDescriptor(previewUrl, token, descriptorPreview, content),
        ),
    );
    server.registerTool(
      'register_descriptor',
      {
        description:
          'Register an AIApp from its repository descriptor after user approval.',
        inputSchema: descriptorInput,
        outputSchema: appResult,
        annotations: {
          readOnlyHint: false,
          idempotentHint: false,
          destructiveHint: false,
        },
      },
      async ({ content }) => {
        const app = await fetchDescriptor(
          repositoryUrl,
          token,
          appSummary,
          content,
        );
        return toolResult({ app: safeSummary(app) });
      },
    );
  }
  await server.connect(new StdioServerTransport());
}

try {
  await start();
} catch (error) {
  // Print only local configuration errors, never SDK or network diagnostics.
  const message =
    error instanceof Error && error.message.startsWith('Set FRONTSTAGE_MCP_')
      ? error.message
      : 'Frontstage catalog MCP server could not start.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
